package main

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type recordingHub struct {
	items                         []Item
	warnings                      []string
	loadErr, actionErr, errorSave error
	opened, copied                []Item
	saved                         []string
}

func (h *recordingHub) Items() ([]Item, []string, error) {
	return append([]Item(nil), h.items...), h.warnings, h.loadErr
}
func (h *recordingHub) SetState(source, id, action string) error {
	if h.actionErr != nil {
		return h.actionErr
	}
	for i := range h.items {
		if h.items[i].Source == source && h.items[i].ID == id {
			switch action {
			case "read":
				h.items[i].Read = true
			case "unread":
				h.items[i].Read = false
			case "dismiss":
				h.items[i].Dismissed = true
			case "restore":
				h.items[i].Dismissed = false
			}
		}
	}
	return nil
}
func (h *recordingHub) Open(item Item) error { h.opened = append(h.opened, item); return h.actionErr }
func (h *recordingHub) Copy(item Item) error { h.copied = append(h.copied, item); return h.actionErr }
func (h *recordingHub) SetLayout(name string) error {
	h.saved = append(h.saved, name)
	return h.errorSave
}
func fixtureApp(t *testing.T, layout string, width, height int) (*appModel, *recordingHub) {
	t.Helper()
	h := &recordingHub{items: []Item{
		{Source: "local-review", ID: "one", Kind: "review", Title: "Review navigation", Body: strings.Repeat("A useful paragraph for reader scrolling.\n", 80), Labels: []string{"agent:ready"}, Worktree: "/example", Base: "base", Head: "head"},
		{Source: "github-pr", ID: "two", Kind: "review", Title: "Team review", Body: "## Changes\n\nReview this.", Labels: []string{"risk:high"}, URL: "https://example.com/pull/2"},
		{Source: "daily", ID: "three", Kind: "brief", Title: "Daily brief", Body: "# Research\n\nLonger context."},
	}}
	m := newAppModel(h, layout)
	m.base.width = width
	m.base.height = height
	finishApp(t, m, m.requestLoad(""))
	return m, h
}
func finishApp(t *testing.T, m *appModel, cmd tea.Cmd) tea.Cmd {
	t.Helper()
	if cmd == nil {
		t.Fatal("expected asynchronous operation")
	}
	_, next := m.Update(cmd())
	return next
}
func clickApp(t *testing.T, m *appModel, action string, index int) tea.Cmd {
	t.Helper()
	c := m.screen()
	for i := len(c.targets) - 1; i >= 0; i-- {
		target := c.targets[i]
		if target.action == action && (action != "select" || target.index == index) {
			_, cmd := m.Update(tea.MouseClickMsg{X: target.x + target.width/2, Y: target.y + target.height/2, Button: tea.MouseLeft})
			return cmd
		}
	}
	t.Fatalf("missing control %s at%dx%d", action, m.base.width, m.base.height)
	return nil
}
func TestAllLayoutsUseRealStateAndActions(t *testing.T) {
	for _, name := range layoutSlugs {
		t.Run(name, func(t *testing.T) {
			m, h := fixtureApp(t, name, 120, 38)
			finishApp(t, m, clickApp(t, m, "read", 0))
			item, _ := m.current()
			if !item.Read || !h.items[0].Read {
				t.Fatal("read did not reach underlying hub")
			}
			finishApp(t, m, clickApp(t, m, "dismiss", 0))
			if !h.items[0].Dismissed {
				t.Fatal("dismiss did not persist")
			}
			clickApp(t, m, "dismissed", 0)
			finishApp(t, m, clickApp(t, m, "dismiss", 0))
			if h.items[0].Dismissed {
				t.Fatal("restore did not reach hub")
			}
			clickApp(t, m, "dismissed", 0)
			m.base.selected = 1
			m.reconcile()
			finishApp(t, m, clickApp(t, m, "open", 0))
			finishApp(t, m, clickApp(t, m, "copy", 0))
			if len(h.opened) != 1 || h.opened[0].ID != "two" || len(h.copied) != 1 {
				t.Fatal("real open/copy was not dispatched")
			}
		})
	}
}
func TestProductionReadDismissSurviveRestart(t *testing.T) {
	h, _ := backendHub(t)
	_, err := h.Publish(Item{Source: "daily", ID: "one", Title: "A real stored item"})
	if err != nil {
		t.Fatal(err)
	}
	m := newAppModel(h, "navigator")
	finishApp(t, m, m.requestLoad(""))
	finishApp(t, m, m.perform("read", 0))
	finishApp(t, m, m.perform("dismiss", 0))
	item, err := NewHubForState(h).find("daily", "one")
	if err != nil || !item.Read || !item.Dismissed {
		t.Fatalf("state was temporary: %+v %v", item, err)
	}
}
func NewHubForState(h *Hub) *Hub {
	return &Hub{StatePath: h.StatePath, Backend: h.Backend, Launcher: h.Launcher}
}
func TestLayoutSwitchPreservesSearchSelectionAndReading(t *testing.T) {
	m, h := fixtureApp(t, "navigator", 120, 38)
	m.base.query = "navigation"
	m.reconcile()
	m.inspect()
	m.scroll(5)
	for index := range layoutSlugs {
		finishApp(t, m, m.switchLayout(index))
		item, _ := m.current()
		if item.ID != "one" || m.base.query != "navigation" || !m.base.previewFocus || m.base.previewOffset != 5 {
			t.Fatalf("layout change lost context: %+v", m.base)
		}
	}
	if h.saved[len(h.saved)-1] != "overview" {
		t.Fatal("layout not remembered")
	}
	_, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	if m.base.previewFocus || m.base.detail {
		t.Fatal("Tab failed to return to queue")
	}
}
func TestFastLayoutChangesRememberLatestChoice(t *testing.T) {
	m, h := fixtureApp(t, "navigator", 120, 38)
	first := m.switchLayout(0)
	if cmd := m.switchLayout(1); cmd != nil {
		t.Fatal("parallel preference writes were scheduled")
	}
	second := finishApp(t, m, first)
	finishApp(t, m, second)
	if strings.Join(h.saved, ",") != "ledger,dispatch" {
		t.Fatalf("saved stale layout: %v", h.saved)
	}
}
func TestBackgroundRefreshCannotUndoACompletedAction(t *testing.T) {
	m, _ := fixtureApp(t, "navigator", 120, 38)
	pending := m.requestLoad("")
	old := pending()
	finishApp(t, m, m.perform("read", 0))
	m.Update(old)
	item, _ := m.current()
	if !item.Read {
		t.Fatal("late refresh undid read state")
	}
}
func TestRefreshPreservesIdentityAndScrollAndShowsNewContent(t *testing.T) {
	m, h := fixtureApp(t, "navigator", 120, 38)
	m.inspect()
	m.scroll(5)
	h.items = append([]Item{{Source: "new", ID: "new", Kind: "review", Title: "New"}}, h.items...)
	finishApp(t, m, m.requestLoad(""))
	item, _ := m.current()
	if item.ID != "one" || m.base.selected != 1 || m.base.previewOffset != 5 {
		t.Fatal("refresh lost reading position")
	}
	h.items[1].Body = "New content"
	finishApp(t, m, m.requestLoad(""))
	if m.base.previewOffset != 0 {
		t.Fatal("changed content should begin at the top")
	}
}
func TestSourceFilterIsExactAndIndependentOfSearch(t *testing.T) {
	m, _ := fixtureApp(t, "navigator", 120, 38)
	m.base.items[1].Body = "mentions local-review"
	m.perform("source:local-review", 0)
	if len(m.items()) != 1 || m.items()[0].Source != "local-review" || m.base.query != "" {
		t.Fatal("source click became a free-text query")
	}
	m.base.query = "AGENT:READY"
	if len(m.items()) != 1 {
		t.Fatal("labels not searchable")
	}
	m.perform("clear", 0)
	if len(m.items()) != 3 {
		t.Fatal("clear did not remove both filters")
	}
}
func TestActionErrorsRemainVisibleAndLocalOpenQuitsOnlyOnSuccess(t *testing.T) {
	m, h := fixtureApp(t, "navigator", 120, 38)
	h.actionErr = errors.New("Cannot open\nsecond diagnostic line")
	if next := finishApp(t, m, m.perform("open", 0)); next != nil {
		t.Fatal("failed local open quit the app")
	}
	if !m.base.failed {
		t.Fatal("action error not displayed")
	}
	finishApp(t, m, m.requestLoad(""))
	if !m.base.failed {
		t.Fatal("background refresh erased action error")
	}
	h.actionErr = nil
	if next := finishApp(t, m, m.perform("open", 0)); next == nil {
		t.Fatal("successful local open should release the popup")
	}
}
func TestPhoneMouseReaderBackAndResize(t *testing.T) {
	for _, name := range layoutSlugs {
		t.Run(name, func(t *testing.T) {
			m, _ := fixtureApp(t, name, 44, 32)
			clickApp(t, m, "select", 0)
			if !m.base.detail {
				t.Fatal("tap did not open phone reader")
			}
			clickApp(t, m, "scroll-down", 0)
			if m.base.previewOffset == 0 {
				t.Fatal("touch scroll failed")
			}
			m.Update(tea.WindowSizeMsg{Width: 120, Height: 38})
			item, _ := m.current()
			if item.ID != "one" || !m.base.previewFocus {
				t.Fatal("resize lost reader focus")
			}
			clickApp(t, m, "back", 0)
			if m.base.detail || m.base.previewFocus {
				t.Fatal("Back failed")
			}
		})
	}
}
func TestLabelsVisibleBeforeSelectionAndFullInReader(t *testing.T) {
	for _, name := range layoutSlugs {
		m, _ := fixtureApp(t, name, 120, 38)
		text := ansi.Strip(m.View().Content)
		if !strings.Contains(text, "[agent:ready]") || !strings.Contains(text, "[risk:high]") {
			t.Fatalf("%s hides unselected labels", name)
		}
		lines := m.previewLines(24)
		text = ""
		for _, line := range lines {
			text += line.text + "\n"
			if ansi.StringWidth(line.text) > 24 {
				t.Fatal("reader exceeds width")
			}
		}
		if !strings.Contains(text, "agent:ready") {
			t.Fatal("reader lost full labels")
		}
	}
}
func TestFramesFitUnicodeAndTinyTerminals(t *testing.T) {
	for _, name := range layoutSlugs {
		for _, size := range [][2]int{{5, 3}, {28, 14}, {44, 18}, {80, 24}, {120, 38}} {
			m, _ := fixtureApp(t, name, size[0], size[1])
			m.base.items[0].Title = strings.Repeat("界🙂long", 30)
			m.base.items[0].Body = "\x1b[2J\x1b[999B" + strings.Repeat("界🙂long", 50)
			for _, detail := range []bool{false, true} {
				m.base.detail = detail
				view := m.View()
				rows := strings.Split(view.Content, "\n")
				if len(rows) != size[1] {
					t.Fatalf("%s %v:height%d", name, size, len(rows))
				}
				for _, row := range rows {
					if ansi.StringWidth(row) > size[0] {
						t.Fatalf("%s %v:row overflows", name, size)
					}
				}
				if strings.Contains(view.Content, "\x1b[2J") || strings.Contains(view.Content, "\x1b[999B") {
					t.Fatal("source terminal control injection")
				}
			}
		}
	}
}
func TestPickerAndSourceStatusRemainAvailableByMouse(t *testing.T) {
	m, h := fixtureApp(t, "navigator", 44, 32)
	clickApp(t, m, "layout-picker", 0)
	if !m.picker {
		t.Fatal("layout name did not open chooser")
	}
	cmd := clickApp(t, m, "layout:0", 0)
	finishApp(t, m, cmd)
	if m.layout != 0 || m.picker {
		t.Fatal("chooser did not select and close")
	}
	h.warnings = []string{"Local source unavailable: retained last snapshot", "PR source unavailable"}
	finishApp(t, m, m.requestLoad(""))
	clickApp(t, m, "help", 0)
	if !m.help || !strings.Contains(ansi.Strip(m.View().Content), "Help / source status") {
		t.Fatal("full source status unavailable")
	}
}

func TestEmptyNavigatorDoesNotOverwriteNavigationRail(t *testing.T) {
	m, _ := fixtureApp(t, "navigator", 120, 38)
	m.base.items = nil
	rows := strings.Split(ansi.Strip(m.View().Content), "\n")
	if !strings.Contains(rows[10], "Briefs") || strings.Contains(rows[10][:19], "Publish") {
		t.Fatalf("onboarding overwrote source navigation: %q", rows[10])
	}
}

func TestHelpOverscrollReturnsImmediatelyAndSupportsTouch(t *testing.T) {
	m, _ := fixtureApp(t, "navigator", 44, 32)
	m.perform("help", 0)
	for i := 0; i < 20; i++ {
		m.Update(tea.KeyPressMsg{Code: tea.KeyPgDown})
	}
	bottom := m.helpScroll
	if bottom == 0 {
		t.Fatal("fixture should require help scrolling")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	if m.helpScroll != bottom-1 {
		t.Fatalf("overscroll swallowed first Up: %d -> %d", bottom, m.helpScroll)
	}
	clickApp(t, m, "help-up", 0)
	if m.helpScroll >= bottom-1 {
		t.Fatal("touch Up failed")
	}
}

func TestSmallHeaderCaretOpensLayoutPicker(t *testing.T) {
	m, _ := fixtureApp(t, "navigator", 28, 18)
	row := []rune(ansi.Strip(strings.Split(m.View().Content, "\n")[0]))
	x := -1
	for index, char := range row {
		if char == '▾' {
			x = index
		}
	}
	if x < 0 {
		t.Fatal("layout caret is not visible")
	}
	m.Update(tea.MouseClickMsg{X: x, Y: 0, Button: tea.MouseLeft})
	if !m.picker || m.help {
		t.Fatal("layout caret touch was intercepted by Help")
	}
}

func TestTypedAndPastedSearchKeepSpacesAndNavigationKeys(t *testing.T) {
	m, _ := fixtureApp(t, "navigator", 44, 32)
	m.perform("search", 0)
	for _, char := range "Team review" {
		m.Update(tea.KeyPressMsg{Code: char, Text: string(char)})
	}
	if m.base.query != "Team review" || len(m.items()) != 1 || m.items()[0].ID != "two" {
		t.Fatal("typed multiword search failed")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.base.searching {
		t.Fatal("Enter did not finish input")
	}
	m.perform("clear", 0)
	m.perform("search", 0)
	m.Update(tea.PasteMsg{Content: "AGENT:READY"})
	if len(m.items()) != 1 || m.items()[0].ID != "one" {
		t.Fatal("pasted label search failed")
	}
}

func TestQuitFinishesPendingStateAndLatestLayoutWrites(t *testing.T) {
	m, h := fixtureApp(t, "navigator", 120, 38)
	pendingRead := m.perform("read", 0)
	pendingLayout := m.switchLayout(0)
	m.switchLayout(1)
	_, quit := m.Update(tea.KeyPressMsg{Code: 'q', Text: "q"})
	if quit != nil {
		t.Fatal("quit discarded pending writes")
	}
	if next := finishApp(t, m, pendingRead); next != nil {
		t.Fatal("quit skipped pending layout write")
	}
	nextLayout := finishApp(t, m, pendingLayout)
	quit = finishApp(t, m, nextLayout)
	if quit == nil || strings.Join(h.saved, ",") != "ledger,dispatch" || !h.items[0].Read {
		t.Fatal("graceful quit lost state or layout")
	}
}
