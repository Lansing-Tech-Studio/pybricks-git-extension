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
