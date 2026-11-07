package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestLayoutPreferenceDefaultsAndSurvivesItemMutations(t *testing.T) {
	h, _ := backendHub(t)
	if got, err := h.Layout(); err != nil || got != "navigator" {
		t.Fatalf("default layout = %q, %v", got, err)
	}
	if err := h.SetLayout("dispatch"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Publish(Item{Source: "daily", ID: "keep", Title: "Keep"}); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"read", "dismiss"} {
		if err := h.SetState("daily", "keep", action); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.Publish(Item{Source: "daily", ID: "remove", Title: "Remove"}); err != nil {
		t.Fatal(err)
	}
	if err := h.Remove("daily", "remove"); err != nil {
		t.Fatal(err)
	}
	reopened := &Hub{StatePath: h.StatePath}
	if got, err := reopened.Layout(); err != nil || got != "dispatch" {
		t.Fatalf("layout lost after item writes/reopen: %q %v", got, err)
	}
	if err := reopened.SetLayout("ledger"); err != nil {
		t.Fatal(err)
	}
	item, err := reopened.find("daily", "keep")
	if err != nil || !item.Read || !item.Dismissed {
		t.Fatalf("preference write lost personal state: %+v %v", item, err)
	}
}

func TestInvalidLayoutDoesNotChangeStateAndSavedErrorsCanBeRepaired(t *testing.T) {
	h, _ := backendHub(t)
	if _, err := h.Publish(Item{Source: "daily", ID: "keep", Title: "Keep"}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(h.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.SetLayout("unknown"); err == nil {
		t.Fatal("invalid preference accepted")
	}
	after, _ := os.ReadFile(h.StatePath)
	if !bytes.Equal(before, after) {
		t.Fatal("invalid layout changed hub state")
	}
	state, err := h.load()
	if err != nil {
		t.Fatal(err)
	}
	state.Layout = "removed-layout"
	if err = h.save(state); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Layout(); err == nil || !strings.Contains(err.Error(), "layout navigator") {
		t.Fatalf("missing repair guidance: %v", err)
	}
	var out, errOut bytes.Buffer
	if err = runCLI(h, []string{"layout", "navigator"}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if item, err := h.find("daily", "keep"); err != nil || item.Title != "Keep" {
		t.Fatalf("repair lost content: %+v %v", item, err)
	}
}

func TestLayoutCLIReportsJSONAndParsesLaunchFlags(t *testing.T) {
	h, _ := backendHub(t)
	for _, args := range [][]string{{"layout"}, {"layout", "stream", "--json"}} {
		var out, errOut bytes.Buffer
		if err := runCLI(h, args, strings.NewReader(""), &out, &errOut); err != nil {
			t.Fatal(err)
		}
		var result struct {
			Layout    string   `json:"layout"`
			Available []string `json:"available"`
		}
		if err := json.Unmarshal(out.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		want := "navigator"
		if len(args) > 1 {
			want = "stream"
		}
		if result.Layout != want || !slices.Equal(result.Available, layoutSlugs) {
			t.Fatalf("bad layout result: %+v", result)
		}
	}
	for _, args := range [][]string{
		{"--layout=ledger", "--backend", "herdr", "--help"},
		{"--backend=tmux", "--layout", "dispatch", "--help"},
		{"publish", "--help"},
	} {
		var out, errOut bytes.Buffer
		if err := runCLI(h, args, strings.NewReader(""), &out, &errOut); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if !strings.Contains(out.String(), "--layout") {
			t.Fatalf("missing help: %q", out.String())
		}
	}
	for _, args := range [][]string{
		{"--layout"}, {"--layout="}, {"--layout=unknown", "--help"},
		{"--layout", "ledger", "list"}, {"layout", "unknown"}, {"layout", "navigator", "extra"},
	} {
		var out, errOut bytes.Buffer
		if err := runCLI(h, args, strings.NewReader(""), &out, &errOut); err == nil {
			t.Fatalf("invalid command accepted: %v", args)
		}
	}
	if got, err := h.Layout(); err != nil || got != "stream" {
		t.Fatalf("launch flags changed saved layout: %q %v", got, err)
	}
}

// Run a real CLI entry point in separate processes to exercise the same store
// contention that happens when agents publish while the TUI saves preferences.
func TestHubCLIProcess(t *testing.T) {
	if os.Getenv("REVIEW_INBOX_CLI_PROCESS") != "1" {
		return
	}
	for index, arg := range os.Args {
		if arg == "--" {
			os.Exit(RunCLI(os.Args[index+1:]))
		}
	}
	os.Exit(2)
}

func TestConcurrentCLIUpdatesPreserveContentStateAndLayout(t *testing.T) {
	h, _ := backendHub(t)
	if _, err := h.Publish(Item{Source: "daily", ID: "anchor", Title: "Anchor"}); err != nil {
		t.Fatal(err)
	}
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	commands := [][]string{{"layout", "dispatch"}, {"read", "daily", "anchor"}, {"dismiss", "daily", "anchor"}}
	for index := 0; index < 12; index++ {
		commands = append(commands, []string{"publish"})
	}
	var group sync.WaitGroup
	errors := make(chan error, len(commands))
	start := make(chan struct{})
	for index, args := range commands {
		group.Add(1)
		go func(index int, args []string) {
			defer group.Done()
			<-start
			command := exec.Command(bin, append([]string{"-test.run=^TestHubCLIProcess$", "--"}, args...)...)
			command.Env = append(os.Environ(), "REVIEW_INBOX_CLI_PROCESS=1", "REVIEW_INBOX_STATE_FILE="+h.StatePath)
			if args[0] == "publish" {
				command.Stdin = strings.NewReader(fmt.Sprintf(`{"source":"daily","id":"item-%d","title":"Item %d"}`, index, index))
			}
			if output, err := command.CombinedOutput(); err != nil {
				errors <- fmt.Errorf("%v: %w: %s", args, err, output)
			}
		}(index, args)
	}
	close(start)
	group.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	state, err := h.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Items) != 13 || state.Layout != "dispatch" {
		t.Fatalf("concurrent commands lost data: items=%d layout=%q", len(state.Items), state.Layout)
	}
	anchor, err := h.find("daily", "anchor")
	if err != nil || !anchor.Read || !anchor.Dismissed {
		t.Fatalf("concurrent read/dismiss lost a choice: %+v %v", anchor, err)
	}
}

func TestSourceFailuresRetainLastGoodSnapshotUntilSuccessfulRemoval(t *testing.T) {
	h, local := backendHub(t)
	localJSON := `[{"worktree":"/work/repo","base":"main","branch":"change","summary":"Local change"}]`
	prJSON := `{"repo":"team/repo","number":7,"title":"PR change","url":"https://example.com/pr/7"}`
	if err := os.WriteFile(local, []byte(localJSON), 0600); err != nil {
		t.Fatal(err)
	}
	feed := os.Getenv("COWORKER_PRS_FILE")
	if err := os.WriteFile(feed, []byte(prJSON), 0600); err != nil {
		t.Fatal(err)
	}
	if items, warnings, err := h.Items(); err != nil || len(items) != 2 || len(warnings) != 0 {
		t.Fatalf("initial source snapshot: %+v %v %v", items, warnings, err)
	}
	if err := os.WriteFile(local, []byte("invalid JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(feed, []byte("invalid JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	items, warnings, err := h.Items()
	if err != nil || len(items) != 2 || len(warnings) != 2 {
		t.Fatalf("lost retained sources: %+v %v %v", items, warnings, err)
	}
	for _, warning := range warnings {
		if !strings.Contains(warning, "last successful snapshot") {
			t.Fatalf("retention is not visible: %q", warning)
		}
	}
	if err := os.WriteFile(local, []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(feed); err != nil {
		t.Fatal(err)
	}
	if items, warnings, err = h.Items(); err != nil || len(items) != 0 || len(warnings) != 0 {
		t.Fatalf("successful source removal retained old rows: %+v %v %v", items, warnings, err)
	}
}
