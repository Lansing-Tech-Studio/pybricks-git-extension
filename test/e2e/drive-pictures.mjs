// Browser end-to-end driver for BLOCK-PROGRAM PICTURES on Commit.
//
// Self-contained sibling of drive-splice.mjs: starts the in-repo git HTTP
// harness with a repo of block programs and no pictures, launches Playwright's
// Chromium with the unpacked extension, and drives Pull → Commit (backfills a
// PNG next to every block program) → Commit (no changes) → edit one program →
// Commit (only that PNG changes) → delete one program → Commit (its PNG goes)
// → Pull (no PNG reaches the editor) on https://code.pybricks.com over raw CDP.
// Asserts on the git-server side, the editor's tabs and IndexedDB, and that
// nothing was downloaded.
//
// Run:  PYBRICKS_LICENSE=<licence JSON> node test/e2e/drive-pictures.mjs
// Exit: 0 = PASS, non-zero = FAIL (reason printed).
//       pictures-sample.png (the committed picture of prog_a.py) on a licensed
//       success, pictures-failure.png on failure (this dir).
//
// Without PYBRICKS_LICENSE the run only asserts that the picture pass is inert:
// a Commit lands with no PNG, no tab opened and no licence dialog raised.
//
// The CDP client, Chromium discovery, LNA-disable launch flags, trusted-input
// helpers, isolated-world tracking, exception capture and Welcome-Tour
// dismissal are copied from drive-splice.mjs (deliberately self-contained).

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startGitServer, makeBareRepo, bareSubjects, bareFile } from '../git-http-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 600);
const PYBRICKS_URL = 'https://code.pybricks.com';
const log = (...a) => console.log('[e2e-pictures]', ...a);
const step = (n, m) => console.log(`\n[e2e-pictures] === STEP ${n}: ${m} ===`);

const fixture = (name) => readFileSync(join(REPO_ROOT, 'test/fixtures', name), 'utf8');
const PROG_A = fixture('blocks-demo.py');
const PROG_A_EDITED = fixture('blocks-team2.py'); // a different program, standing in for a kid's edit
const PROG_B = fixture('setup-only.py');
const SEED_FILES = {
    '.pybricks-git.json': '{"schemaVersion":1,"protected":["coach.py"]}\n',
    'coach.py': fixture('setup-only.py'),
    'prog_a.py': PROG_A,
    'prog_b.py': PROG_B,
    'text.py': 'print("hello")\n',
};

const bareBytes = (bare, path) => execFileSync('git', ['-C', bare, 'show', `main:${path}`], { stdio: ['ignore', 'pipe', 'pipe'] });
const bareHas = (bare, path) => { try { bareBytes(bare, path); return true; } catch { return false; } };
// Width and height from a PNG's IHDR chunk, or null when the bytes aren't a PNG.
function pngSize(buf) {
    if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function findChromium() {
    const glob = join(process.env.HOME, '.cache/ms-playwright');
    let best = null;
    for (const d of readdirSync(glob)) {
        if (!/^chromium-\d+$/.test(d)) continue;
        // Newer Playwright builds unpack to chrome-linux64/, older ones to chrome-linux/.
        const bin = ['chrome-linux64/chrome', 'chrome-linux/chrome']
            .map((sub) => join(glob, d, sub))
            .find((p) => existsSync(p));
        if (!bin) continue;
        const rev = parseInt(d.split('-')[1], 10);
        if (!best || rev > best.rev) best = { rev, bin };
    }
    if (!best) {
        throw new Error(
            'Playwright Chromium not found under ~/.cache/ms-playwright. ' +
                'Install with: npx playwright install chromium',
        );
    }
    return best.bin;
}

// ---- Minimal CDP client over one WebSocket (copied from drive.mjs) ----------
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.listeners = [];
        this.ready = new Promise((res, rej) => {
            this.ws.addEventListener('open', () => res());
            this.ws.addEventListener('error', (e) => rej(new Error('CDP websocket error: ' + (e.message || e.type))));
        });
        this.ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id != null && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
            } else if (msg.method) {
                for (const l of this.listeners) l(msg.method, msg.params);
            }
        });
    }
    onEvent(cb) { this.listeners.push(cb); }
    async send(method, params = {}) {
        await this.ready;
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function fetchJSON(url, tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('timed out waiting for ' + url);
}

async function poll(fn, { timeout = 30000, interval = 200, what = 'condition' } = {}) {
    const start = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
        await sleep(interval);
    }
}

async function main() {
    const scratch = mkdtempSync(join(tmpdir(), 'pbgit-e2e-pictures-'));
    const profile = join(scratch, 'profile');
    let server = null;
    let chrome = null;
    const cleanup = () => {
        if (chrome && !chrome.killed) { try { chrome.kill('SIGKILL'); } catch { /* ignore */ } }
        if (server) server.close().catch(() => {});
        try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    };

    const evidence = { assertions: [] };
    const extExceptions = [];
    const pageExceptions = [];
    const exceptionSummary = (det = {}) => (det.exception && det.exception.description) || det.text || 'exception';
    const assert = (cond, msg) => {
        evidence.assertions.push({ ok: !!cond, msg });
        log(cond ? 'PASS:' : 'FAIL:', msg);
        if (!cond) throw new Error('assertion failed: ' + msg);
    };

    try {
        // -- Harness: seed a bare repo and serve it -------------------------
        step(1, 'Start git harness with a repo of block programs and no pictures');
        const bare = makeBareRepo(scratch, 'team', SEED_FILES);
        server = await startGitServer(scratch);
        const repoUrl = `${server.url}/team.git`;
        log('git server at', server.url, '-> repoUrl', repoUrl);

        // -- Launch Chromium with the unpacked extension (copied from drive.mjs)
        step(1, 'Launch Chromium with the extension loaded');
        const bin = findChromium();
        log('chromium:', bin);
        chrome = spawn(
            bin,
            [
                '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
                '--window-size=1400,1000',
                '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults',
                `--user-data-dir=${profile}`, `--load-extension=${REPO_ROOT}`,
                `--remote-debugging-port=${DEBUG_PORT}`, PYBRICKS_URL,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        chrome.stderr.on('data', (d) => { const s = d.toString(); if (/error|fail/i.test(s)) process.stderr.write('[chrome] ' + s); });

        // -- Discover the service_worker target and write settings ----------
        step(2, 'Configure settings via the service_worker target');
        await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        const swTarget = await poll(
            async () => {
                const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
                return list.find((t) => t.type === 'service_worker' && t.url.endsWith('src/background.js'));
            },
            { timeout: 30000, what: 'extension service_worker target' },
        );
        const sw = new CDP(swTarget.webSocketDebuggerUrl);
        sw.onEvent((method, params) => {
            if (method === 'Runtime.exceptionThrown') {
                const summary = exceptionSummary(params.exceptionDetails);
                extExceptions.push('sw: ' + summary);
                log('EXTENSION EXCEPTION (sw):', summary.split('\n')[0]);
            }
        });
        await sw.send('Runtime.enable');
        const evalSw = async (expression) => {
            const r = await sw.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error('sw eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
            return r.result.value;
        };
        const settings = { repoUrl, branch: 'main', token: 'test', name: 'E2E Team', email: 'e2e@example.com' };
        await evalSw(`chrome.storage.local.set({settings:${JSON.stringify(settings)}})`);
        assert((await evalSw(`chrome.storage.local.get('settings')`)).settings.repoUrl === repoUrl, 'settings written to chrome.storage.local via SW');

        // -- Attach to the page and track the isolated world (copied) -------
        const pageTarget = await poll(
            async () => {
                const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
                return list.find((t) => t.type === 'page' && t.url.startsWith(PYBRICKS_URL));
            },
            { timeout: 30000, what: 'code.pybricks.com page target' },
        );
        const page = new CDP(pageTarget.webSocketDebuggerUrl);
        let isolatedCtx = null;
        page.onEvent((method, params) => {
            if (method === 'Runtime.executionContextCreated') {
                const c = params.context;
                if (c.auxData && c.auxData.type === 'isolated' && /Pybricks Git/.test(c.name || '')) {
                    isolatedCtx = c.id;
                    log('isolated world context id =', c.id);
                }
            } else if (method === 'Runtime.consoleAPICalled') {
                // The extension's own console lines explain a skipped picture.
                const text = params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.map((p) => `${p.name}=${p.value}`))).join(' ');
                if (text.includes('[pybricks-git]')) log('console:', text.slice(0, 600));
            } else if (method === 'Runtime.executionContextsCleared') {
                isolatedCtx = null;
            } else if (method === 'Runtime.exceptionThrown') {
                const det = params.exceptionDetails || {};
                const frames = (det.stackTrace && det.stackTrace.callFrames) || [];
                const text = JSON.stringify(det.url || '') + JSON.stringify(frames.map((f) => f.url));
                const isExt = /chrome-extension:\/\//.test(text) ||
                    /content\.js|inject\.js|background\.js|menu-panel\.js|menu-config\.js|file-list\.js|blocksplice\.js/.test(text);
                const summary = exceptionSummary(det);
                (isExt ? extExceptions : pageExceptions).push((isExt ? 'page: ' : '') + summary);
                if (isExt) log('EXTENSION EXCEPTION (page):', summary.split('\n')[0]);
            }
        });
        await page.send('Page.enable');
        await page.send('Runtime.enable');

        // Pictures need the block editor, which code.pybricks.com gates behind a
        // licence. Seed it from the environment (never committed) and reload so
        // the app reads it. Without it, the run asserts the picture pass is inert.
        const licence = process.env.PYBRICKS_LICENSE || '';
        if (licence) {
            // The target exists before the document does: until the origin is
            // the app's, localStorage is another document's (or throws).
            await poll(async () => {
                const r = await page.send('Runtime.evaluate', {
                    expression: `location.origin === ${JSON.stringify(PYBRICKS_URL)} && (localStorage.setItem('pybricks.license', ${JSON.stringify(licence)}), true)`,
                    returnByValue: true,
                });
                return !r.exceptionDetails && r.result.value === true;
            }, { timeout: 30000, what: 'the app origin, to seed the licence' });
            await page.send('Page.reload');
            log('seeded block-coding licence from PYBRICKS_LICENSE and reloaded');
        } else {
            log('PYBRICKS_LICENSE unset — asserting only that Commit takes no pictures');
        }
        const downloads = join(scratch, 'downloads');
        await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

        const evalIsolated = async (expression, awaitPromise = true) => {
            const ctx = await poll(() => isolatedCtx, { timeout: 40000, what: 'isolated world context' });
            const r = await page.send('Runtime.evaluate', { expression, contextId: ctx, awaitPromise, returnByValue: true, userGesture: true });
            if (r.exceptionDetails) throw new Error('isolated eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
            return r.result.value;
        };
        const buttonRect = (labelPrefix) => evalIsolated(
            `(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(labelPrefix)})); if(!b)return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`, false);
        const rectOf = (selector) => evalIsolated(
            `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`, false);
        const exists = (selector) => evalIsolated(`!!document.querySelector(${JSON.stringify(selector)})`, false);

        const trustedClick = async (pt) => {
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
            await sleep(30);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
        };
        const clickSelector = async (selector, what = selector) => {
            const pt = await poll(() => rectOf(selector), { timeout: 15000, what: `${what} to be clickable` });
            await trustedClick(pt);
            return pt;
        };

        // -- Wait for toolbar + IndexedDB -----------------------------------
        step(3, 'Wait for toolbar buttons + Pybricks IndexedDB');
        await poll(async () => (await buttonRect('Pull')) && (await buttonRect('Commit')) && (await exists('[data-pybricks-git-menu-btn]')),
            { timeout: 40000, what: 'Pybricks Git toolbar buttons' });
        await poll(async () => { try { await evalIsolated(`pageRequest('list-files')`); return true; } catch { return false; } },
            { timeout: 40000, what: 'Pybricks IndexedDB ready' });

        // -- Dismiss the Welcome Tour (copied from drive.mjs) ---------------
        step(3, 'Dismiss the Pybricks Welcome Tour if present');
        const tourOverlayGone = () => evalIsolated(`!document.querySelector('.react-joyride__overlay')`, false);
        const tourDismissRect = () => evalIsolated(
            `(() => { const b=document.querySelector('#react-joyride-portal button[data-action="skip"], #react-joyride-portal button[data-action="close"], .react-joyride__tooltip button[data-action="skip"], .react-joyride__tooltip button[data-action="close"]'); if(!b)return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,action:b.getAttribute('data-action')}; })()`, false);
        if (!(await tourOverlayGone())) {
            await poll(async () => {
                if (await tourOverlayGone()) return true;
                const r = await tourDismissRect();
                if (r) await trustedClick(r);
                else { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' }); }
                return false;
            }, { timeout: 15000, interval: 500, what: 'Welcome Tour to dismiss' });
        }

        // -- Scenario helpers ------------------------------------------------
        const evalMain = async (expression) => {
            const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error('main eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
            return r.result.value;
        };
        await evalIsolated(`window.__pbgitNoReload = 1`, false);
        const ctxBefore = isolatedCtx;
        const noReload = async () =>
            isolatedCtx === ctxBefore && (await evalIsolated(`window.__pbgitNoReload === 1`, false));
        const buttonLabel = (prefixes) => evalIsolated(
            `(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>${JSON.stringify(prefixes)}.some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent.trim():null; })()`, false);
        const editorFiles = async () => (await evalIsolated(`pageRequest('list-files')`)).contents;
        const openTabs = () => evalMain(`document.querySelectorAll('.pb-editor-tablist-tab').length`);
        const dialogTitle = () => evalMain(`document.querySelector('.bp5-dialog .bp5-heading')?.textContent ?? ''`);
        const commit = async (message) => {
            // 'Committing…' also starts with "Commit": wait for the idle label.
            await poll(async () => (await buttonLabel(['Commit'])) === 'Commit', { timeout: 15000, what: 'the Commit button to be idle' });
            await trustedClick(await buttonRect('Commit'));
            await poll(() => exists('[data-pybricks-git-msg]'), { timeout: 10000, what: 'commit message input' });
            await page.send('Input.insertText', { text: message });
            for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
            const label = await poll(
                async () => {
                    const raw = await buttonLabel(['Committing', 'Taking', '✓', 'no changes', 'error']);
                    return raw && (/^✓ [0-9a-f]{7}/.test(raw) || raw === 'error' || raw === 'no changes') ? raw : null;
                },
                { timeout: 120000, interval: 100, what: 'Commit result label' },
            );
            log(`commit "${message}" label =`, JSON.stringify(label));
            return label;
        };

        // -- Pull -------------------------------------------------------------
        step(4, 'Pull the repo, with no reload');
        await trustedClick(await buttonRect('Pull'));
        const pullLabel = await poll(
            async () => {
                const l = await buttonLabel(['Pull', 'Pulling', '↓', 'error', 'setup', 'nothing']);
                return l && /^(↓|error|setup|nothing)/.test(l) ? l : null;
            },
            { timeout: 30000, interval: 100, what: 'Pull result label' },
        );
        assert(pullLabel === '↓ +4 ~0 -0', `Pull label is "↓ +4 ~0 -0" (got "${pullLabel}")`);
        await sleep(2500); // the raw fallback reloads 1.5s after the label
        assert(await noReload(), 'the page did not reload after Pull');
        assert((await openTabs()) === 0, 'no editor tab is open before the first Commit');

        if (!licence) {
            // -- Unlicensed: the picture pass must be inert -------------------
            step(5, 'Commit a changed block program without a licence');
            const w = await evalIsolated(`pageRequest('write-files-live', {files:[{path:'prog_a.py', contents:${JSON.stringify(PROG_A_EDITED)}}]})`);
            assert(w.live === true, 'edited prog_a.py through the app');
            const label = await commit('edit without a licence');
            assert(/^✓ [0-9a-f]{7} ↑$/.test(label), `commit landed (got "${label}")`);
            assert(bareFile(bare, 'prog_a.py') === PROG_A_EDITED, 'the edited program was pushed');
            assert(!bareHas(bare, 'prog_a.png') && !bareHas(bare, 'prog_b.png'), 'no picture was committed');
            assert((await openTabs()) === 0, 'Commit opened no tab');
            assert((await dialogTitle()) === '', 'Commit raised no licence dialog');
            assert(await noReload(), 'the page did not reload');
        } else {
            // -- Backfill -----------------------------------------------------
            step(5, 'First Commit backfills a picture next to every block program');
            assert((await evalIsolated(`blockCodingEnabled()`, false)) === true, 'the extension sees the block-coding licence');
            const needed = await evalIsolated(`readEditorFiles().then((files) => serverRequest('imagesNeeded', { files }))`);
            log('imagesNeeded =', JSON.stringify(needed));
            assert(JSON.stringify([...needed.paths].sort()) === JSON.stringify(['prog_a.py', 'prog_b.py']), 'the engine wants a picture of both unprotected block programs');
            const first = await commit('first pictures');
            assert(/^✓ [0-9a-f]{7} ↑$/.test(first), `commit landed (got "${first}")`);
            for (const prog of ['prog_a', 'prog_b']) {
                const size = bareHas(bare, `${prog}.png`) ? pngSize(bareBytes(bare, `${prog}.png`)) : null;
                log(`${prog}.png =`, JSON.stringify(size));
                assert(size && size.width > 100 && size.height > 100, `${prog}.png is a real PNG of the blocks (got ${JSON.stringify(size)})`);
            }
            writeFileSync(join(HERE, 'pictures-sample.png'), bareBytes(bare, 'prog_a.png'));
            assert(!bareHas(bare, 'coach.png'), 'the protected block program got no picture');
            assert(!bareHas(bare, 'text.png'), 'the text program got no picture');
            assert((await dialogTitle()) === '', 'no dialog was raised');
            assert((await openTabs()) === 0, 'the tabs opened for the pictures were closed again');
            assert(await noReload(), 'the page did not reload');
            const afterFirst = await editorFiles();
            for (const prog of ['prog_a.py', 'prog_b.py']) {
                assert(bareFile(bare, prog) === afterFirst.find((c) => c.path === prog).contents,
                    `${prog} was pushed exactly as the editor holds it after its picture was taken`);
            }
            assert(bareFile(bare, 'coach.py') === SEED_FILES['coach.py'], 'the protected program is byte-identical in the repo');

            // -- Stable ---------------------------------------------------------
            step(6, 'A second Commit with no edits changes nothing');
            const second = await commit('nothing to do');
            assert(second === 'no changes', `second commit is "no changes" (got "${second}")`);
            assert(!bareSubjects(bare).includes('nothing to do'), 'no commit was pushed');

            // -- Edit one program -------------------------------------------------
            step(7, 'Edit one program; only its picture changes');
            const pngA1 = bareBytes(bare, 'prog_a.png');
            const pngB1 = bareBytes(bare, 'prog_b.png');
            const w = await evalIsolated(`pageRequest('write-files-live', {files:[{path:'prog_a.py', contents:${JSON.stringify(PROG_A_EDITED)}}]})`);
            assert(w.live === true, 'edited prog_a.py through the app');
            const third = await commit('edit prog_a');
            assert(/^✓ [0-9a-f]{7} ↑$/.test(third), `commit landed (got "${third}")`);
            assert(!bareBytes(bare, 'prog_a.png').equals(pngA1), 'prog_a.png was retaken');
            assert(pngSize(bareBytes(bare, 'prog_a.png')), 'prog_a.png is still a PNG');
            assert(bareBytes(bare, 'prog_b.png').equals(pngB1), 'prog_b.png is untouched');
            assert((await openTabs()) === 0, 'the tab opened for the picture was closed again');

            // -- Delete one program -----------------------------------------------
            step(8, 'Delete a block program; its picture goes with it');
            const keep = (await editorFiles()).filter((c) => c.path !== 'prog_b.py').map((c) => ({ path: c.path, contents: c.contents }));
            const d = await evalIsolated(`pageRequest('write-files-live', {files:${JSON.stringify(keep)}, deleteUnlisted:true})`);
            assert(d.live === true && d.summary.deleted === 1, 'deleted prog_b.py through the app');
            const fourth = await commit('delete prog_b');
            assert(/^✓ [0-9a-f]{7} ↑$/.test(fourth), `commit landed (got "${fourth}")`);
            assert(!bareHas(bare, 'prog_b.py') && !bareHas(bare, 'prog_b.png'), 'prog_b.py and prog_b.png are both gone');
            assert(bareHas(bare, 'prog_a.png'), 'prog_a.png is still there');

            // -- Pull -------------------------------------------------------------
            step(9, 'Pull hands the editor no picture');
            await poll(async () => (await buttonLabel(['Pull'])) === 'Pull', { timeout: 15000, what: 'the Pull button to be idle' });
            await trustedClick(await buttonRect('Pull'));
            await poll(async () => /^(↓|nothing)/.test((await buttonLabel(['↓', 'nothing', 'error'])) || ''), { timeout: 30000, interval: 100, what: 'Pull result label' });
            const paths = (await editorFiles()).map((c) => c.path).sort();
            assert(JSON.stringify(paths) === JSON.stringify(['coach.py', 'prog_a.py', 'text.py']), `the editor holds only .py files (got ${JSON.stringify(paths)})`);
        }

        // -- Nothing downloaded, no exceptions --------------------------------
        step(10, 'Nothing was downloaded; zero extension exceptions');
        const downloaded = existsSync(downloads) ? readdirSync(downloads) : [];
        assert(downloaded.length === 0, `no file landed in the download folder (got ${JSON.stringify(downloaded)})`);
        if (pageExceptions.length) log(`(note: ${pageExceptions.length} non-extension page exception(s) ignored)`);
        assert(extExceptions.length === 0, `zero extension exceptions (saw ${extExceptions.length}${extExceptions.length ? ': ' + extExceptions.map((e) => e.split('\n')[0]).join(' | ') : ''})`);

        console.log('\n[e2e-pictures] ================= PASS =================');
        console.log('[e2e-pictures] pictures:', licence ? 'asserted' : 'SKIPPED (no PYBRICKS_LICENSE): inert pass asserted');
        for (const a of evidence.assertions) console.log('        [PASS]', a.msg);
        sw.close(); page.close(); cleanup();
        process.exit(0);
    } catch (err) {
        console.error('\n[e2e-pictures] ================= FAIL =================');
        console.error('[e2e-pictures]', err.stack || err.message);
        if (extExceptions.length) { console.error(`[e2e-pictures] extension exceptions (${extExceptions.length}):`); for (const e of extExceptions) console.error('  ' + e.split('\n')[0]); }
        try {
            const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
            const pt = list.find((t) => t.type === 'page');
            if (pt) { const c = new CDP(pt.webSocketDebuggerUrl); const shot = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(HERE, 'pictures-failure.png'), Buffer.from(shot.data, 'base64')); console.error('[e2e-pictures] failure screenshot:', join(HERE, 'pictures-failure.png')); c.close(); }
        } catch { /* best effort */ }
        cleanup();
        process.exit(1);
    }
}

main();
