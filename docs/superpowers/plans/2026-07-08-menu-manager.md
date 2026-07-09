# Phase 3 — Floating Menu Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kids manage their hub menu (`menu_config.py`) with a draggable floating panel and a right-click/long-press context menu on the page's file list, instead of hand-editing Python.

**Architecture:** A new pure-function module `src/menu-config.js` (parse/generate `menu_config.py`, analyze `.py` files for eligibility) is shared by a new floating panel (`src/menu-panel.js`) and a new file-list watcher (`src/file-list.js`), all classic scripts in the same ISOLATED world as `content.js`. Writes go through a new `upsert-files` op in `inject.js` (partial write — **never** reuse `apply-files`, which deletes unlisted paths). The engine (`background.js`) starts persisting the last pull's manifest info (`protected` + `menuConfig`) to `chrome.storage.local` so the panel and badges work across page loads.

**Tech Stack:** Plain JS Chrome MV3 extension, no build step. Node built-in test runner (`npm test` globs `test/*.test.mjs`), real `git` ≥ 2.28 for the engine suite, CDP-driven headless Chromium for E2E.

## Global Constraints

- **No ESM `export`/`import` in any `src/*.js`** — they are classic scripts (`content_scripts` / `importScripts`). Tests load them via `Function`-scope loaders (`test/load-*.mjs` pattern).
- No build step; no new npm runtime deps. `package.json` is dev-only tooling.
- The block-file line-1 JSON (`# pybricks blocks file:{...}`) is **opaque text** — never parse or rewrite it.
- When updating an existing editor file, **preserve `viewState` and `uuid`**; only `sha256` and `contents` change.
- `apply-files` deletes any path not in its payload — single/partial file writes MUST use the new `upsert-files`.
- Protected-path consumers must **intersect the manifest's `protected` list with the actual file list** (a manifest can name absent paths).
- UI: inline styles only (existing pattern), `position: fixed` on `document.body`, `zIndex: 10000`, kid-facing copy. Every interactive element the E2E driver must reach gets a `data-pybricks-git-*` attribute.
- Menu-item contract (from the roadmap spec, phase 1): `display` required (int 0–99 — bools rejected — or 1-char string, or list of exactly 5 strings of 5 chars); `module` required bare identifier (no dots); `function` optional (absent/None = whole-program); `blocks` optional bool; `enabled` optional bool; list order = menu order. The extension rewrites the whole file from its own template; comments inside the list are not preserved.
- Manifest (`.pybricks-git.json`) parsing is schemaVersion-1 gated and never throws; absence/malformation = no protection.
- Branch: `feat/menu-manager` from `main` (f675115). Commit after every task.
- Run `npm test` before every commit; all existing 67 tests must stay green.

## File Structure

- **Create `src/menu-config.js`** — pure helpers: `parseMenuConfig`, `generateMenuConfig`, `pyRepr`, `validateDisplay`, `validateItem`, `analyzeProgram`, `topLevelStatements`, `nextFreeDisplayNumber`. No DOM, no chrome APIs.
- **Create `src/menu-panel.js`** — `makeMenuPanel(deps)` factory (DI like `makeEngine`): the floating panel DOM + interactions. Uses menu-config.js globals.
- **Create `src/file-list.js`** — `makeFileListWatcher(deps)` factory: MutationObserver over the page's file list, protected badges, context-menu/long-press → "Add to menu".
- **Modify `src/inject.js`** — add `upsert-files` op (refactor `applyFiles` to share a `writeFiles` core).
- **Modify `src/background.js`** — `readManifestInfo` (protected + menuConfig), persist `lastPullManifest` on pull.
- **Modify `src/content.js`** — third toolbar button (Menu), panel + watcher wiring, protected-notice copy + a11y fixes.
- **Modify `manifest.json`** — ISOLATED content_scripts `js` becomes `["src/menu-config.js", "src/menu-panel.js", "src/file-list.js", "src/content.js"]` (order matters: content.js last; earlier files' top-level declarations are visible to later ones in the same world).
- **Create `test/load-menu-config.mjs`**, **`test/menu-config.test.mjs`**, extend **`test/inject.test.mjs`**, **`test/background-protected.test.mjs`**.
- **Create `test/e2e/file-list-dom.md`** (discovery notes) and **`test/e2e/drive-menu.mjs`** (panel E2E driver).
- **Modify `CLAUDE.md`** — new ops, storage keys, phase-3 status.

New `chrome.storage.local` keys: `menuPanel` = `{left, top, open}` (panel position + open flag, written by the panel); `lastPullManifest` = `{protected: string[], menuConfig: string|null}` (written by the engine on every successful pull with a head).

**Decision (spec left it open):** Save **always** `location.reload()`s after a successful `upsert-files` (the dexie-observable staleness plus the risk that `menu_config.py` is open in Monaco — a stale buffer would clobber our save on Pybricks' next write — make reload the only safe choice, same as Pull). The panel persists `open: true` before reloading so it reopens automatically.

---

### Task 1: `src/menu-config.js` — pure parse/generate/analyze module

**Files:**
- Create: `src/menu-config.js`
- Create: `test/load-menu-config.mjs`
- Create: `test/menu-config.test.mjs`
- Modify: `manifest.json` (register the new script)

**Interfaces:**
- Produces (globals in the ISOLATED world, published to tests via the loader):
  - `parseMenuConfig(text) -> {items: object[]|null, error: string|null}`
  - `generateMenuConfig(items: object[]) -> string`
  - `pyRepr(value) -> string`
  - `validateDisplay(value) -> string|null` (null = valid)
  - `validateItem(item) -> string|null`
  - `analyzeProgram(path, contents) -> {module: string|null, isBlocks: boolean, setupOnly: boolean, methods: string[]}`
  - `topLevelStatements(text) -> string[]`
  - `nextFreeDisplayNumber(items) -> number`

- [ ] **Step 1: Write the loader** — `test/load-menu-config.mjs` (mirror `test/load-inject.mjs`):

```js
// Test harness: loads src/menu-config.js (a classic content script with no
// module exports) into Node and hands back its functions. Same pattern as
// load-inject.mjs: read verbatim, append a publishing line, run in one
// Function scope so the shipped file stays untouched.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'menu-config.js');

export function loadMenuConfig() {
    const src =
        readFileSync(srcPath, 'utf8') +
        '\n;globalThis.__pybricksMenuConfigTest = { parseMenuConfig, generateMenuConfig, pyRepr, validateDisplay, validateItem, analyzeProgram, topLevelStatements, nextFreeDisplayNumber };';
    // eslint-disable-next-line no-new-func
    new Function(src)();
    return globalThis.__pybricksMenuConfigTest;
}
```

- [ ] **Step 2: Write the failing tests** — `test/menu-config.test.mjs`. Use `node:test` + `node:assert/strict` like the existing suites. Cover ALL of the following (grouped `describe`/`test`):

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMenuConfig } from './load-menu-config.mjs';

const api = loadMenuConfig();

// Trimmed copy of the phase-1 starter file (docstring + comments inside the
// list must be handled).
const STARTER = `"""The list of missions your hub menu shows, in the order it shows them.

    "display"   (required) What shows on the hub screen for this slot.
"""

MENU_ITEMS = [
    {"display": 1, "module": "mission_01_go_out_and_turn", "function": "run"},
    {"display": 2, "module": "mission_02_come_back_home", "function": "run"},
    # Whole program (a block program or a Python file) — picking it runs
    # the entire file from top to bottom:
    # {"display": 3, "module": "my_blocks_program"},
    # {"display": 4, "module": "arm_moves", "function": "lift_arm", "blocks": True},
]
`;

describe('parseMenuConfig', () => {
    test('parses the phase-1 starter file (docstring + comments in list)', () => {
        const { items, error } = api.parseMenuConfig(STARTER);
        assert.equal(error, null);
        assert.deepEqual(items, [
            { display: 1, module: 'mission_01_go_out_and_turn', function: 'run' },
            { display: 2, module: 'mission_02_come_back_home', function: 'run' },
        ]);
    });
    test('parses True/False/None, patterns, escapes', () => {
        const src = 'MENU_ITEMS = [\n' +
            '    {"display": ["#####", "#   #", "#   #", "#   #", "#####"], "module": "box", "function": None, "blocks": True, "enabled": False},\n' +
            "    {'display': 'A', 'module': 'quoted', 'function': 'say_\\'hi\\''},\n" +
            ']\n';
        const { items, error } = api.parseMenuConfig(src);
        assert.equal(error, null);
        assert.equal(items[0].blocks, true);
        assert.equal(items[0].enabled, false);
        assert.equal(items[0].function, null);
        assert.deepEqual(items[0].display, ['#####', '#   #', '#   #', '#   #', '#####']);
        assert.equal(items[1].function, "say_'hi'");
    });
    test('missing MENU_ITEMS -> error, null items', () => {
        const r = api.parseMenuConfig('print("hello")\n');
        assert.equal(r.items, null);
        assert.match(r.error, /MENU_ITEMS/);
    });
    test('MENU_ITEMS not a list -> error', () => {
        assert.notEqual(api.parseMenuConfig('MENU_ITEMS = {"a": 1}\n').error, null);
    });
    test('non-dict entry -> error', () => {
        assert.notEqual(api.parseMenuConfig('MENU_ITEMS = [1, 2]\n').error, null);
    });
    test('unterminated string -> error (never throws)', () => {
        assert.notEqual(api.parseMenuConfig('MENU_ITEMS = [{"display": 1, "module": "oops]\n').error, null);
    });
    test('indented MENU_ITEMS is not top-level -> error', () => {
        assert.notEqual(api.parseMenuConfig('if True:\n    MENU_ITEMS = []\n').error, null);
    });
});

describe('generateMenuConfig', () => {
    test('round-trips through parseMenuConfig', () => {
        const items = [
            { display: 1, module: 'mission_01', function: 'run' },
            { display: 'A', module: 'arm_moves', function: 'lift_arm', blocks: true },
            { display: ['#####', '#   #', '#   #', '#   #', '#####'], module: 'box' },
            { display: 9, module: 'later', enabled: false },
        ];
        const text = api.generateMenuConfig(items);
        const back = api.parseMenuConfig(text);
        assert.equal(back.error, null);
        assert.deepEqual(back.items, items);
    });
    test('normalizes defaults away: function None, blocks False, enabled True omitted', () => {
        const text = api.generateMenuConfig([
            { display: 1, module: 'm', function: null, blocks: false, enabled: true },
        ]);
        assert.match(text, /\{"display": 1, "module": "m"\},/);
    });
    test('keeps unknown keys (forward compat)', () => {
        const text = api.generateMenuConfig([{ display: 1, module: 'm', color: 'red' }]);
        assert.match(text, /"color": "red"/);
    });
    test('starts with a docstring and contains exactly one MENU_ITEMS', () => {
        const text = api.generateMenuConfig([]);
        assert.match(text, /^"""/);
        assert.equal(text.match(/^MENU_ITEMS\s*=/gm).length, 1);
    });
});

describe('validateDisplay / validateItem', () => {
    test('accepts int 0-99, rejects bools, negatives, 100', () => {
        assert.equal(api.validateDisplay(0), null);
        assert.equal(api.validateDisplay(99), null);
        assert.notEqual(api.validateDisplay(true), null);
        assert.notEqual(api.validateDisplay(-1), null);
        assert.notEqual(api.validateDisplay(100), null);
        assert.notEqual(api.validateDisplay(1.5), null);
    });
    test('accepts exactly-1-char strings', () => {
        assert.equal(api.validateDisplay('A'), null);
        assert.notEqual(api.validateDisplay(''), null);
        assert.notEqual(api.validateDisplay('AB'), null);
    });
    test('accepts 5x5 patterns only', () => {
        assert.equal(api.validateDisplay(['#####', '     ', '#####', '     ', '#####']), null);
        assert.notEqual(api.validateDisplay(['#####']), null);
        assert.notEqual(api.validateDisplay(['####', '     ', '#####', '     ', '#####']), null);
        assert.notEqual(api.validateDisplay([1, 2, 3, 4, 5]), null);
    });
    test('validateItem: module must be bare identifier; function plain name; flags boolean', () => {
        assert.equal(api.validateItem({ display: 1, module: 'ok_name' }), null);
        assert.notEqual(api.validateItem({ display: 1, module: 'pkg.mod' }), null);
        assert.notEqual(api.validateItem({ display: 1 }), null);
        assert.notEqual(api.validateItem({ module: 'm' }), null);
        assert.notEqual(api.validateItem({ display: 1, module: 'm', function: 'not a name' }), null);
        assert.notEqual(api.validateItem({ display: 1, module: 'm', blocks: 1 }), null);
        assert.equal(api.validateItem({ display: 1, module: 'm', function: null }), null);
    });
});

describe('analyzeProgram', () => {
    const BLOCKS_MAIN = '# pybricks blocks file:{"whatever": true}\n' +
        'from pybricks.tools import run_task, wait\n\n' +
        'async def main():\n    await wait(100)\n\n' +
        'run_task(main())\n';
    const BLOCKS_SETUP = '# pybricks blocks file:{"whatever": true}\n' +
        'from pybricks.pupdevices import Motor\nfrom pybricks.parameters import Port\n\n' +
        'left_motor = Motor(Port.A)\n\n' +
        'def lift_arm():\n    left_motor.run_angle(500, 90)\n\n' +
        'async def wave():\n    left_motor.run_angle(500, -90)\n';
    const PLAIN_MISSION = '"""Mission 1."""\n\nfrom robot import Robot\n\n\ndef run(robot):\n    robot.drive.straight(200)\n';

    test('block main program: isBlocks, run_task disqualifies methods', () => {
        const r = api.analyzeProgram('my_program.py', BLOCKS_MAIN);
        assert.deepEqual(r, { module: 'my_program', isBlocks: true, setupOnly: false, methods: [] });
    });
    test('block setup-only file: methods listed, async included', () => {
        const r = api.analyzeProgram('arm_moves.py', BLOCKS_SETUP);
        assert.equal(r.isBlocks, true);
        assert.equal(r.setupOnly, true);
        assert.deepEqual(r.methods, ['lift_arm', 'wave']);
    });
    test('plain mission module: setup-only with run()', () => {
        const r = api.analyzeProgram('mission_01.py', PLAIN_MISSION);
        assert.deepEqual(r, { module: 'mission_01', isBlocks: false, setupOnly: true, methods: ['run'] });
    });
    test('top-level call disqualifies (trailing main statement)', () => {
        const src = 'def go():\n    pass\n\ngo()\n';
        assert.deepEqual(api.analyzeProgram('x.py', src).methods, []);
    });
    test('top-level for/if disqualifies', () => {
        assert.equal(api.analyzeProgram('x.py', 'for i in range(3):\n    pass\n').setupOnly, false);
        assert.equal(api.analyzeProgram('x.py', 'if True:\n    pass\n').setupOnly, false);
    });
    test('assignments, imports, class, decorator, docstring are all setup', () => {
        const src = '"""Doc."""\nimport math\nfrom pybricks.parameters import Port\n' +
            'SPEED = 500\nnames = ["a", "b"]\nd = {"k": 1}\na, b = 1, 2\nx += 1\n' +
            '@property\ndef f():\n    pass\nclass C:\n    pass\n';
        assert.equal(api.analyzeProgram('x.py', src).setupOnly, true);
    });
    test('kwarg call is NOT mistaken for an assignment', () => {
        assert.equal(api.analyzeProgram('x.py', 'configure(speed=500)\n').setupOnly, false);
    });
    test('underscore-prefixed defs are hidden from methods', () => {
        const r = api.analyzeProgram('x.py', 'def _helper():\n    pass\ndef go():\n    pass\n');
        assert.deepEqual(r.methods, ['go']);
    });
    test('module name: null for dotted/nested/invalid paths', () => {
        assert.equal(api.analyzeProgram('my.file.py', 'x = 1\n').module, null);
        assert.equal(api.analyzeProgram('dir/x.py', 'x = 1\n').module, null);
        assert.equal(api.analyzeProgram('1bad.py', 'x = 1\n').module, null);
        assert.equal(api.analyzeProgram('notpy.txt', 'x = 1\n').module, null);
    });
    test('multiline constructs do not register as new statements', () => {
        const src = 'ITEMS = [\n    1,\n    2,\n]\nLONG = (\n    "a"\n    "b"\n)\ns = """text\nrun_task( inside a string\n"""\n';
        assert.equal(api.analyzeProgram('x.py', src).setupOnly, true);
    });
});

describe('nextFreeDisplayNumber', () => {
    test('picks the smallest unused 1..99, then 0', () => {
        assert.equal(api.nextFreeDisplayNumber([]), 1);
        assert.equal(api.nextFreeDisplayNumber([{ display: 1 }, { display: 2 }]), 3);
        assert.equal(api.nextFreeDisplayNumber([{ display: 1 }, { display: 3 }]), 2);
        assert.equal(api.nextFreeDisplayNumber([{ display: 'A' }]), 1);
    });
});
```

- [ ] **Step 3: Run tests, verify they fail** — `npm test` → new file fails with `parseMenuConfig is not defined` (or module-load error); existing 67 pass.

- [ ] **Step 4: Implement `src/menu-config.js`:**

```js
// Pure helpers for the floating menu manager: parse and regenerate
// menu_config.py, and analyze .py files for menu eligibility.
//
// Classic script (NO ESM exports) — listed in manifest.json's ISOLATED-world
// content_scripts BEFORE menu-panel.js/file-list.js/content.js so its
// top-level functions are in scope there, and loaded by
// test/load-menu-config.mjs the same way load-inject.mjs loads inject.js.
//
// menu_config.py contract (see the roadmap spec): optional docstring/comments
// plus exactly one top-level `MENU_ITEMS = [<dict literals>]`, values limited
// to int/str/bool/None/list-of-str. The extension rewrites the whole file
// from its own template — comments inside the list are not preserved.

const BLOCKS_SENTINEL = '# pybricks blocks file:';

// --- parse -----------------------------------------------------------------

function parseMenuConfig(text) {
    const m = /^MENU_ITEMS\s*=/m.exec(text);
    if (!m) return { items: null, error: 'no top-level MENU_ITEMS assignment found' };
    try {
        const parser = new PyLiteralParser(text, m.index + m[0].length);
        const value = parser.parseValue();
        if (!Array.isArray(value)) return { items: null, error: 'MENU_ITEMS is not a list' };
        for (const entry of value) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                return { items: null, error: 'every MENU_ITEMS entry must be a dict' };
            }
        }
        return { items: value, error: null };
    } catch (err) {
        return { items: null, error: err && err.message ? err.message : String(err) };
    }
}

// Recursive-descent parser for the Python literal subset the contract allows.
class PyLiteralParser {
    constructor(text, pos) {
        this.text = text;
        this.pos = pos;
    }
    fail(msg) {
        return new Error(`menu_config parse error at offset ${this.pos}: ${msg}`);
    }
    skip() {
        while (this.pos < this.text.length) {
            const c = this.text[this.pos];
            if (c === '#') {
                while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
            } else if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
                this.pos++;
            } else break;
        }
    }
    parseValue() {
        this.skip();
        const c = this.text[this.pos];
        if (c === '[') return this.parseList();
        if (c === '{') return this.parseDict();
        if (c === '"' || c === "'") return this.parseString();
        if (c === '-' || (c >= '0' && c <= '9')) return this.parseInt();
        if (this.text.startsWith('True', this.pos)) { this.pos += 4; return true; }
        if (this.text.startsWith('False', this.pos)) { this.pos += 5; return false; }
        if (this.text.startsWith('None', this.pos)) { this.pos += 4; return null; }
        throw this.fail(`unexpected character ${JSON.stringify(c ?? '<eof>')}`);
    }
    parseList() {
        this.pos++; // '['
        const out = [];
        for (;;) {
            this.skip();
            if (this.pos >= this.text.length) throw this.fail("unterminated list (missing ']')");
            if (this.text[this.pos] === ']') { this.pos++; return out; }
            out.push(this.parseValue());
            this.skip();
            if (this.text[this.pos] === ',') { this.pos++; continue; }
            if (this.text[this.pos] === ']') { this.pos++; return out; }
            throw this.fail("expected ',' or ']' in list");
        }
    }
    parseDict() {
        this.pos++; // '{'
        const out = {};
        for (;;) {
            this.skip();
            if (this.pos >= this.text.length) throw this.fail("unterminated dict (missing '}')");
            if (this.text[this.pos] === '}') { this.pos++; return out; }
            const key = this.parseValue();
            if (typeof key !== 'string') throw this.fail('dict keys must be strings');
            this.skip();
            if (this.text[this.pos] !== ':') throw this.fail("expected ':' after dict key");
            this.pos++;
            out[key] = this.parseValue();
            this.skip();
            if (this.text[this.pos] === ',') { this.pos++; continue; }
            if (this.text[this.pos] === '}') { this.pos++; return out; }
            throw this.fail("expected ',' or '}' in dict");
        }
    }
    parseString() {
        const quote = this.text[this.pos];
        this.pos++;
        let out = '';
        while (this.pos < this.text.length) {
            const c = this.text[this.pos];
            if (c === '\\') {
                const next = this.text[this.pos + 1];
                const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
                if (next in simple) { out += simple[next]; this.pos += 2; continue; }
                throw this.fail(`unsupported escape \\${next}`);
            }
            if (c === '\n') throw this.fail('unterminated string');
            if (c === quote) { this.pos++; return out; }
            out += c;
            this.pos++;
        }
        throw this.fail('unterminated string');
    }
    parseInt() {
        const m = /^-?\d+/.exec(this.text.slice(this.pos));
        if (!m) throw this.fail('bad number');
        this.pos += m[0].length;
        return parseInt(m[0], 10);
    }
}

// --- generate ----------------------------------------------------------------

// Kid-facing header, kept close to the phase-1 starter file's docstring so a
// regenerated menu_config.py still explains itself.
const MENU_CONFIG_HEADER = `"""The list of missions your hub menu shows, in the order it shows them.

Each slot is a little dictionary with these keys:

    "display"   (required) What shows on the hub screen for this slot.
                A number 0-99, a single letter like "A", or a 5-row
                pixel pattern (list of 5 strings) — same as pix_display.
    "module"    (required) The name of the .py file to run, with no ".py"
                and no dots.
    "function"  (optional) The name of the function inside that file to
                call, like "run". Leave this key OUT to run the WHOLE
                file top-to-bottom instead (this is how block programs run).
    "blocks"    (optional, default False) Set to True for a function that
                comes from a block program's "My Block".
    "enabled"   (optional, default True) Set to False to hide a slot from
                the menu without deleting it from this list.

The ORDER of the list is the order the slots appear in the menu.

Heads up: the Pybricks Git extension's menu manager rewrites this file —
comments inside the MENU_ITEMS list are not kept.
"""`;

const MENU_CONFIG_KEY_ORDER = ['display', 'module', 'function', 'blocks', 'enabled'];

// Defaults are normalized away so the generated file stays minimal.
function shouldEmitKey(item, key) {
    if (!(key in item)) return false;
    if (key === 'function') return item.function !== null && item.function !== undefined;
    if (key === 'blocks') return item.blocks === true;
    if (key === 'enabled') return item.enabled === false;
    return true;
}

function generateMenuConfig(items) {
    const lines = [MENU_CONFIG_HEADER, '', 'MENU_ITEMS = ['];
    for (const item of items) {
        const keys = [
            ...MENU_CONFIG_KEY_ORDER.filter((k) => shouldEmitKey(item, k)),
            ...Object.keys(item).filter((k) => !MENU_CONFIG_KEY_ORDER.includes(k)),
        ];
        const body = keys.map((k) => `${pyRepr(k)}: ${pyRepr(item[k])}`).join(', ');
        lines.push(`    {${body}},`);
    }
    lines.push(']', '');
    return lines.join('\n');
}

function pyRepr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') {
        return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    }
    if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
    throw new Error(`can't represent ${typeof v} in menu_config.py`);
}

// --- validate ----------------------------------------------------------------

function validateDisplay(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 0 && value <= 99
            ? null
            : 'display number must be a whole number 0-99';
    }
    if (typeof value === 'string') {
        return value.length === 1 ? null : 'display text must be exactly 1 character';
    }
    if (Array.isArray(value)) {
        return value.length === 5 && value.every((r) => typeof r === 'string' && r.length === 5)
            ? null
            : 'display pattern must be exactly 5 strings of 5 characters';
    }
    return 'display must be a number 0-99, a single character, or a 5x5 pattern';
}

function isBareModuleName(v) {
    return typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
}

function validateItem(item) {
    if (!('display' in item)) return "missing 'display'";
    const displayError = validateDisplay(item.display);
    if (displayError) return displayError;
    if (!isBareModuleName(item.module)) {
        return 'module must be a bare .py file name (letters, digits, _, no dots)';
    }
    if ('function' in item && item.function !== null && item.function !== undefined
        && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.function)) {
        return 'function must be a plain function name';
    }
    if ('blocks' in item && typeof item.blocks !== 'boolean') return 'blocks must be True or False';
    if ('enabled' in item && typeof item.enabled !== 'boolean') return 'enabled must be True or False';
    return null;
}

// --- analyze programs ----------------------------------------------------------

// analyzeProgram(path, contents): can this editor file appear in the menu?
// - module: bare module name (null = ineligible entirely: nested/dotted/non-.py)
// - isBlocks: line-1 blocks sentinel
// - setupOnly: importing the file runs nothing (only imports / defs / classes /
//   assignments / docstrings at top level, and no run_task( anywhere top-level)
// - methods: top-level def/async def names (empty unless setupOnly);
//   underscore-prefixed names are treated as private and hidden.
function analyzeProgram(path, contents) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\.py$/.exec(path);
    const module = m ? m[1] : null;
    const isBlocks = contents.startsWith(BLOCKS_SENTINEL);
    let setupOnly = true;
    const methods = [];
    for (const stmt of topLevelStatements(contents)) {
        const def = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(stmt);
        if (def) {
            if (!def[1].startsWith('_')) methods.push(def[1]);
            continue;
        }
        if (/\brun_task\s*\(/.test(stmt) || !isSetupStatement(stmt)) setupOnly = false;
    }
    return { module, isBlocks, setupOnly, methods: setupOnly ? methods : [] };
}

// Returns the first physical line (comments stripped, trimmed) of every
// top-level (column-0) statement. Continuations — open brackets, trailing
// backslash, unterminated triple-quoted strings — don't start new statements.
function topLevelStatements(text) {
    const out = [];
    let depth = 0; // () [] {} nesting across lines
    let triple = null; // "'''" or '"""' while inside a multiline string
    let backslash = false; // previous line ended with a line-continuation \
    for (const raw of text.split('\n')) {
        const startsStatement = !triple && depth === 0 && !backslash && /^[^\s#]/.test(raw);
        let visible = '';
        let i = 0;
        backslash = false;
        while (i < raw.length) {
            if (triple) {
                const end = raw.indexOf(triple, i);
                if (end === -1) { i = raw.length; break; }
                i = end + 3;
                triple = null;
                continue;
            }
            const c = raw[i];
            if (c === '#') break; // comment runs to end of line
            if (c === '"' || c === "'") {
                const three = raw.slice(i, i + 3);
                if (three === '"""' || three === "'''") {
                    visible += three;
                    const end = raw.indexOf(three, i + 3);
                    if (end === -1) { triple = three; i = raw.length; break; }
                    i = end + 3;
                    continue;
                }
                let j = i + 1;
                while (j < raw.length && raw[j] !== c) {
                    if (raw[j] === '\\') j++;
                    j++;
                }
                visible += raw.slice(i, Math.min(j + 1, raw.length));
                i = j + 1;
                continue;
            }
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
            visible += c;
            i++;
        }
        if (!triple && visible.trimEnd().endsWith('\\')) backslash = true;
        if (startsStatement) out.push(visible.trim());
    }
    return out;
}

// A "setup" statement keeps a module method-eligible: imports, decorators,
// class definitions, bare strings (docstrings), and assignments. Anything
// else at top level (a call, a loop, if/try/with) means importing the file
// RUNS things, so only whole-program use is offered.
function isSetupStatement(stmt) {
    if (/^(import|from)\s/.test(stmt)) return true;
    if (stmt.startsWith('@')) return true;
    if (/^class[\s(]/.test(stmt)) return true;
    if (/^["']/.test(stmt)) return true;
    // Assignment targets: names/dots/subscripts/tuples, optional annotation,
    // then = (augmented allowed, == excluded). '(' is deliberately NOT in the
    // target charset so a kwarg call like configure(speed=500) doesn't match.
    if (/^[A-Za-z_][A-Za-z0-9_.,'"\[\] ]*(:[^=(]+)?([-+*/%&|^@]|\*\*|\/\/)?=(?!=)/.test(stmt)) {
        return true;
    }
    return false;
}

// --- panel helpers -------------------------------------------------------------

// Smallest display number not already used by an int slot: 1..99 first
// (matches the starter's numbering), 0 as a last resort.
function nextFreeDisplayNumber(items) {
    const used = new Set(items.map((i) => i.display).filter((d) => typeof d === 'number'));
    for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
    return 0;
}
```

- [ ] **Step 5: Register in `manifest.json`** — change the ISOLATED entry to:

```json
    {
      "matches": ["https://code.pybricks.com/*"],
      "js": ["src/menu-config.js", "src/content.js"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    },
```

(menu-panel.js / file-list.js are added to this array by Tasks 4 and 7.)

- [ ] **Step 6: Run `npm test`** — all pass (67 existing + new suite). Fix implementation, not tests, unless a test contradicts the contract above.

- [ ] **Step 7: Commit** — `git add src/menu-config.js test/load-menu-config.mjs test/menu-config.test.mjs manifest.json && git commit -m "feat: menu_config.py parse/generate + program eligibility analysis (pure module)"`

---

### Task 2: `inject.js` `upsert-files` op

**Files:**
- Modify: `src/inject.js`
- Modify: `test/load-inject.mjs` (publish `upsertFiles`)
- Modify: `test/inject.test.mjs` (new tests)

**Interfaces:**
- Produces: bridge op `upsert-files` with payload `{files: [{path, contents}]}` → `{added, changed, deleted: 0, unchanged}`. Updates/inserts ONLY the given paths (preserving `viewState`/`uuid` on update, minting `uuid` + `viewState: null` on insert), never deletes anything.

- [ ] **Step 1: Write the failing tests** — append to `test/inject.test.mjs` (reuse its existing fake-indexeddb seeding helpers; adapt names to what's already there):

```js
describe('upsertFiles', () => {
    test('updates listed paths, leaves unlisted paths alone', async () => {
        // seed DB with a.py + b.py (existing helper), then:
        const summary = await t.upsertFiles({ files: [{ path: 'a.py', contents: 'new a\n' }] });
        assert.deepEqual(summary, { added: 0, changed: 1, deleted: 0, unchanged: 0 });
        // b.py still present and untouched; a.py contents updated,
        // a.py metadata keeps its original uuid + viewState, sha256 recomputed.
    });
    test('inserts new paths with fresh uuid and null viewState', async () => {
        const summary = await t.upsertFiles({ files: [{ path: 'menu_config.py', contents: 'MENU_ITEMS = []\n' }] });
        assert.deepEqual(summary, { added: 1, changed: 0, deleted: 0, unchanged: 0 });
    });
    test('unchanged contents counted, not rewritten', async () => {
        // upsert a.py with identical contents -> {added:0, changed:0, deleted:0, unchanged:1}
    });
    test('applyFiles still deletes unlisted paths (regression)', async () => {
        // existing applyFiles behavior unchanged after the refactor
    });
});
```

Write these as real tests against the file's existing seeding pattern — read `test/inject.test.mjs` first and match its helpers exactly (it seeds via `applyFiles` / direct fake-indexeddb writes). Assert uuid/viewState preservation by reading the metadata store back.

- [ ] **Step 2: Run, verify fail** — `upsertFiles is not defined` (loader publish line not yet updated → update loader first, then failure is `upsertFiles is not a function`).

- [ ] **Step 3: Implement** — in `src/inject.js`: add the op, extract the shared write core:

```js
async function handle(op, payload) {
    switch (op) {
        case 'list-databases':
            return await indexedDB.databases();
        case 'list-files':
            return await listFiles();
        case 'apply-files':
            return await applyFiles(payload);
        case 'upsert-files':
            return await upsertFiles(payload);
        default:
            throw new Error(`unknown op: ${op}`);
    }
}
```

Refactor `applyFiles` into a shared `writeFiles(files, deleteUnlisted)` keeping the current body verbatim except the deletion loop is wrapped in `if (deleteUnlisted) { ... }`:

```js
// applyFiles({files}) replaces the IDB-stored set with the given files (adds,
// updates, and DELETES anything unlisted). upsertFiles({files}) is its
// partial-write twin: update/insert ONLY the given paths — used by the menu
// manager to save menu_config.py without touching the rest of the project.
async function applyFiles({ files }) {
    return await writeFiles(files, true);
}

async function upsertFiles({ files }) {
    return await writeFiles(files, false);
}

async function writeFiles(files, deleteUnlisted) {
    // ... existing applyFiles body, with the `for (const m of existingMeta)`
    // deletion loop wrapped in `if (deleteUnlisted) { ... }`.
    // Return shape unchanged: { added, changed, deleted, unchanged }.
}
```

Update `test/load-inject.mjs`'s publish line to include `upsertFiles`:

```js
'\n;globalThis.__pybricksGitTest = { applyFiles, upsertFiles, sha256, listFiles, openPybricksDb };';
```

- [ ] **Step 4: Run `npm test`** — all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: inject.js upsert-files op — partial IDB write that never deletes"`

---

### Task 3: engine persists `lastPullManifest`; deferred protected-commit test

**Files:**
- Modify: `src/background.js` (`readProtectedPaths` → `readManifestInfo` + wrapper; `pullOp` storage write)
- Modify: `test/background-protected.test.mjs`

**Interfaces:**
- Produces: `chrome.storage.local` key `lastPullManifest` = `{protected: string[], menuConfig: string|null}`, written by `pullOp` **only when the fetch found a head** (same guard as `lastPullPaths`). Pull/commit response shapes unchanged.

- [ ] **Step 1: Write the failing tests** — extend `test/background-protected.test.mjs` (use its existing harness helpers for seeding repos with manifests):

```js
test('pull stores lastPullManifest (protected + menuConfig) alongside lastPullPaths', async () => {
    // seed repo with manifest {"schemaVersion":1, "menuConfig":"menu_config.py",
    // "protected":["menu.py"]} + menu.py + a.py; pull; then:
    const stored = await storage.get('lastPullManifest');
    assert.deepEqual(stored, { protected: ['menu.py'], menuConfig: 'menu_config.py' });
});
test('pull with no manifest stores empty lastPullManifest', async () => {
    const stored = await storage.get('lastPullManifest');
    assert.deepEqual(stored, { protected: [], menuConfig: null });
});
test('empty-branch pull leaves lastPullManifest untouched', async () => {
    // pre-set lastPullManifest, pull an empty fork, assert unchanged
});
test('one commit mixing a protected deletion and a divergent protected edit reports both', async () => {
    // (deferred from phase 2) seed manifest protecting menu.py + main.py, pull,
    // then commit a payload that OMITS menu.py (deletion) and EDITS main.py.
    // Assert new Set(result.protectedSkipped) equals new Set(['menu.py','main.py'])
    // — order is unspecified, compare as sets — and the tree kept both originals.
});
```

Follow the file's existing fixture idioms exactly (it already builds manifests and asserts `protectedSkipped`).

- [ ] **Step 2: Run, verify fail** — `lastPullManifest` undefined; combined test fails only if the behavior is actually broken (it may pass immediately — that's fine, it's a pinned regression test; note it in the commit message).

- [ ] **Step 3: Implement** in `src/background.js`:

```js
// Reads the repo manifest (.pybricks-git.json at the root) out of an
// already-listed tree: the protected-path set plus the menu-config file name
// the phase-3 panel edits. Anything short of a well-formed schemaVersion-1
// manifest means "no protection" — this never throws.
async function readManifestInfo(d, fileMap) {
    const none = { protected: new Set(), menuConfig: null };
    const entry = fileMap.get(MANIFEST_PATH);
    if (!entry) return none;
    try {
        const { blob } = await d.git.readBlob({ fs: d.fs, gitdir: d.gitdir, oid: entry.oid });
        const manifest = JSON.parse(new TextDecoder().decode(blob));
        if (!manifest || manifest.schemaVersion !== 1) return none;
        return {
            protected: new Set(
                (Array.isArray(manifest.protected) ? manifest.protected : [])
                    .filter((p) => typeof p === 'string'),
            ),
            menuConfig: typeof manifest.menuConfig === 'string' ? manifest.menuConfig : null,
        };
    } catch {
        return none;
    }
}

async function readProtectedPaths(d, fileMap) {
    return (await readManifestInfo(d, fileMap)).protected;
}
```

In `pullOp`, replace the `readProtectedPaths` call with `readManifestInfo` and extend the guarded storage write:

```js
    let manifestInfo = { protected: new Set(), menuConfig: null };
    if (head) {
        const all = await listAllFiles(d, head);
        manifestInfo = await readManifestInfo(d, all);
        // ... existing blob loop unchanged ...
    }
    if (head) {
        await d.storage.set({
            lastPullPaths: files.map((f) => f.path),
            lastPullManifest: {
                protected: [...manifestInfo.protected],
                menuConfig: manifestInfo.menuConfig,
            },
        });
    }
    return {
        head: head ? head.slice(0, 7) : '',
        files,
        protected: [...manifestInfo.protected],
        pullWarning: head ? '' : 'remote repository has no commits yet',
    };
```

`commitOp` keeps calling `readProtectedPaths` (now a thin wrapper) — no change there.

- [ ] **Step 4: Run `npm test`** — all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: pull persists lastPullManifest (protected + menuConfig); pin combined protected deletion+edit reporting"`

---

### Task 4: panel shell — toolbar toggle, draggable persisted panel

**Files:**
- Create: `src/menu-panel.js`
- Modify: `src/content.js` (Menu button + wiring)
- Modify: `manifest.json` (add `src/menu-panel.js` after `src/menu-config.js`)

**Interfaces:**
- Produces: global `makeMenuPanel(deps)` where `deps = { pageRequest, storageGet, storageSet, reload }`; returns `{ toggle(), open(), close(), isOpen(), addSlot(module, fn, blocks) }`. In THIS task `addSlot` and `refresh` are declared stubs (shown below) that the slot-editing task replaces — the return shape must not change between tasks.
- Consumes: `chrome.storage.local` key `menuPanel` `{left, top, open}`.
- DOM contract (E2E + Task 5 depend on these): panel root `div[data-pybricks-git-panel]`, header `[data-pybricks-git-panel-header]`, close button `[data-pybricks-git-panel-close]`, body `[data-pybricks-git-panel-body]`, toolbar button `[data-pybricks-git-menu-btn]`.

No Node-testable logic here (all DOM) — verification is the E2E smoke in Step 4.

- [ ] **Step 1: Implement `src/menu-panel.js`:**

```js
// Floating menu-manager panel (phase 3). makeMenuPanel wires the DOM and
// interactions; the pure parse/generate/analyze helpers come from
// menu-config.js, loaded earlier in the same isolated world.
//
// Classic script — no exports. content.js calls makeMenuPanel({...}).

function makeMenuPanel(deps) {
    const { pageRequest, storageGet, storageSet, reload } = deps;

    let panel = null;
    let pos = { left: 80, top: 80 };

    async function toggle() {
        if (panel) close();
        else await open();
    }

    function isOpen() {
        return !!panel;
    }

    async function open() {
        if (panel) return;
        const saved = await storageGet('menuPanel');
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
            pos = { left: saved.left, top: saved.top };
        }
        panel = buildShell();
        document.body.appendChild(panel);
        clampIntoViewport();
        void persist(true);
        await refresh(); // no-op shell body until the slot-editing task
    }

    function close() {
        if (!panel) return;
        panel.remove();
        panel = null;
        void persist(false);
    }

    function persist(openFlag) {
        return storageSet({ menuPanel: { left: pos.left, top: pos.top, open: openFlag } });
    }

    function clampIntoViewport() {
        pos.left = Math.max(0, Math.min(pos.left, window.innerWidth - 120));
        pos.top = Math.max(0, Math.min(pos.top, window.innerHeight - 60));
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
    }

    function buildShell() {
        const root = document.createElement('div');
        root.dataset.pybricksGitPanel = '1';
        Object.assign(root.style, {
            position: 'fixed',
            left: `${pos.left}px`,
            top: `${pos.top}px`,
            width: '440px',
            maxHeight: '70vh',
            display: 'flex',
            flexDirection: 'column',
            background: '#252526',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '6px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            font: 'inherit',
            fontSize: '13px',
            zIndex: 10000,
        });

        const header = document.createElement('div');
        header.dataset.pybricksGitPanelHeader = '1';
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: '#2d2d30',
            borderBottom: '1px solid #555',
            borderRadius: '6px 6px 0 0',
            cursor: 'move',
            userSelect: 'none',
        });
        const title = document.createElement('span');
        title.textContent = 'Robot Menu';
        title.style.fontWeight = 'bold';
        const closeBtn = document.createElement('button');
        closeBtn.dataset.pybricksGitPanelClose = '1';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close';
        Object.assign(closeBtn.style, {
            background: 'none',
            color: '#ddd',
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '14px',
        });
        closeBtn.addEventListener('click', close);
        header.appendChild(title);
        header.appendChild(closeBtn);

        header.addEventListener('pointerdown', (down) => {
            if (down.target.closest('button')) return; // don't hijack the ✕
            down.preventDefault();
            const startLeft = pos.left;
            const startTop = pos.top;
            const move = (ev) => {
                pos.left = Math.max(0, Math.min(startLeft + ev.clientX - down.clientX, window.innerWidth - 120));
                pos.top = Math.max(0, Math.min(startTop + ev.clientY - down.clientY, window.innerHeight - 60));
                root.style.left = `${pos.left}px`;
                root.style.top = `${pos.top}px`;
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                void persist(true);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });

        const body = document.createElement('div');
        body.dataset.pybricksGitPanelBody = '1';
        Object.assign(body.style, {
            overflowY: 'auto',
            padding: '10px 12px',
            flex: '1',
        });

        root.appendChild(header);
        root.appendChild(body);
        return root;
    }

    // Loads editor state and renders the panel body. Filled in by the
    // slot-editing task; the shell just shows a placeholder line.
    async function refresh() {
        const body = panel.querySelector('[data-pybricks-git-panel-body]');
        body.textContent = 'Loading…';
    }

    // Adds a slot for module(.fn) — filled in by the slot-editing task.
    async function addSlot(module, fn, blocks) {
        await open();
    }

    return { toggle, open, close, isOpen, addSlot };
}
```

- [ ] **Step 2: Wire into `src/content.js`** — extend `mountButton()` with a third button and create the panel:

```js
const menuPanel = makeMenuPanel({
    pageRequest,
    storageGet: (key) =>
        new Promise((resolve) => chrome.storage.local.get(key, (v) => resolve(v[key]))),
    storageSet: (obj) => new Promise((resolve) => chrome.storage.local.set(obj, () => resolve())),
    reload: () => location.reload(),
});
```

(place after `pageRequest` is defined, before `mountButton()` is called), and in `mountButton()` after the pull button:

```js
    const menuBtn = makeBtn('Menu', 'Pybricks Git: edit the hub menu');
    menuBtn.dataset.pybricksGitMenuBtn = '1';
    menuBtn.addEventListener('click', () => {
        menuPanel.toggle().catch((err) => console.error('[pybricks-git] panel failed:', err));
    });
    toolbar.appendChild(menuBtn);

    // Reopen the panel after the reload that Save/Pull triggers.
    const saved = await new Promise((resolve) =>
        chrome.storage.local.get('menuPanel', (v) => resolve(v.menuPanel)),
    );
    if (saved && saved.open) {
        menuPanel.open().catch((err) => console.warn('[pybricks-git] panel reopen failed:', err));
    }
```

- [ ] **Step 3: Update `manifest.json`** ISOLATED `js` array: `["src/menu-config.js", "src/menu-panel.js", "src/content.js"]`.
- [ ] **Step 4: Verify** — `npm test` (no regressions), then a manual E2E smoke via the existing recipe: launch per `test/e2e/drive.mjs` mechanics (or a scratchpad CDP script) and assert: Menu button exists, click opens `[data-pybricks-git-panel]`, drag moves it, close ✕ removes it, `chrome.storage.local.menuPanel` holds position, reload with `open: true` reopens. Record the checks run in the commit message.
- [ ] **Step 5: Commit** — `git commit -m "feat: floating menu panel shell — toolbar toggle, drag, persisted position/open"`

---

### Task 5: panel content — slots, programs, editing, save

**Files:**
- Modify: `src/menu-panel.js` (replace the `refresh` / `addSlot` stubs)

**Interfaces:**
- Consumes: `parseMenuConfig`, `generateMenuConfig`, `validateItem`, `validateDisplay`, `analyzeProgram`, `nextFreeDisplayNumber` (menu-config.js globals); bridge ops `list-files`, `upsert-files`; storage key `lastPullManifest`.
- DOM contract (E2E depends on these): slots container `[data-pybricks-git-slots]` with one `[data-pybricks-git-slot]` per item (attribute value = index); per-slot: `[data-pybricks-git-slot-display]` (button), `[data-pybricks-git-slot-up]`, `[data-pybricks-git-slot-down]`, `[data-pybricks-git-slot-enabled]` (checkbox), `[data-pybricks-git-slot-remove]`; programs container `[data-pybricks-git-programs]` with `[data-pybricks-git-add]` buttons whose value is `module` or `module.fn`; save button `[data-pybricks-git-save]`; status line `[data-pybricks-git-status]`; display editor popover `[data-pybricks-git-display-editor]`.

- [ ] **Step 1: Implement state loading.** Inside `makeMenuPanel`, add module-level-in-closure `let state = null;` and:

```js
    // state: { menuConfigPath, items, programs, protectedPaths, banner, dirty }
    async function loadState() {
        const [listing, manifest] = await Promise.all([
            pageRequest('list-files'),
            storageGet('lastPullManifest'),
        ]);
        const menuConfigPath = (manifest && manifest.menuConfig) || 'menu_config.py';
        const filePaths = new Set(listing.contents.map((c) => c.path));
        // Manifests can name paths that aren't in the editor — only badge/hide
        // files that actually exist.
        const protectedPaths = new Set(
            ((manifest && manifest.protected) || []).filter((p) => filePaths.has(p)),
        );
        let items = [];
        let banner = '';
        const configRow = listing.contents.find((c) => c.path === menuConfigPath);
        if (!configRow) {
            banner = `${menuConfigPath} doesn't exist yet — Save will create it.`;
        } else {
            const parsed = parseMenuConfig(configRow.contents);
            if (parsed.error) {
                banner = `Couldn't read ${menuConfigPath} (${parsed.error}). Saving will rewrite it from scratch.`;
            } else {
                items = parsed.items;
            }
        }
        const programs = listing.contents
            .filter((c) => c.path !== menuConfigPath && !protectedPaths.has(c.path))
            .map((c) => analyzeProgram(c.path, c.contents))
            .filter((p) => p.module)
            .sort((a, b) => a.module.localeCompare(b.module));
        return { menuConfigPath, items, programs, protectedPaths, banner, dirty: false };
    }
```

`open()` becomes: load saved position → `state = await loadState()` → build shell → `render()`.

- [ ] **Step 2: Implement `render()`** (replaces `refresh`). Full body rebuild each call (small lists; keeps logic simple):

```js
    function render() {
        const body = panel.querySelector('[data-pybricks-git-panel-body]');
        body.textContent = '';

        if (state.banner) body.appendChild(noteEl(state.banner));

        body.appendChild(sectionTitle('Menu slots (drag to reorder)'));
        const slots = document.createElement('div');
        slots.dataset.pybricksGitSlots = '1';
        state.items.forEach((item, index) => slots.appendChild(slotRow(item, index)));
        if (!state.items.length) slots.appendChild(noteEl('No slots yet — add a program below.'));
        body.appendChild(slots);

        body.appendChild(sectionTitle('Programs you can add'));
        const programs = document.createElement('div');
        programs.dataset.pybricksGitPrograms = '1';
        for (const p of state.programs) {
            programs.appendChild(programRow(p));
        }
        if (!state.programs.length) programs.appendChild(noteEl('No programs found — Pull first?'));
        body.appendChild(programs);

        const footer = document.createElement('div');
        Object.assign(footer.style, {
            display: 'flex', gap: '8px', alignItems: 'center',
            paddingTop: '10px', borderTop: '1px solid #444', marginTop: '10px',
        });
        const save = document.createElement('button');
        save.dataset.pybricksGitSave = '1';
        save.textContent = state.dirty ? 'Save menu' : 'Saved';
        save.disabled = !state.dirty;
        styleMiniButton(save);
        save.addEventListener('click', () => void saveConfig(save));
        const status = document.createElement('span');
        status.dataset.pybricksGitStatus = '1';
        footer.appendChild(save);
        footer.appendChild(status);
        body.appendChild(footer);
    }
```

with small helpers `sectionTitle(text)`, `noteEl(text)`, `styleMiniButton(btn)` (inline styles matching the existing button look: `#2d2d30` background, `1px solid #555`, `borderRadius 4px`, `padding 4px 10px`, pointer cursor).

- [ ] **Step 3: Implement `slotRow(item, index)`** — one row per menu item:

```js
    function slotRow(item, index) {
        const row = document.createElement('div');
        row.dataset.pybricksGitSlot = String(index);
        row.draggable = true;
        Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '5px 6px', margin: '2px 0',
            background: '#2d2d30', border: '1px solid #444', borderRadius: '4px',
            opacity: item.enabled === false ? '0.5' : '1',
        });

        // HTML5 drag-to-reorder: remember the source index on dragstart, move
        // the item on drop over another row.
        row.addEventListener('dragstart', (ev) => {
            ev.dataTransfer.setData('text/plain', String(index));
            ev.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('drop', (ev) => {
            ev.preventDefault();
            const from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
            if (Number.isNaN(from) || from === index) return;
            moveSlot(from, index);
        });

        const grip = document.createElement('span');
        grip.textContent = '≡';
        grip.style.cursor = 'grab';
        row.appendChild(grip);

        const displayBtn = document.createElement('button');
        displayBtn.dataset.pybricksGitSlotDisplay = '1';
        displayBtn.textContent = displayLabel(item.display);
        displayBtn.title = 'Change what the hub shows for this slot';
        styleMiniButton(displayBtn);
        displayBtn.style.minWidth = '44px';
        displayBtn.addEventListener('click', () => openDisplayEditor(displayBtn, item));
        row.appendChild(displayBtn);

        const label = document.createElement('span');
        label.style.flex = '1';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        label.textContent = item.function
            ? `${item.module}.${item.function}()${item.blocks ? ' [blocks]' : ''}`
            : `${item.module} (whole program)`;
        row.appendChild(label);

        const up = miniIconButton('▲', 'Move up', () => moveSlot(index, index - 1));
        up.dataset.pybricksGitSlotUp = '1';
        up.disabled = index === 0;
        const down = miniIconButton('▼', 'Move down', () => moveSlot(index, index + 1));
        down.dataset.pybricksGitSlotDown = '1';
        down.disabled = index === state.items.length - 1;
        row.appendChild(up);
        row.appendChild(down);

        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.dataset.pybricksGitSlotEnabled = '1';
        enabled.checked = item.enabled !== false;
        enabled.title = 'Show this slot in the menu';
        enabled.addEventListener('change', () => {
            if (enabled.checked) delete item.enabled;
            else item.enabled = false;
            markDirty();
        });
        row.appendChild(enabled);

        const remove = miniIconButton('✕', 'Remove this slot', () => {
            state.items.splice(index, 1);
            markDirty();
        });
        remove.dataset.pybricksGitSlotRemove = '1';
        row.appendChild(remove);

        return row;
    }

    function moveSlot(from, to) {
        if (to < 0 || to >= state.items.length) return;
        const [item] = state.items.splice(from, 1);
        state.items.splice(to, 0, item);
        markDirty();
    }

    function markDirty() {
        state.dirty = true;
        render();
    }

    function displayLabel(display) {
        if (Array.isArray(display)) return '▦';
        return String(display);
    }

    function miniIconButton(text, title, onClick) {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        styleMiniButton(b);
        b.style.padding = '2px 6px';
        b.addEventListener('click', onClick);
        return b;
    }
```

- [ ] **Step 4: Implement `programRow(p)` and `addSlot`:**

```js
    function programRow(p) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
            padding: '4px 6px', margin: '2px 0',
        });
        const name = document.createElement('span');
        name.textContent = p.module + (p.isBlocks ? ' 🧩' : '');
        name.title = p.isBlocks ? 'Block program' : 'Python program';
        name.style.flex = '1';
        row.appendChild(name);

        const addWhole = miniIconButton('+ program', `Run all of ${p.module}`, () =>
            void addSlot(p.module, null, false),
        );
        addWhole.dataset.pybricksGitAdd = p.module;
        row.appendChild(addWhole);

        for (const fn of p.methods) {
            const addFn = miniIconButton(`+ ${fn}()`, `Run just ${fn}() from ${p.module}`, () =>
                void addSlot(p.module, fn, p.isBlocks),
            );
            addFn.dataset.pybricksGitAdd = `${p.module}.${fn}`;
            row.appendChild(addFn);
        }
        return row;
    }

    // Also called by the file-list context menu ("Add to menu").
    async function addSlot(module, fn, blocks) {
        await open();
        const item = { display: nextFreeDisplayNumber(state.items), module };
        if (fn) item.function = fn;
        if (blocks) item.blocks = true;
        state.items.push(item);
        markDirty();
    }
```

- [ ] **Step 5: Implement the display editor popover** — number / single character / 5×5 pattern grid (pix_display semantics: `'#'` = lit, `' '` = off; digits 1–9 in an existing pattern are shown as lit and become `'#'` if the cell is toggled):

```js
    function openDisplayEditor(anchorBtn, item) {
        document.querySelector('[data-pybricks-git-display-editor]')?.remove();
        const pop = document.createElement('div');
        pop.dataset.pybricksGitDisplayEditor = '1';
        const rect = anchorBtn.getBoundingClientRect();
        Object.assign(pop.style, {
            position: 'fixed',
            left: `${Math.min(rect.left, window.innerWidth - 240)}px`,
            top: `${rect.bottom + 4}px`,
            width: '220px',
            padding: '10px',
            background: '#2d2d30',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            zIndex: 10001,
            font: 'inherit',
            fontSize: '13px',
        });

        // Mode radios
        const current = item.display;
        let mode = Array.isArray(current) ? 'pattern' : typeof current === 'string' ? 'char' : 'number';

        const numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.min = '0';
        numberInput.max = '99';
        numberInput.value = typeof current === 'number' ? String(current) : '1';

        const charInput = document.createElement('input');
        charInput.type = 'text';
        charInput.maxLength = 1;
        charInput.value = typeof current === 'string' ? current : 'A';

        // 5x5 grid of toggle cells
        const pattern = Array.isArray(current)
            ? current.map((row) => row.split(''))
            : Array.from({ length: 5 }, () => Array(5).fill(' '));
        const grid = document.createElement('div');
        Object.assign(grid.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 24px)',
            gap: '2px',
        });
        pattern.forEach((rowChars, r) => {
            rowChars.forEach((ch, c) => {
                const cell = document.createElement('button');
                const isOn = () => pattern[r][c] !== ' ' && pattern[r][c] !== '0';
                const paint = () => {
                    cell.style.background = isOn() ? '#e9b64d' : '#1e1e1e';
                };
                Object.assign(cell.style, {
                    width: '24px', height: '24px',
                    border: '1px solid #555', borderRadius: '3px', cursor: 'pointer',
                });
                paint();
                cell.addEventListener('click', () => {
                    pattern[r][c] = isOn() ? ' ' : '#';
                    paint();
                });
                grid.appendChild(cell);
            });
        });

        const sections = [
            ['number', 'Number (0–99)', numberInput],
            ['char', 'One character', charInput],
            ['pattern', '5×5 picture', grid],
        ];
        for (const [value, labelText, control] of sections) {
            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.margin = '4px 0';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'pybricks-git-display-mode';
            radio.value = value;
            radio.checked = mode === value;
            radio.addEventListener('change', () => { mode = value; });
            label.appendChild(radio);
            label.appendChild(document.createTextNode(' ' + labelText));
            pop.appendChild(label);
            control.style.margin = '2px 0 6px 20px';
            pop.appendChild(control);
        }

        const apply = miniIconButton('Apply', 'Use this display', () => {
            let next;
            if (mode === 'number') next = parseInt(numberInput.value, 10);
            else if (mode === 'char') next = charInput.value;
            else next = pattern.map((rowChars) => rowChars.join(''));
            const problem = validateDisplay(next);
            if (problem) {
                apply.textContent = problem;
                setTimeout(() => (apply.textContent = 'Apply'), 2500);
                return;
            }
            item.display = next;
            pop.remove();
            markDirty();
        });
        const cancel = miniIconButton('Cancel', 'Keep the old display', () => pop.remove());
        const buttons = document.createElement('div');
        buttons.style.marginTop = '6px';
        buttons.appendChild(apply);
        buttons.appendChild(cancel);
        pop.appendChild(buttons);

        document.body.appendChild(pop);
    }
```

- [ ] **Step 6: Implement `saveConfig`:**

```js
    // Save = regenerate the whole file and upsert ONLY that path. Always
    // reload afterwards: dexie-observable can't see raw IDB writes, and if
    // menu_config.py is open in Monaco a stale buffer would clobber this save
    // on the app's next write. The persisted open flag reopens the panel.
    async function saveConfig(saveBtn) {
        for (const [i, item] of state.items.entries()) {
            const problem = validateItem(item);
            if (problem) {
                setStatus(`Slot ${i + 1}: ${problem}`);
                return;
            }
        }
        saveBtn.disabled = true;
        setStatus('Saving…');
        try {
            const text = generateMenuConfig(state.items);
            await pageRequest('upsert-files', {
                files: [{ path: state.menuConfigPath, contents: text }],
            });
            await persist(true);
            setStatus('Saved ✓ — reloading…');
            setTimeout(() => reload(), 800);
        } catch (err) {
            console.error('[pybricks-git] menu save failed:', err);
            setStatus(`Save failed: ${err.message}`);
            saveBtn.disabled = false;
        }
    }

    function setStatus(text) {
        const status = panel && panel.querySelector('[data-pybricks-git-status]');
        if (status) status.textContent = text;
    }
```

- [ ] **Step 7: Verify** — `npm test` (pure-function coverage already exists from Task 1; no new Node tests here), then manual E2E smoke via CDP: open panel against a pulled repo containing `menu_config.py` + a setup-only block file; assert slots render, add/remove/reorder/enable work (DOM assertions on the data attributes), Save writes `menu_config.py` into the editor IDB (`list-files` shows regenerated text) and the page reloads with the panel reopened. Record checks in the commit message.
- [ ] **Step 8: Commit** — `git commit -m "feat: menu panel slots/programs editing and save via upsert-files"`

---

### Task 6: file-list DOM discovery

**Files:**
- Create: `test/e2e/file-list-dom.md`
- (scratchpad-only: a throwaway CDP probe script — do NOT commit it)

**Interfaces:**
- Produces: `test/e2e/file-list-dom.md` documenting, from a real headless-Chromium session against `code.pybricks.com`: (1) the file-list container's tag/roles/aria attributes and a recommended stable selector; (2) the per-file row structure and how to extract the file name (must map 1:1 to IndexedDB `path`); (3) whether class names look hashed/unstable; (4) how rows change when files are added (for the MutationObserver strategy); (5) an `elementFromPoint` hit-test note for context-menu positioning. Task 7 codes against this document.

- [ ] **Step 1: Write a scratchpad probe script** patterned on `test/e2e/drive.mjs` (read it first — reuse its Chromium discovery, extension loading, LNA flags, settings write, tour dismissal, and pull flow so `starter.py` lands in the editor and appears in the file list after reload).
- [ ] **Step 2: Dump the DOM around the file name.** After the post-pull reload, evaluate in the page: find the element whose `textContent` exactly matches the seeded file name (walk `document.body`, depth-first, innermost match), then print `outerHTML` of it and of 5 ancestor levels, plus `role`/`aria-*` attributes up the chain. Also seed a second file via `apply-files` + reload and dump again to see the multi-row shape.
- [ ] **Step 3: Write `test/e2e/file-list-dom.md`** with the findings: recommended container selector, row selector, name-extraction rule, observed HTML snippets (trimmed), and a fallback strategy ("find elements whose exact textContent matches a known `.py` path from `list-files`") for when the page's DOM changes. State the Chromium/pybricks-code version observed.
- [ ] **Step 4: Commit** — `git add test/e2e/file-list-dom.md && git commit -m "docs: discovered code.pybricks.com file-list DOM structure for phase-3 watcher"`

---

### Task 7: `src/file-list.js` — watcher, badges, context menu, long-press

**Files:**
- Create: `src/file-list.js`
- Modify: `src/content.js` (start the watcher)
- Modify: `manifest.json` (add `src/file-list.js` after `src/menu-panel.js`)

**Interfaces:**
- Consumes: `test/e2e/file-list-dom.md` selectors; `analyzeProgram` (menu-config.js); `menuPanel.addSlot(module, fn, blocks)`; storage key `lastPullManifest`; bridge op `list-files`.
- Produces: global `makeFileListWatcher(deps)` with `deps = { pageRequest, storageGet, addSlot }`, returning `{ start() }`. DOM contract: badge `span[data-pybricks-git-badge]`, context menu `div[data-pybricks-git-context-menu]` with `button[data-pybricks-git-context-item]` entries.

- [ ] **Step 1: Implement `src/file-list.js`:**

```js
// File-list integration (phase 3): a MutationObserver finds the page's file
// list (selectors documented in test/e2e/file-list-dom.md), badges protected
// files, and offers right-click / long-press "Add to menu".
//
// Classic script — no exports. content.js calls makeFileListWatcher({...}).

function makeFileListWatcher(deps) {
    const { pageRequest, storageGet, addSlot } = deps;

    let protectedPaths = new Set();
    let debounceTimer = null;

    async function start() {
        const manifest = await storageGet('lastPullManifest');
        protectedPaths = new Set((manifest && manifest.protected) || []);
        const observer = new MutationObserver(scheduleDecorate);
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleDecorate();
    }

    function scheduleDecorate() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => void decorate().catch(() => {}), 250);
    }

    async function decorate() {
        const rows = await findFileRows();
        for (const { row, path } of rows) {
            if (protectedPaths.has(path) && !row.querySelector('[data-pybricks-git-badge]')) {
                const badge = document.createElement('span');
                badge.dataset.pybricksGitBadge = '1';
                badge.textContent = ' 🔒';
                badge.title = "Managed by your coach's repo — edits here won't be committed";
                row.appendChild(badge);
            }
            if (!row.dataset.pybricksGitGestures) {
                row.dataset.pybricksGitGestures = '1';
                attachGestures(row, path);
            }
        }
    }

    // Selector strategy comes from test/e2e/file-list-dom.md. Fallback: match
    // any element whose exact textContent is a known .py path from the editor
    // (innermost such element's row ancestor), so a pybricks-code DOM change
    // degrades to "still works" instead of "silently gone".
    async function findFileRows() {
        // IMPLEMENT with the discovered primary selector, then the fallback.
        // Returns [{row: Element, path: string}] — path must equal the IDB path.
    }

    function attachGestures(row, path) {
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            void showMenu(path, ev.clientX, ev.clientY);
        });
        let pressTimer = null;
        row.addEventListener('touchstart', (ev) => {
            const t = ev.touches[0];
            pressTimer = setTimeout(() => void showMenu(path, t.clientX, t.clientY), 600);
        });
        for (const type of ['touchend', 'touchmove', 'touchcancel']) {
            row.addEventListener(type, () => clearTimeout(pressTimer));
        }
    }

    async function showMenu(path, x, y) {
        document.querySelector('[data-pybricks-git-context-menu]')?.remove();
        const listing = await pageRequest('list-files');
        const file = listing.contents.find((c) => c.path === path);
        if (!file) return;
        const info = analyzeProgram(path, file.contents);
        if (!info.module || protectedPaths.has(path)) return;

        const menu = document.createElement('div');
        menu.dataset.pybricksGitContextMenu = '1';
        Object.assign(menu.style, {
            position: 'fixed',
            left: `${Math.min(x, window.innerWidth - 240)}px`,
            top: `${Math.min(y, window.innerHeight - 160)}px`,
            background: '#2d2d30',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            padding: '4px',
            zIndex: 10001,
            font: 'inherit',
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            minWidth: '180px',
        });

        const entries = [{ label: `Add ${info.module} to menu`, fn: null }];
        for (const method of info.methods) {
            entries.push({ label: `Add ${info.module}.${method}() to menu`, fn: method });
        }
        for (const entry of entries) {
            const btn = document.createElement('button');
            btn.dataset.pybricksGitContextItem = entry.fn ? `${info.module}.${entry.fn}` : info.module;
            btn.textContent = entry.label;
            Object.assign(btn.style, {
                background: 'none', color: '#ddd', border: 'none',
                textAlign: 'left', padding: '6px 10px', cursor: 'pointer', font: 'inherit',
            });
            btn.addEventListener('mouseenter', () => (btn.style.background = '#3d3d40'));
            btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
            btn.addEventListener('click', () => {
                menu.remove();
                void addSlot(info.module, entry.fn, entry.fn ? info.isBlocks : false);
            });
            menu.appendChild(btn);
        }

        const dismiss = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                window.removeEventListener('pointerdown', dismiss, true);
                window.removeEventListener('keydown', onKey, true);
            }
        };
        const onKey = (ev) => {
            if (ev.key === 'Escape') {
                menu.remove();
                window.removeEventListener('pointerdown', dismiss, true);
                window.removeEventListener('keydown', onKey, true);
            }
        };
        window.addEventListener('pointerdown', dismiss, true);
        window.addEventListener('keydown', onKey, true);

        document.body.appendChild(menu);
    }

    return { start };
}
```

Fill in `findFileRows()` from the Task 6 document — primary selector first, exact-textContent fallback second (fetch known paths once per decorate via `pageRequest('list-files')`, cache for the debounce window).

- [ ] **Step 2: Wire into `src/content.js`** (after the panel wiring):

```js
const fileListWatcher = makeFileListWatcher({
    pageRequest,
    storageGet: (key) =>
        new Promise((resolve) => chrome.storage.local.get(key, (v) => resolve(v[key]))),
    addSlot: (module, fn, blocks) => menuPanel.addSlot(module, fn, blocks),
});
fileListWatcher.start().catch((err) => console.warn('[pybricks-git] file-list watcher failed:', err));
```

- [ ] **Step 3: Update `manifest.json`** ISOLATED `js`: `["src/menu-config.js", "src/menu-panel.js", "src/file-list.js", "src/content.js"]`.
- [ ] **Step 4: Verify** — `npm test`; CDP smoke: seed a repo whose manifest protects `menu.py`, pull, assert 🔒 badge on the `menu.py` row, right-click an eligible file → context menu appears → click "Add … to menu" → panel opens with the new slot.
- [ ] **Step 5: Commit** — `git commit -m "feat: file-list watcher — protected badges + add-to-menu context menu/long-press"`

---

### Task 8: phase-2 deferred notice fixes + docs

**Files:**
- Modify: `src/content.js` (`showProtectedNotice`)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Fix the protected notice** (deferred from phase 2 — copy was wrong when the *upstream* moved, and it had no a11y affordances). Replace the message text and add `role`/keyboard dismissal in `showProtectedNotice`:

```js
    box.setAttribute('role', 'status');
    box.tabIndex = 0;
    box.textContent =
        `${paths.join(', ')} ${one ? 'is' : 'are'} managed by your coach's repo, ` +
        `so your ${one ? 'version wasn\'t' : 'versions weren\'t'} committed. ` +
        `Pull to match the repo.`;
    box.title = 'Click or press Escape to dismiss';
    box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') box.remove();
    });
```

(keep the existing click-dismiss, timeout, and styles).

- [ ] **Step 2: Update `CLAUDE.md`:**
  - Architecture diagram/notes: mention the three new ISOLATED scripts and their load order.
  - New subsection "Menu manager (phase 3)" describing: menu-config.js pure helpers; the panel (`menuPanel` storage key, save-always-reloads decision and why); the file-list watcher (selectors doc pointer, badge, context menu); `lastPullManifest` storage key (and that consumers must intersect `protected` with the live file list).
  - inject.js bridge ops list: `list-files`, `apply-files` (deletes unlisted — never use for partial writes), `upsert-files` (partial, never deletes), `list-databases`.
  - Engine section: note `protectedSkipped` **order is unspecified** (deferred phase-2 doc item); note pull now persists `lastPullManifest`.
  - "Planned work" section: mark phase 3 done (mirror how phase 2 is described), leaving phase 4 as the remaining item.
  - Every claim must be fact-checked against the actual merged source — no aspirational docs.
- [ ] **Step 3: Run `npm test`** — green.
- [ ] **Step 4: Commit** — `git commit -m "fix: protected notice copy + a11y (deferred); docs: phase-3 architecture"`

---

### Task 9: E2E driver for the menu-manager flow

**Files:**
- Create: `test/e2e/drive-menu.mjs`
- Modify: `test/e2e/README.md` (short section documenting the new driver)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–8; the harness (`test/git-http-server.mjs`); the mechanics of `test/e2e/drive.mjs` (Chromium discovery, LNA flags, SW settings write, tour dismissal, trusted CDP input, exception capture — reuse those exact recipes; it's fine to copy code from drive.mjs, it is deliberately a self-contained script, but note any copied block's origin in a comment).

- [ ] **Step 1: Write `test/e2e/drive-menu.mjs`** — self-contained, exit 0 = PASS, screenshots `menu-failure.png` on failure / `menu-panel.png` on success. Scenario:

1. Seed the bare repo with: `.pybricks-git.json` (`{"schemaVersion":1,"menuConfig":"menu_config.py","protected":["menu.py"]}`), `menu.py` (`# framework\n`), `menu_config.py` (docstring + one item: `{"display": 1, "module": "mission_01", "function": "run"}`), `mission_01.py` (`def run(robot):\n    pass\n`), and `arm_moves.py` (a setup-only blocks file: line-1 sentinel + import + `left_motor = Motor(Port.A)` + `def lift_arm():` body).
2. Launch, write settings via the SW target, dismiss the tour, **Pull**, wait for the reload.
3. Assert via the SW target that `chrome.storage.local.lastPullManifest` equals `{protected: ['menu.py'], menuConfig: 'menu_config.py'}`.
4. Trusted-click the **Menu** toolbar button (`[data-pybricks-git-menu-btn]`). Assert `[data-pybricks-git-panel]` exists, `[data-pybricks-git-slot]` count is 1, and `[data-pybricks-git-programs]` contains an add button `[data-pybricks-git-add="arm_moves.lift_arm"]` (and does NOT contain one for `menu.py` — protected files are excluded).
5. Trusted-click `[data-pybricks-git-add="arm_moves.lift_arm"]` → slot count 2. Trusted-click `[data-pybricks-git-save]` → wait for the reload → assert the panel reopened by itself (persisted `open` flag).
6. Via the isolated world, `pageRequest('list-files')` → assert `menu_config.py` now parses to 2 items with the second `{display: 2, module: 'arm_moves', function: 'lift_arm', blocks: true}` (assert on the raw text containing `"module": "arm_moves", "function": "lift_arm", "blocks": True`).
7. Trusted-click **Commit**, Enter on the message input, wait for `✓`. Harness-side: assert the bare repo's `menu_config.py` contains the `arm_moves` line and `menu.py` is byte-identical to the seed (protection held end-to-end).
8. If the file-list selectors from Task 6 are stable in headless: assert the `menu.py` row carries `[data-pybricks-git-badge]` (if the file list doesn't render in this environment, log a SKIP line rather than failing — the badge path is covered by the Task 7 smoke).
9. Assert zero extension exceptions on both targets (same gate as drive.mjs).

- [ ] **Step 2: Run it** — `node test/e2e/drive-menu.mjs` until PASS. Also re-run `node test/e2e/drive.mjs` (the original flow must still pass) and `npm test`.
- [ ] **Step 3: Document** — add a "drive-menu.mjs" subsection to `test/e2e/README.md`: what it covers, how to run, what PASS looks like (paste the real label/assert lines from a passing run).
- [ ] **Step 4: Commit** — `git commit -m "test: E2E driver for the menu-manager panel round-trip"`

---

## Final wave (controller)

After Task 9: whole-branch review (Fable), triage any deferred minors into `.superpowers/sdd/progress.md`, controller re-runs `npm test` + both E2E drivers, then hand the merge decision to Brendon (do not push without his say-so).
