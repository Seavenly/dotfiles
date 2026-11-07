package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

type itemState struct {
	Fingerprint string `json:"fingerprint"`
	Read        bool   `json:"read"`
	Dismissed   bool   `json:"dismissed"`
}

type hubState struct {
	Version int                  `json:"version"`
	Layout  string               `json:"layout,omitempty"`
	Items   map[string]Item      `json:"items"`
	States  map[string]itemState `json:"states"`
}

func stateHome() string {
	if value := os.Getenv("XDG_STATE_HOME"); value != "" {
		return value
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state")
}

func NewHub() *Hub {
	path := os.Getenv("REVIEW_INBOX_STATE_FILE")
	if path == "" {
		path = filepath.Join(stateHome(), "dotfiles", "review-inbox.json")
	}
	backend := os.Getenv("REVIEW_INBOX_BACKEND")
	if backend == "" {
		backend = "auto"
	}
	return &Hub{StatePath: path, Backend: backend, Launcher: os.Getenv("REVIEW_INBOX_LAUNCHER")}
}

func (h *Hub) load() (hubState, error) {
	state := hubState{Version: 1, Items: map[string]Item{}, States: map[string]itemState{}}
	data, err := os.ReadFile(h.StatePath)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err = json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("read hub state %s: %w", h.StatePath, err)
	}
	if state.Version != 1 {
		return state, fmt.Errorf("unsupported hub state version %d", state.Version)
	}
	if state.Items == nil {
		state.Items = map[string]Item{}
	}
	if state.States == nil {
		state.States = map[string]itemState{}
	}
	return state, nil
}

func (h *Hub) save(state hubState) error {
	if err := os.MkdirAll(filepath.Dir(h.StatePath), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(h.StatePath), ".review-inbox-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(append(data, '\n')); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), h.StatePath)
}

// Serialize each read-modify-write across the TUI and producer CLI processes.
// The kernel releases this advisory lock if a process exits unexpectedly.
func (h *Hub) mutate(update func(*hubState) error) error {
	if err := os.MkdirAll(filepath.Dir(h.StatePath), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(h.StatePath+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return fmt.Errorf("lock hub state: %w", err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("hub state is busy; retry the command")
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	state, err := h.load()
	if err != nil {
		return err
	}
	if err = update(&state); err != nil {
		return err
	}
	return h.save(state)
}

func withPersonalState(item Item, personal itemState) Item {
	item.Labels = normalizeLabels(item.Labels)
	item.Read = personal.Read && personal.Fingerprint == itemFingerprint(item)
	item.Dismissed = personal.Dismissed
	return item
}

func itemFingerprint(item Item) string {
	// Producer refresh timestamps do not represent new content.
	item.UpdatedAt = ""
	item.Read = false
	item.Dismissed = false
	item.Labels = normalizeLabels(item.Labels)
	data, _ := json.Marshal(item)
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// Labels describe a set of source-owned categories. Stable ordering prevents
// provider reorderings from looking like new content.
func normalizeLabels(labels []string) []string {
	set := make(map[string]bool, len(labels))
	for _, label := range labels {
		if label = strings.TrimSpace(label); label != "" {
			set[label] = true
		}
	}
	var result []string
	for label := range set {
		result = append(result, label)
	}
	sort.Strings(result)
	return result
}

func (h *Hub) Items() ([]Item, []string, error) {
	state, err := h.load()
	if err != nil {
		return nil, nil, err
	}
	items := make([]Item, 0, len(state.Items))
	for _, item := range state.Items {
		items = append(items, item)
	}
	local, localErr := localReviewItems()
	prs, prErr := pullRequestItems()
	h.sourceMu.Lock()
	if localErr == nil {
		h.localSnapshot = append([]Item(nil), local...)
	} else if len(h.localSnapshot) > 0 {
		local = append([]Item(nil), h.localSnapshot...)
		localErr = fmt.Errorf("%w; showing the last successful snapshot", localErr)
	}
	if prErr == nil {
		h.prSnapshot = append([]Item(nil), prs...)
	} else if len(h.prSnapshot) > 0 {
		prs = append([]Item(nil), h.prSnapshot...)
		prErr = fmt.Errorf("%w; showing the last successful snapshot", prErr)
	}
	h.sourceMu.Unlock()
	items = append(items, local...)
	items = append(items, prs...)
	warnings := []string{}
	if localErr != nil {
		warnings = append(warnings, localErr.Error())
	}
	if prErr != nil {
		warnings = append(warnings, prErr.Error())
	}
	for index := range items {
		items[index] = withPersonalState(items[index], state.States[items[index].Key()])
	}
	sort.SliceStable(items, func(a, b int) bool {
		if (items[a].Kind == "review") != (items[b].Kind == "review") {
			return items[a].Kind == "review"
		}
		if items[a].UpdatedAt != items[b].UpdatedAt {
			return items[a].UpdatedAt > items[b].UpdatedAt
		}
		return items[a].Key() < items[b].Key()
	})
	return items, warnings, nil
}

func (h *Hub) find(source, id string) (Item, error) {
	if source != "local-review" && source != "github-pr" {
		state, err := h.load()
		if err != nil {
			return Item{}, err
		}
		item, exists := state.Items[(Item{Source: source, ID: id}).Key()]
		if !exists {
			return Item{}, fmt.Errorf("item not found: %s %s", source, id)
		}
		return withPersonalState(item, state.States[item.Key()]), nil
	}
	items, _, err := h.Items()
	if err != nil {
		return Item{}, err
	}
	for _, item := range items {
		if item.Source == source && item.ID == id {
			return item, nil
		}
	}
	return Item{}, fmt.Errorf("item not found: %s %s", source, id)
}

func (h *Hub) SetState(source, id, action string) error {
	switch action {
	case "read", "unread", "dismiss", "restore":
	default:
		return fmt.Errorf("unknown state action: %s", action)
	}
	item := Item{Source: source, ID: id}
	if source == "local-review" || source == "github-pr" {
		// Read source projections before taking the local store lock.
		var err error
		item, err = h.find(source, id)
		if err != nil {
			return err
		}
	}
	return h.mutate(func(state *hubState) error {
		if source != "local-review" && source != "github-pr" {
			var exists bool
			item, exists = state.Items[item.Key()]
			if !exists {
				return fmt.Errorf("item not found: %s %s", source, id)
			}
		}
		personal := state.States[item.Key()]
		// Derive from the latest locked state so simultaneous read/dismiss
		// commands preserve both independent personal choices.
		personal.Read = withPersonalState(item, personal).Read
		personal.Fingerprint = itemFingerprint(item)
		switch action {
		case "read":
			personal.Read = true
		case "unread":
			personal.Read = false
		case "dismiss":
			personal.Dismissed = true
		case "restore":
			personal.Dismissed = false
		}
		state.States[item.Key()] = personal
		return nil
	})
}

func (h *Hub) Publish(item Item) (Item, error) {
	item.Source = strings.TrimSpace(item.Source)
	item.ID = strings.TrimSpace(item.ID)
	item.Title = strings.TrimSpace(item.Title)
	item.Labels = normalizeLabels(item.Labels)
	if item.Source == "" || item.ID == "" || item.Title == "" {
		return Item{}, fmt.Errorf("publish requires source, id, and title")
	}
	if strings.ContainsAny(item.Source+item.ID, "\x00\r\n\t") {
		return Item{}, fmt.Errorf("source and id must not contain control characters")
	}
	if item.Source == "local-review" || item.Source == "github-pr" {
		return Item{}, fmt.Errorf("source %q is reserved for existing review feeds", item.Source)
	}
	if item.Kind == "" {
		item.Kind = "brief"
	}
	if item.Kind != "brief" && item.Kind != "review" {
		return Item{}, fmt.Errorf("kind must be brief or review")
	}
	if item.UpdatedAt == "" {
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	item.Read = false
	item.Dismissed = false
	// Published data cannot nominate a local executable or review workspace.
	item.Worktree, item.Base, item.Head, item.Branch, item.Token = "", "", "", "", ""
	item.EntryKind, item.Manifest = "", ""
	var published Item
	err := h.mutate(func(state *hubState) error {
		state.Items[item.Key()] = item
		published = withPersonalState(item, state.States[item.Key()])
		return nil
	})
	if err != nil {
		return Item{}, err
	}
	return published, nil
}

func (h *Hub) Remove(source, id string) error {
	if source == "local-review" || source == "github-pr" {
		return fmt.Errorf("review feeds own their items; use dismiss to hide a review")
	}
	item := Item{Source: source, ID: id}
	return h.mutate(func(state *hubState) error {
		if _, exists := state.Items[item.Key()]; !exists {
			return fmt.Errorf("item not found: %s %s", source, id)
		}
		delete(state.Items, item.Key())
		delete(state.States, item.Key())
		return nil
	})
}
