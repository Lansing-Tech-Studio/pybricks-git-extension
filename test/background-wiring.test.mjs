import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMessageHandler } from './load-background.mjs';

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
    assert.deepEqual(await call(handler, { op: 'openPopup' }), { error: 'no active window' });
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
    assert.deepEqual(await call(handler, { op: 'pull' }), { error: 'boom' });
});

test('auth failures come back as {error} instead of hanging', async () => {
    const handler = makeMessageHandler(fakeEngine, {
        ...fakeAuth,
        start: async () => {
            throw new Error('auth boom');
        },
    });
    assert.deepEqual(await call(handler, { op: 'authStart' }), { error: 'auth boom' });
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
    assert.deepEqual(await call(handler, { op: 'pull' }), { error: 'plain string boom' });
});

test('unknown ops come back as {error} synchronously', () => {
    const handler = makeMessageHandler(fakeEngine, fakeAuth);
    let got;
    const keepAlive = handler({ op: 'nope' }, {}, (res) => (got = res));
    assert.equal(keepAlive, false);
    assert.match(got.error, /unknown op/);
});
