import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine } from './engine-helpers.mjs';
import { bareHead, bareFile } from './git-http-server.mjs';

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

test('commit keeps the tree version of an edited protected file and reports it', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 999\n' },
                { path: 'team.py', contents: 'x = 2\n' },
            ],
            message: 'edit both',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.equal(bareFile(bare, 'menu.py'), 'MENU = 1\n'); // coach's version won
        assert.equal(bareFile(bare, 'team.py'), 'x = 2\n');    // team file committed
    } finally {
        await server.close();
    }
});

test('commit with only protected edits is a no-op that still reports protectedSkipped', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const before = bareHead(bare);
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 999\n' },
                { path: 'team.py', contents: 'x = 1\n' },
            ],
            message: 'sneaky menu edit',
        });
        assert.equal(result.committed, false);
        assert.equal(result.message, 'no changes');
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.equal(bareHead(bare), before);
    } finally {
        await server.close();
    }
});

test('an unchanged protected file in the payload is not reported', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 1\n' },
                { path: 'team.py', contents: 'x = 2\n' },
            ],
            message: 'team change only',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, []);
    } finally {
        await server.close();
    }
});

test('deleting a protected file from the editor keeps it upstream and reports it', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull(); // menu.py enters the lastPullPaths snapshot
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'x = 2\n' }], // menu.py gone from editor
            message: 'deleted menu locally',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.equal(bareFile(bare, 'menu.py'), 'MENU = 1\n'); // survived the deletion
    } finally {
        await server.close();
    }
});

test('a protected path that is not upstream is never created', async () => {
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'MENU = 999\n' }, // protected, absent upstream
                { path: 'team.py', contents: 'x = 2\n' },
            ],
            message: 'tried to add menu',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        assert.throws(() => bareFile(bare, 'menu.py')); // never created
    } finally {
        await server.close();
    }
});

test('without a manifest, edits to any file commit normally with empty protectedSkipped', async () => {
    const { engine, bare, server } = await setupEngine({ 'menu.py': 'MENU = 1\n' });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [{ path: 'menu.py', contents: 'MENU = 2\n' }],
            message: 'no manifest, no protection',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, []);
        assert.equal(bareFile(bare, 'menu.py'), 'MENU = 2\n');
    } finally {
        await server.close();
    }
});

test('pull after a skipped protected edit hands the editor the tree version back', async () => {
    const { engine, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
    });
    try {
        await engine.pull();
        await engine.commit({
            files: [{ path: 'menu.py', contents: 'MENU = 999\n' }],
            message: 'sneaky edit',
        });
        const result = await engine.pull(); // pull overwrites the editor — restore is free
        const menu = result.files.find((f) => f.path === 'menu.py');
        assert.equal(menu.contents, 'MENU = 1\n');
    } finally {
        await server.close();
    }
});

test('commit of zero files against an empty repo returns protectedSkipped: []', async () => {
    const { engine, server } = await setupEngine();
    try {
        const result = await engine.commit({ files: [], message: '' });
        assert.equal(result.committed, false);
        assert.deepEqual(result.protectedSkipped, []);
    } finally {
        await server.close();
    }
});
