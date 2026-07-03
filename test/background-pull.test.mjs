import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine, memStorage } from './engine-helpers.mjs';
import { makeEngine } from './load-background.mjs';

const BLOCK = '# pybricks blocks file:{"a":1,"b":[2,3]}\nfrom pybricks import *\n';

// Builds an engine whose git.fetch throws a caller-supplied error, so we can
// pin exactly which fetch failures fetchRemoteHead treats as "no commits yet"
// (return null) versus surfaces to the user (reject). init/addRemote are no-ops.
async function engineWithFetchError(err) {
    const storage = memStorage();
    await storage.set({
        settings: { repoUrl: 'https://example.invalid/x.git', branch: 'main', token: 't' },
    });
    const git = {
        init: async () => {},
        addRemote: async () => {},
        fetch: async () => { throw err; },
    };
    return makeEngine({ git, http: {}, fs: {}, gitdir: '/x', storage });
}

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

test('pull against a nonexistent repo URL rejects instead of reporting an empty repo', async () => {
    const { engine, storage, server } = await setupEngine();
    try {
        const s = await storage.get('settings');
        await storage.set({ settings: { ...s, repoUrl: `${server.url}/does-not-exist.git` } });
        await assert.rejects(engine.pull());
    } finally {
        await server.close();
    }
});

test('pull surfaces a real fetch failure instead of masking it as an empty repo', async () => {
    // A broken/misconfigured remote endpoint: isomorphic-git raises
    // EmptyServerResponse. This is a genuine failure, not an empty repo, and
    // must reach the user rather than be reported as "no commits yet".
    const err = Object.assign(new Error('EmptyServerResponse: Empty response from git server.'), {
        code: 'EmptyServerResponse',
    });
    const engine = await engineWithFetchError(err);
    await assert.rejects(engine.pull(), /EmptyServerResponse/);
});

test('pull treats a missing branch ref as an empty repo (no commits yet)', async () => {
    // How an empty repo / not-yet-pushed branch surfaces when fetch does throw.
    const err = Object.assign(new Error('Could not find refs/heads/main.'), {
        code: 'NotFoundError',
    });
    const engine = await engineWithFetchError(err);
    const result = await engine.pull();
    assert.equal(result.files.length, 0);
    assert.notEqual(result.pullWarning, '');
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
