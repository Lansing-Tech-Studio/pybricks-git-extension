# In-extension git: push straight to GitHub from the extension

**Date:** 2026-07-02
**Status:** Approved direction (approach A). Repo model and Go-server decisions confirmed by Brendon 2026-07-02.

## Why

The roadmap's "native messaging host" item existed to remove the manual "start the Go server" step. Brainstorming surfaced two facts that change the answer:

1. **GitHub is the destination.** The on-disk working tree is not part of the workflow; sharing, review, history, and recovery all happen on GitHub. Anyone wanting a local copy can `git pull` themselves.
2. **Unmanaged personal Chromebooks must work.** ChromeOS cannot run native-messaging hosts or local processes at all, so the planned native host was a dead end for the most important classroom device.

MV3 extensions with `host_permissions` bypass CORS, so a pure-JS git implementation running in the extension's service worker can speak GitHub's smart-HTTP protocol directly. That removes the server, the native host, *and* the localhost fetches (whose Chrome 138+ Local Network Access permission gate can silently hang the current design) in one move, on every platform including Chromebooks.

## What we're building

The extension itself performs git: fetch/commit/push against a GitHub repo over HTTPS. The Commit and Pull toolbar buttons keep their current behavior and labels; only the machinery underneath changes.

## Repo model: one shared repo, folder per team

One club-owned GitHub repository holds all teams. Each device maps 1-to-1 to a team and is configured with a **team folder** (path prefix). A device only ever reads and writes files under its own folder:

- **Commit** replaces the contents of `<team>/` with the editor's files (writes every payload `.py`, deletes tracked `.py` files under `<team>/` that aren't in the payload, never touches anything outside the folder).
- **Pull** returns only files under `<team>/`, with the prefix stripped, so each device round-trips exactly its own team's programs.
- An empty team folder means "repo root", which transparently covers a future one-repo-per-team setup if we ever switch.

Known limitation, accepted: GitHub tokens are repo-scoped, not folder-scoped, so any device's token could technically write other teams' folders. Git history makes that visible; acceptable for a club.

## Architecture

```
[code.pybricks.com page]
  ├─ inject.js (MAIN world)      ── unchanged: Pybricks IndexedDB read/write
  │   ↕ window.postMessage (unchanged envelopes)
  ├─ content.js (ISOLATED world) ── unchanged UI; transport swapped:
  │   ↕ chrome.runtime.sendMessage({op, ...})       (was: fetch localhost)
  └─ background.js (service worker) ── the git engine
      ├─ vendor/isomorphic-git UMD  (git implementation)
      ├─ vendor/lightning-fs UMD    (IndexedDB fs: bare gitdir object cache only)
      └─ HTTPS ↔ github.com (smart HTTP), api.github.com (token check)

[src/popup.html] ── settings UI (action popup): repo URL, branch, PAT, name
```

### Message protocol (content ↔ background)

Same shapes as the old HTTP endpoints so `content.js` changes are confined to the transport function:

| op | request | response |
|---|---|---|
| `status` | `{}` | `{ok, branch, head, configured}` (`configured:false` → button error directs to settings) |
| `commit` | `{files:[{path,contents}], message}` | `{committed, head, message, pushed, pushWarning?}` |
| `pull` | `{}` | `{head, files:[{path,contents}], pullWarning}` |

`commit` folds in the push (the extension already chains them today; doing it in one op avoids a second service-worker round trip).

### Git engine behavior (background.js) — stateless commits

Because a device only ever *replaces its own folder*, the engine never maintains a checked-out working tree or a long-lived local branch. Every operation starts from the remote's current head:

- **commit op:** fetch the remote branch head → build a new tree that is byte-identical to the head's tree except `<team>/` is replaced by the payload (low-level `writeBlob`/`writeTree`) → if the new tree equals the old one, report `committed:false` (nothing to push — a stateless engine cannot strand commits) → otherwise `writeCommit` with the fetched head as parent and author from settings → push. **If the push loses a race** to another team, refetch and rebuild from the new head (the payload is still in hand) — bounded retry (3 attempts), and since teams touch disjoint paths the retry always converges.
- **pull op:** fetch the remote head, read `<team>/` files from its tree, return them. There is no local branch to fast-forward, so the old non-ff failure mode disappears; `pullWarning` survives only for "repo/branch not found or empty".
- **Object store:** isomorphic-git still needs a filesystem for fetched objects, so a bare gitdir lives in lightning-fs as a *cache* (makes refetches incremental). It holds no working tree and no unpushed state; any inconsistency is handled by wiping and refetching — self-healing by construction.
- **Message text is opaque:** empty commit message gets the same `Update from Pybricks at <RFC3339>` default, generated in the service worker now.
- **Block files remain opaque text** — the line-1 workspace JSON round-trips byte-for-byte, exactly as CLAUDE.md requires.

### Settings & auth

- Action popup (`src/popup.html` + `src/popup.js`, plain JS/DOM): repo URL, branch (default `main`), **team folder**, fine-grained GitHub PAT, display name (team name), **Test connection** button.
- Test connection calls `api.github.com` to validate the token against the repo and stores the derived commit email (`<login>@users.noreply.github.com`).
- Everything in `chrome.storage.local`. A PAT there is readable by anyone with access to the machine profile — acceptable for the club prototype and documented in README. GitHub Device Flow OAuth is a future upgrade, out of scope here.
- PAT guidance for students (README): fine-grained token, single repository, Contents read/write, nothing else.

### Manifest changes

- `host_permissions`: add `https://github.com/*`, `https://api.github.com/*`; **remove** both localhost entries.
- `background.service_worker` becomes a **classic** worker (drop `"type": "module"`) so `importScripts('vendor/...')` can load the UMD builds with no build step.
- Add `action.default_popup`.
- Vendored libraries live in `vendor/` with a `vendor/README.md` pinning name, version, source URL, and license of each file.

### Service-worker lifetime

A commit+push of a handful of `.py` files completes in single-digit seconds, well inside MV3's event-handling window (the worker stays alive while a `sendMessage` response is pending). If real usage ever hits the ~30 s ceiling, the documented fallback is a `chrome.runtime.connect` port keepalive — not built now (YAGNI).

## What happens to the existing pieces

- **`native-host/` is deleted.** This design supersedes native messaging entirely.
- **`server/` is deleted** (the Go server and its tests) — the extension no longer has any localhost path, and git history preserves the code. The repo becomes single-language (plain JS) with `npm test` as the only suite.
- **README/CLAUDE.md** get the new architecture, the shared-repo/team-folder setup guide, the PAT guidance, and a rewritten roadmap (native messaging removed; Device Flow OAuth and open-tab cleanup remain).

## Testing

- **Git engine integration tests (Node, `node:test`):** isomorphic-git runs natively in Node. The harness serves a bare repo in a temp dir through `git http-backend` (CGI) fronted by a tiny Node HTTP server — a real smart-HTTP remote, hermetic, requiring only the `git` binary. Tests cover: first commit to an empty repo, commit with custom/default message, no-change no-op, folder scoping (writes/deletes confined to `<team>/`, other teams' folders and non-`.py` files untouched), pull returns only the team's files with prefix stripped, push advances remote head, **race retry** (interleave a competing push between fetch and push, assert the retry converges and both teams' work survives), block-file byte round-trip.
- **`background.js` stays testable unmodified** via the same loader pattern as `test/load-inject.mjs`: read the file, stub `importScripts`/`chrome.*`, publish internals to `globalThis`.
- **Browser verification:** the headless-Chromium CDP recipe (memory: `browser-e2e-recipe`) drives the real UI against a local `git http-backend` remote; trusted input pipeline, screenshot evidence.

## Risks / accepted trade-offs

- ~500 KB vendored JS in a deliberately lean repo (dev-tooling precedent already accepted; these ship, but no build step is introduced).
- PAT in `chrome.storage.local` (documented; Device Flow later).
- Tokens are repo-scoped, not folder-scoped — any device can technically write outside its team folder (visible in history; accepted).
- isomorphic-git is maintenance-mode-ish upstream; pinned vendored version, small API surface used.

## Decisions (confirmed with Brendon, 2026-07-02)

1. **Repo model:** one shared club repo, folder per team, device↔team 1-to-1. Empty team folder = repo root, which covers a per-team-repo setup if it's ever wanted instead.
2. **Go server deleted** along with `native-host/`; the extension is the whole product.
