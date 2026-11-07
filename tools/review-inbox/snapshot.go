package main

import (
	"flag"
	"fmt"
	"io"
)

// Compatibility entry point for old design commands and offline galleries.
// Snapshot rendering is read-only and uses the same production renderers.
func runDesigns(h *Hub, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("designs", flag.ContinueOnError)
	flags.SetOutput(out)
	name := flags.String("skin", "navigator", "ledger, dispatch, navigator, stream, overview")
	snapshot := flags.Bool("snapshot", false, "render a read-only JSON frame")
	width := flags.Int("width", 120, "snapshot columns")
	height := flags.Int("height", 38, "snapshot rows")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || !validLayout(*name) {
		return fmt.Errorf("usage: review-inbox designs --skin NAME [--snapshot]")
	}
	if !*snapshot {
		return runTUI(h, *name)
	}
	items, warnings, err := h.Items()
	if err != nil {
		return err
	}
	m := newAppModel(h, *name)
	m.base.width = max(1, *width)
	m.base.height = max(1, *height)
	m.base.items = items
	m.base.warnings = warnings
	m.base.loaded = true
	m.base.busy = false
	c := m.screen()
	return writeJSON(out, map[string]any{"name": layoutNames[m.layout], "slug": layoutSlugs[m.layout], "width": c.w, "height": c.h, "rows": c.runs()})
}
