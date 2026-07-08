import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine } from './engine-helpers.mjs';

const MANIFEST = JSON.stringify({
    schemaVersion: 1,
    protected: ['.pybricks-git.json', 'menu.py', 'main.py'],
});

test('pull returns the manifest protected list and still filters files to .py', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        const result = await engine.pull();
        assert.deepEqual([...result.protected].sort(), ['.pybricks-git.json', 'main.py', 'menu.py']);
        // manifest is not .py, so it is never handed to the editor
        assert.deepEqual(result.files.map((f) => f.path).sort(), ['menu.py', 'team.py']);
    } finally {
        await server.close();
    }
});

test('pull with no manifest returns an empty protected list', async () => {
    const { engine, server } = await setupEngine({ 'main.py': 'x = 1\n' });
    try {
        const result = await engine.pull();
        assert.deepEqual(result.protected, []);
    } finally {
        await server.close();
    }
});

test('pull tolerates a malformed manifest as no protection', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': '{not json',
        'main.py': 'x = 1\n',
    });
    try {
        const result = await engine.pull();
        assert.deepEqual(result.protected, []);
        assert.equal(result.files.length, 1); // pull itself still works
    } finally {
        await server.close();
    }
});

test('pull ignores a manifest with the wrong schemaVersion', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 2, protected: ['menu.py'] }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await engine.pull()).protected, []);
    } finally {
        await server.close();
    }
});

test('pull ignores a manifest whose protected key is not an array, and drops non-string entries', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: 'menu.py' }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await engine.pull()).protected, []);
    } finally {
        await server.close();
    }
});

test('pull from an empty repo returns protected: []', async () => {
    const { engine, server } = await setupEngine();
    try {
        const result = await engine.pull();
        assert.notEqual(result.pullWarning, '');
        assert.deepEqual(result.protected, []);
    } finally {
        await server.close();
    }
});

test('pull drops non-string entries from the protected list', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: ['menu.py', 7, null] }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await engine.pull()).protected, ['menu.py']);
    } finally {
        await server.close();
    }
});
