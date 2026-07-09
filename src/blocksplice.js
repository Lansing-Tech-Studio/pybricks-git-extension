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

// spliceSetup / mergeImportLines / replaceSetupSection / newProgramContents:
// implemented in the splice task. Stubs keep the test loader stable.
function spliceSetup() { return { contents: null, changed: false, error: 'not implemented' }; }
function mergeImportLines() { return { lines: null, error: 'not implemented' }; }
function replaceSetupSection() { return { python: null, error: 'not implemented' }; }
function newProgramContents() { return { contents: null, error: 'not implemented' }; }
