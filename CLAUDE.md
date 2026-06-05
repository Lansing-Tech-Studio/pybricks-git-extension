# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chrome MV3 extension that adds Git version control to `code.pybricks.com` (the hosted Pybricks block/Python editor for LEGO Powered Up hubs). The extension reads/writes the page's IndexedDB directly and bridges to a Go HTTP server running on the user's machine that performs the actual git operations against a working tree on disk.

This is a wrapper over the deployed site, not a fork of `pybricks-code`. We don't (and can't) ship the upstream block editor — that source is deployed-only and unlicensed for redistribution. Adding Git as an extension sidesteps the entire fork problem.

## Architecture

Three-tier with two cross-world bridges in the browser:

```
[code.pybricks.com page]
  ├─ inject.js (MAIN world)      ─── opens Pybricks' IndexedDB directly
  │   ↕ window.postMessage (REQ/RES envelopes with id correlation)
  ├─ content.js (ISOLATED world) ─── injects toolbar buttons; calls localhost
  │   ↕ fetch http://localhost:8127
  └─ background.js (service worker, currently stub for future native-messaging)

[Go server on host (WSL or native)]
  └─ main.go ─── shells out to /usr/bin/git in --repo working tree
```

**Why two content scripts:** The MAIN-world script can see the page's globals (and could in principle use the page's Dexie instance, though we don't); the ISOLATED-world script has access to `chrome.runtime` APIs and can do cross-origin fetches under `host_permissions`. They communicate via `window.postMessage` with `pybricks-git:request` / `pybricks-git:response` envelopes.

**Why a server, not native messaging:** Native messaging is the right answer for production (no separate process for users to manage), but a localhost server is 10× faster to iterate on. The `native-host/com.pybricks.git.json` template is the placeholder for that migration. The service worker (`src/background.js`) is currently empty — it will own the native-messaging port when we get there.

## Pybricks IndexedDB schema

The page's storage is **discovered, not documented**. `inject.js:openPybricksDb()` enumerates `indexedDB.databases()` and picks the one that has both `metadata` and `_contents` object stores, which is how we identify it without knowing its name.

- **`metadata`** — keyed by `uuid` (a UUID-ish string; Pybricks' generator is not strictly RFC-4122 v4 but Dexie just stores it as a string). Columns: `path` | `sha256` | `viewState` | `uuid`.
- **`_contents`** — keyed by `path`. Columns: `path` | `contents`.

`sha256` is hex-encoded SHA-256 of the contents string. Useful as a free change detector — Pybricks computes it for us. When updating an existing file, **always preserve `viewState` and `uuid` untouched** (Monaco scroll/cursor state lives in `viewState`; `uuid` is the stable identity). Only `sha256` and `contents` should change.

## Block files vs. text files

A "block program" is a regular `.py` file whose **first line** is a sentinel comment:

```
# pybricks blocks file:{...workspace JSON...}
<generated Python below>
```

The line-1 comment carries the entire Blockly workspace state. The rest of the file is valid Python that Pybricks runs verbatim. Both representations live in the single `_contents.contents` string. **Treat this as opaque text** — never parse, regenerate, or "clean up" the line-1 JSON. Round-trip it byte-for-byte.

## The dexie-observable gotcha

Pybricks wraps Dexie with `dexie-observable`, which records mutations in a hidden `_changes` table via Dexie's hook system. Our raw-IndexedDB writes bypass those hooks, so the running React UI does not see our changes. After applying a Pull, `content.js` does `location.reload()` — that's the only currently-working refresh path.

If this becomes painful, the fix paths are (in order of effort): bundle Dexie into the extension and write through it; reverse-engineer `_changes` row format and write directly; or expose Pybricks' Dexie instance via a hook into the page's React tree. None are necessary for the current prototype.

## Server endpoints (`server/main.go`)

| Endpoint | Behavior |
|---|---|
| `GET /status` | `{ok, branch, head, dirty}`. Tolerant of empty repos (uses `git symbolic-ref` for the branch name). |
| `GET /files` | Walks `--repo` for every `.py`, returns `[{path, contents}]`. |
| `POST /commit` | Body `{files, message}`. Writes files to working tree (deletes `.py` files not in payload, leaves non-`.py` alone), `git add -A`, `git commit` if there's a diff. Empty `message` → `Update from Pybricks at <RFC3339>`. |
| `POST /pull` | `git pull --ff-only` then return `{head, files, pullWarning}`. `pullWarning` is non-empty when no remote/upstream is configured — caller still applies the working-tree state. |

CORS is wide-open (`*`); fine because the server binds to `127.0.0.1` only. **The `Cross-Origin-Resource-Policy: cross-origin` response header is mandatory** — `code.pybricks.com` sets `Cross-Origin-Embedder-Policy: require-corp`, so without CORP on our responses, fetches from the page context get blocked.

`safeJoin` rejects paths with `..` or absolute paths; commit payloads are constrained to the repo root.

## Commands

```bash
# Run the server (requires --repo to point at an existing git working tree).
cd server && go run . --repo /path/to/your/git/repo [--port 8127]

# Build a binary.
cd server && go build -o /tmp/pb-git-server .

# Load the extension: chrome://extensions → Developer mode → Load unpacked
# → select the repo root. After editing src/*, click ↻ on the extension card,
# then refresh code.pybricks.com.
```

## Tests

```bash
# Go server: hermetic — each test spins up a throwaway git repo under
# t.TempDir() and shells out to the real `git`, so the suite doubles as
# integration coverage of the git wiring. No flags needed.
cd server && go test ./...

# Extension JS: unit tests for src/inject.js (applyFiles diff + sha256) run on
# Node's built-in test runner against fake-indexeddb (the only dev dependency).
npm install   # once, pulls fake-indexeddb into gitignored node_modules
npm test
```

Notes for changing tests:
- `server/main_test.go` mutates the package-level `repoDir` global, so its tests **must not** run in parallel (no `t.Parallel()`). Each subtest gets its own temp repo via the `setupRepo` helper, which also forces branch `main` and a local git identity.
- `test/load-inject.mjs` loads `src/inject.js` *unmodified* — it reads the file, appends a line publishing the internal functions onto `globalThis`, and runs it in one function scope. Don't add ESM `export`s to `inject.js` to make it testable; that would break it as a classic content script.
- The `test` script globs `test/*.test.mjs` specifically so the `load-inject.mjs` helper isn't picked up as an (empty) test file.
- `package.json` exists **only** for the JS tests — it's tooling, not shipped. The extension still loads unpacked with no build step.

## Things to know before changing things

- `code.pybricks.com` sets **no CSP**, so script/style/eval restrictions are not a constraint. COEP/COOP are present (for `SharedArrayBuffer` / `crossOriginIsolated`, which Pyodide needs); they don't bind extension behavior, but they do force the CORP header on our localhost server.
- The Go server uses **stdlib only**. Keep it that way unless there's a strong reason — the binary is currently ~7 MB and self-contained.
- The extension is plain JS, no build step. If you add a bundler, output to `dist/` (gitignored) and update `manifest.json` paths.
- WSL2 forwards `127.0.0.1` listeners to the Windows host automatically, so a server running in WSL is reachable from Chrome on Windows. Don't bind to `0.0.0.0` "to fix" connectivity — the issue is almost always something else (e.g., empty repo).
- ChromeOS is the known unresolved deployment risk. Managed Chromebooks block sideloaded extensions and Crostini, which kills both halves. The current target is unmanaged Chrome on Linux/macOS/Windows.
