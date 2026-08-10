import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setupEngine, pullAndRecord } from './engine-helpers.mjs';
import { bareHead, bareFile, pushCompeting } from './git-http-server.mjs';

const MANIFEST = JSON.stringify({
    schemaVersion: 1,
    protected: ['.pybricks-git.json', 'menu.py', 'main.py'],
});

test('pull returns the manifest protected list and still filters files to .py', async () => {
    const { engine, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        const result = await pullAndRecord(engine, storage);
        assert.deepEqual([...result.protected].sort(), ['.pybricks-git.json', 'main.py', 'menu.py']);
        // manifest is not .py, so it is never handed to the editor
        assert.deepEqual(result.files.map((f) => f.path).sort(), ['menu.py', 'team.py']);
    } finally {
        await server.close();
    }
});

test('pull with no manifest returns an empty protected list', async () => {
    const { engine, server, storage } = await setupEngine({ 'main.py': 'x = 1\n' });
    try {
        const result = await pullAndRecord(engine, storage);
        assert.deepEqual(result.protected, []);
    } finally {
        await server.close();
    }
});

test('pull tolerates a malformed manifest as no protection', async () => {
    const { engine, server, storage } = await setupEngine({
        '.pybricks-git.json': '{not json',
        'main.py': 'x = 1\n',
    });
    try {
        const result = await pullAndRecord(engine, storage);
        assert.deepEqual(result.protected, []);
        assert.equal(result.files.length, 1); // pull itself still works
    } finally {
        await server.close();
    }
});

test('pull ignores a manifest with the wrong schemaVersion', async () => {
    const { engine, server, storage } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 2, protected: ['menu.py'] }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await pullAndRecord(engine, storage)).protected, []);
    } finally {
        await server.close();
    }
});

test('pull ignores a manifest whose protected key is not an array', async () => {
    const { engine, server, storage } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: 'menu.py' }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await pullAndRecord(engine, storage)).protected, []);
    } finally {
        await server.close();
    }
});

test('pull from an empty repo returns protected: []', async () => {
    const { engine, server, storage } = await setupEngine();
    try {
        const result = await pullAndRecord(engine, storage);
        assert.notEqual(result.pullWarning, '');
        assert.deepEqual(result.protected, []);
    } finally {
        await server.close();
    }
});

test('pull drops non-string entries from the protected list', async () => {
    const { engine, server, storage } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: ['menu.py', 7, null] }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        assert.deepEqual((await pullAndRecord(engine, storage)).protected, ['menu.py']);
    } finally {
        await server.close();
    }
});

test('commit keeps the tree version of an edited protected file and reports it', async () => {
    const { engine, bare, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
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
    const { engine, bare, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
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
    const { engine, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
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
    const { engine, bare, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await pullAndRecord(engine, storage); // menu.py enters the lastPullShas snapshot
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
    const { engine, bare, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'team.py': 'x = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
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
    const { engine, bare, server, storage } = await setupEngine({ 'menu.py': 'MENU = 1\n' });
    try {
        await pullAndRecord(engine, storage);
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
    const { engine, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
        await engine.commit({
            files: [{ path: 'menu.py', contents: 'MENU = 999\n' }],
            message: 'sneaky edit',
        });
        const result = await pullAndRecord(engine, storage); // pull overwrites the editor — restore is free
        const menu = result.files.find((f) => f.path === 'menu.py');
        assert.equal(menu.contents, 'MENU = 1\n');
    } finally {
        await server.close();
    }
});

test('commit of zero files against an empty repo returns protectedSkipped: []', async () => {
    const { engine, server, storage } = await setupEngine();
    try {
        const result = await engine.commit({ files: [], message: '' });
        assert.equal(result.committed, false);
        assert.deepEqual(result.protectedSkipped, []);
    } finally {
        await server.close();
    }
});

test('pull stores lastPullManifest (protected + menuConfig) alongside lastPullShas', async () => {
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
        await pullAndRecord(engine, storage);
        const stored = await storage.get('lastPullManifest');
        assert.deepEqual(stored, {
            protected: ['menu.py'],
            menuConfig: 'menu_config.py',
            setupTemplate: null,
            teamSetup: null,
        });
        assert.deepEqual(Object.keys(await storage.get('lastPullShas')).sort(), ['a.py', 'menu.py']);
    } finally {
        await server.close();
    }
});

test('pull with no manifest stores empty lastPullManifest', async () => {
    const { engine, storage, server } = await setupEngine({ 'main.py': 'x = 1\n' });
    try {
        await pullAndRecord(engine, storage);
        const stored = await storage.get('lastPullManifest');
        assert.deepEqual(stored, {
            protected: [],
            menuConfig: null,
            setupTemplate: null,
            teamSetup: null,
        });
    } finally {
        await server.close();
    }
});

test('pull stores setupTemplate/teamSetup from the manifest', async () => {
    const { engine, storage, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({
            schemaVersion: 1,
            menuConfig: 'menu_config.py',
            setupTemplate: 'robot_setup_template.py',
            teamSetup: 'robot_setup.py',
            protected: ['menu.py'],
        }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
        const stored = await storage.get('lastPullManifest');
        assert.equal(stored.setupTemplate, 'robot_setup_template.py');
        assert.equal(stored.teamSetup, 'robot_setup.py');
    } finally {
        await server.close();
    }
});

test('missing/non-string setupTemplate/teamSetup stored as null', async () => {
    const { engine, storage, server } = await setupEngine({
        '.pybricks-git.json': JSON.stringify({
            schemaVersion: 1,
            setupTemplate: 42, // non-string
            // teamSetup omitted entirely
            protected: ['menu.py'],
        }),
        'menu.py': 'MENU = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
        const stored = await storage.get('lastPullManifest');
        assert.equal(stored.setupTemplate, null);
        assert.equal(stored.teamSetup, null);
    } finally {
        await server.close();
    }
});

test('empty-branch pull leaves lastPullManifest untouched', async () => {
    const { engine, storage, server } = await setupEngine();
    try {
        const sentinel = { protected: ['keep.py'], menuConfig: 'menu_config.py' };
        await storage.set({ lastPullManifest: sentinel });
        const result = await pullAndRecord(engine, storage);
        assert.notEqual(result.pullWarning, ''); // confirm this was an empty fork
        assert.deepEqual(await storage.get('lastPullManifest'), sentinel);
    } finally {
        await server.close();
    }
});

test('an untouched protected file whose upstream copy changed is not reported (guard precedes the protected check)', async () => {
    const { engine, bare, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'L1\n',
    });
    try {
        await pullAndRecord(engine, storage); // lastPullShas records menu.py's sha for L1
        pushCompeting(bare, { 'menu.py': 'L2\n' }, 'coach update'); // upstream diverges
        const result = await engine.commit({
            files: [{ path: 'menu.py', contents: 'L1\n' }], // editor still holds the pulled L1
            message: 'no real edit',
        });
        // A guard placed after the protected check would see L1 !== L2 and
        // wrongly report menu.py as skipped, even though the editor never
        // touched it. Correct placement never reaches the protected branch.
        assert.deepEqual(result.protectedSkipped, []);
        assert.equal(bareFile(bare, 'menu.py'), 'L2\n'); // coach's push stood
    } finally {
        await server.close();
    }
});

test('a diverged protected path keeps its original pulled sha, not the editor\'s or the tree\'s current value', async () => {
    const { engine, bare, storage, server } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'L1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await pullAndRecord(engine, storage);
        const originalSha = (await storage.get('lastPullShas'))['menu.py'];
        pushCompeting(bare, { 'menu.py': 'L2\n' }, 'coach update'); // tree now L2
        const result = await engine.commit({
            files: [
                { path: 'menu.py', contents: 'L3\n' }, // editor diverged to a third value
                { path: 'team.py', contents: 'x = 2\n' }, // genuine change so the commit pushes
            ],
            message: 'sneaky menu edit plus a real one',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.protectedSkipped, ['menu.py']);
        const shas = await storage.get('lastPullShas');
        assert.equal(shas['menu.py'], originalSha); // still L1's sha
        assert.notEqual(shas['menu.py'], createHash('sha256').update('L3\n', 'utf8').digest('hex'));
        assert.notEqual(shas['menu.py'], createHash('sha256').update('L2\n', 'utf8').digest('hex'));
    } finally {
        await server.close();
    }
});

test('one commit mixing a protected deletion and a divergent protected edit reports both', async () => {
    // (deferred from phase 2) menu.py + main.py are both protected. One commit
    // omits menu.py (deletion attempt) and edits main.py (divergent edit).
    const { engine, bare, server, storage } = await setupEngine({
        '.pybricks-git.json': MANIFEST,
        'menu.py': 'MENU = 1\n',
        'main.py': 'MAIN = 1\n',
        'team.py': 'x = 1\n',
    });
    try {
        await pullAndRecord(engine, storage); // both protected paths enter the lastPullShas snapshot
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
