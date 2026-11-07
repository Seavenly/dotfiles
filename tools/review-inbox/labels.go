package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// compactItemLabels keeps category names visible in a queue row while making
// overflow explicit. The full label set remains available in the reader.
func compactItemLabels(labels []string, width int) string {
	if width <= 0 {
		return ""
	}
	names := make([]string, 0, len(labels))
	for _, label := range labels {
		if name := singleLine(label); name != "" {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return ""
	}
	chips := make([]string, 0, len(names))
	best := ""
	for index, name := range names {
		chips = append(chips, "["+name+"]")
		text := strings.Join(chips, " ")
		if left := len(names) - index - 1; left > 0 {
			text += fmt.Sprintf(" +%d", left)
		}
		if ansi.StringWidth(text) > width {
			break
		}
		best = text
	}
	if best != "" {
		return best
	}
	suffix := ""
	if len(names) > 1 {
		suffix = fmt.Sprintf(" +%d", len(names)-1)
	}
	budget := width - ansi.StringWidth(suffix)
	if budget >= 4 {
		return "[" + ansi.Truncate(names[0], budget-2, "…") + "]" + suffix
	}
	return ansi.Truncate("["+names[0]+"]", width, "…")
}
