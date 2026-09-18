// Unit tests for src/inject.js — specifically applyFiles (the add / change /
// delete / unchanged diff against the page's IndexedDB) and sha256.
//
// We run against a real in-memory IndexedDB provided by fake-indexeddb, wired
// to mirror the Pybricks schema discovered in CLAUDE.md:
//   metadata   keyPath "uuid"   { path, sha256, viewState, uuid }
//   _contents  keyPath "path"   { path, contents }
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { loadInject } from './load-inject.mjs';

const { applyFiles, upsertFiles, sha256, findAppStore, planLiveWrites, writeFilesLive } = loadInject();

// Reference SHA-256 hex, computed independently of the code under test.
const hexSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// Each test gets a clean IndexedDB. inject.js reads the global `indexedDB`
// lazily on every call, so swapping the global here fully isolates tests.
beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

// --- IndexedDB helpers (mirror the Pybricks schema) ---

function openPybricks() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('pybricks', 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('metadata', { keyPath: 'uuid' });
            db.createObjectStore('_contents', { keyPath: 'path' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function put(db, store, row) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getAll(db, store) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// Seed the metadata + _contents stores with a set of files, computing each
// row's sha256 the way Pybricks would. Returns the seeded metadata rows.
async function seed(db, files) {
    const meta = [];
    for (const f of files) {
        const row = {
            path: f.path,
            sha256: f.sha256 ?? hexSha(f.contents),
            viewState: f.viewState ?? null,
            uuid: f.uuid,
        };
        await put(db, 'metadata', row);
        await put(db, '_contents', { path: f.path, contents: f.contents });
        meta.push(row);
    }
    return meta;
}

async function snapshot(db) {
    const meta = await getAll(db, 'metadata');
    const contents = await getAll(db, '_contents');
    const byPath = {};
    for (const c of contents) byPath[c.path] = c.contents;
    const metaByPath = {};
    for (const m of meta) metaByPath[m.path] = m;
    return { byPath, metaByPath, metaCount: meta.length, contentCount: contents.length };
}

// --- sha256 ---

test('sha256 matches a reference SHA-256 hex digest', async () => {
    assert.equal(await sha256(''), hexSha(''));
    assert.equal(await sha256('print("hi")\n'), hexSha('print("hi")\n'));
    // Non-ASCII must hash by UTF-8 bytes, like Pybricks does.
    assert.equal(await sha256('ñ→λ'), hexSha('ñ→λ'));
    // Lowercase, zero-padded, 64 hex chars.
    assert.match(await sha256('x'), /^[0-9a-f]{64}$/);
});

// --- applyFiles: add ---

test('adds new files into an empty database', async () => {
    const db = await openPybricks();
    const summary = await applyFiles({
        files: [
            { path: 'main.py', contents: 'print(1)\n' },
            { path: 'lib/util.py', contents: 'x = 2\n' },
        ],
    });
    assert.deepEqual(summary, { added: 2, changed: 0, deleted: 0, unchanged: 0 });

    const snap = await snapshot(db);
    assert.equal(snap.byPath['main.py'], 'print(1)\n');
    assert.equal(snap.byPath['lib/util.py'], 'x = 2\n');
    // Each new metadata row gets the correct sha, a null viewState, and a uuid.
    const m = snap.metaByPath['main.py'];
    assert.equal(m.sha256, hexSha('print(1)\n'));
    assert.equal(m.viewState, null);
    assert.match(m.uuid, /[0-9a-f-]{36}/);
});

// --- applyFiles: unchanged ---

test('leaves unchanged files alone and preserves uuid + viewState', async () => {
    const db = await openPybricks();
    const viewState = { cursor: [1, 4], scroll: 12 };
    await seed(db, [
        { path: 'main.py', contents: 'print(1)\n', uuid: 'uuid-keep', viewState },
    ]);

    const summary = await applyFiles({
        files: [{ path: 'main.py', contents: 'print(1)\n' }],
    });
    assert.deepEqual(summary, { added: 0, changed: 0, deleted: 0, unchanged: 1 });

    const m = (await snapshot(db)).metaByPath['main.py'];
    assert.equal(m.uuid, 'uuid-keep', 'uuid must be preserved');
    assert.deepEqual(m.viewState, viewState, 'viewState must be preserved');
});

// --- applyFiles: change ---

test('updates changed files but keeps uuid + viewState, refreshing sha256', async () => {
    const db = await openPybricks();
    const viewState = { cursor: [3, 0] };
    await seed(db, [
        {
            path: 'main.py',
            contents: 'old\n',
            uuid: 'uuid-stable',
            viewState,
            // Seed with a deliberately stale sha so the diff sees a change.
            sha256: hexSha('old\n'),
        },
    ]);

    const summary = await applyFiles({
        files: [{ path: 'main.py', contents: 'new contents\n' }],
    });
    assert.deepEqual(summary, { added: 0, changed: 1, deleted: 0, unchanged: 0 });

    const snap = await snapshot(db);
    assert.equal(snap.byPath['main.py'], 'new contents\n');
    const m = snap.metaByPath['main.py'];
    assert.equal(m.uuid, 'uuid-stable', 'uuid must survive an update');
    assert.deepEqual(m.viewState, viewState, 'viewState must survive an update');
    assert.equal(m.sha256, hexSha('new contents\n'), 'sha256 must be refreshed');
});

// --- applyFiles: delete ---

test('deletes files absent from the payload from both stores', async () => {
    const db = await openPybricks();
    await seed(db, [
        { path: 'keep.py', contents: 'k\n', uuid: 'u-keep' },
        { path: 'gone.py', contents: 'g\n', uuid: 'u-gone' },
    ]);

    const summary = await applyFiles({
        files: [{ path: 'keep.py', contents: 'k\n' }],
    });
    assert.deepEqual(summary, { added: 0, changed: 0, deleted: 1, unchanged: 1 });

    const snap = await snapshot(db);
    assert.equal(snap.metaCount, 1);
    assert.equal(snap.contentCount, 1);
    assert.ok(snap.byPath['keep.py']);
    assert.equal(snap.byPath['gone.py'], undefined, 'contents row must be deleted');
    assert.equal(snap.metaByPath['gone.py'], undefined, 'metadata row must be deleted');
});

// --- applyFiles: mixed batch + block-file round-trip ---

test('handles add + change + delete + unchanged in one call, byte-for-byte', async () => {
    const db = await openPybricks();
    const block = '# pybricks blocks file:{"blocks":[{"x":1}]}\nfrom pybricks import *\n';
    await seed(db, [
        { path: 'same.py', contents: 'same\n', uuid: 'u-same' },
        { path: 'edit.py', contents: 'before\n', uuid: 'u-edit' },
        { path: 'remove.py', contents: 'bye\n', uuid: 'u-remove' },
    ]);

    const summary = await applyFiles({
        files: [
            { path: 'same.py', contents: 'same\n' }, // unchanged
            { path: 'edit.py', contents: 'after\n' }, // changed
            { path: 'blocks.py', contents: block }, // added (block program)
        ],
    });
    assert.deepEqual(summary, { added: 1, changed: 1, deleted: 1, unchanged: 1 });

    const snap = await snapshot(db);
    assert.equal(snap.byPath['same.py'], 'same\n');
    assert.equal(snap.byPath['edit.py'], 'after\n');
    assert.equal(snap.byPath['blocks.py'], block, 'block sentinel line must round-trip exactly');
    assert.equal(snap.byPath['remove.py'], undefined);
});

// --- upsertFiles: partial write that never deletes ---

describe('upsertFiles', () => {
    test('updates listed paths, leaves unlisted paths alone', async () => {
        const db = await openPybricks();
        const viewState = { cursor: [2, 7], scroll: 40 };
        await seed(db, [
            { path: 'a.py', contents: 'old a\n', uuid: 'uuid-a', viewState },
            { path: 'b.py', contents: 'b body\n', uuid: 'uuid-b', viewState: { scroll: 3 } },
        ]);

        const summary = await upsertFiles({ files: [{ path: 'a.py', contents: 'new a\n' }] });
        assert.deepEqual(summary, { added: 0, changed: 1, deleted: 0, unchanged: 0 });

        const snap = await snapshot(db);
        // a.py: contents updated, sha256 recomputed, uuid + viewState preserved.
        assert.equal(snap.byPath['a.py'], 'new a\n');
        const a = snap.metaByPath['a.py'];
        assert.equal(a.uuid, 'uuid-a', 'uuid must be preserved on update');
        assert.deepEqual(a.viewState, viewState, 'viewState must be preserved on update');
        assert.equal(a.sha256, hexSha('new a\n'), 'sha256 must be recomputed');
        // b.py: untouched and still present (never in the payload).
        assert.equal(snap.metaCount, 2, 'unlisted path must survive');
        assert.equal(snap.byPath['b.py'], 'b body\n', 'unlisted contents untouched');
        const b = snap.metaByPath['b.py'];
        assert.equal(b.uuid, 'uuid-b');
        assert.deepEqual(b.viewState, { scroll: 3 });
    });

    test('inserts new paths with fresh uuid and null viewState', async () => {
        const db = await openPybricks();
        await seed(db, [{ path: 'a.py', contents: 'a body\n', uuid: 'uuid-a' }]);

        const summary = await upsertFiles({
            files: [{ path: 'menu_config.py', contents: 'MENU_ITEMS = []\n' }],
        });
        assert.deepEqual(summary, { added: 1, changed: 0, deleted: 0, unchanged: 0 });

        const snap = await snapshot(db);
        // Existing file untouched; new file inserted.
        assert.equal(snap.metaCount, 2, 'existing path must survive an insert');
        assert.equal(snap.byPath['a.py'], 'a body\n');
        assert.equal(snap.byPath['menu_config.py'], 'MENU_ITEMS = []\n');
        const m = snap.metaByPath['menu_config.py'];
        assert.match(m.uuid, /[0-9a-f-]{36}/, 'new row gets a fresh uuid');
        assert.notEqual(m.uuid, 'uuid-a');
        assert.equal(m.viewState, null, 'new row gets a null viewState');
        assert.equal(m.sha256, hexSha('MENU_ITEMS = []\n'));
    });

    test('unchanged contents counted, not rewritten', async () => {
        const db = await openPybricks();
        const viewState = { cursor: [0, 0] };
        await seed(db, [{ path: 'a.py', contents: 'a body\n', uuid: 'uuid-a', viewState }]);

        const summary = await upsertFiles({ files: [{ path: 'a.py', contents: 'a body\n' }] });
        assert.deepEqual(summary, { added: 0, changed: 0, deleted: 0, unchanged: 1 });

        const m = (await snapshot(db)).metaByPath['a.py'];
        assert.equal(m.uuid, 'uuid-a', 'uuid untouched on a no-op');
        assert.deepEqual(m.viewState, viewState, 'viewState untouched on a no-op');
    });

    test('applyFiles still deletes unlisted paths (regression)', async () => {
        const db = await openPybricks();
        await seed(db, [
            { path: 'keep.py', contents: 'k\n', uuid: 'u-keep' },
            { path: 'gone.py', contents: 'g\n', uuid: 'u-gone' },
        ]);

        const summary = await applyFiles({ files: [{ path: 'keep.py', contents: 'k\n' }] });
        assert.deepEqual(summary, { added: 0, changed: 0, deleted: 1, unchanged: 1 });

        const snap = await snapshot(db);
        assert.equal(snap.metaCount, 1);
        assert.equal(snap.contentCount, 1);
        assert.equal(snap.byPath['gone.py'], undefined, 'applyFiles must still delete unlisted paths');
        assert.equal(snap.metaByPath['gone.py'], undefined);
    });
});

// --- openPybricksDb discovery ---

test('discovers the Pybricks DB by its store names, not its name', async () => {
    // A decoy database that lacks the _contents store must be skipped.
    await new Promise((resolve, reject) => {
        const req = indexedDB.open('some-other-db', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('metadata', { keyPath: 'uuid' });
        req.onsuccess = () => {
            req.result.close();
            resolve();
        };
        req.onerror = () => reject(req.error);
    });
    const db = await openPybricks();
    db.close();

    // applyFiles must find the real DB (with both stores) and write into it.
    const summary = await applyFiles({ files: [{ path: 'a.py', contents: 'a\n' }] });
    assert.equal(summary.added, 1);
});

// --- writeFilesLive: writing through the app's Redux store ---

// A fake React root: #root carries a __reactContainer$ fiber whose subtree
// holds the react-redux Provider (memoizedProps.store) a few levels down,
// behind a sibling, with a text fiber (string props) on the way.
function fakeRoot(store) {
    const provider = { memoizedProps: { store, children: {} }, child: null, sibling: null };
    const textNode = { memoizedProps: 'hello', child: null, sibling: provider };
    const app = { memoizedProps: {}, child: textNode, sibling: null };
    return { '__reactContainer$abc123': { memoizedProps: null, child: app, sibling: null } };
}

// A fake store that behaves like Pybricks' sagas: replaceFile/writeFile end
// in a Dexie write, done here with upsertFiles (after a tick, as a saga would).
function fakeStore({ openFileUuids = [], initialized = true, onDispatch } = {}) {
    const dispatched = [];
    return {
        dispatched,
        getState: () => ({ editor: { openFileUuids }, fileStorage: { isInitialized: initialized } }),
        dispatch(action) {
            dispatched.push(action);
            if (onDispatch) onDispatch(action);
        },
    };
}

async function actLikePybricks(action, db) {
    await new Promise((r) => setTimeout(r, 20));
    if (action.type === 'fileStorage.action.writeFile') {
        await upsertFiles({ files: [{ path: action.path, contents: action.contents }] });
    } else if (action.type === 'editor.action.replaceFile') {
        const meta = await getAll(db, 'metadata');
        const row = meta.find((m) => m.uuid === action.uuid);
        await upsertFiles({ files: [{ path: row.path, contents: action.value }] });
    }
}

describe('findAppStore', () => {
    test('finds the Provider store in the fiber tree', () => {
        const store = fakeStore();
        assert.equal(findAppStore(fakeRoot(store)), store);
    });

    test('returns null without a React container, or with an unexpected state shape', () => {
        assert.equal(findAppStore(null), null);
        assert.equal(findAppStore({}), null);
        const odd = { getState: () => ({ other: 1 }), dispatch() {} };
        assert.equal(findAppStore(fakeRoot(odd)), null);
    });

    test('ignores the store until file storage is initialized', () => {
        assert.equal(findAppStore(fakeRoot(fakeStore({ initialized: false }))), null);
    });
});

describe('planLiveWrites', () => {
    const meta = [
        { path: 'menu_config.py', uuid: 'u-menu', sha256: 'old' },
        { path: 'open.py', uuid: 'u-open', sha256: 'old' },
        { path: 'same.py', uuid: 'u-same', sha256: 'same' },
    ];

    test('open files go through the editor, others through file storage, unchanged ones not at all', () => {
        const actions = planLiveWrites(
            [
                { path: 'menu_config.py', contents: 'M', sha: 'new' },
                { path: 'open.py', contents: 'O', sha: 'new' },
                { path: 'same.py', contents: 'S', sha: 'same' },
                { path: 'fresh.py', contents: 'F', sha: 'new' },
            ],
            meta,
            ['u-open', 'u-same'],
        );
        assert.deepEqual(actions, [
            { type: 'fileStorage.action.writeFile', path: 'menu_config.py', contents: 'M' },
            { type: 'editor.action.replaceFile', uuid: 'u-open', value: 'O' },
            { type: 'fileStorage.action.writeFile', path: 'fresh.py', contents: 'F' },
        ]);
    });
});

describe('writeFilesLive', () => {
    test('writes a closed file through fileStorage and confirms it in IndexedDB', async () => {
        const db = await openPybricks();
        await seed(db, [{ path: 'menu_config.py', contents: 'old\n', uuid: 'u-menu', viewState: { top: 3 } }]);
        const store = fakeStore({ onDispatch: (a) => actLikePybricks(a, db) });
        const res = await writeFilesLive({
            files: [{ path: 'menu_config.py', contents: 'new\n' }],
            rootEl: fakeRoot(store),
        });
        assert.deepEqual(res, { live: true, dispatched: 1 });
        assert.equal(store.dispatched[0].type, 'fileStorage.action.writeFile');
        const snap = await snapshot(db);
        assert.equal(snap.byPath['menu_config.py'], 'new\n');
        assert.deepEqual(snap.metaByPath['menu_config.py'].viewState, { top: 3 });
    });

    test('replaces an open file through the editor', async () => {
        const db = await openPybricks();
        await seed(db, [{ path: 'menu_config.py', contents: 'old\n', uuid: 'u-menu' }]);
        const store = fakeStore({ openFileUuids: ['u-menu'], onDispatch: (a) => actLikePybricks(a, db) });
        const res = await writeFilesLive({
            files: [{ path: 'menu_config.py', contents: 'new\n' }],
            rootEl: fakeRoot(store),
        });
        assert.equal(res.live, true);
        assert.deepEqual(store.dispatched, [{ type: 'editor.action.replaceFile', uuid: 'u-menu', value: 'new\n' }]);
    });

    test('creates a missing file through fileStorage', async () => {
        const db = await openPybricks();
        const store = fakeStore({ onDispatch: (a) => actLikePybricks(a, db) });
        const res = await writeFilesLive({
            files: [{ path: 'menu_config.py', contents: 'new\n' }],
            rootEl: fakeRoot(store),
        });
        assert.equal(res.live, true);
        assert.equal((await snapshot(db)).byPath['menu_config.py'], 'new\n');
    });

    test('an unchanged file dispatches nothing and still confirms', async () => {
        const db = await openPybricks();
        await seed(db, [{ path: 'menu_config.py', contents: 'same\n', uuid: 'u-menu' }]);
        const store = fakeStore({ openFileUuids: ['u-menu'] });
        const res = await writeFilesLive({
            files: [{ path: 'menu_config.py', contents: 'same\n' }],
            rootEl: fakeRoot(store),
        });
        assert.deepEqual(res, { live: true, dispatched: 0 });
        assert.deepEqual(store.dispatched, []);
    });

    test('reports live:false when the app never writes (so the caller can fall back)', async () => {
        const db = await openPybricks();
        await seed(db, [{ path: 'menu_config.py', contents: 'old\n', uuid: 'u-menu' }]);
        const store = fakeStore(); // swallows the action, as a renamed action type would
        const res = await writeFilesLive({
            files: [{ path: 'menu_config.py', contents: 'new\n' }],
            rootEl: fakeRoot(store),
            timeoutMs: 300,
        });
        assert.equal(res.live, false);
        assert.match(res.reason, /did not confirm/);
        assert.equal((await snapshot(db)).byPath['menu_config.py'], 'old\n', 'nothing written behind the app');
    });

    test('a throwing dispatch resolves live:false instead of rejecting', async () => {
        const db = await openPybricks();
        await seed(db, [{ path: 'menu_config.py', contents: 'old\n', uuid: 'u-menu' }]);
        const store = fakeStore({
            onDispatch: () => {
                throw new Error('reducer exploded');
            },
        });
        const res = await writeFilesLive({
            files: [{ path: 'menu_config.py', contents: 'new\n' }],
            rootEl: fakeRoot(store),
        });
        assert.equal(res.live, false);
        assert.match(res.reason, /could not save the file this way: reducer exploded/);
    });

    test('a missing Pybricks database resolves live:false instead of rejecting', async () => {
        // Fresh IDBFactory from beforeEach: no DB with metadata/_contents exists.
        const res = await writeFilesLive({
            files: [{ path: 'menu_config.py', contents: 'new\n' }],
            rootEl: fakeRoot(fakeStore()),
        });
        assert.equal(res.live, false);
        assert.match(res.reason, /no Pybricks IndexedDB found/);
    });

    test('reports live:false without touching IndexedDB when no store is found', async () => {
        const res = await writeFilesLive({ files: [{ path: 'a.py', contents: 'a' }], rootEl: {} });
        assert.deepEqual(res, { live: false, reason: 'Pybricks app store not found' });
    });
});
