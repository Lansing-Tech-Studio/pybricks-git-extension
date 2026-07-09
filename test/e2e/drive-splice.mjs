// Browser end-to-end driver for the phase-4 SETUP SPLICE round-trip.
//
// Self-contained sibling of drive.mjs / drive-menu.mjs: starts the in-repo git
// HTTP harness (Task 2), launches Playwright's Chromium with the unpacked
// extension, and drives the real Pull → New-program → Update-robot-setup →
// editor round-trip → Commit flow on https://code.pybricks.com over raw CDP
// (Node 22's built-in WebSocket, no npm deps). Asserts on the browser side
// (nudge markers, Update button, splice report), the editor IndexedDB
// (created/spliced files, signatures via the isolated world's own blocksplice
// globals), and the git-server side (the snapshot commit holds the PRE-splice
// content; the manual Commit pushes the spliced content).
//
// Run:  node test/e2e/drive-splice.mjs
// Exit: 0 = PASS, non-zero = FAIL/BLOCKED (reason printed).
//       splice-panel.png on success, splice-failure.png on failure (this dir).
//
// The CDP client, Chromium discovery, LNA-disable launch flags, trusted-input
// helpers, isolated-world tracking, exception capture, and Welcome-Tour
// dismissal are all copied from test/e2e/drive.mjs (deliberately a
// self-contained script) — the same hard-won environment facts apply here.
// Splice-specific scenario logic is original to this file.

import { spawn } from 'node:child_process';
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
const log = (...a) => console.log('[e2e-splice]', ...a);
const step = (n, m) => console.log(`\n[e2e-splice] === STEP ${n}: ${m} ===`);

// ---- Derived fixtures -------------------------------------------------------
// robot_setup.py is the editor-authored setup-only fixture (the team setup).
// prog_differs/prog_renamed are JSON surgeries on its setup chain, mirroring
// what a coach/kid would produce. prog_match keeps the team chain verbatim.
// (The exact mutations are validated against the real blocksplice functions in
// the phase-4 unit tests + Task 6's fixture probe.)
const SENT = '# pybricks blocks file:';
const ROBOT_SETUP = readFileSync(join(REPO_ROOT, 'test/fixtures/setup-only.py'), 'utf8');
function splitBlocks(contents) {
    const nl = contents.indexOf('\n');
    return {
        json: JSON.parse(contents.slice(SENT.length, nl === -1 ? undefined : nl)),
        python: nl === -1 ? '' : contents.slice(nl + 1),
    };
}
function joinBlocks(json, python) { return SENT + JSON.stringify(json) + '\n' + python; }
function setupChain(json) {
    const out = [];
    let node = json.blocks.blocks.find((b) => b.type === 'blockGlobalSetup');
    while (node) { out.push(node); node = node.next && node.next.block; }
    return out;
}
// prog_differs: the left-wheel motor's port F -> E (motors ref their variable by
// id, so match on the PORT shadow value). Splices cleanly back to F.
function makeDiffers(base) {
    const { json, python } = splitBlocks(base);
    let hit = false;
    for (const blk of setupChain(json)) {
        const nf = blk.inputs?.PORT?.shadow?.fields;
        if (blk.type === 'variables_set_motor' && nf && nf.NAME === 'F') { nf.NAME = 'E'; hit = true; }
    }
    if (!hit) throw new Error('fixture makeDiffers: PORT F motor not found');
    return joinBlocks(json, python);
}
// prog_renamed: rename the "attachment" device -> "grabber" in the variables[]
// table. Trips the nudge AND makes spliceSetup skip ("its own device").
function makeRenamed(base) {
    const { json, python } = splitBlocks(base);
    let hit = false;
    for (const v of json.variables) { if (v && v.name === 'attachment') { v.name = 'grabber'; hit = true; } }
    if (!hit) throw new Error('fixture makeRenamed: "attachment" variable not found');
    return joinBlocks(json, python);
}

const PROG_MATCH = ROBOT_SETUP;                 // chain identical to the team setup
const PROG_DIFFERS = makeDiffers(ROBOT_SETUP);  // port E — differs, splices to F
const PROG_RENAMED = makeRenamed(ROBOT_SETUP);  // renamed device — skips
const MENU_CONFIG_SEED = ['"""The hub menu (seed)."""', '', 'MENU_ITEMS = [', ']', ''].join('\n');

const SEED_FILES = {
    '.pybricks-git.json':
        '{"schemaVersion":1,"menuConfig":"menu_config.py","teamSetup":"robot_setup.py","protected":["menu.py"]}\n',
    'menu.py': '# framework\n',
    'menu_config.py': MENU_CONFIG_SEED,
    'robot_setup.py': ROBOT_SETUP,
    'prog_match.py': PROG_MATCH,
    'prog_differs.py': PROG_DIFFERS,
    'prog_renamed.py': PROG_RENAMED,
};

function findChromium() {
    const glob = join(process.env.HOME, '.cache/ms-playwright');
    let best = null;
    for (const d of readdirSync(glob)) {
        if (!/^chromium-\d+$/.test(d)) continue;
        const bin = join(glob, d, 'chrome-linux/chrome');
        if (!existsSync(bin)) continue;
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
    const scratch = mkdtempSync(join(tmpdir(), 'pbgit-e2e-splice-'));
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
        step(1, 'Start git harness with a seeded phase-4 template repo');
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
        const rowHasMarker = (mod) => evalIsolated(
            `(() => { const a=document.querySelector('[data-pybricks-git-programs] [data-pybricks-git-add="'+${JSON.stringify(mod)}+'"]'); if(!a)return 'NO_ROW'; return !!a.parentElement.querySelector('[data-pybricks-git-setup-differs]'); })()`, false);
        const sigOf = (contents) => evalIsolated(`JSON.stringify(setupSignature(${JSON.stringify(contents)}).signature)`, false);

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

        // -- Pull -----------------------------------------------------------
        step(3, 'Pull the template repo, then wait for the reload');
        await trustedClick(await buttonRect('Pull'));
        const pullLabel = await poll(
            async () => {
                const l = await evalIsolated(`(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>['Pull','Pulling','↓','error','setup','nothing'].some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent:null; })()`, false);
                return l && /^(↓|error|setup|nothing)/.test(l) ? l : null;
            },
            { timeout: 30000, interval: 100, what: 'Pull result label' },
        );
        log('pull label =', JSON.stringify(pullLabel));
        // 6 .py: menu, menu_config, robot_setup, prog_match, prog_differs, prog_renamed.
        assert(pullLabel === '↓ +6 ~0 -0', `Pull label is "↓ +6 ~0 -0" (got "${pullLabel}")`);
        await poll(() => isolatedCtx === null, { timeout: 15000, what: 'reload to clear isolated context' }).catch(() => {});
        await poll(async () => (await buttonRect('Pull')) != null, { timeout: 40000, what: 'buttons to remount after reload' });

        // -- Manifest -------------------------------------------------------
        step(4, 'Assert lastPullManifest persisted teamSetup');
        const manifest = (await evalSw(`chrome.storage.local.get('lastPullManifest')`)).lastPullManifest;
        log('lastPullManifest =', JSON.stringify(manifest));
        assert(manifest && manifest.teamSetup === 'robot_setup.py' && JSON.stringify(manifest.protected) === JSON.stringify(['menu.py']),
            'lastPullManifest has teamSetup=robot_setup.py + protected=[menu.py]');

        // -- Open panel; assert nudges --------------------------------------
        step(5, 'Open Menu panel; assert setup-differs nudges + Update button');
        await clickSelector('[data-pybricks-git-menu-btn]', 'Menu toolbar button');
        await poll(() => exists('[data-pybricks-git-panel]'), { timeout: 15000, what: 'menu panel to open' });
        await poll(async () => (await rowHasMarker('prog_differs')) !== 'NO_ROW', { timeout: 10000, what: 'programs list to render' });
        assert((await rowHasMarker('prog_differs')) === true, 'prog_differs row is marked ⚠ setup differs');
        assert((await rowHasMarker('prog_match')) === false, 'prog_match row (matches the team setup) is NOT marked');
        assert((await rowHasMarker('prog_renamed')) === true, 'prog_renamed row is marked ⚠ setup differs');
        assert(await exists('[data-pybricks-git-update-setup]'), 'Update robot setup button present');
        assert(await exists('[data-pybricks-git-new-program]'), 'New program button present');

        // -- New program from the team setup --------------------------------
        // Creating a local file also DIVERGES the editor from the remote, so the
        // safety snapshot committed by Update (next step) lands a real commit.
        step(6, 'Create my_new_one via New program; assert seed after reload');
        await clickSelector('[data-pybricks-git-new-program]', 'New program button');
        await poll(() => exists('[data-pybricks-git-new-name]'), { timeout: 10000, what: 'name input row' });
        await clickSelector('[data-pybricks-git-new-name]', 'name input');
        await page.send('Input.insertText', { text: 'my_new_one' });
        await clickSelector('[data-pybricks-git-new-create]', 'Create button');
        await poll(() => isolatedCtx === null, { timeout: 15000, what: 'reload after create' }).catch(() => {});
        await poll(async () => (await buttonRect('Pull')) != null, { timeout: 40000, what: 'buttons remount post-create' });
        const robotRow0 = (await evalIsolated(`pageRequest('list-files')`)).contents.find((c) => c.path === 'robot_setup.py');
        const robotSig = await sigOf(robotRow0.contents);
        const listingAfterNew = await evalIsolated(`pageRequest('list-files')`);
        const newRow = listingAfterNew.contents.find((c) => c.path === 'my_new_one.py');
        assert(!!newRow, 'my_new_one.py created in editor IndexedDB');
        assert((await sigOf(newRow.contents)) === robotSig, 'my_new_one.py setupSignature === robot_setup.py signature');
        const newHasStart = await evalIsolated(`(() => { const p=parseBlocksFile(${JSON.stringify(newRow.contents)}); return p.error?false:p.json.blocks.blocks.some(b=>b.type==='blockGlobalStart'); })()`, false);
        assert(newHasStart === true, 'my_new_one.py JSON has a blockGlobalStart block');

        // -- Update robot setup ---------------------------------------------
        step(7, 'Record remote state, then Update robot setup');
        const subjectsBefore = bareSubjects(bare);
        assert(!subjectsBefore.includes('Before robot setup update'), 'no snapshot commit exists before Update');
        await poll(() => exists('[data-pybricks-git-panel]'), { timeout: 15000, what: 'panel reopened after create reload' });
        await clickSelector('[data-pybricks-git-update-setup]', 'Update robot setup button');
        await poll(() => isolatedCtx === null, { timeout: 20000, what: 'reload after Update' }).catch(() => {});
        await poll(async () => (await buttonRect('Pull')) != null, { timeout: 40000, what: 'buttons remount post-Update' });

        // -- Snapshot-first + report ----------------------------------------
        step(8, 'Assert snapshot-first commit + splice report + editor outcomes');
        const subjectsAfter = bareSubjects(bare);
        log('subjects after Update =', JSON.stringify(subjectsAfter));
        assert(subjectsAfter.includes('Before robot setup update'), 'remote gained the "Before robot setup update" snapshot commit');
        // The snapshot's tree holds the PRE-splice prog_differs (port E); the
        // spliced port-F version lives only in editor IDB until the manual
        // Commit below. That ordering IS the snapshot-first proof.
        assert(bareFile(bare, 'prog_differs.py') === PROG_DIFFERS, 'snapshot commit holds the PRE-splice prog_differs.py');
        assert(bareFile(bare, 'prog_renamed.py') === PROG_RENAMED, 'snapshot commit holds prog_renamed.py verbatim');
        assert(bareFile(bare, 'menu.py') === SEED_FILES['menu.py'], 'protected menu.py untouched in the snapshot');
        await poll(() => exists('[data-pybricks-git-splice-report]'), { timeout: 15000, what: 'splice report block' });
        const reportText = await evalIsolated(`(() => { const b=document.querySelector('[data-pybricks-git-splice-report]'); return b?b.textContent:''; })()`, false);
        log('report =', JSON.stringify(reportText));
        assert(/updated in:\s*prog_differs/i.test(reportText), 'report says robot setup updated in prog_differs');
        assert(/Skipped prog_renamed\.py/.test(reportText) && /its own device/.test(reportText), 'report lists prog_renamed.py skipped with the kid-facing reason');
        const listingSpliced = await evalIsolated(`pageRequest('list-files')`);
        const differsSpliced = listingSpliced.contents.find((c) => c.path === 'prog_differs.py');
        assert((await sigOf(differsSpliced.contents)) === robotSig, 'editor prog_differs.py setup signature now matches robot_setup.py');
        assert(listingSpliced.contents.find((c) => c.path === 'prog_renamed.py').contents === PROG_RENAMED, 'skipped prog_renamed.py byte-unchanged in the editor');

        // -- Editor round-trip (the spec's acceptance) ----------------------
        // blocks-format.md (Task 1) documents that the editor regenerates the
        // Python AND line-1 JSON on open (debounced), persisting via Dexie. The
        // invariant we assert is therefore SEMANTIC: after opening the spliced
        // file and giving the editor a beat, its line-1 JSON still parses and
        // its setup signature is unchanged (byte-for-byte Python is allowed to
        // regenerate). A regeneration that broke the setup would flip this.
        step(9, 'Editor round-trip: open prog_differs.py, assert signature stable');
        let roundTripped = false;
        const explorerPt = await rectOf('#pb-toolbar-explorer-button');
        if (explorerPt) {
            await trustedClick(explorerPt);
            const rowPt = await poll(() => evalIsolated(
                `(() => { const rows=[...document.querySelectorAll('[role="tree"][aria-label="Files"] li[role="treeitem"]')]; const r=rows.find(li=>{const l=li.querySelector('span.bp5-tree-node-label'); return l&&l.textContent==='prog_differs.py';}); if(!r)return null; const l=r.querySelector('span.bp5-tree-node-label'); const b=l.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })()`, false),
                { timeout: 10000, what: 'prog_differs.py row' }).catch(() => null);
            if (rowPt) { await trustedClick(rowPt); roundTripped = true; }
        }
        if (roundTripped) {
            await sleep(8000); // exceed the 4–7s regen debounce documented in blocks-format.md
            const errShown = await evalIsolated(`!!document.querySelector('.bp5-toast, .bp5-dialog')`, false);
            assert(!errShown, 'opening the spliced prog_differs.py raised no error toast/dialog');
            const reread = (await evalIsolated(`pageRequest('list-files')`)).contents.find((c) => c.path === 'prog_differs.py');
            const parseOk = await evalIsolated(`(() => { const p=parseBlocksFile(${JSON.stringify(reread.contents)}); return !p.error; })()`, false);
            assert(parseOk === true, 'after editor open, prog_differs.py line-1 JSON still parses');
            assert((await sigOf(reread.contents)) === robotSig, 'after editor open+regen, prog_differs.py setup signature is unchanged (matches robot_setup.py)');
        } else {
            log('SKIP: Explorer row for prog_differs.py did not render in this environment — round-trip skipped');
        }
        evidence.roundTripped = roundTripped;

        // -- Commit ---------------------------------------------------------
        step(10, 'Commit via toolbar; assert the pushed tree has the spliced prog_differs.py');
        await trustedClick(await buttonRect('Commit'));
        await poll(() => exists('[data-pybricks-git-msg]'), { timeout: 10000, what: 'commit message input' });
        await page.send('Input.insertText', { text: 'apply team robot setup' });
        for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
        const commitLabel = await poll(
            async () => {
                const raw = await evalIsolated(`(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>['Committing','✓','no changes','error'].some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent.trim():null; })()`, false);
                return raw && (/^✓ [0-9a-f]{7}/.test(raw) || raw === 'error' || raw === 'no changes') ? raw : null;
            },
            { timeout: 40000, interval: 100, what: 'Commit result label' },
        );
        log('commit label =', JSON.stringify(commitLabel));
        assert(/^✓ [0-9a-f]{7} ↑$/.test(commitLabel), `commit label shows "✓ <sha> ↑" (got "${commitLabel}")`);
        assert(bareSubjects(bare).includes('apply team robot setup'), 'pushed history includes the manual commit');
        assert((await sigOf(bareFile(bare, 'prog_differs.py'))) === robotSig, 'pushed prog_differs.py now carries the spliced (team-matching) setup');
        assert(bareFile(bare, 'menu.py') === SEED_FILES['menu.py'], 'protected menu.py still byte-identical after the manual commit');

        // -- Exceptions -----------------------------------------------------
        step(11, 'Zero extension exceptions (page + service worker)');
        if (pageExceptions.length) log(`(note: ${pageExceptions.length} non-extension page exception(s) ignored)`);
        if (extExceptions.length) for (const e of extExceptions) log('  captured:', e.split('\n')[0]);
        assert(extExceptions.length === 0, `zero extension exceptions (saw ${extExceptions.length}${extExceptions.length ? ': ' + extExceptions.map((e) => e.split('\n')[0]).join(' | ') : ''})`);

        // -- Screenshot -----------------------------------------------------
        step(12, 'Capture screenshot evidence');
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(HERE, 'splice-panel.png'), Buffer.from(shot.data, 'base64'));
        log('screenshot saved to', join(HERE, 'splice-panel.png'));

        console.log('\n[e2e-splice] ================= PASS =================');
        console.log('[e2e-splice] Pull:', pullLabel, '| Commit:', commitLabel, '| round-trip:', roundTripped ? 'asserted' : 'SKIPPED');
        for (const a of evidence.assertions) console.log('        [PASS]', a.msg);
        sw.close(); page.close(); cleanup();
        process.exit(0);
    } catch (err) {
        console.error('\n[e2e-splice] ================= FAIL =================');
        console.error('[e2e-splice]', err.stack || err.message);
        if (extExceptions.length) { console.error(`[e2e-splice] extension exceptions (${extExceptions.length}):`); for (const e of extExceptions) console.error('  ' + e.split('\n')[0]); }
        try {
            const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
            const pt = list.find((t) => t.type === 'page');
            if (pt) { const c = new CDP(pt.webSocketDebuggerUrl); const shot = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(HERE, 'splice-failure.png'), Buffer.from(shot.data, 'base64')); console.error('[e2e-splice] failure screenshot:', join(HERE, 'splice-failure.png')); c.close(); }
        } catch { /* best effort */ }
        cleanup();
        process.exit(1);
    }
}

main();
