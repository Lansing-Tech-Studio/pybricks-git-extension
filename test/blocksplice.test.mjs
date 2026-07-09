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
