// Browser end-to-end driver for the Pybricks Git extension.
//
// Self-contained: starts the in-repo git HTTP harness (Task 2), launches
// Playwright's Chromium with the unpacked extension, and drives the real
// Pull/Commit flow on https://code.pybricks.com over raw CDP (Node 22's
// built-in WebSocket, no npm deps). Asserts on both the browser side (button
// label timelines, editor IndexedDB) and the git-server side (pushed commit).
//
// Run:  node test/e2e/drive.mjs
// Exit: 0 = PASS, non-zero = FAIL/BLOCKED (reason printed).
//
// Hard-won environment facts baked in below (each cost real debugging time):
//  - Branded Google Chrome ignores --load-extension; must use Playwright's
//    Chromium binary.
//  - Chrome's Local Network Access gate SILENTLY HANGS fetches to 127.0.0.1
//    unless the --disable-features list below is passed.
//  - Drive UI with TRUSTED CDP input events, not synthetic DOM events.
//  - After a Pull applies changes, content.js schedules location.reload() ~1.5s
//    later; execution contexts are recreated, so the isolated world must be
//    re-enumerated after the reload.

import { spawn, execFileSync } from 'node:child_process';
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

const log = (...a) => console.log('[e2e]', ...a);
const step = (n, m) => console.log(`\n[e2e] === STEP ${n}: ${m} ===`);

function findChromium() {
    const glob = join(
        process.env.HOME,
        '.cache/ms-playwright',
    );
    let best = null;
    for (const d of readdirSync(glob)) {
        // Only the full `chromium-<rev>` build ships the branded binary that
        // honors --load-extension; `chromium_headless_shell-*` does not, and
        // some rev dirs are metadata-only (no binary). Verify existence.
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

// ---- Minimal CDP client over one WebSocket (one per attached target) --------
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
    const scratch = mkdtempSync(join(tmpdir(), 'pbgit-e2e-'));
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

    const evidence = { labels: {}, assertions: [] };
    // Extension exceptions from BOTH targets end up here, each tagged with its
    // source ("page:" or "sw:") so the zero-exceptions gate covers the service
    // worker (where the git engine runs), not just the page. Declared in the
    // outer scope so the catch block can print them as failure diagnostics.
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
        step(1, 'Start git harness with a seeded bare repo');
        const bare = makeBareRepo(scratch, 'team', {
            'starter.py': 'print("starter")\n',
        });
        server = await startGitServer(scratch);
        const repoUrl = `${server.url}/team.git`;
        log('git server at', server.url, '-> repoUrl', repoUrl);

        // -- Launch Chromium with the unpacked extension --------------------
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

        // -- Discover targets ----------------------------------------------
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
        // The extension's git engine runs in this service-worker target, so a
        // throw here is invisible to the page listener. Capture it into the same
        // extExceptions array (tagged "sw:") before any Pull/Commit interaction.
        sw.onEvent((method, params) => {
            if (method === 'Runtime.exceptionThrown') {
                const summary = exceptionSummary(params.exceptionDetails);
                extExceptions.push('sw: ' + summary);
                log('EXTENSION EXCEPTION (sw):', summary.split('\n')[0]);
            }
        });
        await sw.send('Runtime.enable'); // enables exceptionThrown on the SW too
        const settings = {
            repoUrl,
            branch: 'main',
            token: 'test',
            name: 'E2E Team',
            email: 'e2e@example.com',
        };
        await sw.send('Runtime.evaluate', {
            expression: `chrome.storage.local.set({settings:${JSON.stringify(
                settings,
            )}})`,
            awaitPromise: true,
            returnByValue: true,
        });
        const check = await sw.send('Runtime.evaluate', {
            expression: `chrome.storage.local.get('settings')`,
            awaitPromise: true,
            returnByValue: true,
        });
        assert(
            check.result.value.settings.repoUrl === repoUrl,
            'settings written to chrome.storage.local via SW',
        );

        // -- Attach to the page and track the isolated world ----------------
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

        // Track the extension's isolated execution context; it is recreated on
        // reload, so keep the latest and clear it when contexts are wiped.
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
                    /content\.js|inject\.js|background\.js/.test(text);
                const summary = exceptionSummary(det);
                (isExt ? extExceptions : pageExceptions).push(
                    (isExt ? 'page: ' : '') + summary,
                );
                if (isExt) log('EXTENSION EXCEPTION (page):', summary.split('\n')[0]);
            }
        });
        await page.send('Page.enable');
        await page.send('Runtime.enable'); // replays execution contexts (not past exceptions)

        // Evaluate an expression in the isolated world (re-fetches ctx id).
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

        // Locate a toolbar button by its (prefix of) label; returns center pt.
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

        const buttonLabel = (labelStarts) =>
            evalIsolated(
                `(() => {
                  const b = [...document.querySelectorAll('button[data-pybricks-git]')]
                    .find(x => ${JSON.stringify(labelStarts)}.some(p => x.textContent.trim().startsWith(p)));
                  return b ? b.textContent : null;
                })()`,
                false,
            );

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
        const elementAt = (x, y) =>
            evalIsolated(
                `(() => {
                  const e = document.elementFromPoint(${x}, ${y});
                  if (!e) return 'null';
                  const chain = [];
                  let n = e;
                  for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
                    const r = n.getBoundingClientRect();
                    chain.push(n.tagName + (n.id?'#'+n.id:'') + (n.className && typeof n.className==='string'?'.'+n.className.split(' ').filter(Boolean).slice(0,2).join('.'):'') + ' ['+Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'x'+Math.round(r.height)+']');
                  }
                  return chain.join('  <  ');
                })()`,
                false,
            );

        // -- Wait for toolbar buttons to mount ------------------------------
        step(3, 'Wait for Commit/Pull buttons to mount');
        await poll(async () => (await buttonRect('Pull')) && (await buttonRect('Commit')), {
            timeout: 40000,
            what: 'Pybricks Git toolbar buttons',
        });
        log('buttons mounted');

        // Wait until the Pybricks IndexedDB exists (list-files resolves).
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

        // -- Pull -----------------------------------------------------------
        // The Pybricks Welcome Tour (react-joyride) mounts a full-viewport
        // overlay that intercepts hit-testing, so trusted clicks never reach
        // the toolbar. Dismiss it like a user before driving the toolbar.
        step(3, 'Dismiss the Pybricks Welcome Tour if present');
        const tourOverlayGone = () =>
            evalIsolated(
                `!document.querySelector('.react-joyride__overlay')`,
                false,
            );
        // Rect of the joyride "Skip"/close button (data-action skip|close), if any.
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
            const jb = await evalIsolated(
                `[...document.querySelectorAll('#react-joyride-portal button, .react-joyride__tooltip button')].map(b => ({ action: b.getAttribute('data-action'), text: b.textContent.trim().slice(0,20) }))`,
                false,
            );
            log('joyride buttons:', JSON.stringify(jb));
            await poll(
                async () => {
                    if (await tourOverlayGone()) return true;
                    const r = await tourDismissRect();
                    if (r) {
                        log('clicking tour dismiss:', r.action, `(${r.x},${r.y})`);
                        await trustedClick(r);
                    } else {
                        // No skip button on this step — press Escape (joyride
                        // closes the tour on Escape by default).
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

        step(3, 'Pull: real-click, expect label "↓ +1 ~0 -0", then reload');
        const pullPt = await buttonRect('Pull');
        log('Pull button center:', JSON.stringify(pullPt));
        log('elementFromPoint(pull center):', await elementAt(pullPt.x, pullPt.y));
        await trustedClick(pullPt);
        const rawPull = () =>
            evalIsolated(
                `(() => { const b=[...document.querySelectorAll('button[data-pybricks-git]')].find(x=>['Pull','Pulling','↓','error','setup'].some(p=>x.textContent.trim().startsWith(p))); return b?b.textContent:null; })()`,
                false,
            );
        log('label right after click:', JSON.stringify(await rawPull()));
        const pullTimeline = [];
        const pullLabel = await poll(
            async () => {
                const l = await rawPull();
                if (l && l !== pullTimeline[pullTimeline.length - 1]) {
                    pullTimeline.push(l);
                    log('  pull label ->', JSON.stringify(l));
                }
                return l && /^(↓|error|setup)/.test(l) ? l : null;
            },
            { timeout: 30000, interval: 100, what: 'Pull result label' },
        );
        evidence.labels.pullTimeline = pullTimeline;
        evidence.labels.pull = pullLabel;
        log('pull label =', JSON.stringify(pullLabel));
        assert(
            pullLabel === '↓ +1 ~0 -0',
            `Pull label is "↓ +1 ~0 -0" (got "${pullLabel}")`,
        );

        // content.js reloads ~1.5s after a non-empty apply; wait for the
        // context to be torn down and rebuilt.
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

        const afterPull = await evalIsolated(`pageRequest('list-files')`);
        const pulledPaths = afterPull.contents.map((c) => c.path);
        log('editor files after pull:', pulledPaths);
        assert(
            pulledPaths.some((p) => p === 'starter.py' || p.endsWith('/starter.py')),
            'starter.py present in editor IndexedDB after Pull+reload',
        );

        // -- Commit ---------------------------------------------------------
        step(4, 'Seed a second file, then Commit with message "e2e message"');
        const existing = afterPull.contents.map((c) => ({
            path: c.path,
            contents: c.contents,
        }));
        const seeded = existing.concat([
            { path: 'e2e.py', contents: 'print("e2e")\n' },
        ]);
        const applySummary = await evalIsolated(
            `pageRequest('apply-files', { files: ${JSON.stringify(seeded)} })`,
        );
        log('apply-files summary:', applySummary);
        assert(
            applySummary.added === 1,
            `apply-files added e2e.py (summary ${JSON.stringify(applySummary)})`,
        );

        const commitPt = await buttonRect('Commit');
        await trustedClick(commitPt);
        // The message input appears focused; type into it with trusted input.
        await poll(
            () =>
                evalIsolated(
                    `!!document.querySelector('[data-pybricks-git-msg]')`,
                    false,
                ),
            { timeout: 10000, what: 'commit message input to appear' },
        );
        await page.send('Input.insertText', { text: 'e2e message' });
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

        // Capture the label timeline: Committing… -> ✓ <sha> ↑
        const timeline = [];
        const commitLabel = await poll(
            async () => {
                const l = await buttonLabel(['Committing', '✓', 'no changes', 'error']);
                if (l && l !== timeline[timeline.length - 1]) timeline.push(l);
                if (l && (/^✓ [0-9a-f]{7} ↑$/.test(l.trim()) || l === 'error' || l === 'no changes')) {
                    return l;
                }
                return null;
            },
            { timeout: 40000, interval: 100, what: 'Commit result label' },
        );
        evidence.labels.commitTimeline = timeline;
        log('commit label timeline:', timeline);
        assert(
            timeline.includes('Committing…'),
            'commit label showed "Committing…"',
        );
        assert(
            /^✓ [0-9a-f]{7} ↑$/.test(commitLabel.trim()),
            `commit label shows "✓ <sha> ↑" (got "${commitLabel}")`,
        );

        // -- Harness-side assertions ---------------------------------------
        step(5, 'Harness-side assertions on the pushed commit');
        const subjects = bareSubjects(bare);
        log('bare subjects:', subjects);
        assert(subjects.includes('e2e message'), 'bareSubjects includes "e2e message"');
        const e2eContents = bareFile(bare, 'e2e.py');
        log('bareFile e2e.py =', JSON.stringify(e2eContents));
        assert(e2eContents === 'print("e2e")\n', 'e2e.py pushed to the bare repo');
        const starterContents = bareFile(bare, 'starter.py');
        assert(
            starterContents === 'print("starter")\n',
            'starter.py still present in the bare repo (first-commit guard held)',
        );

        // -- Exceptions -----------------------------------------------------
        // Covers BOTH the page (content.js/inject.js) and the service worker
        // (background.js, where the git engine runs); entries are tagged
        // "page:"/"sw:" so the source is unambiguous.
        step(6, 'Zero extension exceptions (page + service worker)');
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
        step(7, 'Capture screenshot evidence');
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const shotPath = join(HERE, 'toolbar.png');
        writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
        log('screenshot saved to', shotPath);
        evidence.screenshot = shotPath;

        // -- Summary --------------------------------------------------------
        console.log('\n[e2e] ================= PASS =================');
        console.log('[e2e] Pull label:      ', evidence.labels.pull);
        console.log('[e2e] Commit timeline: ', evidence.labels.commitTimeline.join('  ->  '));
        console.log('[e2e] Commit head:     ', commitLabel.trim());
        console.log('[e2e] Assertions:');
        for (const a of evidence.assertions) console.log('       [PASS]', a.msg);

        sw.close();
        page.close();
        cleanup();
        process.exit(0);
    } catch (err) {
        console.error('\n[e2e] ================= FAIL =================');
        console.error('[e2e]', err.stack || err.message);
        // Surface any captured extension exceptions (page + service worker) as
        // failure diagnostics — a throw in the SW git engine is a prime suspect.
        if (extExceptions.length) {
            console.error(
                `[e2e] extension exceptions captured (${extExceptions.length}):`,
            );
            for (const e of extExceptions) console.error('[e2e]   ' + e.split('\n')[0]);
        }
        // Try to grab a diagnostic screenshot if the page is reachable.
        try {
            const list = await fetchJSON(`http://127.0.0.1:${DEBUG_PORT}/json`, 1);
            const pt = list.find((t) => t.type === 'page');
            if (pt) {
                const c = new CDP(pt.webSocketDebuggerUrl);
                const shot = await c.send('Page.captureScreenshot', { format: 'png' });
                const p = join(HERE, 'failure.png');
                writeFileSync(p, Buffer.from(shot.data, 'base64'));
                console.error('[e2e] failure screenshot:', p);
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
