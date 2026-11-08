package main

// Overview is an information desk: two parallel queues above one
// shared reading surface. Counts are derived from the current view's items.
import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

type overviewEntry struct {
	index int
	item  Item
}

func renderOverview(p *appModel, c *canvas) {
	if c.h < 26 {
		renderCompactQueue(p, c, "YOUR DESK")
		return
	}
	colors := p.palette()
	items := p.items()
	bottom := c.h - 3
	bodyHeight := bottom - 4
	if bodyHeight < 5 {
		return
	}
	if c.w < 70 && p.base.detail {
		p.textButton(c, 2, 4, "< Your desk", "back", false)
		c.rule(2, 5, c.w-4, colors.Line)
		p.preview(c, 3, 7, c.w-6, max(1, bottom-8))
		return
	}

	reviews, briefs := []overviewEntry{}, []overviewEntry{}
	unread := 0
	for index, item := range items {
		entry := overviewEntry{index, item}
		if item.Kind == "review" {
			reviews = append(reviews, entry)
		} else {
			briefs = append(briefs, entry)
		}
		if !item.Read {
			unread++
		}
	}

	c.text(2, 4, "YOUR DESK", colors.Accent, true)
	if c.w >= 70 {
		c.text(16, 4, "A place for the next consideration.", colors.Muted, false)
	}
	summary := fmt.Sprintf("%02d reviews   /   %02d briefs   /   %02d unread", len(reviews), len(briefs), unread)
	c.text(2, 6, ansi.Truncate(summary, c.w-4, "…"), colors.Ink, false)

	if c.w < 70 {
		// Compact screens keep the two categories distinct instead of squeezing
		// two narrow columns together. The selected category receives more room.
		available := bottom - 9
		if len(reviews) == 0 {
			overviewLane(p, c, 2, 8, c.w-4, available, "READING DESK", briefs)
		} else if len(briefs) == 0 {
			overviewLane(p, c, 2, 8, c.w-4, available, "REVIEW QUEUE", reviews)
		} else {
			reviewHeight := max(4, available/2)
			briefHeight := available - reviewHeight
			current, ok := p.current()
			if ok && current.Kind == "review" && available >= 12 {
				reviewHeight = available * 3 / 5
				briefHeight = available - reviewHeight
			}
			overviewLane(p, c, 2, 8, c.w-4, reviewHeight, "REVIEW QUEUE", reviews)
			overviewLane(p, c, 2, 8+reviewHeight, c.w-4, briefHeight, "READING DESK", briefs)
		}
		return
	}

	laneHeight := min(max(7, (bodyHeight-5)*58/100), max(0, bottom-8))
	leftWidth := (c.w - 7) / 2
	rightX := leftWidth + 5
	overviewLane(p, c, 2, 8, leftWidth, laneHeight, "REVIEW QUEUE", reviews)
	overviewLane(p, c, rightX, 8, c.w-rightX-2, laneHeight, "READING DESK", briefs)
	for y := 8; y < 8+laneHeight; y++ {
		c.text(leftWidth+3, y, "│", colors.Line, false)
	}

	readerY := 8 + laneHeight + 1
	if readerY+3 >= bottom {
		return
	}
	c.inlineReader = true
	c.fill(1, readerY, c.w-2, bottom-readerY-1, colors.Surface)
	c.text(3, readerY, " ON YOUR DESK ", colors.Accent, true)
	if item, ok := p.current(); ok {
		kind := "BRIEF"
		if item.Kind == "review" {
			kind = "REVIEW"
		}
		c.text(c.w-len(kind)-4, readerY, kind, colors.Tag, false)
	}
	p.preview(c, 3, readerY+2, c.w-6, max(1, bottom-readerY-3))
}

func overviewLane(p *appModel, c *canvas, x, y, width, height int, title string, entries []overviewEntry) {
	if height < 3 || width < 6 {
		return
	}
	colors := p.palette()
	c.text(x, y, title, colors.Muted, true)
	count := fmt.Sprintf("%02d", len(entries))
	c.text(x+width-len(count), y, count, colors.Accent, true)
	c.rule(x, y+1, width, colors.Line)
	capacity := max(1, (height-2)/2)
	start := 0
	selectedInLane := false
	for index, entry := range entries {
		if entry.index == p.base.selected {
			selectedInLane = true
			start = max(0, index-capacity+1)
			break
		}
	}
	if selectedInLane || c.listPage == 0 {
		c.listPage = capacity
	}
	for slot := 0; slot < capacity && start+slot < len(entries); slot++ {
		entry := entries[start+slot]
		rowY := y + 2 + slot*2
		if rowY+1 >= y+height {
			break
		}
		selected := entry.index == p.base.selected
		if selected {
			c.fill(x, rowY, width, 2, colors.Select)
		}
		marker := "·"
		if !entry.item.Read {
			marker = "●"
		}
		if selected {
			marker = "›"
		}
		c.text(x, rowY, marker, colors.Accent, selected)
		c.text(x+2, rowY, ansi.Truncate(singleLine(entry.item.Title), width-3, "…"), colors.Ink, selected || !entry.item.Read)
		meta := entry.item.Source
		if entry.item.Status != "" {
			meta += " · " + strings.ReplaceAll(entry.item.Status, "_", " ")
		} else if entry.item.UpdatedAt != "" {
			meta += " · " + formatInboxTime(entry.item.UpdatedAt)
		}
		if len(entry.item.Labels) > 0 {
			labels := compactItemLabels(entry.item.Labels, width-3)
			c.text(x+2, rowY+1, ansi.Truncate(labels+"  "+meta, width-3, "…"), colors.Tag, false)
		} else {
			c.text(x+2, rowY+1, ansi.Truncate(singleLine(meta), width-3, "…"), colors.Muted, false)
		}
		p.selectTarget(c, x, rowY, width, 2, entry.index)
	}
	if len(entries) == 0 {
		c.text(x+1, y+3, "Nothing waiting here.", colors.Muted, false)
	}
}
