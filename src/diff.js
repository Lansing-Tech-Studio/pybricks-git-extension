// Pure line-diff helpers for the History panel — no DOM, no globals touched.
// Loaded as a classic content script (ISOLATED world) before history-panel.js
// and by test/load-diff.mjs in Node. Shares one global scope with the other
// content scripts, so every top-level name here must be unique across src/.
//
// Diffs are line-based. A file is split on '\n'; a missing newline on the last
// line is remembered (`noEol`) and counts as a difference, as it does in git.
// Block programs (line 1 is the Blockly workspace JSON) are diffed on their
// Python body only: the generated Python mirrors the blocks, and the JSON line
// is a single unreadable line that would dominate every hunk. The header's
// change is reported separately as `blocksChanged` / `layoutOnly`.

// Splits text into [{text, noEol}] lines. 'a\nb\n' → two lines; 'a\nb' → two
// lines with the last marked noEol; '' → no lines.
function splitDiffLines(text) {
    if (text === '' || text == null) return [];
    const parts = String(text).split('\n');
    const noEol = parts[parts.length - 1] !== '';
    if (!noEol) parts.pop();
    return parts.map((t, i) => ({ text: t, noEol: noEol && i === parts.length - 1 }));
}

function diffLineKey(line) {
    return line.noEol ? `${line.text}\u0000` : line.text;
}

// Myers' O(ND) shortest-edit-script over two arrays of keys. Returns the list
// of edits as [{type: 'same'|'add'|'del', i, j}] in order, or null when the
// edit distance exceeds `cap` (the caller then falls back to a whole replace,
// which bounds memory on pathological inputs).
function myersEdits(a, b, cap) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const limit = Math.min(max, cap);
    const offset = limit + 1;
    let v = new Array(2 * offset + 1).fill(0);
    const trace = [];
    let found = false;
    for (let d = 0; d <= limit; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
            else x = v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = true;
                break;
            }
        }
        if (found) break;
    }
    if (!found) return null;
    // Backtrack.
    const edits = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d];
        const k = x - y;
        let prevK;
        if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
        else prevK = k - 1;
        const prevX = vd[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            x--;
            y--;
            edits.push({ type: 'same', i: x, j: y });
        }
        if (d > 0) {
            if (x === prevX) {
                y--;
                edits.push({ type: 'add', i: x, j: y });
            } else {
                x--;
                edits.push({ type: 'del', i: x, j: y });
            }
        }
    }
    edits.reverse();
    return edits;
}

const DIFF_EDIT_CAP = 2000;

// Line diff of two texts. Returns ops in order: {type, text, noEol, aLine?,
// bLine?} with 1-based line numbers (aLine for same/del, bLine for same/add).
// Common prefix and suffix are trimmed before the Myers pass.
function diffLines(aText, bText, { cap = DIFF_EDIT_CAP } = {}) {
    const a = splitDiffLines(aText);
    const b = splitDiffLines(bText);
    const ak = a.map(diffLineKey);
    const bk = b.map(diffLineKey);
    let pre = 0;
    while (pre < a.length && pre < b.length && ak[pre] === bk[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && ak[a.length - 1 - suf] === bk[b.length - 1 - suf]) suf++;

    const midA = ak.slice(pre, a.length - suf);
    const midB = bk.slice(pre, b.length - suf);
    let edits = myersEdits(midA, midB, cap);
    if (!edits) {
        // Too different to diff cheaply: show the middle as a whole replace.
        edits = [];
        for (let i = 0; i < midA.length; i++) edits.push({ type: 'del', i, j: 0 });
        for (let j = 0; j < midB.length; j++) edits.push({ type: 'add', i: midA.length, j });
    }

    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ type: 'same', text: a[i].text, noEol: a[i].noEol, aLine: i + 1, bLine: i + 1 });
    for (const e of edits) {
        if (e.type === 'same') {
            const la = a[pre + e.i];
            ops.push({ type: 'same', text: la.text, noEol: la.noEol, aLine: pre + e.i + 1, bLine: pre + e.j + 1 });
        } else if (e.type === 'del') {
            const la = a[pre + e.i];
            ops.push({ type: 'del', text: la.text, noEol: la.noEol, aLine: pre + e.i + 1 });
        } else {
            const lb = b[pre + e.j];
            ops.push({ type: 'add', text: lb.text, noEol: lb.noEol, bLine: pre + e.j + 1 });
        }
    }
    for (let k = 0; k < suf; k++) {
        const ai = a.length - suf + k;
        const bi = b.length - suf + k;
        ops.push({ type: 'same', text: a[ai].text, noEol: a[ai].noEol, aLine: ai + 1, bLine: bi + 1 });
    }
    return ops;
}

// Groups ops into hunks with `context` unchanged lines around each change;
// hunks whose context would touch or overlap are merged. Each hunk is
// {aStart, aCount, bStart, bCount, lines} where lines are the ops themselves.
function toHunks(ops, context = 3) {
    const changed = [];
    for (let i = 0; i < ops.length; i++) if (ops[i].type !== 'same') changed.push(i);
    if (!changed.length) return [];
    const ranges = [];
    let start = Math.max(0, changed[0] - context);
    let end = Math.min(ops.length - 1, changed[0] + context);
    for (let c = 1; c < changed.length; c++) {
        const s = Math.max(0, changed[c] - context);
        const e = Math.min(ops.length - 1, changed[c] + context);
        if (s <= end + 1) end = e;
        else {
            ranges.push([start, end]);
            start = s;
            end = e;
        }
    }
    ranges.push([start, end]);
    return ranges.map(([s, e]) => {
        const lines = ops.slice(s, e + 1);
        const aLines = lines.filter((l) => l.aLine != null);
        const bLines = lines.filter((l) => l.bLine != null);
        return {
            aStart: aLines.length ? aLines[0].aLine : (lines[0].aLine ?? aBefore(ops, s)),
            aCount: aLines.length,
            bStart: bLines.length ? bLines[0].bLine : (lines[0].bLine ?? bBefore(ops, s)),
            bCount: bLines.length,
            lines,
        };
    });
}

// Position in A/B just before op index `s` — only needed for a hunk made
// purely of adds (no aLine) or purely of dels (no bLine).
function aBefore(ops, s) {
    for (let i = s - 1; i >= 0; i--) if (ops[i].aLine != null) return ops[i].aLine;
    return 0;
}
function bBefore(ops, s) {
    for (let i = s - 1; i >= 0; i--) if (ops[i].bLine != null) return ops[i].bLine;
    return 0;
}

// Splits a block program into its line-1 header and the Python body. A plain
// text file has header null and body === contents. The sentinel is spelled
// inline on purpose: this script must not redeclare blocksplice.js's constant.
function splitBlocksFile(contents) {
    const text = String(contents ?? '');
    if (!text.startsWith('# pybricks blocks file:')) return { header: null, body: text };
    const nl = text.indexOf('\n');
    if (nl === -1) return { header: text, body: '' };
    return { header: text.slice(0, nl), body: text.slice(nl + 1) };
}

// Diffs two file sets ([{path, contents}]) into one entry per path, sorted:
// {path, status: 'added'|'modified'|'deleted'|'unchanged', ops, hunks,
//  added, deleted, isBlocks, blocksChanged, layoutOnly}
// `ops` is the full line diff (for the whole-file view); `hunks` the
// context-trimmed one. Unchanged entries carry neither. Block programs are
// compared on their Python body; a header-only change (blocks moved on the
// canvas, same code) is a 'modified' entry with layoutOnly: true and no hunks.
function diffFileSets(before, after, { context = 3 } = {}) {
    const bMap = new Map((before ?? []).map((f) => [f.path, f.contents ?? '']));
    const aMap = new Map((after ?? []).map((f) => [f.path, f.contents ?? '']));
    const paths = [...new Set([...bMap.keys(), ...aMap.keys()])].sort();
    const out = [];
    for (const path of paths) {
        const hasB = bMap.has(path);
        const hasA = aMap.has(path);
        const bText = hasB ? bMap.get(path) : '';
        const aText = hasA ? aMap.get(path) : '';
        const bParts = splitBlocksFile(bText);
        const aParts = splitBlocksFile(aText);
        const isBlocks = bParts.header != null || aParts.header != null;
        const entry = {
            path,
            status: 'unchanged',
            ops: [],
            hunks: [],
            added: 0,
            deleted: 0,
            isBlocks,
            blocksChanged: false,
            layoutOnly: false,
        };
        if (hasB && hasA && bText === aText) {
            out.push(entry);
            continue;
        }
        entry.status = !hasB ? 'added' : !hasA ? 'deleted' : 'modified';
        entry.blocksChanged = isBlocks && bParts.header !== aParts.header;
        entry.ops = diffLines(bParts.body, aParts.body);
        entry.hunks = toHunks(entry.ops, context);
        for (const op of entry.ops) {
            if (op.type === 'add') entry.added++;
            else if (op.type === 'del') entry.deleted++;
        }
        entry.layoutOnly = entry.status === 'modified' && entry.blocksChanged && entry.added === 0 && entry.deleted === 0;
        out.push(entry);
    }
    return out;
}
