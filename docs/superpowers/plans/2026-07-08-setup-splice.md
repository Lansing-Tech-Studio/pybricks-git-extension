# Phase 4 — New-Program-from-Template + Setup Splice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kids create new block programs pre-seeded with their team's robot setup, and coaches propagate setup changes (ports, wheel sizes, new sensors) into every block program with one click — safely, with a snapshot commit first and skip-and-report on anything uncertain.

**Architecture:** A new pure-function classic script `src/blocksplice.js` parses a block file's line-1 workspace JSON, locates the `blockGlobalSetup` chain, and splices in the team-setup file's chain — remapping Blockly variable IDs by variable *name+type* — then rewrites the generated-Python `# Set up all devices.` section and merges imports. The panel (`src/menu-panel.js`) gains a New-program button (seed a fresh file from the team's `robot_setup.py`), a per-program "setup differs" nudge, and an Update-robot-setup button that snapshot-commits before splicing. The engine starts persisting the manifest's `setupTemplate`/`teamSetup` names. Everything is gated by a discovery task that harvests real editor-authored fixtures and pins the editor's regeneration behavior.

**Tech Stack:** Plain JS Chrome MV3 extension, no build step. Node built-in test runner (`npm test` globs `test/*.test.mjs`), real `git` ≥ 2.28, CDP-driven headless Chromium for discovery + E2E.

## Global Constraints

- **Safety rails (locked in the spec — do not improvise):** only touch files whose existing setup chain matches the recognizable shape; **auto-commit a snapshot ("Before robot setup update") before propagating** so Pull can restore; **skip-and-report** any file with unmatched variables or unrecognized structure; **never touch protected files or the templates** (`setupTemplate`, `teamSetup`, the menu-config file).
- The propagate flow MUST abort if the snapshot commit fails (not-configured, network error). A `{committed: false, message: 'no changes'}` result is success (tree already matches).
- `src/blocksplice.js` **never throws** — every function returns `{..., error: string|null}` with kid-facing error text; a hostile/corrupt line-1 JSON must produce an error, not an exception.
- The CLAUDE.md rule "treat line-1 blocks JSON as opaque" applies to the **git layer**; `blocksplice.js` is the single sanctioned exception and the docs task must say so. Everything blocksplice does not explicitly rewrite must round-trip byte-for-byte (JSON.parse → JSON.stringify preserves key order for string keys; the line-1 JSON is compact — no added whitespace).
- No ESM `export`/`import` in any `src/*.js` (classic scripts; `Function`-scope test loaders, `test/load-*.mjs` pattern). No build step; no new npm runtime deps.
- `apply-files` deletes unlisted paths — all writes here use `upsert-files` (it computes `sha256` itself, satisfying the spec's "recompute sha256").
- Manifest keys (spec contract): `setupTemplate: "robot_setup_template.py"`, `teamSetup: "robot_setup.py"`. Parsing stays schemaVersion-1 gated, never throws, string-gated per key with `null` default.
- A setup file (contract): a blocks file whose workspace JSON contains **only** the non-deletable `blockGlobalSetup` chain (no main-program blocks; generated Python has no `run_task` and no trailing statements).
- **Known production gap (flag, don't fix here):** the starter repo's manifest names `robot_setup_template.py` but the file was never authored (Brendon's manual phase-1 step, done in code.pybricks.com only — never hand-written). All phase-4 tests use fixtures harvested from the team's own `pybricks-demo` repo and editor-validated derivatives; production use additionally needs Brendon's authored template and each team's `robot_setup.py`.
- UI: inline styles, kid-facing copy, `data-pybricks-git-*` attributes on everything the E2E driver touches.
- Branch: `feat/setup-splice` from `main` (d0ffa99). `npm test` (currently 101/101) green before every commit; both existing E2E drivers must still pass at the end.
- E2E screenshot churn: a passing driver run rewrites committed `test/e2e/*.png` — `git checkout -- test/e2e/*.png` before commits that shouldn't include them.

## Observed format facts (from `../pybricks-demo/blocks.py`, to be confirmed/extended by Task 1)

- Line 1: `# pybricks blocks file:` + compact JSON: `{"blocks":{"languageVersion":0,"blocks":[<top-level blocks>]},"variables":[{name,id,type}...],"info":{"type":"pybricks","version":"1.3.2"}}`.
- The setup chain: one top-level block `{"type":"blockGlobalSetup","id":...,"x":...,"y":...,"deletable":false,"next":{"block":{...}}}` whose `next` chain is `variables_set_*` blocks (`variables_set_prime_hub`, `variables_set_motor`, `variables_set_drive_base`, …). Set blocks carry `fields.VAR.id` (ID only); `variables_get_*` **shadows** inside inputs carry `fields.VAR = {id, name, type}`.
- The `variables` array mixes 10 built-in `ColorDef` entries with user device variables. Blockly IDs are 20-char strings drawn from a charset including `,{}^$%()|~` etc. — treat as opaque strings.
- Generated Python: import lines (`from pybricks.hubs import PrimeHub` / `from pybricks.parameters import Axis, Direction, Port, Stop` / pupdevices / robotics / tools — names alphabetical within a line), blank line, `# Set up all devices.`, contiguous setup assignment lines (1:1 with the chain, variable names snake_cased), blank line, program body.
- A second real fixture exists: `../pybricks-demo/team2testing.py`.

## File Structure

- **Create `src/blocksplice.js`** — pure functions only: `parseBlocksFile`, `findSetupChain`, `chainVariableRefs`, `setupSignature`, `spliceSetup`, `mergeImportLines`, `replaceSetupSection`. No DOM, no chrome APIs, no IO.
- **Modify `src/background.js`** — `readManifestInfo` gains `setupTemplate`/`teamSetup`; `lastPullManifest` persists them.
- **Modify `src/menu-panel.js`** — New-program button + name prompt; per-program setup-differs nudge; Update-robot-setup button (snapshot commit → splice loop → report → reload). `makeMenuPanel` deps gain `serverRequest`.
- **Modify `src/content.js`** — pass `serverRequest` into `makeMenuPanel`; file-list context menu gains "New program from team setup" entry (via a new `onNewProgram` dep on `makeFileListWatcher`).
- **Modify `src/file-list.js`** — the context-menu entry.
- **Modify `manifest.json`** — ISOLATED `js` becomes `["src/menu-config.js", "src/blocksplice.js", "src/menu-panel.js", "src/file-list.js", "src/content.js"]`.
- **Create `test/fixtures/`** — harvested + editor-validated block files (Task 1 populates; later tasks consume).
- **Create `test/load-blocksplice.mjs`, `test/blocksplice.test.mjs`**.
- **Create `test/e2e/blocks-format.md`** (discovery doc), **`test/e2e/drive-splice.mjs`** (E2E driver).
- **Modify `CLAUDE.md`, `test/e2e/README.md`**.

New `lastPullManifest` shape: `{protected: string[], menuConfig: string|null, setupTemplate: string|null, teamSetup: string|null}`.

**Decision (spec left open):** the propagate flow and new-program flow both end in `location.reload()` (same rationale as menu save: dexie-observable staleness + stale Monaco buffers). The skip-report must survive the reload: persist it under storage key `spliceReport` = `{when: ISO-8601, updated: string[], skipped: [{path, reason}]}`; the panel shows it (dismissable) on next open and clears the key on dismiss.

---

### Task 1: fixture harvest + editor-behavior discovery

**Files:**
- Create: `test/fixtures/blocks-demo.py` (verbatim copy of `../pybricks-demo/blocks.py`)
- Create: `test/fixtures/blocks-team2.py` (verbatim copy of `../pybricks-demo/team2testing.py`)
- Create: `test/fixtures/setup-only.py` (derived setup-only file, **editor-validated**)
- Create: `test/fixtures/empty-program.py` (a brand-new block program created via the editor's own UI)
- Create: `test/e2e/blocks-format.md` (the discovery doc)
- (scratchpad-only CDP probe script — not committed)

**Interfaces:**
- Produces: the four fixture files (inputs to Tasks 3–4 tests) and `blocks-format.md`, which MUST answer, from live observation:
  1. **Regeneration semantics:** when a block file is opened in code.pybricks.com, does the editor regenerate the Python below line 1 and persist it back to IndexedDB? On open, or only on edit? (Drive it: upsert a block file whose Python text was deliberately perturbed — e.g. setup line reordered — open the file via the Explorer, wait, re-read IDB, diff.) This determines how exact `spliceSetup`'s Python rewrite must be.
  2. **Empty program shape:** create a new block program via the editor's own new-file UI (Explorer's new-file button; choose the blocks language option). Dump its IDB contents verbatim → `test/fixtures/empty-program.py`. Document: is `blockGlobalStart` present when empty? Does the generated Python of an empty/setup-only program contain `run_task` or trailing statements?
  3. **Derived-file acceptance:** build `setup-only.py` by JSON surgery on `blocks-demo.py` (keep only the `blockGlobalSetup` top-level block; keep the full `variables` array; keep `info`), generate a best-guess Python body (imports needed by the chain + `# Set up all devices.` + the five setup lines), upsert it, open it in the editor, confirm it loads without an error toast/dialog, and capture what the editor (re)generates. **Commit the editor-produced contents** (re-read from IDB after open/edit-nudge) as `test/fixtures/setup-only.py` — editor-authored by construction. Document any divergence between the best-guess Python and the editor's regeneration (imports dropped/added, ordering).
  4. **Import-line rules:** from the observed files, document module-line ordering (hubs → parameters → pupdevices → robotics → tools?), name ordering within a line, and whether unused imports are dropped on regeneration.
  5. **ID rules:** confirm Blockly block/variable IDs are 20-char opaque strings; confirm whether the editor tolerates two files sharing block IDs (it must — files are independent workspaces — but say so).
- CDP mechanics: reuse `test/e2e/drive.mjs` patterns (Chromium under ~/.cache/ms-playwright, LNA-disable flags, git-http harness + SW settings for Pull, tour dismissal, trusted input) and `test/e2e/file-list-dom.md` (Explorer mount button `#pb-toolbar-explorer-button`, row selectors — opening a file = trusted click on its row label).

- [ ] **Step 1:** Copy the two pybricks-demo fixtures verbatim (`cp ../pybricks-demo/blocks.py test/fixtures/blocks-demo.py` etc.) and sanity-check line 1 parses as JSON (`node -e` one-liner).
- [ ] **Step 2:** Write the scratchpad probe; answer questions 1–2 (perturb-and-open on `blocks-demo.py`; create the empty program via the editor UI and dump it).
- [ ] **Step 3:** Answer question 3 (derive, upsert, open, capture) and save the editor-produced `setup-only.py`.
- [ ] **Step 4:** Write `test/e2e/blocks-format.md` with real observed snippets, the five answers, Chromium version + date, and a "consequences for blocksplice" section (exactly how faithful the Python rewrite must be, given answer 1).
- [ ] **Step 5:** Commit: `git add test/fixtures test/e2e/blocks-format.md && git commit -m "test: harvest editor-authored block fixtures; document blocks format + regeneration semantics"`

---

### Task 2: engine persists `setupTemplate`/`teamSetup` in `lastPullManifest`

**Files:**
- Modify: `src/background.js` (`readManifestInfo`, `pullOp` storage write)
- Modify: `test/background-protected.test.mjs`

**Interfaces:**
- Produces: `lastPullManifest` = `{protected, menuConfig, setupTemplate: string|null, teamSetup: string|null}` — same `if (head)` guard, response shapes unchanged.

- [ ] **Step 1: Failing tests** — extend the existing `lastPullManifest` tests in `test/background-protected.test.mjs` (they seed manifests via the git-http harness):

```js
test('pull stores setupTemplate/teamSetup from the manifest', async () => {
    // manifest: {"schemaVersion":1, "menuConfig":"menu_config.py",
    //  "setupTemplate":"robot_setup_template.py", "teamSetup":"robot_setup.py",
    //  "protected":["menu.py"]}
    const stored = await storage.get('lastPullManifest');
    assert.equal(stored.setupTemplate, 'robot_setup_template.py');
    assert.equal(stored.teamSetup, 'robot_setup.py');
});
test('missing/non-string setupTemplate/teamSetup stored as null', async () => {
    // manifest without those keys (and a variant with numbers) -> both null
});
```

Also update the existing `pull with no manifest stores empty lastPullManifest` assertion to the new 4-key shape.

- [ ] **Step 2:** Run `node --test test/background-protected.test.mjs` — new tests fail (`setupTemplate` undefined).
- [ ] **Step 3:** Implement in `readManifestInfo` (add to the returned object, mirroring `menuConfig`):

```js
        return {
            protected: new Set(
                (Array.isArray(manifest.protected) ? manifest.protected : [])
                    .filter((p) => typeof p === 'string'),
            ),
            menuConfig: typeof manifest.menuConfig === 'string' ? manifest.menuConfig : null,
            setupTemplate: typeof manifest.setupTemplate === 'string' ? manifest.setupTemplate : null,
            teamSetup: typeof manifest.teamSetup === 'string' ? manifest.teamSetup : null,
        };
```

with the `none` fallback object gaining both keys as `null`, and `pullOp`'s storage write persisting both (`setupTemplate: manifestInfo.setupTemplate, teamSetup: manifestInfo.teamSetup`).

- [ ] **Step 4:** `npm test` — all green (existing lastPullManifest tests updated, nothing else regresses).
- [ ] **Step 5:** Commit: `git commit -m "feat: pull persists setupTemplate/teamSetup names in lastPullManifest"`

---

### Task 3: `src/blocksplice.js` — parse, locate, refs, signature

**Files:**
- Create: `src/blocksplice.js`
- Create: `test/load-blocksplice.mjs` (mirror `test/load-menu-config.mjs`; publish line: `globalThis.__pybricksBlockspliceTest = { parseBlocksFile, findSetupChain, chainVariableRefs, setupSignature, spliceSetup, mergeImportLines, replaceSetupSection, newProgramContents };` — `spliceSetup`/`mergeImportLines`/`replaceSetupSection`/`newProgramContents` are the splice task's work but declare stubs returning `{error: 'not implemented'}` now so the loader line is stable)
- Create: `test/blocksplice.test.mjs`
- Modify: `manifest.json` (ISOLATED `js`: insert `src/blocksplice.js` after `src/menu-config.js`)

**Interfaces (Tasks 4–6 rely on these exact signatures):**
- `parseBlocksFile(contents) -> {json: object|null, python: string|null, error: string|null}` — `json` from line 1 after the sentinel; `python` = everything after the first `\n`; validates top shape (`json.blocks.blocks` is array, `json.variables` is array). Not a blocks file / bad JSON / bad shape → error.
- `findSetupChain(json) -> {head: object|null, chain: object[]|null, error}` — `head` = the single top-level `blockGlobalSetup` block; `chain` = the ordered `variables_set_*` blocks walked via `.next.block`. Errors: zero/multiple `blockGlobalSetup`; a chain member whose `type` doesn't start with `variables_set_`.
- `chainVariableRefs(chain, variables) -> {refs: Map<id, {name, type}>|null, error}` — every `fields.VAR.id` found anywhere in the chain (set blocks AND nested `variables_get_*` shadows), resolved against the file's `variables` array. Unresolvable ID → error.
- `setupSignature(contents) -> {signature: string|null, error}` — canonical string equal for two files whose setup chains are semantically identical: deep-copy the chain, strip every `id` key, replace every `fields.VAR` with the referenced variable's `{name, type}`, then `JSON.stringify`. Used by the panel nudge and by tests.

- [ ] **Step 1: Loader** (as specified above, `load-menu-config.mjs` pattern).
- [ ] **Step 2: Failing tests** — `test/blocksplice.test.mjs` reading the committed fixtures:

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBlocksplice } from './load-blocksplice.mjs';

const api = loadBlocksplice();
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name), 'utf8');
const DEMO = fixture('blocks-demo.py');
const SETUP_ONLY = fixture('setup-only.py');

describe('parseBlocksFile', () => {
    test('parses a real editor file', () => {
        const r = api.parseBlocksFile(DEMO);
        assert.equal(r.error, null);
        assert.equal(r.json.info.type, 'pybricks');
        assert.ok(Array.isArray(r.json.blocks.blocks));
        assert.ok(r.python.includes('# Set up all devices.'));
    });
    test('non-blocks file -> error', () => {
        assert.notEqual(api.parseBlocksFile('print("hi")\n').error, null);
    });
    test('corrupt JSON -> error, never throws', () => {
        assert.notEqual(api.parseBlocksFile('# pybricks blocks file:{oops\nx\n').error, null);
    });
    test('valid JSON, wrong shape -> error', () => {
        assert.notEqual(api.parseBlocksFile('# pybricks blocks file:{"a":1}\n').error, null);
    });
});

describe('findSetupChain', () => {
    test('walks the demo chain in order', () => {
        const { json } = api.parseBlocksFile(DEMO);
        const r = api.findSetupChain(json);
        assert.equal(r.error, null);
        assert.equal(r.head.type, 'blockGlobalSetup');
        assert.deepEqual(r.chain.map((b) => b.type), [
            'variables_set_prime_hub', 'variables_set_motor', 'variables_set_motor',
            'variables_set_drive_base', 'variables_set_motor',
        ]);
    });
    test('no blockGlobalSetup -> error', () => {
        const r = api.findSetupChain({ blocks: { blocks: [] }, variables: [] });
        assert.notEqual(r.error, null);
    });
    test('non-variables_set block in chain -> error (unrecognized shape)', () => {
        const { json } = api.parseBlocksFile(DEMO);
        const chainCopy = structuredClone(json);
        // graft a wait block into the chain
        chainCopy.blocks.blocks[0].next.block = { type: 'blockWaitTime', id: 'x'.repeat(20), next: chainCopy.blocks.blocks[0].next.block.next };
        assert.notEqual(api.findSetupChain(chainCopy).error, null);
    });
});

describe('chainVariableRefs', () => {
    test('resolves every ref in the demo chain by name+type', () => {
        const { json } = api.parseBlocksFile(DEMO);
        const { chain } = api.findSetupChain(json);
        const r = api.chainVariableRefs(chain, json.variables);
        assert.equal(r.error, null);
        const names = new Set([...r.refs.values()].map((v) => v.name));
        assert.deepEqual([...names].sort(), ['attachment', 'drive base', 'left wheel', 'prime hub', 'right wheel']);
    });
    test('dangling variable id -> error', () => {
        const { json } = api.parseBlocksFile(DEMO);
        const { chain } = api.findSetupChain(json);
        assert.notEqual(api.chainVariableRefs(chain, []).error, null);
    });
});

describe('setupSignature', () => {
    test('identical for a file and itself; stable across id churn', () => {
        const a = api.setupSignature(DEMO);
        assert.equal(a.error, null);
        // re-id every block: signature must not change
        const { json, python } = api.parseBlocksFile(DEMO);
        const churned = structuredClone(json);
        let n = 0;
        (function reId(o) {
            if (o && typeof o === 'object') {
                if (typeof o.id === 'string' && !('name' in o)) o.id = `reid-${n++}`.padEnd(20, '_');
                for (const v of Object.values(o)) reId(v);
            }
        })(churned.blocks.blocks[0]);
        // NOTE: fields.VAR objects keep their ids in this churn only where a name
        // is present; setupSignature must resolve VAR ids via the variables array,
        // so ALSO remap the variables array ids consistently for a fair test —
        // simpler: assert signature(DEMO) !== signature(SETUP_ONLY-with-a-port-changed)
        // and signature(DEMO) === signature(DEMO).
        assert.equal(api.setupSignature(DEMO).signature, a.signature);
    });
    test('differs when a port changes', () => {
        const changed = DEMO.replace('"NAME":"F"', '"NAME":"A"');
        assert.notEqual(api.setupSignature(changed).signature, api.setupSignature(DEMO).signature);
    });
    test('setup-only fixture has a signature (and it differs from demo unless devices match)', () => {
        assert.equal(api.setupSignature(SETUP_ONLY).error, null);
    });
    test('non-blocks file -> error', () => {
        assert.notEqual(api.setupSignature('x = 1\n').error, null);
    });
});
```

(The re-id test's inline NOTE is guidance for the implementer: keep the two simple assertions — self-equality and port-change inequality — and drop the churn scaffolding if id-consistent remapping proves fiddly. The signature contract is: VAR ids resolved to `{name,type}` via the variables array; all other `id` keys stripped.)

- [ ] **Step 3:** Verify RED (`node --test test/blocksplice.test.mjs`).
- [ ] **Step 4: Implement** `src/blocksplice.js`:

```js
// Block-file setup splicing (phase 4). Pure functions over the line-1
// workspace JSON of code.pybricks.com block files.
//
// THIS FILE IS THE ONE SANCTIONED EXCEPTION to the "treat the line-1 blocks
// JSON as opaque" rule: the git layer still round-trips block files
// byte-for-byte; only the explicit splice/new-program features parse and
// rewrite the JSON, under the safety rails documented on spliceSetup.
// Format facts live in test/e2e/blocks-format.md — read it before editing.
//
// Classic script (NO ESM exports) — loaded in the ISOLATED world after
// menu-config.js, and by test/load-blocksplice.mjs. Every function returns
// {..., error} and never throws.

const BLOCKS_FILE_SENTINEL = '# pybricks blocks file:';

function parseBlocksFile(contents) {
    if (typeof contents !== 'string' || !contents.startsWith(BLOCKS_FILE_SENTINEL)) {
        return { json: null, python: null, error: 'not a block program' };
    }
    const nl = contents.indexOf('\n');
    const jsonText = (nl === -1 ? contents : contents.slice(0, nl)).slice(BLOCKS_FILE_SENTINEL.length);
    const python = nl === -1 ? '' : contents.slice(nl + 1);
    let json;
    try {
        json = JSON.parse(jsonText);
    } catch {
        return { json: null, python: null, error: "couldn't read the block data on line 1" };
    }
    if (!json || typeof json !== 'object'
        || !json.blocks || !Array.isArray(json.blocks.blocks)
        || !Array.isArray(json.variables)) {
        return { json: null, python: null, error: 'unrecognized block file layout' };
    }
    return { json, python, error: null };
}

function findSetupChain(json) {
    const heads = json.blocks.blocks.filter((b) => b && b.type === 'blockGlobalSetup');
    if (heads.length !== 1) {
        return { head: null, chain: null, error: heads.length === 0 ? 'no setup section found' : 'more than one setup section' };
    }
    const head = heads[0];
    const chain = [];
    let node = head.next && head.next.block;
    while (node) {
        if (typeof node.type !== 'string' || !node.type.startsWith('variables_set_')) {
            return { head: null, chain: null, error: `unexpected "${node.type}" block inside the setup section` };
        }
        chain.push(node);
        node = node.next && node.next.block;
    }
    return { head, chain, error: null };
}

// Collects every variable id referenced in the chain: the set blocks'
// fields.VAR.id and any nested fields.VAR.id in shadows/blocks (a
// variables_get_* shadow carries {id, name, type} but the variables array is
// the source of truth for resolution).
function chainVariableRefs(chain, variables) {
    const byId = new Map(variables.map((v) => [v.id, { name: v.name, type: v.type }]));
    const refs = new Map();
    let error = null;
    (function walk(node) {
        if (error || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.VAR && typeof node.VAR === 'object' && typeof node.VAR.id === 'string') {
            const meta = byId.get(node.VAR.id);
            if (!meta) { error = 'a device in the setup section is missing from the file’s variable list'; return; }
            refs.set(node.VAR.id, meta);
        }
        for (const v of Object.values(node)) walk(v);
    })(chain);
    if (error) return { refs: null, error };
    return { refs, error: null };
}

function setupSignature(contents) {
    const parsed = parseBlocksFile(contents);
    if (parsed.error) return { signature: null, error: parsed.error };
    const found = findSetupChain(parsed.json);
    if (found.error) return { signature: null, error: found.error };
    const byId = new Map(parsed.json.variables.map((v) => [v.id, { name: v.name, type: v.type }]));
    let danglingRef = false;
    const canon = (function clone(node) {
        if (Array.isArray(node)) return node.map(clone);
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            if (k === 'id') continue; // block/shadow ids are churn, not meaning
            if (k === 'x' || k === 'y') continue; // canvas position is not meaning
            if (k === 'VAR' && v && typeof v === 'object' && typeof v.id === 'string') {
                const meta = byId.get(v.id);
                if (!meta) { danglingRef = true; return null; }
                out[k] = { name: meta.name, type: meta.type };
                continue;
            }
            out[k] = clone(v);
        }
        return out;
    })(found.chain);
    if (danglingRef) return { signature: null, error: 'a device in the setup section is missing from the file’s variable list' };
    return { signature: JSON.stringify(canon), error: null };
}

// spliceSetup / mergeImportLines / replaceSetupSection: implemented in the
// splice task. Stubs keep the test loader stable.
function spliceSetup() { return { contents: null, changed: false, error: 'not implemented' }; }
function mergeImportLines() { return { lines: null, error: 'not implemented' }; }
function replaceSetupSection() { return { python: null, error: 'not implemented' }; }
```

- [ ] **Step 5:** Verify GREEN, then `npm test` (full).
- [ ] **Step 6:** Commit: `git add src/blocksplice.js test/load-blocksplice.mjs test/blocksplice.test.mjs manifest.json && git commit -m "feat: blocksplice parse/locate/refs/signature over real editor fixtures"`

---

### Task 4: `spliceSetup` — chain replacement, variable remap, Python rewrite

**Files:**
- Modify: `src/blocksplice.js` (replace the three stubs)
- Modify: `test/blocksplice.test.mjs`

**Interfaces:**
- `spliceSetup(targetContents, templateContents) -> {contents: string|null, changed: boolean, error: string|null}` — `changed: false, error: null` when the chains already match (`setupSignature` equal). Error strings are kid-facing skip reasons.
- `mergeImportLines(targetPython, templatePython) -> {lines: string[], error}` — union of `from pybricks.<mod> import <names>` lines (names union, alphabetical; module order hubs→parameters→pupdevices→robotics→tools per `blocks-format.md` Q4; non-`from pybricks.` import lines from the TARGET kept as-is in their original position relative to the pybricks block). Never removes a name the target had — the target's program body needs its imports (e.g. `Stop` comes from start blocks); extra unused names self-heal when the editor regenerates on open (`blocks-format.md` Q1/Q4). Do NOT recompute from scratch.
- `replaceSetupSection(targetPython, templatePython, mergedImportLines) -> {python, error}` — swaps the target's setup section for the template's, and its leading pybricks import block for `mergedImportLines`. **The setup marker is version-dependent** (`blocks-format.md` Q1/consequence 3): locate it with a tolerant anchor matching either `# Set up all devices.` or `# Set up.` (exact line match against both literals), in both target and template; the template's section (its own marker line + statements) is written verbatim. Section = marker line through the last consecutive non-blank line after it. **Marker-less target** (empty program — `blocks-format.md` Q2): insert `mergedImportLines` + blank line + the template's section + blank line ABOVE the `# The main program starts here.` line (error only if the target has neither a setup marker nor the start marker). Error if the TEMPLATE lacks a setup marker.
- `newProgramContents(emptyProgramContents, teamSetupContents) -> {contents, error}` — the new-program seed: `spliceSetup(emptyProgramContents, teamSetupContents)` where the empty-program scaffold is the module constant `EMPTY_PROGRAM_CONTENTS` (the verbatim editor-authored `test/fixtures/empty-program.py` contents, embedded as a template literal with a comment naming its origin; block/variable IDs are workspace-local per `blocks-format.md` Q5, so sharing the constant across created files is safe). Exposed as `newProgramContents(teamSetupContents)` taking only the team setup (the scaffold is internal).

**Splice algorithm (the safety rails, exactly):**
1. Parse both files; find both chains; compute both refs. Any error → that error (skip reason).
2. If signatures equal → `{changed: false}`.
3. Match variables by **name AND type**: for each template ref, look up a target variable with the same name; if found with a different `type` → error `'device "X" has a different type in this program'`. Template refs with no same-name target variable are **additions**: append `{name, id, type}` (template's id) to the target's `variables` array — after checking the template id doesn't collide with any existing target variable id or block id (collision → error `'internal id collision — skipped to be safe'`).
4. **Reverse check:** every ref of the TARGET's old chain must appear (name+type) among the template's refs — a target-only device means the kid wired their own hardware into setup; replacing the chain would orphan it. Error: `'this program has its own device "X" in setup — update it by hand'`.
5. Build the new head: deep-copy the template's `blockGlobalSetup` block; overwrite its `id`, `x`, `y` with the TARGET head's values (keep the kid's canvas layout and the existing head id; a target head with no `x`/`y` keeps the template's). An EMPTY target chain (fresh program: head has no `next` key — `blocks-format.md` Q2) is valid: refs are empty, the reverse check passes trivially, and the template chain grafts in whole. Rewrite every `fields.VAR.id` (and `variables_get_*` shadow `fields.VAR` `{id}` — update `id`, keep `name`/`type` as the template wrote them) to the target's id for that name. Copied chain block/shadow ids may be kept verbatim (ids are workspace-local, `blocks-format.md` Q5) — but if any collides with an id elsewhere in the target file, error out (rail: skip on doubt) rather than minting ids.
6. Replace the target's `blockGlobalSetup` entry in `json.blocks.blocks` with the new head. Everything else in the JSON is untouched.
7. Python: `mergeImportLines` + `replaceSetupSection` on the target python using the TEMPLATE's python (the template is a setup-only file: its setup section is authoritative).
8. Reassemble: `BLOCKS_FILE_SENTINEL + JSON.stringify(json) + '\n' + newPython` → `{contents, changed: true}`.

- [ ] **Step 1: Failing tests** (add to `test/blocksplice.test.mjs`; build variant fixtures by string/JSON surgery on the committed ones — each test states its intent):

```js
describe('spliceSetup', () => {
    // Template = the editor-validated setup-only fixture. Target = the demo
    // program (same devices, since setup-only was derived from it) with a
    // port changed, so the splice has real work.
    test('same-signature target -> changed:false, contents null', () => {
        const r = api.spliceSetup(DEMO, DEMO_AS_TEMPLATE);       // identical chains
        assert.equal(r.error, null);
        assert.equal(r.changed, false);
    });
    test('port change propagates; ids remapped to target; program body untouched', () => {
        const target = DEMO;                                      // Port F
        const template = SETUP_ONLY.replace('"NAME":"F"', '"NAME":"A"'); // Port A
        const r = api.spliceSetup(target, template);
        assert.equal(r.error, null);
        assert.equal(r.changed, true);
        const out = api.parseBlocksFile(r.contents);
        // chain now has Port A
        assert.ok(JSON.stringify(api.findSetupChain(out.json).chain).includes('"NAME":"A"'));
        // signature now equals the template's
        assert.equal(api.setupSignature(r.contents).signature, api.setupSignature(template).signature);
        // variable ids in the new chain are the TARGET's ids (splice remapped, not copied)
        const targetIds = new Set(api.parseBlocksFile(target).json.variables.map((v) => v.id));
        const { chain } = api.findSetupChain(out.json);
        const { refs } = api.chainVariableRefs(chain, out.json.variables);
        for (const id of refs.keys()) assert.ok(targetIds.has(id), `chain ref ${id} is a target id`);
        // program body (blockGlobalStart subtree) byte-identical
        const before = JSON.stringify(api.parseBlocksFile(target).json.blocks.blocks.filter((b) => b.type !== 'blockGlobalSetup'));
        const after = JSON.stringify(out.json.blocks.blocks.filter((b) => b.type !== 'blockGlobalSetup'));
        assert.equal(after, before);
        // python setup section updated, body preserved
        assert.ok(out.python.includes('Port.A'));
        assert.ok(out.python.includes('async def subtask'));
        // head keeps target position
        assert.equal(api.findSetupChain(out.json).head.x, api.findSetupChain(api.parseBlocksFile(target).json).head.x);
    });
    test('template with an extra device ADDS the variable and splices', () => {
        // template = SETUP_ONLY with an extra variables_set_motor for a new
        // "arm motor" variable appended to chain + variables array (surgery below)
        const r = api.spliceSetup(DEMO, TEMPLATE_WITH_EXTRA);
        assert.equal(r.error, null);
        const out = api.parseBlocksFile(r.contents);
        assert.ok(out.json.variables.some((v) => v.name === 'arm motor'));
    });
    test('renamed variable in target -> skip with kid-facing reason', () => {
        const target = DEMO.replaceAll('"name":"left wheel"', '"name":"port wheel"')
                           .replace('left_wheel = ', 'port_wheel = ');
        const r = api.spliceSetup(target, SETUP_ONLY);
        assert.notEqual(r.error, null);
        assert.match(r.error, /own device|update it by hand/);
        assert.equal(r.contents, null);
    });
    test('type mismatch -> skip', () => {
        const target = DEMO.replace('"name":"attachment","id":"U04[%8bXE-`Wv%FIbLsK","type":"Motor"',
                                    '"name":"attachment","id":"U04[%8bXE-`Wv%FIbLsK","type":"ColorSensor"');
        assert.notEqual(api.spliceSetup(target, SETUP_ONLY).error, null);
    });
    test('unrecognized target chain -> skip; corrupt template -> skip; never throws', () => {
        assert.notEqual(api.spliceSetup('plain python\n', SETUP_ONLY).error, null);
        assert.notEqual(api.spliceSetup(DEMO, '# pybricks blocks file:{bad\n').error, null);
    });
    test('empty-chain target (fresh program) grafts the whole template chain', () => {
        const EMPTY = fixture('empty-program.py');
        const r = api.spliceSetup(EMPTY, SETUP_ONLY);
        assert.equal(r.error, null);
        assert.equal(r.changed, true);
        assert.equal(api.setupSignature(r.contents).signature, api.setupSignature(SETUP_ONLY).signature);
        const out = api.parseBlocksFile(r.contents);
        // start block + its print survive; python gains imports + setup above the start marker
        assert.ok(out.json.blocks.blocks.some((b) => b.type === 'blockGlobalStart'));
        assert.ok(out.python.includes('# The main program starts here.'));
        assert.ok(out.python.indexOf('# Set up') < out.python.indexOf('# The main program starts here.'));
        assert.ok(out.python.includes("print('Hello, Pybricks!')"));
    });
});

describe('newProgramContents', () => {
    test('seeds a fresh program with the team setup chain + start block', () => {
        const r = api.newProgramContents(SETUP_ONLY);
        assert.equal(r.error, null);
        assert.equal(api.setupSignature(r.contents).signature, api.setupSignature(SETUP_ONLY).signature);
        const out = api.parseBlocksFile(r.contents);
        assert.ok(out.json.blocks.blocks.some((b) => b.type === 'blockGlobalStart'));
    });
    test('corrupt team setup -> error', () => {
        assert.notEqual(api.newProgramContents('# pybricks blocks file:{bad\n').error, null);
    });
});

describe('mergeImportLines / replaceSetupSection', () => {
    test('union per module, names alphabetical, target-only names kept', () => {
        const target = 'from pybricks.parameters import Port, Stop\nfrom pybricks.tools import wait\n\n# Set up all devices.\nx = 1\n\nbody()\n';
        const template = 'from pybricks.parameters import Direction, Port\n\n# Set up all devices.\ny = 2\n';
        const m = api.mergeImportLines(target, template);
        assert.deepEqual(m.lines.filter((l) => l.includes('parameters')),
            ['from pybricks.parameters import Direction, Port, Stop']);
    });
    test('setup section swapped, body untouched, marker missing -> error', () => {
        const target = 'from pybricks.tools import wait\n\n# Set up all devices.\nold = 1\nold2 = 2\n\nbody()\n';
        const template = 'from pybricks.tools import wait\n\n# Set up all devices.\nnew = 9\n';
        const r = api.replaceSetupSection(target, template, ['from pybricks.tools import wait']);
        assert.equal(r.error, null);
        assert.ok(r.python.includes('new = 9'));
        assert.ok(!r.python.includes('old = 1'));
        assert.ok(r.python.includes('body()'));
        assert.notEqual(api.replaceSetupSection('no marker\n', template, []).error, null);
    });
});
```

Define `DEMO_AS_TEMPLATE` / `TEMPLATE_WITH_EXTRA` at the top of the describe via documented JSON surgery helpers (parse → mutate → reassemble with `JSON.stringify`), each with a comment stating what real-world case it models. Consult `test/e2e/blocks-format.md` for the exact shape of an appended `variables_set_motor` block (copy one from the demo chain and re-id it).

- [ ] **Step 2:** Verify RED.
- [ ] **Step 3:** Implement the three functions per the algorithm above. Implementation notes that are binding:
  - Deep-copy via `structuredClone` (available in Chrome MV3 service workers, content scripts, and Node ≥ 17).
  - Collect "all ids in the target file" with one recursive walk gathering every `id` string value outside the old setup head.
  - `mergeImportLines`: parse lines matching `/^from pybricks\.([a-z]+) import (.+)$/`; module order = the order observed in `blocks-format.md` (fall back to alphabetical for unlisted modules); names = union, deduped, sorted; non-matching lines from the target's import block (e.g. bare `import`) are preserved before the pybricks lines.
  - `replaceSetupSection`: the "import block" = the leading run of lines up to the first blank line; the setup section = the `# Set up all devices.` line through the last consecutive non-blank line. Everything between the import block and the marker, and everything after the section, is preserved byte-for-byte.
- [ ] **Step 4:** Verify GREEN; `npm test` full.
- [ ] **Step 5:** Commit: `git commit -m "feat: spliceSetup — chain replacement with name-matched id remap and python rewrite"`

---

### Task 5: panel + file-list — New program from team setup

**Files:**
- Modify: `src/menu-panel.js` (new-program UI; `makeMenuPanel` deps gain `serverRequest` — added here, used by Task 6 too)
- Modify: `src/content.js` (pass `serverRequest`; pass `onNewProgram` to the watcher)
- Modify: `src/file-list.js` (context-menu entry)

**Interfaces:**
- Panel DOM: button `[data-pybricks-git-new-program]` in the panel footer; inline name row `[data-pybricks-git-new-name]` (text input) + `[data-pybricks-git-new-create]` (create button); errors go to the existing `[data-pybricks-git-status]`.
- `makeMenuPanel` gains a public `newProgram()` method (opens the panel and focuses the name input) — `makeFileListWatcher` deps gain `onNewProgram: () => void` wired to it; the context menu appends a final entry `button[data-pybricks-git-context-item="new-program"]`, label "New program from team setup", shown for every row (it acts on the project), including protected rows (place it before the protected early-return; for protected rows show ONLY this entry).
- Behavior: teamSetup name from `lastPullManifest.teamSetup` (no default — `null` means the feature is hidden: button not rendered, context entry absent). If the teamSetup FILE is missing from `list-files` despite the manifest naming it → status message `Pull first — your repo's robot_setup.py isn't in the editor yet.`
- Name validation: reuse `isBareModuleName`? It is file-local to menu-config.js but IS a global in the shared world — call it directly. Rules: bare module name, auto-append `.py`, reject existing paths (case-sensitive compare against `list-files`), reject the reserved names (menuConfig, teamSetup, setupTemplate, protected paths).
- Create: contents come from `newProgramContents(state.teamSetupRow.contents)` (blocksplice global) — the team's setup chain grafted onto the editor-authored empty-program scaffold, so the kid gets a start block to program under (deviation from the spec's literal "seeded from robot_setup.py content", justified by `blocks-format.md` Q2/consequence 7: a verbatim setup-only copy has no `blockGlobalStart`). Its `{error}` → status message and no write. Then `upsert-files` with `{path: name + '.py', contents}` (upsert mints uuid + null viewState) → persist panel open → `location.reload()`.

- [ ] **Step 1:** Implement panel UI. Code sketch (binding structure; adapt to the file's existing helpers `miniIconButton`/`noteEl`/`setStatus`/`markDirty` — read the file first):

```js
    // in render()'s footer, after the Save button, when state.teamSetup (the
    // file name) is non-null:
    const newBtn = miniIconButton('+ New program', 'Start a new block program with your robot setup', () => showNewProgramRow());
    newBtn.dataset.pybricksGitNewProgram = '1';
    footer.appendChild(newBtn);
```

`loadState` gains: `teamSetup: (manifest && manifest.teamSetup) || null`, `setupTemplate: (manifest && manifest.setupTemplate) || null`, and `teamSetupRow = listing.contents.find((c) => c.path === teamSetup) || null`.

```js
    function showNewProgramRow() {
        if (panel.querySelector('[data-pybricks-git-new-name]')) return;
        if (!state.teamSetupRow) {
            setStatus("Pull first — your repo's " + state.teamSetup + " isn't in the editor yet.");
            return;
        }
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '6px', marginTop: '6px' });
        const input = document.createElement('input');
        input.dataset.pybricksGitNewName = '1';
        input.type = 'text';
        input.placeholder = 'program name (letters, digits, _)';
        Object.assign(input.style, { flex: '1', padding: '4px 8px', background: '#1e1e1e', color: '#ddd', border: '1px solid #555', borderRadius: '4px', font: 'inherit' });
        const create = miniIconButton('Create', 'Create the program', () => void createProgram(input.value.trim()));
        create.dataset.pybricksGitNewCreate = '1';
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void createProgram(input.value.trim()); if (ev.key === 'Escape') row.remove(); });
        row.appendChild(input); row.appendChild(create);
        panel.querySelector('[data-pybricks-git-panel-body]').appendChild(row);
        input.focus();
    }

    async function createProgram(name) {
        if (!isBareModuleName(name)) { setStatus('Names use letters, digits and _ — like mission_03.'); return; }
        const path = name + '.py';
        const existing = new Set(state.programs.map((p) => p.module + '.py'));
        const reserved = new Set([state.menuConfigPath, state.teamSetup, state.setupTemplate, ...state.protectedPaths]);
        if (existing.has(path) || reserved.has(path) || state.teamSetupRow.path === path) {
            setStatus(`${path} already exists — pick another name.`);
            return;
        }
        setStatus('Creating…');
        try {
            await pageRequest('upsert-files', { files: [{ path, contents: state.teamSetupRow.contents }] });
            await persist(true);
            setStatus(`Created ${path} — reloading…`);
            setTimeout(() => reload(), 800);
        } catch (err) {
            setStatus(`Couldn't create it: ${err.message}`);
        }
    }
```

Expose `newProgram: async () => { await open(); showNewProgramRow(); }` in the returned object. (`existing` must ALSO include non-program files: check against ALL `list-files` paths, not just eligible programs — keep the full path list in `state.allPaths` from `loadState`.)

- [ ] **Step 2:** `content.js`: `makeMenuPanel({..., serverRequest})`; `makeFileListWatcher({..., onNewProgram: () => menuPanel.newProgram().catch(...)})`.
- [ ] **Step 3:** `file-list.js`: append the entry in `showMenu` (before the protected early-return; protected rows get only this entry), calling `deps.onNewProgram()` after `dismiss()`.
- [ ] **Step 4:** `npm test` (no regressions) + CDP smoke (scratchpad, drive.mjs mechanics): seed harness repo with a manifest whose `teamSetup: "robot_setup.py"` + a `robot_setup.py` (use `test/fixtures/setup-only.py` contents) + `menu_config.py`; Pull; open panel → `[data-pybricks-git-new-program]` visible; create `my_mission` → after reload, `list-files` contains `my_mission.py` whose `setupSignature` equals robot_setup.py's and whose JSON has a `blockGlobalStart` block, fresh uuid, `viewState: null`; open `my_mission.py` in the editor (Explorer row click) → no error toast/dialog; duplicate name → status error, no write; manifest WITHOUT teamSetup → button absent and context-menu entry absent. Record outputs in the report.
- [ ] **Step 5:** Commit: `git commit -m "feat: new program seeded from the team's robot_setup (panel + context menu)"`

---

### Task 6: panel — setup-differs nudge + Update-robot-setup propagate flow

**Files:**
- Modify: `src/menu-panel.js`

**Interfaces:**
- Nudge: in the programs list, each block program (`p.isBlocks`) whose `setupSignature` differs from the teamSetup file's gets a `span[data-pybricks-git-setup-differs]` marker (`⚠ setup differs`, title "This program's robot setup doesn't match robot_setup.py — use Update robot setup"). Files whose `setupSignature` returns an error are NOT marked (unrecognizable ≠ different). Skip entirely when `state.teamSetupRow` is null.
- Propagate: footer button `[data-pybricks-git-update-setup]` ("Update robot setup", rendered only when `state.teamSetupRow` exists and at least one program is marked). Flow:
  1. Disable button, status `Saving a safety snapshot…`.
  2. Snapshot commit: `const files = state.allFiles.map(({path, contents}) => ({path, contents}))` (from `list-files`, kept in `loadState`); `await serverRequest('commit', { files, message: 'Before robot setup update' })`. Any throw → status `Couldn't save the safety snapshot — nothing was changed. (${err.message})`, re-enable, STOP. (`committed: false` "no changes" result → proceed.)
  3. For every eligible target (block program; not protected; not menuConfig/teamSetup/setupTemplate): `spliceSetup(target.contents, state.teamSetupRow.contents)`. Collect `updated` (`changed && !error`) and `skipped` (`error` → `{path, reason: error}`); `changed: false` files are neither.
  4. If `updated.length`: `upsert-files` with all updated `{path, contents}`.
  5. Persist `spliceReport` = `{when: new Date().toISOString(), updated: [...paths], skipped}` via `storageSet`; persist panel open; status `Updated N program(s)… reloading`; reload after 800ms. If nothing updated and nothing skipped → status `All programs already match.` (no reload). If only skips → show report inline, no reload.
- Report rendering: on `open()`, if storage `spliceReport` exists, render a dismissable block `[data-pybricks-git-splice-report]` at the top of the body: "Robot setup updated in: a, b" + per-skip lines "Skipped c.py — <reason>"; a `[data-pybricks-git-splice-report-dismiss]` button clears the storage key and re-renders.

- [ ] **Step 1:** Extend `loadState` (`allFiles`, `allPaths`, per-program `signature` computed once, teamSetup signature) and `render` (nudge markers; the two footer buttons; report block). Write the code following the file's existing render/helper idioms.
- [ ] **Step 2:** Implement `updateSetup()` exactly per the flow above (the snapshot-first rail is non-negotiable; any deviation must be BLOCKED, not improvised).
- [ ] **Step 3:** `npm test` + CDP smoke: seed manifest (`teamSetup`) + `robot_setup.py` (setup-only fixture) + a block program derived from `test/fixtures/blocks-demo.py` with one port changed (differs) + one plain-python mission (ignored) + one block program with a renamed variable (skip path); configure git settings (the snapshot commit needs them). Assert: differing program is marked; Update button appears; click → harness bare repo gains commit "Before robot setup update" BEFORE the content changes; after reload the panel shows the splice report (1 updated, 1 skipped with reason); updated file's chain signature now matches; skipped file untouched; report dismiss clears it. Record outputs.
- [ ] **Step 4:** Commit: `git commit -m "feat: setup-differs nudge + snapshot-first robot-setup propagation"`

---

### Task 7: E2E driver `test/e2e/drive-splice.mjs` + editor round-trip

**Files:**
- Create: `test/e2e/drive-splice.mjs`
- Modify: `test/e2e/README.md` (new section)

**Interfaces:**
- Self-contained (drive.mjs mechanics; copying noted by origin comments). Exit 0 = PASS; `splice-failure.png` / `splice-panel.png`.

Scenario (assert each):
1. Seed bare repo: manifest (`schemaVersion: 1`, `menuConfig`, `teamSetup: "robot_setup.py"`, `protected: ["menu.py"]`), `menu.py`, `menu_config.py`, `robot_setup.py` (= `test/fixtures/setup-only.py`), `prog_match.py` (block program whose chain matches — derive from setup-only + a body block, or reuse the fixture pair Task 6's smoke used), `prog_differs.py` (port changed), `prog_renamed.py` (renamed variable → skip).
2. Launch, settings, tour, Pull, reload.
3. Panel: `prog_differs` row has `[data-pybricks-git-setup-differs]`; `prog_match` doesn't; `[data-pybricks-git-update-setup]` present.
4. New program: create `my_new_one` via `[data-pybricks-git-new-program]` → after reload `my_new_one.py` in IDB has `setupSignature` equal to `robot_setup.py`'s and a `blockGlobalStart` block.
5. Update setup: click → wait for reload → `spliceReport` rendered (updated: `prog_differs.py`; skipped: `prog_renamed.py` with reason). IDB `prog_differs.py` signature === teamSetup signature (evaluate via the page's own globals: `setupSignature` is in the isolated world — call through `Runtime.evaluate` on that context).
6. Harness-side: bare repo has the snapshot commit `Before robot setup update` whose tree holds the PRE-splice `prog_differs.py`; `prog_renamed.py` byte-identical to seed; `menu.py` untouched.
7. **Editor round-trip (the spec's acceptance):** open `prog_differs.py` in the editor (Explorer row click), give the editor a beat, re-read IDB: line-1 JSON still parses, `setupSignature` unchanged, and the Python is identical to what the splice wrote (or, if `blocks-format.md` documented that the editor regenerates-and-persists on open: identical AFTER regeneration — assert per what Task 1 found, citing the doc in a comment).
8. Commit via toolbar → pushed tree contains the spliced `prog_differs.py`.
9. Zero extension exceptions (page + SW; isExt regex includes `blocksplice.js`).

- [ ] **Step 1:** Write the driver; iterate to PASS (`node test/e2e/drive-splice.mjs`).
- [ ] **Step 2:** Regression gates: `node test/e2e/drive-menu.mjs` PASS, `node test/e2e/drive.mjs` PASS, `npm test` all green. Restore screenshot churn before committing.
- [ ] **Step 3:** README section (what it covers, how to run, real PASS tail).
- [ ] **Step 4:** Commit: `git commit -m "test: E2E driver for setup propagation incl. editor round-trip"`

---

### Task 8: docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Update CLAUDE.md, fact-checking every claim against source:
  - Architecture: five ISOLATED scripts + load order (blocksplice after menu-config).
  - "Block files vs. text files": amend the opaque rule — opaque **in the git layer**; `src/blocksplice.js` is the sanctioned exception (splice + new-program only), format reference `test/e2e/blocks-format.md`.
  - New "Setup propagation (phase 4)" subsection: blocksplice API one-liners, the safety rails verbatim (snapshot-first, skip-and-report, never protected/templates), `spliceReport` + extended `lastPullManifest` storage keys, new-program seeding, the nudge.
  - "Planned work": phase 4 done (phase-2/3 style); note the remaining production prerequisite (Brendon authors `robot_setup_template.py` in the editor; teams copy it to `robot_setup.py`) — this is the roadmap's only open item.
- [ ] **Step 2:** `npm test` green; commit: `git commit -m "docs: phase-4 setup-splice architecture; blocksplice exception to the opaque-JSON rule"`

---

## Final wave (controller)

Whole-branch review (Fable) with minors triage; controller re-runs `npm test` + all three E2E drivers; merge decision to Brendon. Surface the production gap explicitly in the wrap-up: the starter repo still needs Brendon's editor-authored `robot_setup_template.py` (and teams need `robot_setup.py`) before phase 4 features light up on a real fork.
