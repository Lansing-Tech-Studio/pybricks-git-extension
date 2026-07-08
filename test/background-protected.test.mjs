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

test('pull ignores a manifest whose protected key is not an array', async () => {
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

test('pull stores lastPullManifest (protected + menuConfig) alongside lastPullPaths', async () => {
    const { engine, storage, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({
            schemaVersion: 1,
            menuConfig: 'menu_config.py',
            protected: ['menu.py'],
        }),
        'menu.py': 'MENU = 1\n',
        'a.py': 'x = 1\n',
    });
    try {
        await engine.pull();
        const stored = await storage.get('lastPullManifest');
        assert.deepEqual(stored, { protected: ['menu.py'], menuConfig: 'menu_config.py' });
        assert.deepEqual((await storage.get('lastPullPaths')).sort(), ['a.py', 'menu.py']);
    } finally {
        await server.close();
    }
});

test('pull with no manifest stores empty lastPullManifest', async () => {
    const { engine, storage, server } = await setupEngine({ 'main.py': 'x = 1\n' });
    try {
        await engine.pull();
        const stored = await storage.get('lastPullManifest');
        assert.deepEqual(stored, { protected: [], menuConfig: null });
    } finally {
        await server.close();
    }
});

test('empty-branch pull leaves lastPullManifest untouched', async () => {
    const { engine, storage, server } = await setupEngine();
    try {
        const sentinel = { protected: ['keep.py'], menuConfig: 'menu_config.py' };
        await storage.set({ lastPullManifest: sentinel });
        const result = await engine.pull();
        assert.notEqual(result.pullWarning, ''); // confirm this was an empty fork
        assert.deepEqual(await storage.get('lastPullManifest'), sentinel);
    } finally {
        await server.close();
    }
});

test('one commit mixing a protected deletion and a divergent protected edit reports both', async () => {
    // (deferred from phase 2) menu.py + main.py are both protected. One commit
    // omits menu.py (deletion attempt) and edits main.py (divergent edit).
    const { engine, bare, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'main.py': 'MAIN = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await engine.pull(); // both protected paths enter the lastPullPaths snapshot
        const result = await engine.commit({
            files: [
                { path: 'main.py', contents: 'MAIN = 999\n' }, // divergent protected edit
                { path: 'team.py', contents: 'x = 2\n' }, // menu.py omitted → deletion attempt
            ],
            message: 'delete menu and edit main',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(
            new Set(result.protectedSkipped),
            new Set(['menu.py', 'main.py']),
        );
        assert.equal(bareFile(bare, 'menu.py'), 'MENU = 1\n'); // deletion skipped
        assert.equal(bareFile(bare, 'main.py'), 'MAIN = 1\n'); // edit skipped
        assert.equal(bareFile(bare, 'team.py'), 'x = 2\n'); // team change landed
    } finally {
        await server.close();
    }
});
