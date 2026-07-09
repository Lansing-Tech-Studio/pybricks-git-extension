// Browser end-to-end driver for the phase-3 MENU MANAGER round-trip.
//
// Self-contained sibling of drive.mjs: starts the in-repo git HTTP harness
// (Task 2), launches Playwright's Chromium with the unpacked extension, and
// drives the real Pull → open Menu panel → add a program slot → Save (rewrites
// menu_config.py via upsert-files) → Commit flow on https://code.pybricks.com
// over raw CDP (Node 22's built-in WebSocket, no npm deps). Asserts on the
// browser side (panel DOM, slot counts, add buttons), the editor IndexedDB
// (regenerated menu_config.py), the SW storage (lastPullManifest), and the
// git-server side (pushed menu_config.py + untouched protected menu.py).
//
// Run:  node test/e2e/drive-menu.mjs
// Exit: 0 = PASS, non-zero = FAIL/BLOCKED (reason printed).
//       menu-panel.png on success, menu-failure.png on failure (this dir).
//
// The CDP client, Chromium discovery, LNA-disable launch flags, trusted-input
// helpers, isolated-world tracking, exception capture, and Welcome-Tour
// dismissal are all copied from test/e2e/drive.mjs (deliberately a
// self-contained script) — the same hard-won environment facts apply here.
// Menu-manager-specific scenario logic is original to this file.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    startGitServer,
    makeBareRepo,
    bareSubjects,
    bareFile,
} from '../git-http-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
// Random port so a leftover Chromium from a crashed run can't collide.
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 600);
const PYBRICKS_URL = 'https://code.pybricks.com';

const log = (...a) => console.log('[e2e-menu]', ...a);
const step = (n, m) => console.log(`\n[e2e-menu] === STEP ${n}: ${m} ===`);

// ---- Seed files for the bare repo (the phase-3 template shape) --------------
// arm_moves.py is a SETUP-ONLY blocks file: line-1 sentinel + imports + a
// module-level assignment + one `def lift_arm()`. analyzeProgram() must read it
// as { module:'arm_moves', isBlocks:true, setupOnly:true, methods:['lift_arm'] }
// so the panel offers a `[data-pybricks-git-add="arm_moves.lift_arm"]` button.
const ARM_MOVES = [
    '# pybricks blocks file:{"blocks":[]}',
    'from pybricks.pupdevices import Motor',
    'from pybricks.parameters import Port',
    '',
    'left_motor = Motor(Port.A)',
    '',
    '',
    'def lift_arm():',
    '    left_motor.run_angle(500, 90)',
    '',
].join('\n');

const MENU_CONFIG_SEED = [
    '"""The hub menu (seed)."""',
    '',
    'MENU_ITEMS = [',
    '    {"display": 1, "module": "mission_01", "function": "run"},',
    ']',
    '',
].join('\n');

const SEED_FILES = {
    '.pybricks-git.json':
        '{"schemaVersion":1,"menuConfig":"menu_config.py","protected":["menu.py"]}\n',
    'menu.py': '# framework\n',
    'menu_config.py': MENU_CONFIG_SEED,
    'mission_01.py': 'def run(robot):\n    pass\n',
    'arm_moves.py': ARM_MOVES,
};

function findChromium() {
    // Copied from drive.mjs — only the full `chromium-<rev>` build honors
    // --load-extension; headless_shell + metadata-only dirs are skipped.
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
            this.ws.addEventListener('error', (e) =>
                rej(new Error('CDP websocket error: ' + (e.message || e.type))),
            );
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
        if (Date.now() - start > timeout) {
            throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
        }
        await sleep(interval);
    }
}

async function main() {
    const scratch = mkdtempSync(join(tmpdir(), 'pbgit-e2e-menu-'));
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
    // Extension exceptions from BOTH targets (tagged "page:"/"sw:") — same
    // zero-exceptions gate as drive.mjs, covering the SW git engine too.
    const extExceptions = [];
    const pageExceptions = [];
    const exceptionSummary = (det = {}) =>
        (det.exception && det.exception.description) || det.text || 'exception';
    const assert = (cond, msg) => {
        evidence.assertions.push({ ok: !!cond, msg });
        if (cond) log('PASS:', msg);
        else log('FAIL:', msg);
        if (!cond) throw new Error('assertion failed: ' + msg);
    };

    try {
        // -- Harness: seed a bare repo and serve it -------------------------
        step(1, 'Start git harness with a seeded phase-3 template repo');
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

        // -- Discover the service_worker target and write settings ----------
        step(2, 'Configure settings via the service_worker target');
        await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`);

        const swTarget = await poll(
            async () => {
                const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
                return list.find(
                    (t) =>
                        t.type === 'service_worker' &&
                        t.url.endsWith('src/background.js'),
                );
            },
            { timeout: 30000, what: 'extension service_worker target' },
        );
        log('service worker target:', swTarget.url);

        const sw = new CDP(swTarget.webSocketDebuggerUrl);
        sw.onEvent((method, params) => {
            if (method === 'Runtime.exceptionThrown') {
                const summary = exceptionSummary(params.exceptionDetails);
                extExceptions.push('sw: ' + summary);
                log('EXTENSION EXCEPTION (sw):', summary.split('\n')[0]);
            }
        });
        await sw.send('Runtime.enable');
        // Evaluate an expression in the service worker (returns the value).
        const evalSw = async (expression) => {
            const r = await sw.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
            });
            if (r.exceptionDetails) {
                throw new Error(
                    'sw eval threw: ' +
                        (r.exceptionDetails.exception?.description ||
                            r.exceptionDetails.text),
                );
            }
            return r.result.value;
        };
        const settings = {
            repoUrl,
            branch: 'main',
            token: 'test',
            name: 'E2E Team',
            email: 'e2e@example.com',
        };
        await evalSw(
            `chrome.storage.local.set({settings:${JSON.stringify(settings)}})`,
        );
        const check = await evalSw(`chrome.storage.local.get('settings')`);
        assert(
            check.settings.repoUrl === repoUrl,
            'settings written to chrome.storage.local via SW',
        );

        // -- Attach to the page and track the isolated world (copied) -------
        const pageTarget = await poll(
            async () => {
                const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
                return list.find(
                    (t) => t.type === 'page' && t.url.startsWith(PYBRICKS_URL),
                );
            },
            { timeout: 30000, what: 'code.pybricks.com page target' },
        );
        const page = new CDP(pageTarget.webSocketDebuggerUrl);

        let isolatedCtx = null;
        page.onEvent((method, params) => {
            if (method === 'Runtime.executionContextCreated') {
                const c = params.context;
                if (
                    c.auxData &&
                    c.auxData.type === 'isolated' &&
                    /Pybricks Git/.test(c.name || '')
                ) {
                    isolatedCtx = c.id;
                    log('isolated world context id =', c.id);
                }
            } else if (method === 'Runtime.executionContextsCleared') {
                isolatedCtx = null;
            } else if (method === 'Runtime.exceptionThrown') {
                const det = params.exceptionDetails || {};
                const frames =
                    (det.stackTrace && det.stackTrace.callFrames) || [];
                const text =
                    JSON.stringify(det.url || '') +
                    JSON.stringify(frames.map((f) => f.url));
                const isExt =
                    /chrome-extension:\/\//.test(text) ||
                    /content\.js|inject\.js|background\.js|menu-panel\.js|menu-config\.js|file-list\.js/.test(
                        text,
                    );
                const summary = exceptionSummary(det);
                (isExt ? extExceptions : pageExceptions).push(
                    (isExt ? 'page: ' : '') + summary,
                );
                if (isExt) log('EXTENSION EXCEPTION (page):', summary.split('\n')[0]);
            }
        });
        await page.send('Page.enable');
        await page.send('Runtime.enable');

        const evalIsolated = async (expression, awaitPromise = true) => {
            const ctx = await poll(() => isolatedCtx, {
                timeout: 40000,
                what: 'isolated world context',
            });
            const r = await page.send('Runtime.evaluate', {
                expression,
                contextId: ctx,
                awaitPromise,
                returnByValue: true,
                userGesture: true,
            });
            if (r.exceptionDetails) {
                throw new Error(
                    'isolated eval threw: ' +
                        (r.exceptionDetails.exception?.description ||
                            r.exceptionDetails.text),
                );
            }
            return r.result.value;
        };

        // Toolbar button center by label prefix (copied from drive.mjs).
        const buttonRect = (labelPrefix) =>
            evalIsolated(
                `(() => {
                  const b = [...document.querySelectorAll('button[data-pybricks-git]')]
                    .find(x => x.textContent.trim().startsWith(${JSON.stringify(
                        labelPrefix,
                    )}));
                  if (!b) return null;
                  const r = b.getBoundingClientRect();
                  return { x: r.left + r.width/2, y: r.top + r.height/2, label: b.textContent };
                })()`,
                false,
            );

        // Center point of an arbitrary selector (scrollIntoView first so panel
        // buttons below the fold still get valid viewport coordinates).
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
        const count = (selector) =>
            evalIsolated(
                `document.querySelectorAll(${JSON.stringify(selector)}).length`,
                false,
            );
        const exists = (selector) =>
            evalIsolated(
                `!!document.querySelector(${JSON.stringify(selector)})`,
                false,
            );

        // Trusted CDP click (copied from drive.mjs).
        const trustedClick = async (pt) => {
            await page.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: pt.x,
                y: pt.y,
                buttons: 0,
            });
            await page.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: pt.x,
                y: pt.y,
                button: 'left',
                buttons: 1,
                clickCount: 1,
            });
            await sleep(30);
            await page.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: pt.x,
                y: pt.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
        };
        const clickSelector = async (selector, what = selector) => {
            const pt = await poll(() => rectOf(selector), {
                timeout: 15000,
                what: `${what} to be clickable`,
            });
            await trustedClick(pt);
            return pt;
        };

        // -- Wait for the toolbar and IndexedDB -----------------------------
        step(3, 'Wait for toolbar buttons + Pybricks IndexedDB');
        await poll(
            async () =>
                (await buttonRect('Pull')) &&
                (await buttonRect('Commit')) &&
                (await exists('[data-pybricks-git-menu-btn]')),
            { timeout: 40000, what: 'Pybricks Git toolbar buttons (incl. Menu)' },
        );
        log('buttons mounted (Commit / Pull / Menu)');
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
        log('pybricks IndexedDB ready');

        // -- Dismiss the Welcome Tour (copied from drive.mjs) ---------------
        step(3, 'Dismiss the Pybricks Welcome Tour if present');
        const tourOverlayGone = () =>
            evalIsolated(`!document.querySelector('.react-joyride__overlay')`, false);
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
                    if (r) {
                        log('clicking tour dismiss:', r.action, `(${r.x},${r.y})`);
                        await trustedClick(r);
                    } else {
                        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
                        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
                    }
                    return false;
                },
                { timeout: 15000, interval: 500, what: 'Welcome Tour to dismiss' },
            );
            log('welcome tour dismissed');
        } else {
            log('no welcome tour overlay present');
        }

        // -- Pull -----------------------------------------------------------
        step(3, 'Pull the template repo, then wait for the reload');
        const pullPt = await buttonRect('Pull');
        await trustedClick(pullPt);
        const rawPull = () =>
            evalIsolated(
                `(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>['Pull','Pulling','↓','error','setup','nothing'].some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent:null; })()`,
                false,
            );
        const pullLabel = await poll(
            async () => {
                const l = await rawPull();
                return l && /^(↓|error|setup|nothing)/.test(l) ? l : null;
            },
            { timeout: 30000, interval: 100, what: 'Pull result label' },
        );
        log('pull label =', JSON.stringify(pullLabel));
        // Four .py files pulled (menu.py, menu_config.py, mission_01.py,
        // arm_moves.py); .pybricks-git.json is non-.py so it is not applied.
        assert(
            pullLabel === '↓ +4 ~0 -0',
            `Pull label is "↓ +4 ~0 -0" (got "${pullLabel}")`,
        );

        log('waiting for post-Pull reload...');
        await poll(() => isolatedCtx === null, {
            timeout: 15000,
            what: 'reload to clear isolated context',
        }).catch(() => log('note: did not observe context clear (may have raced)'));
        await poll(async () => (await buttonRect('Pull')) != null, {
            timeout: 40000,
            what: 'buttons to remount after reload',
        });
        log('page reloaded, buttons remounted');

        // -- Assert the persisted manifest (SW storage) ---------------------
        step(4, 'Assert lastPullManifest persisted by the engine');
        const manifest = (await evalSw(`chrome.storage.local.get('lastPullManifest')`))
            .lastPullManifest;
        log('lastPullManifest =', JSON.stringify(manifest));
        assert(
            manifest &&
                JSON.stringify(manifest.protected) === JSON.stringify(['menu.py']) &&
                manifest.menuConfig === 'menu_config.py',
            'lastPullManifest === {protected:[menu.py], menuConfig:menu_config.py}',
        );

        // -- Open the Menu panel --------------------------------------------
        step(5, 'Open the Menu panel; assert 1 seed slot + program add buttons');
        await clickSelector('[data-pybricks-git-menu-btn]', 'Menu toolbar button');
        await poll(() => exists('[data-pybricks-git-panel]'), {
            timeout: 15000,
            what: 'menu panel to open',
        });
        assert(await exists('[data-pybricks-git-panel]'), 'menu panel mounted');
        const slotCount0 = await poll(
            async () => ((await count('[data-pybricks-git-slot]')) === 1 ? 1 : null),
            { timeout: 10000, what: 'panel to render the 1 seed slot' },
        );
        assert(slotCount0 === 1, 'panel shows exactly 1 seed slot (mission_01.run)');
        assert(
            await exists('[data-pybricks-git-programs] [data-pybricks-git-add="arm_moves.lift_arm"]'),
            'programs list offers add button for arm_moves.lift_arm',
        );
        assert(
            !(await exists('[data-pybricks-git-add="menu.py"], [data-pybricks-git-add="menu"]')),
            'no add button for protected menu.py (excluded from programs)',
        );

        // -- Add a slot, then Save ------------------------------------------
        step(6, 'Add arm_moves.lift_arm; Save (rewrites menu_config.py) + reload');
        await clickSelector(
            '[data-pybricks-git-add="arm_moves.lift_arm"]',
            'arm_moves.lift_arm add button',
        );
        const slotCount1 = await poll(
            async () => ((await count('[data-pybricks-git-slot]')) === 2 ? 2 : null),
            { timeout: 10000, what: 'slot count to grow to 2' },
        );
        assert(slotCount1 === 2, 'adding arm_moves.lift_arm grows slots to 2');

        await clickSelector('[data-pybricks-git-save]', 'Save button');
        log('Save clicked; waiting for reload...');
        await poll(() => isolatedCtx === null, {
            timeout: 15000,
            what: 'reload to clear isolated context after Save',
        }).catch(() => log('note: did not observe context clear (may have raced)'));
        await poll(async () => (await buttonRect('Pull')) != null, {
            timeout: 40000,
            what: 'buttons to remount after Save reload',
        });
        // The persisted open flag reopens the panel on load, unattended.
        await poll(() => exists('[data-pybricks-git-panel]'), {
            timeout: 15000,
            what: 'menu panel to auto-reopen after reload',
        });
        assert(
            await exists('[data-pybricks-git-panel]'),
            'panel auto-reopened after Save reload (persisted open flag)',
        );

        // -- Verify the regenerated menu_config.py in the editor IDB --------
        step(7, 'Assert editor menu_config.py now has 2 items incl. arm_moves');
        const listing = await evalIsolated(`pageRequest('list-files')`);
        const configRow = listing.contents.find((c) => c.path === 'menu_config.py');
        assert(!!configRow, 'menu_config.py present in editor IndexedDB');
        log('menu_config.py contents:\n' + configRow.contents);
        const armLine =
            '"module": "arm_moves", "function": "lift_arm", "blocks": True';
        assert(
            configRow.contents.includes(armLine),
            `menu_config.py contains the arm_moves slot line (${armLine})`,
        );
        const parsed = await evalIsolated(
            `(() => { const p = parseMenuConfig(${JSON.stringify(
                configRow.contents,
            )}); return { error: p.error, len: p.items && p.items.length, second: p.items && p.items[1] }; })()`,
            false,
        );
        log('parsed menu_config:', JSON.stringify(parsed));
        assert(parsed.error === null, 'regenerated menu_config.py parses cleanly');
        assert(parsed.len === 2, 'menu_config.py parses to exactly 2 items');
        assert(
            parsed.second &&
                parsed.second.display === 2 &&
                parsed.second.module === 'arm_moves' &&
                parsed.second.function === 'lift_arm' &&
                parsed.second.blocks === true,
            'second item = {display:2, module:arm_moves, function:lift_arm, blocks:true}',
        );

        // -- Commit ---------------------------------------------------------
        step(8, 'Commit; assert the push landed menu_config.py, menu.py untouched');
        const commitPt = await buttonRect('Commit');
        await trustedClick(commitPt);
        await poll(() => exists('[data-pybricks-git-msg]'), {
            timeout: 10000,
            what: 'commit message input to appear',
        });
        await page.send('Input.insertText', { text: 'add arm_moves to menu' });
        await page.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            windowsVirtualKeyCode: 13,
            key: 'Enter',
            code: 'Enter',
        });
        await page.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            windowsVirtualKeyCode: 13,
            key: 'Enter',
            code: 'Enter',
        });
        const commitLabel = await poll(
            async () => {
                const raw = await evalIsolated(
                    `(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>['Committing','✓','no changes','error'].some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent.trim():null; })()`,
                    false,
                );
                if (raw && (/^✓ [0-9a-f]{7}/.test(raw) || raw === 'error' || raw === 'no changes')) {
                    return raw;
                }
                return null;
            },
            { timeout: 40000, interval: 100, what: 'Commit result label' },
        );
        log('commit label =', JSON.stringify(commitLabel));
        assert(
            /^✓ [0-9a-f]{7} ↑$/.test(commitLabel),
            `commit label shows "✓ <sha> ↑" (got "${commitLabel}")`,
        );

        const subjects = bareSubjects(bare);
        log('bare subjects:', subjects);
        assert(
            subjects.includes('add arm_moves to menu'),
            'bareSubjects includes the commit message',
        );
        const pushedConfig = bareFile(bare, 'menu_config.py');
        assert(
            pushedConfig.includes(armLine),
            'pushed menu_config.py contains the arm_moves slot line',
        );
        const pushedMenu = bareFile(bare, 'menu.py');
        assert(
            pushedMenu === SEED_FILES['menu.py'],
            'protected menu.py is byte-identical to the seed (protection held end-to-end)',
        );

        // -- File-list badge (Task 6/7) -------------------------------------
        step(9, 'Protected badge on the menu.py file-list row (SKIP if unrendered)');
        // SKIP is scoped STRICTLY to "the Explorer tree does not render in this
        // headless environment" (per the task brief). Once the tree has rows, a
        // missing badge is a real watcher regression and MUST fail the run, so
        // the assert lives OUTSIDE this try/catch.
        let badgeChecked = false;
        let treeReady = false;
        try {
            // The Explorer tree isn't mounted until its toolbar button is
            // clicked (file-list-dom.md §0). Open it, wait for the rows.
            const explorerPt = await rectOf('#pb-toolbar-explorer-button');
            if (!explorerPt) throw new Error('no #pb-toolbar-explorer-button');
            await trustedClick(explorerPt);
            treeReady = await poll(
                async () =>
                    exists('[role="tree"][aria-label="Files"] li[role="treeitem"]'),
                { timeout: 10000, what: 'Explorer file rows to render' },
            ).then(() => true, () => false);
        } catch (err) {
            log('SKIP: could not open the Explorer file list —', err.message);
        }
        if (!treeReady) {
            log('SKIP: Explorer file list did not render in this environment');
            log('      (badge path is covered by the Task 7 smoke)');
        } else {
            // The watcher badges protected rows on a 250ms-debounced
            // decorate; poll for the badge inside the menu.py row.
            const badged = await poll(
                () =>
                    evalIsolated(
                        `(() => {
                          const rows = [...document.querySelectorAll('[role="tree"][aria-label="Files"] li[role="treeitem"]')];
                          const row = rows.find(li => {
                            const lbl = li.querySelector('span.bp5-tree-node-label');
                            return lbl && lbl.textContent === 'menu.py';
                          });
                          return !!(row && row.querySelector('[data-pybricks-git-badge]'));
                        })()`,
                        false,
                    ),
                { timeout: 10000, what: 'protected badge on menu.py row' },
            ).catch(() => false);
            assert(badged, 'menu.py file-list row carries [data-pybricks-git-badge]');
            badgeChecked = true;
        }
        evidence.badgeChecked = badgeChecked;

        // -- Exceptions -----------------------------------------------------
        step(10, 'Zero extension exceptions (page + service worker)');
        if (pageExceptions.length) {
            log(`(note: ${pageExceptions.length} non-extension page exception(s) ignored)`);
        }
        if (extExceptions.length) {
            for (const e of extExceptions) log('  captured:', e.split('\n')[0]);
        }
        assert(
            extExceptions.length === 0,
            `zero extension exceptions (saw ${extExceptions.length}${
                extExceptions.length
                    ? ': ' + extExceptions.map((e) => e.split('\n')[0]).join(' | ')
                    : ''
            })`,
        );

        // -- Screenshot -----------------------------------------------------
        step(11, 'Capture screenshot evidence');
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const shotPath = join(HERE, 'menu-panel.png');
        writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
        log('screenshot saved to', shotPath);

        // -- Summary --------------------------------------------------------
        console.log('\n[e2e-menu] ================= PASS =================');
        console.log('[e2e-menu] Pull label:        ', pullLabel);
        console.log('[e2e-menu] Manifest:          ', JSON.stringify(manifest));
        console.log('[e2e-menu] Commit head:       ', commitLabel);
        console.log('[e2e-menu] Badge check:       ', badgeChecked ? 'asserted' : 'SKIPPED');
        console.log('[e2e-menu] Assertions:');
        for (const a of evidence.assertions) console.log('        [PASS]', a.msg);

        sw.close();
        page.close();
        cleanup();
        process.exit(0);
    } catch (err) {
        console.error('\n[e2e-menu] ================= FAIL =================');
        console.error('[e2e-menu]', err.stack || err.message);
        if (extExceptions.length) {
            console.error(
                `[e2e-menu] extension exceptions captured (${extExceptions.length}):`,
            );
            for (const e of extExceptions) console.error('[e2e-menu]   ' + e.split('\n')[0]);
        }
        try {
            const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
            const pt = list.find((t) => t.type === 'page');
            if (pt) {
                const c = new CDP(pt.webSocketDebuggerUrl);
                const shot = await c.send('Page.captureScreenshot', { format: 'png' });
                const p = join(HERE, 'menu-failure.png');
                writeFileSync(p, Buffer.from(shot.data, 'base64'));
                console.error('[e2e-menu] failure screenshot:', p);
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
