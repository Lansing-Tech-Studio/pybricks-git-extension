# In-extension git: push straight to GitHub from the extension

**Date:** 2026-07-02
**Status:** Approved direction (approach A); repo-model default chosen while user was away — see Open decisions.

## Why

The roadmap's "native messaging host" item existed to remove the manual "start the Go server" step. Brainstorming surfaced two facts that change the answer:

1. **GitHub is the destination.** The on-disk working tree is not part of the workflow; sharing, review, history, and recovery all happen on GitHub. Anyone wanting a local copy can `git pull` themselves.
2. **Unmanaged personal Chromebooks must work.** ChromeOS cannot run native-messaging hosts or local processes at all, so the planned native host was a dead end for the most important classroom device.

MV3 extensions with `host_permissions` bypass CORS, so a pure-JS git implementation running in the extension's service worker can speak GitHub's smart-HTTP protocol directly. That removes the server, the native host, *and* the localhost fetches (whose Chrome 138+ Local Network Access permission gate can silently hang the current design) in one move, on every platform including Chromebooks.

## What we're building

The extension itself performs git: clone/fetch/commit/push against a GitHub repo over HTTPS, using a repo copy stored in browser IndexedDB. The Commit and Pull toolbar buttons keep their current behavior and labels; only the transport underneath changes.

## Architecture

```
[code.pybricks.com page]
  ├─ inject.js (MAIN world)      ── unchanged: Pybricks IndexedDB read/write
  │   ↕ window.postMessage (unchanged envelopes)
  ├─ content.js (ISOLATED world) ── unchanged UI; transport swapped:
  │   ↕ chrome.runtime.sendMessage({op, ...})       (was: fetch localhost)
  └─ background.js (service worker) ── the git engine
      ├─ vendor/isomorphic-git UMD  (git implementation)
      ├─ vendor/lightning-fs UMD    (IndexedDB filesystem, /repo clone)
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

### Git engine behavior (background.js)

- **ensureRepo():** if `/repo/.git` is missing or the stored repo URL/branch changed since last clone, wipe the lightning-fs volume and `clone` (singleBranch, full depth — club repos are tiny; shallow clones complicate push/ff).
- **commit op:** `fetch` + `fastForward` first (so we never push from a stale base); write payload files with the same semantics as the Go server's `applyFiles` (write every payload `.py`, delete tracked `.py` files not in the payload, never touch non-`.py`); stage adds/deletes via `statusMatrix`; skip the commit when nothing changed (`committed:false`, still attempt push so stranded commits go up — same as today); commit with author from settings; `push`.
- **pull op:** `fetch` + `fastForward` only. A non-fast-forward situation returns a `pullWarning` naming the problem; we never merge or rebase.
- **Message text is opaque:** empty commit message gets the same `Update from Pybricks at <RFC3339>` default, generated in the service worker now.
- **Block files remain opaque text** — the line-1 workspace JSON round-trips byte-for-byte, exactly as CLAUDE.md requires.

### Settings & auth

- Action popup (`src/popup.html` + `src/popup.js`, plain JS/DOM): repo URL, branch (default `main`), fine-grained GitHub PAT, display name, **Test connection** button.
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
- **The Go server stays** as an optional developer tool (local mirroring of a working tree) with its tests; README repositions it as such. It is no longer part of the user-facing path.
- **README/CLAUDE.md** get the new architecture, the PAT setup guide, and a rewritten roadmap (native messaging removed; Device Flow OAuth and open-tab cleanup remain).

## Testing

- **Git engine integration tests (Node, `node:test`):** isomorphic-git runs natively in Node. The harness serves a bare repo in `t.TempDir()`-style temp dirs through `git http-backend` (CGI) fronted by a tiny Node HTTP server — a real smart-HTTP remote, hermetic, requiring only the `git` binary (already required by the Go tests). Tests cover: clone-on-first-use, commit with custom/default message, no-change no-op, delete-removed-`.py`/keep-non-`.py`, push advances remote head, non-ff pull warning, block-file byte round-trip.
- **`background.js` stays testable unmodified** via the same loader pattern as `test/load-inject.mjs`: read the file, stub `importScripts`/`chrome.*`, publish internals to `globalThis`.
- **Browser verification:** the headless-Chromium CDP recipe (memory: `browser-e2e-recipe`) drives the real UI against a local `git http-backend` remote; trusted input pipeline, screenshot evidence.

## Risks / accepted trade-offs

- ~500 KB vendored JS in a deliberately lean repo (dev-tooling precedent already accepted; these ship, but no build step is introduced).
- Repo copy duplicated in extension IndexedDB (tiny for `.py` projects).
- PAT in `chrome.storage.local` (documented; Device Flow later).
- isomorphic-git is maintenance-mode-ish upstream; pinned vendored version, small API surface used.

## Open decisions (defaults chosen; user to confirm)

1. **Repo model:** designed for *own account, own repo*; the `branch` setting also covers *shared club repo, branch per student* with zero extra work. The folder-per-student model was rejected (merge-conflict-prone).
2. **Go server retained** as a dev tool rather than deleted.
