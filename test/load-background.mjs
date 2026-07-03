import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'background.js'),
    'utf8',
);
// importScripts is undefined in Node, so the service-worker wiring block
// (guarded by `typeof importScripts === 'function'`) never runs here.
const load = new Function(
    `${src}\n;globalThis.__background = { makeEngine, makeMessageHandler: typeof makeMessageHandler === 'function' ? makeMessageHandler : undefined, makeAuthFlow: typeof makeAuthFlow === 'function' ? makeAuthFlow : undefined };`,
);
load();
export const { makeEngine, makeMessageHandler, makeAuthFlow } = globalThis.__background;
