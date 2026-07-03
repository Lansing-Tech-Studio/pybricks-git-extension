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

## Repo model: fork per team

Brendon maintains an upstream club repo containing shared starter code (`.py` programs). Each team **forks** it into their own repo; each device maps 1-to-1 to a team and is configured with that fork's URL. The shared code is *starter code — theirs to evolve*: after the first Pull it lives in the team's Pybricks editor, and from then on the fork's `.py` contents track the editor 1:1 (edits, additions, deletions).

- **Isolation for free:** a team's PAT is scoped to their own fork, so no device can touch another team's repo or the upstream. Damaging shared code is impossible outside your own fork.
- **Shared-code updates** flow through GitHub's *Sync fork* button (mentor-driven), then the team's next Pull picks them up. Out of scope for the extension.
- **First-commit guard:** Commit's delete semantics ("`.py` files absent from the editor payload get deleted") would let a commit-before-first-Pull wipe the starter code out of a fresh fork. Guard: the extension remembers the set of paths returned by the last Pull (`chrome.storage.local`), and **Commit only deletes paths that appeared in that snapshot**. Never-pulled files are preserved (with a note in the response), so a fresh device's first Commit adds the editor's files without touching starter code. The natural flow — Pull first, then work — behaves exactly as today.

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

The engine never maintains a checked-out working tree or a long-lived local branch. Every operation starts from the remote's current head:

- **commit op:** fetch the remote branch head → build a new tree from the head's tree: every payload `.py` written, `.py` files absent from the payload deleted *only if they were in the last-Pull snapshot* (first-commit guard above), non-`.py` files untouched (low-level `writeBlob`/`writeTree`) → if the new tree equals the old one, report `committed:false` (nothing to push — a stateless engine cannot strand commits) → otherwise `writeCommit` with the fetched head as parent and author from settings → push. **If the push loses a race** (e.g. two devices on one fork, or a Sync-fork landing mid-commit), refetch and rebuild from the new head (the payload is still in hand) — bounded retry (3 attempts).
- **pull op:** fetch the remote head, read its `.py` files, store the path set as the last-Pull snapshot, return the files. There is no local branch to fast-forward, so the old non-ff failure mode disappears; `pullWarning` survives only for "repo/branch not found or empty".
- **Object store:** isomorphic-git still needs a filesystem for fetched objects, so a bare gitdir lives in lightning-fs as a *cache* (makes refetches incremental). It holds no working tree and no unpushed state; any inconsistency is handled by wiping and refetching — self-healing by construction.
- **Message text is opaque:** empty commit message gets the same `Update from Pybricks at <RFC3339>` default, generated in the service worker now.
- **Block files remain opaque text** — the line-1 workspace JSON round-trips byte-for-byte, exactly as CLAUDE.md requires.

### Settings & auth

- Action popup (`src/popup.html` + `src/popup.js`, plain JS/DOM): fork URL, branch (default `main`), fine-grained GitHub PAT, display name (team name), **Test connection** button.
- Test connection calls `api.github.com` to validate the token against the repo and stores the derived commit email (`<login>@users.noreply.github.com`).
- Everything in `chrome.storage.local`. A PAT there is readable by anyone with access to the machine profile — acceptable for the club prototype and documented in README. GitHub Device Flow OAuth is a future upgrade, out of scope here.
- PAT guidance for students (README): fine-grained token, single repository (their fork only), Contents read/write, nothing else.

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
- **README/CLAUDE.md** get the new architecture, the fork-per-team setup guide (fork upstream → create PAT → configure popup → Pull first), and a rewritten roadmap (native messaging removed; Device Flow OAuth and open-tab cleanup remain).

## Testing

- **Git engine integration tests (Node, `node:test`):** isomorphic-git runs natively in Node. The harness serves a bare repo in a temp dir through `git http-backend` (CGI) fronted by a tiny Node HTTP server — a real smart-HTTP remote, hermetic, requiring only the `git` binary. Tests cover: first commit to an empty repo, commit with custom/default message, no-change no-op, **first-commit guard** (commit before any pull preserves starter `.py` files; after a pull, absent files are deleted), non-`.py` files never touched, pull returns all `.py` files and records the snapshot, push advances remote head, **race retry** (interleave a competing push between fetch and push, assert the retry converges and both changes survive), block-file byte round-trip.
- **`background.js` stays testable unmodified** via the same loader pattern as `test/load-inject.mjs`: read the file, stub `importScripts`/`chrome.*`, publish internals to `globalThis`.
- **Browser verification:** the headless-Chromium CDP recipe (memory: `browser-e2e-recipe`) drives the real UI against a local `git http-backend` remote; trusted input pipeline, screenshot evidence.

## Risks / accepted trade-offs

- ~500 KB vendored JS in a deliberately lean repo (dev-tooling precedent already accepted; these ship, but no build step is introduced).
- PAT in `chrome.storage.local` (documented; Device Flow later).
- The last-Pull snapshot is the engine's only persistent state besides settings; losing it (cleared storage) degrades safely — deletions stop propagating until the next Pull, nothing is destroyed.
- isomorphic-git is maintenance-mode-ish upstream; pinned vendored version, small API surface used.

## Decisions (confirmed with Brendon, 2026-07-02)

1. **Repo model:** fork per team from Brendon's upstream shared-code repo, device↔team 1-to-1. Shared code is starter code the team evolves; forking (not folders) is the isolation boundary, chosen to prevent accidental damage to shared code.
2. **Shared code behavior:** *starter code — theirs to evolve* (whole-fork ↔ editor round-trip, with the first-commit guard).
3. **Go server deleted** along with `native-host/`; the extension is the whole product.
