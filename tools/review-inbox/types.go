package main

import "sync"

// Item is the hub's display contract. Review approval and lifecycle stay with
// the source; Read and Dismissed describe only this host's personal organization.
type Item struct {
	Source    string   `json:"source"`
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Title     string   `json:"title"`
	Labels    []string `json:"labels,omitempty"`
	Body      string   `json:"body,omitempty"`
	URL       string   `json:"url,omitempty"`
	UpdatedAt string   `json:"updated_at,omitempty"`
	Read      bool     `json:"read"`
	Dismissed bool     `json:"dismissed"`
	Worktree  string   `json:"worktree,omitempty"`
	Base      string   `json:"base,omitempty"`
	Head      string   `json:"head,omitempty"`
	Branch    string   `json:"branch,omitempty"`
	Token     string   `json:"token,omitempty"`
	Status    string   `json:"status,omitempty"`
	Health    string   `json:"health,omitempty"`
	EntryKind string   `json:"entry_kind,omitempty"`
	Manifest  string   `json:"manifest,omitempty"`
}

func (i Item) Key() string { return i.Source + "\x00" + i.ID }

type Hub struct {
	StatePath     string
	Backend       string
	Launcher      string
	sourceMu      sync.Mutex
	localSnapshot []Item
	prSnapshot    []Item
}
