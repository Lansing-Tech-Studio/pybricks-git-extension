import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine } from './engine-helpers.mjs';

const BLOCK = '# pybricks blocks file:{"a":1,"b":[2,3]}\nfrom pybricks import *\n';

test('status reports configured with branch when settings exist', async () => {
    const { engine, server } = await setupEngine();
    try {
        assert.deepEqual(await engine.status(), {
            ok: true,
            configured: true,
            branch: 'main',
            head: null,
        });
    } finally {
        await server.close();
    }
});

test('status reports unconfigured when settings are missing', async () => {
    const { engine, storage, server } = await setupEngine();
    try {
        await storage.set({ settings: {} });
        const s = await engine.status();
        assert.equal(s.configured, false);
    } finally {
        await server.close();
    }
});

test('pull returns .py files (block files byte-exact), skips non-.py, records snapshot', async () => {
    const { engine, storage, server } = await setupEngine({
        'prog.py': BLOCK,
        'lib/util.py': 'def f(): pass\n',
        'README.md': '# not python\n',
    });
    try {
        const result = await engine.pull();
        assert.equal(result.pullWarning, '');
        assert.equal(result.head.length, 7);
        const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.contents]));
        assert.deepEqual(Object.keys(byPath).sort(), ['lib/util.py', 'prog.py']);
        assert.equal(byPath['prog.py'], BLOCK);
        assert.deepEqual((await storage.get('lastPullPaths')).sort(), ['lib/util.py', 'prog.py']);
    } finally {
        await server.close();
    }
});

test('pull from an empty repo warns but succeeds with no files', async () => {
    const { engine, server } = await setupEngine();
    try {
        const result = await engine.pull();
        assert.equal(result.files.length, 0);
        assert.notEqual(result.pullWarning, '');
    } finally {
        await server.close();
    }
});

test('pull without configuration throws a message pointing at the popup', async () => {
    const { engine, storage, server } = await setupEngine();
    try {
        await storage.set({ settings: {} });
        await assert.rejects(engine.pull(), /not configured/i);
    } finally {
        await server.close();
    }
});
