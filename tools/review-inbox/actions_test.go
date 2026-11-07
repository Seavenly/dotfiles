package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestActionsPassArgumentsWithoutShellInterpretation(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "arguments")
	t.Setenv("HUB_ACTION_LOG", log)
	launcher := filepath.Join(dir, "launcher")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HUB_ACTION_LOG\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	h := &Hub{Launcher: launcher, Backend: "herdr"}
	item := Item{Worktree: dir, Base: "base-sha", Head: "head-sha", Branch: "branch $(touch unwanted); 'quoted'", Token: "token with spaces"}
	if err := h.Open(item); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(log)
	want := strings.Join([]string{"--backend", "herdr", "--open-local", dir, item.Base, item.Head, item.Branch, ""}, "\n")
	if string(got) != want {
		t.Fatalf("arguments = %q; want %q", got, want)
	}
	if err := h.Copy(item); err != nil {
		t.Fatal(err)
	}
	got, _ = os.ReadFile(log)
	if string(got) != "--backend\nherdr\n--copy-token\ntoken with spaces\n" {
		t.Fatalf("copy arguments = %q", got)
	}
}

func TestOpenDoesNotWaitForInheritedBrowserOutput(t *testing.T) {
	dir := t.TempDir()
	launcher := filepath.Join(dir, "launcher")
	pidFile := filepath.Join(dir, "child-pid")
	t.Setenv("BROWSER_CHILD_PID_FILE", pidFile)
	script := "#!/bin/sh\nsleep 3 &\nprintf '%s' \"$!\" > \"$BROWSER_CHILD_PID_FILE\"\nexit 0\n"
	if err := os.WriteFile(launcher, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		data, err := os.ReadFile(pidFile)
		if err != nil {
			return
		}
		pid, _ := strconv.Atoi(string(data))
		if pid > 0 {
			process, _ := os.FindProcess(pid)
			if process != nil {
				_ = process.Kill()
			}
		}
	})
	h := &Hub{Launcher: launcher}
	start := time.Now()
	if err := h.Open(Item{URL: "https://example.com"}); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Open waited for child output: %s", elapsed)
	}
}

func TestActionErrorIncludesBoundedDiagnostics(t *testing.T) {
	dir := t.TempDir()
	launcher := filepath.Join(dir, "launcher")
	script := "#!/bin/sh\nprintf 'clipboard unavailable\\n' >&2\nexit 1\n"
	if err := os.WriteFile(launcher, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	h := &Hub{Launcher: launcher}
	err := h.Copy(Item{Token: "one"})
	if err == nil || !strings.Contains(err.Error(), "clipboard unavailable") {
		t.Fatalf("missing diagnostics: %v", err)
	}
}

func TestOpenRejectsUnavailableWorktreesAndNonWebURLs(t *testing.T) {
	h := &Hub{Launcher: "/does/not/exist"}
	for _, item := range []Item{
		{Worktree: "/does/not/exist", Base: "base", Head: "head"},
		{Worktree: t.TempDir()},
		{URL: "file:///tmp/example"},
		{URL: "javascript:alert(1)"},
		{URL: "https:///missing-host"},
		{},
	} {
		if err := h.Open(item); err == nil {
			t.Fatalf("Open(%+v) unexpectedly succeeded", item)
		}
	}
}
