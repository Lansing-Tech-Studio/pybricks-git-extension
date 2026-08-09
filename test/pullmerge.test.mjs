import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPullMerge } from './load-pullmerge.mjs';

const { rescueName, planPull } = loadPullMerge();

describe('rescueName', () => {
    test('inserts _mine before the extension', () => {
        assert.equal(rescueName('mission2.py', new Set()), 'mission2_mine.py');
    });

    test('keeps the directory prefix', () => {
        assert.equal(rescueName('lib/util.py', new Set()), 'lib/util_mine.py');
    });

    test('bumps past names already taken', () => {
        const taken = new Set(['m_mine.py', 'm_mine2.py']);
        assert.equal(rescueName('m.py', taken), 'm_mine3.py');
    });

    test('handles a path with no extension', () => {
        assert.equal(rescueName('notes', new Set()), 'notes_mine');
    });
});

// Shorthand builders. `sha` values here are opaque tokens, not real hashes —
// planPull only ever compares them for equality against `base`.
const L = (path, contents, sha) => ({ path, contents, sha });
const R = (path, contents) => ({ path, contents });
const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f.contents]));

describe('planPull', () => {
    test('untouched file: the repo version wins silently', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'old\n', 'sha-old')],
            repo: [R('a.py', 'new\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'new\n' });
        assert.deepEqual(rescued, []);
    });

    test('untouched file the repo deleted: it goes away', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'old\n', 'sha-old')],
            repo: [],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(files, []);
        assert.deepEqual(rescued, []);
    });

    test('edited file the repo also has: repo keeps the name, local is rescued', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', 'sha-mine')],
            repo: [R('a.py', 'theirs\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'theirs\n', 'a_mine.py': 'mine\n' });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine.py' }]);
    });

    test('edited file the repo deleted: the edit survives under _mine', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', 'sha-mine')],
            repo: [],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a_mine.py': 'mine\n' });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine.py' }]);
    });

    test('edited into agreement with the repo: no duplicate', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'same\n', 'sha-mine')],
            repo: [R('a.py', 'same\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'same\n' });
        assert.deepEqual(rescued, []);
    });

    // The reported data loss: a program created in the editor and never
    // committed used to be deleted by apply-files' delete pass.
    test('never-committed local file survives under its own name', () => {
        const { files, rescued } = planPull({
            local: [L('scratch.py', 'wip\n', 'sha-wip')],
            repo: [R('a.py', 'theirs\n')],
            base: { 'a.py': 'sha-a' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'theirs\n', 'scratch.py': 'wip\n' });
        assert.deepEqual(rescued, []);
    });

    test('locally created name the repo independently also has: contested', () => {
        const { files, rescued } = planPull({
            local: [L('m7.py', 'mine\n', 'sha-mine')],
            repo: [R('m7.py', 'theirs\n')],
            base: {},
        });
        assert.deepEqual(byPath(files), { 'm7.py': 'theirs\n', 'm7_mine.py': 'mine\n' });
        assert.deepEqual(rescued, [{ path: 'm7.py', savedAs: 'm7_mine.py' }]);
    });

    test('protected file with a local edit: overwritten, no rescue copy', () => {
        const { files, rescued } = planPull({
            local: [L('menu_config.py', 'mine\n', 'sha-mine')],
            repo: [R('menu_config.py', 'coach\n')],
            base: { 'menu_config.py': 'sha-old' },
            protectedPaths: ['menu_config.py'],
        });
        assert.deepEqual(byPath(files), { 'menu_config.py': 'coach\n' });
        assert.deepEqual(rescued, []);
    });

    test('rescue name avoids a name the repo is bringing in', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', 'sha-mine')],
            repo: [R('a.py', 'theirs\n'), R('a_mine.py', 'coach copy\n')],
            base: { 'a.py': 'sha-old', 'a_mine.py': 'sha-c' },
        });
        assert.deepEqual(byPath(files), {
            'a.py': 'theirs\n',
            'a_mine.py': 'coach copy\n',
            'a_mine2.py': 'mine\n',
        });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine2.py' }]);
    });

    // First pull after upgrading, or cleared storage: nothing is provably
    // untouched, so anything that actually differs is rescued. Noisy once,
    // never lossy.
    test('missing base: differing files are rescued, matching ones are not', () => {
        const { files, rescued } = planPull({
            local: [L('a.py', 'mine\n', undefined), L('b.py', 'same\n', undefined)],
            repo: [R('a.py', 'theirs\n'), R('b.py', 'same\n')],
            base: {},
        });
        assert.deepEqual(byPath(files), {
            'a.py': 'theirs\n',
            'b.py': 'same\n',
            'a_mine.py': 'mine\n',
        });
        assert.deepEqual(rescued, [{ path: 'a.py', savedAs: 'a_mine.py' }]);
    });

    test('a local file with no metadata sha counts as edited, never lost', () => {
        const { files } = planPull({
            local: [L('a.py', 'mine\n', undefined)],
            repo: [R('a.py', 'theirs\n')],
            base: { 'a.py': 'sha-old' },
        });
        assert.deepEqual(byPath(files), { 'a.py': 'theirs\n', 'a_mine.py': 'mine\n' });
    });
});
