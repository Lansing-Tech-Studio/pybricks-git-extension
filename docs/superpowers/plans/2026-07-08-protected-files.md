# Protected Upstream Files (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The git engine reads `.pybricks-git.json` from the remote head and refuses to commit team edits to protected files (reporting them as `protectedSkipped`), pull reports the protected set, and the page shows a kid-facing notice when protected edits were skipped.

**Architecture:** All engine work lives in `src/background.js` (classic service-worker script, DI via `makeEngine(deps)` — same file runs under vendored isomorphic-git in Chrome and Node's fs/http in tests). A new internal helper reads the manifest from the already-fetched tree; `pullOp` and `commitOp` gain response fields; `content.js` renders a dismissable notice. Tests run against the hermetic `git http-backend` server in `test/git-http-server.mjs`.

**Tech Stack:** Plain JS (no build step), isomorphic-git, Node built-in test runner (`npm test`), real `git` ≥ 2.28 binary for the test server.

**Branch:** `feat/protected-files` off `main`.

## Global Constraints

- `src/background.js` must stay loadable as a **classic MV3 service worker**: NO ESM `export`/`import` statements, ever. Node tests load it via `test/load-background.mjs` (Function-scope eval).
- Keep the DI pattern: engine code touches git/fs/storage only through the `d` deps object (`d.git`, `d.fs`, `d.gitdir`, `d.storage`, `d.http`, `d.now`).
- Manifest path is exactly `.pybricks-git.json` at the repo root. Parse guard: `schemaVersion === 1` and `protected` is an array; absence, unreadable blob, malformed JSON, wrong schemaVersion, or non-array `protected` ALL mean "no protection" (empty set) — never throw. Non-string entries in the array are ignored.
- New response fields (the contract phases 3–4 code against): `pull` → `protected` (array of paths), `commit` → `protectedSkipped` (array of paths). **Every** return path of `commitOp` must include `protectedSkipped` (empty array when nothing was skipped).
- Protected handling in commit: the tree's version always wins — never write an editor blob to a protected path, never create a protected path that isn't in the tree, never delete a protected path. Report a path in `protectedSkipped` only when the editor's state actually differs from the tree (changed contents, new file, or a deletion of a previously-pulled path).
- Block files are opaque text: comparisons are whole-string equality on decoded contents; never parse or normalize.
- Notice copy pattern (kid-facing, from the spec): "Your changes to menu.py weren't saved — that file is managed by your coach's repo; Pull to restore it."
- Tests: extend the existing style — real engine against `setupEngine(files)` fixtures, one new file `test/background-protected.test.mjs`. `npm test` (all suites) must pass at every commit. Requires the real `git` binary ≥ 2.28 and `npm install` having been run once.
- Code comments follow the existing house style: explain constraints/why, not what.

---

### Task 1: Manifest reader + `pull` returns `protected`

**Files:**
- Modify: `src/background.js` (add helper after `listAllFiles` ~line 99; modify `pullOp` lines 101–126)
- Test: `test/background-protected.test.mjs` (create)

**Interfaces:**
- Consumes: existing `listAllFiles(d, commitOid)` → `Map<path, {oid, mode}>`; `d.git.readBlob({fs, gitdir, oid})` → `{blob}`.
- Produces: `readProtectedPaths(d, fileMap)` → `Promise<Set<string>>` (Task 2 calls this with commit's `existing` map). `pullOp` response gains `protected: string[]` (Task 3's phase-3 successors rely on the name `protected`).

- [ ] **Step 1: Write the failing tests**

Create `test/background-protected.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine } from './engine-helpers.mjs';

const MANIFEST = JSON.stringify({
    schemaVersion: 1,
    protected: ['.pybricks-git.json', 'menu.py', 'main.py'],
});

test('pull returns the manifest protected list and still filters files to .py', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        const result = await engine.pull();
        assert.deepEqual([...result.protected].sort(), ['.pybricks-git.json', 'main.py', 'menu.py']);
        // manifest is not .py, so it is never handed to the editor
        assert.deepEqual(result.files.map((f) => f.path).sort(), ['menu.py', 'team.py']);
    } finally {
        await server.close();
    }
});

test('pull with no manifest returns an empty protected list', async () => {
    const { engine, server } = await setupEngine({ 'main.py': 'x = 1\n' });
    try {
        const result = await engine.pull();
        assert.deepEqual(result.protected, []);
    } finally {
        await server.close();
    }
});

test('pull tolerates a malformed manifest as no protection', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': '{not json',
        'main.py': 'x = 1\n',
    });
    try {
        const result = await engine.pull();
        assert.deepEqual(result.protected, []);
        assert.equal(result.files.length, 1); // pull itself still works
    } finally {
        await server.close();
    }
});

test('pull ignores a manifest with the wrong schemaVersion', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 2, protected: ['menu.py'] }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await engine.pull()).protected, []);
    } finally {
        await server.close();
    }
});

test('pull ignores a manifest whose protected key is not an array, and drops non-string entries', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: 'menu.py' }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await engine.pull()).protected, []);
    } finally {
        await server.close();
    }
});

test('pull from an empty repo returns protected: []', async () => {
    const { engine, server } = await setupEngine();
    try {
        const result = await engine.pull();
        assert.notEqual(result.pullWarning, '');
        assert.deepEqual(result.protected, []);
    } finally {
        await server.close();
    }
});

test('pull drops non-string entries from the protected list', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: ['menu.py', 7, null] }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await engine.pull()).protected, ['menu.py']);
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: the new `background-protected` tests FAIL (`result.protected` is `undefined`); all pre-existing tests still PASS.

- [ ] **Step 3: Implement**

In `src/background.js`, after `listAllFiles` (line 99), add:

```js
// Reads the repo's protection manifest (.pybricks-git.json at the root) out
// of an already-listed tree. Anything short of a well-formed schemaVersion-1
// manifest with an array `protected` means "no protection" — forks that
// predate the manifest (or carry a broken one) must keep working, so this
// never throws.
const MANIFEST_PATH = '.pybricks-git.json';

async function readProtectedPaths(d, fileMap) {
    const entry = fileMap.get(MANIFEST_PATH);
    if (!entry) return new Set();
    try {
        const { blob } = await d.git.readBlob({ fs: d.fs, gitdir: d.gitdir, oid: entry.oid });
        const manifest = JSON.parse(new TextDecoder().decode(blob));
        if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.protected)) {
            return new Set();
        }
        return new Set(manifest.protected.filter((p) => typeof p === 'string'));
    } catch {
        return new Set();
    }
}
```

Modify `pullOp`: declare `let protectedPaths = new Set();` before the `if (head)` block; inside the block (after `const all = await listAllFiles(d, head);`) add `protectedPaths = await readProtectedPaths(d, all);`; add `protected: [...protectedPaths],` to the returned object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: all tests PASS (existing suites included).

- [ ] **Step 5: Commit**

```bash
git add src/background.js test/background-protected.test.mjs
git commit -m "feat: read .pybricks-git.json protection manifest; pull reports protected paths"
```

---

### Task 2: Commit protection — tree version wins, `protectedSkipped` reported

**Files:**
- Modify: `src/background.js` `commitOp` (lines 157–233)
- Test: `test/background-protected.test.mjs` (extend; created in Task 1)

**Interfaces:**
- Consumes: `readProtectedPaths(d, fileMap)` → `Promise<Set<string>>` from Task 1 (call it with the `existing` map).
- Produces: every `commitOp` return object gains `protectedSkipped: string[]`. Task 3's `content.js` reads `result.protectedSkipped`.

- [ ] **Step 1: Write the failing tests**

Append to `test/background-protected.test.mjs` (extend the imports at the top to `import { bareHead, bareFile } from './git-http-server.mjs';`):

```js
test('commit keeps the tree version of an edited protected file and reports it', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 999\n' },
                { path: 'team.py', contents: 'x = 2\n' },
            ],
            message: 'edit both',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.equal(bareFile(bare, 'menu.py'), 'MENU = 1\n'); // coach's version won
        assert.equal(bareFile(bare, 'team.py'), 'x = 2\n');    // team file committed
    } finally {
        await server.close();
    }
});

test('commit with only protected edits is a no-op that still reports protectedSkipped', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const before = bareHead(bare);
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 999\n' },
                { path: 'team.py', contents: 'x = 1\n' },
            ],
            message: 'sneaky menu edit',
        });
        assert.equal(result.committed, false);
        assert.equal(result.message, 'no changes');
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.equal(bareHead(bare), before);
    } finally {
        await server.close();
    }
});

test('an unchanged protected file in the payload is not reported', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 1\n' },
                { path: 'team.py', contents: 'x = 2\n' },
            ],
            message: 'team change only',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, []);
    } finally {
        await server.close();
    }
});

test('deleting a protected file from the editor keeps it upstream and reports it', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull(); // menu.py enters the lastPullPaths snapshot
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'x = 2\n' }], // menu.py gone from editor
            message: 'deleted menu locally',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.equal(bareFile(bare, 'menu.py'), 'MENU = 1\n'); // survived the deletion
    } finally {
        await server.close();
    }
});

test('a protected path that is not upstream is never created', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 999\n' }, // protected, absent upstream
                { path: 'team.py', contents: 'x = 2\n' },
            ],
            message: 'tried to add menu',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.throws(() => bareFile(bare, 'menu.py')); // never created
    } finally {
        await server.close();
    }
});

test('without a manifest, edits to any file commit normally with empty protectedSkipped', async () => {
    const { engine, bare, server } = await setupEngine({ 'menu.py': 'MENU = 1\n' });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [{ path: 'menu.py', contents: 'MENU = 2\n' }],
            message: 'no manifest, no protection',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, []);
        assert.equal(bareFile(bare, 'menu.py'), 'MENU = 2\n');
    } finally {
        await server.close();
    }
});

test('pull after a skipped protected edit hands the editor the tree version back', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
    });
    try {
        await engine.pull();
        await engine.commit({
            files: [{ path: 'menu.py', contents: 'MENU = 999\n' }],
            message: 'sneaky edit',
        });
        const result = await engine.pull(); // pull overwrites the editor — restore is free
        const menu = result.files.find((f) => f.path === 'menu.py');
        assert.equal(menu.contents, 'MENU = 1\n');
    } finally {
        await server.close();
    }
});

test('commit of zero files against an empty repo returns protectedSkipped: []', async () => {
    const { engine, server } = await setupEngine();
    try {
        const result = await engine.commit({ files: [], message: '' });
        assert.equal(result.committed, false);
        assert.deepEqual(result.protectedSkipped, []);
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: new commit-protection tests FAIL (`protectedSkipped` undefined / protected file overwritten); Task 1 tests and all pre-existing tests still PASS.

- [ ] **Step 3: Implement**

In `commitOp`:

1. Early return (line 165–167) gains the field:
```js
return { committed: false, head: '', message: 'no changes', pushed: false, preserved: [], protectedSkipped: [] };
```

2. After `const existing = await listAllFiles(d, head);` add:
```js
const protectedPaths = await readProtectedPaths(d, existing);
```

3. Replace the deletion loop body (lines 171–178) with:
```js
for (const path of existing.keys()) {
    if (!path.endsWith('.py')) continue;
    if (files.some((f) => f.path === path)) continue;
    // Delete only what a previous Pull showed the editor; never-pulled
    // files (fresh fork starter code) are preserved.
    if (snapshot.has(path)) {
        // Deleting a protected file is an edit too — the tree's copy stays.
        if (protectedPaths.has(path)) protectedSkipped.push(path);
        else next.delete(path);
    } else preserved.push(path);
}
```
with `const protectedSkipped = [];` declared next to `const preserved = [];`.

4. In the overlay loop (lines 179–186), before the `writeBlob`, protected paths short-circuit:
```js
for (const f of files) {
    if (protectedPaths.has(f.path)) {
        // The tree's version always wins for protected paths. Report the
        // path only when the editor actually diverged (changed contents, or
        // a file that doesn't exist upstream and must not be created).
        const entry = existing.get(f.path);
        if (!entry) {
            protectedSkipped.push(f.path);
        } else {
            const { blob } = await d.git.readBlob({ fs: d.fs, gitdir: d.gitdir, oid: entry.oid });
            if (new TextDecoder().decode(blob) !== f.contents) protectedSkipped.push(f.path);
        }
        continue;
    }
    const oid = await d.git.writeBlob({
        fs: d.fs,
        gitdir: d.gitdir,
        blob: new TextEncoder().encode(f.contents),
    });
    next.set(f.path, { oid, mode: '100644' });
}
```

5. The `no changes` return (line 192) and the success return (line 223) each gain `protectedSkipped`:
```js
return { committed: false, head: head.slice(0, 7), message: 'no changes', pushed: false, preserved, protectedSkipped };
```
```js
return { committed: true, head: commitOid.slice(0, 7), message, pushed: true, preserved, protectedSkipped };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background.js test/background-protected.test.mjs
git commit -m "feat: commit keeps tree version of protected files and reports protectedSkipped"
```

---

### Task 3: `content.js` protected-files notice + CLAUDE.md contract update

**Files:**
- Modify: `src/content.js` (commit flow, lines 118–150; new notice function)
- Modify: `CLAUDE.md` (ops table; git-engine section; planned-work section)

**Interfaces:**
- Consumes: `commit` response field `protectedSkipped: string[]` from Task 2.
- Produces: user-visible notice element flagged `data-pybricks-git-notice` (phase-3 UI work may reuse the attribute).

There is no automated harness for `content.js` (it's exercised via the manual browser E2E recipe), so this task is code + docs with careful self-review; `npm test` still must pass (guards against accidental engine/test breakage).

- [ ] **Step 1: Implement the notice**

In `src/content.js`, inside `commit()` after the `preserved` warning block (line 139), add:

```js
if (result.protectedSkipped && result.protectedSkipped.length) {
    showProtectedNotice(result.protectedSkipped);
}
```

Add below the `commit` function:

```js
// Kid-facing warning for commits that tried to change coach-managed files.
// The engine kept the repo's version; the editor still shows the local edit
// until the next Pull. Click or the timeout dismisses it.
function showProtectedNotice(paths) {
    document.querySelector('[data-pybricks-git-notice]')?.remove();
    const one = paths.length === 1;
    const box = document.createElement('div');
    box.dataset.pybricksGitNotice = '1';
    box.textContent =
        `Your changes to ${paths.join(', ')} weren't saved — ` +
        `${one ? 'that file is' : 'those files are'} managed by your coach's repo; ` +
        `Pull to restore ${one ? 'it' : 'them'}.`;
    box.title = 'Click to dismiss';
    Object.assign(box.style, {
        position: 'fixed',
        top: '48px',
        right: '12px',
        maxWidth: '360px',
        padding: '10px 14px',
        background: '#5c3c00',
        color: '#ffe2a8',
        border: '1px solid #a97800',
        borderRadius: '4px',
        font: 'inherit',
        fontSize: '13px',
        zIndex: 10000,
        cursor: 'pointer',
    });
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 15000);
}
```

- [ ] **Step 2: Update CLAUDE.md**

In the message-ops table: `commit` success response becomes `{committed, head, message, pushed, preserved, protectedSkipped}`; `pull` becomes `{head, files, pullWarning, protected}`.

In "The git engine" section, extend the **Pull** bullet with: reads the `.pybricks-git.json` manifest from the fetched tree (schemaVersion-1 guard; absent/malformed → no protection) and returns the `protected` path list. Extend the **Commit** bullet with: protected paths always keep the tree's version (edits, new files, and deletions are all skipped) and are reported in `protectedSkipped` when the editor diverged; `content.js` shows a dismissable notice for them.

In "Planned work: team-features roadmap": mark Phase 2 done (move it out of "Remaining phases", e.g. "Phase 2 (protected files) is done — engine + notice shipped; see the ops table").

- [ ] **Step 3: Run the full suite**

Run: `npm test 2>&1 | tail -5`
Expected: all tests PASS (nothing in this task should move them).

- [ ] **Step 4: Commit**

```bash
git add src/content.js CLAUDE.md
git commit -m "feat: show protected-files notice after commit; document phase-2 contract"
```
