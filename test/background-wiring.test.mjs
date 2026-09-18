import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMessageHandler, describeError } from './load-background.mjs';
import { setupEngine } from './engine-helpers.mjs';

function call(handler, msg) {
    return new Promise((resolve) => {
        const keepAlive = handler(msg, {}, resolve);
        assert.equal(keepAlive, true, 'handler must return true to keep the message channel open');
    });
}

const fakeEngine = {
    status: async () => ({ ok: true, configured: true, branch: 'main', head: null }),
    pull: async () => ({ head: 'abc1234', files: [], pullWarning: '' }),
    commit: async (msg) => ({ committed: true, head: 'abc1234', message: msg.message, pushed: true, preserved: [] }),
};

const fakeAuth = {
    start: async () => ({ state: 'pending', userCode: 'X' }),
    status: async () => ({ state: 'idle', signedIn: false, login: '' }),
    cancel: async () => ({ state: 'idle' }),
    signOut: async () => ({ signedIn: false }),
};

test('routes status, pull, and commit ops to the engine', async () => {
    const handler = makeMessageHandler(fakeEngine, fakeAuth);
    assert.equal((await call(handler, { op: 'status' })).configured, true);
    assert.equal((await call(handler, { op: 'pull' })).head, 'abc1234');
    assert.equal((await call(handler, { op: 'commit', files: [], message: 'm' })).message, 'm');
});

test('routes the four auth ops to the auth flow', async () => {
    const handler = makeMessageHandler(fakeEngine, fakeAuth);
    assert.deepEqual(await call(handler, { op: 'authStart' }), { state: 'pending', userCode: 'X' });
    assert.deepEqual(await call(handler, { op: 'authStatus' }), { state: 'idle', signedIn: false, login: '' });
    assert.deepEqual(await call(handler, { op: 'authCancel' }), { state: 'idle' });
    assert.deepEqual(await call(handler, { op: 'authSignOut' }), { signedIn: false });
});

test('routes openPopup to the injected ui dep', async () => {
    let opened = 0;
    const handler = makeMessageHandler(fakeEngine, fakeAuth, {
        openPopup: async () => {
            opened++;
        },
    });
    assert.deepEqual(await call(handler, { op: 'openPopup' }), { opened: true });
    assert.equal(opened, 1);
});

test('openPopup failures come back as {error}', async () => {
    const handler = makeMessageHandler(fakeEngine, fakeAuth, {
        openPopup: async () => {
            throw new Error('no active window');
        },
    });
    assert.equal((await call(handler, { op: 'openPopup' })).error, 'no active window');
});

test('openPopup without a ui dep still responds with {error}, not a hang', async () => {
    // Node tests build handlers without ui; the op must fail cleanly there.
    const handler = makeMessageHandler(fakeEngine, fakeAuth);
    const res = await call(handler, { op: 'openPopup' });
    assert.ok(res.error, 'expected an {error} response');
});

test('engine failures come back as {error} instead of hanging', async () => {
    const handler = makeMessageHandler({
        ...fakeEngine,
        pull: async () => {
            throw new Error('boom');
        },
    }, fakeAuth);
    assert.equal((await call(handler, { op: 'pull' })).error, 'boom');
});

test('auth failures come back as {error} instead of hanging', async () => {
    const handler = makeMessageHandler(fakeEngine, {
        ...fakeAuth,
        start: async () => {
            throw new Error('auth boom');
        },
    });
    assert.equal((await call(handler, { op: 'authStart' })).error, 'auth boom');
});

test('non-Error rejections still come back as a stringified {error}', async () => {
    // A throw of a plain string has no .message, so {error: err.message} was
    // {error: undefined} — which content.js treats as success. Stringify it.
    const handler = makeMessageHandler({
        ...fakeEngine,
        pull: async () => {
            throw 'plain string boom';
        },
    }, fakeAuth);
    assert.equal((await call(handler, { op: 'pull' })).error, 'plain string boom');
});

test('unknown ops come back as {error} synchronously', () => {
    const handler = makeMessageHandler(fakeEngine, fakeAuth);
    let got;
    const keepAlive = handler({ op: 'nope' }, {}, (res) => (got = res));
    assert.equal(keepAlive, false);
    assert.match(got.error, /unknown op/);
});

test('error responses carry details with the op and the engine context', async () => {
    const handler = makeMessageHandler({
        ...fakeEngine,
        commit: async () => {
            throw new Error('boom');
        },
        errorContext: async () => ({ repoUrl: 'https://github.com/team/robot', branch: 'main', secrets: [] }),
    }, fakeAuth);
    const res = await call(handler, { op: 'commit', files: [], message: '' });
    assert.equal(res.error, 'boom');
    assert.equal(res.details.op, 'commit');
    assert.ok(res.details.lines.includes('Operation: commit'));
    assert.ok(res.details.lines.includes('Repo: https://github.com/team/robot'));
    assert.ok(res.details.lines.includes('Branch: main'));
    assert.ok(res.details.lines.includes('Error: boom'));
});

test('a failing errorContext still produces an error response', async () => {
    const handler = makeMessageHandler({
        ...fakeEngine,
        pull: async () => {
            throw new Error('boom');
        },
        errorContext: async () => {
            throw new Error('storage gone');
        },
    }, fakeAuth);
    const res = await call(handler, { op: 'pull' });
    assert.equal(res.error, 'boom');
    assert.equal(res.details.op, 'pull');
});

test('describeError spells out an isomorphic-git HttpError', () => {
    const err = Object.assign(new Error('HTTP Error: 404 Not Found'), {
        name: 'HttpError',
        code: 'HttpError',
        caller: 'git.fetch',
        data: { statusCode: 404, statusMessage: 'Not Found', response: 'Repository not found.' },
    });
    const d = describeError(err, { op: 'pull' });
    assert.equal(d.code, 'HttpError');
    assert.match(d.hint, /couldn't find the repo/);
    assert.ok(d.lines.includes('Step: git.fetch'));
    assert.ok(d.lines.includes('Error: HttpError: HTTP Error: 404 Not Found'));
    assert.ok(d.lines.includes('HTTP status: 404 Not Found'));
    assert.ok(d.lines.includes('Server said: Repository not found.'));
    assert.ok(d.lines.includes('Stack:'));
});

test('describeError hints at the common failures', () => {
    const http = (statusCode) =>
        Object.assign(new Error(`HTTP Error: ${statusCode}`), { code: 'HttpError', data: { statusCode } });
    assert.match(describeError(http(401)).hint, /sign in again/);
    assert.match(describeError(http(403)).hint, /refused access/);
    assert.match(describeError(http(502)).hint, /GitHub had a problem/);
    assert.match(describeError(new TypeError('Failed to fetch')).hint, /internet connection/);
    assert.match(describeError(new Error('push kept being rejected after 3 attempts: x')).hint, /Teammates/);
    assert.match(describeError(new Error('not configured — click the icon')).hint, /sign in/);
    assert.equal(describeError(new Error('something odd')).hint, null);
});

test('describeError includes non-HTTP error data', () => {
    const err = Object.assign(new Error('push failed'), {
        code: 'GitPushError',
        data: { prettyDetails: 'protected branch hook declined' },
    });
    const d = describeError(err);
    assert.match(d.hint, /protected/);
    assert.ok(d.lines.some((l) => l.includes('protected branch hook declined')));
});

test('describeError never leaks the token or URL credentials', () => {
    const token = 'ghp_supersecret123';
    const err = new Error(`auth failed for https://x-access-token:${token}@github.com/team/robot`);
    const d = describeError(err, { repoUrl: `https://me:${token}@github.com/team/robot`, secrets: [token] });
    const text = [d.message, ...d.lines].join('\n');
    assert.ok(!text.includes(token), text);
    assert.ok(text.includes('https://***@github.com/team/robot'));
});

test('describeError truncates a huge server response', () => {
    const err = Object.assign(new Error('HTTP Error: 500'), {
        code: 'HttpError',
        data: { statusCode: 500, response: 'x'.repeat(10000) },
    });
    const line = describeError(err).lines.find((l) => l.startsWith('Server said:'));
    assert.ok(line.length < 2100);
    assert.match(line, /more characters/);
});

test('a real 404 from the git server comes back with full details', async () => {
    const { engine, storage, server } = await setupEngine({ 'a.py': 'x = 1\n' });
    try {
        const s = await storage.get('settings');
        await storage.set({ settings: { ...s, repoUrl: `${server.url}/nope.git` } });
        const res = await call(makeMessageHandler(engine, fakeAuth), { op: 'pull' });
        assert.match(res.error, /404/);
        assert.match(res.details.hint, /couldn't find the repo/);
        assert.ok(res.details.lines.includes('HTTP status: 404 Not Found'));
        assert.ok(res.details.lines.includes(`Repo: ${server.url}/nope.git`));
        assert.ok(!res.details.lines.join('\n').includes('test-token'));
    } finally {
        await server.close();
    }
});
