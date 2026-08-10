# Merge on Pull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Pull from destroying uncommitted local work — rescue edited files under a `_mine` name, keep never-committed local files, and stop a stale Commit from reverting a teammate's push.

**Architecture:** A new pure module `src/pullmerge.js` decides the complete post-pull file set from four inputs (editor files, repo files, a per-file base sha map, protected paths). `src/content.js` calls it between the `pull` op and the `apply-files` op. The engine gains one storage key, `lastPullShas` (`{path: sha256}`), which replaces `lastPullPaths` and doubles as the guard that keeps `commitOp` from overlaying files the kid never touched.

**Tech Stack:** Plain ES2022, no build step. Chrome MV3 classic content scripts. Node 22 built-in test runner (`node:test` + `node:assert/strict`). Vendored isomorphic-git in the service worker; real isomorphic-git + a local `git http-backend` server in tests.

**Design spec:** `docs/superpowers/specs/2026-08-09-pull-merge-design.md` — read it first.

## Global Constraints

- **No ESM `export`s in `src/*.js`.** They are classic scripts (content scripts and a service worker); an `export` breaks them at load. Tests load them through `test/load-*.mjs` shims that read the file verbatim and append a publishing line.
- **`manifest.json` `content_scripts` order is load order.** The ISOLATED-world files share one global scope. A helper must be listed before its caller.
- **No build step.** Do not add a bundler, a dependency, or a transpiler.
- **`npm test` requires a real `git` binary ≥ 2.28** and the `unzip` binary.
- **Never add Claude/Anthropic attribution** to any commit message — no `Co-Authored-By`, no "Generated with" line.
- **Block files are opaque outside `src/blocksplice.js`.** Nothing in this plan parses or regenerates the line-1 JSON; contents strings round-trip byte-for-byte.
- **sha256 means hex-encoded SHA-256 of the contents string** — the exact value Pybricks stores on each `metadata` row and that `src/inject.js:sha256()` computes.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/pullmerge.js` | create | Pure. `rescueName()` + `planPull()`. No DOM, no `chrome.*`. |
| `test/load-pullmerge.mjs` | create | Node shim publishing both functions. |
| `test/pullmerge.test.mjs` | create | The classification table, one test per row. |
| `manifest.json` | modify | Add `src/pullmerge.js` before `src/content.js`. |
| `src/background.js` | modify | `pullOp` writes `lastPullShas`; `commitOp` reads it for the snapshot and for the untouched-skip guard. |
| `test/background-pull.test.mjs` | modify | Assert `lastPullShas` instead of `lastPullPaths`. |
| `test/background-commit.test.mjs` | modify | Snapshot fallback + untouched-skip coverage. |
| `src/content.js` | modify | Wire `planPull` into `pull()`; persist and render the rescue notice. |
| `test/e2e/drive.mjs` | modify | One browser-side scenario proving the round-trip. |
| `CLAUDE.md` | modify | Document `lastPullShas` / `pullRescued`, and the new pull behavior. |

---

### Task 1: `rescueName` — the collision-safe rename

**Files:**
- Create: `src/pullmerge.js`
- Create: `test/load-pullmerge.mjs`
- Create: `test/pullmerge.test.mjs`
- Modify: `manifest.json:25`

**Interfaces:**
- Consumes: nothing.
- Produces: `rescueName(path: string, taken: Set<string>) → string` — the name a rescued local copy takes.

- [ ] **Step 1: Write the failing test**

Create `test/load-pullmerge.mjs`:

```js
// Test harness: loads src/pullmerge.js (a classic content script with no module
// exports) into Node and hands back its functions. Same pattern as
// load-menu-config.mjs: read verbatim, append a publishing line, run in one
// Function scope so the shipped file stays untouched.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'pullmerge.js');

export function loadPullMerge() {
    const src =
        readFileSync(srcPath, 'utf8') +
        '\n;globalThis.__pybricksPullMergeTest = { rescueName, planPull };';
    // eslint-disable-next-line no-new-func
    new Function(src)();
    return globalThis.__pybricksPullMergeTest;
}
```

Create `test/pullmerge.test.mjs`:

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPullMerge } from './load-pullmerge.mjs';

const { rescueName, planPull } = loadPullMerge();

describe('rescueName', () => {
    test('inserts _mine before the extension', () => {
        assert.equal(rescueName('mission2.py', new Set()), 'mission2_mine.py');
    });

    test('keeps the directory prefix', () => {
        assert.equal(rescueName('lib/util.py', new Set()), 'lib/util_mine.py');
    });

    test('bumps past names already taken', () => {
        const taken = new Set(['m_mine.py', 'm_mine2.py']);
        assert.equal(rescueName('m.py', taken), 'm_mine3.py');
    });

    test('handles a path with no extension', () => {
        assert.equal(rescueName('notes', new Set()), 'notes_mine');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pullmerge.test.mjs`
Expected: FAIL — `ENOENT` for `src/pullmerge.js` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/pullmerge.js`:

```js
// ISOLATED-world pure helpers: decide what the editor should hold after a Pull
// instead of letting the repo's file set clobber it. No DOM, no chrome APIs —
// loaded before content.js (its only caller) and unit-tested through
// test/load-pullmerge.mjs. Design: docs/superpowers/specs/2026-08-09-pull-merge-design.md

// A rescued copy has to stay a valid Python module name or the hub can't import
// it and analyzeProgram() rules it out of the menu — hence `_mine`, never
// "(mine)". `taken` must hold every name already spoken for (local, incoming,
// and rescues issued so far).
function rescueName(path, taken) {
    const dot = path.lastIndexOf('.');
    const stem = dot === -1 ? path : path.slice(0, dot);
    const ext = dot === -1 ? '' : path.slice(dot);
    for (let n = 1; ; n++) {
        const candidate = `${stem}_mine${n === 1 ? '' : n}${ext}`;
        if (!taken.has(candidate)) return candidate;
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pullmerge.test.mjs`
Expected: the four `rescueName` tests PASS. (`planPull` is still undefined, so the shim's publishing line will throw — add a temporary `function planPull() {}` stub below `rescueName` to get a green run, and replace it in Task 2.)

- [ ] **Step 5: Register the file in the manifest**

In `manifest.json`, the ISOLATED entry's `js` array currently reads:

```json
"js": ["src/menu-config.js", "src/blocksplice.js", "src/menu-panel.js", "src/file-list.js", "src/content.js"],
```

Change it to:

```json
"js": ["src/menu-config.js", "src/blocksplice.js", "src/pullmerge.js", "src/menu-panel.js", "src/file-list.js", "src/content.js"],
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `test/pack.test.mjs` derives its expected zip contents from the repo, so the new `src/` file needs no change there.

- [ ] **Step 7: Commit**

```bash
git add src/pullmerge.js test/load-pullmerge.mjs test/pullmerge.test.mjs manifest.json
git commit -m "feat: add pullmerge rescueName helper"
```

---

### Task 2: `planPull` — the classification

**Files:**
- Modify: `src/pullmerge.js`
- Modify: `test/pullmerge.test.mjs`

**Interfaces:**
- Consumes: `rescueName(path, taken)` from Task 1.
- Produces:
  `planPull({local, repo, base, protectedPaths}) → {files, rescued}` where
  `local` is `[{path, contents, sha}]` (`sha` may be `undefined`),
  `repo` is `[{path, contents}]`,
  `base` is `{[path]: sha}` (default `{}`),
  `protectedPaths` is `string[]` (default `[]`),
  `files` is `[{path, contents}]` — the COMPLETE desired set for `apply-files`,
  `rescued` is `[{path, savedAs}]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pullmerge.test.mjs`:

```js
// Shorthand builders. `sha` values here are opaque tokens, not real hashes —
// planPull only ever compares them for equality against `base`.
const L = (path, contents, sha) => ({ path, contents, sha });
const R = (path, contents) => ({ path, contents });
const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f.contents]));

describe('planPull', () => {
    test('untouched file: the repo version wins silently', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'old\n', 'sha-old')],
            repo: [R('a.py', 'new\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'new\n' });
        assert.deepEqual(rescued, []);
    });

    test('untouched file the repo deleted: it goes away', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'old\n', 'sha-old')],
            repo: [],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(files, []);
        assert.deepEqual(rescued, []);
    });

    test('edited file the repo also has: repo keeps the name, local is rescued', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', 'sha-mine')],
            repo: [R('a.py', 'theirs\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'theirs\n', 'a_mine.py': 'mine\n' });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine.py' }]);
    });

    test('edited file the repo deleted: the edit survives under _mine', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', 'sha-mine')],
            repo: [],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a_mine.py': 'mine\n' });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine.py' }]);
    });

    test('edited into agreement with the repo: no duplicate', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'same\n', 'sha-mine')],
            repo: [R('a.py', 'same\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'same\n' });
        assert.deepEqual(rescued, []);
    });

    // The reported data loss: a program created in the editor and never
    // committed used to be deleted by apply-files' delete pass.
    test('never-committed local file survives under its own name', () => {
        const { files, rescued } = planPull({
            local: [L('scratch.py', 'wip\n', 'sha-wip')],
            repo: [R('a.py', 'theirs\n')],
            base: { 'a.py': 'sha-a' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'theirs\n', 'scratch.py': 'wip\n' });
        assert.deepEqual(rescued, []);
    });

    test('locally created name the repo independently also has: contested', () => {
        const { files, rescued } = planPull({
            local: [L('m7.py', 'mine\n', 'sha-mine')],
            repo: [R('m7.py', 'theirs\n')],
            base: {},
        });
        assert.deepEqual(byPath(files), { 'm7.py': 'theirs\n', 'm7_mine.py': 'mine\n' });
        assert.deepEqual(rescued, [{ path: 'm7.py', savedAs: 'm7_mine.py' }]);
    });

    test('protected file with a local edit: overwritten, no rescue copy', () => {
        const { files, rescued } = planPull({
            local: [L('menu_config.py', 'mine\n', 'sha-mine')],
            repo: [R('menu_config.py', 'coach\n')],
            base: { 'menu_config.py': 'sha-old' },
            protectedPaths: ['menu_config.py'],
        });
        assert.deepEqual(byPath(files), { 'menu_config.py': 'coach\n' });
        assert.deepEqual(rescued, []);
    });

    test('rescue name avoids a name the repo is bringing in', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', 'sha-mine')],
            repo: [R('a.py', 'theirs\n'), R('a_mine.py', 'coach copy\n')],
            base: { 'a.py': 'sha-old', 'a_mine.py': 'sha-c' },
        });
        assert.deepEqual(byPath(files), {
            'a.py': 'theirs\n',
            'a_mine.py': 'coach copy\n',
            'a_mine2.py': 'mine\n',
        });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine2.py' }]);
    });

    // First pull after upgrading, or cleared storage: nothing is provably
    // untouched, so anything that actually differs is rescued. Noisy once,
    // never lossy.
    test('missing base: differing files are rescued, matching ones are not', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', undefined), L('b.py', 'same\n', undefined)],
            repo: [R('a.py', 'theirs\n'), R('b.py', 'same\n')],
            base: {},
        });
        assert.deepEqual(byPath(files), {
            'a.py': 'theirs\n',
            'b.py': 'same\n',
            'a_mine.py': 'mine\n',
        });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine.py' }]);
    });

    test('a local file with no metadata sha counts as edited, never lost', () => {
        const { files } = planPull({
            local: [L('a.py', 'mine\n', undefined)],
            repo: [R('a.py', 'theirs\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'theirs\n', 'a_mine.py': 'mine\n' });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pullmerge.test.mjs`
Expected: the `planPull` tests FAIL (the Task 1 stub returns `undefined`, so destructuring `{files, rescued}` throws).

- [ ] **Step 3: Write the implementation**

Replace the `planPull` stub in `src/pullmerge.js` with:

```js
// Decides what the editor should hold after a Pull. `files` is the COMPLETE
// desired set for the `apply-files` op — that op deletes every path it isn't
// given, so anything omitted here is destroyed.
//
//   local          [{path, contents, sha}]  the editor now; `sha` is the
//                                           metadata row's sha256, and a
//                                           missing one counts as edited —
//                                           the safe direction, a spurious
//                                           rescue rather than a silent loss
//   repo           [{path, contents}]       what the Pull fetched
//   base           {path: sha}              lastPullShas: the last state the
//                                           editor and the repo agreed on
//   protectedPaths [path]                   coach-managed; the repo always
//                                           wins and no copy is kept
function planPull({ local, repo, base = {}, protectedPaths = [] }) {
    const prot = new Set(protectedPaths);
    const baseSha = new Map(Object.entries(base));
    const repoContents = new Map(repo.map((f) => [f.path, f.contents]));
    const files = repo.map((f) => ({ path: f.path, contents: f.contents }));
    const taken = new Set([...repoContents.keys(), ...local.map((f) => f.path)]);
    const rescued = [];

    for (const f of local) {
        // Provably untouched since the last Pull: whatever the repo says goes,
        // including a deletion. `files` already carries the repo's version.
        if (baseSha.has(f.path) && baseSha.get(f.path) === f.sha) continue;

        const upstream = repoContents.get(f.path);
        if (upstream === undefined && !baseSha.has(f.path)) {
            // Created in the editor, never committed, and nobody else claims
            // the name — uncontested, so it keeps it. This is checked BEFORE
            // the protected rule: a manifest can reserve a path the repo does
            // not actually have, and "the repo wins" with no repo version to
            // win with would just delete the file the kid made.
            files.push({ path: f.path, contents: f.contents });
            continue;
        }
        // Coach-managed: the repo wins and a _mine copy would be clutter the
        // kid can't use, since commitOp refuses to push protected paths anyway.
        if (prot.has(f.path)) continue;
        if (upstream === f.contents) continue; // edited into agreement

        const savedAs = rescueName(f.path, taken);
        taken.add(savedAs);
        files.push({ path: savedAs, contents: f.contents });
        rescued.push({ path: f.path, savedAs });
    }
    return { files, rescued };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pullmerge.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pullmerge.js test/pullmerge.test.mjs
git commit -m "feat: planPull decides the post-pull file set instead of clobbering"
```

---

### Task 3: `lastPullShas` replaces `lastPullPaths`

**Files:**
- Modify: `src/background.js:154-162` (the `pullOp` storage write), `src/background.js:205` (the `commitOp` snapshot)
- Modify: `test/background-pull.test.mjs`
- Modify: `test/background-commit.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: storage key `lastPullShas` — `{[path]: sha256hex}` over the `.py` files the Pull returned. Written only when the fetch found a head, alongside `lastPullManifest`. Task 4 and Task 5 both read it.

- [ ] **Step 1: Write the failing tests**

In `test/background-pull.test.mjs`, the test `'pull returns .py files (block files byte-exact), skips non-.py, records snapshot'` currently asserts:

```js
        assert.deepEqual((await storage.get('lastPullPaths')).sort(), ['lib/util.py', 'prog.py']);
```

Replace that line with:

```js
        const shas = await storage.get('lastPullShas');
        assert.deepEqual(Object.keys(shas).sort(), ['lib/util.py', 'prog.py']);
        // Hex sha256 of the exact contents string — the same value Pybricks
        // stores on each metadata row, so the two sides compare directly.
        assert.match(shas['prog.py'], /^[0-9a-f]{64}$/);
        assert.equal(
            shas['prog.py'],
            createHash('sha256').update(BLOCK, 'utf8').digest('hex'),
        );
```

and add to that file's imports:

```js
import { createHash } from 'node:crypto';
```

In `test/background-commit.test.mjs`, add:

```js
test('commit falls back to lastPullPaths when lastPullShas is absent', async () => {
    const { engine, bare, storage, server } = await setupEngine({ 'starter.py': 'shared = True\n' });
    try {
        // An install that pulled before the upgrade: only the old key exists.
        await storage.set({ lastPullPaths: ['starter.py'] });
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'ours = 1\n' }],
            message: 'old snapshot',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.preserved, []);
        // bareFile shells out to `git show` and THROWS for a missing path — it
        // does not return null. This is how the existing tests assert absence.
        assert.throws(() => bareFile(bare, 'starter.py'));
    } finally {
        await server.close();
    }
});
```

`test/background-commit.test.mjs` already imports `bareFile` from `./git-http-server.mjs`, so no import change is needed for this task.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/background-pull.test.mjs test/background-commit.test.mjs`
Expected: FAIL — `lastPullShas` is `undefined`, so `Object.keys(undefined)` throws.

- [ ] **Step 3: Write the implementation**

In `src/background.js`, add this helper next to the other module-level helpers (above `pullOp`):

```js
// Hex sha256 of a contents string — byte-identical to what Pybricks stores on
// each metadata row and what inject.js:sha256() computes, so the engine's shas
// and the editor's compare directly with no conversion.
async function sha256Hex(text) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
```

In `pullOp`, replace the `lastPullPaths` line inside the `if (head)` storage write:

```js
            lastPullPaths: files.map((f) => f.path),
```

with:

```js
            lastPullShas: Object.fromEntries(
                await Promise.all(files.map(async (f) => [f.path, await sha256Hex(f.contents)])),
            ),
```

Update that block's leading comment so it names `lastPullShas` instead of `lastPullPaths`; the reasoning about the `if (head)` guard is unchanged.

In `commitOp`, replace:

```js
    const snapshot = new Set((await d.storage.get('lastPullPaths')) ?? []);
```

with:

```js
    // lastPullShas replaced lastPullPaths; fall back for installs that haven't
    // pulled since the upgrade, so their tracked-file set survives.
    const pullShas = await d.storage.get('lastPullShas');
    const snapshot = new Set(
        pullShas ? Object.keys(pullShas) : ((await d.storage.get('lastPullPaths')) ?? []),
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/background-pull.test.mjs test/background-commit.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. If another test asserted on `lastPullPaths`, update it the same way — grep first: `grep -rn lastPullPaths test/ src/`.

- [ ] **Step 6: Commit**

```bash
git add src/background.js test/background-pull.test.mjs test/background-commit.test.mjs
git commit -m "feat: pull records per-file shas as lastPullShas"
```

---

### Task 4: Commit stops reverting a teammate's push

**Files:**
- Modify: `src/background.js` — the payload loop in `commitOp` (starts at `for (const f of files) {`, currently line 228)
- Modify: `test/git-http-server.mjs:78-82` — let `pushCompeting` express a deletion
- Modify: `test/background-commit.test.mjs`

**Interfaces:**
- Consumes: `pullShas` and `sha256Hex` from Task 3.
- Produces: `pushCompeting(bare, files, message)` gains one behavior — a `null` value in `files` deletes that path instead of writing it. No other helper changes.

- [ ] **Step 1: Teach `pushCompeting` to delete**

`pushCompeting(bare, files, message)` clones the bare repo, writes every entry of `files`, then `git add -A` and pushes — so it can only create or modify. The third test below needs a teammate deletion. In `test/git-http-server.mjs`, replace the write loop:

```js
    for (const [rel, contents] of Object.entries(files)) {
        const full = join(w, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
    }
```

with:

```js
    for (const [rel, contents] of Object.entries(files)) {
        const full = join(w, rel);
        // null means "the teammate deleted this path" — `git add -A` below
        // stages the removal.
        if (contents === null) {
            rmSync(full, { force: true });
            continue;
        }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
    }
```

and add `rmSync` to that file's existing `node:fs` import.

- [ ] **Step 2: Write the failing tests**

Add to `test/background-commit.test.mjs`, and add `pushCompeting` to its existing import from `./git-http-server.mjs` (`bareHead`, `bareFile`, `bareSubjects` are already there).

```js
test('a stale untouched file does not revert a teammate\'s push', async () => {
    const { engine, bare, server } = await setupEngine({
        'shared.py': 'v1\n',
        'mine.py': 'a = 1\n',
    });
    try {
        // Pull records shas for v1 of both files.
        await engine.pull();
        // A teammate pushes a newer shared.py while our editor still holds v1.
        pushCompeting(bare, { 'shared.py': 'v2\n' }, 'teammate edit');
        // We commit our own edit; our payload still carries the stale shared.py.
        const result = await engine.commit({
            files: [
                { path: 'shared.py', contents: 'v1\n' },
                { path: 'mine.py', contents: 'a = 2\n' },
            ],
            message: 'my edit',
        });
        assert.equal(result.committed, true);
        assert.equal(bareFile(bare, 'shared.py'), 'v2\n'); // theirs survived
        assert.equal(bareFile(bare, 'mine.py'), 'a = 2\n'); // ours landed
    } finally {
        await server.close();
    }
});

test('an edited file still overwrites the tree version', async () => {
    const { engine, bare, server } = await setupEngine({ 'shared.py': 'v1\n' });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [{ path: 'shared.py', contents: 'v1 edited\n' }],
            message: 'genuine edit',
        });
        assert.equal(result.committed, true);
        assert.equal(bareFile(bare, 'shared.py'), 'v1 edited\n');
    } finally {
        await server.close();
    }
});

test('an untouched file whose upstream copy was deleted stays deleted', async () => {
    const { engine, bare, server } = await setupEngine({
        'gone.py': 'v1\n',
        'mine.py': 'a = 1\n',
    });
    try {
        await engine.pull();
        pushCompeting(bare, { 'gone.py': null }, 'teammate deleted it');
        const result = await engine.commit({
            files: [
                { path: 'gone.py', contents: 'v1\n' },
                { path: 'mine.py', contents: 'a = 2\n' },
            ],
            message: 'my edit',
        });
        assert.equal(result.committed, true);
        assert.throws(() => bareFile(bare, 'gone.py'));
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/background-commit.test.mjs`
Expected: the first test FAILS with `shared.py` equal to `'v1\n'` — the stale copy overwrote the teammate's push. The second should already pass.

- [ ] **Step 4: Write the implementation**

In `commitOp`'s payload loop, insert this as the **first** statement inside `for (const f of files) {`, before the `if (protectedPaths.has(f.path))` block:

```js
        // Untouched since the last Pull: leave the tree's version alone. `next`
        // starts as a copy of the fetched tree, so skipping preserves a
        // teammate's newer push — and their deletion — instead of reverting it
        // with our stale copy. A path with no lastPullShas entry is never
        // "untouched", so newly created files still commit normally, and an
        // absent lastPullShas disables the guard entirely (pre-upgrade installs
        // keep today's behavior). It goes ahead of the protected check so an
        // upstream change to a protected file the kid never edited doesn't
        // raise a false "your version wasn't committed" notice.
        if (pullShas && pullShas[f.path] && pullShas[f.path] === (await sha256Hex(f.contents))) {
            continue;
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/background-commit.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `test/background-guard.test.mjs` also uses `pushCompeting`, so confirm it still passes after the helper change. Watch `test/background-protected.test.mjs` in particular — a protected-file test that pulls first and then commits an unmodified payload will now skip before reaching the protected branch and will no longer report the path in `protectedSkipped`. That is the intended behavior (the editor did not diverge), so update any such assertion rather than weakening the guard.

- [ ] **Step 7: Commit**

```bash
git add src/background.js test/git-http-server.mjs test/background-commit.test.mjs
git commit -m "fix: commit no longer reverts upstream changes with stale untouched files"
```

---

### Task 5: Wire the merge into Pull

**Files:**
- Modify: `src/content.js` — `pull()` at line 229, plus a new notice function and a startup call

**Interfaces:**
- Consumes: `planPull({local, repo, base, protectedPaths}) → {files, rescued}` (Task 2); the `lastPullShas` storage key (Task 3).
- Produces: storage key `pullRescued` — `[{path, savedAs}]` or absent, written just before the post-pull reload and cleared once rendered.

- [ ] **Step 1: Lift the storage helpers to module scope**

`makeMenuPanel` and `makeFileListWatcher` are each handed their own inline copy of these (lines 32-34 and 40-41). Lift them to module scope above the `makeMenuPanel` call so `pull()` can use them too, and pass the named functions into both constructors instead of the inline arrows:

```js
const storageGet = (key) =>
    new Promise((resolve) => chrome.storage.local.get(key, (v) => resolve(v[key])));
const storageSet = (obj) =>
    new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
```

- [ ] **Step 2: Replace the body of `pull()`**

In `src/content.js`, `pull()` currently does this after the `pullWarning` early return:

```js
        console.log(`[pybricks-git] received ${result.files.length} file(s)`);

        const summary = await pageRequest('apply-files', { files: result.files });
```

Replace those two statements with:

```js
        console.log(`[pybricks-git] received ${result.files.length} file(s)`);

        // Never hand apply-files the repo's set directly — it deletes every
        // path it isn't given, which is how uncommitted local work used to
        // disappear. planPull returns the full desired set: the repo's files,
        // plus rescued copies of anything edited locally, plus never-committed
        // local files left alone.
        const editor = await pageRequest('list-files');
        // NOTE (corrected during execution): the `base` read below MUST happen
        // BEFORE `serverRequest('pull')`. `pullOp` writes `lastPullShas` inside
        // the op, so reading it afterwards hands planPull the shas of the file
        // set the repo just delivered — making every untouched file look edited.
        const shaByPath = new Map(editor.metadata.map((m) => [m.path, m.sha256]));
        const plan = planPull({
            local: editor.contents.map((c) => ({
                path: c.path,
                contents: c.contents,
                sha: shaByPath.get(c.path),
            })),
            repo: result.files,
            base: (await storageGet('lastPullShas')) ?? {},
            protectedPaths: result.protected ?? [],
        });
        if (plan.rescued.length) {
            console.warn('[pybricks-git] rescued local edits:', plan.rescued);
            // The reload below wipes any notice we show now, so hand it to the
            // next page load — same trick as the menu panel's spliceReport.
            await storageSet({ pullRescued: plan.rescued });
        }

        const summary = await pageRequest('apply-files', { files: plan.files });
```

- [ ] **Step 3: Add the rescue notice**

Add below `showProtectedNotice`, which it deliberately mirrors:

```js
// Kid-facing report of what Pull rescued. Rendered on the page load *after*
// the pull's reload, because that's when the rescued files are actually
// visible in the file list. Click, Escape, or the timeout dismisses it.
async function showRescueNotice() {
    const rescued = await storageGet('pullRescued');
    if (!rescued || !rescued.length) return;
    await storageSet({ pullRescued: [] });

    const box = document.createElement('div');
    box.dataset.pybricksGitRescue = '1';
    box.setAttribute('role', 'status');
    box.tabIndex = 0;
    box.textContent =
        `The repo had its own version of ${rescued.length === 1 ? 'this file' : 'these files'}, ` +
        `so your changes were saved alongside it: ` +
        rescued.map((r) => `${r.path} → ${r.savedAs}`).join(', ');
    box.title = 'Click or press Escape to dismiss';
    box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') box.remove();
    });
    Object.assign(box.style, {
        position: 'fixed',
        top: '48px',
        right: '12px',
        maxWidth: '360px',
        padding: '10px 14px',
        background: '#0d3b2e',
        color: '#a8f0d4',
        border: '1px solid #1c7a5c',
        borderRadius: '4px',
        font: 'inherit',
        fontSize: '13px',
        zIndex: 10000,
        cursor: 'pointer',
    });
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 20000);
}
```

- [ ] **Step 4: Call it at startup**

Next to the existing startup calls (`fileListWatcher.start()` at line 48, `mountButton()` at line 50), add:

```js
showRescueNotice().catch((err) => console.warn('[pybricks-git] rescue notice failed:', err));
```

- [ ] **Step 5: Verify by hand in Chrome**

This file has no Node loader — it is DOM-heavy and covered only through the browser path, so verify manually before committing:

1. `chrome://extensions` → reload the unpacked extension → refresh `code.pybricks.com`.
2. Pull once so `lastPullShas` is populated.
3. In the editor, create a new file `scratch.py` and edit one file that came from the repo.
4. Push a different change to that same repo file from a terminal.
5. Click Pull.

Expected: the page reloads; `scratch.py` is still there under its own name; the repo's version of the edited file is at its own path; your version is at `<name>_mine.py`; the green notice names the rescue.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS (nothing here is Node-testable, but the suite must stay green).

- [ ] **Step 7: Commit**

```bash
git add src/content.js
git commit -m "feat: pull merges into the editor instead of clobbering it"
```

---

### Task 6: Browser end-to-end coverage

**Files:**
- Modify: `test/e2e/drive.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing consumed by later tasks.

`test/e2e/drive.mjs` is a manually-run driver (`node test/e2e/drive.mjs`), not part of `npm test`. It already runs: step 1 start git harness + launch Chromium, step 2 configure settings, step 3 Pull, step 4 seed a second file and Commit, step 5 harness-side assertions, step 6 zero-exceptions, step 7 screenshot. Read the whole file before editing — the CDP client, the real-click helper, the IndexedDB eval helper, and the reload-wait helper all already exist there and must be reused rather than rewritten.

- [ ] **Step 1: Add a merge-on-pull step**

Insert a new step between the existing step 5 (harness-side assertions) and step 6 (zero exceptions), renumbering the later steps. It must:

1. Write two files straight into the page's IndexedDB using the same eval helper the existing steps use: `scratch.py` (contents `wip = 1\n`, a path the repo has never had) and an edit to the file the first Pull brought in (append `# edited locally\n` to its contents). Do **not** go through `apply-files` — the point is to simulate the kid's own editing.
2. Push a competing change to that same repo file directly into the bare repo, using `pushCompeting` from `../git-http-server.mjs` (already imported by `test/background-guard.test.mjs`; add the import here).
3. Real-click Pull and wait for the reload, the same way step 3 does.

- [ ] **Step 2: Assert the outcome**

After the reload settles, read the editor's IndexedDB and assert:

- `scratch.py` still exists with contents `wip = 1\n` — **this is the regression the whole change exists to prevent.**
- The repo file holds the competing version pushed in step 1.2.
- A `<stem>_mine.py` sibling exists holding the locally edited contents.
- `document.querySelector('[data-pybricks-git-rescue]')` is present and its `textContent` names both the original path and the `_mine` path.

- [ ] **Step 3: Run the driver**

Run: `node test/e2e/drive.mjs`
Expected: exit 0, `PASS` printed, `toolbar.png` written. On failure the script writes a failure screenshot — read it and the printed reason before changing anything.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/drive.mjs
git commit -m "test: e2e coverage for merge-on-pull"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the finished behavior from Tasks 1-6.
- Produces: nothing.

- [ ] **Step 1: Update the storage key list**

In the "Settings" section's bullet list of `chrome.storage.local` keys, replace the `lastPullPaths` bullet with:

```markdown
- `lastPullShas` — `{path: sha256}` over the `.py` files the last non-empty Pull returned: the base state the editor and the repo last agreed on. Replaces the old `lastPullPaths` (whose keys it subsumes; `commitOp` still falls back to that key for installs that haven't pulled since the upgrade). Read by `planPull` to tell a locally edited file from an upstream-changed one, and by `commitOp` to skip payload files the editor never touched.
- `pullRescued` — `[{path, savedAs}]`, written by a Pull that rescued local edits and rendered as a notice on the next page load, then cleared.
```

- [ ] **Step 2: Update the git engine section**

In "The git engine", the **Pull** bullet says it records `lastPullPaths`; change that to `lastPullShas` and note it is a path→sha map. In the **Commit** bullet, add after the existing sentence about the snapshot:

```markdown
  A payload file whose sha matches its `lastPullShas` entry is skipped entirely — the fetched tree's version stands — so a stale editor copy can't revert a teammate's push or resurrect a file they deleted. Files with no snapshot entry (newly created) commit normally, and an absent `lastPullShas` disables the guard.
```

- [ ] **Step 3: Document the merge**

Add a subsection under "Architecture" (after the ISOLATED-world script list, which must also gain `pullmerge.js` in its load order) :

```markdown
**Pull merges, it does not clobber.** `content.js:pull()` never hands the repo's file set straight to `apply-files` — that op deletes every path it isn't given, which used to destroy uncommitted local work. `src/pullmerge.js:planPull()` (pure, no DOM, unit-tested via `test/load-pullmerge.mjs`) computes the complete desired set from the editor's files, the repo's files, the `lastPullShas` base, and the protected list. Files untouched since the last Pull take the repo's version; locally edited files let the repo keep the canonical path and are rescued to `<stem>_mine.py` (a valid module name, so the hub can still import it); files created locally and never committed keep their own name; protected paths **that the repo actually has** are overwritten with no rescue copy. Protection is checked after the never-committed rule on purpose — a manifest can reserve a path the repo doesn't have (the starter reserves `robot_setup.py`, never authored), and with no repo version to restore, "the repo wins" would just delete the file the kid made. Rescues are reported through the `pullRescued` key as a notice on the next load. Design: `docs/superpowers/specs/2026-08-09-pull-merge-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe merge-on-pull and the lastPullShas key"
```
