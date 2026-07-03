# In-Extension Git Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension performs git itself — fetch/commit/push against a team's GitHub fork over HTTPS — replacing the Go localhost server and the never-built native-messaging host.

**Architecture:** `src/background.js` (MV3 service worker, classic script) becomes a stateless git engine built on vendored isomorphic-git: every commit is constructed directly on the freshly fetched remote head (no local clone or working tree), with a last-Pull snapshot guarding deletions and a bounded retry absorbing push races. `content.js` swaps its localhost fetches for `chrome.runtime.sendMessage` with the same op/response shapes. A browser-action popup holds per-device settings (fork URL, branch, PAT, team name).

**Tech Stack:** Plain JS (no build step), isomorphic-git + lightning-fs vendored as UMD files, Node's `node:test` + real `git http-backend` for hermetic integration tests.

**Spec:** `docs/superpowers/specs/2026-07-02-in-extension-git-design.md` — read it first.

## Global Constraints

- **No build step.** The extension loads unpacked from the repo root. Vendored libs are checked-in UMD files under `vendor/`; `package.json` is dev-tooling only.
- **Plain classic scripts.** Never add ESM `export` statements to `src/inject.js`, `src/content.js`, or `src/background.js` — tests load them unmodified via loader shims (see `test/load-inject.mjs` for the pattern).
- **Block files are opaque text.** The line-1 `# pybricks blocks file:{...}` comment must round-trip byte-for-byte. Never parse or regenerate it.
- **`src/inject.js` is untouched** by this plan. The `window.postMessage` REQ/RES envelope protocol between content.js and inject.js is unchanged.
- **Tests are hermetic** but require the real `git` binary (≥2.28 for `init -b`) on PATH. Test repos live in `fs.mkdtempSync` dirs. No `.only`, no network beyond `127.0.0.1`.
- **Message-op response shapes** (the contract between background.js and content.js):
  - `{op:'status'}` → `{ok:true, configured:boolean, branch:string, head:null}`
  - `{op:'commit', files:[{path,contents}], message:string}` → `{committed:boolean, head:string, message:string, pushed:boolean, preserved:string[]}`
  - `{op:'pull'}` → `{head:string, files:[{path,contents}], pullWarning:string}`
  - any failure → `{error: string}`
- **Storage keys** in `chrome.storage.local`: `settings` = `{repoUrl, branch, token, name, email}`; `lastPullPaths` = `string[]`.
- Work happens on the existing branch `feat/in-extension-git`. Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Vendor isomorphic-git and lightning-fs; add test dependency

**Files:**
- Create: `vendor/isomorphic-git.umd.js`, `vendor/isomorphic-git-http-web.umd.js`, `vendor/lightning-fs.umd.js`, `vendor/README.md`
- Modify: `package.json` (add devDependency)

**Interfaces:**
- Produces: UMD globals `git`, `GitHttp`, `LightningFS` for `importScripts` in Task 6; npm package `isomorphic-git` importable in tests (Tasks 3–5).

- [ ] **Step 1: Download pinned UMD builds**

```bash
cd /home/brendon/code/github/lansingtechstudio/pybricks-git-extension
mkdir -p vendor
curl -fsSL https://unpkg.com/isomorphic-git@1.27.1/index.umd.min.js -o vendor/isomorphic-git.umd.js
curl -fsSL https://unpkg.com/isomorphic-git@1.27.1/http/web/index.umd.js -o vendor/isomorphic-git-http-web.umd.js
curl -fsSL https://unpkg.com/@isomorphic-git/lightning-fs@4.6.0/dist/lightning-fs.min.js -o vendor/lightning-fs.umd.js
```

If any URL 404s, list the package with `curl -s https://unpkg.com/browse/isomorphic-git@1.27.1/` (or the lightning-fs equivalent) to find the actual UMD filename, download that instead, and record the real path in `vendor/README.md`.

- [ ] **Step 2: Verify the UMD global names**

```bash
head -c 400 vendor/isomorphic-git.umd.js | grep -o 'GitHttp\|git\s*=\|\.git=\|exports' | head -3
tail -c 400 vendor/isomorphic-git-http-web.umd.js
head -c 400 vendor/lightning-fs.umd.js
```

Confirm the globals the wiring in Task 6 expects: `git` (isomorphic-git), `GitHttp` (http client), `LightningFS`. If a file exposes a different global name (e.g. `LightningFs`), note the actual name in `vendor/README.md`; Task 6 reads that file before writing the `importScripts` wiring.

- [ ] **Step 3: Write `vendor/README.md`**

```markdown
# Vendored libraries

Checked in so the extension loads unpacked with no build step. Loaded by
`src/background.js` via `importScripts` (classic service worker).

| File | Package | Version | Global | Source URL |
|---|---|---|---|---|
| isomorphic-git.umd.js | isomorphic-git | 1.27.1 | `git` | https://unpkg.com/isomorphic-git@1.27.1/index.umd.min.js |
| isomorphic-git-http-web.umd.js | isomorphic-git (http/web) | 1.27.1 | `GitHttp` | https://unpkg.com/isomorphic-git@1.27.1/http/web/index.umd.js |
| lightning-fs.umd.js | @isomorphic-git/lightning-fs | 4.6.0 | `LightningFS` | https://unpkg.com/@isomorphic-git/lightning-fs@4.6.0/dist/lightning-fs.min.js |

All MIT-licensed. Update by re-downloading a pinned version and editing this table.
```

Correct the version/global cells if Step 1/2 found different values.

- [ ] **Step 4: Add isomorphic-git as a dev dependency (tests import it natively in Node)**

```bash
npm install --save-dev isomorphic-git@1.27.1
npm test
```

Expected: existing 7 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add vendor package.json package-lock.json
git commit -m "chore: vendor isomorphic-git + lightning-fs UMD builds, add test dep"
```

---

### Task 2: Hermetic smart-HTTP git server for tests

**Files:**
- Create: `test/git-http-server.mjs` (harness — NOT matched by the `test/*.test.mjs` glob)
- Test: `test/git-http-server.test.mjs`

**Interfaces:**
- Produces (used by Tasks 3–5 and the E2E task):
  - `startGitServer(projectRoot: string) → Promise<{url: string, close: () => Promise<void>}>` — serves every bare repo under `projectRoot` at `<url>/<name>.git`
  - `makeBareRepo(root: string, name: string, files?: Record<string,string>) → string` — creates `<root>/<name>.git` (push-enabled, branch `main`), optionally seeded with `files` via a throwaway clone; returns the bare repo path
  - `bareHead(bare: string) → string` — full sha of `main` (empty string if no commits)
  - `bareFile(bare: string, path: string) → string` — file contents at `main`
  - `bareSubjects(bare: string) → string[]` — commit subjects, newest first
  - `pushCompeting(bare: string, files: Record<string,string>, message: string) → void` — clone, write files, commit, push (simulates another device)

- [ ] **Step 1: Write the failing self-test**

`test/git-http-server.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startGitServer, makeBareRepo, bareHead, bareFile } from './git-http-server.mjs';

function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

test('real git can clone from and push to the harness over HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pbgit-'));
    makeBareRepo(root, 'team', { 'main.py': 'print(1)\n' });
    const server = await startGitServer(root);
    try {
        const work = join(root, 'work');
        execFileSync('git', ['clone', '-q', `${server.url}/team.git`, work]);
        assert.equal(git(work, 'show', 'HEAD:main.py'), 'print(1)');

        git(work, 'config', 'user.email', 't@e.com');
        git(work, 'config', 'user.name', 'T');
        execFileSync('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'via http']);
        git(work, 'push', '-q', 'origin', 'main');
        assert.equal(bareHead(join(root, 'team.git')), git(work, 'rev-parse', 'HEAD'));
        assert.equal(bareFile(join(root, 'team.git'), 'main.py'), 'print(1)\n');
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './git-http-server.mjs'`

- [ ] **Step 3: Implement the harness**

`test/git-http-server.mjs`:

```js
// Serves bare git repos over smart HTTP by fronting `git http-backend` (CGI)
// with a Node http server. Hermetic: binds 127.0.0.1:0, needs only `git`.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

export function startGitServer(projectRoot) {
    const server = createServer((req, res) => {
        const [path, query = ''] = req.url.split('?');
        const cgi = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: decodeURIComponent(path),
                QUERY_STRING: query,
                REQUEST_METHOD: req.method,
                CONTENT_TYPE: req.headers['content-type'] ?? '',
                CONTENT_LENGTH: req.headers['content-length'] ?? '',
            },
        });
        req.pipe(cgi.stdin);
        let buf = Buffer.alloc(0);
        let headerDone = false;
        cgi.stdout.on('data', (chunk) => {
            if (headerDone) return void res.write(chunk);
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) return;
            for (const line of buf.subarray(0, idx).toString().split('\r\n')) {
                const sep = line.indexOf(': ');
                const key = line.slice(0, sep);
                const value = line.slice(sep + 2);
                if (key.toLowerCase() === 'status') res.statusCode = parseInt(value, 10);
                else res.setHeader(key, value);
            }
            headerDone = true;
            res.write(buf.subarray(idx + 4));
        });
        cgi.on('close', () => res.end());
        cgi.stderr.on('data', (d) => process.stderr.write(`[git-http] ${d}`));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

export function makeBareRepo(root, name, files = {}) {
    const bare = join(root, `${name}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(bare, 'config', 'http.receivepack', 'true');
    if (Object.keys(files).length) pushCompeting(bare, files, 'seed');
    return bare;
}

export function pushCompeting(bare, files, message) {
    const work = mkdtempSync(join(tmpdir(), 'pbgit-work-'));
    execFileSync('git', ['clone', '-q', bare, join(work, 'w')]);
    const w = join(work, 'w');
    git(w, 'config', 'user.email', 'seed@example.com');
    git(w, 'config', 'user.name', 'Seed');
    git(w, 'config', 'commit.gpgsign', 'false');
    git(w, 'checkout', '-q', '-B', 'main');
    for (const [rel, contents] of Object.entries(files)) {
        const full = join(w, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
    }
    git(w, 'add', '-A');
    git(w, 'commit', '-q', '-m', message);
    git(w, 'push', '-q', 'origin', 'main');
}

export function bareHead(bare) {
    try {
        return git(bare, 'rev-parse', 'main');
    } catch {
        return '';
    }
}

export function bareFile(bare, path) {
    return execFileSync('git', ['-C', bare, 'show', `main:${path}`], { encoding: 'utf8' });
}

export function bareSubjects(bare) {
    return git(bare, 'log', '--format=%s', 'main').split('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: all tests PASS (7 existing + 1 new).

- [ ] **Step 5: Commit**

```bash
git add test/git-http-server.mjs test/git-http-server.test.mjs
git commit -m "test: hermetic smart-HTTP git server harness (git http-backend CGI)"
```

---

### Task 3: Engine skeleton — settings, status, pull

**Files:**
- Create: `src/background.js` (replaces the stub), `test/load-background.mjs`, `test/engine-helpers.mjs`
- Test: `test/background-pull.test.mjs`

**Interfaces:**
- Consumes: harness exports from Task 2.
- Produces:
  - In `src/background.js` (plain top-level functions, classic script):
    - `makeEngine(deps) → {status(), pull(), commit(msg)}` where `deps = {git, http, fs, gitdir, storage, now?}`; `storage` is `{get(key)→Promise<value>, set(obj)→Promise<void>}`
    - internal helpers later tasks reuse: `getSettings(d)`, `fetchRemoteHead(d, s)`, `listAllFiles(d, commitOid) → Map<path,{oid,mode}>`
  - `test/load-background.mjs` exports `{ makeEngine, makeMessageHandler }` (makeMessageHandler arrives in Task 6; export both from the start — see loader code)
  - `test/engine-helpers.mjs` exports `setupEngine(files?) → Promise<{engine, storage, bare, server, gitdir}>`

- [ ] **Step 1: Write the loader and helpers**

`test/load-background.mjs` (same pattern as `test/load-inject.mjs` — loads the file unmodified):

```js
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
    `${src}\n;globalThis.__background = { makeEngine, makeMessageHandler: typeof makeMessageHandler === 'function' ? makeMessageHandler : undefined };`,
);
load();
export const { makeEngine, makeMessageHandler } = globalThis.__background;
```

`test/engine-helpers.mjs`:

```js
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine } from './load-background.mjs';
import { startGitServer, makeBareRepo } from './git-http-server.mjs';

export function memStorage() {
    const m = new Map();
    return {
        get: async (key) => m.get(key),
        set: async (obj) => {
            for (const [k, v] of Object.entries(obj)) m.set(k, v);
        },
    };
}

// Spins up a served bare repo (optionally seeded) plus an engine pointed at it.
export async function setupEngine(files = {}) {
    const root = mkdtempSync(join(tmpdir(), 'pbgit-engine-'));
    const bare = makeBareRepo(root, 'team', files);
    const server = await startGitServer(root);
    const storage = memStorage();
    await storage.set({
        settings: {
            repoUrl: `${server.url}/team.git`,
            branch: 'main',
            token: 'test-token',
            name: 'Test Team',
            email: 'team@example.com',
        },
    });
    const gitdir = join(root, 'cache.git');
    const engine = makeEngine({ git, http, fs, gitdir, storage });
    return { engine, storage, bare, server, gitdir };
}
```

- [ ] **Step 2: Write the failing tests**

`test/background-pull.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine } from './engine-helpers.mjs';

const BLOCK = '# pybricks blocks file:{"a":1,"b":[2,3]}\nfrom pybricks import *\n';

test('status reports configured with branch when settings exist', async () => {
    const { engine, server } = await setupEngine();
    try {
        assert.deepEqual(await engine.status(), {
            ok: true,
            configured: true,
            branch: 'main',
            head: null,
        });
    } finally {
        await server.close();
    }
});

test('status reports unconfigured when settings are missing', async () => {
    const { engine, storage, server } = await setupEngine();
    try {
        await storage.set({ settings: {} });
        const s = await engine.status();
        assert.equal(s.configured, false);
    } finally {
        await server.close();
    }
});

test('pull returns .py files (block files byte-exact), skips non-.py, records snapshot', async () => {
    const { engine, storage, server } = await setupEngine({
        'prog.py': BLOCK,
        'lib/util.py': 'def f(): pass\n',
        'README.md': '# not python\n',
    });
    try {
        const result = await engine.pull();
        assert.equal(result.pullWarning, '');
        assert.equal(result.head.length, 7);
        const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.contents]));
        assert.deepEqual(Object.keys(byPath).sort(), ['lib/util.py', 'prog.py']);
        assert.equal(byPath['prog.py'], BLOCK);
        assert.deepEqual((await storage.get('lastPullPaths')).sort(), ['lib/util.py', 'prog.py']);
    } finally {
        await server.close();
    }
});

test('pull from an empty repo warns but succeeds with no files', async () => {
    const { engine, server } = await setupEngine();
    try {
        const result = await engine.pull();
        assert.equal(result.files.length, 0);
        assert.notEqual(result.pullWarning, '');
    } finally {
        await server.close();
    }
});

test('pull without configuration throws a message pointing at the popup', async () => {
    const { engine, storage, server } = await setupEngine();
    try {
        await storage.set({ settings: {} });
        await assert.rejects(engine.pull(), /not configured/i);
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `makeEngine` is not defined (background.js is still the stub).

- [ ] **Step 4: Write `src/background.js` with status + pull**

Replace the whole file:

```js
// MV3 service worker: the git engine. Stateless — every operation starts by
// fetching the remote head; no local clone or working tree is kept. A bare
// gitdir in lightning-fs only caches fetched objects and can be wiped freely.
//
// Loaded two ways:
//  - In Chrome: classic worker; the wiring block at the bottom (guarded by
//    `typeof importScripts`) pulls in vendored UMDs and registers listeners.
//  - In Node tests: test/load-background.mjs evaluates this file unmodified
//    and calls makeEngine with Node's fs/http and a temp gitdir.

function makeEngine(deps) {
    const d = { now: () => Date.now(), ...deps };
    return {
        status: () => statusOp(d),
        pull: () => pullOp(d),
        commit: (msg) => commitOp(d, msg ?? {}),
    };
}

async function getSettings(d) {
    const s = (await d.storage.get('settings')) ?? {};
    return {
        repoUrl: s.repoUrl ?? '',
        branch: s.branch || 'main',
        token: s.token ?? '',
        name: s.name ?? '',
        email: s.email ?? '',
    };
}

function isConfigured(s) {
    return Boolean(s.repoUrl && s.token);
}

function requireConfigured(s) {
    if (!isConfigured(s)) {
        throw new Error('not configured — click the Pybricks Git extension icon to set fork URL and token');
    }
}

function onAuth(s) {
    return () => ({ username: 'x-access-token', password: s.token });
}

async function statusOp(d) {
    const s = await getSettings(d);
    return { ok: true, configured: isConfigured(s), branch: s.branch, head: null };
}

// Fetches the remote branch tip into the cache gitdir. Returns its oid, or
// null when the remote exists but has no commits yet (fresh fork edge case).
async function fetchRemoteHead(d, s) {
    await d.git.init({ fs: d.fs, gitdir: d.gitdir, bare: true });
    try {
        const res = await d.git.fetch({
            fs: d.fs,
            http: d.http,
            gitdir: d.gitdir,
            url: s.repoUrl,
            ref: s.branch,
            singleBranch: true,
            depth: 1,
            tags: false,
            onAuth: onAuth(s),
        });
        return res.fetchHead ?? null;
    } catch (err) {
        const text = `${err && err.code} ${err && err.message}`;
        if (/NotFoundError|NoRefSpecError|EmptyServerResponse|Could not find|no refs/i.test(text)) {
            return null;
        }
        throw err;
    }
}

// Full recursive listing of a commit's tree: path -> {oid, mode}.
async function listAllFiles(d, commitOid) {
    const out = new Map();
    async function walk(oid, prefix) {
        const { tree } = await d.git.readTree({ fs: d.fs, gitdir: d.gitdir, oid });
        for (const entry of tree) {
            const path = prefix ? `${prefix}/${entry.path}` : entry.path;
            if (entry.type === 'tree') await walk(entry.oid, path);
            else out.set(path, { oid: entry.oid, mode: entry.mode });
        }
    }
    if (commitOid) await walk(commitOid, ''); // readTree peels a commit to its tree
    return out;
}

async function pullOp(d) {
    const s = await getSettings(d);
    requireConfigured(s);
    const head = await fetchRemoteHead(d, s);
    const files = [];
    if (head) {
        const all = await listAllFiles(d, head);
        for (const [path, entry] of all) {
            if (!path.endsWith('.py')) continue;
            const { blob } = await d.git.readBlob({ fs: d.fs, gitdir: d.gitdir, oid: entry.oid });
            files.push({ path, contents: new TextDecoder().decode(blob) });
        }
    }
    await d.storage.set({ lastPullPaths: files.map((f) => f.path) });
    return {
        head: head ? head.slice(0, 7) : '',
        files,
        pullWarning: head ? '' : 'remote repository has no commits yet',
    };
}

async function commitOp(d, msg) {
    throw new Error('commit not implemented yet');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS. If the empty-repo test fails because isomorphic-git surfaces a different error for an empty remote, print the actual `err.code`/`err.message` in the test failure, extend the regex in `fetchRemoteHead` to match it exactly, and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/background.js test/load-background.mjs test/engine-helpers.mjs test/background-pull.test.mjs
git commit -m "feat(engine): stateless status + pull against a fetched remote head"
```

---

### Task 4: Engine — commit and push

**Files:**
- Modify: `src/background.js` (replace the `commitOp` stub; add tree-building helpers)
- Test: `test/background-commit.test.mjs`

**Interfaces:**
- Consumes: `setupEngine`, `bareHead`, `bareFile`, `bareSubjects` (Tasks 2–3).
- Produces: working `engine.commit({files, message})` returning `{committed, head, message, pushed, preserved}`; helpers `writeTreeFromMap(d, map)` reused by Task 5's tests indirectly.

- [ ] **Step 1: Write the failing tests**

`test/background-commit.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEngine } from './engine-helpers.mjs';
import { bareHead, bareFile, bareSubjects } from './git-http-server.mjs';

const BLOCK = '# pybricks blocks file:{"a":1,"b":[2,3]}\nfrom pybricks import *\n';

test('first commit to an empty fork creates the branch and pushes', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const result = await engine.commit({
            files: [{ path: 'main.py', contents: 'print(1)\n' }],
            message: 'first commit',
        });
        assert.equal(result.committed, true);
        assert.equal(result.pushed, true);
        assert.equal(result.message, 'first commit');
        assert.equal(bareHead(bare).slice(0, 7), result.head);
        assert.equal(bareFile(bare, 'main.py'), 'print(1)\n');
        assert.deepEqual(bareSubjects(bare), ['first commit']);
    } finally {
        await server.close();
    }
});

test('empty message gets the timestamped default', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const result = await engine.commit({
            files: [{ path: 'main.py', contents: 'x=1\n' }],
            message: '',
        });
        assert.match(result.message, /^Update from Pybricks at /);
        assert.match(bareSubjects(bare)[0], /^Update from Pybricks at /);
    } finally {
        await server.close();
    }
});

test('identical second commit is a no-op that does not push', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const files = [{ path: 'main.py', contents: 'x=1\n' }];
        await engine.commit({ files, message: 'one' });
        const before = bareHead(bare);
        const result = await engine.commit({ files, message: 'two' });
        assert.equal(result.committed, false);
        assert.equal(result.message, 'no changes');
        assert.equal(bareHead(bare), before);
    } finally {
        await server.close();
    }
});

test('nested paths and block files round-trip byte-for-byte through commit', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        await engine.commit({
            files: [
                { path: 'prog.py', contents: BLOCK },
                { path: 'nested/deep/mod.py', contents: 'y = 2\n' },
            ],
            message: 'nested',
        });
        assert.equal(bareFile(bare, 'prog.py'), BLOCK);
        assert.equal(bareFile(bare, 'nested/deep/mod.py'), 'y = 2\n');
    } finally {
        await server.close();
    }
});

test('non-.py files in the fork are never touched by commit', async () => {
    const { engine, bare, server } = await setupEngine({
        'README.md': '# shared docs\n',
        'main.py': 'print(1)\n',
    });
    try {
        await engine.pull(); // snapshot main.py so its deletion is allowed
        await engine.commit({
            files: [{ path: 'other.py', contents: 'z=1\n' }],
            message: 'replace',
        });
        assert.equal(bareFile(bare, 'README.md'), '# shared docs\n');
        assert.equal(bareFile(bare, 'other.py'), 'z=1\n');
        assert.throws(() => bareFile(bare, 'main.py')); // deleted: pulled, then absent
    } finally {
        await server.close();
    }
});

test('commit of zero files against an empty repo is a no-op', async () => {
    const { engine, bare, server } = await setupEngine();
    try {
        const result = await engine.commit({ files: [], message: '' });
        assert.equal(result.committed, false);
        assert.equal(bareHead(bare), '');
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the new tests FAIL with "commit not implemented yet"; Task 3 tests still pass.

- [ ] **Step 3: Implement commit**

In `src/background.js`, replace the `commitOp` stub and add the helpers below it:

```js
// Git sorts tree entries as if directory names had a trailing slash.
function treeSortKey(entry) {
    return entry.type === 'tree' ? `${entry.path}/` : entry.path;
}

// Writes a full git tree (bottom-up) from a flat Map of path -> {oid, mode}.
async function writeTreeFromMap(d, fileMap) {
    const root = {};
    for (const [path, entry] of fileMap) {
        const parts = path.split('/');
        let node = root;
        for (const part of parts.slice(0, -1)) node = node[part] ??= {};
        node[parts[parts.length - 1]] = entry;
    }
    async function writeDir(node) {
        const entries = [];
        for (const [name, child] of Object.entries(node)) {
            if (child.oid) {
                entries.push({ mode: child.mode, path: name, oid: child.oid, type: 'blob' });
            } else {
                entries.push({ mode: '040000', path: name, oid: await writeDir(child), type: 'tree' });
            }
        }
        entries.sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
        return d.git.writeTree({ fs: d.fs, gitdir: d.gitdir, tree: entries });
    }
    return writeDir(root);
}

async function commitOp(d, msg) {
    const files = msg.files ?? [];
    const s = await getSettings(d);
    requireConfigured(s);
    const snapshot = new Set((await d.storage.get('lastPullPaths')) ?? []);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        const head = await fetchRemoteHead(d, s);
        if (!head && files.length === 0) {
            return { committed: false, head: '', message: 'no changes', pushed: false, preserved: [] };
        }
        const existing = await listAllFiles(d, head);
        const next = new Map(existing);
        const preserved = [];
        for (const path of existing.keys()) {
            if (!path.endsWith('.py')) continue;
            if (files.some((f) => f.path === path)) continue;
            // Delete only what a previous Pull showed the editor; never-pulled
            // files (fresh fork starter code) are preserved.
            if (snapshot.has(path)) next.delete(path);
            else preserved.push(path);
        }
        for (const f of files) {
            const oid = await d.git.writeBlob({
                fs: d.fs,
                gitdir: d.gitdir,
                blob: new TextEncoder().encode(f.contents),
            });
            next.set(f.path, { oid, mode: '100644' });
        }
        const newTree = await writeTreeFromMap(d, next);
        const oldTree = head
            ? (await d.git.readCommit({ fs: d.fs, gitdir: d.gitdir, oid: head })).commit.tree
            : null;
        if (newTree === oldTree) {
            return { committed: false, head: head.slice(0, 7), message: 'no changes', pushed: false, preserved };
        }
        const message = (msg.message ?? '').trim() || `Update from Pybricks at ${new Date(d.now()).toISOString()}`;
        const author = {
            name: s.name || 'Pybricks Team',
            email: s.email || 'team@users.noreply.github.com',
            timestamp: Math.floor(d.now() / 1000),
            timezoneOffset: 0,
        };
        const commitOid = await d.git.writeCommit({
            fs: d.fs,
            gitdir: d.gitdir,
            commit: { message, tree: newTree, parent: head ? [head] : [], author, committer: author },
        });
        await d.git.writeRef({
            fs: d.fs,
            gitdir: d.gitdir,
            ref: `refs/heads/${s.branch}`,
            value: commitOid,
            force: true,
        });
        try {
            await d.git.push({
                fs: d.fs,
                http: d.http,
                gitdir: d.gitdir,
                url: s.repoUrl,
                ref: s.branch,
                remoteRef: `refs/heads/${s.branch}`,
                onAuth: onAuth(s),
            });
            return { committed: true, head: commitOid.slice(0, 7), message, pushed: true, preserved };
        } catch (err) {
            if (err && err.code === 'PushRejectedError') {
                lastErr = err; // someone else pushed between our fetch and push — rebuild on the new head
                continue;
            }
            throw err;
        }
    }
    throw new Error(`push kept being rejected after 3 attempts: ${lastErr.message}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS. Known adjustment point: if `git.push` reports rejection via a result object (`result.ok === false`) instead of throwing on your isomorphic-git version, wrap it — after the push call add `if (pushResult && pushResult.ok === false) { lastErr = new Error(JSON.stringify(pushResult)); continue; }` and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/background.js test/background-commit.test.mjs
git commit -m "feat(engine): stateless commit built on the fetched head, pushed to the fork"
```

---

### Task 5: Engine — first-commit guard and race retry

**Files:**
- Test: `test/background-guard.test.mjs` (implementation already exists from Task 4 — these tests pin the two safety behaviors; expect them to pass, and treat any failure as a Task 4 bug to fix)

**Interfaces:**
- Consumes: `setupEngine`, `pushCompeting`, `bareFile`, `bareSubjects` (Tasks 2–3), `engine.commit`/`engine.pull` (Tasks 3–4).

- [ ] **Step 1: Write the tests**

`test/background-guard.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'node:fs';
import { setupEngine } from './engine-helpers.mjs';
import { makeEngine } from './load-background.mjs';
import { pushCompeting, bareFile, bareSubjects } from './git-http-server.mjs';

test('commit before any pull preserves never-pulled starter code', async () => {
    const { engine, bare, server } = await setupEngine({
        'starter.py': 'shared = True\n',
        'lib/shared.py': 'lib = 1\n',
    });
    try {
        // Fresh device: no pull has happened, editor has only the team's file.
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'ours = 1\n' }],
            message: 'first day',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.preserved.sort(), ['lib/shared.py', 'starter.py']);
        assert.equal(bareFile(bare, 'starter.py'), 'shared = True\n');
        assert.equal(bareFile(bare, 'lib/shared.py'), 'lib = 1\n');
        assert.equal(bareFile(bare, 'team.py'), 'ours = 1\n');
    } finally {
        await server.close();
    }
});

test('after a pull, files removed from the editor are deleted by commit', async () => {
    const { engine, bare, server } = await setupEngine({ 'starter.py': 'shared = True\n' });
    try {
        await engine.pull();
        const result = await engine.commit({
            files: [{ path: 'team.py', contents: 'ours = 1\n' }],
            message: 'deleted starter',
        });
        assert.equal(result.committed, true);
        assert.deepEqual(result.preserved, []);
        assert.throws(() => bareFile(bare, 'starter.py'));
    } finally {
        await server.close();
    }
});

test('a competing push between fetch and push is absorbed by the retry', async () => {
    const { engine, storage, bare, server, gitdir } = await setupEngine({
        'main.py': 'x = 1\n',
    });
    try {
        // Wrap git so the FIRST push is preceded by a competing push landing
        // after our fetch — guaranteeing a PushRejected on attempt 1.
        let interfered = false;
        const rigged = {
            ...git,
            push: async (args) => {
                if (!interfered) {
                    interfered = true;
                    pushCompeting(bare, { 'competitor.py': 'c = 1\n' }, 'competing change');
                }
                return git.push(args);
            },
        };
        const racedEngine = makeEngine({ git: rigged, http, fs, gitdir, storage });
        const result = await racedEngine.commit({
            files: [{ path: 'main.py', contents: 'x = 2\n' }],
            message: 'raced commit',
        });
        assert.equal(result.committed, true);
        assert.equal(result.pushed, true);
        // Both changes survive: ours and the competitor's.
        assert.equal(bareFile(bare, 'main.py'), 'x = 2\n');
        assert.equal(bareFile(bare, 'competitor.py'), 'c = 1\n');
        assert.deepEqual(bareSubjects(bare)[0], 'raced commit');
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test`
Expected: all PASS. If the race test fails because the competing push was NOT rejected (isomorphic-git may force-update since we `writeRef --force` locally), verify the push call is non-force (no `force: true` in `commitOp`'s push) and that the harness bare repo has `receive.denyNonFastForwards` default behavior; fix `commitOp` until the retry path demonstrably executes — add a temporary `console.log` in the catch to confirm attempt 2 runs, then remove it.

- [ ] **Step 3: Commit**

```bash
git add test/background-guard.test.mjs
git commit -m "test(engine): pin first-commit guard and push-race retry behavior"
```

---

### Task 6: Service-worker wiring and manifest

**Files:**
- Modify: `src/background.js` (append `makeMessageHandler` + wiring block), `manifest.json`
- Test: `test/background-wiring.test.mjs`

**Interfaces:**
- Consumes: `makeEngine` (Task 3), vendored globals (Task 1 — check `vendor/README.md` for the actual global names before writing the wiring).
- Produces: `makeMessageHandler(engine) → (msg, sender, sendResponse) => boolean` — the chrome.runtime.onMessage listener; the final `manifest.json` used by all later tasks.

- [ ] **Step 1: Write the failing test**

`test/background-wiring.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMessageHandler } from './load-background.mjs';

function call(handler, msg) {
    return new Promise((resolve) => {
        const keepAlive = handler(msg, {}, resolve);
        assert.equal(keepAlive, true, 'handler must return true to keep the message channel open');
    });
}

const fakeEngine = {
    status: async () => ({ ok: true, configured: true, branch: 'main', head: null }),
    pull: async () => ({ head: 'abc1234', files: [], pullWarning: '' }),
    commit: async (msg) => ({ committed: true, head: 'abc1234', message: msg.message, pushed: true, preserved: [] }),
};

test('routes status, pull, and commit ops to the engine', async () => {
    const handler = makeMessageHandler(fakeEngine);
    assert.equal((await call(handler, { op: 'status' })).configured, true);
    assert.equal((await call(handler, { op: 'pull' })).head, 'abc1234');
    assert.equal((await call(handler, { op: 'commit', files: [], message: 'm' })).message, 'm');
});

test('engine failures come back as {error} instead of hanging', async () => {
    const handler = makeMessageHandler({
        ...fakeEngine,
        pull: async () => {
            throw new Error('boom');
        },
    });
    assert.deepEqual(await call(handler, { op: 'pull' }), { error: 'boom' });
});

test('unknown ops come back as {error} synchronously', () => {
    const handler = makeMessageHandler(fakeEngine);
    let got;
    const keepAlive = handler({ op: 'nope' }, {}, (res) => (got = res));
    assert.equal(keepAlive, false);
    assert.match(got.error, /unknown op/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test`
Expected: FAIL — `makeMessageHandler` is undefined.

- [ ] **Step 3: Append handler + wiring to `src/background.js`**

```js
function makeMessageHandler(engine) {
    return (msg, _sender, sendResponse) => {
        const ops = {
            status: () => engine.status(),
            pull: () => engine.pull(),
            commit: () => engine.commit({ files: msg.files, message: msg.message }),
        };
        const run = ops[msg && msg.op];
        if (!run) {
            sendResponse({ error: `unknown op: ${msg && msg.op}` });
            return false;
        }
        run().then(sendResponse, (err) => sendResponse({ error: err.message }));
        return true; // async sendResponse — keep the channel open
    };
}

// --- Service-worker wiring (skipped when loaded by Node tests) ---
if (typeof importScripts === 'function') {
    importScripts(
        '../vendor/isomorphic-git.umd.js',
        '../vendor/isomorphic-git-http-web.umd.js',
        '../vendor/lightning-fs.umd.js',
    );
    const storage = {
        get: (key) => chrome.storage.local.get(key).then((o) => o[key]),
        set: (obj) => chrome.storage.local.set(obj),
    };
    const engine = makeEngine({
        git: self.git,
        http: self.GitHttp,
        fs: new self.LightningFS('pybricks-git'),
        gitdir: '/pybricks.git',
        storage,
    });
    chrome.runtime.onMessage.addListener(makeMessageHandler(engine));
}
```

Before committing, open `vendor/README.md`: if the recorded globals differ from `git`/`GitHttp`/`LightningFS`, use the recorded names in the block above.

- [ ] **Step 4: Rewrite `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Pybricks Git",
  "version": "0.1.0",
  "description": "Version control for code.pybricks.com — commits straight to your team's GitHub fork",
  "permissions": ["storage"],
  "host_permissions": [
    "https://code.pybricks.com/*",
    "https://github.com/*",
    "https://api.github.com/*",
    "http://127.0.0.1/*"
  ],
  "background": {
    "service_worker": "src/background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://code.pybricks.com/*"],
      "js": ["src/content.js"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    },
    {
      "matches": ["https://code.pybricks.com/*"],
      "js": ["src/inject.js"],
      "run_at": "document_idle",
      "world": "MAIN"
    }
  ],
  "action": {
    "default_title": "Pybricks Git settings",
    "default_popup": "src/popup.html"
  }
}
```

Notes: `"type": "module"` is dropped (classic worker for `importScripts`); `scripting` permission dropped (content scripts are declarative); localhost is gone from user paths, but `http://127.0.0.1/*` stays for E2E testing against the local git harness (Task 10).

- [ ] **Step 5: Run tests and JSON-lint the manifest**

```bash
npm test
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

Expected: all tests PASS; `manifest ok`.

- [ ] **Step 6: Commit**

```bash
git add src/background.js manifest.json test/background-wiring.test.mjs
git commit -m "feat: wire git engine into the service worker; manifest for GitHub + popup"
```

---

### Task 7: content.js — swap localhost fetches for runtime messages

**Files:**
- Modify: `src/content.js`

**Interfaces:**
- Consumes: message ops + response shapes (Global Constraints), served by Task 6's handler.
- Produces: user-visible behavior — button labels unchanged from today (`✓ <head> ↑`, `no changes`, `↓ +N ~N -N`), plus a new `setup needed` label when unconfigured.

- [ ] **Step 1: Replace the transport**

In `src/content.js`:

1. Delete the line `const SERVER = 'http://localhost:8127';`
2. Delete the whole `fetchJSON` function.
3. Add in its place:

```js
function serverRequest(op, payload = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ op, ...payload }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!res) return reject(new Error('no response from the extension service worker'));
            if (res.error) return reject(new Error(res.error));
            resolve(res);
        });
    });
}

// Shows 'setup needed' on the button when settings are missing; returns false
// so the caller can bail out of the operation.
async function ensureConfigured(btn, original) {
    const status = await serverRequest('status');
    if (status.configured) return true;
    console.warn('[pybricks-git] not configured — click the extension icon to set fork URL and token');
    btn.textContent = 'setup needed';
    setTimeout(() => (btn.textContent = original), 3000);
    return false;
}
```

- [ ] **Step 2: Rewrite `commit()` to use it**

Replace the existing `commit` function body (keep the surrounding `promptCommitMessage` untouched):

```js
async function commit(btn, message) {
    const original = 'Commit';
    btn.textContent = 'Committing…';
    btn.disabled = true;
    try {
        if (!(await ensureConfigured(btn, original))) return;

        const data = await pageRequest('list-files');
        const files = data.contents.map((c) => ({
            path: c.path,
            contents: c.contents,
        }));
        console.log(`[pybricks-git] committing ${files.length} file(s)`);

        const result = await serverRequest('commit', { files, message });
        console.log('[pybricks-git] commit result:', result);
        if (result.preserved && result.preserved.length) {
            console.warn(
                '[pybricks-git] kept files never seen by a Pull (fork starter code?):',
                result.preserved,
            );
        }
        const label = result.committed ? `✓ ${result.head}` : 'no changes';
        btn.textContent = label + (result.pushed ? ' ↑' : '');
        setTimeout(() => (btn.textContent = original), 3000);
    } catch (err) {
        console.error('[pybricks-git] commit failed:', err);
        btn.textContent = 'error';
        setTimeout(() => (btn.textContent = original), 3000);
    } finally {
        btn.disabled = false;
    }
}
```

- [ ] **Step 3: Rewrite `pull()` to use it**

```js
async function pull(btn) {
    const original = 'Pull';
    btn.textContent = 'Pulling…';
    btn.disabled = true;
    try {
        if (!(await ensureConfigured(btn, original))) return;

        const result = await serverRequest('pull');
        if (result.pullWarning) {
            console.warn('[pybricks-git] pull warning:', result.pullWarning);
        }
        console.log(`[pybricks-git] received ${result.files.length} file(s)`);

        const summary = await pageRequest('apply-files', { files: result.files });
        console.log('[pybricks-git] applied:', summary);
        btn.textContent = `↓ +${summary.added} ~${summary.changed} -${summary.deleted}`;

        // dexie-observable doesn't see raw IDB writes, so reload to refresh
        // the React UI. Brief delay so the user can see the summary.
        if (summary.added || summary.changed || summary.deleted) {
            setTimeout(() => location.reload(), 1500);
        } else {
            setTimeout(() => (btn.textContent = original), 3000);
        }
    } catch (err) {
        console.error('[pybricks-git] pull failed:', err);
        btn.textContent = 'error';
        setTimeout(() => (btn.textContent = original), 3000);
    } finally {
        btn.disabled = false;
    }
}
```

- [ ] **Step 4: Verify**

```bash
node --check src/content.js
grep -n 'localhost\|fetchJSON\|SERVER' src/content.js
npm test
```

Expected: syntax OK; the grep prints nothing; tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/content.js
git commit -m "feat(extension): route commit/pull through the service worker instead of localhost"
```

---

### Task 8: Settings popup

**Files:**
- Create: `src/popup.html`, `src/popup.js`

**Interfaces:**
- Consumes: `settings` storage key shape (Global Constraints); `api.github.com` host permission (Task 6).
- Produces: `settings.email` derived from the token's GitHub login, consumed by the engine's commit author.

- [ ] **Step 1: Write `src/popup.html`**

```html
<!doctype html>
<meta charset="utf-8" />
<title>Pybricks Git settings</title>
<style>
    body { font: 13px system-ui, sans-serif; min-width: 320px; padding: 12px; }
    label { display: block; margin: 8px 0 2px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; padding: 4px 6px; }
    button { margin: 12px 8px 0 0; padding: 6px 12px; }
    #status { margin-top: 10px; white-space: pre-wrap; }
</style>
<label>Fork URL
    <input id="repoUrl" placeholder="https://github.com/your-team/robot-code" />
</label>
<label>Branch
    <input id="branch" placeholder="main" />
</label>
<label>GitHub token (fine-grained, this fork only, Contents read/write)
    <input id="token" type="password" />
</label>
<label>Team name
    <input id="name" placeholder="Team Rocket" />
</label>
<button id="save">Save</button>
<button id="test">Test connection</button>
<div id="status"></div>
<script src="popup.js"></script>
```

- [ ] **Step 2: Write `src/popup.js`**

```js
const FIELDS = ['repoUrl', 'branch', 'token', 'name'];
const $ = (id) => document.getElementById(id);

async function loadForm() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    for (const f of FIELDS) $(f).value = settings[f] ?? '';
}

async function saveForm(extra = {}) {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const next = { ...settings, ...extra };
    for (const f of FIELDS) next[f] = $(f).value.trim();
    if (!next.branch) next.branch = 'main';
    await chrome.storage.local.set({ settings: next });
    return next;
}

$('save').addEventListener('click', async () => {
    await saveForm();
    $('status').textContent = 'Saved.';
});

$('test').addEventListener('click', async () => {
    $('status').textContent = 'Testing…';
    const s = await saveForm();
    const match = s.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) {
        $('status').textContent = 'Fork URL must look like https://github.com/owner/repo';
        return;
    }
    const headers = {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/vnd.github+json',
    };
    try {
        const repo = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`, { headers });
        if (!repo.ok) throw new Error(`token cannot see ${match[1]}/${match[2]} (HTTP ${repo.status})`);
        const user = await fetch('https://api.github.com/user', { headers });
        const login = user.ok ? (await user.json()).login : null;
        const email = login
            ? `${login}@users.noreply.github.com`
            : 'team@users.noreply.github.com';
        await saveForm({ email });
        $('status').textContent = `OK — token can see ${match[1]}/${match[2]}` +
            (login ? `; commits will be authored as ${login}.` : '.');
    } catch (err) {
        $('status').textContent = `Failed: ${err.message}`;
    }
});

loadForm();
```

- [ ] **Step 3: Verify**

```bash
node --check src/popup.js
npm test
```

Expected: syntax OK, tests pass. (The popup is exercised for real in Task 10.)

- [ ] **Step 4: Commit**

```bash
git add src/popup.html src/popup.js
git commit -m "feat(extension): settings popup with GitHub token test"
```

---

### Task 9: Delete the Go server and native-host; rewrite docs

**Files:**
- Delete: `server/` (all files), `native-host/` (all files)
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Delete the superseded pieces**

```bash
git rm -r server native-host
```

- [ ] **Step 2: Rewrite `README.md`**

Keep the existing headline + "Why this exists" framing, then replace everything from **Current capabilities** down with:

- **Current capabilities:** Commit button (message prompt, blank = timestamped) that commits *and pushes* the editor's files to the team's GitHub fork; Pull button that fetches the fork and applies changes into the editor (preserving Monaco view state and file UUIDs); works for block programs and Python identically; runs on anything that can sideload a Chrome extension — including Chromebooks — with **no local server or install**.
- **How it works (one paragraph):** the extension performs git itself (vendored isomorphic-git in the service worker) speaking GitHub's HTTPS protocol directly; commits are built on the freshly fetched remote head, so there is no local clone to corrupt; a snapshot of the last Pull guards against a first Commit deleting fork starter code.
- **Setup (the fork-per-team guide):**
  1. Mentor maintains the upstream shared-code repo. Each team clicks **Fork** on GitHub.
  2. Create a fine-grained PAT: *Settings → Developer settings → Fine-grained tokens*; Repository access = **only the fork**; Permissions = **Contents: Read and write**. Copy it.
  3. `chrome://extensions` → Developer mode → Load unpacked → repo root.
  4. Click the extension icon: enter fork URL, token, team name → **Test connection** → Save.
  5. On code.pybricks.com: **Pull first** (brings starter code into the editor), then work, then **Commit**.
- **Usage table:** Commit row (message input, `✓ <sha> ↑` / `no changes` / `setup needed` / `error`), Pull row (`↓ +N ~N -N`, page reloads on changes).
- **Shared-code updates:** mentor updates upstream; teams press **Sync fork** on GitHub, then Pull.
- **Known limitations:** page reloads after Pull (dexie-observable); token stored in `chrome.storage.local` (device-local, readable by anyone using the Chrome profile); commit-before-first-Pull preserves rather than deletes unknown files (by design).
- **Roadmap:** GitHub Device Flow OAuth (replace pasted PATs); open-tab cleanup on delete; Chrome Web Store listing (removes even the sideloading step).

- [ ] **Step 3: Rewrite `CLAUDE.md`**

Update these sections, keeping the file's voice and the untouched sections (IndexedDB schema, block files, dexie-observable) as they are:

- **Project / Architecture:** replace the three-tier diagram with the new one (page ↔ content.js ↔ background.js service worker ↔ github.com); delete every mention of the Go server, `--repo`, ports, CORS/CORP, and native messaging; document the message ops table and storage keys (copy from this plan's Global Constraints).
- **New section "The git engine":** stateless commit model (build on fetched head, no working tree), the last-Pull snapshot guard, the 3-attempt push retry, the lightning-fs gitdir being a disposable cache, auth via `x-access-token` + PAT.
- **Commands:** drop the Go commands; keep `npm install` / `npm test`; note tests need the real `git` binary; keep the load-unpacked instructions.
- **Tests:** describe `test/git-http-server.mjs` (CGI harness), `test/load-background.mjs` (unmodified-source loader — same rule as inject.js: no ESM exports), and that `vendor/` files are pinned per `vendor/README.md`.
- **Things to know:** keep the ChromeOS note but update it — unmanaged Chromebooks now work via sideloading; managed ones still need the Web Store/policy story.

- [ ] **Step 4: Verify nothing references the dead pieces**

```bash
grep -rn 'localhost:8127\|native-host\|native messaging\|go run\|server/main.go' README.md CLAUDE.md manifest.json src/ test/ || echo CLEAN
npm test
```

Expected: `CLEAN` (or only historical mentions you deliberately kept in CLAUDE.md's history notes — none expected); tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat!: remove Go server and native-host; extension is the whole product"
```

---

### Task 10: Browser end-to-end verification

**Files:**
- Create: `test/e2e/README.md` (the recipe, checked in), `test/e2e/drive.mjs` (CDP driver)

This task verifies the real flow in headless Chromium against the Task 2 git harness. It follows the proven recipe from the previous round (see memory note `browser-e2e-recipe`): use **Playwright's Chromium** (`~/.cache/ms-playwright/chromium-*/chrome-linux/chrome` — branded Chrome ignores `--load-extension`), and drive with **trusted CDP input events**, not synthetic DOM events.

- [ ] **Step 1: Start the pieces**

```bash
S=$(mktemp -d)
# 1. Serve a seeded bare repo:
node -e "
import('./test/git-http-server.mjs').then(async (h) => {
  const bare = h.makeBareRepo(process.env.S, 'team', { 'starter.py': 'print(\"starter\")\n' });
  const srv = await h.startGitServer(process.env.S);
  console.log(srv.url); // note the port
});
" &
# 2. Launch Chromium with the extension:
CHROME=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome | sort | tail -1)
$CHROME --headless=new --disable-gpu --no-first-run \
  --disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults \
  --user-data-dir=$S/profile \
  --load-extension="$PWD" \
  --remote-debugging-port=9333 \
  https://code.pybricks.com &
```

- [ ] **Step 2: Configure settings through the service worker target**

Write and run `test/e2e/drive.mjs` (raw CDP over Node's built-in WebSocket, following the pattern in the memory recipe). It must, in order:

1. Find the extension's **service_worker** target at `http://127.0.0.1:9333/json`; attach; `Runtime.evaluate`:
   `chrome.storage.local.set({settings:{repoUrl:'http://127.0.0.1:<PORT>/team.git', branch:'main', token:'test', name:'E2E Team', email:'e2e@example.com'}})`
2. Find the code.pybricks.com **page** target; find the extension's isolated world (`Runtime.executionContextCreated`, name "Pybricks Git").
3. Wait for the Commit/Pull buttons to mount.
4. **Pull:** real-click Pull (trusted `Input.dispatchMouseEvent` at the button's center); assert the button shows `↓ +1 ~0 -0` and the page reload lands `starter.py` in the editor (after reload, `pageRequest('list-files')` from the isolated world contains it).
5. **Commit:** seed one more file via `pageRequest('apply-files', ...)`; real-click Commit; trusted-type `e2e message`; trusted Enter; assert the label timeline shows `Committing…` then `✓ <sha> ↑`.
6. Assert on the harness side (`bareSubjects` includes `e2e message`, `bareFile` returns the new file, and `starter.py` still exists — the guard held if step 5 ran before any post-reload pull).
7. Capture `Runtime.exceptionThrown` throughout — **any extension exception fails the run** (this is what caught the blur-re-entrancy bug last time).
8. Screenshot the toolbar as evidence.

- [ ] **Step 3: Record results**

Write `test/e2e/README.md`: how to run (steps 1–2 verbatim), what PASS looks like, and paste the label timeline + final assertions from the successful run. Fix any bug found (each fix is its own TDD cycle: reproduce in a Node test if the engine is at fault, fix, re-run E2E).

- [ ] **Step 4: Full suite + commit**

```bash
npm test
git add test/e2e
git commit -m "test: browser E2E driver and recipe for the in-extension git flow"
```

---

## Final acceptance (run after all tasks)

```bash
npm test                                   # every suite green
node --check src/background.js src/content.js src/popup.js src/inject.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
git log --oneline main..HEAD               # one commit per task, conventional messages
```

Then load unpacked in real Chrome against a real GitHub fork (manual, Brendon): configure popup with a real PAT, Pull, edit a program, Commit with a message, confirm the commit + author on GitHub.
