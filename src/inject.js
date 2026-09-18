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
        case 'write-files-live':
            return await writeFilesLive(payload);
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

// --- Writing through the app (no reload) --------------------------------
//
// Raw IDB writes (above) are invisible to the running app, so callers used to
// follow them with a page reload — which drops the hub's Bluetooth link.
// writeFilesLive instead asks Pybricks' own Redux store to do the write, the
// way its Explorer "Import file" does: a file open in an editor tab gets
// `editor.action.replaceFile` (the open Monaco model is updated in place, with
// an undo stop, and the app persists it), any other file gets
// `fileStorage.action.writeFile` (a Dexie write, so the file list and every
// dexie-observable subscriber see it). Action shapes are from pybricks-code
// src/editor/actions.ts + src/fileStorage/actions.ts.
//
// Everything here is best effort and self-verifying: it resolves
// {live: true} only once IndexedDB holds exactly the requested contents, and
// {live: false, reason} otherwise — store not found, app not initialized, or
// no confirmation within timeoutMs. On {live: false} the caller falls back
// to upsert-files + reload, so an upstream UI change degrades to the old
// behaviour instead of losing a save.

const LIVE_WRITE_TIMEOUT_MS = 5000;

// The app's Redux store, found by walking React's fiber tree from the root
// container down to the react-redux <Provider store>. Only a store whose
// state has the shape we rely on counts. Null when anything is missing.
function findAppStore(rootEl = document.getElementById('root')) {
    if (!rootEl) return null;
    const key = Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$'));
    if (!key) return null;
    const stack = [rootEl[key]];
    // The Provider sits near the top of the tree; the cap only bounds a
    // pathological walk if it ever moves or disappears.
    for (let visited = 0; stack.length && visited < 5000; visited++) {
        const fiber = stack.pop();
        if (!fiber) continue;
        const props = fiber.memoizedProps;
        const store = props && typeof props === 'object' ? props.store : null;
        if (store && typeof store.dispatch === 'function' && typeof store.getState === 'function') {
            const st = store.getState();
            if (
                st && st.editor && Array.isArray(st.editor.openFileUuids) &&
                st.fileStorage && st.fileStorage.isInitialized === true
            ) {
                return store;
            }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
    }
    return null;
}

// Pure: which action writes each file. Files already holding the requested
// contents get none (no spurious undo stop in an open tab).
function planLiveWrites(files, metadata, openFileUuids) {
    const metaByPath = new Map(metadata.map((m) => [m.path, m]));
    const open = new Set(openFileUuids);
    const actions = [];
    for (const f of files) {
        const existing = metaByPath.get(f.path);
        if (existing && existing.sha256 === f.sha) continue;
        if (existing && open.has(existing.uuid)) {
            actions.push({ type: 'editor.action.replaceFile', uuid: existing.uuid, value: f.contents });
        } else {
            actions.push({ type: 'fileStorage.action.writeFile', path: f.path, contents: f.contents });
        }
    }
    return actions;
}

async function writeFilesLive({ files, timeoutMs = LIVE_WRITE_TIMEOUT_MS, rootEl } = {}) {
    const store = findAppStore(rootEl);
    if (!store) return { live: false, reason: 'Pybricks app store not found' };
    // Never reject: a throw from hashing, IDB, or the app's own reducers is
    // just another reason to fall back.
    try {
        return await liveWriteAttempt(store, files, timeoutMs);
    } catch (err) {
        return { live: false, reason: `Pybricks could not save the file this way: ${err && err.message ? err.message : err}` };
    }
}

async function liveWriteAttempt(store, files, timeoutMs) {
    const wanted = await Promise.all(
        files.map(async (f) => ({ path: f.path, contents: f.contents, sha: await sha256(f.contents) })),
    );
    const before = await readStores();
    const actions = planLiveWrites(wanted, before.metadata, store.getState().editor.openFileUuids);
    for (const action of actions) store.dispatch(action);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const now = await readStores();
        const byPath = new Map(now.contents.map((c) => [c.path, c.contents]));
        const shaByPath = new Map(now.metadata.map((m) => [m.path, m.sha256]));
        const done = wanted.every(
            (f) => byPath.get(f.path) === f.contents && shaByPath.get(f.path) === f.sha,
        );
        if (done) return { live: true, dispatched: actions.length };
        if (Date.now() >= deadline) {
            return { live: false, reason: 'Pybricks did not confirm the write in time' };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function readStores() {
    const db = await openPybricksDb();
    try {
        return { metadata: await readAll(db, 'metadata'), contents: await readAll(db, '_contents') };
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
