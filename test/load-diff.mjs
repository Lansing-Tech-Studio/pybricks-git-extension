// Test harness: loads src/diff.js (a classic content script with no module
// exports) into Node and hands back its functions. Same pattern as
// load-pullmerge.mjs: read verbatim, append a publishing line, run in one
// Function scope so the shipped file stays untouched.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'diff.js');

export function loadDiff() {
    const src =
        readFileSync(srcPath, 'utf8') +
        '\n;globalThis.__pybricksDiffTest = { splitDiffLines, diffLines, toHunks, splitBlocksFile, diffFileSets };';
    // eslint-disable-next-line no-new-func
    new Function(src)();
    return globalThis.__pybricksDiffTest;
}
