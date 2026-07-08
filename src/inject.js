// MAIN-world script: runs in the page's JS context so it can open the same
// IndexedDB the Pybricks app uses. Communicates with content.js (ISOLATED)
// via window.postMessage.

const REQ = 'pybricks-git:request';
const RES = 'pybricks-git:response';

window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== REQ) return;

    try {
        const result = await handle(msg.op, msg.payload);
        window.postMessage({ type: RES, id: msg.id, ok: true, result }, '*');
    } catch (err) {
        window.postMessage(
            { type: RES, id: msg.id, ok: false, error: String(err) },
            '*',
        );
    }
});

async function handle(op, payload) {
    switch (op) {
        case 'list-databases':
            return await indexedDB.databases();
        case 'list-files':
            return await listFiles();
        case 'apply-files':
            return await applyFiles(payload);
        case 'upsert-files':
            return await upsertFiles(payload);
        default:
            throw new Error(`unknown op: ${op}`);
    }
}

// Open the Pybricks Dexie DB by name. The app's DB name isn't exposed as a
// global, so we discover it: enumerate IndexedDB databases and pick the one
// that has both a `metadata` and `_contents` table.
async function openPybricksDb() {
    const dbs = await indexedDB.databases();
    for (const info of dbs) {
        if (!info.name) continue;
        const db = await openByName(info.name);
        const names = Array.from(db.objectStoreNames);
        if (names.includes('metadata') && names.includes('_contents')) {
            return db;
        }
        db.close();
    }
    throw new Error('no Pybricks IndexedDB found');
}

function openByName(name) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked opening ' + name));
    });
}

async function listFiles() {
    const db = await openPybricksDb();
    try {
        const meta = await readAll(db, 'metadata');
        const contents = await readAll(db, '_contents');
        // Build a map by uuid (or by whatever the contents key turns out to be).
        // For the scaffold we just return both arrays so we can inspect schema.
        return { metadata: meta, contents: contents.map(stripBuffers) };
    } finally {
        db.close();
    }
}

function readAll(db, store) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// applyFiles({files: [{path, contents}]}) replaces the IDB-stored set with the
// given files: adds new ones, updates changed ones (preserving viewState +
// uuid on each metadata row), and DELETES any IDB row whose path isn't in the
// input. upsertFiles({files}) is its partial-write twin: it updates/inserts
// ONLY the given paths and never deletes — used by the menu manager to save
// menu_config.py without touching the rest of the project. Both return a
// summary count.
//
// Caveat: Pybricks wraps Dexie with dexie-observable which hooks writes
// through the Dexie API. Raw IndexedDB writes (what we do here) skip those
// hooks, so the running React UI won't reflect changes until a reload.
async function applyFiles({ files }) {
    return await writeFiles(files, true);
}

async function upsertFiles({ files }) {
    return await writeFiles(files, false);
}

async function writeFiles(files, deleteUnlisted) {
    const db = await openPybricksDb();
    try {
        // Pre-compute hashes outside the transaction (crypto.subtle is async
        // and can't be awaited inside an open IDB tx without it auto-closing).
        const enriched = await Promise.all(
            files.map(async (f) => ({
                path: f.path,
                contents: f.contents,
                sha: await sha256(f.contents),
            })),
        );

        const existingMeta = await readAll(db, 'metadata');
        const metaByPath = new Map(existingMeta.map((m) => [m.path, m]));
        const wantPaths = new Set(enriched.map((f) => f.path));

        const tx = db.transaction(['metadata', '_contents'], 'readwrite');
        const metaStore = tx.objectStore('metadata');
        const contentsStore = tx.objectStore('_contents');

        let added = 0;
        let changed = 0;
        let deleted = 0;
        let unchanged = 0;

        for (const f of enriched) {
            const existing = metaByPath.get(f.path);
            if (!existing) {
                metaStore.put({
                    path: f.path,
                    sha256: f.sha,
                    viewState: null,
                    uuid: crypto.randomUUID(),
                });
                contentsStore.put({ path: f.path, contents: f.contents });
                added++;
            } else if (existing.sha256 !== f.sha) {
                metaStore.put({ ...existing, sha256: f.sha });
                contentsStore.put({ path: f.path, contents: f.contents });
                changed++;
            } else {
                unchanged++;
            }
        }

        if (deleteUnlisted) {
            for (const m of existingMeta) {
                if (!wantPaths.has(m.path)) {
                    metaStore.delete(m[metaStore.keyPath]);
                    contentsStore.delete(m.path);
                    deleted++;
                }
            }
        }

        await txDone(tx);
        return { added, changed, deleted, unchanged };
    } finally {
        db.close();
    }
}

async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
}

function stripBuffers(row) {
    // Avoid serializing large binary blobs (e.g. Monaco view state, mpy).
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
            out[k] = `<binary ${v.byteLength} bytes>`;
        } else {
            out[k] = v;
        }
    }
    return out;
}
