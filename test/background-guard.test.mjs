import test from 'node:test';
import assert from 'node:assert/strict';
import git from 'isomorphic-git';
// Node 22 ESM won't resolve the bare directory 'isomorphic-git/http/node'
// (the subpackage ships no "exports" map), so point at the file directly —
// same workaround as engine-helpers.mjs.
import http from 'isomorphic-git/http/node/index.cjs';
import fs from 'node:fs';
import { setupEngine } from './engine-helpers.mjs';
import { makeEngine } from './load-background.mjs';
import { pushCompeting, bareFile, bareSubjects } from './git-http-server.mjs';

test('commit before any pull preserves never-pulled starter code', async () => {
    const { engine, bare, server } = await setupEngine({
        'starter.py': 'shared = True\n',
        'lib/shared.py': 'lib = 1\n',
    });
    try {
        // Fresh device: no pull has happened, editor has only the team's file.
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'ours = 1\n' }],
            message: 'first day',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.preserved.sort(), ['lib/shared.py', 'starter.py']);
        assert.equal(bareFile(bare, 'starter.py'), 'shared = True\n');
        assert.equal(bareFile(bare, 'lib/shared.py'), 'lib = 1\n');
        assert.equal(bareFile(bare, 'team.py'), 'ours = 1\n');
    } finally {
        await server.close();
    }
});

test('after a pull, files removed from the editor are deleted by commit', async () => {
    const { engine, bare, server } = await setupEngine({ 'starter.py': 'shared = True\n' });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'ours = 1\n' }],
            message: 'deleted starter',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.preserved, []);
        assert.throws(() => bareFile(bare, 'starter.py'));
    } finally {
        await server.close();
    }
});

test('a competing push between fetch and push is absorbed by the retry', async () => {
    const { engine, storage, bare, server, gitdir } = await setupEngine({
        'main.py': 'x = 1\n',
    });
    try {
        // Wrap git so the FIRST push is preceded by a competing push landing
        // after our fetch — guaranteeing a PushRejected on attempt 1.
        let interfered = false;
        const rigged = {
            ...git,
            push: async (args) => {
                if (!interfered) {
                    interfered = true;
                    pushCompeting(bare, { 'competitor.py': 'c = 1\n' }, 'competing change');
                }
                return git.push(args);
            },
        };
        const racedEngine = makeEngine({ git: rigged, http, fs, gitdir, storage });
        const result = await racedEngine.commit({
            files: [{ path: 'main.py', contents: 'x = 2\n' }],
            message: 'raced commit',
        });
        assert.equal(result.committed, true);
        assert.equal(result.pushed, true);
        // Both changes survive: ours and the competitor's.
        assert.equal(bareFile(bare, 'main.py'), 'x = 2\n');
        assert.equal(bareFile(bare, 'competitor.py'), 'c = 1\n');
        assert.deepEqual(bareSubjects(bare)[0], 'raced commit');
    } finally {
        await server.close();
    }
});
