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
