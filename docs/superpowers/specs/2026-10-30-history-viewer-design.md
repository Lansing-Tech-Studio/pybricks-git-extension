# History viewer with diffs and per-file restore (phase 5)

Design settled with Brendon on 2026-10-30. Vocabulary is in `CONTEXT.md`;
the implementation notes are the "History viewer (phase 5)" section of
`CLAUDE.md`. This document records the decisions and why they were taken.

## Problem

The extension could Commit and Pull, but a team had no way to see what changed
between commits, or what they had changed since a commit, without leaving the
editor for GitHub. Kids cannot tell "what did we break since Tuesday" from the
editor alone, and recovering an older working program meant a coach digging
through the fork on github.com.

## What was built

A **History** toolbar button opens a floating panel (the same kind as the Robot
Menu) listing the branch's commits, newest first, with a GitHub-PR-style
unified diff of the editor-visible `.py` files on the right. Two compare modes:

- **Compared to now** — the selected commit's version of each file against the
  editor's current contents, uncommitted work included. The default on every
  open, so the first thing a kid sees is "what haven't I committed yet".
- **This commit's changes** — the commit's first parent against the commit.

`◀ Older` / `Newer ▶` step the selection; `Load older` fetches more. Each
changed file carries **Restore this version**.

## Decisions and reasons

| Decision | Why |
|---|---|
| "commit" in the list, "version" only on the per-file button | "Commit" is already in the toolbar; "version" reads naturally on a button about one file. No kid-facing synonyms invented. |
| "Now" is the editor's contents, not the branch tip | The question kids have is "what have I changed", which only the editor knows. The tip is just the newest row. |
| Default mode is "Compared to now" on the newest commit | First view answers "what's uncommitted" with no clicks. |
| Restore writes the selected commit's version of one file, never deletes, never commits | One rule for both modes. Deleting is a different, riskier action; committing stays an explicit step. |
| No Restore for protected files (badge instead) | Commit would refuse the result; offering it is a trap. |
| Two-click inline confirm on Restore | It overwrites uncommitted edits. One extra click, drivable from the E2E harness, no native dialog. |
| Same file set as Pull (non-dot `.py`) | The viewer must never show a file Pull would hide; both read `readPyFiles`. |
| Unchanged files hidden behind one "N unchanged files" line | A dozen collapsed no-op rows bury the one changed mission. |
| First-parent walk, one row per merge with a badge | GitHub's "Files changed" view of a merge. `git.log` walks all parents and sorts by timestamp. |
| Depth 20, +20 per Load older; fetch on open, after Commit, after Pull, on ↻; never on selection change | A season is 50–100 commits. The fetch is one `upload-pack` negotiation, the same cost class as a Pull. |
| History fetches depth + 1 | So the oldest listed commit's parent tree and blobs are present and every row can show a diff. |
| Pull and Commit stay at depth 1 | They only need the tip's tree. isomorphic-git records a commit as shallow only when a parent is missing locally, so a depth-1 fetch after History leaves the cached chain walkable. |
| `filesAt` never fetches on the hot path; refetches once on `NotFoundError` | CLAUDE.md promises the gitdir can be wiped at any time, and the panel must survive that without a fetch per click. |
| Block programs diff on the Python body only, with "blocks changed" and "blocks moved, same code" markers | The line-1 JSON is one unreadable line; the generated Python mirrors the blocks. |
| Unified diff, 3 lines of context, plus a persisted panel-wide Whole-file toggle | Generated block Python is short; hunks usually show the whole file anyway. The toggle is for kids who prefer full files, every time. |
| "Now" re-read on render and on any click inside the panel; no polling | The read is local and cheap; the moment it matters is right before a Restore or a Commit. |
| Not configured → inline "Set up GitHub first" + open-popup button; real failures → the red error panel | Opening a panel is browsing, not a failed operation. |
| Shared `floating-panel.js` shell extracted now; menu panel migrates later | The code was being written anyway. The menu panel's `persist()` is interleaved with its Save race logic and the E2E driver asserts on its attribute names, so its migration needs that driver as a gate. |
| Own attribute namespace `data-pybricks-git-history-*` | `drive-menu.mjs` queries the menu panel's generic selectors document-wide. |
| Restoring an open block program goes through close/write/reopen, licence dialog and all | Matches Pull and Update robot setup. Hiding the button would be a confusing special case. |

## Out of scope (follow-ups)

- Migrating `menu-panel.js` onto `floating-panel.js`.
- Restoring a whole commit, or deleting files that did not exist at that version.
- Badging the last-pulled commit (needs a `lastPullHead` key written by Pull).
- A side-by-side (split) diff view.

## Verification

- `npm test`: `test/diff.test.mjs`, `test/background-history.test.mjs`, the
  extended `test/background-wiring.test.mjs`.
- `node test/e2e/drive-history.mjs`: the full browser round-trip, including
  the two-click Restore with no reload and no Restore on a protected file.
- `node test/e2e/drive-menu.mjs` still passes (the menu panel is untouched).
