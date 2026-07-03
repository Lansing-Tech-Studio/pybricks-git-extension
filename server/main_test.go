// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Lansing Tech Studio
//
// Tests for the localhost git bridge. These shell out to the real `git`
// binary against throwaway repos created under t.TempDir(), so they double
// as integration coverage of the git wiring. They mutate the package-level
// `repoDir` global, so they must not run in parallel with each other.
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// --- helpers ---

// setupRepo creates an initialized git repo in a temp dir, points the
// package-level repoDir at it, and returns the directory. The repo has a
// deterministic branch name (main) and a local user identity so commits work
// without relying on the machine's global git config.
func setupRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	// Resolve symlinks so paths compare equal to what the server computes
	// (macOS /var -> /private/var, etc.).
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	runGit(t, dir, "init", "-q")
	runGit(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test")
	// commit.gpgsign off in case the host has it globally enabled.
	runGit(t, dir, "config", "commit.gpgsign", "false")

	prev := repoDir
	repoDir = &dir
	t.Cleanup(func() { repoDir = prev })
	return dir
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFile(t *testing.T, dir, rel, contents string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commitAll(t *testing.T, dir, msg string) {
	t.Helper()
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "-q", "-m", msg)
}

// callJSON invokes a handler and decodes the JSON response into a generic map.
func callJSON(t *testing.T, h http.HandlerFunc, method, target string, body any) (int, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = bytes.NewReader(buf)
	}
	req := httptest.NewRequest(method, target, r)
	rec := httptest.NewRecorder()
	h(rec, req)
	res := rec.Result()
	defer res.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(res.Body)
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("decode response (%d): %v\n%s", res.StatusCode, err, raw)
		}
	}
	return res.StatusCode, out
}

// --- safeJoin ---

func TestSafeJoin(t *testing.T) {
	base := filepath.Join("/", "repo")
	cases := []struct {
		name    string
		rel     string
		wantErr bool
		want    string // expected path relative to base, slash form (when no error)
	}{
		{"simple", "main.py", false, "main.py"},
		{"nested", "lib/util.py", false, "lib/util.py"},
		{"dot prefix", "./main.py", false, "main.py"},
		{"interior dotdot stays inside", "a/../b.py", false, "b.py"},
		{"parent traversal", "../evil.py", true, ""},
		{"deep traversal", "a/../../evil.py", true, ""},
		{"bare dotdot", "..", true, ""},
		{"absolute unix", "/etc/passwd", true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := safeJoin(base, c.rel)
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %q", c.rel, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", c.rel, err)
			}
			rel, _ := filepath.Rel(base, got)
			if filepath.ToSlash(rel) != c.want {
				t.Fatalf("safeJoin(%q) = %q (rel %q), want rel %q", c.rel, got, rel, c.want)
			}
		})
	}
}

// --- /status ---

func TestStatusEmptyRepo(t *testing.T) {
	setupRepo(t)
	code, body := callJSON(t, withCORS(handleStatus), http.MethodGet, "/status", nil)
	if code != http.StatusOK {
		t.Fatalf("status code = %d, want 200", code)
	}
	if body["ok"] != true {
		t.Errorf("ok = %v, want true", body["ok"])
	}
	if body["branch"] != "main" {
		t.Errorf("branch = %v, want main", body["branch"])
	}
	if body["head"] != "" {
		t.Errorf("head = %q, want empty on fresh repo", body["head"])
	}
	if body["dirty"] != false {
		t.Errorf("dirty = %v, want false on empty repo", body["dirty"])
	}
}

func TestStatusAfterCommit(t *testing.T) {
	dir := setupRepo(t)
	writeFile(t, dir, "main.py", "print(1)\n")
	commitAll(t, dir, "init")

	code, body := callJSON(t, withCORS(handleStatus), http.MethodGet, "/status", nil)
	if code != http.StatusOK {
		t.Fatalf("status code = %d, want 200", code)
	}
	if body["head"] == "" {
		t.Errorf("head should be non-empty after a commit")
	}
	if body["dirty"] != false {
		t.Errorf("dirty = %v, want false on a clean tree", body["dirty"])
	}

	// Introduce an untracked change -> dirty.
	writeFile(t, dir, "extra.py", "x = 2\n")
	_, body = callJSON(t, withCORS(handleStatus), http.MethodGet, "/status", nil)
	if body["dirty"] != true {
		t.Errorf("dirty = %v, want true after adding an untracked file", body["dirty"])
	}
}

// --- /files ---

func TestFilesReturnsOnlyPyWithSlashPaths(t *testing.T) {
	dir := setupRepo(t)
	writeFile(t, dir, "main.py", "print('a')\n")
	writeFile(t, dir, "lib/helper.py", "print('b')\n")
	writeFile(t, dir, "README.md", "# not python\n")
	writeFile(t, dir, "data.txt", "ignore me\n")

	req := httptest.NewRequest(http.MethodGet, "/files", nil)
	rec := httptest.NewRecorder()
	withCORS(handleFiles)(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", rec.Code)
	}
	var files []fileRow
	if err := json.Unmarshal(rec.Body.Bytes(), &files); err != nil {
		t.Fatalf("decode: %v\n%s", err, rec.Body.String())
	}
	got := map[string]string{}
	for _, f := range files {
		got[f.Path] = f.Contents
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 .py files, got %d: %v", len(got), got)
	}
	if got["main.py"] != "print('a')\n" {
		t.Errorf("main.py contents = %q", got["main.py"])
	}
	if _, ok := got["lib/helper.py"]; !ok {
		t.Errorf("expected forward-slash nested path lib/helper.py, got keys %v", got)
	}
	if _, ok := got["README.md"]; ok {
		t.Errorf("non-.py file leaked into /files")
	}
}

func TestFilesSkipsGitDir(t *testing.T) {
	dir := setupRepo(t)
	writeFile(t, dir, "main.py", "print(1)\n")
	// A .py file living inside .git must never be returned.
	writeFile(t, dir, ".git/hooks/sneaky.py", "evil = True\n")

	req := httptest.NewRequest(http.MethodGet, "/files", nil)
	rec := httptest.NewRecorder()
	handleFiles(rec, req)
	var files []fileRow
	if err := json.Unmarshal(rec.Body.Bytes(), &files); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.Contains(f.Path, ".git") {
			t.Fatalf("file from .git leaked: %q", f.Path)
		}
	}
	if len(files) != 1 {
		t.Fatalf("expected only main.py, got %d files: %+v", len(files), files)
	}
}

// --- /commit ---

func TestCommitCreatesCommit(t *testing.T) {
	dir := setupRepo(t)
	body := commitRequest{
		Files: []fileRow{
			{Path: "main.py", Contents: "print('hello')\n"},
			{Path: "lib/util.py", Contents: "def f(): pass\n"},
		},
		Message: "first commit",
	}
	code, resp := callJSON(t, withCORS(handleCommit), http.MethodPost, "/commit", body)
	if code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (resp %v)", code, resp)
	}
	if resp["committed"] != true {
		t.Errorf("committed = %v, want true", resp["committed"])
	}
	if resp["message"] != "first commit" {
		t.Errorf("message = %v, want 'first commit'", resp["message"])
	}
	if resp["head"] == "" {
		t.Errorf("head should be non-empty")
	}
	// Files landed on disk.
	if b, err := os.ReadFile(filepath.Join(dir, "main.py")); err != nil || string(b) != "print('hello')\n" {
		t.Errorf("main.py on disk = %q, err %v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "lib", "util.py")); err != nil || string(b) != "def f(): pass\n" {
		t.Errorf("lib/util.py on disk = %q, err %v", b, err)
	}
	// And git actually recorded it.
	if msg := runGit(t, dir, "log", "-1", "--pretty=%s"); msg != "first commit" {
		t.Errorf("git log subject = %q, want 'first commit'", msg)
	}
}

func TestCommitNoChangesIsNoop(t *testing.T) {
	dir := setupRepo(t)
	body := commitRequest{Files: []fileRow{{Path: "main.py", Contents: "x=1\n"}}}
	callJSON(t, withCORS(handleCommit), http.MethodPost, "/commit", body)

	// Second identical commit -> nothing staged.
	code, resp := callJSON(t, withCORS(handleCommit), http.MethodPost, "/commit", body)
	if code != http.StatusOK {
		t.Fatalf("code = %d, want 200", code)
	}
	if resp["committed"] != false {
		t.Errorf("committed = %v, want false on a no-op commit", resp["committed"])
	}
	if resp["message"] != "no changes" {
		t.Errorf("message = %v, want 'no changes'", resp["message"])
	}
	if n := runGit(t, dir, "rev-list", "--count", "HEAD"); n != "1" {
		t.Errorf("commit count = %s, want 1 (no second commit)", n)
	}
}

func TestCommitDeletesRemovedPyButKeepsOtherFiles(t *testing.T) {
	dir := setupRepo(t)
	// Seed two .py files and a non-.py file via a real commit.
	writeFile(t, dir, "a.py", "a=1\n")
	writeFile(t, dir, "b.py", "b=1\n")
	writeFile(t, dir, "keep.txt", "data\n")
	commitAll(t, dir, "seed")

	// Commit only a.py — b.py should be deleted, keep.txt left alone.
	body := commitRequest{Files: []fileRow{{Path: "a.py", Contents: "a=2\n"}}}
	code, resp := callJSON(t, withCORS(handleCommit), http.MethodPost, "/commit", body)
	if code != http.StatusOK || resp["committed"] != true {
		t.Fatalf("commit failed: code %d resp %v", code, resp)
	}
	if _, err := os.Stat(filepath.Join(dir, "b.py")); !os.IsNotExist(err) {
		t.Errorf("b.py should have been deleted, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "keep.txt")); err != nil {
		t.Errorf("keep.txt (non-.py) should be untouched, stat err = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.py")); string(b) != "a=2\n" {
		t.Errorf("a.py = %q, want updated contents", b)
	}
}

func TestCommitDefaultMessage(t *testing.T) {
	setupRepo(t)
	body := commitRequest{Files: []fileRow{{Path: "main.py", Contents: "x=1\n"}}}
	_, resp := callJSON(t, withCORS(handleCommit), http.MethodPost, "/commit", body)
	msg, _ := resp["message"].(string)
	if !strings.HasPrefix(msg, "Update from Pybricks at ") {
		t.Errorf("default message = %q, want 'Update from Pybricks at <ts>' prefix", msg)
	}
}

func TestCommitRejectsPathTraversal(t *testing.T) {
	setupRepo(t)
	body := commitRequest{Files: []fileRow{{Path: "../evil.py", Contents: "pwned\n"}}}
	code, resp := callJSON(t, withCORS(handleCommit), http.MethodPost, "/commit", body)
	if code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 for traversal path (resp %v)", code, resp)
	}
}

func TestCommitMethodNotAllowed(t *testing.T) {
	setupRepo(t)
	code, _ := callJSON(t, withCORS(handleCommit), http.MethodGet, "/commit", nil)
	if code != http.StatusMethodNotAllowed {
		t.Fatalf("code = %d, want 405 for GET", code)
	}
}

func TestCommitBadJSON(t *testing.T) {
	setupRepo(t)
	req := httptest.NewRequest(http.MethodPost, "/commit", strings.NewReader("{not json"))
	rec := httptest.NewRecorder()
	withCORS(handleCommit)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 for malformed JSON", rec.Code)
	}
}

// --- /pull ---

func TestPullNoRemoteWarnsButReturnsFiles(t *testing.T) {
	dir := setupRepo(t)
	writeFile(t, dir, "main.py", "print('x')\n")
	commitAll(t, dir, "seed")

	code, resp := callJSON(t, withCORS(handlePull), http.MethodGet, "/pull", nil)
	if code != http.StatusOK {
		t.Fatalf("code = %d, want 200", code)
	}
	warn, _ := resp["pullWarning"].(string)
	if warn == "" {
		t.Errorf("expected a non-empty pullWarning when no remote is configured")
	}
	files, ok := resp["files"].([]any)
	if !ok || len(files) != 1 {
		t.Fatalf("files = %v, want one entry", resp["files"])
	}
}

// --- /push ---

// setupBareRemote creates a bare repo in a temp dir and adds it as `origin`
// of the current test repo.
func setupBareRemote(t *testing.T, dir string) string {
	t.Helper()
	bare := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(bare); err == nil {
		bare = resolved
	}
	runGit(t, bare, "init", "-q", "--bare")
	runGit(t, dir, "remote", "add", "origin", bare)
	return bare
}

func TestPushNoRemoteWarns(t *testing.T) {
	dir := setupRepo(t)
	writeFile(t, dir, "main.py", "print(1)\n")
	commitAll(t, dir, "seed")

	code, resp := callJSON(t, withCORS(handlePush), http.MethodPost, "/push", nil)
	if code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (resp %v)", code, resp)
	}
	if resp["pushed"] != false {
		t.Errorf("pushed = %v, want false with no remote", resp["pushed"])
	}
	warn, _ := resp["pushWarning"].(string)
	if warn == "" {
		t.Errorf("expected a non-empty pushWarning when no remote is configured")
	}
}

func TestPushToBareRemote(t *testing.T) {
	dir := setupRepo(t)
	bare := setupBareRemote(t, dir)
	writeFile(t, dir, "main.py", "print(1)\n")
	commitAll(t, dir, "seed")

	code, resp := callJSON(t, withCORS(handlePush), http.MethodPost, "/push", nil)
	if code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (resp %v)", code, resp)
	}
	if resp["pushed"] != true {
		t.Errorf("pushed = %v, want true", resp["pushed"])
	}
	localHead := runGit(t, dir, "rev-parse", "HEAD")
	remoteHead := runGit(t, bare, "rev-parse", "refs/heads/main")
	if localHead != remoteHead {
		t.Errorf("remote head = %s, want %s", remoteHead, localHead)
	}

	// A second push with a new commit must also land (upstream already set).
	writeFile(t, dir, "main.py", "print(2)\n")
	commitAll(t, dir, "second")
	code, resp = callJSON(t, withCORS(handlePush), http.MethodPost, "/push", nil)
	if code != http.StatusOK || resp["pushed"] != true {
		t.Fatalf("second push: code %d resp %v", code, resp)
	}
	if got := runGit(t, bare, "rev-parse", "refs/heads/main"); got != runGit(t, dir, "rev-parse", "HEAD") {
		t.Errorf("remote head not advanced on second push")
	}
}

func TestPushDivergedRemoteFails(t *testing.T) {
	dir := setupRepo(t)
	bare := setupBareRemote(t, dir)
	writeFile(t, dir, "main.py", "print(1)\n")
	commitAll(t, dir, "seed")
	runGit(t, dir, "push", "-q", "-u", "origin", "HEAD")

	// Advance the remote through a second clone so the local repo is behind.
	clone := t.TempDir()
	runGit(t, clone, "clone", "-q", bare, "work")
	work := filepath.Join(clone, "work")
	runGit(t, work, "config", "user.email", "other@example.com")
	runGit(t, work, "config", "user.name", "Other")
	runGit(t, work, "config", "commit.gpgsign", "false")
	writeFile(t, work, "main.py", "print('remote')\n")
	commitAll(t, work, "remote change")
	runGit(t, work, "push", "-q", "origin", "HEAD")

	// Diverge locally.
	writeFile(t, dir, "main.py", "print('local')\n")
	commitAll(t, dir, "local change")

	code, resp := callJSON(t, withCORS(handlePush), http.MethodPost, "/push", nil)
	if code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500 for non-fast-forward push (resp %v)", code, resp)
	}
	errMsg, _ := resp["error"].(string)
	if errMsg == "" {
		t.Errorf("expected error message in response")
	}
}

func TestPushMethodNotAllowed(t *testing.T) {
	setupRepo(t)
	code, _ := callJSON(t, withCORS(handlePush), http.MethodGet, "/push", nil)
	if code != http.StatusMethodNotAllowed {
		t.Fatalf("code = %d, want 405 for GET", code)
	}
}

// --- CORS plumbing ---

func TestWithCORSHeaders(t *testing.T) {
	setupRepo(t)
	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rec := httptest.NewRecorder()
	withCORS(handleStatus)(rec, req)
	h := rec.Header()
	if h.Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("ACAO = %q, want *", h.Get("Access-Control-Allow-Origin"))
	}
	// Mandatory: code.pybricks.com sets COEP: require-corp.
	if h.Get("Cross-Origin-Resource-Policy") != "cross-origin" {
		t.Errorf("CORP = %q, want cross-origin", h.Get("Cross-Origin-Resource-Policy"))
	}
}

func TestWithCORSPreflightShortCircuits(t *testing.T) {
	// OPTIONS must return 204 without invoking the wrapped handler (which would
	// otherwise panic here because repoDir isn't set for this test).
	called := false
	h := withCORS(func(http.ResponseWriter, *http.Request) { called = true })
	req := httptest.NewRequest(http.MethodOptions, "/commit", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("OPTIONS code = %d, want 204", rec.Code)
	}
	if called {
		t.Errorf("wrapped handler should not run on preflight")
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Errorf("preflight should still advertise allowed methods")
	}
}

// --- applyFiles (direct, incl. round-trip) ---

func TestApplyFilesRoundTrip(t *testing.T) {
	dir := setupRepo(t)
	// A block-program file: line-1 sentinel comment must round-trip byte-for-byte.
	block := "# pybricks blocks file:{\"a\":1,\"b\":[2,3]}\nfrom pybricks import *\n"
	in := []fileRow{
		{Path: "prog.py", Contents: block},
		{Path: "nested/deep/mod.py", Contents: "y = 2\n"},
	}
	if err := applyFiles(in); err != nil {
		t.Fatalf("applyFiles: %v", err)
	}
	out, err := readPyFiles()
	if err != nil {
		t.Fatalf("readPyFiles: %v", err)
	}
	got := map[string]string{}
	for _, f := range out {
		got[f.Path] = f.Contents
	}
	if got["prog.py"] != block {
		t.Errorf("block file did not round-trip:\n got %q\nwant %q", got["prog.py"], block)
	}
	if got["nested/deep/mod.py"] != "y = 2\n" {
		t.Errorf("nested file = %q", got["nested/deep/mod.py"])
	}
	// Confirm the directory was actually created on disk.
	if _, err := os.Stat(filepath.Join(dir, "nested", "deep", "mod.py")); err != nil {
		t.Errorf("nested dir not created: %v", err)
	}
}
