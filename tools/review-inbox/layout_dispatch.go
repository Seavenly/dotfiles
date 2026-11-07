package main

// Dispatch keeps a compact contents index beside a generous reading surface.

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
)

func renderDispatch(p *appModel, c *canvas) {
	if c.h < 22 {
		renderCompactQueue(p, c, "DISPATCH")
		return
	}
	colors := p.palette()
	items := p.items()
	wide := c.w >= 76
	c.inlineReader = wide
	margin := 3
	if c.w < 40 {
		margin = 2
	}
	width := c.w - 2*margin
	c.text(margin, 4, "T H E  D I S P A T C H", colors.Ink, true)
	if c.w >= 64 {
		date := strings.ToUpper(time.Now().Format("Mon, 02 Jan 2006"))
		c.text(c.w-margin-len(date), 4, date, colors.Muted, false)
	}
	tagline := "A quieter place to consider what comes next."
	if c.w < 60 {
		tagline = "A daily reading room."
	}
	c.text(margin, 5, tagline, colors.Muted, false)
	c.rule(margin, 7, width, colors.Ink)

	if !wide && !p.base.detail {
		c.text(margin, 9, "IN THIS EDITION", colors.Accent, true)
		capacity := max(1, (c.h-16)/3)
		c.listPage = capacity
		start := p.listStart(capacity)
		for row := 0; row < capacity && start+row < len(items); row++ {
			index := start + row
			item := items[index]
			y := 11 + row*3
			if index == p.base.selected {
				c.fill(margin-1, y, width+2, 2, colors.Select)
			}
			c.text(margin, y, fmt.Sprintf("%02d", index+1), colors.Accent, true)
			c.text(margin+4, y, ledgerClip(item.Title, width-4), colors.Ink, !item.Read)
			kind := "READING"
			if item.Kind == "review" {
				kind = "REVIEW"
			}
			if len(item.Labels) > 0 {
				c.text(margin+4, y+1, compactItemLabels(item.Labels, width-4), colors.Tag, false)
			} else {
				c.text(margin+4, y+1, ledgerClip(kind+"  /  "+item.Source, width-4), colors.Muted, false)
			}
			p.selectTarget(c, margin-1, y, width+2, 2, index)
		}
		if len(items) == 0 {
			c.text(margin, 11, ledgerClip("Nothing in this edition yet.", width), colors.Muted, false)
		}
		c.rule(margin, c.h-5, width, colors.Line)
		c.text(margin, c.h-4, "Select a story to begin reading.", colors.Muted, false)
		return
	}

	if !wide {
		p.textButton(c, margin, 8, "‹ Contents", "back", false)
		p.preview(c, margin, 10, width, max(1, c.h-15))
		return
	}

	indexWidth := max(19, min(27, c.w/4))
	c.text(margin, 9, "CONTENTS", colors.Accent, true)
	c.text(margin, 10, fmt.Sprintf("%02d things to consider", len(items)), colors.Muted, false)
	capacity := max(1, (c.h-17)/3)
	c.listPage = capacity
	start := p.listStart(capacity)
	for row := 0; row < capacity && start+row < len(items); row++ {
		index := start + row
		item := items[index]
		y := 12 + row*3
		rowHeight := 2
		if len(item.Labels) > 0 {
			rowHeight = 3
		}
		ink := colors.Muted
		if index == p.base.selected {
			c.fill(margin-1, y, indexWidth-2, rowHeight, colors.Select)
			c.text(margin-1, y, "▎", colors.Accent, true)
			ink = colors.Ink
		}
		c.text(margin, y, fmt.Sprintf("%02d", index+1), colors.Accent, false)
		for lineIndex, line := range dispatchTitleLines(item.Title, indexWidth-8) {
			c.text(margin+4, y+lineIndex, line, ink, index == p.base.selected)
		}
		if len(item.Labels) > 0 {
			c.text(margin, y+2, compactItemLabels(item.Labels, indexWidth-4), colors.Tag, false)
		}
		p.selectTarget(c, margin-1, y, indexWidth-2, rowHeight, index)
	}
	if len(items) == 0 {
		c.text(margin, 12, "An open page.", colors.Muted, false)
	}

	articleX := margin + indexWidth + 2
	articleWidth := c.w - articleX - margin
	// A restrained reading measure leaves deliberate breathing room on a wide
	// terminal instead of stretching paragraphs into an exhausting long line.
	measure := min(76, articleWidth)
	articleX += max(0, (articleWidth-measure)/2)
	if item, ok := p.current(); ok {
		label := "READING ROOM"
		if item.Kind == "review" {
			label = "AT THE REVIEW DESK"
		}
		c.text(articleX, 9, label, colors.Accent, true)
		p.preview(c, articleX, 11, measure, max(1, c.h-17))
		c.rule(articleX, c.h-5, measure, colors.Line)
		c.text(articleX, c.h-4, fmt.Sprintf("STORY %02d / %02d", p.base.selected+1, len(items)), colors.Muted, false)
		if measure >= 46 {
			c.text(articleX+measure-26, c.h-4, "Take your time. Then decide.", colors.Accent, false)
		}
	} else {
		c.text(articleX, 9, "READING ROOM", colors.Accent, true)
		p.preview(c, articleX, 11, measure, max(1, c.h-17))
	}
}

func dispatchTitleLines(title string, width int) []string {
	lines := strings.Split(ansi.Wrap(singleLine(title), max(1, width), ""), "\n")
	if len(lines) > 2 {
		lines = lines[:2]
		lines[1] = ansi.Truncate(lines[1], max(1, width-1), "") + "…"
	}
	return lines
}
