// MV3 service worker: the git engine. Stateless — every operation starts by
// fetching the remote head; no local clone or working tree is kept. A bare
// gitdir in lightning-fs only caches fetched objects and can be wiped freely.
//
// Loaded two ways:
//  - In Chrome: classic worker; the wiring block at the bottom (guarded by
//    `typeof importScripts`) pulls in vendored UMDs and registers listeners.
//  - In Node tests: test/load-background.mjs evaluates this file unmodified
//    and calls makeEngine with Node's fs/http and a temp gitdir.

function makeEngine(deps) {
    const d = { now: () => Date.now(), ...deps };
    return {
        status: () => statusOp(d),
        pull: () => pullOp(d),
        commit: (msg) => commitOp(d, msg ?? {}),
    };
}

async function getSettings(d) {
    const s = (await d.storage.get('settings')) ?? {};
    return {
        repoUrl: s.repoUrl ?? '',
        branch: s.branch || 'main',
        token: s.token ?? '',
        name: s.name ?? '',
        email: s.email ?? '',
    };
}

function isConfigured(s) {
    return Boolean(s.repoUrl && s.token);
}

function requireConfigured(s) {
    if (!isConfigured(s)) {
        throw new Error('not configured — click the Pybricks Git extension icon to sign in with GitHub');
    }
}

function onAuth(s) {
    return () => ({ username: 'x-access-token', password: s.token });
}

async function statusOp(d) {
    const s = await getSettings(d);
    return { ok: true, configured: isConfigured(s), branch: s.branch, head: null };
}

// Fetches the remote branch tip into the cache gitdir. Returns its oid, or
// null when the branch has no commits yet (a fresh/empty fork, or a branch
// that hasn't been pushed). Most hosts surface that as fetch resolving with
// fetchHead: null (fetch goes through the registered `origin` remote, so no
// throw); some throw "Could not find refs/heads/<branch>" instead — that one
// message is the only failure we treat as empty. Every other fetch error
// (404 wrong URL, 401 bad auth, empty/broken server response, etc.) is a real
// failure and is rethrown so the user sees it rather than a false "no commits".
async function fetchRemoteHead(d, s) {
    await d.git.init({ fs: d.fs, gitdir: d.gitdir, bare: true });
    // Register a named remote so fetch has a refspec to store the fetched ref
    // under. Fetching with a raw `url` throws NoRefspecError because a bare
    // `init` sets up no remote/refspec. `force` keeps repeat pulls idempotent.
    await d.git.addRemote({ fs: d.fs, gitdir: d.gitdir, remote: 'origin', url: s.repoUrl, force: true });
    try {
        const res = await d.git.fetch({
            fs: d.fs,
            http: d.http,
            gitdir: d.gitdir,
            remote: 'origin',
            ref: s.branch,
            singleBranch: true,
            depth: 1,
            tags: false,
            onAuth: onAuth(s),
        });
        return res.fetchHead ?? null;
    } catch (err) {
        const text = `${err && err.code} ${err && err.message}`;
        if (/Could not find refs\/heads\//i.test(text)) {
            return null; // branch has no commits yet — treat as empty repo
        }
        throw err;
    }
}

// Full recursive listing of a commit's tree: path -> {oid, mode}.
async function listAllFiles(d, commitOid) {
    const out = new Map();
    async function walk(oid, prefix) {
        const { tree } = await d.git.readTree({ fs: d.fs, gitdir: d.gitdir, oid });
        for (const entry of tree) {
            const path = prefix ? `${prefix}/${entry.path}` : entry.path;
            if (entry.type === 'tree') await walk(entry.oid, path);
            else out.set(path, { oid: entry.oid, mode: entry.mode });
        }
    }
    if (commitOid) await walk(commitOid, ''); // readTree peels a commit to its tree
    return out;
}

async function pullOp(d) {
    const s = await getSettings(d);
    requireConfigured(s);
    const head = await fetchRemoteHead(d, s);
    const files = [];
    if (head) {
        const all = await listAllFiles(d, head);
        for (const [path, entry] of all) {
            if (!path.endsWith('.py')) continue;
            const { blob } = await d.git.readBlob({ fs: d.fs, gitdir: d.gitdir, oid: entry.oid });
            files.push({ path, contents: new TextDecoder().decode(blob) });
        }
    }
    // Only update the snapshot when the editor was actually shown a file set.
    // An empty/missing-branch pull applies nothing (content.js skips it), so
    // clobbering lastPullPaths to [] here would make the next Commit treat every
    // previously-tracked path as known and delete it.
    if (head) {
        await d.storage.set({ lastPullPaths: files.map((f) => f.path) });
    }
    return {
        head: head ? head.slice(0, 7) : '',
        files,
        pullWarning: head ? '' : 'remote repository has no commits yet',
    };
}

// Git sorts tree entries as if directory names had a trailing slash.
function treeSortKey(entry) {
    return entry.type === 'tree' ? `${entry.path}/` : entry.path;
}

// Writes a full git tree (bottom-up) from a flat Map of path -> {oid, mode}.
async function writeTreeFromMap(d, fileMap) {
    const root = {};
    for (const [path, entry] of fileMap) {
        const parts = path.split('/');
        let node = root;
        for (const part of parts.slice(0, -1)) node = node[part] ??= {};
        node[parts[parts.length - 1]] = entry;
    }
    async function writeDir(node) {
        const entries = [];
        for (const [name, child] of Object.entries(node)) {
            if (child.oid) {
                entries.push({ mode: child.mode, path: name, oid: child.oid, type: 'blob' });
            } else {
                entries.push({ mode: '040000', path: name, oid: await writeDir(child), type: 'tree' });
            }
        }
        entries.sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
        return d.git.writeTree({ fs: d.fs, gitdir: d.gitdir, tree: entries });
    }
    return writeDir(root);
}

async function commitOp(d, msg) {
    const files = msg.files ?? [];
    const s = await getSettings(d);
    requireConfigured(s);
    const snapshot = new Set((await d.storage.get('lastPullPaths')) ?? []);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        const head = await fetchRemoteHead(d, s);
        if (!head && files.length === 0) {
            return { committed: false, head: '', message: 'no changes', pushed: false, preserved: [] };
        }
        const existing = await listAllFiles(d, head);
        const next = new Map(existing);
        const preserved = [];
        for (const path of existing.keys()) {
            if (!path.endsWith('.py')) continue;
            if (files.some((f) => f.path === path)) continue;
            // Delete only what a previous Pull showed the editor; never-pulled
            // files (fresh fork starter code) are preserved.
            if (snapshot.has(path)) next.delete(path);
            else preserved.push(path);
        }
        for (const f of files) {
            const oid = await d.git.writeBlob({
                fs: d.fs,
                gitdir: d.gitdir,
                blob: new TextEncoder().encode(f.contents),
            });
            next.set(f.path, { oid, mode: '100644' });
        }
        const newTree = await writeTreeFromMap(d, next);
        const oldTree = head
            ? (await d.git.readCommit({ fs: d.fs, gitdir: d.gitdir, oid: head })).commit.tree
            : null;
        if (newTree === oldTree) {
            return { committed: false, head: head.slice(0, 7), message: 'no changes', pushed: false, preserved };
        }
        const message = (msg.message ?? '').trim() || `Update from Pybricks at ${new Date(d.now()).toISOString()}`;
        const author = {
            name: s.name || 'Pybricks Team',
            email: s.email || 'team@users.noreply.github.com',
            timestamp: Math.floor(d.now() / 1000),
            timezoneOffset: 0,
        };
        const commitOid = await d.git.writeCommit({
            fs: d.fs,
            gitdir: d.gitdir,
            commit: { message, tree: newTree, parent: head ? [head] : [], author, committer: author },
        });
        await d.git.writeRef({
            fs: d.fs,
            gitdir: d.gitdir,
            ref: `refs/heads/${s.branch}`,
            value: commitOid,
            force: true,
        });
        try {
            await d.git.push({
                fs: d.fs,
                http: d.http,
                gitdir: d.gitdir,
                url: s.repoUrl,
                ref: s.branch,
                remoteRef: `refs/heads/${s.branch}`,
                onAuth: onAuth(s),
            });
            return { committed: true, head: commitOid.slice(0, 7), message, pushed: true, preserved };
        } catch (err) {
            if (err && err.code === 'PushRejectedError') {
                lastErr = err; // someone else pushed between our fetch and push — rebuild on the new head
                continue;
            }
            throw err;
        }
    }
    throw new Error(`push kept being rejected after 3 attempts: ${lastErr.message}`);
}

// --- GitHub Device Flow OAuth ---
//
// Same DI shape as makeEngine. The whole state machine lives in storage under
// the `authFlow` key: idle -> pending -> success | error. The poll loop is
// fire-and-forget and storage-driven: it re-reads `authFlow` every tick and
// stops as soon as the record is no longer the pending one it started with —
// that is how cancel() and a superseding start() kill it, with no in-memory
// abort flags to lose when the service worker is killed.

const GITHUB_CLIENT_ID = 'Ov23liqcQJLjt7WAtXm7';

// The deviceCode the poll loop in this worker instance is servicing (null when
// none). status() uses it to restart the loop after a service-worker kill.
let activePollDeviceCode = null;

const OAUTH_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
};

function makeAuthFlow(deps) {
    const d = { now: () => Date.now(), delay: (ms) => new Promise(r => setTimeout(r, ms)),
                clientId: GITHUB_CLIENT_ID, ...deps }; // deps: fetch, storage
    return { start: () => authStartOp(d), status: () => authStatusOp(d),
             cancel: () => authCancelOp(d), signOut: () => authSignOutOp(d) };
}

function expiredAuthRecord() {
    return { state: 'error', message: 'The sign-in code expired. Start again.' };
}

async function authStartOp(d) {
    if (!d.clientId) {
        throw new Error('GitHub sign-in is not available in this build: no OAuth client_id is configured. Use the Advanced section to paste a token instead.');
    }
    let data;
    try {
        const res = await d.fetch('https://github.com/login/device/code', {
            method: 'POST',
            headers: OAUTH_HEADERS,
            body: new URLSearchParams({ client_id: d.clientId, scope: 'public_repo' }).toString(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (err) {
        throw new Error(`could not start GitHub sign-in: ${err && err.message ? err.message : err}`);
    }
    if (!data || !data.device_code || !data.user_code) {
        throw new Error('could not start GitHub sign-in: GitHub returned an unexpected response');
    }
    const now = d.now();
    const record = {
        state: 'pending',
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt: now + data.expires_in * 1000,
        interval: data.interval,
        startedAt: now,
    };
    await d.storage.set({ authFlow: record });
    pollLoop(d, record.deviceCode); // fire-and-forget; storage-driven abort
    return {
        state: 'pending',
        userCode: record.userCode,
        verificationUri: record.verificationUri,
        expiresAt: record.expiresAt,
        interval: record.interval,
    };
}

// Rewrites the pending record only if it is still the one this loop services.
// An unconditional write could resurrect a flow that cancel() (or a new
// start()) killed while this tick was parked in delay/fetch.
async function keepPending(d, deviceCode, rec) {
    const cur = await d.storage.get('authFlow');
    if (cur && cur.state === 'pending' && cur.deviceCode === deviceCode) {
        await d.storage.set({ authFlow: rec });
    }
}

// Writes a terminal (error/success) authFlow record only if this loop's flow is
// still the pending one — same guard as keepPending. A loop parked in
// delay/fetch can wake after a superseding start() (or a post-cancel idle
// record) already replaced authFlow; an unconditional write would clobber that
// newer record and silently strand the flow the user is now servicing.
async function finishIfCurrent(d, deviceCode, rec) {
    const cur = await d.storage.get('authFlow');
    if (cur && cur.state === 'pending' && cur.deviceCode === deviceCode) {
        await d.storage.set({ authFlow: rec });
    }
}

// Polls GitHub for the token until the flow leaves the pending state. Each
// tick starts by re-reading `authFlow` — the storage-driven abort described
// above — and that recurring storage access is also what keeps the MV3 worker
// alive while the user is off authorizing on github.com.
async function pollLoop(d, deviceCode) {
    activePollDeviceCode = deviceCode;
    try {
        while (true) {
            const rec = await d.storage.get('authFlow');
            if (!rec || rec.state !== 'pending' || rec.deviceCode !== deviceCode) return;
            if (d.now() >= rec.expiresAt) {
                await d.storage.set({ authFlow: expiredAuthRecord() });
                return;
            }
            await d.delay(rec.interval * 1000);
            let data;
            try {
                const res = await d.fetch('https://github.com/login/oauth/access_token', {
                    method: 'POST',
                    headers: OAUTH_HEADERS,
                    body: new URLSearchParams({
                        client_id: d.clientId,
                        device_code: deviceCode,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    }).toString(),
                });
                data = (await res.json()) ?? {}; // a null body must not throw outside the try
            } catch {
                continue; // network hiccup — stay pending; expiresAt bounds the loop
            }
            if (data.access_token) {
                await authSucceed(d, deviceCode, data.access_token);
                return;
            }
            if (data.error === 'authorization_pending') {
                await keepPending(d, deviceCode, rec);
            } else if (data.error === 'slow_down') {
                rec.interval = data.interval ?? rec.interval + 5;
                await keepPending(d, deviceCode, rec);
            } else if (data.error === 'expired_token') {
                await finishIfCurrent(d, deviceCode, expiredAuthRecord());
                return;
            } else if (data.error === 'access_denied') {
                await finishIfCurrent(d, deviceCode, { state: 'error', message: 'Sign-in was denied on GitHub.' });
                return;
            } else if (data.error) {
                await finishIfCurrent(d, deviceCode, { state: 'error', message: data.error });
                return;
            }
        }
    } finally {
        // A superseding start() owns the marker by now — only clear our own.
        if (activePollDeviceCode === deviceCode) activePollDeviceCode = null;
    }
}

// Turns a fresh access token into stored credentials. The /user lookup is
// best-effort: if it fails the token is still saved, with a team fallback
// identity instead of the GitHub login.
async function authSucceed(d, deviceCode, token) {
    let login = null;
    try {
        const res = await d.fetch('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
        });
        if (res.ok) login = (await res.json()).login ?? null;
    } catch {
        // tolerated — login stays null
    }
    const settings = (await d.storage.get('settings')) ?? {};
    await d.storage.set({
        settings: {
            ...settings,
            token,
            login: login ?? '',
            email: login ? `${login}@users.noreply.github.com` : 'team@users.noreply.github.com',
        },
    });
    // The token write above is unconditional — the user did authorize it — but
    // the authFlow success flag is guarded so a superseded loop can't overwrite
    // a newer flow's pending record.
    await finishIfCurrent(d, deviceCode, { state: 'success', login });
}

// Raw settings read on purpose: getSettings() projects a fixed field list and
// would drop `login`.
async function authStatusOp(d) {
    const settings = (await d.storage.get('settings')) ?? {};
    let rec = (await d.storage.get('authFlow')) ?? { state: 'idle' };
    if (rec.state === 'pending' && d.now() >= rec.expiresAt) {
        rec = expiredAuthRecord();
        await d.storage.set({ authFlow: rec });
    }
    if (rec.state === 'pending' && activePollDeviceCode !== rec.deviceCode) {
        // The worker was killed and restarted while the user was authorizing;
        // resume polling — GitHub hands over the token on the next poll.
        pollLoop(d, rec.deviceCode);
    }
    const out = { state: rec.state, signedIn: Boolean(settings.token), login: settings.login ?? '' };
    if (rec.state === 'pending') {
        out.userCode = rec.userCode;
        out.verificationUri = rec.verificationUri;
        out.expiresAt = rec.expiresAt;
    }
    if (rec.state === 'error') out.message = rec.message;
    return out;
}

async function authCancelOp(d) {
    // Overwrite, not remove — the storage contract has no remove(). The poll
    // loop sees the non-pending record at its next tick and exits.
    await d.storage.set({ authFlow: { state: 'idle' } });
    return { state: 'idle' };
}

async function authSignOutOp(d) {
    const settings = (await d.storage.get('settings')) ?? {};
    await d.storage.set({ settings: { ...settings, token: '', email: '', login: '' } });
    await d.storage.set({ authFlow: { state: 'idle' } });
    return { signedIn: false };
}

function makeMessageHandler(engine, auth, ui = {}) {
    return (msg, _sender, sendResponse) => {
        const ops = {
            status: () => engine.status(),
            pull: () => engine.pull(),
            commit: () => engine.commit({ files: msg.files, message: msg.message }),
            authStart: () => auth.start(),
            authStatus: () => auth.status(),
            authCancel: () => auth.cancel(),
            authSignOut: () => auth.signOut(),
            openPopup: async () => {
                await ui.openPopup();
                return { opened: true };
            },
        };
        const run = ops[msg && msg.op];
        if (!run) {
            sendResponse({ error: `unknown op: ${msg && msg.op}` });
            return false;
        }
        run().then(sendResponse, (err) =>
            // A non-Error throw has no .message; {error: undefined} reads as
            // success on the content side, so coerce to a non-empty string.
            sendResponse({ error: String(err && err.message ? err.message : err) }),
        );
        return true; // async sendResponse — keep the channel open
    };
}

// --- Service-worker wiring (skipped when loaded by Node tests) ---
if (typeof importScripts === 'function') {
    importScripts(
        '../vendor/isomorphic-git.umd.js',
        '../vendor/isomorphic-git-http-web.umd.js',
        '../vendor/lightning-fs.umd.js',
    );
    const storage = {
        get: (key) => chrome.storage.local.get(key).then((o) => o[key]),
        set: (obj) => chrome.storage.local.set(obj),
    };
    const engine = makeEngine({
        git: self.git,
        http: self.GitHttp,
        fs: new self.LightningFS('pybricks-git'),
        gitdir: '/pybricks.git',
        storage,
    });
    const auth = makeAuthFlow({ fetch: (...a) => fetch(...a), storage });
    // chrome.action.openPopup() opens the settings popup for the active
    // window (available to all extensions since Chrome 127).
    const ui = { openPopup: () => chrome.action.openPopup() };
    chrome.runtime.onMessage.addListener(makeMessageHandler(engine, auth, ui));
    // Every service-worker wake-up resumes a stranded pending device flow, so
    // sign-in completes even if the popup never reopens.
    auth.status().catch(() => {});
}
