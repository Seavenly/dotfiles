package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func (m *appModel) textButton(c *canvas, x, y int, label, action string, active bool) {
	if x >= c.w || y >= c.h {
		return
	}
	fg := m.palette().Muted
	if active {
		fg = m.palette().Accent
	}
	label = ansi.Truncate(singleLine(label), max(0, c.w-x), "")
	c.text(x, y, label, fg, active)
	c.target(max(0, x-1), y, ansi.StringWidth(label)+2, 1, action, 0)
}
func (m *appModel) screen() *canvas {
	b := m.base
	w, h := max(1, b.width), max(1, b.height)
	pal := m.palette()
	c := newCanvas(w, h, pal)
	if w < 28 || h < 14 {
		for y, line := range strings.Split(ansi.Wrap("Inbox\n\nUse at least 28 columns and 14 rows.\nPress q to exit.", w, ""), "\n") {
			c.text(0, y, line, pal.Ink, false)
		}
		return c
	}
	c.text(2, 0, "inbox", pal.Ink, true)
	m.textButton(c, 10, 0, layoutNames[m.layout]+" ▾", "layout-picker", true)
	if w >= 60 {
		m.textButton(c, w-18, 0, "? Help", "help", false)
		m.textButton(c, w-8, 0, "q Quit", "quit", false)
	} else {
		m.textButton(c, w-6, 0, "?", "help", false)
		m.textButton(c, w-2, 0, "×", "quit", false)
	}
	counts := [3]int{}
	for _, item := range b.items {
		if item.Dismissed != b.dismissed || (b.source != "" && item.Source != b.source) {
			continue
		}
		counts[0]++
		if item.Kind == "review" {
			counts[1]++
		} else {
			counts[2]++
		}
	}
	x := 2
	names := []string{"Attention", "Reviews", "Briefs"}
	if w < 65 {
		names[0] = "All"
	}
	for i, name := range names {
		label := fmt.Sprintf("%s %d", name, counts[i])
		if w < 38 {
			label = name
		}
		m.textButton(c, x, 1, label, []string{"attention", "reviews", "briefs"}[i], b.view == i)
		x += ansi.StringWidth(label) + 3
	}
	search := "/ Search"
	if b.source != "" {
		search = "/ [" + b.source + "]"
	}
	if b.query != "" {
		search = "/ " + b.query
		if b.source != "" {
			search += " · " + b.source
		}
	}
	if b.searching {
		search += "_"
	}
	searchWidth := w - 16
	m.textButton(c, 2, 2, ansi.Truncate(search, max(1, searchWidth-2), "…"), "search", b.searching)
	// The full input area can be clicked, including the whitespace after a query.
	c.target(1, 2, searchWidth, 1, "search", 0)
	if b.query != "" || b.source != "" {
		m.textButton(c, searchWidth, 2, "×", "clear", false)
	}
	label := "Dismissed"
	if b.dismissed {
		label = "Active"
	}
	m.textButton(c, w-12, 2, label, "dismissed", b.dismissed)
	c.rule(0, 3, w, pal.Line)
	switch m.layout {
	case 0:
		renderLedger(m, c)
	case 1:
		renderDispatch(m, c)
	case 2:
		renderNavigator(m, c)
	case 3:
		renderStream(m, c)
	case 4:
		renderOverview(m, c)
	}
	c.fill(0, h-3, w, 3, pal.BG)
	c.rule(0, h-3, w, pal.Line)
	status := b.status
	if !b.loaded {
		status = "Loading your inbox…"
	} else if m.acting {
		status = "Working…"
	} else if !b.failed && len(b.warnings) > 0 {
		status = "Source: " + b.warnings[0]
		if len(b.warnings) > 1 {
			status += fmt.Sprintf(" (+%d)", len(b.warnings)-1)
		}
	}
	if status != "" {
		if m.quitRequested {
			status = "Finishing pending changes before quitting…"
		}
		fg := pal.Muted
		if b.failed {
			fg = "#E46876"
		} else if len(b.warnings) > 0 {
			fg = "#E6C384"
		}
		c.text(2, h-3, ansi.Truncate(" "+singleLine(status)+" ", max(1, w-4), "…"), fg, false)
		c.target(0, h-3, w, 1, "help", 0)
	}
	read, dismiss := "Read", "Dismiss"
	if item, ok := m.current(); ok {
		if item.Read {
			read = "Unread"
		}
		if item.Dismissed {
			dismiss = "Restore"
		}
	}
	x = 1
	for i, name := range []string{read, dismiss, "Open", "Copy"} {
		m.textButton(c, x, h-2, name, []string{"read", "dismiss", "open", "copy"}[i], false)
		x += len(name) + 2
	}
	if w >= 70 {
		m.textButton(c, w-26, h-2, "↑ Scroll", "scroll-up", false)
		m.textButton(c, w-15, h-2, "↓ Scroll", "scroll-down", false)
	}
	back := "Prev"
	backAction := "previous"
	if b.detail || b.previewFocus {
		back = "Back"
		backAction = "back"
	}
	m.textButton(c, 1, h-1, back, backAction, false)
	m.textButton(c, 7, h-1, "Next", "next", false)
	m.textButton(c, 14, h-1, "↑", "scroll-up", false)
	m.textButton(c, 18, h-1, "↓", "scroll-down", false)
	m.textButton(c, 22, h-1, "R", "refresh", false)
	if w >= 40 {
		position := fmt.Sprintf("%d/%d", min(len(m.items()), b.selected+1), len(m.items()))
		c.text(w-len(position)-2, h-1, position, pal.Muted, false)
	}
	if w >= 78 {
		c.text(29, h-1, "/ search · r read · d dismiss · L layout", pal.Muted, false)
	}
	if m.picker {
		m.renderPicker(c)
	}
	if m.help {
		m.renderHelp(c)
	}
	return c
}
func (m *appModel) renderPicker(c *canvas) {
	pal := m.palette()
	w := min(49, c.w-4)
	x := max(1, c.w-w-2)
	y := 2
	h := min(11, c.h-4)
	c.target(0, 0, c.w, c.h, "close-overlay", 0)
	c.fill(x, y, w, h, pal.Surface)
	c.box(x, y, w, h, "Layout", pal.Line)
	c.target(x, y, w, h, "overlay", 0)
	for index, name := range layoutNames {
		row := y + 2 + index
		if row >= y+h-1 {
			break
		}
		if index == m.pickerIndex {
			c.fill(x+1, row, w-2, 1, pal.Select)
		}
		mark := " "
		if index == m.layout {
			mark = "✓"
		}
		text := fmt.Sprintf("%d  %s %s", index+1, mark, name)
		c.text(x+2, row, text, pal.Ink, index == m.pickerIndex)
		c.target(x+1, row, w-2, 1, fmt.Sprintf("layout:%d", index), index)
	}
	if h >= 10 {
		c.text(x+2, y+h-2, "↑↓ choose · Enter select · Esc close", pal.Muted, false)
	}
}
func (m *appModel) helpLines(width int) []string {
	content := []string{
		"1 / 2 / 3      Attention / Reviews / Briefs",
		"j / k, arrows  Move through items; scroll in reader",
		"Enter / Tab    Focus reader; Tab returns to queue",
		"Esc / h        Back; clear filters from the queue",
		"/              Search titles, bodies, sources, labels",
		"r / d          Toggle read; dismiss or restore",
		"o / y          Open in tuicr/browser; copy reference",
		"s / R          Dismissed items; refresh sources",
		"L / [ / ]      Choose layout; cycle layouts",
		"q / Ctrl-C     Quit",
		"",
		"Layout choices are remembered on this host. Read and dismissed state is shared by every layout.",
	}
	if m.base.failed {
		content = append(content, "", "Action error: "+m.base.status)
	}
	if len(m.base.warnings) > 0 {
		content = append(content, "", "Source observations:")
		content = append(content, m.base.warnings...)
	}
	lines := []string{}
	for _, text := range content {
		lines = append(lines, strings.Split(ansi.Wrap(cleanText(text), max(1, width), ""), "\n")...)
	}
	return lines
}

func (m *appModel) scrollHelp(delta int) {
	width := max(1, min(84, m.base.width-4)-4)
	visible := max(1, min(25, m.base.height-2)-4)
	m.helpScroll = max(0, min(m.helpScroll+delta, max(0, len(m.helpLines(width))-visible)))
}

func (m *appModel) renderHelp(c *canvas) {
	pal := m.palette()
	w := min(84, c.w-4)
	h := min(25, c.h-2)
	x, y := (c.w-w)/2, (c.h-h)/2
	lines := m.helpLines(w - 4)
	visible := max(1, h-4)
	start := max(0, min(m.helpScroll, max(0, len(lines)-visible)))
	c.target(0, 0, c.w, c.h, "close-overlay", 0)
	c.fill(x, y, w, h, pal.Surface)
	c.box(x, y, w, h, "Help / source status", pal.Line)
	c.target(x, y, w, h, "overlay", 0)
	for row := 0; row < visible && start+row < len(lines); row++ {
		c.text(x+2, y+2+row, lines[start+row], pal.Ink, false)
	}
	m.textButton(c, x+w-4, y, "×", "close-overlay", false)
	m.textButton(c, x+2, y+h-2, "↑", "help-up", false)
	m.textButton(c, x+6, y+h-2, "↓", "help-down", false)
	c.text(x+10, y+h-2, "Esc close", pal.Muted, false)
}
func (m *appModel) View() tea.View {
	v := tea.NewView(m.screen().view())
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.ReportFocus = true
	v.WindowTitle = "Inbox / " + layoutNames[m.layout]
	if m.base.searching && !m.help && !m.picker {
		position := min(max(2, m.base.width-18), 2+ansi.StringWidth("/ "+m.base.query))
		v.Cursor = tea.NewCursor(position, 2)
	}
	return v
}
