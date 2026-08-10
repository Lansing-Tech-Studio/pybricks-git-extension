// Test harness: loads src/pullmerge.js (a classic content script with no module
// exports) into Node and hands back its functions. Same pattern as
// load-menu-config.mjs: read verbatim, append a publishing line, run in one
// Function scope so the shipped file stays untouched.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'pullmerge.js');

export function loadPullMerge() {
    const src =
        readFileSync(srcPath, 'utf8') +
        '\n;globalThis.__pybricksPullMergeTest = { rescueName, planPull };';
    // eslint-disable-next-line no-new-func
    new Function(src)();
    return globalThis.__pybricksPullMergeTest;
}
