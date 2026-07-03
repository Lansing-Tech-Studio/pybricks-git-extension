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
        throw new Error('not configured — click the Pybricks Git extension icon to set fork URL and token');
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
// null when the remote exists but has no commits yet (fresh fork edge case).
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
        if (/NotFoundError|NoRefSpecError|EmptyServerResponse|Could not find|no refs/i.test(text)) {
            return null;
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
    await d.storage.set({ lastPullPaths: files.map((f) => f.path) });
    return {
        head: head ? head.slice(0, 7) : '',
        files,
        pullWarning: head ? '' : 'remote repository has no commits yet',
    };
}

async function commitOp(d, msg) {
    throw new Error('commit not implemented yet');
}
