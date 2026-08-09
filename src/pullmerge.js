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
//   local          [{path, contents, sha}]  the editor now; `sha` is the
//                                           metadata row's sha256, and a
//                                           missing one counts as edited —
//                                           the safe direction, a spurious
//                                           rescue rather than a silent loss
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
