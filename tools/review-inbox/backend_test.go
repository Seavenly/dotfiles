package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func backendHub(t *testing.T) (*Hub, string) {
	t.Helper()
	dir := t.TempDir()
	local := filepath.Join(dir, "local.json")
	if err := os.WriteFile(local, []byte("[]\n"), 0600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "tuicr-reviews"), []byte("#!/bin/sh\n/bin/cat \"$REVIEW_INBOX_TEST_LOCAL_FILE\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("REVIEW_INBOX_TEST_LOCAL_FILE", local)
	t.Setenv("COWORKER_PRS_FILE", filepath.Join(dir, "prs.jsonl"))
	return &Hub{StatePath: filepath.Join(dir, "state.json"), Backend: "auto"}, local
}

func TestPublishStateAndContentUpdates(t *testing.T) {
	h, _ := backendHub(t)
	item := Item{Source: "daily", ID: "today", Title: "Daily brief", Body: "Original", UpdatedAt: "2026-11-05T12:00:00Z"}
	first, err := h.Publish(item)
	if err != nil {
		t.Fatal(err)
	}
	if first.Kind != "brief" || first.Read || first.Dismissed {
		t.Fatalf("unexpected first item: %+v", first)
	}
	if err = h.SetState(item.Source, item.ID, "read"); err != nil {
		t.Fatal(err)
	}
	item.UpdatedAt = "2026-11-05T13:00:00Z"
	updated, err := h.Publish(item)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Read {
		t.Fatal("timestamp-only refresh reset read state")
	}
	if err = h.SetState(item.Source, item.ID, "dismiss"); err != nil {
		t.Fatal(err)
	}
	item.Body = "Changed content"
	updated, err = h.Publish(item)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Read || !updated.Dismissed {
		t.Fatalf("changed item should be unread and dismissed: %+v", updated)
	}
	if err = h.SetState(item.Source, item.ID, "restore"); err != nil {
		t.Fatal(err)
	}
	reopened := &Hub{StatePath: h.StatePath, Backend: "auto"}
	items, _, err := reopened.Items()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Read || items[0].Dismissed || items[0].Body != "Changed content" {
		t.Fatalf("bad persisted items: %+v", items)
	}
}

func TestPublishedLabelsRoundTripAndContentChanges(t *testing.T) {
	h, _ := backendHub(t)
	var stdout, stderr bytes.Buffer
	input := `{"source":"agent","id":"change","kind":"review","title":"Review change","labels":["risk:low"," agent:reviewed ","risk:low",""]}`
	if err := runCLI(h, []string{"publish"}, strings.NewReader(input), &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	var item Item
	if err := json.Unmarshal(stdout.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(item.Labels, []string{"agent:reviewed", "risk:low"}) {
		t.Fatalf("labels were not preserved and normalized: %v", item.Labels)
	}
	if err := h.SetState(item.Source, item.ID, "read"); err != nil {
		t.Fatal(err)
	}
	item.Labels = []string{"risk:low", "agent:reviewed", "agent:reviewed"}
	item, err := h.Publish(item)
	if err != nil || !item.Read {
		t.Fatalf("label reordering changed read state: %+v %v", item, err)
	}
	if err = h.SetState(item.Source, item.ID, "dismiss"); err != nil {
		t.Fatal(err)
	}
	item.Labels = []string{"agent:reviewed", "risk:high"}
	item, err = h.Publish(item)
	if err != nil || item.Read || !item.Dismissed {
		t.Fatalf("label change should mark unread and retain dismissal: %+v %v", item, err)
	}
	reopened := &Hub{StatePath: h.StatePath}
	item, err = reopened.find("agent", "change")
	if err != nil || !slices.Equal(item.Labels, []string{"agent:reviewed", "risk:high"}) {
		t.Fatalf("persisted labels missing: %+v %v", item, err)
	}
}

func TestReviewSourcesCarryLabelsAndIgnoreTheirOrder(t *testing.T) {
	h, local := backendHub(t)
	localJSON := `[{"worktree":"/work/project","repo":"/work/project","base":"main","branch":"agent/fix","summary":"Agent change","labels":["size:small","agent:reviewed"]}]`
	if err := os.WriteFile(local, []byte(localJSON), 0600); err != nil {
		t.Fatal(err)
	}
	localItem, err := h.find("local-review", "/work/project|main|agent/fix")
	if err != nil || !slices.Equal(localItem.Labels, []string{"agent:reviewed", "size:small"}) {
		t.Fatalf("local review labels missing: %+v %v", localItem, err)
	}
	feed := os.Getenv("COWORKER_PRS_FILE")
	writePR := func(labels string) {
		t.Helper()
		data := `{"repo":"team/project","number":42,"title":"Change","url":"https://example.com/pr/42"` + labels + "}\n"
		if err := os.WriteFile(feed, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	writePR(`,"labels":["risk:low","agent:approved"]`)
	if err := h.SetState("github-pr", "team/project#42", "read"); err != nil {
		t.Fatal(err)
	}
	writePR(`,"labels":["agent:approved","risk:low","risk:low"]`)
	item, err := h.find("github-pr", "team/project#42")
	if err != nil || !item.Read || !slices.Equal(item.Labels, []string{"agent:approved", "risk:low"}) {
		t.Fatalf("source reordering changed state: %+v %v", item, err)
	}
	writePR(`,"labels":["risk:high"]`)
	item, err = h.find("github-pr", "team/project#42")
	if err != nil || item.Read || !slices.Equal(item.Labels, []string{"risk:high"}) {
		t.Fatalf("new classification should be unread: %+v %v", item, err)
	}
	writePR("")
	item, err = h.find("github-pr", "team/project#42")
	if err != nil || len(item.Labels) != 0 {
		t.Fatalf("legacy label-free feed rejected: %+v %v", item, err)
	}
}

func TestSourceSnapshotsAndImmutableReviewRange(t *testing.T) {
	h, local := backendHub(t)
	localJSON := `[{"worktree":"/work/project","repo":"/work/project","base":"main","branch":"agent/fix","base_sha":"aaa","head_sha":"bbb","manifest":"/work/review.json","summary":"Fix bug","slug":"review-token","lifecycle":"review_ready","health":"current","kind":"manifest"}]`
	if err := os.WriteFile(local, []byte(localJSON), 0600); err != nil {
		t.Fatal(err)
	}
	prs := os.Getenv("COWORKER_PRS_FILE")
	prJSON := `{"repo":"team/project","number":42,"title":"Improve it","url":"https://example.com/pr/42","kind":"review"}` + "\n"
	if err := os.WriteFile(prs, []byte(prJSON), 0600); err != nil {
		t.Fatal(err)
	}
	items, warnings, err := h.Items()
	if err != nil || len(warnings) != 0 || len(items) != 2 {
		t.Fatalf("items=%+v warnings=%v err=%v", items, warnings, err)
	}
	localItem, err := h.find("local-review", "/work/review.json")
	if err != nil {
		t.Fatal(err)
	}
	if localItem.Base != "aaa" || localItem.Head != "bbb" || localItem.Token != "review-token" {
		t.Fatalf("lost immutable review facts: %+v", localItem)
	}
	if err = h.SetState("github-pr", "team/project#42", "read"); err != nil {
		t.Fatal(err)
	}
	if err = h.SetState("github-pr", "team/project#42", "dismiss"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(prs, []byte(strings.ReplaceAll(prJSON, "Improve it", "Improve it further")), 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := h.find("github-pr", "team/project#42")
	if err != nil {
		t.Fatal(err)
	}
	if changed.Read || !changed.Dismissed {
		t.Fatalf("PR update state incorrect: %+v", changed)
	}
	if err = os.Remove(prs); err != nil {
		t.Fatal(err)
	}
	items, _, err = h.Items()
	if err != nil || len(items) != 1 {
		t.Fatalf("closed PR should disappear: %+v %v", items, err)
	}
	data, err := os.ReadFile(local)
	if err != nil || string(data) != localJSON {
		t.Fatal("hub modified source review data")
	}
	if err = h.Remove("local-review", localItem.ID); err == nil {
		t.Fatal("source-owned review deletion should be rejected")
	}
}

func TestCLIJSONAndDismissal(t *testing.T) {
	h, _ := backendHub(t)
	run := func(args []string, input string) string {
		t.Helper()
		var stdout, stderr bytes.Buffer
		if err := runCLI(h, args, strings.NewReader(input), &stdout, &stderr); err != nil {
			t.Fatalf("%v: %v (%s)", args, err, stderr.String())
		}
		if !json.Valid(stdout.Bytes()) {
			t.Fatalf("%v did not emit JSON: %s", args, stdout.String())
		}
		return stdout.String()
	}
	run([]string{"publish"}, `{"source":"research","id":"today","title":"Industry","body":"# Research"}`)
	run([]string{"read", "research", "today", "--json"}, "")
	run([]string{"dismiss", "research", "today"}, "")
	var items []Item
	if err := json.Unmarshal([]byte(run([]string{"list", "--json"}, "")), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatal("default list included dismissed items")
	}
	if err := json.Unmarshal([]byte(run([]string{"list", "--all", "--kind", "brief", "--source", "research"}, "")), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || !items[0].Read || !items[0].Dismissed {
		t.Fatalf("unexpected list: %+v", items)
	}
	run([]string{"restore", "research", "today"}, "")
	run([]string{"show", "research", "today"}, "")
	run([]string{"remove", "research", "today"}, "")
	if _, err := h.find("research", "today"); err == nil {
		t.Fatal("removed item remains")
	}
}

func TestInvalidPublishDoesNotOverwriteState(t *testing.T) {
	h, _ := backendHub(t)
	if _, err := h.Publish(Item{Source: "daily", ID: "one", Title: "Keep"}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(h.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{
		`{"source":"daily","id":"two"}`,
		`{"source":"local-review","id":"two","title":"Impersonate"}`,
		`{"source":"daily","id":"two","title":"Bad","command":"execute me"}`,
		`{"source":"daily","id":"two","title":"First"} {"title":"Second"}`,
	} {
		var stdout, stderr bytes.Buffer
		if err = runCLI(h, []string{"publish"}, strings.NewReader(input), &stdout, &stderr); err == nil {
			t.Fatalf("accepted invalid publish: %s", input)
		}
		after, err := os.ReadFile(h.StatePath)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(before, after) {
			t.Fatalf("invalid publish changed state: %s", input)
		}
	}
}

func TestSourceErrorDoesNotHidePublishedBriefs(t *testing.T) {
	h, local := backendHub(t)
	if _, err := h.Publish(Item{Source: "daily", ID: "one", Title: "Keep"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, []byte("invalid JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	items, warnings, err := h.Items()
	if err != nil || len(items) != 1 || len(warnings) != 1 {
		t.Fatalf("items=%+v warnings=%v err=%v", items, warnings, err)
	}
	if err = h.SetState("daily", "one", "read"); err != nil {
		t.Fatalf("unrelated source failure blocked brief state: %v", err)
	}
}

func TestNewHubUsesHostLocalEnvironment(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/tmp/hub-test-state")
	t.Setenv("REVIEW_INBOX_STATE_FILE", "")
	t.Setenv("REVIEW_INBOX_BACKEND", "herdr")
	t.Setenv("REVIEW_INBOX_LAUNCHER", "/custom/review-inbox")
	h := NewHub()
	if h.StatePath != "/tmp/hub-test-state/dotfiles/review-inbox.json" || h.Backend != "herdr" || h.Launcher != "/custom/review-inbox" {
		t.Fatalf("unexpected config: %+v", h)
	}
	t.Setenv("REVIEW_INBOX_STATE_FILE", "/tmp/custom-hub.json")
	if NewHub().StatePath != "/tmp/custom-hub.json" {
		t.Fatal("state override ignored")
	}
}
