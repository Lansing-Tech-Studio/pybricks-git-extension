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
// writeFilesLive instead asks Pybricks' own Redux store to do the work, the
// way its Explorer does (pybricks-code src/explorer/sagas.ts: importPythonFile
// for writes, handleExplorerDeleteFile for deletes):
//   - a text file open in an editor tab gets `editor.action.replaceFile` (the
//     open Monaco model is updated in place, with an undo stop, and the app
//     persists it);
//   - any other write gets `fileStorage.action.writeFile` (a Dexie write, so
//     the file list and every dexie-observable subscriber see it);
//   - a delete gets `fileStorage.action.deleteFile`, after closing its tab
//     with `editor.action.closeFile` (the Explorer's order — deleting an open
//     file fails as "in use", and closing also drops it from the remembered
//     tabs);
//   - a BLOCK program open in a tab is closed, written, then reopened. The
//     block editor keeps its own Blockly workspace, and nothing shows it
//     reloads when the model is replaced underneath it; a stale workspace
//     would later write the old program back. Close + reopen leaves it exactly
//     where a page reload would.
// Action shapes are from pybricks-code src/editor/actions.ts +
// src/fileStorage/actions.ts.
//
// Everything here is best effort and self-verifying: it resolves
// {live: true, summary} only once IndexedDB holds exactly the requested
// contents (and none of the deleted paths), and {live: false, reason}
// otherwise — store not found, app not initialized, anything thrown, or no
// confirmation in time. It never rejects. On {live: false} the caller falls
// back to the raw write + reload, so an upstream UI change degrades to the
// old behaviour instead of losing data.

const LIVE_WRITE_TIMEOUT_MS = 5000;
const BLOCKS_SENTINEL = '# pybricks blocks file:';

const isBlocksFile = (text) => typeof text === 'string' && text.startsWith(BLOCKS_SENTINEL);

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

// Pure: how to bring the editor to `files` through the app.
//   files          [{path, contents, sha}]   the desired contents
//   before         {metadata, contents}      the editor's IndexedDB now
//   openFileUuids  [uuid]                    tabs open in the editor, in order
//   deleteUnlisted                           true → also delete every file not
//                                            in `files` (Pull's full sync)
// Returns {close, writes, deletes, reopen, summary}: `close` = tab uuids to
// close first; `writes`/`deletes` = actions to dispatch; `reopen` = closed
// block-program tabs to reopen afterwards (open-tab order); `summary` = the
// same counts apply-files/upsert-files report. Files already holding the
// requested contents get no action (no spurious undo stop in an open tab).
function planLiveWrites({ files, before, openFileUuids, deleteUnlisted = false }) {
    const metaByPath = new Map(before.metadata.map((m) => [m.path, m]));
    const oldContents = new Map(before.contents.map((c) => [c.path, c.contents]));
    const open = new Set(openFileUuids);
    const close = new Set();
    const reopen = new Set();
    const writes = [];
    const deletes = [];
    const summary = { added: 0, changed: 0, deleted: 0, unchanged: 0 };
    const wanted = new Set();
    for (const f of files) {
        wanted.add(f.path);
        const existing = metaByPath.get(f.path);
        if (!existing) {
            summary.added++;
            writes.push({ type: 'fileStorage.action.writeFile', path: f.path, contents: f.contents });
            continue;
        }
        if (existing.sha256 === f.sha) {
            summary.unchanged++;
            continue;
        }
        summary.changed++;
        if (!open.has(existing.uuid)) {
            writes.push({ type: 'fileStorage.action.writeFile', path: f.path, contents: f.contents });
        } else if (isBlocksFile(oldContents.get(f.path)) || isBlocksFile(f.contents)) {
            close.add(existing.uuid);
            reopen.add(existing.uuid);
            writes.push({ type: 'fileStorage.action.writeFile', path: f.path, contents: f.contents });
        } else {
            writes.push({ type: 'editor.action.replaceFile', uuid: existing.uuid, value: f.contents });
        }
    }
    if (deleteUnlisted) {
        for (const m of before.metadata) {
            if (wanted.has(m.path)) continue;
            summary.deleted++;
            if (open.has(m.uuid)) close.add(m.uuid);
            deletes.push({ type: 'fileStorage.action.deleteFile', path: m.path });
        }
    }
    return {
        close: openFileUuids.filter((u) => close.has(u)),
        writes,
        deletes,
        reopen: openFileUuids.filter((u) => reopen.has(u)),
        summary,
    };
}

async function writeFilesLive({ files, deleteUnlisted = false, timeoutMs = LIVE_WRITE_TIMEOUT_MS, rootEl } = {}) {
    const store = findAppStore(rootEl);
    if (!store) return { live: false, reason: 'Pybricks app store not found' };
    // Never reject: a throw from hashing, IDB, or the app's own reducers is
    // just another reason to fall back.
    try {
        return await liveWriteAttempt(store, files, deleteUnlisted, timeoutMs);
    } catch (err) {
        return { live: false, reason: `Pybricks could not save the file this way: ${err && err.message ? err.message : err}` };
    }
}

// Polls `check` every 100ms until it returns true or the deadline passes.
async function waitUntil(check, deadline) {
    for (;;) {
        if (await check()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function liveWriteAttempt(store, files, deleteUnlisted, timeoutMs) {
    const wanted = await Promise.all(
        files.map(async (f) => ({ path: f.path, contents: f.contents, sha: await sha256(f.contents) })),
    );
    const before = await readStores();
    const { editor } = store.getState();
    const plan = planLiveWrites({ files: wanted, before, openFileUuids: editor.openFileUuids, deleteUnlisted });
    const openNow = () => store.getState().editor.openFileUuids;
    try {
        for (const uuid of plan.close) store.dispatch({ type: 'editor.action.closeFile', uuid });
        const closed = await waitUntil(
            () => plan.close.every((u) => !openNow().includes(u)),
            Date.now() + timeoutMs,
        );
        if (!closed) return { live: false, reason: 'Pybricks did not close the affected tabs in time' };

        for (const action of [...plan.writes, ...plan.deletes]) store.dispatch(action);

        const gone = plan.deletes.map((a) => a.path);
        const confirmed = await waitUntil(async () => {
            const now = await readStores();
            const byPath = new Map(now.contents.map((c) => [c.path, c.contents]));
            const shaByPath = new Map(now.metadata.map((m) => [m.path, m.sha256]));
            return (
                wanted.every((f) => byPath.get(f.path) === f.contents && shaByPath.get(f.path) === f.sha) &&
                gone.every((p) => !byPath.has(p) && !shaByPath.has(p))
            );
        }, Date.now() + timeoutMs);
        if (!confirmed) return { live: false, reason: 'Pybricks did not confirm the write in time' };
        return {
            live: true,
            dispatched: plan.writes.length + plan.deletes.length,
            summary: plan.summary,
        };
    } finally {
        // Best effort, success or not: bring back the block tabs we closed,
        // one at a time so the originally active file ends up active again.
        await reopenTabs(store, plan.reopen, editor.activeFileUuid, timeoutMs);
    }
}

async function reopenTabs(store, uuids, activeUuid, timeoutMs) {
    const order = uuids.includes(activeUuid)
        ? [...uuids.filter((u) => u !== activeUuid), activeUuid]
        : uuids;
    for (const uuid of order) {
        store.dispatch({ type: 'editor.action.activateFile', uuid });
        await waitUntil(
            () => store.getState().editor.openFileUuids.includes(uuid),
            Date.now() + timeoutMs,
        );
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
