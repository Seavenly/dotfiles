package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func layoutGeometryFixture(width, height int, detail bool) *appModel {
	items := make([]Item, 24)
	for index := range items {
		kind := "review"
		if index%2 == 1 {
			kind = "brief"
		}
		items[index] = Item{
			Source: "fixture", ID: fmt.Sprint(index), Kind: kind,
			Title:  fmt.Sprintf("Item %02d: café 日本語 and a longer title", index),
			Labels: []string{"agent:ready", "risk:low"},
			Body:   "# Context\n\n" + strings.Repeat("Useful context for a readable preview.\n", 20),
		}
	}
	return &appModel{base: &inboxState{
		items: items, selected: len(items) - 1,
		width: width, height: height, detail: detail, loaded: true,
	}}
}

func TestLayoutGeometryKeepsSelectedItemsReachable(t *testing.T) {
	renderers := []struct {
		name   string
		render func(*appModel, *canvas)
	}{
		{"ledger", renderLedger}, {"dispatch", renderDispatch},
		{"navigator", renderNavigator}, {"stream", renderStream},
		{"overview", renderOverview},
	}
	for _, renderer := range renderers {
		for _, size := range [][2]int{{28, 14}, {44, 18}, {80, 24}, {120, 38}} {
			for _, detail := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%dx%d/detail=%t", renderer.name, size[0], size[1], detail), func(t *testing.T) {
					model := layoutGeometryFixture(size[0], size[1], detail)
					frame := newCanvas(size[0], size[1], model.palette())
					renderer.render(model, frame)
					selectedVisible, queueVisible := false, false
					for _, target := range frame.targets {
						if target.x < 0 || target.x+target.width > size[0] || target.y < 4 || target.y+target.height > size[1]-3 {
							t.Errorf("target escaped the body: %+v", target)
						}
						if target.action == "select" {
							queueVisible = true
							selectedVisible = selectedVisible || target.index == model.base.selected
						}
					}
					if queueVisible && !selectedVisible {
						t.Fatal("selected item is outside the visible queue")
					}
					if queueVisible && frame.listPage < 1 {
						t.Fatal("queue did not report its visible page capacity")
					}
					if frame.reader.w > 0 {
						if frame.reader.h < 1 || frame.reader.x < 0 || frame.reader.x+frame.reader.w > size[0] || frame.reader.y < 4 || frame.reader.y+frame.reader.h > size[1]-3 {
							t.Errorf("reader escaped the body: %+v", frame.reader)
						}
					} else if !queueVisible {
						t.Fatal("layout exposed neither queue nor reader")
					}
					if frame.inlineReader && (!queueVisible || frame.reader.w < 1) {
						t.Fatal("inline reader geometry disagrees with visible controls")
					}
					rows := frame.runs()
					if len(rows) != size[1] {
						t.Fatalf("rendered %d rows; expected %d", len(rows), size[1])
					}
					for row, runs := range rows {
						var text strings.Builder
						for _, run := range runs {
							text.WriteString(run.Text)
						}
						if width := ansi.StringWidth(text.String()); width != size[0] {
							t.Errorf("row %d width %d; expected %d", row, width, size[0])
						}
					}
				})
			}
		}
	}
}

func TestWideEmptyLayoutsKeepReaderGeometry(t *testing.T) {
	for _, renderer := range []struct {
		name   string
		render func(*appModel, *canvas)
	}{
		{"ledger", renderLedger}, {"dispatch", renderDispatch},
		{"navigator", renderNavigator}, {"stream", renderStream},
		{"overview", renderOverview},
	} {
		t.Run(renderer.name, func(t *testing.T) {
			model := layoutGeometryFixture(120, 38, false)
			model.base.items = nil
			model.base.selected = 0
			frame := newCanvas(120, 38, model.palette())
			renderer.render(model, frame)
			if !frame.inlineReader || frame.reader.w < 1 || frame.reader.h < 1 {
				t.Fatalf("empty layout lost its reader geometry: inline=%t reader=%+v", frame.inlineReader, frame.reader)
			}
		})
	}
}
