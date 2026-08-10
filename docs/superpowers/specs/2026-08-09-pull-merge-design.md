# Merge on Pull — design

Date: 2026-08-09
Status: approved, not yet implemented

## Problem

Pull destroys uncommitted local work with no warning and no recovery.

`content.js:pull()` hands the repo's file list straight to the `apply-files`
bridge op. That op treats its payload as the **complete desired state**: it
overwrites every listed path and deletes every IDB row whose path isn't listed
(`inject.js:writeFiles`, the `deleteUnlisted` pass). Nothing anywhere compares
the incoming files against what the editor currently holds.

Two distinct losses fall out of that:

1. **Edited files are overwritten.** A program the kid changed since the last
   pull is replaced by the repo's version.
2. **New local files are deleted.** A program created in the editor and never
   committed isn't in the repo's list, so the delete pass removes it. This is
   the case that prompted the spec.

Neither is recoverable — the IndexedDB rows are gone and there is no local git.

The `lastPullPaths` snapshot that guards deletion in `commitOp` has no
equivalent on the pull side.

## Constraints

Three facts about this codebase shape every part of the design:

- **There is no local git.** No working tree, no local commits; `commitOp`
  builds directly on the fetched remote tip and pushes. "Merge conflict" here
  is not a git concept — it is editor-vs-remote-tip, at whole-file granularity.
- **There is no merge base.** `lastPullPaths` stores paths, not contents. You
  can see that a file differs from the repo, but not *who* changed it. Supplying
  that base is the one piece of new state this design adds.
- **Block files cannot be text-merged.** Line 1 is a JSON workspace blob and the
  body is generated from it; hunk-level merging produces corrupt programs. A
  real merge driver is rejected outright. Resolution is per file: the repo's
  copy or the local copy, never a blend.

## Decisions

Locked with Brendon during design:

- **Contested files keep both copies, and the *local* copy is the one renamed.**
  The repo's path stays canonical so `menu_config.py`, protected files, and
  anything the hub menu references by name keep working. The kid's divergent
  version moves aside.
- **Protected files are exempt.** The repo's version simply overwrites; no
  rescue copy. A `menu_config_mine.py` the kid can't use is clutter, and
  `commitOp` already refuses to push protected paths.
- **Rescued files are ordinary files.** They commit, push, and sync to
  teammates like anything else. No special-casing in `commitOp`, no menu
  exclusion. Coaches clean them up.
- **No conflict dialog.** Resolution is automatic; the kid is told what
  happened, not asked what to do.

## Design

### New state: `lastPullShas`

`pullOp` replaces `lastPullPaths` with `lastPullShas` — a `{path: sha256}` map
over the file set the repo just handed the editor, written under the same
`if (head)` guard that protects the existing snapshot from empty-branch pulls.

`sha256` is hex SHA-256 of the contents string — the same algorithm Pybricks
uses for each `metadata` row's stored `sha256` and that `inject.js:sha256()`
computes. The repo side is hashed once at pull time; the local side is
recomputed in `content.js` from `list-files`' contents rather than trusted off
the metadata row, since that stored value is only as current as Pybricks' own
write path keeps it.

`commitOp`'s deletion snapshot becomes `Object.keys(lastPullShas)`, falling back
to `lastPullPaths` when `lastPullShas` is absent so installs that haven't pulled
since the upgrade keep working. One key replaced, not added.

Contents are deliberately *not* stored — a block program's line-1 JSON runs to
tens of kilobytes and `chrome.storage.local`'s default quota is 10 MB.

### New file: `src/pullmerge.js`

Pure, DOM-free, no dependencies — the established pattern of `menu-config.js`
and `blocksplice.js`, with a `test/load-pullmerge.mjs` shim for Node. Added to
`manifest.json` `content_scripts` before `content.js`, which is its only caller.

One exported function:

```
planPull({local, repo, base, protectedPaths}) → {files, rescued}
```

- `local` — `[{path, contents, sha}]` from `list-files`; `sha` is always
  recomputed from `contents` in `content.js` (matching `inject.js:sha256()`
  byte-for-byte) rather than read off the metadata row's stored `sha256`,
  since that value is only as current as Pybricks' own write path keeps it.
- `repo` — `[{path, contents}]` from the `pull` op.
- `base` — the `lastPullShas` map, possibly empty.
- `protectedPaths` — the `protected` array the `pull` op already returns.
- `files` — the complete desired file set to hand `apply-files`. The op is
  unchanged; `inject.js` needs no edit.
- `rescued` — `[{path, savedAs}]`, for the notice.

**Classification.** A path is *touched* when it has no `base` entry, or its
local sha differs from that entry.

| situation | result |
|---|---|
| untouched; repo changed, added, or deleted it | repo wins, silently — today's behavior |
| touched; repo has it | repo's version at the canonical path, local contents written to `<stem>_mine.py` |
| touched; repo deleted it | canonical path deleted, local contents survive as `<stem>_mine.py` |
| touched, but local contents already equal the repo's | nothing — no pointless duplicate |
| local-only, absent from both `base` and `repo` | **kept under its own name**, no rename, no notice |
| protected path **that the repo has** | repo wins, no rescue copy |
| protected path the repo does *not* have, created locally | kept under its own name — see below |

**Protection only bites for paths the repo actually has.** A manifest can name
a path that doesn't exist upstream — the starter's `.pybricks-git.json` names
`robot_setup_template.py` and `robot_setup.py`, neither of which has been
authored yet. If a locally created file took a protected-but-absent name and
the protected rule applied, there would be no repo version to replace it with,
so "the repo wins" would degrade to "delete the file the kid just made." The
local-only row therefore takes precedence: a file absent from both `base` and
`repo` keeps its name whether or not the manifest reserves it. A protected path
that *was* in `base` and the repo has since deleted is unaffected — the coach
removed it deliberately, so it goes, with no rescue copy.

The local-only row is the fix for the reported loss: a path nobody else has an
opinion about is uncontested, so it is carried into the payload untouched.
A locally-created path that the repo *also* contains independently is contested
by definition (no `base` entry ⇒ touched) and takes the rename.

**Rename.** `<stem>_mine.py`, bumping to `_mine2`, `_mine3` on collision,
checked against both the live local paths and the incoming repo paths.
Underscore, not `(mine)`: the name must stay a valid Python module name or the
file can't be imported and `analyzeProgram` rules it out of the hub menu.

**Missing base.** When `lastPullShas` is absent or empty — first pull after
upgrading, cleared storage — every local file counts as touched. Everything
whose contents genuinely differ from the repo's is rescued. Noisy exactly once,
never lossy.

### `content.js:pull()`

Between the `pull` op and the `apply-files` call: fetch `list-files`, read
`lastPullShas` from `chrome.storage.local` (the ISOLATED world has direct
access), call `planPull`, and apply `files` instead of `result.files`. The
existing `pullWarning` early return and the reload-on-change behavior are
unchanged.

When `rescued` is non-empty, show a notice before the reload, reusing
`showProtectedNotice`'s styling and dismiss behavior:

> Your changes to `mission2.py` were saved as `mission2_mine.py`.

### Commit-side: stale copies no longer revert a teammate's push

The same missing base causes the mirror bug. Kid A pushes `mission5.py`; kid B
hasn't pulled; kid B hits Commit. B's payload carries their stale copy of
`mission5.py`, `commitOp` overlays it onto the fetched tip, and A's change is
silently reverted. Recoverable from branch history, but silent.

With `lastPullShas` present the guard is one condition in `commitOp`'s payload
loop: **skip any payload file whose sha equals its `lastPullShas` entry.**

`next` starts as a copy of the upstream tree, so skipping means the tree's
version stands. That is correct in all three cases:

- untouched, upstream unchanged → the overlay was a no-op anyway
- untouched, upstream changed → the teammate's change survives
- untouched, upstream deleted → the file stays deleted instead of being re-added

A file with no `base` entry is never untouched, so newly created local files
still commit normally. When `lastPullShas` is absent the guard never fires and
behavior is exactly as today.

No new reporting. Skipping is the *correct* outcome, not a loss, and the kid
learns about the upstream change on their next Pull. Reporting which skipped
files actually differed upstream would mean a `readBlob` per unchanged file on
every commit — a real cost for a message nobody needs.

Bonus: commits stop writing blobs for unchanged files.

## Testing

`test/pullmerge.test.mjs` is the classification table above, one case per row,
plus:

- rename collision bumping (`_mine`, `_mine2`, `_mine3`), against local and
  incoming paths
- empty/missing `base` — everything differing is rescued, nothing is lost
- protected path with a local edit — overwritten, no rescue, not in `rescued`
- a touched file whose contents match the repo's — absent from `rescued`

Pure in, pure out, no browser.

`test/background.test.mjs` gains coverage for the commit guard: an untouched
payload file does not revert an upstream change; a file with no `base` entry
still commits; an absent `lastPullShas` reproduces today's behavior. It also
needs the `lastPullShas` → `lastPullPaths` snapshot fallback asserted.

The browser E2E adds one case alongside `drive-splice.mjs`: create a local file,
edit an existing one, push a divergent change from a second clone, pull, and
assert the new file survived under its own name and the edited one under
`_mine`.

## Rejected

- **A real merge driver** (isomorphic-git's `merge`). Meaningless for block
  files; see Constraints.
- **A per-file conflict dialog** (Keep mine / Take repo's / Keep both). Better
  in principle, but it puts a merge decision in front of a kid mid-pull. The
  automatic bias-to-repo resolution loses nothing, so the dialog buys only
  tidiness.
- **A pre-pull backup under a `pullBackup` key with an Undo button.** Worth
  ~15 lines as a safety net under a design that still overwrites. Under this
  design nothing is ever overwritten without a copy surviving, so there is
  nothing to undo.
- **Storing base contents rather than shas.** Quota risk; shas answer the only
  question asked of the base.
