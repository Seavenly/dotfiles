package main

// Stream places a chronological queue above a full-width reading surface.
import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
)

func renderStream(p *appModel, c *canvas) {
	if c.h < 22 {
		renderCompactQueue(p, c, "ACTIVITY")
		return
	}
	colors := p.palette()
	items := p.items()
	bottom := c.h - 3
	bodyHeight := bottom - 4
	if bodyHeight < 4 {
		return
	}

	if c.w < 70 && p.base.detail {
		p.textButton(c, 2, 4, "< Activity", "back", false)
		c.text(max(2, c.w-16), 4, "READING", colors.Muted, false)
		c.rule(2, 5, c.w-4, colors.Line)
		p.preview(c, 3, 7, c.w-6, max(1, bottom-8))
		return
	}

	c.text(2, 4, "ACTIVITY", colors.Accent, true)
	count := fmt.Sprintf("%02d in view", len(items))
	c.text(max(2, c.w-len(count)-3), 4, count, colors.Muted, false)

	if len(items) == 0 {
		c.text(3, 7, "A little quiet. Nothing in this view.", colors.Muted, false)
	}

	timelineHeight := bodyHeight
	if c.w >= 70 {
		timelineHeight = max(7, bodyHeight*55/100)
	}
	capacity := max(1, (timelineHeight-2)/2)
	c.listPage = capacity
	start := p.listStart(capacity)
	for slot := 0; slot < capacity && start+slot < len(items); slot++ {
		index := start + slot
		item := items[index]
		y := 6 + slot*2
		if y+1 >= bottom {
			break
		}
		selected := index == p.base.selected
		if selected {
			c.fill(1, y, c.w-2, 2, colors.Select)
			c.text(1, y, "▎", colors.Accent, true)
		}
		stamp := streamTime(item.UpdatedAt)
		c.text(3, y, stamp, colors.Muted, false)
		mark := "·"
		if !item.Read {
			mark = "●"
		}
		c.text(10, y, mark, colors.Accent, false)
		c.text(10, y+1, "│", colors.Line, false)
		titleWidth := max(1, c.w-15)
		c.text(13, y, ansi.Truncate(singleLine(item.Title), titleWidth, "…"), colors.Ink, !item.Read || selected)
		kind := "BRIEF"
		if item.Kind == "review" {
			kind = "REVIEW"
		}
		meta := kind + " / " + item.Source
		if item.Status != "" {
			meta += " / " + strings.ReplaceAll(item.Status, "_", " ")
		}
		if c.w >= 96 {
			meta += "   " + streamExcerpt(item.Body)
		}
		if len(item.Labels) > 0 {
			labels := compactItemLabels(item.Labels, titleWidth)
			c.text(13, y+1, ansi.Truncate(labels+"  "+meta, titleWidth, "…"), colors.Tag, false)
		} else {
			c.text(13, y+1, ansi.Truncate(singleLine(meta), titleWidth, "…"), colors.Muted, false)
		}
		p.selectTarget(c, 1, y, c.w-2, 2, index)
	}

	if c.w < 70 {
		return
	}

	readerY := 4 + timelineHeight
	if readerY+3 >= bottom {
		return
	}
	c.inlineReader = true
	c.rule(2, readerY, c.w-4, colors.Line)
	c.text(3, readerY, " READING NOW ", colors.Accent, true)
	position := fmt.Sprintf(" %02d / %02d ", p.base.selected+1, len(items))
	c.text(max(3, c.w-len(position)-3), readerY, position, colors.Muted, false)
	p.preview(c, 3, readerY+2, c.w-6, max(1, bottom-readerY-3))
}

func streamTime(value string) string {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.Local().Format("15:04")
	}
	return "     "
}

func streamExcerpt(body string) string {
	for _, line := range strings.Split(cleanText(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, ">") || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "```") {
			continue
		}
		return line
	}
	return ""
}
