import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine } from './engine-helpers.mjs';
import { bareHead, bareFile, bareSubjects } from './git-http-server.mjs';

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
