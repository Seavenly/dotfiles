package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestCompactLabelsShowNamesAndCountOverflow(t *testing.T) {
	labels := []string{"agent:ready", "risk:low", "size:S"}
	if got := compactItemLabels(labels, 29); got != "[agent:ready] [risk:low] +1" {
		t.Fatalf("labels lost names or overflow count: %q", got)
	}
	if got := compactItemLabels(labels, 80); got != "[agent:ready] [risk:low] [size:S]" {
		t.Fatalf("full labels: %q", got)
	}
	got := compactItemLabels([]string{"team:platform-feature-work", "risk:low"}, 18)
	if !strings.HasPrefix(got, "[team:") || !strings.HasSuffix(got, " +1") {
		t.Fatalf("long first label should stay recognizable: %q", got)
	}
}

func TestCompactLabelsFitNarrowUnicodeRows(t *testing.T) {
	for width := 0; width <= 45; width++ {
		got := compactItemLabels([]string{"分類:レビュー", "agent:ready", "risk:low"}, width)
		if ansi.StringWidth(got) > width {
			t.Fatalf("width%d: label overflow %q", width, got)
		}
	}
	if compactItemLabels(nil, 20) != "" || compactItemLabels([]string{" "}, 20) != "" {
		t.Fatal("empty labels should not leave placeholders")
	}
	if got := compactItemLabels([]string{"\x1b[31magent:ready\x1b[0m"}, 30); strings.Contains(got, "\x1b") {
		t.Fatalf("label exposed terminal controls: %q", got)
	}
}
