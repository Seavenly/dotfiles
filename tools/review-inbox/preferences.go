package main

import "fmt"

var layoutNames = []string{"Ledger", "Dispatch", "Navigator", "Stream", "Overview"}
var layoutSlugs = []string{"ledger", "dispatch", "navigator", "stream", "overview"}

func validLayout(name string) bool {
	for _, candidate := range layoutSlugs {
		if name == candidate {
			return true
		}
	}
	return false
}

func (h *Hub) Layout() (string, error) {
	state, err := h.load()
	if err != nil {
		return "", err
	}
	if state.Layout == "" {
		return "navigator", nil
	}
	if !validLayout(state.Layout) {
		return "", fmt.Errorf("invalid saved layout %q; run review-inbox layout navigator", state.Layout)
	}
	return state.Layout, nil
}

func (h *Hub) SetLayout(name string) error {
	if !validLayout(name) {
		return fmt.Errorf("unknown layout %q; choose ledger, dispatch, navigator, stream, or overview", name)
	}
	return h.mutate(func(state *hubState) error {
		state.Layout = name
		return nil
	})
}
