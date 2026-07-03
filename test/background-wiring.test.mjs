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

test('routes status, pull, and commit ops to the engine', async () => {
    const handler = makeMessageHandler(fakeEngine);
    assert.equal((await call(handler, { op: 'status' })).configured, true);
    assert.equal((await call(handler, { op: 'pull' })).head, 'abc1234');
    assert.equal((await call(handler, { op: 'commit', files: [], message: 'm' })).message, 'm');
});

test('engine failures come back as {error} instead of hanging', async () => {
    const handler = makeMessageHandler({
        ...fakeEngine,
        pull: async () => {
            throw new Error('boom');
        },
    });
    assert.deepEqual(await call(handler, { op: 'pull' }), { error: 'boom' });
});

test('unknown ops come back as {error} synchronously', () => {
    const handler = makeMessageHandler(fakeEngine);
    let got;
    const keepAlive = handler({ op: 'nope' }, {}, (res) => (got = res));
    assert.equal(keepAlive, false);
    assert.match(got.error, /unknown op/);
});
