package main

import (
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/rivo/uniseg"
	"strings"
)

type rect struct{ x, y, w, h int }

func (r rect) contains(x, y int) bool {
	return r.w > 0 && r.h > 0 && x >= r.x && x < r.x+r.w && y >= r.y && y < r.y+r.h
}

type hitTarget struct {
	x, y, width, height int
	action              string
	index               int
}
type palette struct{ BG, Surface, Ink, Muted, Accent, Line, Select, Tag string }

// All layouts share Kanagawa Wave so layout is the only design
// variable. Palette source: github.com/rebelot/kanagawa.nvim, colors.lua.
var kanagawaPalette = palette{
	BG:      "#1F1F28", // sumiInk3
	Surface: "#16161D", // sumiInk0
	Ink:     "#DCD7BA", // fujiWhite
	Muted:   "#727169", // fujiGray
	Accent:  "#7E9CD8", // crystalBlue
	Line:    "#54546D", // sumiInk6
	Select:  "#223249", // waveBlue1
	Tag:     "#98BB6C", // springGreen
}

type cell struct {
	Text, FG, BG string
	Bold         bool
}
type cellRun struct {
	Text string `json:"text"`
	FG   string `json:"fg"`
	BG   string `json:"bg"`
	Bold bool   `json:"bold,omitempty"`
}
type canvas struct {
	w, h         int
	cells        [][]cell
	targets      []hitTarget
	palette      palette
	reader       rect
	inlineReader bool
	listPage     int
}

func newCanvas(w, h int, p palette) *canvas {
	c := &canvas{w: w, h: h, palette: p, cells: make([][]cell, h)}
	for y := range h {
		c.cells[y] = make([]cell, w)
		for x := range w {
			c.cells[y][x] = cell{" ", p.Ink, p.BG, false}
		}
	}
	return c
}
func (c *canvas) text(x, y int, s, fg string, bold bool) {
	if y < 0 || y >= c.h || x >= c.w {
		return
	}
	if fg == "" {
		fg = c.palette.Ink
	}
	g := uniseg.NewGraphemes(strings.ReplaceAll(cleanText(s), "\n", " "))
	for g.Next() {
		text := g.Str()
		width := ansi.StringWidth(text)
		if width == 0 {
			continue
		}
		if x+width > c.w {
			break
		}
		if x >= 0 {
			c.cells[y][x] = cell{text, fg, c.cells[y][x].BG, bold}
			for offset := 1; offset < width; offset++ {
				c.cells[y][x+offset] = cell{"", fg, c.cells[y][x+offset].BG, bold}
			}
		}
		x += width
	}
}
func (c *canvas) fill(x, y, w, h int, bg string) {
	for row := max(0, y); row < min(c.h, y+h); row++ {
		for col := max(0, x); col < min(c.w, x+w); col++ {
			c.cells[row][col] = cell{" ", c.palette.Ink, bg, false}
		}
	}
}
func (c *canvas) rule(x, y, w int, fg string) {
	c.text(x, y, strings.Repeat("─", max(0, min(w, c.w-max(0, x)))), fg, false)
}
func (c *canvas) box(x, y, w, h int, title, fg string) {
	if w < 2 || h < 2 {
		return
	}
	c.rule(x+1, y, w-2, fg)
	c.rule(x+1, y+h-1, w-2, fg)
	for row := y + 1; row < y+h-1; row++ {
		c.text(x, row, "│", fg, false)
		c.text(x+w-1, row, "│", fg, false)
	}
	c.text(x, y, "╭", fg, false)
	c.text(x+w-1, y, "╮", fg, false)
	c.text(x, y+h-1, "╰", fg, false)
	c.text(x+w-1, y+h-1, "╯", fg, false)
	if title != "" {
		c.text(x+2, y, " "+ansi.Truncate(title, max(0, w-6), "")+" ", fg, true)
	}
}
func (c *canvas) target(x, y, w, h int, action string, index int) {
	if x < 0 || y < 0 || x >= c.w || y >= c.h || w <= 0 || h <= 0 {
		return
	}
	c.targets = append(c.targets, hitTarget{x, y, min(w, c.w-x), min(h, c.h-y), action, index})
}
func (c *canvas) runs() [][]cellRun {
	rows := make([][]cellRun, c.h)
	for y, row := range c.cells {
		for _, cell := range row {
			if cell.Text == "" {
				continue
			}
			n := len(rows[y])
			if n > 0 && rows[y][n-1].FG == cell.FG && rows[y][n-1].BG == cell.BG && rows[y][n-1].Bold == cell.Bold {
				rows[y][n-1].Text += cell.Text
			} else {
				rows[y] = append(rows[y], cellRun{cell.Text, cell.FG, cell.BG, cell.Bold})
			}
		}
	}
	return rows
}
func (c *canvas) view() string {
	var out strings.Builder
	for y, row := range c.runs() {
		if y > 0 {
			out.WriteByte('\n')
		}
		for _, run := range row {
			style := lipgloss.NewStyle().Foreground(lipgloss.Color(run.FG)).Background(lipgloss.Color(run.BG)).Bold(run.Bold)
			out.WriteString(style.Render(run.Text))
		}
	}
	return out.String()
}
