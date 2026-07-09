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
    test('null / shapeless json -> error, never throws', () => {
        assert.notEqual(api.findSetupChain(null).error, null);
        assert.notEqual(api.findSetupChain({}).error, null);
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
    test('non-object variables entries are skipped, never throw', () => {
        const { json } = api.parseBlocksFile(DEMO);
        const { chain } = api.findSetupChain(json);
        const r = api.chainVariableRefs(chain, [null, ...json.variables]);
        assert.equal(r.error, null);
        // a referenced entry replaced by null -> unresolvable -> error, not throw
        const holed = json.variables.map((v) => (v.name === 'prime hub' ? null : v));
        assert.notEqual(api.chainVariableRefs(chain, holed).error, null);
    });
});

describe('setupSignature', () => {
    test('identical for a file and itself', () => {
        const a = api.setupSignature(DEMO);
        assert.equal(a.error, null);
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
    test('null variables entries -> error only when referenced, never throws', () => {
        // Rebuild DEMO's line 1 with a null variable entry via JSON surgery.
        const withNullAt = (index) => {
            const nl = DEMO.indexOf('\n');
            const sentinel = '# pybricks blocks file:';
            const json = JSON.parse(DEMO.slice(sentinel.length, nl));
            json.variables[index] = null;
            return sentinel + JSON.stringify(json) + DEMO.slice(nl);
        };
        // variables[0] is a ColorDef the setup chain never references: still fine.
        const unreferenced = api.setupSignature(withNullAt(0));
        assert.equal(unreferenced.error, null);
        assert.equal(unreferenced.signature, api.setupSignature(DEMO).signature);
        // variables[10] is "prime hub", referenced by the chain: error, not throw.
        assert.notEqual(api.setupSignature(withNullAt(10)).error, null);
    });
});

// --- Line-1 surgery helpers, used to build variant fixtures for the splice. ---
const SENTINEL = '# pybricks blocks file:';
function splitFile(contents) {
    const nl = contents.indexOf('\n');
    return { json: JSON.parse(contents.slice(SENTINEL.length, nl)), python: contents.slice(nl + 1) };
}
function joinFile(json, python) {
    return SENTINEL + JSON.stringify(json) + '\n' + python;
}

// DEMO_AS_TEMPLATE models a teammate's setup file whose device chain already
// matches this program exactly — only the canvas position / editor version
// differ (both stripped from the signature). The splice must no-op.
const DEMO_AS_TEMPLATE = (() => {
    const { json, python } = splitFile(DEMO);
    const head = json.blocks.blocks.find((b) => b.type === 'blockGlobalSetup');
    head.x = 999;
    head.y = 888;
    json.info.version = '2.0.0';
    return joinFile(json, python);
})();

// TEMPLATE_WITH_EXTRA models the coach adding one more device (an "arm motor")
// to the shared team setup file after kids already have programs. Splicing must
// ADD that new variable to each kid's program (extra-sensor propagation).
const TEMPLATE_WITH_EXTRA = (() => {
    const { json, python } = splitFile(SETUP_ONLY);
    const armBlock = {
        type: 'variables_set_motor',
        id: 'arm-set-block-id-001', // fresh, non-colliding structural ids
        fields: { VAR: { id: 'arm-motor-new-id-000' } },
        inputs: {
            PORT: { shadow: { type: 'blockParametersPort', id: 'arm-port-shadow-0001', fields: { NAME: 'C' } } },
            POSITIVE_DIRECTION: { shadow: { type: 'blockParametersDirection', id: 'arm-dir-shadow-00001', fields: { SELECTION: 'Direction.CLOCKWISE' } } },
        },
    };
    let node = json.blocks.blocks.find((b) => b.type === 'blockGlobalSetup').next.block;
    while (node.next && node.next.block) node = node.next.block;
    node.next = { block: armBlock };
    json.variables.push({ name: 'arm motor', id: 'arm-motor-new-id-000', type: 'Motor' });
    return joinFile(json, python);
})();

describe('spliceSetup', () => {
    test('same-signature target -> changed:false, contents null', () => {
        const r = api.spliceSetup(DEMO, DEMO_AS_TEMPLATE); // identical chains
        assert.equal(r.error, null);
        assert.equal(r.changed, false);
        assert.equal(r.contents, null);
    });
    test('port change propagates; ids remapped to target; program body untouched', () => {
        const target = DEMO; // Port F
        // The team's setup file: left wheel moved from Port F to Port A (the
        // editor keeps line-1 JSON and generated Python in sync, so both change).
        const template = SETUP_ONLY.replace('"NAME":"F"', '"NAME":"A"').replace('Port.F', 'Port.A');
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
        // program body (non-setup blocks) byte-identical
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
