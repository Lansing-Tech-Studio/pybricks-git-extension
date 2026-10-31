import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { setupEngine, memStorage } from './engine-helpers.mjs';
import { makeEngine } from './load-background.mjs';
import { pushCompeting, bareSubjects, bareHead } from './git-http-server.mjs';

// Four commits, oldest first: seed, second, third, fourth. `third` deletes a
// file and adds another; `fourth` touches a non-.py file and a dot-path.
async function fourCommits() {
    const ctx = await setupEngine({ 'a.py': 'a v1\n', 'b.py': 'b v1\n' });
    pushCompeting(ctx.bare, { 'a.py': 'a v2\n' }, 'second');
    pushCompeting(ctx.bare, { 'b.py': null, 'c.py': 'c v1\n' }, 'third');
    pushCompeting(ctx.bare, { 'README.md': 'docs\n', '.vscode/run.py': 'x\n', 'a.py': 'a v3\n' }, 'fourth');
    return ctx;
}

test('history lists commits newest first with parent links, matching git log', async () => {
    const { engine, bare, server } = await fourCommits();
    try {
        const res = await engine.history({ depth: 10 });
        assert.equal(res.head, bareHead(bare));
        assert.deepEqual(res.commits.map((c) => c.message.trim()), bareSubjects(bare));
        assert.equal(res.commits.length, 4);
        for (let i = 0; i < 3; i++) assert.equal(res.commits[i].parent, res.commits[i + 1].oid);
        assert.equal(res.commits[3].parent, null, 'root commit has no parent');
        assert.equal(res.hasMore, false);
        for (const c of res.commits) {
            assert.match(c.oid, /^[0-9a-f]{40}$/);
            assert.equal(c.parents, c.parent ? 1 : 0);
            assert.equal(c.author.name, 'Seed');
            assert.equal(typeof c.author.timestamp, 'number');
        }
    } finally {
        await server.close();
    }
});

test('history honours depth and reports hasMore until the root is reached', async () => {
    const { engine, bare, server } = await fourCommits();
    try {
        const two = await engine.history({ depth: 2 });
        assert.equal(two.commits.length, 2);
        assert.deepEqual(two.commits.map((c) => c.message.trim()), bareSubjects(bare).slice(0, 2));
        assert.equal(two.hasMore, true);

        const three = await engine.history({ depth: 3 });
        assert.equal(three.commits.length, 3);
        assert.equal(three.hasMore, true);

        const four = await engine.history({ depth: 4 });
        assert.equal(four.commits.length, 4);
        assert.equal(four.hasMore, false, 'the depth+1 probe found no commit beyond the root');
    } finally {
        await server.close();
    }
});

test('history defaults the depth and clamps nonsense values', async () => {
    const { engine, server } = await fourCommits();
    try {
        assert.equal((await engine.history()).commits.length, 4);
        assert.equal((await engine.history({ depth: 0 })).commits.length, 1);
        assert.equal((await engine.history({ depth: -5 })).commits.length, 1);
        assert.equal((await engine.history({ depth: 'x' })).commits.length, 4);
    } finally {
        await server.close();
    }
});

test('history of an empty branch is empty, not an error', async () => {
    const { engine, server } = await setupEngine();
    try {
        assert.deepEqual(await engine.history({ depth: 5 }), { head: null, commits: [], hasMore: false });
    } finally {
        await server.close();
    }
});

test('history rejects when not configured', async () => {
    const { engine, storage, server } = await setupEngine({ 'a.py': 'x\n' });
    try {
        await storage.set({ settings: {} });
        await assert.rejects(() => engine.history(), /not configured/);
    } finally {
        await server.close();
    }
});

test('filesAt returns the editor-visible files of each commit', async () => {
    const { engine, server } = await fourCommits();
    try {
        const { commits } = await engine.history({ depth: 10 });
        const [fourth, third, second, seed] = commits;

        const atSeed = await engine.filesAt({ oid: seed.oid });
        assert.equal(atSeed.oid, seed.oid);
        assert.deepEqual(atSeed.files, [
            { path: 'a.py', contents: 'a v1\n' },
            { path: 'b.py', contents: 'b v1\n' },
        ]);

        const atSecond = await engine.filesAt({ oid: second.oid });
        assert.deepEqual(atSecond.files.map((f) => f.contents), ['a v2\n', 'b v1\n']);

        const atThird = await engine.filesAt({ oid: third.oid });
        assert.deepEqual(atThird.files.map((f) => f.path), ['a.py', 'c.py'], 'b.py deleted, c.py added');

        const atFourth = await engine.filesAt({ oid: fourth.oid });
        assert.deepEqual(
            atFourth.files.map((f) => f.path),
            ['a.py', 'c.py'],
            'README.md (not .py) and .vscode/run.py (repo-internal) are hidden, as in Pull',
        );
        assert.equal(atFourth.files[0].contents, 'a v3\n');
    } finally {
        await server.close();
    }
});

test('filesAt rejects a malformed oid before touching git', async () => {
    const { engine, server } = await fourCommits();
    try {
        await assert.rejects(() => engine.filesAt({ oid: 'nope' }), /invalid commit id/);
        await assert.rejects(() => engine.filesAt({}), /invalid commit id/);
        await assert.rejects(() => engine.filesAt({ oid: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }), /invalid commit id/);
    } finally {
        await server.close();
    }
});

test('filesAt rejects an unknown but well-formed oid', async () => {
    const { engine, server } = await fourCommits();
    try {
        await engine.history({ depth: 10 });
        await assert.rejects(() => engine.filesAt({ oid: '0'.repeat(40) }));
    } finally {
        await server.close();
    }
});

test('filesAt survives a wiped gitdir by refetching once', async () => {
    const { engine, server, gitdir } = await fourCommits();
    try {
        const { commits } = await engine.history({ depth: 10 });
        rmSync(gitdir, { recursive: true, force: true });
        const res = await engine.filesAt({ oid: commits[2].oid, depth: 10 });
        assert.deepEqual(res.files.map((f) => f.contents), ['a v2\n', 'b v1\n']);
    } finally {
        await server.close();
    }
});

test('a depth-1 pull between two history calls keeps the chain walkable', async () => {
    const { engine, bare, server } = await fourCommits();
    try {
        const before = await engine.history({ depth: 10 });
        assert.equal(before.commits.length, 4);

        await engine.pull(); // depth 1, same tip
        pushCompeting(bare, { 'a.py': 'a v4\n' }, 'fifth'); // a teammate moves the tip
        await engine.pull(); // depth 1, new tip

        const after = await engine.history({ depth: 10 });
        assert.deepEqual(after.commits.map((c) => c.message.trim()), bareSubjects(bare));
        assert.equal(after.commits.length, 5);
        assert.equal(after.commits[0].parent, before.commits[0].oid, 'new tip links onto the cached chain');
        assert.equal(after.hasMore, false);
    } finally {
        await server.close();
    }
});

test('history of a merge commit follows the first parent and counts parents', async () => {
    const { engine, bare, server } = await setupEngine({ 'a.py': 'a v1\n' });
    try {
        // Build a merge in the bare repo: main gets `on-main`, a side branch
        // gets `on-side`, then main merges side with --no-ff.
        const { execFileSync } = await import('node:child_process');
        const { mkdtempSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const w = join(mkdtempSync(join(tmpdir(), 'pbgit-merge-')), 'w');
        execFileSync('git', ['clone', '-q', bare, w], { stdio: 'ignore' });
        const g = (...a) => execFileSync('git', ['-C', w, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        g('config', 'user.email', 'seed@example.com');
        g('config', 'user.name', 'Seed');
        g('config', 'commit.gpgsign', 'false');
        g('checkout', '-q', '-b', 'side');
        execFileSync('sh', ['-c', `printf 'side\\n' > "${w}/side.py"`]);
        g('add', '-A');
        g('commit', '-q', '-m', 'on-side');
        g('checkout', '-q', 'main');
        execFileSync('sh', ['-c', `printf 'a v2\\n' > "${w}/a.py"`]);
        g('add', '-A');
        g('commit', '-q', '-m', 'on-main');
        g('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
        g('push', '-q', 'origin', 'main');

        const res = await engine.history({ depth: 10 });
        assert.deepEqual(
            res.commits.map((c) => c.message.trim()),
            ['merge side', 'on-main', 'seed'],
            'first-parent walk: the side branch commit is not its own row',
        );
        assert.equal(res.commits[0].parents, 2);
        assert.equal(res.commits[1].parents, 1);
        assert.equal(res.hasMore, false);
        // The merge's diff (first parent -> merge) brings in side.py.
        const atMerge = await engine.filesAt({ oid: res.commits[0].oid });
        const atParent = await engine.filesAt({ oid: res.commits[0].parent });
        assert.deepEqual(atParent.files.map((f) => f.path), ['a.py']);
        assert.deepEqual(atMerge.files.map((f) => f.path), ['a.py', 'side.py']);
    } finally {
        await server.close();
    }
});

test('history surfaces fetch failures instead of a false empty list', async () => {
    const storage = memStorage();
    await storage.set({ settings: { repoUrl: 'https://example.invalid/x.git', branch: 'main', token: 't' } });
    const git = {
        init: async () => {},
        addRemote: async () => {},
        fetch: async () => {
            throw Object.assign(new Error('HTTP Error: 401 Unauthorized'), { code: 'HttpError' });
        },
    };
    const engine = makeEngine({ git, http: {}, fs: {}, gitdir: '/x', storage });
    await assert.rejects(() => engine.history(), /401/);
});

test('history asks fetch for depth + 1 so the oldest row still has a parent tree', async () => {
    const storage = memStorage();
    await storage.set({ settings: { repoUrl: 'https://example.invalid/x.git', branch: 'main', token: 't' } });
    const seen = [];
    const git = {
        init: async () => {},
        addRemote: async () => {},
        fetch: async (opts) => {
            seen.push(opts.depth);
            return { fetchHead: null };
        },
    };
    const engine = makeEngine({ git, http: {}, fs: {}, gitdir: '/x', storage });
    await engine.history({ depth: 7 });
    assert.deepEqual(seen, [8]);
});
