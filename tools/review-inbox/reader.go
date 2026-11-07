package main

import (
	"github.com/charmbracelet/x/ansi"
	"strings"
)

type readerLine struct {
	text, fg string
	bold     bool
}

func (m *appModel) previewLines(width int) []readerLine {
	item, ok := m.current()
	pal := m.palette()
	if !ok {
		lines := []readerLine{}
		for _, text := range []string{"Select an item to read its context.", "", "Reviews appear when a source publishes them.", "Add briefs with review-inbox publish.", "Press ? for controls and source status."} {
			for _, line := range strings.Split(ansi.Wrap(text, max(1, width), ""), "\n") {
				lines = append(lines, readerLine{line, pal.Muted, false})
			}
		}
		return lines
	}
	lines := []readerLine{}
	add := func(text, fg string, bold bool) {
		for _, line := range strings.Split(ansi.Wrap(cleanText(text), max(1, width), ""), "\n") {
			lines = append(lines, readerLine{line, fg, bold})
		}
	}
	add(item.Title, pal.Ink, true)
	meta := strings.ToUpper(item.Kind) + " / " + item.Source
	if item.Status != "" {
		meta += " / " + strings.ReplaceAll(item.Status, "_", " ")
	}
	add(meta, pal.Muted, false)
	if len(item.Labels) > 0 {
		add("Labels: "+strings.Join(item.Labels, " · "), pal.Tag, false)
	}
	if item.Health != "" && item.Health != "current" {
		add("Source health: "+item.Health, pal.Tag, false)
	}
	if item.UpdatedAt != "" {
		add("Updated "+formatInboxTime(item.UpdatedAt), pal.Muted, false)
	}
	add("", pal.Ink, false)
	body := cleanText(item.Body)
	if body == "" {
		body = "No additional context provided."
	}
	code := false
	for _, line := range strings.Split(body, "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "```") {
			code = !code
			add("  ────────────", pal.Line, false)
			continue
		}
		fg, bold := pal.Ink, false
		if strings.HasPrefix(trim, "#") {
			line = strings.TrimSpace(strings.TrimLeft(trim, "#"))
			fg, bold = pal.Accent, true
		} else if code {
			line = "  " + line
			fg = pal.Tag
		} else if strings.HasPrefix(trim, ">") {
			line = strings.TrimSpace(strings.TrimPrefix(trim, ">"))
			fg = pal.Muted
		}
		add(line, fg, bold)
	}
	if item.URL != "" {
		add("", pal.Ink, false)
		add(item.URL, pal.Accent, false)
	}
	return lines
}
func (m *appModel) preview(c *canvas, x, y, w, h int) {
	c.reader = rect{x, y, max(0, w), max(0, h)}
	if w < 1 || h < 1 {
		return
	}
	lines := m.previewLines(w)
	start := max(0, min(m.base.previewOffset, max(0, len(lines)-h)))
	for row := 0; row < h && start+row < len(lines); row++ {
		line := lines[start+row]
		c.text(x, y+row, line.text, line.fg, line.bold)
	}
	c.target(x, y, w, h, "preview", 0)
}
