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
    if (!json || !json.blocks || !Array.isArray(json.blocks.blocks)) {
        return { head: null, chain: null, error: 'unrecognized block file layout' };
    }
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

// Builds the id -> {name, type} lookup, skipping non-object entries (corrupt
// files can carry e.g. null in variables[]; a chain ref pointing at one is
// simply unresolvable, reported by the callers' existing dangling-ref error).
function variablesById(variables) {
    const byId = new Map();
    for (const v of variables) {
        if (!v || typeof v !== 'object') continue;
        byId.set(v.id, { name: v.name, type: v.type });
    }
    return byId;
}

// Collects every variable id referenced in the chain: the set blocks'
// fields.VAR.id and any nested fields.VAR.id in shadows/blocks (a
// variables_get_* shadow carries {id, name, type} but the variables array is
// the source of truth for resolution).
function chainVariableRefs(chain, variables) {
    // try/catch backstop: the walk recurses over attacker-controllable JSON, so
    // a pathologically deep tree could blow the stack. Never-throws is the
    // locked contract for every function here — degrade to an error string.
    try {
        const byId = variablesById(variables);
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
    } catch {
        return { refs: null, error: "couldn't read the setup section" };
    }
}

function setupSignature(contents) {
    // try/catch backstop (same reason as chainVariableRefs): the canonicalize
    // recurses over the line-1 JSON, and loadState calls this bare per program —
    // an unguarded stack overflow here would wedge the whole panel open.
    try {
        const parsed = parseBlocksFile(contents);
        if (parsed.error) return { signature: null, error: parsed.error };
        const found = findSetupChain(parsed.json);
        if (found.error) return { signature: null, error: found.error };
        const byId = variablesById(parsed.json.variables);
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
    } catch {
        return { signature: null, error: "couldn't read the setup section" };
    }
}

// The setup marker is version-dependent (blocks-format.md Q1/consequence 3):
// v1.3.2 files say "# Set up all devices.", the current v2.0.0 editor says
// "# Set up." — anchor tolerantly on either, never on one literal.
const SETUP_MARKERS = ['# Set up all devices.', '# Set up.'];
const START_MARKER = '# The main program starts here.';
// Module (line) order is fixed by package, not alphabetical (blocks-format.md
// Q4). Unlisted modules fall back to alphabetical after these.
const PYBRICKS_MODULE_ORDER = ['hubs', 'parameters', 'pupdevices', 'robotics', 'tools'];

// Verbatim contents of test/fixtures/empty-program.py — exactly what the
// editor's own new-file dialog produces for a blocks program (empty
// blockGlobalSetup with no `next`, default blockGlobalStart + blockPrint, 10
// ColorDef vars; blocks-format.md Q2/consequence 7). Block/variable ids are
// workspace-local (Q5) so sharing this scaffold across created files is safe.
// Only backticks are escaped; the source has no `${` or backslashes.
const EMPTY_PROGRAM_CONTENTS = `# pybricks blocks file:{"blocks":{"languageVersion":0,"blocks":[{"type":"blockGlobalSetup","id":"bjK,wS1MYO7aiYkFSwd{","x":150,"y":100,"deletable":false},{"type":"blockGlobalStart","id":"3tJe|AWl0baN(wH9a$@.","x":150,"y":300,"deletable":false,"next":{"block":{"type":"blockPrint","id":"j,,T}?rBkaW$1v?olp4p","extraState":{"optionLevel":0},"inputs":{"TEXT0":{"shadow":{"type":"text","id":"!x5.0YiWya^\`(y)yO5B8","fields":{"TEXT":"Hello, Pybricks!"}}}}}}}]},"variables":[{"name":"red","id":"H7t84x:~=X%ju!|M_0QH","type":"ColorDef"},{"name":"orange","id":"v_LATps@6?P|wyz8+y.M","type":"ColorDef"},{"name":"yellow","id":"hP]$V;#C(,5+ijKxHW]J","type":"ColorDef"},{"name":"green","id":"k2kCCY{25GV4Wr{Oha^F","type":"ColorDef"},{"name":"cyan","id":"m{gpb5n|Tz%Sq/G;MoZF","type":"ColorDef"},{"name":"blue","id":"X9iFJOsU#gKmMF(A/(}2","type":"ColorDef"},{"name":"violet","id":"z^L^)Q(D5{DZuPhv,QG!","type":"ColorDef"},{"name":"magenta","id":"n=3K08qYat2{eDEuNN^~","type":"ColorDef"},{"name":"white","id":"WYf[B9;jW-iy=v:].hvH","type":"ColorDef"},{"name":"none","id":"*h:02-E2]Su]wf\`-|3#Z","type":"ColorDef"}],"info":{"type":"pybricks","version":"2.0.0"},"workspaceOptions":{"scrollX":0,"scrollY":0,"scale":1}}
# The main program starts here.
print('Hello, Pybricks!')
`;

// Recursively add every `id` string value under `node` to `out`, skipping the
// `except` subtree entirely (the old setup head we are about to replace).
function collectIdsExcept(node, out, except) {
    if (node === except) return;
    if (Array.isArray(node)) { for (const x of node) collectIdsExcept(x, out, except); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
        if (k === 'id' && typeof v === 'string') out.add(v);
        else collectIdsExcept(v, out, except);
    }
}

// Structural (block/shadow) ids only — skips the `VAR` subtree so remapped
// variable references are NOT mistaken for structural id collisions.
function collectStructuralIds(node, out) {
    if (Array.isArray(node)) { for (const x of node) collectStructuralIds(x, out); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
        if (k === 'VAR') continue;
        if (k === 'id' && typeof v === 'string') out.add(v);
        else collectStructuralIds(v, out);
    }
}

// Rewrite every fields.VAR.id in the copied chain to the target's id for that
// variable (per `remap`); name/type are left exactly as the template wrote them.
function remapVarIds(node, remap) {
    if (Array.isArray(node)) { for (const x of node) remapVarIds(x, remap); return; }
    if (!node || typeof node !== 'object') return;
    if (node.VAR && typeof node.VAR === 'object' && typeof node.VAR.id === 'string' && remap.has(node.VAR.id)) {
        node.VAR.id = remap.get(node.VAR.id);
    }
    for (const v of Object.values(node)) remapVarIds(v, remap);
}

// The leading run of import-block lines, up to the first blank line.
function importBlockLines(python) {
    const lines = python.split('\n');
    const block = [];
    for (const line of lines) {
        if (line.trim() === '') break;
        block.push(line);
    }
    return block;
}

// Locate the setup section: the marker line (tolerant anchor) through the last
// consecutive non-blank line after it. Returns {start, end} indices, or null.
function locateSetupSection(lines) {
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (SETUP_MARKERS.includes(lines[i])) { start = i; break; }
    }
    if (start === -1) return null;
    let end = start;
    for (let j = start + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') break;
        end = j;
    }
    return { start, end };
}

// Union of the two files' `from pybricks.<mod> import <names>` lines: names
// unioned + deduped + alphabetical, module lines in package order. The target's
// own name set is never reduced (its program body needs those imports); extra
// unused names self-heal on the editor's next regenerate (blocks-format.md
// Q1/Q4). Non-`from pybricks.` import lines from the TARGET are preserved first.
function mergeImportLines(targetPython, templatePython) {
    try {
        const re = /^from pybricks\.([a-z]+) import (.+)$/;
        const byModule = new Map();
        const nonPybricks = [];
        const ingest = (python, keepNonPybricks) => {
            for (const line of importBlockLines(python)) {
                const m = line.match(re);
                if (m) {
                    if (!byModule.has(m[1])) byModule.set(m[1], new Set());
                    for (const n of m[2].split(',').map((s) => s.trim()).filter(Boolean)) byModule.get(m[1]).add(n);
                } else if (keepNonPybricks && /^(import |from )/.test(line)) {
                    nonPybricks.push(line);
                }
            }
        };
        ingest(targetPython, true);
        ingest(templatePython, false);
        const rank = (mod) => {
            const i = PYBRICKS_MODULE_ORDER.indexOf(mod);
            return i === -1 ? PYBRICKS_MODULE_ORDER.length : i;
        };
        const modules = [...byModule.keys()].sort((a, b) =>
            (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0));
        const pybricksLines = modules.map((mod) =>
            `from pybricks.${mod} import ${[...byModule.get(mod)].sort().join(', ')}`);
        return { lines: [...nonPybricks, ...pybricksLines], error: null };
    } catch {
        return { lines: null, error: 'couldn’t read the program’s imports' };
    }
}

// Swap the target's setup section for the template's (written verbatim), and
// its leading pybricks import block for `mergedImportLines`. A marker-less
// target (empty program) gets the imports + template section inserted above the
// start marker. Everything between the import block and the marker, and
// everything after the section, is preserved byte-for-byte.
function replaceSetupSection(targetPython, templatePython, mergedImportLines) {
    try {
        const templateLines = templatePython.split('\n');
        const tmplSec = locateSetupSection(templateLines);
        if (!tmplSec) return { python: null, error: 'the team setup file has no setup section' };
        const templateSection = templateLines.slice(tmplSec.start, tmplSec.end + 1);
        const merged = Array.isArray(mergedImportLines) ? mergedImportLines : [];

        const targetLines = targetPython.split('\n');
        const targetSec = locateSetupSection(targetLines);
        if (targetSec) {
            let importEnd = 0;
            while (importEnd < targetLines.length && targetLines[importEnd].trim() !== '') importEnd++;
            const middle = targetLines.slice(importEnd, targetSec.start);
            const tail = targetLines.slice(targetSec.end + 1);
            return { python: [...merged, ...middle, ...templateSection, ...tail].join('\n'), error: null };
        }

        // Marker-less target: insert imports + section above the start marker.
        const startIdx = targetLines.findIndex((l) => l === START_MARKER);
        if (startIdx === -1) return { python: null, error: 'this program has no setup section to update' };
        const insertion = [...merged, '', ...templateSection, ''];
        return { python: [...targetLines.slice(0, startIdx), ...insertion, ...targetLines.slice(startIdx)].join('\n'), error: null };
    } catch {
        return { python: null, error: 'couldn’t rewrite the program’s setup section' };
    }
}

// Replace the target block file's setup chain with the team template's, remapping
// variable ids by name+type. Safety rails (blocks-format.md + task spec): all
// eligibility checks run BEFORE any mutation; on any doubt we skip and report a
// kid-facing reason instead of guessing. Never throws.
function spliceSetup(targetContents, templateContents) {
    try {
        const skip = (error) => ({ contents: null, changed: false, error });

        const target = parseBlocksFile(targetContents);
        if (target.error) return skip(target.error);
        const template = parseBlocksFile(templateContents);
        if (template.error) return skip(template.error);

        const targetFound = findSetupChain(target.json);
        if (targetFound.error) return skip(targetFound.error);
        const templateFound = findSetupChain(template.json);
        if (templateFound.error) return skip(templateFound.error);

        const targetRefsR = chainVariableRefs(targetFound.chain, target.json.variables);
        if (targetRefsR.error) return skip(targetRefsR.error);
        const templateRefsR = chainVariableRefs(templateFound.chain, template.json.variables);
        if (templateRefsR.error) return skip(templateRefsR.error);

        // Step 2: chains already match -> no-op.
        const targetSig = setupSignature(targetContents);
        if (targetSig.error) return skip(targetSig.error);
        const templateSig = setupSignature(templateContents);
        if (templateSig.error) return skip(templateSig.error);
        if (targetSig.signature === templateSig.signature) {
            return { contents: null, changed: false, error: null };
        }

        // Step 3a: match template refs to target variables by name+type; build
        // the id remap and the list of template-only variables to ADD.
        const targetVarsByName = new Map();
        for (const v of target.json.variables) {
            if (v && typeof v === 'object' && typeof v.name === 'string' && !targetVarsByName.has(v.name)) {
                targetVarsByName.set(v.name, v);
            }
        }
        const remap = new Map();
        const additions = [];
        for (const [tId, meta] of templateRefsR.refs) {
            const tv = targetVarsByName.get(meta.name);
            if (tv) {
                if (tv.type !== meta.type) return skip(`device "${meta.name}" has a different type in this program`);
                remap.set(tId, tv.id);
            } else {
                additions.push({ name: meta.name, id: tId, type: meta.type });
                remap.set(tId, tId);
            }
        }

        // Step 4: reverse check — a device the target has in setup but the
        // template doesn't means the kid wired their own hardware; don't orphan
        // it. (Runs before the addition collision check so this kid-meaningful
        // reason wins when both apply.)
        const templateNameType = new Set();
        for (const meta of templateRefsR.refs.values()) templateNameType.add(meta.name + ' ' + meta.type);
        for (const meta of targetRefsR.refs.values()) {
            if (!templateNameType.has(meta.name + ' ' + meta.type)) {
                return skip(`this program has its own device "${meta.name}" in setup — update it by hand`);
            }
        }

        // Every id in the target OUTSIDE the old setup head — the collision set.
        const allTargetIds = new Set();
        collectIdsExcept(target.json, allTargetIds, targetFound.head);

        // Step 3b: an added variable's id must not collide with an existing id.
        for (const add of additions) {
            if (allTargetIds.has(add.id)) return skip('internal id collision — skipped to be safe');
        }

        // Step 5: build the new head. Deep-copy the template head, keep the
        // target's head id and canvas position (a target head with no x/y keeps
        // the template's), and remap variable references to the target's ids.
        const newHead = structuredClone(templateFound.head);
        newHead.id = targetFound.head.id;
        if ('x' in targetFound.head) newHead.x = targetFound.head.x;
        if ('y' in targetFound.head) newHead.y = targetFound.head.y;
        remapVarIds(newHead, remap);

        // Copied chain block/shadow ids are workspace-local and may be reused,
        // but a collision with an id elsewhere in the target file is unsafe -> skip.
        const chainIds = new Set();
        collectStructuralIds(newHead, chainIds);
        for (const id of chainIds) {
            if (id === targetFound.head.id) continue; // the intentional head id
            if (allTargetIds.has(id)) return skip('internal id collision — skipped to be safe');
        }

        // Step 7: Python rewrite (computed before mutating, so a template that
        // lacks a setup marker skips cleanly with nothing half-applied).
        const mi = mergeImportLines(target.python, template.python);
        if (mi.error) return skip(mi.error);
        const rs = replaceSetupSection(target.python, template.python, mi.lines);
        if (rs.error) return skip(rs.error);

        // --- All eligibility passed. Mutate the target JSON. ---
        // Step 3 (apply): add template-only variables.
        for (const add of additions) target.json.variables.push({ name: add.name, id: add.id, type: add.type });
        // Step 6: replace the blockGlobalSetup entry; everything else untouched.
        const idx = target.json.blocks.blocks.indexOf(targetFound.head);
        if (idx === -1) return skip('couldn’t locate the setup section to replace');
        target.json.blocks.blocks[idx] = newHead;

        // Step 8: reassemble.
        const contents = BLOCKS_FILE_SENTINEL + JSON.stringify(target.json) + '\n' + rs.python;
        return { contents, changed: true, error: null };
    } catch {
        return { contents: null, changed: false, error: 'couldn’t update the setup — skipped to be safe' };
    }
}

// New-program seed: splice the team setup chain onto the editor-authored empty
// program scaffold. The scaffold is internal (EMPTY_PROGRAM_CONTENTS).
function newProgramContents(teamSetupContents) {
    const r = spliceSetup(EMPTY_PROGRAM_CONTENTS, teamSetupContents);
    return { contents: r.contents, error: r.error };
}
