package main

import "strings"

// The inbox state is independent of layout and terminal geometry.
type inboxState struct {
	items                                      []Item
	warnings                                   []string
	width, height                              int
	view, selected, listOffset, previewOffset  int
	detail, previewFocus, dismissed, searching bool
	query, source, status                      string
	busy, loaded, failed                       bool
}

func (s *inboxState) filtered() []Item {
	items := make([]Item, 0, len(s.items))
	query := strings.ToLower(s.query)
	for _, item := range s.items {
		if item.Dismissed != s.dismissed || (s.source != "" && item.Source != s.source) {
			continue
		}
		if s.view == 1 && item.Kind != "review" || s.view == 2 && item.Kind != "brief" {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(item.Title+" "+item.Source+" "+item.ID+" "+item.Body+" "+item.Token+" "+item.Status+" "+strings.Join(item.Labels, " ")), query) {
			continue
		}
		items = append(items, item)
	}
	return items
}
func (s *inboxState) current() (Item, bool) {
	items := s.filtered()
	if s.selected < 0 || s.selected >= len(items) {
		return Item{}, false
	}
	return items[s.selected], true
}
func (s *inboxState) normalize() {
	s.selected = max(0, min(s.selected, len(s.filtered())-1))
	s.listOffset = max(0, s.listOffset)
	if len(s.filtered()) == 0 {
		s.previewOffset = 0
		s.detail = false
		s.previewFocus = false
	}
}
