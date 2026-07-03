// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Lansing Tech Studio
//
// Localhost git bridge for the pybricks-git Chrome extension.
//
//	go run . --repo /path/to/your/git/repo [--port 8127]
//
// Endpoints:
//
//	GET  /status      → { ok, branch, dirty, head }
//	GET  /files       → [{ path, contents }]   (every .py in the repo)
//	POST /commit      → write files, git add+commit, return { head }
//	POST /pull        → git pull, return new file list
//	POST /push        → git push to origin (host credentials), return { pushed }
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	repoDir = flag.String("repo", "", "git working directory (required)")
	port    = flag.Int("port", 8127, "port to listen on")
)

type fileRow struct {
	Path     string `json:"path"`
	Contents string `json:"contents"`
}

type commitRequest struct {
	Files   []fileRow `json:"files"`
	Message string    `json:"message"`
}

func main() {
	flag.Parse()
	if *repoDir == "" {
		log.Fatal("--repo is required")
	}
	abs, err := filepath.Abs(*repoDir)
	if err != nil {
		log.Fatalf("--repo: %v", err)
	}
	*repoDir = abs

	if _, err := os.Stat(filepath.Join(*repoDir, ".git")); err != nil {
		log.Fatalf("not a git repo: %s (no .git directory)", *repoDir)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/status", withCORS(handleStatus))
	mux.HandleFunc("/files", withCORS(handleFiles))
	mux.HandleFunc("/commit", withCORS(handleCommit))
	mux.HandleFunc("/pull", withCORS(handlePull))
	mux.HandleFunc("/push", withCORS(handlePush))

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	branch, _ := currentBranch()
	log.Printf("listening on http://%s, repo=%s, branch=%s", addr, *repoDir, branch)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// --- HTTP plumbing ---

func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		// Required because code.pybricks.com sets COEP: require-corp; without
		// CORP on our responses, fetches from the page context get blocked.
		w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, err error) {
	log.Printf("error: %v", err)
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// --- Handlers ---

func handleStatus(w http.ResponseWriter, _ *http.Request) {
	branch, err := currentBranch()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// `rev-parse --short HEAD` fails on a freshly-initialized repo with no
	// commits — that's expected, so treat the empty case as "no head yet".
	head, _ := gitOutput("rev-parse", "--short", "HEAD")
	dirtyOut, _ := gitOutput("status", "--porcelain")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"branch": branch,
		"head":   head,
		"dirty":  dirtyOut != "",
	})
}

// currentBranch returns the current branch name even on an empty repo (where
// HEAD is a symbolic ref to a branch that doesn't exist yet).
func currentBranch() (string, error) {
	return gitOutput("symbolic-ref", "--short", "HEAD")
}

func handleFiles(w http.ResponseWriter, _ *http.Request) {
	files, err := readPyFiles()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, files)
}

func handleCommit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("POST required"))
		return
	}
	var req commitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := applyFiles(req.Files); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if _, err := gitOutput("add", "-A"); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// `git diff --cached --quiet` exits 1 when there are staged changes.
	if err := gitRun("diff", "--cached", "--quiet"); err == nil {
		// No staged changes — nothing to commit.
		head, _ := gitOutput("rev-parse", "--short", "HEAD")
		writeJSON(w, http.StatusOK, map[string]any{
			"committed": false,
			"head":      head,
			"message":   "no changes",
		})
		return
	}

	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		msg = fmt.Sprintf("Update from Pybricks at %s", time.Now().Format(time.RFC3339))
	}
	if _, err := gitOutput("commit", "-m", msg); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	head, _ := gitOutput("rev-parse", "--short", "HEAD")
	writeJSON(w, http.StatusOK, map[string]any{
		"committed": true,
		"head":      head,
		"message":   msg,
	})
}

func handlePull(w http.ResponseWriter, _ *http.Request) {
	// `git pull` may fail because there's no remote configured, no upstream
	// for the current branch, etc. Treat that as a non-fatal warning and
	// still return the working-tree state — useful for local-only testing.
	pullWarning := ""
	if _, err := gitOutput("pull", "--ff-only"); err != nil {
		pullWarning = err.Error()
	}
	files, err := readPyFiles()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	head, _ := gitOutput("rev-parse", "--short", "HEAD")
	writeJSON(w, http.StatusOK, map[string]any{
		"head":        head,
		"files":       files,
		"pullWarning": pullWarning,
	})
}

func handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("POST required"))
		return
	}
	// No remote configured is a normal local-only setup, not an error —
	// mirror /pull's tolerance and let the caller show a soft warning.
	remotes, err := gitOutput("remote")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if remotes == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"pushed":      false,
			"pushWarning": "no remote configured",
		})
		return
	}
	// -u sets the upstream on the first push; harmless afterwards. Auth comes
	// from whatever the host already has (SSH agent, credential helper).
	if _, err := gitOutput("push", "-u", "origin", "HEAD"); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pushed": true})
}

// --- Filesystem ---

func readPyFiles() ([]fileRow, error) {
	var out []fileRow
	err := filepath.WalkDir(*repoDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".py") {
			return nil
		}
		rel, _ := filepath.Rel(*repoDir, path)
		// IndexedDB stores forward-slash paths; normalize on the way out.
		rel = filepath.ToSlash(rel)
		buf, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out = append(out, fileRow{Path: rel, Contents: string(buf)})
		return nil
	})
	return out, err
}

func applyFiles(files []fileRow) error {
	want := make(map[string]struct{}, len(files))
	for _, f := range files {
		clean, err := safeJoin(*repoDir, f.Path)
		if err != nil {
			return err
		}
		want[filepath.ToSlash(strings.TrimPrefix(clean, *repoDir+string(os.PathSeparator)))] = struct{}{}
		if err := os.MkdirAll(filepath.Dir(clean), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(clean, []byte(f.Contents), 0o644); err != nil {
			return err
		}
	}
	// Delete .py files that exist in the working tree but weren't in the request.
	return filepath.WalkDir(*repoDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".py") {
			return nil
		}
		rel, _ := filepath.Rel(*repoDir, path)
		rel = filepath.ToSlash(rel)
		if _, keep := want[rel]; !keep {
			return os.Remove(path)
		}
		return nil
	})
}

func safeJoin(base, rel string) (string, error) {
	rel = filepath.FromSlash(rel)
	cleaned := filepath.Clean(rel)
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, "..") {
		return "", fmt.Errorf("invalid path: %s", rel)
	}
	return filepath.Join(base, cleaned), nil
}

// --- Git wrappers ---

func gitOutput(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = *repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func gitRun(args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = *repoDir
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}
