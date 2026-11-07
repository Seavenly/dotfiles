package main

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

type hubAPI interface {
	Items() ([]Item, []string, error)
	SetState(string, string, string) error
	Open(Item) error
	Copy(Item) error
}
type layoutSaver interface{ SetLayout(string) error }
type itemsLoadedMsg struct {
	items          []Item
	warnings       []string
	err            error
	request, epoch uint64
	notice         string
}
type actionFinishedMsg struct {
	items         []Item
	warnings      []string
	err           error
	refresh, quit bool
	notice        string
}
type layoutSavedMsg struct {
	name string
	err  error
}
type refreshTickMsg time.Time

// One controller owns behavior for all five renderers. Renderers report their
// actual geometry rather than teaching input handling about each layout.
type appModel struct {
	base                    *inboxState
	hub                     hubAPI
	layout                  int
	loading, acting         bool
	request, epoch          uint64
	errorFromLoad           bool
	picker, help            bool
	pickerIndex, helpScroll int
	savingLayout            bool
	wantedLayout            string
	quitRequested           bool
}

func newAppModel(h hubAPI, layout string) *appModel {
	index := 2
	for i, name := range layoutSlugs {
		if name == layout {
			index = i
		}
	}
	return &appModel{hub: h, layout: index, base: &inboxState{width: 100, height: 30, busy: true}}
}
func runTUI(h *Hub, override string) error {
	name := override
	if name == "" {
		var err error
		name, err = h.Layout()
		if err != nil {
			return err
		}
	}
	if !validLayout(name) {
		return fmt.Errorf("unknown layout %q", name)
	}
	_, err := tea.NewProgram(newAppModel(h, name)).Run()
	return err
}
func (m *appModel) palette() palette      { return kanagawaPalette }
func (m *appModel) items() []Item         { return m.base.filtered() }
func (m *appModel) current() (Item, bool) { return m.base.current() }
func (m *appModel) listStart(capacity int) int {
	capacity = max(1, capacity)
	start := max(0, min(m.base.listOffset, max(0, len(m.items())-capacity)))
	if m.base.selected < start {
		start = m.base.selected
	}
	if m.base.selected >= start+capacity {
		start = m.base.selected - capacity + 1
	}
	return max(0, start)
}
func (m *appModel) selectTarget(c *canvas, x, y, w, h, index int) {
	c.target(x, y, w, h, "select", index)
}
func (m *appModel) Init() tea.Cmd { return tea.Batch(m.requestLoad(""), refreshTick()) }
func refreshTick() tea.Cmd {
	return tea.Tick(4*time.Second, func(t time.Time) tea.Msg { return refreshTickMsg(t) })
}
func (m *appModel) syncBusy() { m.base.busy = m.loading || m.acting }

func (m *appModel) requestQuit() tea.Cmd {
	if m.acting || m.savingLayout {
		m.quitRequested = true
		m.base.status = "Finishing pending changes before quitting…"
		return nil
	}
	return tea.Quit
}
func (m *appModel) requestLoad(notice string) tea.Cmd {
	if m.loading || m.acting {
		return nil
	}
	m.loading = true
	m.request++
	m.syncBusy()
	request, epoch := m.request, m.epoch
	return func() tea.Msg {
		items, warnings, err := m.hub.Items()
		return itemsLoadedMsg{items, warnings, err, request, epoch, notice}
	}
}
func (m *appModel) setError(err error, fromLoad bool) {
	m.base.failed = true
	m.base.status = err.Error()
	m.errorFromLoad = fromLoad
}
func (m *appModel) applyItems(items []Item, warnings []string) {
	old, had := m.current()
	m.base.items = items
	m.base.warnings = warnings
	m.base.loaded = true
	found := false
	for index, item := range m.items() {
		if had && item.Key() == old.Key() {
			m.base.selected = index
			found = true
			if itemFingerprint(item) != itemFingerprint(old) {
				m.base.previewOffset = 0
			}
			break
		}
	}
	if !found {
		m.base.previewOffset = 0
	}
	m.base.normalize()
	m.reconcile()
}
func (m *appModel) reconcile() {
	m.base.normalize()
	c := m.screen()
	if c.listPage > 0 {
		m.base.listOffset = m.listStart(c.listPage)
	}
	if c.reader.w > 0 && c.reader.h > 0 {
		m.base.previewOffset = max(0, min(m.base.previewOffset, max(0, len(m.previewLines(c.reader.w))-c.reader.h)))
	}
}
func (m *appModel) inspect() {
	if _, ok := m.current(); !ok {
		return
	}
	c := m.screen()
	m.base.previewFocus = true
	m.base.detail = !c.inlineReader
	m.reconcile()
}
func (m *appModel) back() { m.base.detail = false; m.base.previewFocus = false; m.reconcile() }
func (m *appModel) scroll(delta int) {
	c := m.screen()
	if c.reader.w < 1 || c.reader.h < 1 {
		m.inspect()
		c = m.screen()
	}
	if c.reader.w < 1 || c.reader.h < 1 {
		return
	}
	m.base.previewOffset = max(0, min(m.base.previewOffset+delta, max(0, len(m.previewLines(c.reader.w))-c.reader.h)))
}
func (m *appModel) move(delta int) {
	m.base.selected += delta
	m.base.previewOffset = 0
	m.base.status = ""
	m.base.normalize()
	m.reconcile()
}
func (m *appModel) resetFilter() {
	m.base.selected = 0
	m.base.listOffset = 0
	m.base.previewOffset = 0
	m.base.detail = false
	m.base.previewFocus = false
	m.reconcile()
}
func (m *appModel) setView(view int) { m.base.view = view; m.resetFilter() }
func (m *appModel) startLayoutSave() tea.Cmd {
	saver, ok := m.hub.(layoutSaver)
	if !ok || m.savingLayout {
		return nil
	}
	name := m.wantedLayout
	m.savingLayout = true
	return func() tea.Msg { return layoutSavedMsg{name, saver.SetLayout(name)} }
}
func (m *appModel) switchLayout(index int) tea.Cmd {
	index = (index + len(layoutSlugs)) % len(layoutSlugs)
	m.layout = index
	m.picker = false
	reading := m.base.previewFocus || m.base.detail
	m.base.detail = false
	c := m.screen()
	m.base.detail = reading && !c.inlineReader
	m.base.previewFocus = reading
	m.reconcile()
	m.wantedLayout = layoutSlugs[index]
	return m.startLayoutSave()
}
func (m *appModel) perform(action string, index int) tea.Cmd {
	switch {
	case action == "quit":
		return m.requestQuit()
	case action == "layout-picker":
		m.picker = !m.picker
		m.help = false
		m.pickerIndex = m.layout
		return nil
	case strings.HasPrefix(action, "layout:"):
		return m.switchLayout(index)
	case action == "layout-prev":
		return m.switchLayout(m.layout - 1)
	case action == "layout-next":
		return m.switchLayout(m.layout + 1)
	case action == "help":
		m.help = !m.help
		m.picker = false
		m.helpScroll = 0
		return nil
	case action == "close-overlay":
		m.help = false
		m.picker = false
		return nil
	case action == "help-up":
		m.scrollHelp(-8)
		return nil
	case action == "help-down":
		m.scrollHelp(8)
		return nil
	case action == "attention":
		m.setView(0)
		return nil
	case action == "reviews":
		m.setView(1)
		return nil
	case action == "briefs":
		m.setView(2)
		return nil
	case strings.HasPrefix(action, "source:"):
		m.base.source = strings.TrimPrefix(action, "source:")
		m.resetFilter()
		return nil
	case action == "search":
		m.base.searching = true
		return nil
	case action == "search-done":
		m.base.searching = false
		return nil
	case action == "clear":
		m.base.query = ""
		m.base.source = ""
		m.base.searching = false
		m.resetFilter()
		return nil
	case action == "back":
		m.back()
		return nil
	case action == "dismissed":
		m.base.dismissed = !m.base.dismissed
		m.resetFilter()
		return nil
	case action == "select":
		m.base.selected = index
		m.base.previewOffset = 0
		m.base.previewFocus = false
		m.base.detail = false
		m.base.normalize()
		c := m.screen()
		if !c.inlineReader {
			m.inspect()
		}
		m.reconcile()
		return nil
	case action == "preview":
		m.base.previewFocus = true
		return nil
	case action == "previous":
		m.move(-1)
		return nil
	case action == "next":
		m.move(1)
		return nil
	case action == "scroll-up":
		m.scroll(-max(1, m.screen().reader.h/2))
		return nil
	case action == "scroll-down":
		m.scroll(max(1, m.screen().reader.h/2))
		return nil
	case action == "refresh":
		return m.requestLoad("Refreshed")
	}
	if m.acting {
		m.base.status = "Finishing the previous action…"
		return nil
	}
	item, ok := m.current()
	if !ok {
		return nil
	}
	if action == "open" && item.Worktree == "" && item.URL == "" {
		m.inspect()
		return nil
	}
	if action != "read" && action != "dismiss" && action != "open" && action != "copy" {
		return nil
	}
	m.acting = true
	m.epoch++
	m.syncBusy()
	switch action {
	case "read", "dismiss":
		operation, notice := "read", "Marked read"
		if action == "read" && item.Read {
			operation, notice = "unread", "Marked unread"
		}
		if action == "dismiss" {
			operation, notice = "dismiss", "Dismissed"
			if item.Dismissed {
				operation, notice = "restore", "Restored"
			}
		}
		return func() tea.Msg {
			if err := m.hub.SetState(item.Source, item.ID, operation); err != nil {
				return actionFinishedMsg{err: err}
			}
			items, warnings, err := m.hub.Items()
			return actionFinishedMsg{items: items, warnings: warnings, err: err, refresh: true, notice: notice}
		}
	case "open":
		return func() tea.Msg {
			return actionFinishedMsg{err: m.hub.Open(item), quit: item.Worktree != "", notice: "Opened"}
		}
	case "copy":
		return func() tea.Msg { return actionFinishedMsg{err: m.hub.Copy(item), notice: "Copied"} }
	}
	return nil
}
func (m *appModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		reading := m.base.detail || m.base.previewFocus
		m.base.width = max(1, msg.Width)
		m.base.height = max(1, msg.Height)
		m.base.detail = false
		c := m.screen()
		m.base.detail = reading && !c.inlineReader
		m.base.previewFocus = reading
		m.reconcile()
		if m.help {
			m.scrollHelp(0)
		}
	case itemsLoadedMsg:
		if msg.request != m.request {
			return m, nil
		}
		m.loading = false
		m.syncBusy()
		if msg.epoch != m.epoch {
			return m, nil
		}
		if msg.err != nil {
			m.base.loaded = true
			m.setError(msg.err, true)
			return m, nil
		}
		m.applyItems(msg.items, msg.warnings)
		if m.errorFromLoad {
			m.base.failed = false
			m.base.status = ""
			m.errorFromLoad = false
		}
		if msg.notice != "" {
			m.base.status = msg.notice
			m.base.failed = false
		}
	case actionFinishedMsg:
		m.acting = false
		m.syncBusy()
		if msg.err != nil {
			m.setError(msg.err, false)
			if m.quitRequested {
				return m, m.requestQuit()
			}
			return m, nil
		}
		if msg.refresh {
			m.applyItems(msg.items, msg.warnings)
		}
		m.base.status = msg.notice
		m.base.failed = false
		m.errorFromLoad = false
		if msg.quit || m.quitRequested {
			return m, m.requestQuit()
		}
	case layoutSavedMsg:
		m.savingLayout = false
		if m.wantedLayout != msg.name {
			return m, m.startLayoutSave()
		}
		if msg.err != nil {
			m.setError(fmt.Errorf("save layout: %w", msg.err), false)
		}
		if m.quitRequested {
			return m, m.requestQuit()
		}
	case refreshTickMsg:
		return m, tea.Batch(m.requestLoad(""), refreshTick())
	case tea.FocusMsg:
		return m, m.requestLoad("")
	case tea.PasteMsg:
		if m.base.searching {
			m.base.query += strings.ReplaceAll(cleanText(msg.String()), "\n", " ")
			m.resetFilter()
		}
	case tea.KeyPressMsg:
		key := msg.String()
		if key == "ctrl+c" {
			return m, tea.Quit
		}
		if key == "q" && (!m.base.searching || m.picker || m.help) {
			return m, m.requestQuit()
		}
		if m.quitRequested {
			return m, nil
		}
		if m.picker {
			switch key {
			case "esc", "L":
				m.picker = false
			case "up", "k":
				m.pickerIndex = (m.pickerIndex + 4) % 5
			case "down", "j":
				m.pickerIndex = (m.pickerIndex + 1) % 5
			case "enter":
				return m, m.switchLayout(m.pickerIndex)
			case "1", "2", "3", "4", "5":
				return m, m.switchLayout(int(key[0] - '1'))
			}
			return m, nil
		}
		if m.help {
			switch key {
			case "esc", "?", "q":
				m.help = false
			case "down", "j":
				m.scrollHelp(1)
			case "up", "k":
				m.scrollHelp(-1)
			case "pgdown", "ctrl+d":
				m.scrollHelp(8)
			case "pgup", "ctrl+u":
				m.scrollHelp(-8)
			}
			return m, nil
		}
		if m.base.searching {
			switch key {
			case "esc", "enter":
				m.base.searching = false
			case "backspace", "ctrl+h":
				r := []rune(m.base.query)
				if len(r) > 0 {
					m.base.query = string(r[:len(r)-1])
				}
			case "ctrl+u":
				m.base.query = ""
			default:
				if msg.Text != "" {
					m.base.query += strings.ReplaceAll(cleanText(msg.Text), "\n", " ")
				}
			}
			m.resetFilter()
			return m, nil
		}
		switch key {
		case "q":
			return m, m.requestQuit()
		case "L":
			return m, m.perform("layout-picker", 0)
		case "[":
			return m, m.switchLayout(m.layout - 1)
		case "]":
			return m, m.switchLayout(m.layout + 1)
		case "?":
			return m, m.perform("help", 0)
		case "1", "a":
			m.setView(0)
		case "2", "v":
			m.setView(1)
		case "3", "b":
			m.setView(2)
		case "/":
			m.base.searching = true
		case "esc", "backspace":
			if m.base.detail || m.base.previewFocus {
				m.back()
			} else {
				m.base.query = ""
				m.base.source = ""
				m.resetFilter()
			}
		case "enter", "right", "l":
			m.inspect()
		case "left", "h":
			m.back()
		case "tab":
			if m.base.detail || m.base.previewFocus {
				m.back()
			} else {
				m.inspect()
			}
		case "up", "k":
			if m.base.detail || m.base.previewFocus {
				m.scroll(-1)
			} else {
				m.move(-1)
			}
		case "down", "j":
			if m.base.detail || m.base.previewFocus {
				m.scroll(1)
			} else {
				m.move(1)
			}
		case "pgdown", "ctrl+d":
			c := m.screen()
			if m.base.detail || m.base.previewFocus {
				m.scroll(max(1, c.reader.h-1))
			} else {
				m.move(max(1, c.listPage))
			}
		case "pgup", "ctrl+u":
			c := m.screen()
			if m.base.detail || m.base.previewFocus {
				m.scroll(-max(1, c.reader.h-1))
			} else {
				m.move(-max(1, c.listPage))
			}
		case "home", "g":
			if m.base.detail || m.base.previewFocus {
				m.base.previewOffset = 0
			} else {
				m.base.selected = 0
				m.reconcile()
			}
		case "end", "G":
			if m.base.detail || m.base.previewFocus {
				m.scroll(1 << 30)
			} else {
				m.base.selected = len(m.items()) - 1
				m.reconcile()
			}
		case "r":
			return m, m.perform("read", 0)
		case "d":
			return m, m.perform("dismiss", 0)
		case "o":
			return m, m.perform("open", 0)
		case "y":
			return m, m.perform("copy", 0)
		case "s":
			return m, m.perform("dismissed", 0)
		case "R":
			return m, m.perform("refresh", 0)
		}
	case tea.MouseClickMsg:
		if m.quitRequested {
			return m, nil
		}
		if msg.Button != tea.MouseLeft {
			return m, nil
		}
		c := m.screen()
		for n := len(c.targets) - 1; n >= 0; n-- {
			target := c.targets[n]
			if (rect{target.x, target.y, target.width, target.height}).contains(msg.X, msg.Y) {
				return m, m.perform(target.action, target.index)
			}
		}
		if m.picker {
			m.picker = false
		}
		if m.help {
			m.help = false
		}
	case tea.MouseWheelMsg:
		delta := 3
		if msg.Button == tea.MouseWheelUp {
			delta = -3
		} else if msg.Button != tea.MouseWheelDown {
			return m, nil
		}
		if m.help {
			m.scrollHelp(delta)
			return m, nil
		}
		if m.picker {
			return m, nil
		}
		c := m.screen()
		if c.reader.contains(msg.X, msg.Y) {
			m.scroll(delta)
		} else {
			m.move(delta / 3)
		}
	}
	return m, nil
}
