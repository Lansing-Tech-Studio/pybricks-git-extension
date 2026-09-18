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

// Decides what the editor should hold after a Pull. `files` is the COMPLETE
// desired set for the `apply-files` op — that op deletes every path it isn't
// given, so anything omitted here is destroyed.
//
//   local          [{path, contents, sha}]  the editor now; `sha` is a
//                                           SHA-256 of `contents` recomputed
//                                           by the caller, not read off
//                                           Pybricks' stored metadata
//   repo           [{path, contents}]       what the Pull fetched
//   base           {path: sha}              lastPullShas: the last state the
//                                           editor and the repo agreed on
//   protectedPaths [path]                   coach-managed; when the repo has
//                                           the file (now or per `base`), it
//                                           always wins and no copy is kept.
//                                           A protected name absent from both
//                                           `base` and `repo` has no coach
//                                           version to restore, so it's just
//                                           an ordinary local-only file.
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
            // the name — uncontested, so it keeps it. Applies even to a
            // protected name: with no repo/base version, "protected" has
            // nothing to protect.
            files.push({ path: f.path, contents: f.contents });
            continue;
        }
        // Coach-managed and the repo has a say (it has the file now, or it
        // did per `base` and has since removed it): the repo wins and a
        // _mine copy would be clutter the kid can't use, since commitOp
        // refuses to push protected paths anyway.
        if (prot.has(f.path)) continue;

        if (upstream === f.contents) continue; // edited into agreement

        const savedAs = rescueName(f.path, taken);
        taken.add(savedAs);
        files.push({ path: savedAs, contents: f.contents });
        rescued.push({ path: f.path, savedAs });
    }
    return { files, rescued };
}

// --- Open-tab cleanup ---------------------------------------------------------
//
// Pybricks remembers open editor tabs in sessionStorage, as a JSON array of
// file uuids under `editor.activeFileHistory.<window.name>.<editorId>`
// (pybricks-code src/editor/lib.ts ActiveFileHistoryManager), and reopens each
// on load. A uuid whose file a Pull deleted fails that reopen with an
// "unexpected error" toast ("file with uuid '…' not found"). These helpers
// find the uuids a Pull removes and plan pruning them from that history;
// content.js does the sessionStorage reads and writes.

const OPEN_TAB_HISTORY_PREFIX = 'editor.activeFileHistory.';

// uuids of the editor's files that are absent from `keptPaths` — exactly what
// apply-files deletes when handed a file set with those paths.
//   metadata   [{path, uuid}]   the editor's metadata rows before the apply
//   keptPaths  [path]           the paths passed to apply-files
function deletedUuids(metadata, keptPaths) {
    const kept = new Set(keptPaths);
    return metadata.filter((m) => !kept.has(m.path)).map((m) => m.uuid);
}

// One history value with `uuids` removed. Returns the new JSON string, or null
// when nothing changes (including a value that isn't a JSON array — Pybricks
// itself treats that as empty, so it's left alone).
function pruneTabHistory(value, uuids) {
    let history;
    try {
        history = JSON.parse(value);
    } catch {
        return null;
    }
    if (!Array.isArray(history)) return null;
    const drop = new Set(uuids);
    const pruned = history.filter((u) => !drop.has(u));
    return pruned.length === history.length ? null : JSON.stringify(pruned);
}

// Plans the rewrites for every open-tab history entry. `entries` is
// [[key, value]] as read from sessionStorage by the caller (content.js does
// the storage I/O; this stays pure). Returns [[key, newValue]] for just the
// keys that change.
function planTabPrunes(entries, uuids) {
    if (!uuids.length) return [];
    const writes = [];
    for (const [key, value] of entries) {
        if (typeof key !== 'string' || !key.startsWith(OPEN_TAB_HISTORY_PREFIX)) continue;
        const next = pruneTabHistory(value, uuids);
        if (next !== null) writes.push([key, next]);
    }
    return writes;
}
