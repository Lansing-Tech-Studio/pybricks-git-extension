# Pybricks Git

A Chrome extension that adds Git version control to [code.pybricks.com](https://code.pybricks.com) — the hosted Pybricks editor for LEGO Powered Up hubs.

> **Status: prototype.** The commit, push, and pull round-trip works against a local git repository (and its remote, if one is configured). Nothing is ready for classroom deployment yet. See [Roadmap](#roadmap) for what's next.

## Why this exists

Pybricks Code is a great in-browser editor, but every program lives in IndexedDB inside one browser profile on one machine. There's no version history, no way to share a starter file with a team, no way to recover yesterday's working program. This extension wraps the deployed site (without forking it) and adds a Git workflow on top: commit your current set of files, pull updates from disk back into the editor.

It works equally well for block-based programs and Python programs — block files are stored as `.py` files with their workspace JSON in a line-1 comment, so Git just sees text.

## Current capabilities

- **Commit button** in the editor toolbar — prompts for a commit message (blank = auto-timestamped), writes every file from IndexedDB into a local git working tree, then `git commit`.
- **Push after commit** — if the repo has a remote, every commit is followed by `git push` using whatever credentials the machine already has (SSH agent, credential helper). No remote configured is fine; push is silently skipped.
- **Pull button** — reads the local git working tree and applies changes back into IndexedDB (adds new files, updates changed ones, deletes removed ones). Preserves Monaco scroll/cursor state and file UUIDs on update.
- **Works on both program types** — Python and block files round-trip identically; the extension treats `_contents.contents` as opaque text.
- **No remote required** for local-only testing — commits stay local and push is skipped until you add a remote.

## Roadmap

In rough priority order:

1. **Native messaging host** — replaces the localhost server with a Chrome native-messaging binary, removing the "start the server" step. The `native-host/` directory has a placeholder manifest.
2. **Open-tab cleanup on delete** — when Pull deletes a file, also clean up its entry in Pybricks' "open tabs" state so the page doesn't log a non-fatal error after reload.
3. **Classroom credential story** — push currently rides on the host machine's git credentials, which is fine for a developer setup but not for a shared classroom machine.
4. **ChromeOS deployment story** — managed Chromebooks block both sideloaded extensions and Crostini, which kills the current architecture for school district deployments. Open question: enterprise force-install + remote git proxy, or a Tauri desktop wrapper.
5. **Multi-user / classroom features** — per-student branches, mentor review workflow.

## Install

You need both halves running: the extension in Chrome, and the Go server on the same machine.

### Extension

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select this repository's root.
3. Open or refresh `https://code.pybricks.com`. You should see **Commit** and **Pull** buttons in the editor toolbar.

### Server

Requires Go 1.22+ and a git working tree.

```bash
# Once: create or clone the repo you want to sync to.
mkdir -p ~/pybricks-classroom && cd ~/pybricks-classroom && git init -q
git commit --allow-empty -m "init"   # required for an empty repo

# Each session: start the server.
cd path/to/pybricks-git-extension/server
go run . --repo ~/pybricks-classroom
# → listening on http://127.0.0.1:8127, repo=..., branch=main
```

Leave the server running while you use Pybricks Code.

## Usage

| Action | What it does |
|---|---|
| Click **Commit** | Opens a message input under the button — **Enter** commits (blank message = timestamped default), **Escape** cancels. The server writes every file from IndexedDB into the working tree, creates a commit, then pushes if a remote is configured. Button shows `✓ <short-sha> ↑` (committed and pushed), `✓ <short-sha>` (no remote), `no changes`, or `… push failed` (commit succeeded, push didn't — see the console). |
| Click **Pull** | Server runs `git pull --ff-only` (skipped if no remote is configured), reads the working tree, returns the file list. Extension applies it to IndexedDB and reloads the page. Button shows `↓ +N ~N -N` (added / changed / deleted). |

## Architecture

Three tiers: a Chrome extension content script reads/writes the page's IndexedDB directly; an HTTP server on `127.0.0.1` performs git operations against a working tree on disk; the two communicate via simple JSON endpoints. The extension is plain JavaScript with no build step. The server is a single-file Go program with stdlib only.

Detailed architecture, the IndexedDB schema we discovered, and gotchas (especially around `dexie-observable` and the page's COEP header) are documented in [CLAUDE.md](CLAUDE.md).

## Known limitations

- **Page reloads after Pull.** Pybricks wraps Dexie with `dexie-observable`; our raw-IndexedDB writes bypass its hook system, so React doesn't see them until a reload. This is a deliberate prototype choice — fixable later.
- **Single working tree per server.** The server is configured with one `--repo` flag at startup. Multi-repo support would need an endpoint to switch context.
- **No auth on the localhost server.** Fine because it binds to `127.0.0.1` only, but anything on the local machine can reach it.
- **Push uses the host's git credentials.** The server just runs `git push`; if the machine's SSH agent or credential helper can't reach the remote, the push fails (the commit still succeeds locally).
- **ChromeOS is unsupported.** See roadmap.
- **WSL note.** The server can run inside WSL2 and Chrome on Windows can still reach it — Windows forwards `127.0.0.1` listeners automatically. Don't bind to `0.0.0.0`.

## License

MIT — see [LICENSE](LICENSE).
