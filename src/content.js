// ISOLATED-world content script: injects the Git toolbar button and bridges
// requests to inject.js (MAIN world) and to the local Go server.

const REQ = 'pybricks-git:request';
const RES = 'pybricks-git:response';
const SERVER = 'http://localhost:8127';

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
    const original = btn.textContent;
    btn.textContent = 'Committing…';
    btn.disabled = true;
    try {
        // 1. Verify the Go server is up.
        const status = await fetchJSON(`${SERVER}/status`);
        console.log('[pybricks-git] server status:', status);

        // 2. Read every file from the page's IndexedDB via inject.js.
        const data = await pageRequest('list-files');
        const files = data.contents.map((c) => ({
            path: c.path,
            contents: c.contents,
        }));
        console.log(`[pybricks-git] sending ${files.length} file(s) to server`);

        // 3. Send to /commit.
        const result = await fetchJSON(`${SERVER}/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files, message }),
        });
        console.log('[pybricks-git] commit result:', result);
        const label = result.committed ? `✓ ${result.head}` : 'no changes';

        // 4. Push — even when nothing new was committed, so commits stranded
        // by an earlier failed push still go up. A failed push must not mask
        // the successful commit.
        let pushSuffix = '';
        try {
            const push = await fetchJSON(`${SERVER}/push`, { method: 'POST' });
            if (push.pushed) {
                pushSuffix = ' ↑';
            } else if (push.pushWarning) {
                console.warn('[pybricks-git] push skipped:', push.pushWarning);
            }
        } catch (pushErr) {
            console.error('[pybricks-git] push failed (commit succeeded):', pushErr);
            pushSuffix = ' push failed';
        }
        btn.textContent = label + pushSuffix;
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
    const original = btn.textContent;
    btn.textContent = 'Pulling…';
    btn.disabled = true;
    try {
        const status = await fetchJSON(`${SERVER}/status`);
        console.log('[pybricks-git] server status:', status);

        const result = await fetchJSON(`${SERVER}/pull`);
        if (result.pullWarning) {
            console.warn(
                '[pybricks-git] git pull skipped/failed (continuing with working-tree state):',
                result.pullWarning,
            );
        }
        console.log(
            `[pybricks-git] received ${result.files.length} file(s) from server`,
        );

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

async function fetchJSON(url, init) {
    const r = await fetch(url, init);
    const text = await r.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`${url}: non-JSON response (${r.status}): ${text.slice(0, 200)}`);
    }
    if (!r.ok) {
        throw new Error(`${url}: ${r.status} ${body.error || text.slice(0, 200)}`);
    }
    return body;
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
