import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDiff } from './load-diff.mjs';

const { splitDiffLines, diffLines, toHunks, splitBlocksFile, diffFileSets } = loadDiff();

const types = (ops) => ops.map((o) => o.type).join('');
const texts = (ops) => ops.map((o) => o.text);

describe('splitDiffLines', () => {
    test('splits on newline and remembers a missing final newline', () => {
        assert.deepEqual(splitDiffLines(''), []);
        assert.deepEqual(splitDiffLines('a\nb\n'), [{ text: 'a', noEol: false }, { text: 'b', noEol: false }]);
        assert.deepEqual(splitDiffLines('a\nb'), [{ text: 'a', noEol: false }, { text: 'b', noEol: true }]);
        assert.deepEqual(splitDiffLines('\n'), [{ text: '', noEol: false }]);
    });
});

describe('diffLines', () => {
    test('identical texts are all same with matching line numbers', () => {
        const ops = diffLines('a\nb\nc\n', 'a\nb\nc\n');
        assert.equal(types(ops), 'samesamesame');
        assert.deepEqual(ops.map((o) => [o.aLine, o.bLine]), [[1, 1], [2, 2], [3, 3]]);
    });

    test('a single inserted line', () => {
        const ops = diffLines('a\nc\n', 'a\nb\nc\n');
        assert.equal(types(ops), 'sameaddsame');
        assert.deepEqual(ops[1], { type: 'add', text: 'b', noEol: false, bLine: 2 });
        assert.deepEqual([ops[2].aLine, ops[2].bLine], [2, 3]);
    });

    test('a single deleted line', () => {
        const ops = diffLines('a\nb\nc\n', 'a\nc\n');
        assert.equal(types(ops), 'samedelsame');
        assert.deepEqual(ops[1], { type: 'del', text: 'b', noEol: false, aLine: 2 });
        assert.deepEqual([ops[2].aLine, ops[2].bLine], [3, 2]);
    });

    test('a replaced line is a del then an add', () => {
        const ops = diffLines('a\nb\nc\n', 'a\nB\nc\n');
        assert.equal(types(ops), 'samedeladdsame');
        assert.deepEqual(texts(ops), ['a', 'b', 'B', 'c']);
    });

    test('prefix-only and suffix-only changes', () => {
        assert.equal(types(diffLines('x\na\nb\n', 'a\nb\n')), 'delsamesame');
        assert.equal(types(diffLines('a\nb\n', 'a\nb\nz\n')), 'samesameadd');
    });

    test('empty to content is all adds; content to empty is all dels', () => {
        assert.equal(types(diffLines('', 'a\nb\n')), 'addadd');
        assert.equal(types(diffLines('a\nb\n', '')), 'deldel');
    });

    test('a missing trailing newline counts as a change, as in git', () => {
        const ops = diffLines('a\nb', 'a\nb\n');
        assert.equal(types(ops), 'samedeladd');
        assert.equal(ops[1].noEol, true);
        assert.equal(ops[2].noEol, false);
    });

    test('interleaved edits keep the common lines in order', () => {
        const ops = diffLines('a\nb\nc\nd\ne\n', 'a\nx\nc\ny\ne\nf\n');
        assert.equal(types(ops), 'samedeladdsamedeladdsameadd');
        assert.deepEqual(ops.filter((o) => o.type === 'same').map((o) => o.text), ['a', 'c', 'e']);
    });

    test('the edit cap falls back to a whole replace of the differing middle', () => {
        const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n') + '\n';
        const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n') + '\n';
        const ops = diffLines(`same\n${a}same\n`, `same\n${b}same\n`, { cap: 10 });
        assert.equal(ops[0].type, 'same');
        assert.equal(ops[ops.length - 1].type, 'same');
        const mid = ops.slice(1, -1);
        assert.equal(mid.filter((o) => o.type === 'del').length, 50);
        assert.equal(mid.filter((o) => o.type === 'add').length, 50);
        assert.equal(types(mid), 'del'.repeat(50) + 'add'.repeat(50), 'all dels then all adds');
    });

    test('the cap is not hit by an ordinary edit', () => {
        const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
        const a = lines.join('\n') + '\n';
        const b = [...lines.slice(0, 1500), 'inserted', ...lines.slice(1500)].join('\n') + '\n';
        const ops = diffLines(a, b);
        assert.equal(ops.filter((o) => o.type !== 'same').length, 1);
    });
});

describe('toHunks', () => {
    const file = (n) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n';

    test('no changes → no hunks', () => {
        assert.deepEqual(toHunks(diffLines('a\n', 'a\n')), []);
    });

    test('one change gets three lines of context each side and git-style starts', () => {
        const a = file(20);
        const b = a.replace('l10\n', 'L10\n');
        const hunks = toHunks(diffLines(a, b));
        assert.equal(hunks.length, 1);
        const [h] = hunks;
        assert.deepEqual([h.aStart, h.aCount, h.bStart, h.bCount], [7, 7, 7, 7]);
        assert.deepEqual(texts(h.lines), ['l7', 'l8', 'l9', 'l10', 'L10', 'l11', 'l12', 'l13']);
    });

    test('context is clipped at the file edges', () => {
        const a = file(5);
        const b = a.replace('l1\n', 'L1\n');
        const [h] = toHunks(diffLines(a, b));
        assert.deepEqual([h.aStart, h.bStart], [1, 1]);
        assert.deepEqual(texts(h.lines), ['l1', 'L1', 'l2', 'l3', 'l4']);
    });

    test('two edits two lines apart merge into one hunk; ten apart make two', () => {
        const a = file(30);
        const near = a.replace('l10\n', 'X\n').replace('l13\n', 'Y\n');
        assert.equal(toHunks(diffLines(a, near)).length, 1);
        const far = a.replace('l10\n', 'X\n').replace('l21\n', 'Y\n');
        assert.equal(toHunks(diffLines(a, far)).length, 2);
    });

    test('a pure-add hunk at the end reports the position after the last A line', () => {
        const [h] = toHunks(diffLines('a\nb\n', 'a\nb\nc\n'), 0);
        assert.deepEqual([h.aStart, h.aCount, h.bStart, h.bCount], [2, 0, 3, 1]);
    });

    test('zero context yields only changed lines', () => {
        const a = file(10);
        const b = a.replace('l5\n', 'L5\n');
        const [h] = toHunks(diffLines(a, b), 0);
        assert.deepEqual(texts(h.lines), ['l5', 'L5']);
    });
});

describe('splitBlocksFile', () => {
    test('plain text has no header', () => {
        assert.deepEqual(splitBlocksFile('print(1)\n'), { header: null, body: 'print(1)\n' });
    });
    test('a block program splits at the first newline', () => {
        const c = '# pybricks blocks file:{"a":1}\nfrom pybricks import *\n';
        assert.deepEqual(splitBlocksFile(c), { header: '# pybricks blocks file:{"a":1}', body: 'from pybricks import *\n' });
    });
    test('a header-only block file has an empty body', () => {
        assert.deepEqual(splitBlocksFile('# pybricks blocks file:{}'), { header: '# pybricks blocks file:{}', body: '' });
    });
});

describe('diffFileSets', () => {
    test('classifies added, deleted, modified and unchanged, sorted by path', () => {
        const before = [{ path: 'b.py', contents: 'b\n' }, { path: 'a.py', contents: 'a\n' }, { path: 'd.py', contents: 'd\n' }];
        const after = [{ path: 'a.py', contents: 'a\n' }, { path: 'c.py', contents: 'c\n' }, { path: 'd.py', contents: 'D\n' }];
        const out = diffFileSets(before, after);
        assert.deepEqual(out.map((e) => [e.path, e.status]), [
            ['a.py', 'unchanged'],
            ['b.py', 'deleted'],
            ['c.py', 'added'],
            ['d.py', 'modified'],
        ]);
        const d = out[3];
        assert.deepEqual([d.added, d.deleted], [1, 1]);
        assert.equal(d.hunks.length, 1);
        assert.equal(out[0].hunks.length, 0);
        assert.equal(out[0].ops.length, 0);
        assert.equal(out[1].deleted, 1);
        assert.equal(out[2].added, 1);
    });

    test('block programs diff on the Python body and flag a header change', () => {
        const before = [{ path: 'm.py', contents: '# pybricks blocks file:{"x":1}\nmotor.run(1)\n' }];
        const after = [{ path: 'm.py', contents: '# pybricks blocks file:{"x":2}\nmotor.run(2)\n' }];
        const [e] = diffFileSets(before, after);
        assert.equal(e.status, 'modified');
        assert.equal(e.isBlocks, true);
        assert.equal(e.blocksChanged, true);
        assert.equal(e.layoutOnly, false);
        assert.deepEqual(texts(e.ops), ['motor.run(1)', 'motor.run(2)'], 'the JSON line never appears in the diff');
    });

    test('a header-only change is layoutOnly with no hunks', () => {
        const before = [{ path: 'm.py', contents: '# pybricks blocks file:{"x":1}\nmotor.run(1)\n' }];
        const after = [{ path: 'm.py', contents: '# pybricks blocks file:{"x":2}\nmotor.run(1)\n' }];
        const [e] = diffFileSets(before, after);
        assert.equal(e.status, 'modified');
        assert.equal(e.blocksChanged, true);
        assert.equal(e.layoutOnly, true);
        assert.deepEqual(e.hunks, []);
        assert.deepEqual([e.added, e.deleted], [0, 0]);
    });

    test('a body-only change in a block program is not blocksChanged', () => {
        const before = [{ path: 'm.py', contents: '# pybricks blocks file:{"x":1}\nmotor.run(1)\n' }];
        const after = [{ path: 'm.py', contents: '# pybricks blocks file:{"x":1}\nmotor.run(2)\n' }];
        const [e] = diffFileSets(before, after);
        assert.equal(e.blocksChanged, false);
        assert.equal(e.layoutOnly, false);
    });

    test('an added block program counts its body lines only', () => {
        const [e] = diffFileSets([], [{ path: 'm.py', contents: '# pybricks blocks file:{}\na\nb\n' }]);
        assert.equal(e.status, 'added');
        assert.equal(e.isBlocks, true);
        assert.equal(e.added, 2);
    });

    test('a file converted between text and blocks is a modified blocks entry', () => {
        const [e] = diffFileSets([{ path: 'm.py', contents: 'a\n' }], [{ path: 'm.py', contents: '# pybricks blocks file:{}\na\n' }]);
        assert.equal(e.status, 'modified');
        assert.equal(e.isBlocks, true);
        assert.equal(e.blocksChanged, true);
        assert.equal(e.layoutOnly, true, 'same Python, blocks header appeared');
    });

    test('context option is passed through to the hunks', () => {
        const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n';
        const b = a.replace('l10\n', 'X\n');
        const [e] = diffFileSets([{ path: 'f.py', contents: a }], [{ path: 'f.py', contents: b }], { context: 1 });
        assert.equal(e.hunks[0].lines.length, 4);
    });

    test('tolerates missing inputs', () => {
        assert.deepEqual(diffFileSets(undefined, undefined), []);
        assert.equal(diffFileSets(null, [{ path: 'a.py', contents: 'x\n' }])[0].status, 'added');
    });
});
