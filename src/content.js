// ISOLATED-world content script: injects the Git toolbar button and bridges
// requests to inject.js (MAIN world) and to the extension service worker.

const REQ = 'pybricks-git:request';
const RES = 'pybricks-git:response';

let nextId = 1;
const pending = new Map();

window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== RES) return;
    const cb = pending.get(msg.id);
    if (!cb) return;
    pending.delete(msg.id);
    if (msg.ok) cb.resolve(msg.result);
    else cb.reject(new Error(msg.error));
});

function pageRequest(op, payload) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.postMessage({ type: REQ, id, op, payload }, '*');
    });
}

const storageGet = (key) =>
    new Promise((resolve) => chrome.storage.local.get(key, (v) => resolve(v[key])));
const storageSet = (obj) =>
    new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));

const menuPanel = makeMenuPanel({
    pageRequest,
    serverRequest,
    storageGet,
    storageSet,
    reload: () => location.reload(),
});

const fileListWatcher = makeFileListWatcher({
    pageRequest,
    storageGet,
    addSlot: (module, fn, blocks) => menuPanel.addSlot(module, fn, blocks),
    onNewProgram: () =>
        menuPanel.newProgram().catch((err) =>
            console.error('[pybricks-git] new program failed:', err),
        ),
});
fileListWatcher.start().catch((err) => console.warn('[pybricks-git] file-list watcher failed:', err));

mountButton().catch((err) => console.warn('[pybricks-git] mount failed:', err));

showRescueNotice().catch((err) => console.warn('[pybricks-git] rescue notice failed:', err));

async function mountButton() {
    const toolbar = await waitFor(() =>
        document.querySelector('[role="toolbar"][aria-label="Editor"]'),
    );
    if (toolbar.querySelector('[data-pybricks-git]')) return;

    const commitBtn = makeBtn('Commit', 'Pybricks Git: commit current files');
    commitBtn.addEventListener('click', () => promptCommitMessage(commitBtn));

    const pullBtn = makeBtn('Pull', 'Pybricks Git: pull from disk into editor');
    pullBtn.addEventListener('click', () => pull(pullBtn));

    toolbar.appendChild(commitBtn);
    toolbar.appendChild(pullBtn);

    const menuBtn = makeBtn('Menu', 'Pybricks Git: edit the hub menu');
    menuBtn.dataset.pybricksGitMenuBtn = '1';
    menuBtn.addEventListener('click', () => {
        menuPanel.toggle().catch((err) => console.error('[pybricks-git] panel failed:', err));
    });
    toolbar.appendChild(menuBtn);

    // Reopen the panel after the reload that Save/Pull triggers.
    const saved = await new Promise((resolve) =>
        chrome.storage.local.get('menuPanel', (v) => resolve(v.menuPanel)),
    );
    if (saved && saved.open) {
        menuPanel.open().catch((err) => console.warn('[pybricks-git] panel reopen failed:', err));
    }
}

function makeBtn(label, title) {
    const btn = document.createElement('button');
    btn.dataset.pybricksGit = '1';
    btn.textContent = label;
    btn.title = title;
    Object.assign(btn.style, {
        marginLeft: '8px',
        padding: '6px 12px',
        background: '#2d2d30',
        color: '#ddd',
        border: '1px solid #555',
        borderRadius: '4px',
        cursor: 'pointer',
        font: 'inherit',
    });
    return btn;
}

// Shows a one-line message input under the Commit button. Enter commits with
// the typed message (blank falls back to the timestamped default the extension
// service worker generates), Escape or clicking elsewhere cancels without
// committing.
function promptCommitMessage(btn) {
    if (document.querySelector('[data-pybricks-git-msg]')) return;

    const input = document.createElement('input');
    input.dataset.pybricksGitMsg = '1';
    input.type = 'text';
    input.placeholder = 'Commit message (blank = timestamped)';
    const rect = btn.getBoundingClientRect();
    // The buttons sit at the right end of the toolbar, so anchoring the input's
    // left edge to the button pushes it off-screen. Clamp it into the viewport.
    const boxWidth = 298; // 280px width + 16px padding + 2px border
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - boxWidth - 8));
    Object.assign(input.style, {
        position: 'fixed',
        left: `${left}px`,
        top: `${rect.bottom + 4}px`,
        width: '280px',
        padding: '6px 8px',
        background: '#2d2d30',
        color: '#ddd',
        border: '1px solid #555',
        borderRadius: '4px',
        font: 'inherit',
        zIndex: 10000,
    });
    // Removing a focused element fires blur, and the blur listener below
    // removes the input re-entrantly — a plain input.remove() in the keydown
    // handler then throws NotFoundError before commit() runs. The guard makes
    // close() idempotent so whichever event fires first wins cleanly.
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        input.remove();
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            const message = input.value.trim();
            close();
            commit(btn, message);
        } else if (event.key === 'Escape') {
            close();
        }
    });
    input.addEventListener('blur', close);
    document.body.appendChild(input);
    input.focus();
}

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
        // Both notices share one slot, so report the protected files last: a kid
        // who edits a coach file needs that explained more than a stale deletion.
        if (result.deleteSkipped && result.deleteSkipped.length) {
            const one = result.deleteSkipped.length === 1;
            showCommitNotice(
                `${result.deleteSkipped.join(', ')} ${one ? 'was' : 'were'} changed by a teammate ` +
                    `since your last Pull, so ${one ? "it wasn't" : "they weren't"} deleted. ` +
                    `Pull to see their version.`,
            );
        }
        if (result.protectedSkipped && result.protectedSkipped.length) {
            const one = result.protectedSkipped.length === 1;
            showCommitNotice(
                `${result.protectedSkipped.join(', ')} ${one ? 'is' : 'are'} managed by your coach's repo, ` +
                    `so your ${one ? "version wasn't" : "versions weren't"} committed. ` +
                    `Pull to match the repo.`,
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

// Kid-facing warning about work a Commit deliberately did not push: coach-managed
// files it wouldn't change, and deletions it wouldn't apply over a teammate's
// newer edit. Only one is shown at a time. Click or the timeout dismisses it.
function showCommitNotice(text) {
    document.querySelector('[data-pybricks-git-notice]')?.remove();
    const box = document.createElement('div');
    box.dataset.pybricksGitNotice = '1';
    box.setAttribute('role', 'status');
    box.tabIndex = 0;
    box.textContent = text;
    box.title = 'Click or press Escape to dismiss';
    box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') box.remove();
    });
    Object.assign(box.style, {
        position: 'fixed',
        top: '48px',
        right: '12px',
        maxWidth: '360px',
        padding: '10px 14px',
        background: '#5c3c00',
        color: '#ffe2a8',
        border: '1px solid #a97800',
        borderRadius: '4px',
        font: 'inherit',
        fontSize: '13px',
        zIndex: 10000,
        cursor: 'pointer',
    });
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 15000);
}

// Kid-facing report of what Pull rescued. Rendered on the page load *after*
// the pull's reload, because that's when the rescued files are actually
// visible in the file list. Click, Escape, or the timeout dismisses it.
async function showRescueNotice() {
    const rescued = await storageGet('pullRescued');
    if (!rescued || !rescued.length) return;
    await storageSet({ pullRescued: [] });

    const box = document.createElement('div');
    box.dataset.pybricksGitRescue = '1';
    box.setAttribute('role', 'status');
    box.tabIndex = 0;
    box.textContent =
        `The repo had its own version of ${rescued.length === 1 ? 'this file' : 'these files'}, ` +
        `so your changes were saved alongside it: ` +
        rescued.map((r) => `${r.path} → ${r.savedAs}`).join(', ');
    box.title = 'Click or press Escape to dismiss';
    box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') box.remove();
    });
    Object.assign(box.style, {
        position: 'fixed',
        top: '48px',
        right: '12px',
        maxWidth: '360px',
        padding: '10px 14px',
        background: '#0d3b2e',
        color: '#a8f0d4',
        border: '1px solid #1c7a5c',
        borderRadius: '4px',
        font: 'inherit',
        fontSize: '13px',
        zIndex: 10000,
        cursor: 'pointer',
    });
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 20000);
}

// Must match inject.js:sha256() byte-for-byte — planPull compares this against
// the repo's hash (computed the same way in background.js), so any divergence
// makes every pull rescue every file. Computed here instead of trusting the
// metadata row's stored sha256, which is only as current as Pybricks' own
// write path keeps it.
async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

async function pull(btn) {
    const original = 'Pull';
    btn.textContent = 'Pulling…';
    btn.disabled = true;
    try {
        if (!(await ensureConfigured(btn, original))) return;

        // Read before the pull op, which overwrites this key on success — base
        // must be the last state the editor and repo agreed on, not what the
        // repo just handed us (that would make every upstream change look like
        // an "edit" and spuriously rescue it).
        const base = (await storageGet('lastPullShas')) ?? {};
        const result = await serverRequest('pull');
        // An empty/missing-branch pull (no head → non-empty pullWarning) returns
        // files:[]. Applying that would DELETE every file in the editor, since
        // apply-files diffs the payload as the complete desired state. Skip the
        // apply entirely — the editor keeps what it has. NOTE: a fork that has
        // commits but zero .py files has head set and pullWarning empty, so it
        // still applies normally (emptying the editor by design, 1:1 tracking).
        if (result.pullWarning) {
            console.warn('[pybricks-git] pull skipped:', result.pullWarning);
            btn.textContent = 'nothing to pull';
            setTimeout(() => (btn.textContent = original), 3000);
            return;
        }
        console.log(`[pybricks-git] received ${result.files.length} file(s)`);

        // Never hand apply-files the repo's set directly — it deletes every
        // path it isn't given, which is how uncommitted local work used to
        // disappear. planPull returns the full desired set: the repo's files,
        // plus rescued copies of files genuinely edited locally, plus
        // never-committed local files left alone.
        const editor = await pageRequest('list-files');
        const plan = planPull({
            local: await Promise.all(
                editor.contents.map(async (c) => ({
                    path: c.path,
                    contents: c.contents,
                    sha: await sha256(c.contents),
                })),
            ),
            repo: result.files,
            base,
            protectedPaths: result.protected ?? [],
        });
        if (plan.rescued.length) {
            console.warn('[pybricks-git] rescued local edits:', plan.rescued);
        }

        const summary = await pageRequest('apply-files', { files: plan.files });
        console.log('[pybricks-git] applied:', summary);
        btn.textContent = `↓ +${summary.added} ~${summary.changed} -${summary.deleted}`;
        // Both keys are written only after apply-files resolves. The base must
        // never claim agreement the editor doesn't hold: if the apply throws,
        // the editor is still on the old files, and an advanced base would let
        // the next Commit push them over whatever the repo now has. A stale
        // pullRescued would likewise render a false notice on the next load.
        await storageSet({ lastPullShas: result.shas });
        if (plan.rescued.length) await storageSet({ pullRescued: plan.rescued });

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

// Shows 'setup needed' on the button when settings are missing and opens the
// extension's settings popup; returns false so the caller can bail out of the
// operation.
async function ensureConfigured(btn, original) {
    const status = await serverRequest('status');
    if (status.configured) return true;
    btn.textContent = 'setup needed';
    setTimeout(() => (btn.textContent = original), 3000);
    try {
        await serverRequest('openPopup');
    } catch (err) {
        // Chrome can refuse (e.g. another popup already open) — the button
        // label is the fallback.
        console.warn(
            '[pybricks-git] not configured — click the extension icon to sign in with GitHub',
            `(auto-open failed: ${err.message})`,
        );
    }
    return false;
}

function waitFor(predicate, { interval = 200, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        (function tick() {
            const v = predicate();
            if (v) return resolve(v);
            if (Date.now() - start > timeout) {
                return reject(new Error('waitFor timed out'));
            }
            setTimeout(tick, interval);
        })();
    });
}
