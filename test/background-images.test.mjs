import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node/index.cjs';
import fs from 'node:fs';
import { makeEngine } from './load-background.mjs';
import { setupEngine, pullAndRecord } from './engine-helpers.mjs';
import { bareFile, pushCompeting } from './git-http-server.mjs';

const blocks = (body) => `# pybricks blocks file:{"blocks":{}}\n${body}\n`;
// Deliberately not valid UTF-8, so a text round-trip would corrupt it.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc3, 0x28, 0x00]);
const image = (path, bytes = PNG) => ({ path, base64: bytes.toString('base64') });

const bareBytes = (bare, path) =>
    execFileSync('git', ['-C', bare, 'show', `main:${path}`], { stdio: ['ignore', 'pipe', 'pipe'] });
const bareHas = (bare, path) => {
    try {
        bareBytes(bare, path);
        return true;
    } catch {
        return false;
    }
};

async function withEngine(files, run) {
    const ctx = await setupEngine(files);
    try {
        await run(ctx);
    } finally {
        await ctx.server.close();
    }
}

// --- imagesNeeded -------------------------------------------------------------

test('imagesNeeded: a changed block program needs a picture even when one exists', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG }, async ({ engine, storage }) => {
        await pullAndRecord(engine, storage);
        const { paths } = await engine.imagesNeeded({ files: [{ path: 'a.py', contents: blocks('x = 2') }] });
        assert.deepEqual(paths, ['a.py']);
    });
});

test('imagesNeeded: an unchanged block program needs a picture only when the repo has none', async () => {
    await withEngine(
        { 'has.py': blocks('x = 1'), 'has.png': PNG, 'lacks.py': blocks('y = 1') },
        async ({ engine, storage }) => {
            await pullAndRecord(engine, storage);
            const { paths } = await engine.imagesNeeded({
                files: [
                    { path: 'has.py', contents: blocks('x = 1') },
                    { path: 'lacks.py', contents: blocks('y = 1') },
                ],
            });
            assert.deepEqual(paths, ['lacks.py']);
        },
    );
});

test('imagesNeeded: works with no Pull base (never pulled)', async () => {
    await withEngine(
        { 'has.py': blocks('x = 1'), 'has.png': PNG, 'lacks.py': blocks('y = 1') },
        async ({ engine }) => {
            const { paths } = await engine.imagesNeeded({
                files: [
                    { path: 'has.py', contents: blocks('x = 1') },
                    { path: 'lacks.py', contents: blocks('y = 1') },
                    { path: 'new.py', contents: blocks('z = 1') },
                ],
            });
            assert.deepEqual(paths.sort(), ['lacks.py', 'new.py']);
        },
    );
});

test('imagesNeeded: a stale editor copy (a teammate pushed over it) needs no picture', async () => {
    await withEngine({ 'a.py': blocks('x = 1') }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        pushCompeting(bare, { 'a.py': blocks('x = 99') }, 'teammate edit');
        const { paths } = await engine.imagesNeeded({ files: [{ path: 'a.py', contents: blocks('x = 1') }] });
        assert.deepEqual(paths, []);
    });
});

test('imagesNeeded: protected programs and text programs never need a picture', async () => {
    await withEngine(
        {
            '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: ['coach.py'] }),
            'coach.py': blocks('c = 1'),
            'text.py': 'print(1)\n',
        },
        async ({ engine, storage }) => {
            await pullAndRecord(engine, storage);
            const { paths } = await engine.imagesNeeded({
                files: [
                    { path: 'coach.py', contents: blocks('c = 2') },
                    { path: 'text.py', contents: 'print(2)\n' },
                ],
            });
            assert.deepEqual(paths, []);
        },
    );
});

test('imagesNeeded: on an empty branch every block program needs a picture', async () => {
    await withEngine({}, async ({ engine }) => {
        const { paths } = await engine.imagesNeeded({
            files: [
                { path: 'a.py', contents: blocks('x = 1') },
                { path: 'text.py', contents: 'print(1)\n' },
            ],
        });
        assert.deepEqual(paths, ['a.py']);
    });
});

// --- commit with images ---------------------------------------------------------

test('commit writes the picture of a changed block program next to it, byte-exact', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'sub/b.py': blocks('y = 1') }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        const result = await engine.commit({
            files: [
                { path: 'a.py', contents: blocks('x = 2') },
                { path: 'sub/b.py', contents: blocks('y = 2') },
            ],
            images: [image('a.py'), image('sub/b.py', PNG2)],
            message: 'm',
        });
        assert.equal(result.committed, true);
        assert.deepEqual([...result.images].sort(), ['a.png', 'sub/b.png']);
        assert.deepEqual(bareBytes(bare, 'a.png'), PNG);
        assert.deepEqual(bareBytes(bare, 'sub/b.png'), PNG2);
        assert.equal(bareFile(bare, 'a.py'), blocks('x = 2'));
    });
});

test('commit of a changed block program with no picture deletes the outdated one', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        const result = await engine.commit({ files: [{ path: 'a.py', contents: blocks('x = 2') }], message: 'm' });
        assert.equal(result.committed, true);
        assert.deepEqual(result.images, []);
        assert.equal(bareHas(bare, 'a.png'), false);
    });
});

test('commit leaves the picture of an unchanged block program alone', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        // No picture supplied: nothing to do.
        const none = await engine.commit({ files: [{ path: 'a.py', contents: blocks('x = 1') }], message: 'm' });
        assert.equal(none.committed, false);
        // A picture supplied for a program that already has one is not written.
        const extra = await engine.commit({
            files: [{ path: 'a.py', contents: blocks('x = 1') }],
            images: [image('a.py', PNG2)],
            message: 'm',
        });
        assert.equal(extra.committed, false);
        assert.deepEqual(bareBytes(bare, 'a.png'), PNG);
    });
});

test('commit backfills a missing picture for an unchanged block program', async () => {
    await withEngine({ 'a.py': blocks('x = 1') }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        const result = await engine.commit({
            files: [{ path: 'a.py', contents: blocks('x = 1') }],
            images: [image('a.py')],
            message: 'm',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.images, ['a.png']);
        assert.deepEqual(bareBytes(bare, 'a.png'), PNG);
    });
});

test('commit ignores a picture of a stale editor copy and keeps the repo picture', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        pushCompeting(bare, { 'a.py': blocks('x = 99') }, 'teammate edit');
        const result = await engine.commit({
            files: [{ path: 'a.py', contents: blocks('x = 1') }],
            images: [image('a.py', PNG2)],
            message: 'm',
        });
        assert.equal(result.committed, false);
        assert.deepEqual(bareBytes(bare, 'a.png'), PNG);
        assert.equal(bareFile(bare, 'a.py'), blocks('x = 99'));
    });
});

test('commit never writes a picture for a protected program, a text program, or an unknown path', async () => {
    await withEngine(
        {
            '.pybricks-git.json': JSON.stringify({ schemaVersion: 1, protected: ['coach.py'] }),
            'coach.py': blocks('c = 1'),
            'text.py': 'print(1)\n',
        },
        async ({ engine, storage, bare }) => {
            await pullAndRecord(engine, storage);
            const result = await engine.commit({
                files: [
                    { path: 'coach.py', contents: blocks('c = 2') },
                    { path: 'text.py', contents: 'print(2)\n' },
                ],
                images: [image('coach.py'), image('text.py'), image('ghost.py'), image('../escape.py')],
                message: 'm',
            });
            assert.deepEqual(result.images, []);
            for (const p of ['coach.png', 'text.png', 'ghost.png']) assert.equal(bareHas(bare, p), false, p);
        },
    );
});

test('a picture that is not valid base64 is dropped without failing the commit', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        const result = await engine.commit({
            files: [{ path: 'a.py', contents: blocks('x = 2') }],
            images: [{ path: 'a.py', base64: '!!! not base64 !!!' }, { path: 'a.py' }, null],
            message: 'm',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.images, []);
        // Treated as "changed, no picture": the outdated one goes.
        assert.equal(bareHas(bare, 'a.png'), false);
        assert.equal(bareFile(bare, 'a.py'), blocks('x = 2'));
    });
});

test('deleting a block program deletes its picture; deleting a text program leaves a sibling png', async () => {
    await withEngine(
        { 'gone.py': blocks('x = 1'), 'gone.png': PNG, 'text.py': 'print(1)\n', 'text.png': PNG2, 'keep.py': 'k = 1\n' },
        async ({ engine, storage, bare }) => {
            await pullAndRecord(engine, storage);
            const result = await engine.commit({ files: [{ path: 'keep.py', contents: 'k = 1\n' }], message: 'm' });
            assert.equal(result.committed, true);
            assert.equal(bareHas(bare, 'gone.py'), false);
            assert.equal(bareHas(bare, 'gone.png'), false);
            assert.equal(bareHas(bare, 'text.py'), false);
            assert.deepEqual(bareBytes(bare, 'text.png'), PNG2);
        },
    );
});

test('a deletion skipped because a teammate pushed over the program keeps its picture', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG, 'keep.py': 'k = 1\n' }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        pushCompeting(bare, { 'a.py': blocks('x = 99') }, 'teammate edit');
        const result = await engine.commit({ files: [{ path: 'keep.py', contents: 'k = 2\n' }], message: 'm' });
        assert.deepEqual(result.deleteSkipped, ['a.py']);
        assert.deepEqual(bareBytes(bare, 'a.png'), PNG);
    });
});

test('a picture still lands when the push is rejected once and the commit is rebuilt', async () => {
    await withEngine({ 'a.py': blocks('x = 1') }, async ({ storage, bare, gitdir, engine }) => {
        await pullAndRecord(engine, storage);
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
        const raced = makeEngine({ git: rigged, http, fs, gitdir, storage });
        const result = await raced.commit({
            files: [{ path: 'a.py', contents: blocks('x = 2') }],
            images: [image('a.py')],
            message: 'm',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.images, ['a.png']);
        assert.deepEqual(bareBytes(bare, 'a.png'), PNG);
        assert.equal(bareFile(bare, 'competitor.py'), 'c = 1\n');
    });
});

// --- pictures stay out of the editor -------------------------------------------

test('Pull and filesAt never hand a picture to the editor', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG }, async ({ engine, storage }) => {
        const pulled = await pullAndRecord(engine, storage);
        assert.deepEqual(pulled.files.map((f) => f.path), ['a.py']);
        assert.deepEqual(Object.keys(pulled.shas), ['a.py']);
        const { commits } = await engine.history({});
        const at = await engine.filesAt({ oid: commits[0].oid });
        assert.deepEqual(at.files.map((f) => f.path), ['a.py']);
    });
});

test('a commit that never mentions pictures leaves existing ones untouched', async () => {
    await withEngine({ 'a.py': blocks('x = 1'), 'a.png': PNG, 'text.py': 't = 1\n' }, async ({ engine, storage, bare }) => {
        await pullAndRecord(engine, storage);
        const result = await engine.commit({
            files: [
                { path: 'a.py', contents: blocks('x = 1') },
                { path: 'text.py', contents: 't = 2\n' },
            ],
            message: 'm',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(bareBytes(bare, 'a.png'), PNG);
    });
});
