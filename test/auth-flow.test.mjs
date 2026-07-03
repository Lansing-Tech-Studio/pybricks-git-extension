import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthFlow } from './load-background.mjs';
import { memStorage } from './engine-helpers.mjs';

const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

const pending = { status: 200, json: { error: 'authorization_pending' } };

function deviceCodeResponse(overrides = {}) {
    return {
        status: 200,
        json: {
            device_code: 'dc',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
            ...overrides,
        },
    };
}

// Scripted fetch: shifts canned {status, json} responses in order and records
// every call. When the script runs dry it keeps answering `whenEmpty`
// (authorization_pending by default), so a poll loop can idle without crashing
// — that endless-pending behaviour is exactly what the cancel test needs.
function scriptedFetch(responses = [], whenEmpty = pending) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body ?? '' });
        const r = responses.length ? responses.shift() : whenEmpty;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
    };
    fetch.calls = calls;
    return fetch;
}

// Instant delay that still yields a macrotask so an "endless" poll loop
// interleaves with test code (a microtask-only delay would starve the test
// and cancel() could never run). Records every requested ms.
function recordingDelay() {
    const delays = [];
    const delay = async (ms) => {
        delays.push(ms);
        await new Promise((r) => setTimeout(r, 0));
    };
    return { delay, delays };
}

async function settle(rounds = 20) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(pred, what, tries = 500) {
    for (let i = 0; i < tries; i++) {
        if (await pred()) return;
        await new Promise((r) => setTimeout(r, 0));
    }
    assert.fail(`timed out waiting for ${what}`);
}

function makeFlow({ responses = [], whenEmpty, now = 1_000_000 } = {}) {
    const storage = memStorage();
    const fetch = scriptedFetch(responses, whenEmpty);
    const { delay, delays } = recordingDelay();
    const clock = { now };
    const flow = makeAuthFlow({ fetch, storage, delay, now: () => clock.now, clientId: 'test-client' });
    return { flow, storage, fetch, delays, clock };
}

function tokenPosts(fetch) {
    return fetch.calls.filter((c) => c.url === TOKEN_URL);
}

test('start() without a configured client_id fails with a clear message', async () => {
    const fetch = scriptedFetch();
    const flow = makeAuthFlow({ fetch, storage: memStorage(), clientId: '' });
    await assert.rejects(flow.start(), /client_id|not available/);
    assert.equal(fetch.calls.length, 0);
});

test('start() stores a pending record and returns the user-facing fields', async () => {
    const { flow, storage, fetch, clock } = makeFlow({ responses: [deviceCodeResponse()] });
    const res = await flow.start();
    assert.deepEqual(res, {
        state: 'pending',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: clock.now + 900_000,
        interval: 5,
    });
    const rec = await storage.get('authFlow');
    assert.equal(rec.state, 'pending');
    assert.equal(rec.deviceCode, 'dc');
    assert.equal(rec.expiresAt, clock.now + 900_000);
    assert.equal(rec.startedAt, clock.now);
    const call = fetch.calls[0];
    assert.equal(call.url, DEVICE_URL);
    assert.equal(call.headers['Accept'], 'application/json');
    assert.match(call.body, /scope=public_repo/);
    assert.match(call.body, /client_id=test-client/);
    await flow.cancel(); // don't leave the fire-and-forget loop polling
    await settle();
});

test('poll loop lands the token and merges it into settings', async () => {
    const { flow, storage, fetch, delays } = makeFlow({
        responses: [
            deviceCodeResponse({ device_code: 'dc3' }),
            pending,
            pending,
            { status: 200, json: { access_token: 'gho_x' } },
            { status: 200, json: { login: 'kid' } },
        ],
    });
    await storage.set({
        settings: { repoUrl: 'https://github.com/t/r', branch: 'dev', name: 'Team', token: '', email: '' },
    });
    await flow.start();
    await waitFor(async () => ((await storage.get('authFlow')) ?? {}).state === 'success', 'success state');
    assert.deepEqual(await storage.get('settings'), {
        repoUrl: 'https://github.com/t/r',
        branch: 'dev',
        name: 'Team',
        token: 'gho_x',
        login: 'kid',
        email: 'kid@users.noreply.github.com',
    });
    assert.deepEqual(await storage.get('authFlow'), { state: 'success', login: 'kid' });
    const polls = tokenPosts(fetch);
    assert.equal(polls.length, 3);
    for (const p of polls) {
        assert.match(p.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
        assert.match(p.body, /device_code=dc3/);
        assert.equal(p.headers['Accept'], 'application/json');
    }
    assert.equal(fetch.calls.at(-1).url, USER_URL);
    assert.deepEqual(delays, [5000, 5000, 5000]);
});

test('slow_down bumps and persists the poll interval', async () => {
    const { flow, storage, delays } = makeFlow({
        responses: [
            deviceCodeResponse({ device_code: 'dc4' }),
            { status: 200, json: { error: 'slow_down', interval: 10 } },
            pending,
            { status: 200, json: { access_token: 'gho_y' } },
            { status: 200, json: { login: 'kid' } },
        ],
    });
    await flow.start();
    await waitFor(async () => ((await storage.get('authFlow')) ?? {}).state === 'success', 'success state');
    // Each tick re-reads the record from storage before delaying, so the
    // 10000s on ticks 2 and 3 prove the bumped interval was persisted.
    assert.deepEqual(delays, [5000, 10000, 10000]);
});

test('expired_token stops the loop with the expiry error', async () => {
    const { flow, storage, fetch } = makeFlow({
        responses: [deviceCodeResponse({ device_code: 'dc5a' }), { status: 200, json: { error: 'expired_token' } }],
    });
    await flow.start();
    await waitFor(async () => ((await storage.get('authFlow')) ?? {}).state === 'error', 'error state');
    assert.deepEqual(await storage.get('authFlow'), {
        state: 'error',
        message: 'The sign-in code expired. Start again.',
    });
    const frozen = fetch.calls.length;
    await settle();
    assert.equal(fetch.calls.length, frozen);
});

test('access_denied stops the loop with the denial error', async () => {
    const { flow, storage, fetch } = makeFlow({
        responses: [deviceCodeResponse({ device_code: 'dc5b' }), { status: 200, json: { error: 'access_denied' } }],
    });
    await flow.start();
    await waitFor(async () => ((await storage.get('authFlow')) ?? {}).state === 'error', 'error state');
    assert.deepEqual(await storage.get('authFlow'), {
        state: 'error',
        message: 'Sign-in was denied on GitHub.',
    });
    const frozen = fetch.calls.length;
    await settle();
    assert.equal(fetch.calls.length, frozen);
});

test('status() flips a stale pending record to the expiry error without polling', async () => {
    const { flow, storage, fetch, clock } = makeFlow();
    await storage.set({
        authFlow: {
            state: 'pending',
            deviceCode: 'dc6',
            userCode: 'GONE-0000',
            verificationUri: 'https://github.com/login/device',
            expiresAt: clock.now - 1,
            interval: 5,
            startedAt: clock.now - 901_000,
        },
    });
    const res = await flow.status();
    assert.equal(res.state, 'error');
    assert.equal(res.message, 'The sign-in code expired. Start again.');
    assert.equal(res.signedIn, false);
    assert.deepEqual(await storage.get('authFlow'), {
        state: 'error',
        message: 'The sign-in code expired. Start again.',
    });
    await settle();
    assert.equal(tokenPosts(fetch).length, 0);
});

test('cancel() kills a running poll loop', async () => {
    const { flow, storage, fetch } = makeFlow({ responses: [deviceCodeResponse({ device_code: 'dc7' })] });
    await flow.start(); // script is exhausted after this — endless authorization_pending
    await waitFor(() => tokenPosts(fetch).length >= 4, 'a few poll ticks');
    assert.deepEqual(await flow.cancel(), { state: 'idle' });
    await settle();
    const frozen = fetch.calls.length;
    await settle();
    assert.equal(fetch.calls.length, frozen);
    assert.deepEqual(await storage.get('authFlow'), { state: 'idle' });
});

test('status() resumes a pending flow after a worker restart', async () => {
    const { flow, storage, clock } = makeFlow({
        responses: [
            { status: 200, json: { access_token: 'gho_r' } },
            { status: 200, json: { login: 'kid' } },
        ],
    });
    // Hand-written pending record, no start() call — as if the service worker
    // was killed and restarted while the user was authorizing on github.com.
    await storage.set({
        authFlow: {
            state: 'pending',
            deviceCode: 'dc8',
            userCode: 'WXYZ-0000',
            verificationUri: 'https://github.com/login/device',
            expiresAt: clock.now + 900_000,
            interval: 5,
            startedAt: clock.now,
        },
    });
    const res = await flow.status();
    assert.equal(res.state, 'pending');
    assert.equal(res.userCode, 'WXYZ-0000');
    assert.equal(res.verificationUri, 'https://github.com/login/device');
    await waitFor(async () => ((await storage.get('settings')) ?? {}).token === 'gho_r', 'token stored');
    assert.deepEqual(await storage.get('authFlow'), { state: 'success', login: 'kid' });
});

test('signOut() clears credentials but keeps the repo config', async () => {
    const { flow, storage } = makeFlow();
    await storage.set({
        settings: {
            repoUrl: 'https://github.com/t/r',
            branch: 'dev',
            name: 'Team',
            token: 'gho_z',
            email: 'kid@users.noreply.github.com',
            login: 'kid',
        },
    });
    assert.deepEqual(await flow.signOut(), { signedIn: false });
    assert.deepEqual(await storage.get('settings'), {
        repoUrl: 'https://github.com/t/r',
        branch: 'dev',
        name: 'Team',
        token: '',
        email: '',
        login: '',
    });
    assert.deepEqual(await storage.get('authFlow'), { state: 'idle' });
});

test('a failed /user lookup still stores the token with fallback identity', async () => {
    const { flow, storage } = makeFlow({
        responses: [
            deviceCodeResponse({ device_code: 'dc10' }),
            { status: 200, json: { access_token: 'gho_f' } },
            { status: 401, json: { message: 'Bad credentials' } },
        ],
    });
    await flow.start();
    await waitFor(async () => ((await storage.get('authFlow')) ?? {}).state === 'success', 'success state');
    const s = await storage.get('settings');
    assert.equal(s.token, 'gho_f');
    assert.equal(s.email, 'team@users.noreply.github.com');
    assert.equal(s.login, '');
    assert.deepEqual(await storage.get('authFlow'), { state: 'success', login: null });
});
