import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setupEngine } from './engine-helpers.mjs';
import { bareHead, bareFile, bareSubjects, pushCompeting } from './git-http-server.mjs';

const BLOCK = '# pybricks blocks file:{"a":1,"b":[2,3]}\nfrom pybricks import *\n';

test('first commit to an empty fork creates the branch and pushes', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const result = await engine.commit({
            files: [{ path: 'main.py', contents: 'print(1)\n' }],
            message: 'first commit',
        });
        assert.equal(result.committed, true);
        assert.equal(result.pushed, true);
        assert.equal(result.message, 'first commit');
        assert.equal(bareHead(bare).slice(0, 7), result.head);
        assert.equal(bareFile(bare, 'main.py'), 'print(1)\n');
        assert.deepEqual(bareSubjects(bare), ['first commit']);
    } finally {
        await server.close();
    }
});

test('empty message gets the timestamped default', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const result = await engine.commit({
            files: [{ path: 'main.py', contents: 'x=1\n' }],
            message: '',
        });
        assert.match(result.message, /^Update from Pybricks at /);
        assert.match(bareSubjects(bare)[0], /^Update from Pybricks at /);
    } finally {
        await server.close();
    }
});

test('identical second commit is a no-op that does not push', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const files = [{ path: 'main.py', contents: 'x=1\n' }];
        await engine.commit({ files, message: 'one' });
        const before = bareHead(bare);
        const result = await engine.commit({ files, message: 'two' });
        assert.equal(result.committed, false);
        assert.equal(result.message, 'no changes');
        assert.equal(bareHead(bare), before);
    } finally {
        await server.close();
    }
});

test('nested paths and block files round-trip byte-for-byte through commit', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        await engine.commit({
            files: [
                { path: 'prog.py', contents: BLOCK },
                { path: 'nested/deep/mod.py', contents: 'y = 2\n' },
            ],
            message: 'nested',
        });
        assert.equal(bareFile(bare, 'prog.py'), BLOCK);
        assert.equal(bareFile(bare, 'nested/deep/mod.py'), 'y = 2\n');
    } finally {
        await server.close();
    }
});

test('non-.py files in the fork are never touched by commit', async () => {
    const { engine, bare, server } = await setupEngine({
        'README.md': '# shared docs\n',
        'main.py': 'print(1)\n',
    });
    try {
        await engine.pull(); // snapshot main.py so its deletion is allowed
        await engine.commit({
            files: [{ path: 'other.py', contents: 'z=1\n' }],
            message: 'replace',
        });
        assert.equal(bareFile(bare, 'README.md'), '# shared docs\n');
        assert.equal(bareFile(bare, 'other.py'), 'z=1\n');
        assert.throws(() => bareFile(bare, 'main.py')); // deleted: pulled, then absent
    } finally {
        await server.close();
    }
});

test('commit of zero files against an empty repo is a no-op', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const result = await engine.commit({ files: [], message: '' });
        assert.equal(result.committed, false);
        assert.equal(bareHead(bare), '');
    } finally {
        await server.close();
    }
});

test('commit falls back to lastPullPaths when lastPullShas is absent', async () => {
    const { engine, bare, storage, server } = await setupEngine({ 'starter.py': 'shared = True\n' });
    try {
        // An install that pulled before the upgrade: only the old key exists.
        await storage.set({ lastPullPaths: ['starter.py'] });
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'ours = 1\n' }],
            message: 'old snapshot',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.preserved, []);
        // bareFile shells out to `git show` and THROWS for a missing path — it
        // does not return null. This is how the existing tests assert absence.
        assert.throws(() => bareFile(bare, 'starter.py'));
    } finally {
        await server.close();
    }
});

test('a stale untouched file does not revert a teammate\'s push', async () => {
    const { engine, bare, server } = await setupEngine({
        'shared.py': 'v1\n',
        'mine.py': 'a = 1\n',
    });
    try {
        // Pull records shas for v1 of both files.
        await engine.pull();
        // A teammate pushes a newer shared.py while our editor still holds v1.
        pushCompeting(bare, { 'shared.py': 'v2\n' }, 'teammate edit');
        // We commit our own edit; our payload still carries the stale shared.py.
        const result = await engine.commit({
            files: [
                { path: 'shared.py', contents: 'v1\n' },
                { path: 'mine.py', contents: 'a = 2\n' },
            ],
            message: 'my edit',
        });
        assert.equal(result.committed, true);
        assert.equal(bareFile(bare, 'shared.py'), 'v2\n'); // theirs survived
        assert.equal(bareFile(bare, 'mine.py'), 'a = 2\n'); // ours landed
    } finally {
        await server.close();
    }
});

test('an edited file still overwrites the tree version', async () => {
    const { engine, bare, server } = await setupEngine({ 'shared.py': 'v1\n' });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [{ path: 'shared.py', contents: 'v1 edited\n' }],
            message: 'genuine edit',
        });
        assert.equal(result.committed, true);
        assert.equal(bareFile(bare, 'shared.py'), 'v1 edited\n');
    } finally {
        await server.close();
    }
});

test('an untouched file whose upstream copy was deleted stays deleted', async () => {
    const { engine, bare, server } = await setupEngine({
        'gone.py': 'v1\n',
        'mine.py': 'a = 1\n',
    });
    try {
        await engine.pull();
        pushCompeting(bare, { 'gone.py': null }, 'teammate deleted it');
        const result = await engine.commit({
            files: [
                { path: 'gone.py', contents: 'v1\n' },
                { path: 'mine.py', contents: 'a = 2\n' },
            ],
            message: 'my edit',
        });
        assert.equal(result.committed, true);
        assert.throws(() => bareFile(bare, 'gone.py'));
    } finally {
        await server.close();
    }
});

test('a genuine revert to the last-pulled content still commits (base moves forward after a push)', async () => {
    const { engine, bare, server } = await setupEngine({ 'shared.py': 'v1\n' });
    try {
        await engine.pull(); // lastPullShas: shared.py -> sha(v1)
        const edit = await engine.commit({
            files: [{ path: 'shared.py', contents: 'v2\n' }],
            message: 'edit to v2',
        });
        assert.equal(edit.committed, true);
        assert.equal(bareFile(bare, 'shared.py'), 'v2\n');
        // Undo back to exactly the pulled content. If the base were still
        // sha(v1), the guard would wrongly treat this as untouched and drop
        // the deliberate revert.
        const revert = await engine.commit({
            files: [{ path: 'shared.py', contents: 'v1\n' }],
            message: 'revert to v1',
        });
        assert.equal(revert.committed, true);
        assert.equal(bareFile(bare, 'shared.py'), 'v1\n');
    } finally {
        await server.close();
    }
});

test('a newly created file gains a lastPullShas entry after commit', async () => {
    const { engine, storage, server } = await setupEngine({ 'shared.py': 'v1\n' });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [
                { path: 'shared.py', contents: 'v1\n' }, // untouched
                { path: 'new.py', contents: 'x = 1\n' }, // never seen by a Pull
            ],
            message: 'add new file',
        });
        assert.equal(result.committed, true);
        const shas = await storage.get('lastPullShas');
        assert.equal(shas['new.py'], createHash('sha256').update('x = 1\n', 'utf8').digest('hex'));
    } finally {
        await server.close();
    }
});

test('a guard-skipped path keeps its old base entry, not the tree\'s new one', async () => {
    const { engine, bare, storage, server } = await setupEngine({
        'shared.py': 'v1\n',
        'mine.py': 'a = 1\n',
    });
    try {
        await engine.pull();
        const v1Sha = (await storage.get('lastPullShas'))['shared.py'];
        pushCompeting(bare, { 'shared.py': 'v2\n' }, 'teammate edit');
        const result = await engine.commit({
            files: [
                { path: 'shared.py', contents: 'v1\n' }, // stale, guard-skipped
                { path: 'mine.py', contents: 'a = 2\n' },
            ],
            message: 'my edit',
        });
        assert.equal(result.committed, true);
        const shas = await storage.get('lastPullShas');
        // Base still describes v1 (what the editor and repo last agreed on),
        // not the teammate's v2 the tree now holds — otherwise the next Pull
        // would see local v1 against a v2 base and wrongly "rescue" it.
        assert.equal(shas['shared.py'], v1Sha);
    } finally {
        await server.close();
    }
});
