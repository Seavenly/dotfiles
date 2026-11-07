package main

import (
	"github.com/charmbracelet/x/ansi"
	"strings"
	"time"
	"unicode"
)

func cleanText(s string) string {
	s = ansi.Strip(strings.ReplaceAll(s, "\t", "    "))
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' {
			return -1
		}
		return r
	}, s)
}
func singleLine(s string) string { return strings.Join(strings.Fields(cleanText(s)), " ") }

// Keep producer timestamps exact in the API while showing a readable local
// time in a narrow terminal.
func formatInboxTime(value string) string {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.Local().Format("Jan 2, 15:04")
	}
	return value
}
