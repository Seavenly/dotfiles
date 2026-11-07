package main

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"time"
)

func (h *Hub) helper(args ...string) error {
	launcher := h.Launcher
	if launcher == "" {
		var err error
		launcher, err = exec.LookPath("review-inbox")
		if err != nil {
			return fmt.Errorf("review-inbox launcher unavailable: %w", err)
		}
	}
	backend := h.Backend
	if backend == "" {
		backend = "auto"
	}
	// GUI processes can keep inherited output pipes open after the launcher has
	// exited. A private file captures diagnostics without delaying Open/Copy.
	log, err := os.CreateTemp("", "review-inbox-action-*")
	if err != nil {
		return err
	}
	defer os.Remove(log.Name())
	defer log.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, launcher, append([]string{"--backend", backend}, args...)...)
	cmd.Stdout, cmd.Stderr = log, log
	err = cmd.Run()
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("action timed out; check the browser, clipboard service, or terminal backend")
		}
		output, _ := io.ReadAll(io.NewSectionReader(log, 0, 4096))
		return fmt.Errorf("%v: %s", err, output)
	}
	return nil
}

func (h *Hub) Open(item Item) error {
	if item.Worktree != "" {
		if item.Base == "" || item.Head == "" {
			return fmt.Errorf("review has no comparison commits")
		}
		if info, err := os.Stat(item.Worktree); err != nil || !info.IsDir() {
			return fmt.Errorf("review worktree is unavailable: %s", item.Worktree)
		}
		return h.helper("--open-local", item.Worktree, item.Base, item.Head, item.Branch)
	}
	if item.URL == "" {
		return fmt.Errorf("this item has no external destination; read it in the preview")
	}
	u, err := url.Parse(item.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return fmt.Errorf("item URL must be an http or https address")
	}
	return h.helper("--open-url", item.URL)
}

func (h *Hub) Copy(item Item) error {
	text := item.Token
	if text == "" {
		text = item.URL
	}
	if text == "" {
		text = item.Source + "/" + item.ID
	}
	return h.helper("--copy-token", text)
}
