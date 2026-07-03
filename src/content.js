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

mountButton().catch((err) => console.warn('[pybricks-git] mount failed:', err));

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
// the typed message (blank keeps the server's timestamped default), Escape or
// clicking elsewhere cancels without committing.
function promptCommitMessage(btn) {
    if (document.querySelector('[data-pybricks-git-msg]')) return;

    const input = document.createElement('input');
    input.dataset.pybricksGitMsg = '1';
    input.type = 'text';
    input.placeholder = 'Commit message (blank = timestamped)';
    const rect = btn.getBoundingClientRect();
    Object.assign(input.style, {
        position: 'fixed',
        left: `${rect.left}px`,
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

async function pull(btn) {
    const original = 'Pull';
    btn.textContent = 'Pulling…';
    btn.disabled = true;
    try {
        if (!(await ensureConfigured(btn, original))) return;

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
