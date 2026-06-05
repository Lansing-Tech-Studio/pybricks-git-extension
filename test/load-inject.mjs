// Test harness: loads src/inject.js (a classic MAIN-world content script with
// no module exports) into Node and hands back its internal functions.
//
// inject.js isn't an ES module — it just declares top-level functions and wires
// up a window.postMessage listener. Rather than fork the source for testing, we
// read it verbatim, append a line that publishes the functions we want onto
// globalThis, and run the whole thing inside a single function scope so those
// top-level declarations are in scope for the appended line. This keeps the
// shipped file untouched.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const injectPath = path.join(here, '..', 'src', 'inject.js');

export function loadInject() {
    // inject.js calls window.addEventListener at the top level; stub it.
    if (!globalThis.window) {
        globalThis.window = { addEventListener() {} };
    }
    const src =
        readFileSync(injectPath, 'utf8') +
        '\n;globalThis.__pybricksGitTest = { applyFiles, sha256, listFiles, openPybricksDb };';
    // eslint-disable-next-line no-new-func
    new Function(src)();
    return globalThis.__pybricksGitTest;
}
