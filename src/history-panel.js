// Floating History panel: lists the branch's commits and shows line diffs of
// the editor-visible .py files, GitHub-PR style. Two ways to compare:
//   - "Compared to now"        selected commit  → the editor's current files
//   - "This commit's changes"  its first parent → the selected commit
// ◀ Older / Newer ▶ step the selection. Each changed file offers "Restore this
// version", which writes the SELECTED commit's copy of that file into the
// editor (never deletes, never commits, never offered for protected files).
//
// Depends on diff.js (diffFileSets) and floating-panel.js (makeFloatingPanel),
// loaded earlier in the same isolated world. Classic script — no exports;
// content.js calls makeHistoryPanel({...}).

function makeHistoryPanel(deps) {
    const {
        pageRequest,
        serverRequest,
        storageGet,
        storageSet,
        reload,
        showError = (op, err) => console.error(`[pybricks-git] ${op} failed:`, err),
        afterRestore = async () => {},
    } = deps;

    const PAGE = 20;
    const CONTEXT = 3;

    const state = {
        configured: true,
        commits: [],
        head: null,
        hasMore: false,
        depth: PAGE,
        selected: null, // oid
        mode: 'now', // 'now' | 'commit' — every open starts on "Compared to now"
        wholeFile: false, // persisted in the historyPanel key
        filesCache: new Map(), // oid -> [{path, contents}]
        protectedPaths: new Set(),
        loading: false,
        restoring: false,
        confirmPath: null, // path whose Restore button is in its "really?" state
        confirmTimer: null,
        lastNowFingerprint: null,
    };
    let renderToken = 0;

    const shell = makeFloatingPanel({
        title: 'History',
        attr: 'history',
        storageKey: 'historyPanel',
        storageGet,
        storageSet,
        width: 640,
        defaultPos: { left: 140, top: 120 }, // offset from the Menu panel's 80/80
        extraState: () => ({ wholeFile: state.wholeFile }),
        onClose: () => clearConfirm(),
    });

    // DOM handles, rebuilt on every open.
    let ui = null;

    // --- open / close ----------------------------------------------------------

    async function open() {
        if (shell.isOpen()) return;
        await shell.open(async (saved) => {
            state.wholeFile = Boolean(saved && saved.wholeFile);
            state.mode = 'now';
        });
        buildBody();
        await refresh();
    }

    function close() {
        shell.close();
        ui = null;
    }

    async function toggle() {
        if (shell.isOpen()) close();
        else await open();
    }

    function isOpen() {
        return shell.isOpen();
    }

    // --- data ------------------------------------------------------------------

    // Re-reads the commit list (one deeper fetch in the service worker) and the
    // manifest's protected set, then re-renders. The stale list stays on screen
    // while it runs; a failure keeps it and reports in the status line.
    async function loadHistory() {
        state.loading = true;
        setStatus(state.commits.length ? 'Refreshing…' : 'Loading…');
        renderControls();
        try {
            const status = await serverRequest('status');
            state.configured = Boolean(status.configured);
            if (!state.configured) {
                state.commits = [];
                state.head = null;
                state.hasMore = false;
                return;
            }
            const [res, manifest] = await Promise.all([
                serverRequest('history', { depth: state.depth }),
                storageGet('lastPullManifest'),
            ]);
            state.commits = res.commits ?? [];
            state.head = res.head ?? null;
            state.hasMore = Boolean(res.hasMore);
            state.protectedPaths = new Set(Array.isArray(manifest?.protected) ? manifest.protected : []);
            if (!state.commits.some((c) => c.oid === state.selected)) {
                state.selected = state.commits.length ? state.commits[0].oid : null;
            }
            // The cache is keyed by immutable oids, so entries never go stale;
            // just keep it from growing without bound across a long session.
            if (state.filesCache.size > 60) state.filesCache.clear();
            setStatus('');
        } catch (err) {
            console.error('[pybricks-git] history failed:', err);
            setStatus("Couldn't load history");
            showError('History', err);
        } finally {
            state.loading = false;
        }
    }

    async function filesFor(oid) {
        if (!oid) return [];
        if (state.filesCache.has(oid)) return state.filesCache.get(oid);
        const res = await serverRequest('filesAt', { oid, depth: state.depth });
        state.filesCache.set(oid, res.files ?? []);
        return state.filesCache.get(oid);
    }

    async function currentFiles() {
        const data = await pageRequest('list-files');
        return data.contents.map((c) => ({ path: c.path, contents: c.contents }));
    }

    function nowFingerprint(files) {
        return files.map((f) => `${f.path}\u0000${f.contents.length}\u0000${f.contents}`).join('\u0001');
    }

    function selectedCommit() {
        return state.commits.find((c) => c.oid === state.selected) ?? null;
    }

    function selectedIndex() {
        return state.commits.findIndex((c) => c.oid === state.selected);
    }

    // --- public refresh ----------------------------------------------------------

    async function refresh() {
        if (!shell.isOpen()) return;
        await loadHistory();
        renderControls();
        renderList();
        await renderDiff();
    }

    // --- body layout -------------------------------------------------------------

    function buildBody() {
        const body = shell.body;
        Object.assign(body.style, { display: 'flex', flexDirection: 'column', padding: '0', overflow: 'hidden' });

        const controls = document.createElement('div');
        controls.dataset.pybricksGitHistoryControls = '1';
        Object.assign(controls.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flexWrap: 'wrap',
            padding: '8px 12px',
            borderBottom: '1px solid #444',
            flexShrink: '0',
        });

        const columns = document.createElement('div');
        Object.assign(columns.style, { display: 'flex', flex: '1', minHeight: '0' });

        const list = document.createElement('div');
        list.dataset.pybricksGitHistoryList = '1';
        Object.assign(list.style, {
            width: '210px',
            flexShrink: '0',
            overflowY: 'auto',
            borderRight: '1px solid #444',
            padding: '4px 0',
        });

        const diff = document.createElement('div');
        diff.dataset.pybricksGitHistoryDiff = '1';
        Object.assign(diff.style, { flex: '1', minWidth: '0', overflow: 'auto', padding: '8px 12px' });

        columns.appendChild(list);
        columns.appendChild(diff);
        body.appendChild(controls);
        body.appendChild(columns);

        const footer = shell.footer;
        const status = document.createElement('span');
        status.dataset.pybricksGitHistoryStatus = '1';
        Object.assign(status.style, { flex: '1', color: '#999', fontStyle: 'italic', minHeight: '1.2em' });
        const more = miniBtn('Load older', 'Show 20 more commits');
        more.dataset.pybricksGitHistoryMore = '1';
        more.addEventListener('click', async () => {
            state.depth += PAGE;
            await refresh();
        });
        footer.appendChild(status);
        footer.appendChild(more);

        // "Now" freshness: after any click inside the panel (bubble phase, so
        // button handlers have already run), re-read the editor and re-render
        // the diff only if its contents changed. No polling.
        shell.root.addEventListener('click', () => {
            if (state.mode !== 'now' || !state.selected || state.restoring) return;
            void refreshNowIfChanged();
        });

        ui = { controls, list, diff, status, more };
    }

    async function refreshNowIfChanged() {
        try {
            const files = await currentFiles();
            if (nowFingerprint(files) !== state.lastNowFingerprint) await renderDiff(files);
        } catch (err) {
            console.warn('[pybricks-git] history: editor re-read failed:', err);
        }
    }

    // --- controls --------------------------------------------------------------------

    function renderControls() {
        if (!ui) return;
        const c = ui.controls;
        c.replaceChildren();
        const idx = selectedIndex();
        const n = state.commits.length;

        const older = miniBtn('◀ Older', 'Select the previous commit');
        older.dataset.pybricksGitHistoryOlder = '1';
        older.disabled = idx < 0 || idx >= n - 1;
        older.addEventListener('click', () => select(state.commits[idx + 1]?.oid));

        const newer = miniBtn('Newer ▶', 'Select the next commit');
        newer.dataset.pybricksGitHistoryNewer = '1';
        newer.disabled = idx <= 0;
        newer.addEventListener('click', () => select(state.commits[idx - 1]?.oid));

        const mode = document.createElement('select');
        mode.dataset.pybricksGitHistoryMode = '1';
        mode.title = 'What to compare';
        for (const [value, label] of [
            ['now', 'Compared to now'],
            ['commit', "This commit's changes"],
        ]) {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = label;
            mode.appendChild(o);
        }
        mode.value = state.mode;
        Object.assign(mode.style, {
            background: '#2d2d30',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            padding: '4px 6px',
            font: 'inherit',
            fontSize: '13px',
        });
        mode.addEventListener('change', () => {
            state.mode = mode.value;
            clearConfirm();
            void renderDiff();
        });

        const whole = document.createElement('label');
        Object.assign(whole.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.pybricksGitHistoryWholefile = '1';
        cb.checked = state.wholeFile;
        cb.addEventListener('change', () => {
            state.wholeFile = cb.checked;
            void shell.persist(true);
            void renderDiff();
        });
        whole.appendChild(cb);
        whole.appendChild(document.createTextNode('Whole file'));

        const spacer = document.createElement('span');
        spacer.style.flex = '1';

        const refreshBtn = miniBtn('↻', 'Refresh');
        refreshBtn.dataset.pybricksGitHistoryRefresh = '1';
        refreshBtn.disabled = state.loading;
        refreshBtn.addEventListener('click', () => void refresh());

        c.appendChild(older);
        c.appendChild(newer);
        c.appendChild(mode);
        c.appendChild(whole);
        c.appendChild(spacer);
        c.appendChild(refreshBtn);
        if (ui.more) ui.more.style.display = state.hasMore && state.configured ? '' : 'none';
    }

    function select(oid) {
        if (!oid || oid === state.selected) return;
        state.selected = oid;
        clearConfirm();
        renderControls();
        renderList();
        void renderDiff();
    }

    // --- commit list -----------------------------------------------------------------

    function renderList() {
        if (!ui) return;
        const list = ui.list;
        list.replaceChildren();
        if (!state.configured) return;
        if (!state.commits.length) {
            list.appendChild(noteEl(state.loading ? 'Loading…' : 'No commits yet'));
            return;
        }
        const now = Date.now();
        for (const c of state.commits) {
            const row = document.createElement('div');
            row.dataset.pybricksGitHistoryCommit = c.oid;
            const active = c.oid === state.selected;
            Object.assign(row.style, {
                padding: '6px 10px',
                cursor: 'pointer',
                borderLeft: active ? '3px solid #4a9eff' : '3px solid transparent',
                background: active ? '#2a2d2e' : 'transparent',
            });
            row.addEventListener('click', () => select(c.oid));
            row.addEventListener('mouseenter', () => {
                if (c.oid !== state.selected) row.style.background = '#2a2a2a';
            });
            row.addEventListener('mouseleave', () => {
                row.style.background = c.oid === state.selected ? '#2a2d2e' : 'transparent';
            });

            const subject = document.createElement('div');
            subject.textContent = firstLine(c.message) || '(no message)';
            Object.assign(subject.style, {
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: '#eee',
            });
            subject.title = c.message.trim();

            const meta = document.createElement('div');
            Object.assign(meta.style, { color: '#999', fontSize: '11px', display: 'flex', gap: '6px', alignItems: 'center' });
            const sha = document.createElement('code');
            sha.textContent = c.oid.slice(0, 7);
            sha.style.color = '#8fb8ff';
            meta.appendChild(sha);
            meta.appendChild(document.createTextNode(`${c.author?.name ?? ''} · ${relativeTime(c.author?.timestamp, now)}`));
            if (c.parents > 1) meta.appendChild(badge('merge', '#3b3b5c', '#c8c8ff'));

            row.appendChild(subject);
            row.appendChild(meta);
            list.appendChild(row);
        }
    }

    // --- diff -------------------------------------------------------------------------

    // Renders the diff for the current selection and mode. `nowFiles` lets the
    // freshness check hand over the editor files it already read.
    async function renderDiff(nowFiles) {
        if (!ui) return;
        const token = ++renderToken;
        const diffEl = ui.diff;

        if (!state.configured) {
            diffEl.replaceChildren(setupNeeded());
            return;
        }
        const commit = selectedCommit();
        if (!commit) {
            diffEl.replaceChildren(noteEl(state.loading ? 'Loading…' : 'No commits yet. Commit to start your history.'));
            return;
        }

        let before;
        let after;
        let heading;
        try {
            if (state.mode === 'commit') {
                [before, after] = await Promise.all([filesFor(commit.parent), filesFor(commit.oid)]);
                heading = commit.parent
                    ? `Changes in ${commit.oid.slice(0, 7)}`
                    : `First commit ${commit.oid.slice(0, 7)}, everything added`;
            } else {
                const files = nowFiles ?? (await currentFiles());
                state.lastNowFingerprint = nowFingerprint(files);
                before = await filesFor(commit.oid);
                after = files;
                heading = `Since ${commit.oid.slice(0, 7)}, compared to now`;
            }
        } catch (err) {
            if (token !== renderToken) return;
            console.error('[pybricks-git] history diff failed:', err);
            if (err && err.details && /not found/i.test(err.message)) {
                const wrap = document.createElement('div');
                wrap.appendChild(noteEl("Older history isn't loaded yet."));
                const more = miniBtn('Load older', 'Fetch more history');
                more.addEventListener('click', async () => {
                    state.depth += PAGE;
                    await refresh();
                });
                wrap.appendChild(more);
                diffEl.replaceChildren(wrap);
            } else {
                diffEl.replaceChildren(noteEl("Couldn't load this diff."));
                showError('History', err);
            }
            return;
        }
        if (token !== renderToken) return; // a newer selection superseded this render

        const entries = diffFileSets(before, after, { context: CONTEXT });
        const changed = entries.filter((e) => e.status !== 'unchanged');
        const unchanged = entries.filter((e) => e.status === 'unchanged');
        // The selected commit's own files: what Restore writes.
        const restorable = new Map((state.mode === 'commit' ? after : before).map((f) => [f.path, f.contents]));

        const frag = document.createDocumentFragment();
        const h = document.createElement('div');
        h.dataset.pybricksGitHistoryHeading = '1';
        Object.assign(h.style, { fontWeight: 'bold', color: '#bbb', marginBottom: '6px' });
        h.textContent = heading;
        const sub = document.createElement('div');
        Object.assign(sub.style, { color: '#999', fontSize: '12px', marginBottom: '8px' });
        sub.textContent = `${firstLine(commit.message)} — ${commit.author?.name ?? ''}, ${absoluteTime(commit.author?.timestamp)}`;
        frag.appendChild(h);
        frag.appendChild(sub);

        if (!changed.length) {
            frag.appendChild(
                noteEl(state.mode === 'now' ? 'Nothing has changed since this commit.' : 'This commit changed no program files.'),
            );
        }
        for (const e of changed) frag.appendChild(fileSection(e, restorable));
        if (unchanged.length) frag.appendChild(unchangedSection(unchanged));
        diffEl.replaceChildren(frag);
    }

    function fileSection(e, restorable) {
        const details = document.createElement('details');
        details.dataset.pybricksGitHistoryFile = e.path;
        details.open = true;
        Object.assign(details.style, { border: '1px solid #444', borderRadius: '4px', marginBottom: '8px' });

        const summary = document.createElement('summary');
        Object.assign(summary.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            background: '#2d2d30',
            cursor: 'pointer',
            listStyle: 'none',
        });
        const statusColors = {
            added: ['#1f4d2a', '#9fe0a8'],
            deleted: ['#5a1f22', '#f2a0a0'],
            modified: ['#4d3f1f', '#ffe2a8'],
        };
        const [bg, fg] = statusColors[e.status];
        summary.appendChild(badge(e.status, bg, fg));
        const name = document.createElement('span');
        name.textContent = e.path;
        Object.assign(name.style, { fontFamily: 'monospace', flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' });
        summary.appendChild(name);
        const counts = document.createElement('span');
        counts.style.fontSize = '12px';
        counts.appendChild(colored(`+${e.added}`, '#9fe0a8'));
        counts.appendChild(document.createTextNode(' '));
        counts.appendChild(colored(`−${e.deleted}`, '#f2a0a0'));
        summary.appendChild(counts);
        if (e.layoutOnly) summary.appendChild(badge('blocks moved, same code', '#3b3b5c', '#c8c8ff'));
        else if (e.blocksChanged) summary.appendChild(badge('blocks changed', '#3b3b5c', '#c8c8ff'));

        if (restorable.has(e.path)) {
            if (state.protectedPaths.has(e.path)) {
                summary.appendChild(badge('🔒 protected', '#444', '#bbb'));
            } else {
                summary.appendChild(restoreButton(e.path, restorable.get(e.path)));
            }
        }
        details.appendChild(summary);

        const pre = document.createElement('div');
        Object.assign(pre.style, {
            font: '12px monospace',
            whiteSpace: 'pre',
            overflowX: 'auto',
            background: '#1e1e1e',
            padding: '4px 0',
            userSelect: 'text',
        });
        if (e.layoutOnly) {
            pre.appendChild(noteEl('Only the block layout changed; the Python is the same.'));
        } else if (state.wholeFile) {
            for (const op of e.ops) pre.appendChild(diffLine(op));
            if (!e.ops.length) pre.appendChild(noteEl('(empty file)'));
        } else {
            for (const hunk of e.hunks) {
                pre.appendChild(hunkHeader(hunk));
                for (const op of hunk.lines) pre.appendChild(diffLine(op));
            }
        }
        details.appendChild(pre);
        return details;
    }

    function unchangedSection(unchanged) {
        const details = document.createElement('details');
        details.dataset.pybricksGitHistoryUnchanged = '1';
        Object.assign(details.style, { color: '#999', marginTop: '6px' });
        const summary = document.createElement('summary');
        summary.textContent = `${unchanged.length} unchanged ${unchanged.length === 1 ? 'file' : 'files'}`;
        summary.style.cursor = 'pointer';
        details.appendChild(summary);
        const ul = document.createElement('div');
        Object.assign(ul.style, { fontFamily: 'monospace', fontSize: '12px', padding: '4px 0 0 16px' });
        for (const e of unchanged) {
            const li = document.createElement('div');
            li.textContent = e.path;
            ul.appendChild(li);
        }
        details.appendChild(ul);
        return details;
    }

    function hunkHeader(h) {
        const el = document.createElement('div');
        el.textContent = `@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`;
        Object.assign(el.style, { color: '#8fb8ff', background: '#24262b', padding: '2px 8px' });
        return el;
    }

    function diffLine(op) {
        const row = document.createElement('div');
        row.dataset.pybricksGitHistoryLine = op.type;
        const palette = {
            same: ['transparent', '#ccc', ' '],
            add: ['#12331a', '#9fe0a8', '+'],
            del: ['#3a1416', '#f2a0a0', '−'],
        }[op.type];
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '3.5em 3.5em 1.2em 1fr',
            background: palette[0],
            color: palette[1],
        });
        row.appendChild(gutter(op.aLine));
        row.appendChild(gutter(op.bLine));
        const mark = document.createElement('span');
        mark.textContent = palette[2];
        mark.style.userSelect = 'none';
        row.appendChild(mark);
        const text = document.createElement('span');
        text.textContent = op.text + (op.noEol ? '  ⏎ missing' : '');
        row.appendChild(text);
        return row;
    }

    function gutter(n) {
        const el = document.createElement('span');
        el.textContent = n == null ? '' : String(n);
        Object.assign(el.style, { color: '#777', textAlign: 'right', paddingRight: '6px', userSelect: 'none' });
        return el;
    }

    // --- restore ---------------------------------------------------------------------

    // Two clicks: the first turns the button into "Replace current file?" for
    // five seconds, the second writes the file. Overwriting uncommitted edits
    // deserves the pause; the diff beside it shows exactly what is replaced.
    function restoreButton(path, contents) {
        const b = miniBtn('', '');
        b.dataset.pybricksGitHistoryRestore = path;
        b.disabled = state.restoring;
        const arming = state.confirmPath === path;
        b.textContent = arming ? 'Replace current file?' : 'Restore this version';
        b.title = arming ? 'Click again to overwrite the editor copy' : 'Write this version into the editor';
        if (arming) Object.assign(b.style, { background: '#5c3c00', color: '#ffe2a8', borderColor: '#a97800' });
        b.addEventListener('click', (ev) => {
            ev.preventDefault(); // don't toggle the <details>
            ev.stopPropagation();
            if (state.restoring) return;
            if (state.confirmPath !== path) {
                armConfirm(path);
                return;
            }
            clearConfirm();
            void restore(path, contents);
        });
        return b;
    }

    function armConfirm(path) {
        clearConfirm();
        state.confirmPath = path;
        state.confirmTimer = setTimeout(() => {
            state.confirmPath = null;
            state.confirmTimer = null;
            refreshRestoreButtons();
        }, 5000);
        refreshRestoreButtons();
    }

    function clearConfirm() {
        if (state.confirmTimer) clearTimeout(state.confirmTimer);
        state.confirmTimer = null;
        state.confirmPath = null;
        refreshRestoreButtons();
    }

    function refreshRestoreButtons() {
        if (!ui) return;
        for (const b of ui.diff.querySelectorAll('[data-pybricks-git-history-restore]')) {
            const path = b.dataset.pybricksGitHistoryRestore;
            const arming = state.confirmPath === path;
            b.textContent = arming ? 'Replace current file?' : 'Restore this version';
            b.disabled = state.restoring;
            Object.assign(
                b.style,
                arming
                    ? { background: '#5c3c00', color: '#ffe2a8', borderColor: '#a97800' }
                    : { background: '#2d2d30', color: '#ddd', borderColor: '#555' },
            );
        }
    }

    async function restore(path, contents) {
        state.restoring = true;
        refreshRestoreButtons();
        setStatus(`Restoring ${path}…`);
        try {
            const res = await writeOrFallback([{ path, contents }]);
            if (res.reloading) {
                setStatus(`Restored ${path}, reloading…`);
                setTimeout(() => reload(), 800);
                return;
            }
            setStatus(`Restored ${path}`);
            try {
                await afterRestore();
            } catch (err) {
                console.warn('[pybricks-git] post-restore refresh failed:', err);
            }
            state.restoring = false;
            await renderDiff();
        } catch (err) {
            console.error('[pybricks-git] restore failed:', err);
            setStatus(`Couldn't restore ${path}`);
            showError('Restore', err);
        } finally {
            state.restoring = false;
            refreshRestoreButtons();
        }
    }

    // Same contract as menu-panel.js:writeOrFallback — live write through the
    // app first (no reload, the hub stays connected); raw upsert + reload only
    // when the app can't be driven, because a raw write is invisible to it.
    async function writeOrFallback(files) {
        let live;
        try {
            live = await pageRequest('write-files-live', { files });
        } catch (err) {
            live = { live: false, reason: err.message };
        }
        if (live.live) {
            if (live.tabsNotReopened || live.activeNotRestored) {
                console.warn('[pybricks-git] could not fully restore the editor tabs:', {
                    tabsNotReopened: live.tabsNotReopened,
                    activeNotRestored: live.activeNotRestored,
                });
            }
            return { reloading: false };
        }
        console.warn('[pybricks-git] live write unavailable, reloading instead:', live.reason);
        await pageRequest('upsert-files', { files });
        await shell.persist(true);
        return { reloading: true };
    }

    // --- small helpers --------------------------------------------------------------

    function setupNeeded() {
        const wrap = document.createElement('div');
        wrap.dataset.pybricksGitHistorySetup = '1';
        wrap.appendChild(noteEl('Set up GitHub first: sign in from the Pybricks Git extension popup.'));
        const b = miniBtn('Open settings', 'Open the extension popup');
        b.addEventListener('click', async () => {
            try {
                await serverRequest('openPopup');
            } catch (err) {
                setStatus('Click the Pybricks Git icon in the toolbar to sign in');
                console.warn('[pybricks-git] openPopup failed:', err.message);
            }
        });
        wrap.appendChild(b);
        return wrap;
    }

    function setStatus(text) {
        if (ui && ui.status) ui.status.textContent = text;
    }

    function miniBtn(text, title) {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        Object.assign(b.style, {
            background: '#2d2d30',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            padding: '4px 10px',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '13px',
        });
        return b;
    }

    function badge(text, bg, fg) {
        const el = document.createElement('span');
        el.textContent = text;
        Object.assign(el.style, {
            background: bg,
            color: fg,
            borderRadius: '10px',
            padding: '1px 8px',
            fontSize: '11px',
            whiteSpace: 'nowrap',
        });
        return el;
    }

    function colored(text, color) {
        const el = document.createElement('span');
        el.textContent = text;
        el.style.color = color;
        return el;
    }

    function noteEl(text) {
        const el = document.createElement('div');
        el.textContent = text;
        Object.assign(el.style, { color: '#999', fontStyle: 'italic', padding: '4px 8px' });
        return el;
    }

    function firstLine(message) {
        return String(message ?? '').split('\n')[0].trim();
    }

    function relativeTime(tsSeconds, nowMs) {
        if (!tsSeconds) return '';
        const s = Math.max(0, Math.round(nowMs / 1000 - tsSeconds));
        if (s < 60) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
        const d = Math.round(h / 24);
        if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
        const mo = Math.round(d / 30);
        if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
        const y = Math.round(mo / 12);
        return `${y} year${y === 1 ? '' : 's'} ago`;
    }

    function absoluteTime(tsSeconds) {
        if (!tsSeconds) return '';
        try {
            return new Date(tsSeconds * 1000).toLocaleString();
        } catch {
            return '';
        }
    }

    return { open, close, toggle, isOpen, refresh };
}
