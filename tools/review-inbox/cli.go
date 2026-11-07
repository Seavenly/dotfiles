package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

const usage = `review-inbox - your local attention hub

Usage:
  review-inbox [--backend auto|tmux|herdr] [--layout NAME]
                                              Open the TUI (Navigator by default)
  review-inbox layout [NAME]                   Inspect or save the preferred layout
  review-inbox designs [--skin NAME]            Open a layout or render gallery snapshots
  review-inbox publish [FILE|-]                 Upsert one JSON item (stdin by default)
  review-inbox list [--all] [--kind brief|review] [--source SOURCE] [--json]
  review-inbox show SOURCE ID [--json]
  review-inbox read|unread|dismiss|restore SOURCE ID [--json]
  review-inbox remove SOURCE ID [--json]         Remove published content
  review-inbox open|copy SOURCE ID [--json]      Open item or copy its token/URL

All CLI results are JSON. list excludes dismissed items unless --all is supplied.
publish accepts source, id, title, kind (brief by default), labels (string array),
body (Markdown), url, and updated_at. source + id is stable identity; publishing
it again updates it.
Content changes mark items unread. Dismissed items stay dismissed until restored.
The local-review and github-pr source names are reserved for existing feeds.
Layouts: navigator, ledger, dispatch, stream, overview. --layout overrides the
saved choice for this launch; the layout command saves a host-local preference.

Examples:
  printf '%s\n' '{"source":"daily","id":"2026-11-05","title":"Daily brief","body":"# Today\n\nYour brief here."}' | review-inbox publish
  review-inbox list --kind brief --json
  review-inbox show daily 2026-11-05
  review-inbox dismiss daily 2026-11-05
  review-inbox restore daily 2026-11-05

State: REVIEW_INBOX_STATE_FILE or $XDG_STATE_HOME/dotfiles/review-inbox.json
PR feed: COWORKER_PRS_FILE or $XDG_STATE_HOME/dotfiles/coworker-review-prs.jsonl
Local reviews: tuicr-reviews list --json (respects TUICR_REVIEWS_FILE)
`

func RunCLI(args []string) int {
	if err := runCLI(NewHub(), args, os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "review-inbox:", err)
		return 1
	}
	return 0
}

func writeJSON(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func runCLI(h *Hub, args []string, in io.Reader, out, errOut io.Writer) error {
	layout := ""
	layoutSet := false
	for len(args) > 0 {
		if args[0] == "--backend" {
			if len(args) < 2 {
				return fmt.Errorf("--backend requires auto, tmux, or herdr")
			}
			h.Backend, args = args[1], args[2:]
		} else if strings.HasPrefix(args[0], "--backend=") {
			h.Backend, args = strings.TrimPrefix(args[0], "--backend="), args[1:]
		} else if args[0] == "--layout" {
			layoutSet = true
			if len(args) < 2 {
				return fmt.Errorf("--layout requires a layout name")
			}
			layout, args = args[1], args[2:]
		} else if strings.HasPrefix(args[0], "--layout=") {
			layoutSet = true
			layout, args = strings.TrimPrefix(args[0], "--layout="), args[1:]
		} else {
			break
		}
	}
	if h.Backend != "auto" && h.Backend != "tmux" && h.Backend != "herdr" {
		return fmt.Errorf("backend must be auto, tmux, or herdr")
	}
	if layoutSet && !validLayout(layout) {
		return fmt.Errorf("unknown layout %q; choose %s", layout, strings.Join(layoutSlugs, ", "))
	}
	if len(args) == 0 {
		return runTUI(h, layout)
	}
	command, args := args[0], args[1:]
	if command == "--help" || command == "-h" || command == "help" {
		_, err := io.WriteString(out, usage)
		return err
	}
	if layout != "" {
		return fmt.Errorf("--layout applies to the TUI; use review-inbox layout NAME to save a preference")
	}
	// --json is explicit documentation of output format and accepted anywhere.
	filtered := make([]string, 0, len(args))
	for _, argument := range args {
		if argument != "--json" {
			filtered = append(filtered, argument)
		}
	}
	args = filtered
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		switch command {
		case "publish", "list", "layout", "show", "read", "unread", "dismiss", "restore", "remove", "open", "copy":
			_, err := io.WriteString(out, usage)
			return err
		}
	}
	switch command {
	case "layout":
		if len(args) > 1 {
			return fmt.Errorf("usage: review-inbox layout [NAME]")
		}
		if len(args) == 1 {
			if err := h.SetLayout(args[0]); err != nil {
				return err
			}
		}
		current, err := h.Layout()
		if err != nil {
			return err
		}
		return writeJSON(out, map[string]any{"layout": current, "available": layoutSlugs})
	case "designs":
		return runDesigns(h, args, out)
	case "publish":
		if len(args) > 1 {
			return fmt.Errorf("usage: review-inbox publish [FILE|-]")
		}
		var reader io.Reader = in
		if len(args) == 1 && args[0] != "-" {
			file, err := os.Open(args[0])
			if err != nil {
				return err
			}
			defer file.Close()
			reader = file
		}
		decoder := json.NewDecoder(reader)
		decoder.DisallowUnknownFields()
		var item Item
		if err := decoder.Decode(&item); err != nil {
			return fmt.Errorf("publish JSON: %w", err)
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			return fmt.Errorf("publish expects exactly one JSON object")
		}
		published, err := h.Publish(item)
		if err != nil {
			return err
		}
		return writeJSON(out, published)
	case "list":
		flags := flag.NewFlagSet("list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		all := flags.Bool("all", false, "include dismissed items")
		kind := flags.String("kind", "", "filter brief or review")
		source := flags.String("source", "", "filter source")
		if err := flags.Parse(args); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("usage: review-inbox list [--all] [--kind brief|review] [--source SOURCE]")
		}
		if *kind != "" && *kind != "brief" && *kind != "review" {
			return fmt.Errorf("kind must be brief or review")
		}
		items, warnings, err := h.Items()
		if err != nil {
			return err
		}
		for _, warning := range warnings {
			fmt.Fprintln(errOut, "review-inbox:", warning)
		}
		visible := []Item{}
		for _, item := range items {
			if item.Dismissed && !*all {
				continue
			}
			if *kind != "" && item.Kind != *kind {
				continue
			}
			if *source != "" && item.Source != *source {
				continue
			}
			visible = append(visible, item)
		}
		return writeJSON(out, visible)
	case "show", "read", "unread", "dismiss", "restore", "remove", "open", "copy":
		if len(args) != 2 {
			return fmt.Errorf("usage: review-inbox %s SOURCE ID", command)
		}
		source, id := args[0], args[1]
		if command == "remove" {
			if err := h.Remove(source, id); err != nil {
				return err
			}
			return writeJSON(out, map[string]any{"source": source, "id": id, "removed": true})
		}
		if command == "read" || command == "unread" || command == "dismiss" || command == "restore" {
			if err := h.SetState(source, id, command); err != nil {
				return err
			}
		}
		item, err := h.find(source, id)
		if err != nil {
			return err
		}
		if command == "open" {
			if err := h.Open(item); err != nil {
				return err
			}
		}
		if command == "copy" {
			if err := h.Copy(item); err != nil {
				return err
			}
		}
		return writeJSON(out, item)
	default:
		return fmt.Errorf("unknown command %q; run review-inbox --help", command)
	}
}
