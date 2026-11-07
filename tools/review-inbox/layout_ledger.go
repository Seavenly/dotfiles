package main

// Ledger presents a compact queue with a separate inspector when space permits.

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

func renderLedger(p *appModel, c *canvas) {
	if c.h < 22 {
		renderCompactQueue(p, c, "LEDGER")
		return
	}
	colors := p.palette()
	items := p.items()
	wide := c.w >= 88
	c.inlineReader = wide
	if !wide && p.base.detail {
		p.textButton(c, 2, 4, "‹ Queue", "back", false)
		c.text(14, 4, "READING / LEDGER", colors.Muted, false)
		c.rule(2, 5, c.w-4, colors.Line)
		p.preview(c, 3, 7, c.w-6, max(1, c.h-12))
		return
	}

	listWidth := c.w - 2
	if wide {
		listWidth = c.w * 57 / 100
	}
	leftWidth := max(20, listWidth-3)
	c.text(2, 4, "QUEUE", colors.Accent, true)
	c.text(9, 4, fmt.Sprintf("%02d ITEMS", len(items)), colors.Muted, false)
	if listWidth > 42 {
		c.text(listWidth-22, 4, "ORDERED FOR ATTENTION", colors.Muted, false)
	}
	c.rule(2, 5, leftWidth, colors.Line)

	metaSource := listWidth - 18
	metaKind := listWidth - 7
	titleWidth := max(8, metaSource-10)
	hasLabels := false
	for _, item := range items {
		if len(item.Labels) > 0 {
			hasLabels = true
			break
		}
	}
	labelColumn := hasLabels && listWidth >= 56
	labelWidth := min(26, max(18, listWidth*2/5))
	labelX := listWidth - labelWidth - 2
	rowHeight := 1
	if hasLabels && !labelColumn {
		rowHeight = 2
	}
	c.text(3, 7, "#", colors.Muted, false)
	c.text(8, 7, "ITEM", colors.Muted, false)
	if labelColumn {
		titleWidth = labelX - 9
		c.text(labelX, 7, "LABELS", colors.Muted, false)
	} else if listWidth >= 44 && !hasLabels {
		c.text(metaSource, 7, "SOURCE", colors.Muted, false)
		c.text(metaKind, 7, "TYPE", colors.Muted, false)
	} else {
		titleWidth = leftWidth - 7
	}

	capacity := max(1, (c.h-15)/rowHeight)
	c.listPage = capacity
	start := p.listStart(capacity)
	for row := 0; row < capacity && start+row < len(items); row++ {
		index := start + row
		item := items[index]
		y := 9 + row*rowHeight
		ink := colors.Ink
		if item.Read {
			ink = colors.Muted
		}
		if index == p.base.selected {
			c.fill(2, y, leftWidth, rowHeight, colors.Select)
			c.text(2, y, "▎", colors.Accent, true)
		}
		c.text(3, y, fmt.Sprintf("%02d", index+1), colors.Muted, false)
		mark := "·"
		if !item.Read {
			mark = "●"
		}
		c.text(6, y, mark, colors.Accent, false)
		c.text(8, y, ledgerClip(singleLine(item.Title), titleWidth), ink, !item.Read)
		if labelColumn {
			c.text(labelX, y, compactItemLabels(item.Labels, labelWidth), colors.Tag, false)
		} else if hasLabels {
			c.text(8, y+1, compactItemLabels(item.Labels, leftWidth-7), colors.Tag, false)
		} else if listWidth >= 44 {
			c.text(metaSource, y, ledgerClip(item.Source, 9), colors.Muted, false)
			kind := "NOTE"
			if item.Kind == "review" {
				kind = "REV"
			}
			c.text(metaKind, y, kind, colors.Tag, false)
		}
		p.selectTarget(c, 2, y, leftWidth, rowHeight, index)
	}
	if len(items) == 0 {
		c.text(3, 10, ledgerClip("The queue is clear.", leftWidth-2), colors.Muted, false)
	}
	c.rule(2, c.h-6, leftWidth, colors.Line)
	position := "Nothing selected"
	if len(items) > 0 {
		position = fmt.Sprintf("%02d / %02d", p.base.selected+1, len(items))
	}
	c.text(3, c.h-5, position, colors.Muted, false)
	if listWidth > 37 {
		c.text(listWidth-20, c.h-5, "↵ inspect · j/k", colors.Muted, false)
	}

	if wide {
		x := listWidth + 1
		width := c.w - x - 2
		c.fill(x, 4, width, c.h-8, colors.Surface)
		c.text(x+2, 5, "INSPECTOR", colors.Accent, true)
		c.rule(x+2, 6, width-4, colors.Line)
		p.preview(c, x+2, 8, width-4, max(1, c.h-15))
		if item, ok := p.current(); ok {
			state := "UNREAD"
			if item.Read {
				state = "READ"
			}
			c.text(x+2, c.h-6, state, colors.Tag, false)
			if item.Status != "" {
				c.text(x+11, c.h-6, ledgerClip(strings.ReplaceAll(item.Status, "_", " "), width-14), colors.Muted, false)
			}
		}
	}
}

func ledgerClip(value string, width int) string {
	return ansi.Truncate(singleLine(value), max(1, width), "…")
}

// Short terminals trade decorative framing for usable queue and reader space.
// All layouts use this fallback so focus and paging still follow real geometry.
func renderCompactQueue(p *appModel, c *canvas, title string) {
	colors := p.palette()
	bottom := c.h - 3
	c.listPage = 1
	if p.base.detail {
		p.textButton(c, 2, 4, "‹ Queue", "back", false)
		if c.w > 40 {
			c.text(14, 4, title, colors.Muted, false)
		}
		c.rule(2, 5, c.w-4, colors.Line)
		p.preview(c, 2, 6, c.w-4, max(1, bottom-6))
		return
	}
	items := p.items()
	c.text(2, 4, title, colors.Accent, true)
	c.text(c.w-7, 4, fmt.Sprintf("%02d", len(items)), colors.Muted, false)
	c.rule(2, 5, c.w-4, colors.Line)
	capacity := max(1, (bottom-6)/2)
	c.listPage = capacity
	start := p.listStart(capacity)
	for row := 0; row < capacity && start+row < len(items); row++ {
		index := start + row
		item := items[index]
		y := 6 + row*2
		if index == p.base.selected {
			c.fill(1, y, c.w-2, 2, colors.Select)
		}
		marker := "○"
		if !item.Read {
			marker = "●"
		}
		c.text(2, y, marker, colors.Accent, false)
		c.text(4, y, ledgerClip(item.Title, c.w-6), colors.Ink, !item.Read)
		if len(item.Labels) > 0 {
			c.text(4, y+1, compactItemLabels(item.Labels, c.w-6), colors.Tag, false)
		} else {
			c.text(4, y+1, ledgerClip(item.Source+" / "+item.Kind, c.w-6), colors.Muted, false)
		}
		p.selectTarget(c, 1, y, c.w-2, 2, index)
	}
	if len(items) == 0 {
		c.text(2, 6, ledgerClip("No items in this view.", c.w-4), colors.Muted, false)
	}
}
