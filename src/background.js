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
    await d.storage.set({ lastPullPaths: files.map((f) => f.path) });
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
