package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// Navigator is a three-pane reading workspace. Its navigation
// rail stays quiet; color is reserved for the current location and selection.
func renderNavigator(p *appModel, c *canvas) {
	y, h := 4, c.h-7
	if h < 1 {
		return
	}
	pal := p.palette()
	if c.w >= 105 {
		c.inlineReader = true
		railW := 19
		queueW := max(32, min(42, (c.w-railW)*2/5))
		navigatorRail(p, c, 0, y, railW, h)
		navigatorDivider(c, railW, y, h, pal.Line)
		navigatorQueue(p, c, railW+1, y, queueW, h)
		navigatorDivider(c, railW+queueW+1, y, h, pal.Line)
		navigatorReader(p, c, railW+queueW+2, y, c.w-railW-queueW-2, h, false)
		return
	}
	if c.w >= 88 {
		c.inlineReader = true
		queueW := max(32, c.w*2/5)
		navigatorQueue(p, c, 0, y, queueW, h)
		navigatorDivider(c, queueW, y, h, pal.Line)
		navigatorReader(p, c, queueW+1, y, c.w-queueW-1, h, false)
		return
	}
	if c.w >= 70 {
		railW := 17
		navigatorRail(p, c, 0, y, railW, h)
		navigatorDivider(c, railW, y, h, pal.Line)
		if p.base.detail {
			navigatorReader(p, c, railW+1, y, c.w-railW-1, h, true)
		} else {
			navigatorQueue(p, c, railW+1, y, c.w-railW-1, h)
		}
		return
	}
	if p.base.detail {
		navigatorReader(p, c, 0, y, c.w, h, true)
	} else {
		navigatorQueue(p, c, 0, y, c.w, h)
	}
}

func navigatorRail(p *appModel, c *canvas, x, y, w, h int) {
	pal := p.palette()
	c.fill(x, y, w, h, pal.Surface)
	navigatorText(c, x+2, y, w-4, "WORKSPACE", pal.Muted, true)
	counts := [3]int{}
	sources := map[string]int{}
	for _, item := range p.base.items {
		if item.Dismissed != p.base.dismissed {
			continue
		}
		counts[0]++
		if item.Kind == "review" {
			counts[1]++
		} else {
			counts[2]++
		}
		sources[item.Source]++
	}
	labels := []string{"Attention", "Reviews", "Briefs"}
	actions := []string{"attention", "reviews", "briefs"}
	for i, label := range labels {
		row := y + 2 + i*2
		if row >= y+h {
			break
		}
		fg, marker := pal.Ink, " "
		if p.base.view == i {
			fg, marker = pal.Accent, "›"
			c.fill(x+1, row, w-2, 1, pal.Select)
		}
		navigatorText(c, x+1, row, w-2, marker+" "+label, fg, p.base.view == i)
		count := fmt.Sprint(counts[i])
		c.text(x+w-2-len(count), row, count, pal.Muted, false)
		c.target(x+1, row, w-2, 1, actions[i], 0)
	}
	if h > 11 {
		c.rule(x+2, y+9, w-4, pal.Line)
		navigatorText(c, x+2, y+11, w-4, "SOURCES", pal.Muted, true)
	}
	names := make([]string, 0, len(sources))
	for source := range sources {
		names = append(names, source)
	}
	sort.Strings(names)
	for i, source := range names {
		row := y + 13 + i*2
		if row >= y+h-3 {
			break
		}
		fg, branch := pal.Muted, "├"
		if i == len(names)-1 {
			branch = "└"
		}
		if p.base.source == source {
			fg = pal.Accent
			c.fill(x+1, row, w-2, 1, pal.Select)
		}
		navigatorText(c, x+2, row, w-7, branch+" "+source, fg, false)
		count := fmt.Sprint(sources[source])
		c.text(x+w-2-len(count), row, count, pal.Muted, false)
		c.target(x+1, row, w-2, 1, "source:"+source, 0)
	}
	if h > 17 {
		navigatorText(c, x+2, y+h-2, w-4, "○ HOST LOCAL", pal.Muted, false)
	}
}

func navigatorQueue(p *appModel, c *canvas, x, y, w, h int) {
	pal := p.palette()
	items := p.items()
	label := "ALL ITEMS"
	if p.base.view == 1 {
		label = "REVIEW QUEUE"
	} else if p.base.view == 2 {
		label = "READING LIST"
	}
	navigatorText(c, x+2, y, w-9, label, pal.Ink, true)
	count := fmt.Sprintf("%02d", len(items))
	c.text(x+w-4, y, count, pal.Accent, true)
	c.rule(x+2, y+1, w-4, pal.Line)
	capacity := max(1, (h-3)/2)
	c.listPage = capacity
	if len(items) == 0 {
		navigatorText(c, x+2, y+3, w-4, "No items in this view.", pal.Muted, false)
		return
	}
	start := p.listStart(capacity)
	for row := 0; row < capacity && start+row < len(items); row++ {
		index := start + row
		item := items[index]
		lineY := y + 2 + row*2
		if lineY >= y+h-1 {
			break
		}
		fg, marker := pal.Ink, "●"
		if item.Read {
			fg, marker = pal.Muted, "○"
		}
		if index == p.base.selected {
			c.fill(x+1, lineY, w-2, min(2, y+h-lineY), pal.Select)
			c.text(x, lineY, "▎", pal.Accent, true)
			fg = pal.Ink
		}
		c.text(x+2, lineY, marker, pal.Accent, false)
		navigatorText(c, x+4, lineY, w-6, singleLine(item.Title), fg, !item.Read)
		kind := "brief"
		if item.Kind == "review" {
			kind = "review"
		}
		meta := item.Source + "  /  " + kind
		if item.Status != "" && w >= 39 {
			meta += "  /  " + strings.ReplaceAll(item.Status, "_", " ")
		}
		if lineY+1 < y+h-1 {
			if len(item.Labels) > 0 {
				c.text(x+4, lineY+1, compactItemLabels(item.Labels, w-6), pal.Tag, false)
			} else {
				navigatorText(c, x+4, lineY+1, w-6, meta, pal.Muted, false)
			}
		}
		p.selectTarget(c, x+1, lineY, w-2, min(2, y+h-lineY), index)
	}
	position := fmt.Sprintf("%02d / %02d", min(len(items), p.base.selected+1), len(items))
	navigatorText(c, x+2, y+h-1, w-4, position+"  ·  j/k navigate", pal.Muted, false)
}

func navigatorReader(p *appModel, c *canvas, x, y, w, h int, back bool) {
	pal := p.palette()
	item, ok := p.current()
	if back {
		p.textButton(c, x+2, y, "‹ Queue", "back", false)
	} else {
		navigatorText(c, x+2, y, w-4, "CONTEXT", pal.Muted, true)
	}
	if ok && w >= 40 {
		source := singleLine(item.Source)
		c.text(x+w-2-min(ansi.StringWidth(source), w/2), y, ansi.Truncate(source, w/2, "…"), pal.Accent, false)
	}
	c.rule(x+2, y+1, w-4, pal.Line)
	if h > 4 {
		p.preview(c, x+3, y+3, w-6, h-4)
	}
}

func navigatorDivider(c *canvas, x, y, h int, fg string) {
	for row := 0; row < h; row++ {
		c.text(x, y+row, "│", fg, false)
	}
}

func navigatorText(c *canvas, x, y, width int, text, fg string, bold bool) {
	if width <= 0 {
		return
	}
	c.text(x, y, ansi.Truncate(singleLine(text), width, "…"), fg, bold)
}
