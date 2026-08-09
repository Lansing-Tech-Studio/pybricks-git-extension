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

// Task 2 replaces this stub with the real merge-planning function.
function planPull() {}
