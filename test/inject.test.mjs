// Unit tests for src/inject.js — specifically applyFiles (the add / change /
// delete / unchanged diff against the page's IndexedDB) and sha256.
//
// We run against a real in-memory IndexedDB provided by fake-indexeddb, wired
// to mirror the Pybricks schema discovered in CLAUDE.md:
//   metadata   keyPath "uuid"   { path, sha256, viewState, uuid }
//   _contents  keyPath "path"   { path, contents }
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { loadInject } from './load-inject.mjs';

const { applyFiles, sha256 } = loadInject();

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
