package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func localReviewItems() ([]Item, error) {
	bin, err := exec.LookPath("tuicr-reviews")
	if err != nil {
		home, _ := os.UserHomeDir()
		bin = filepath.Join(home, ".local", "bin", "tuicr-reviews")
		if _, err = os.Stat(bin); err != nil {
			return nil, fmt.Errorf("local reviews unavailable: tuicr-reviews is not installed")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, bin, "list", "--json")
	var stderr bytes.Buffer
	command.Stderr = &stderr
	data, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("local reviews unavailable: %s", strings.TrimSpace(stderr.String()+" "+err.Error()))
	}
	var rows []struct {
		Worktree    string   `json:"worktree"`
		Base        string   `json:"base"`
		Branch      string   `json:"branch"`
		Repo        string   `json:"repo"`
		Slug        string   `json:"slug"`
		Created     string   `json:"created"`
		Summary     string   `json:"summary"`
		Labels      []string `json:"labels"`
		Lifecycle   string   `json:"lifecycle"`
		Health      string   `json:"health"`
		BaseSHA     string   `json:"base_sha"`
		HeadSHA     string   `json:"head_sha"`
		Kind        string   `json:"kind"`
		Manifest    string   `json:"manifest"`
		RunID       string   `json:"run_id"`
		SessionSlug string   `json:"session_slug"`
	}
	if err = json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("invalid local review listing: %w", err)
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		id := row.Manifest
		if id == "" {
			id = row.Worktree + "|" + row.Base + "|" + row.Branch
		}
		base, head := row.BaseSHA, row.HeadSHA
		if base == "" {
			base = row.Base
		}
		if head == "" {
			head = row.Branch
		}
		title := row.Summary
		if title == "" {
			title = filepath.Base(row.Repo) + ": " + row.Branch
		}
		token := row.Slug
		if token == "" {
			token = row.Branch
		}
		body := fmt.Sprintf("## Local review\n\nRepository: %s\n\nBranch: %s\n\nStatus: %s\n\nHealth: %s\n\nComparison: %s...%s\n\nWorktree: %s", row.Repo, row.Branch, row.Lifecycle, row.Health, base, head, row.Worktree)
		if row.RunID != "" {
			body += "\n\nRun: " + row.RunID
		}
		if row.SessionSlug != "" {
			body += "\n\nSession: " + row.SessionSlug
		}
		items = append(items, Item{Source: "local-review", ID: id, Kind: "review", Title: title, Labels: normalizeLabels(row.Labels), Body: body, UpdatedAt: row.Created, Worktree: row.Worktree, Base: base, Head: head, Branch: row.Branch, Token: token, Status: row.Lifecycle, Health: row.Health, EntryKind: row.Kind, Manifest: row.Manifest})
	}
	return items, nil
}

func pullRequestItems() ([]Item, error) {
	path := os.Getenv("COWORKER_PRS_FILE")
	if path == "" {
		path = filepath.Join(stateHome(), "dotfiles", "coworker-review-prs.jsonl")
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("PR feed unavailable: %w", err)
	}
	defer file.Close()
	items := []Item{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var row struct {
			Repo        string      `json:"repo"`
			Number      json.Number `json:"number"`
			Title       string      `json:"title"`
			Labels      []string    `json:"labels"`
			URL         string      `json:"url"`
			Kind        string      `json:"kind"`
			State       string      `json:"state"`
			Body        string      `json:"body"`
			Description string      `json:"description"`
			UpdatedAt   string      `json:"updated_at"`
		}
		if err = json.Unmarshal(scanner.Bytes(), &row); err != nil {
			return items, fmt.Errorf("PR feed line %d: %w", line, err)
		}
		if row.Repo == "" || row.Number == "" || row.URL == "" {
			return items, fmt.Errorf("PR feed line %d requires repo, number, and url", line)
		}
		if _, err = strconv.Atoi(row.Number.String()); err != nil {
			return items, fmt.Errorf("PR feed line %d has invalid number", line)
		}
		if row.Kind == "" {
			row.Kind = "review"
		}
		body := row.Body
		if body == "" {
			body = row.Description
		}
		metadata := fmt.Sprintf("## %s #%s\n\n%s\n\nReason: %s", row.Repo, row.Number, row.URL, row.Kind)
		if row.State != "" {
			metadata += "\n\nReview status: " + row.State
		}
		if body != "" {
			metadata += "\n\n" + body
		}
		title := row.Title
		if title == "" {
			title = row.Repo + " #" + row.Number.String()
		}
		items = append(items, Item{Source: "github-pr", ID: row.Repo + "#" + row.Number.String(), Kind: "review", Title: title, Labels: normalizeLabels(row.Labels), Body: metadata, URL: row.URL, UpdatedAt: row.UpdatedAt, Status: row.State})
	}
	if err = scanner.Err(); err != nil {
		return items, fmt.Errorf("PR feed: %w", err)
	}
	return items, nil
}
