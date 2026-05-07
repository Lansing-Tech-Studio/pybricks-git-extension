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
    commitBtn.addEventListener('click', () => commit(commitBtn));

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

async function commit(btn) {
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
            body: JSON.stringify({ files, message: '' }),
        });
        console.log('[pybricks-git] commit result:', result);
        btn.textContent = result.committed ? `✓ ${result.head}` : 'no changes';
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
