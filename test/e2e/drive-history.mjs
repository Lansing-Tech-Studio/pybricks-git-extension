// Browser end-to-end driver for the HISTORY panel (phase 5).
//
// Self-contained sibling of drive-menu.mjs: starts the in-repo git HTTP
// harness with a three-commit repo, launches Playwright's Chromium with the
// unpacked extension, and drives Pull → open History → "Compared to now"
// (unchanged, then a live edit picked up on click) → "This commit's changes"
// → ◀ Older stepping → Restore this version (two-click, no reload, protected
// file offers no Restore) → Commit (the list grows) on
// https://code.pybricks.com over raw CDP. Asserts on the panel DOM, the editor
// IndexedDB and the git-server side.
//
// Run:  node test/e2e/drive-history.mjs
// Exit: 0 = PASS, non-zero = FAIL (reason printed).
//       history-panel.png on success, history-failure.png on failure.
//
// The CDP client, Chromium discovery, LNA-disable launch flags, trusted-input
// helpers, isolated-world tracking, exception capture and Welcome-Tour
// dismissal are copied from drive-menu.mjs / drive.mjs (deliberately
// self-contained). The history scenario is original to this file.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startGitServer, makeBareRepo, pushCompeting, bareSubjects, bareHead } from '../git-http-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 600);
const PYBRICKS_URL = 'https://code.pybricks.com';

const log = (...a) => console.log('[e2e-history]', ...a);
const step = (n, m) => console.log(`\n[e2e-history] === STEP ${n}: ${m} ===`);

// Three commits, oldest first: seed (a v1, coach), second (a v2, +b), third (a v3).
const SEED_FILES = {
    '.pybricks-git.json': '{"schemaVersion":1,"protected":["coach.py"]}\n',
    'a.py': 'print("a v1")\n',
    'coach.py': '# coach framework\n',
};

function findChromium() {
    const glob = join(process.env.HOME, '.cache/ms-playwright');
    let best = null;
    for (const d of readdirSync(glob)) {
        if (!/^chromium-\d+$/.test(d)) continue;
        const bin = ['chrome-linux64/chrome', 'chrome-linux/chrome'].map((sub) => join(glob, d, sub)).find((p) => existsSync(p));
        if (!bin) continue;
        const rev = parseInt(d.split('-')[1], 10);
        if (!best || rev > best.rev) best = { rev, bin };
    }
    if (!best) throw new Error('Playwright Chromium not found under ~/.cache/ms-playwright. Install with: npx playwright install chromium');
    return best.bin;
}

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
    onEvent(cb) {
        this.listeners.push(cb);
    }
    async send(method, params = {}) {
        await this.ready;
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    close() {
        try {
            this.ws.close();
        } catch {
            /* ignore */
        }
    }
}

async function fetchJSON(url, tries = 60) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) return await r.json();
        } catch {
            /* not up yet */
        }
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
    const scratch = mkdtempSync(join(tmpdir(), 'pbgit-e2e-history-'));
    const profile = join(scratch, 'profile');
    let server = null;
    let chrome = null;
    const cleanup = () => {
        if (chrome && !chrome.killed) {
            try {
                chrome.kill('SIGKILL');
            } catch {
                /* ignore */
            }
        }
        if (server) server.close().catch(() => {});
        try {
            rmSync(scratch, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    };

    const evidence = { assertions: [] };
    const extExceptions = [];
    const pageExceptions = [];
    const exceptionSummary = (det = {}) => (det.exception && det.exception.description) || det.text || 'exception';
    const assert = (cond, msg) => {
        evidence.assertions.push({ ok: !!cond, msg });
        if (cond) log('PASS:', msg);
        else log('FAIL:', msg);
        if (!cond) throw new Error('assertion failed: ' + msg);
    };

    try {
        step(1, 'Start git harness with a three-commit repo');
        const bare = makeBareRepo(scratch, 'team', SEED_FILES);
        pushCompeting(bare, { 'a.py': 'print("a v2")\n', 'b.py': 'print("b")\n' }, 'second');
        pushCompeting(bare, { 'a.py': 'print("a v3")\n' }, 'third');
        const subjects = bareSubjects(bare);
        log('seeded subjects (newest first):', subjects);
        server = await startGitServer(scratch);
        const repoUrl = `${server.url}/team.git`;

        step(1, 'Launch Chromium with the extension loaded');
        const bin = findChromium();
        chrome = spawn(
            bin,
            [
                '--headless=new',
                '--disable-gpu',
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1400,1000',
                '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults',
                `--user-data-dir=${profile}`,
                `--load-extension=${REPO_ROOT}`,
                `--remote-debugging-port=${DEBUG_PORT}`,
                PYBRICKS_URL,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        chrome.stderr.on('data', (d) => {
            const s = d.toString();
            if (/error|fail/i.test(s)) process.stderr.write('[chrome] ' + s);
        });

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
        const check = await evalSw(`chrome.storage.local.get('settings')`);
        assert(check.settings.repoUrl === repoUrl, 'settings written to chrome.storage.local via SW');

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
                const isExt =
                    /chrome-extension:\/\//.test(text) ||
                    /content\.js|inject\.js|background\.js|menu-panel\.js|menu-config\.js|file-list\.js|history-panel\.js|floating-panel\.js|diff\.js/.test(text);
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
        const buttonRect = (labelPrefix) =>
            evalIsolated(
                `(() => {
                  const b = [...document.querySelectorAll('button[data-pybricks-git]')].find(x => x.textContent.trim().startsWith(${JSON.stringify(labelPrefix)}));
                  if (!b) return null;
                  const r = b.getBoundingClientRect();
                  return { x: r.left + r.width/2, y: r.top + r.height/2, label: b.textContent };
                })()`,
                false,
            );
        const rectOf = (selector) =>
            evalIsolated(
                `(() => {
                  const e = document.querySelector(${JSON.stringify(selector)});
                  if (!e) return null;
                  e.scrollIntoView({ block: 'center' });
                  const r = e.getBoundingClientRect();
                  return { x: r.left + r.width/2, y: r.top + r.height/2 };
                })()`,
                false,
            );
        const count = (selector) => evalIsolated(`document.querySelectorAll(${JSON.stringify(selector)}).length`, false);
        const exists = (selector) => evalIsolated(`!!document.querySelector(${JSON.stringify(selector)})`, false);
        const textOf = (selector) =>
            evalIsolated(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? e.textContent : null; })()`, false);
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
        const key = async (k, code) => {
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: k, code: k });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: k, code: k });
        };

        step(3, 'Wait for toolbar buttons + Pybricks IndexedDB');
        await poll(
            async () => (await buttonRect('Pull')) && (await buttonRect('Commit')) && (await exists('[data-pybricks-git-history-btn]')),
            { timeout: 40000, what: 'Pybricks Git toolbar buttons (incl. History)' },
        );
        await poll(
            async () => {
                try {
                    await evalIsolated(`pageRequest('list-files')`);
                    return true;
                } catch {
                    return false;
                }
            },
            { timeout: 40000, what: 'Pybricks IndexedDB ready' },
        );
        log('toolbar mounted, IndexedDB ready');

        step(3, 'Dismiss the Pybricks Welcome Tour if present');
        const tourOverlayGone = () => evalIsolated(`!document.querySelector('.react-joyride__overlay')`, false);
        const tourDismissRect = () =>
            evalIsolated(
                `(() => {
                  const b = document.querySelector('#react-joyride-portal button[data-action="skip"], #react-joyride-portal button[data-action="close"], .react-joyride__tooltip button[data-action="skip"], .react-joyride__tooltip button[data-action="close"]');
                  if (!b) return null;
                  const r = b.getBoundingClientRect();
                  return { x: r.left + r.width/2, y: r.top + r.height/2, action: b.getAttribute('data-action') };
                })()`,
                false,
            );
        if (!(await tourOverlayGone())) {
            await poll(
                async () => {
                    if (await tourOverlayGone()) return true;
                    const r = await tourDismissRect();
                    if (r) await trustedClick(r);
                    else await key('Escape', 27);
                    return false;
                },
                { timeout: 15000, interval: 500, what: 'Welcome Tour to dismiss' },
            );
            log('welcome tour dismissed');
        }

        step(4, 'Pull the repo');
        await evalIsolated(`window.__pbgitNoReload = 1`, false);
        const ctxAtStart = isolatedCtx;
        await trustedClick(await buttonRect('Pull'));
        const pullLabel = await poll(
            async () => {
                const l = await evalIsolated(
                    `(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>['Pull','Pulling','↓','error','setup','nothing'].some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent:null; })()`,
                    false,
                );
                return l && /^(↓|error|setup|nothing)/.test(l) ? l : null;
            },
            { timeout: 30000, interval: 100, what: 'Pull result label' },
        );
        assert(pullLabel === '↓ +3 ~0 -0', `Pull label is "↓ +3 ~0 -0" (got "${pullLabel}")`);
        await sleep(2500);
        assert(isolatedCtx === ctxAtStart, 'the page did not reload after Pull');

        step(5, 'Open History: three commits, "Compared to now" shows nothing changed');
        await clickSelector('[data-pybricks-git-history-btn]', 'History toolbar button');
        await poll(() => exists('[data-pybricks-git-history-panel]'), { timeout: 15000, what: 'history panel to open' });
        const rows = await poll(async () => ((await count('[data-pybricks-git-history-commit]')) === 3 ? 3 : null), {
            timeout: 20000,
            what: 'three commit rows',
        });
        assert(rows === 3, 'history lists 3 commits');
        const rowSubjects = await evalIsolated(
            `[...document.querySelectorAll('[data-pybricks-git-history-commit]')].map(r => r.firstChild.textContent)`,
            false,
        );
        assert(JSON.stringify(rowSubjects) === JSON.stringify(subjects), `rows read ${JSON.stringify(rowSubjects)} (newest first, matches git log)`);
        const oids = await evalIsolated(
            `[...document.querySelectorAll('[data-pybricks-git-history-commit]')].map(r => r.dataset.pybricksGitHistoryCommit)`,
            false,
        );
        assert(oids[0] === bareHead(bare), 'the first row is the branch tip');
        const [tipOid, secondOid, seedOid] = oids;
        assert((await evalIsolated(`document.querySelector('[data-pybricks-git-history-mode]').value`, false)) === 'now', 'default mode is "Compared to now"');
        const heading0 = await poll(() => textOf('[data-pybricks-git-history-heading]'), { timeout: 15000, what: 'diff heading' });
        assert(/compared to now/.test(heading0), `heading reads "${heading0}"`);
        await poll(() => exists('[data-pybricks-git-history-unchanged]'), { timeout: 15000, what: 'unchanged-files line' });
        assert((await textOf('[data-pybricks-git-history-unchanged] summary')) === '3 unchanged files', 'three files are reported unchanged');
        assert((await count('[data-pybricks-git-history-file]')) === 0, 'no changed-file sections right after a Pull');

        step(6, 'Edit a.py and coach.py locally; a click inside the panel picks the edits up');
        await evalIsolated(
            `pageRequest('upsert-files', { files: [
                { path: 'a.py', contents: 'print("a v3")\\nprint("edited")\\n' },
                { path: 'coach.py', contents: '# coach framework\\n# kid edit\\n' },
            ] })`,
        );
        await clickSelector('[data-pybricks-git-history-heading]', 'diff heading (freshness click)');
        await poll(() => exists('[data-pybricks-git-history-file="a.py"]'), { timeout: 15000, what: 'a.py section after the edit' });
        const addLines = await evalIsolated(
            `[...document.querySelectorAll('[data-pybricks-git-history-file="a.py"] [data-pybricks-git-history-line="add"]')].map(l => l.textContent)`,
            false,
        );
        assert(addLines.length === 1 && /print\("edited"\)/.test(addLines[0]), `a.py shows one added line: ${JSON.stringify(addLines)}`);
        assert(await exists('[data-pybricks-git-history-file="a.py"] [data-pybricks-git-history-restore="a.py"]'), 'a.py offers "Restore this version"');
        assert(await exists('[data-pybricks-git-history-file="coach.py"]'), 'coach.py section appears (edited locally)');
        assert(!(await exists('[data-pybricks-git-history-restore="coach.py"]')), 'protected coach.py offers NO Restore button');
        assert((await textOf('[data-pybricks-git-history-unchanged] summary')) === '1 unchanged file', 'b.py is the one unchanged file');

        step(7, '"This commit\'s changes" on the tip, then ◀ Older twice');
        await evalIsolated(
            `(() => { const s = document.querySelector('[data-pybricks-git-history-mode]'); s.value = 'commit'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
            false,
        );
        const headingTip = await poll(
            async () => {
                const t = await textOf('[data-pybricks-git-history-heading]');
                return t && t.startsWith('Changes in') ? t : null;
            },
            { timeout: 15000, what: 'commit-mode heading' },
        );
        assert(headingTip === `Changes in ${tipOid.slice(0, 7)}`, `heading reads "${headingTip}"`);
        await poll(() => exists('[data-pybricks-git-history-file="a.py"]'), { timeout: 15000, what: 'a.py section in commit mode' });
        const tipLines = await evalIsolated(
            `[...document.querySelectorAll('[data-pybricks-git-history-file="a.py"] [data-pybricks-git-history-line]')].map(l => l.dataset.pybricksGitHistoryLine + ':' + l.lastChild.textContent)`,
            false,
        );
        assert(
            JSON.stringify(tipLines) === JSON.stringify(['del:print("a v2")', 'add:print("a v3")']),
            `third commit diff of a.py is v2→v3: ${JSON.stringify(tipLines)}`,
        );
        assert(!(await exists('[data-pybricks-git-history-file="b.py"]')), 'b.py (added one commit earlier) is not in the tip\'s diff');

        await clickSelector('[data-pybricks-git-history-older]', '◀ Older');
        await poll(async () => (await textOf('[data-pybricks-git-history-heading]')) === `Changes in ${secondOid.slice(0, 7)}`, {
            timeout: 15000,
            what: 'heading for the second commit',
        });
        await poll(() => exists('[data-pybricks-git-history-file="b.py"]'), { timeout: 15000, what: 'b.py section for the second commit' });
        const secondStatuses = await evalIsolated(
            `[...document.querySelectorAll('[data-pybricks-git-history-file]')].map(d => d.dataset.pybricksGitHistoryFile + ':' + d.querySelector('summary span').textContent)`,
            false,
        );
        assert(JSON.stringify(secondStatuses) === JSON.stringify(['a.py:modified', 'b.py:added']), `second commit: ${JSON.stringify(secondStatuses)}`);

        await clickSelector('[data-pybricks-git-history-older]', '◀ Older (to the root)');
        const rootHeading = await poll(
            async () => {
                const t = await textOf('[data-pybricks-git-history-heading]');
                return t && t.startsWith('First commit') ? t : null;
            },
            { timeout: 15000, what: 'root-commit heading' },
        );
        assert(rootHeading.includes(seedOid.slice(0, 7)), `root heading reads "${rootHeading}"`);
        const olderDisabled = await evalIsolated(`document.querySelector('[data-pybricks-git-history-older]').disabled`, false);
        assert(olderDisabled === true, '◀ Older is disabled on the oldest commit');
        assert(!(await exists('[data-pybricks-git-history-more]:not([style*="display: none"])')), 'no "Load older" when hasMore is false');

        step(8, 'Whole-file toggle shows unchanged lines too');
        await clickSelector('[data-pybricks-git-history-newer]', 'Newer ▶');
        await poll(async () => (await textOf('[data-pybricks-git-history-heading]')) === `Changes in ${secondOid.slice(0, 7)}`, {
            timeout: 15000,
            what: 'back on the second commit',
        });
        await clickSelector('[data-pybricks-git-history-wholefile]', 'Whole file checkbox');
        const wholeOk = await poll(
            async () => {
                const kinds = await evalIsolated(
                    `[...document.querySelectorAll('[data-pybricks-git-history-file="b.py"] [data-pybricks-git-history-line]')].map(l => l.dataset.pybricksGitHistoryLine)`,
                    false,
                );
                return kinds.length === 1 && kinds[0] === 'add' ? true : null;
            },
            { timeout: 10000, what: 'whole-file render' },
        );
        assert(wholeOk, 'whole-file view renders b.py as one added line (no hunk header)');
        const persisted = (await evalSw(`chrome.storage.local.get('historyPanel')`)).historyPanel;
        assert(persisted && persisted.wholeFile === true && persisted.open === true, `historyPanel key persisted wholeFile: ${JSON.stringify(persisted)}`);
        await clickSelector('[data-pybricks-git-history-wholefile]', 'Whole file checkbox (off)');

        step(9, 'Restore a.py from the second commit: two clicks, no reload');
        await evalIsolated(
            `(() => { const s = document.querySelector('[data-pybricks-git-history-mode]'); s.value = 'now'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
            false,
        );
        await poll(async () => /compared to now/.test((await textOf('[data-pybricks-git-history-heading]')) || ''), { timeout: 15000, what: 'now-mode heading' });
        await poll(() => exists('[data-pybricks-git-history-restore="a.py"]'), { timeout: 15000, what: 'Restore button for a.py' });
        await clickSelector('[data-pybricks-git-history-restore="a.py"]', 'Restore (first click)');
        const armed = await poll(async () => ((await textOf('[data-pybricks-git-history-restore="a.py"]')) === 'Replace current file?' ? true : null), {
            timeout: 5000,
            what: 'Restore to arm',
        });
        assert(armed, 'first click arms the button: "Replace current file?"');
        const editorBefore = (await evalIsolated(`pageRequest('list-files')`)).contents.find((c) => c.path === 'a.py').contents;
        assert(editorBefore === 'print("a v3")\nprint("edited")\n', 'a.py is still the edited copy before the second click');
        const ctxBeforeRestore = isolatedCtx;
        await clickSelector('[data-pybricks-git-history-restore="a.py"]', 'Restore (second click)');
        const status = await poll(
            async () => {
                const t = await textOf('[data-pybricks-git-history-status]');
                return t && /^(Restored|Couldn't)/.test(t) ? t : null;
            },
            { timeout: 15000, interval: 100, what: 'restore status' },
        );
        assert(status === 'Restored a.py', `status reads "${status}"`);
        const editorAfter = await poll(
            async () => {
                const c = (await evalIsolated(`pageRequest('list-files')`)).contents.find((x) => x.path === 'a.py').contents;
                return c === 'print("a v2")\n' ? c : null;
            },
            { timeout: 10000, what: 'editor a.py to hold the second commit\'s version' },
        );
        assert(editorAfter === 'print("a v2")\n', 'editor a.py now holds the restored version');
        await sleep(1500);
        assert(isolatedCtx === ctxBeforeRestore && (await evalIsolated(`window.__pbgitNoReload === 1`, false)), 'the page did not reload after Restore');
        await poll(async () => !(await exists('[data-pybricks-git-history-file="a.py"]')), { timeout: 10000, what: 'a.py to drop out of the diff' });
        assert(true, 'a.py drops out of "Compared to now" once restored');
        const coachAfter = (await evalIsolated(`pageRequest('list-files')`)).contents.find((c) => c.path === 'coach.py').contents;
        assert(coachAfter === '# coach framework\n# kid edit\n', 'coach.py was untouched by the restore');

        step(10, 'Commit: the history list gains the new commit');
        await trustedClick(await buttonRect('Commit'));
        await poll(() => exists('input[data-pybricks-git-msg]'), { timeout: 10000, what: 'commit message input' }).catch(() => null);
        await page.send('Input.insertText', { text: 'restored a.py' });
        await key('Enter', 13);
        const commitLabel = await poll(
            async () => {
                const l = await evalIsolated(
                    `(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>['Commit','Committing','✓','error','no changes','setup'].some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent:null; })()`,
                    false,
                );
                return l && /^(✓|error|no changes|setup)/.test(l) ? l : null;
            },
            { timeout: 30000, interval: 100, what: 'Commit result label' },
        );
        assert(/^✓ [0-9a-f]{7} ↑$/.test(commitLabel), `Commit label is "✓ <sha> ↑" (got "${commitLabel}")`);
        const rows4 = await poll(async () => ((await count('[data-pybricks-git-history-commit]')) === 4 ? 4 : null), {
            timeout: 20000,
            what: 'history to refresh to 4 rows',
        });
        assert(rows4 === 4, 'history refreshed itself after the Commit');
        assert(bareSubjects(bare)[0] === 'restored a.py', 'the commit reached the git server');

        step(11, 'Zero extension exceptions (page + service worker)');
        if (extExceptions.length) for (const e of extExceptions) log('  captured:', e.split('\n')[0]);
        assert(extExceptions.length === 0, `zero extension exceptions (saw ${extExceptions.length})`);

        step(12, 'Capture screenshot evidence');
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const shotPath = join(HERE, 'history-panel.png');
        writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
        log('screenshot saved to', shotPath);

        console.log('\n[e2e-history] ================= PASS =================');
        for (const a of evidence.assertions) console.log('        [PASS]', a.msg);
        sw.close();
        page.close();
        cleanup();
        process.exit(0);
    } catch (err) {
        console.error('\n[e2e-history] ================= FAIL =================');
        console.error('[e2e-history]', err.stack || err.message);
        if (extExceptions.length) for (const e of extExceptions) console.error('[e2e-history]   ' + e.split('\n')[0]);
        try {
            const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
            const pt = list.find((t) => t.type === 'page');
            if (pt) {
                const c = new CDP(pt.webSocketDebuggerUrl);
                const shot = await c.send('Page.captureScreenshot', { format: 'png' });
                const p = join(HERE, 'history-failure.png');
                writeFileSync(p, Buffer.from(shot.data, 'base64'));
                console.error('[e2e-history] failure screenshot:', p);
                c.close();
            }
        } catch {
            /* best effort */
        }
        cleanup();
        process.exit(1);
    }
}

main();
