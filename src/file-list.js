// File-list integration (phase 3): a MutationObserver finds the page's file
// list (selectors documented in test/e2e/file-list-dom.md), badges protected
// files, and offers right-click / long-press "Add to menu".
//
// Classic script — no exports. content.js calls makeFileListWatcher({...}).

function makeFileListWatcher(deps) {
    const { pageRequest, storageGet, addSlot } = deps;

    let protectedPaths = new Set();
    let debounceTimer = null;

    async function start() {
        const manifest = await storageGet('lastPullManifest');
        protectedPaths = new Set((manifest && manifest.protected) || []);
        const observer = new MutationObserver(scheduleDecorate);
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleDecorate();
    }

    function scheduleDecorate() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => void decorate().catch(() => {}), 250);
    }

    async function decorate() {
        const rows = await findFileRows();
        for (const { row, path, labelEl } of rows) {
            if (protectedPaths.has(path) && !row.querySelector('[data-pybricks-git-badge]')) {
                const badge = document.createElement('span');
                badge.dataset.pybricksGitBadge = '1';
                badge.textContent = ' 🔒';
                badge.title = "Managed by your coach's repo — edits here won't be committed";
                // Insert as a SIBLING after the name (not inside it): appending
                // into the label span would fold " 🔒" into its textContent and
                // corrupt the path read on the next decorate. The badge stays
                // findable via row.querySelector because it's still in the <li>.
                if (labelEl && labelEl.parentNode) labelEl.after(badge);
                else row.appendChild(badge);
            }
            if (!row.dataset.pybricksGitGestures) {
                row.dataset.pybricksGitGestures = '1';
                attachGestures(row, path);
            }
        }
    }

    // Primary: Blueprint/react-complex-tree structure (test/e2e/file-list-dom.md
    // §1–3). Fallback: match any element whose exact textContent is a known .py
    // path from the editor, so a pybricks-code DOM change degrades to "still
    // works" instead of "silently gone". Returns [{row, path, labelEl}] where
    // `path` equals the IndexedDB path and `row` is the treeitem boundary.
    //
    // GATE: the Explorer panel unmounts whenever it's closed (file-list-dom.md
    // §0), which is the default state and the state after every post-Pull
    // reload. With no panel there are NO file rows anywhere — bail before the
    // fallback, or every settled editor mutation (~250ms while typing) would
    // trigger a list-files round-trip plus a text-walk that can match file
    // names OUTSIDE the tree (e.g. the active file's editor tab) and badge
    // editor chrome.
    async function findFileRows() {
        const rows = [];

        const panel = document.querySelector('div.pb-activities-tabview');
        const tree = document.querySelector('[role="tree"][aria-label="Files"]');
        if (!panel && !tree) return rows;

        if (tree) {
            for (const li of tree.querySelectorAll('li[role="treeitem"]')) {
                const labelEl = li.querySelector('span.bp5-tree-node-label');
                // The label's textContent is the file name, verbatim equal to
                // the IDB path (no trimming needed per the discovery doc).
                const path = labelEl && labelEl.textContent;
                if (!path) continue;
                rows.push({ row: li, path, labelEl });
            }
        }
        if (rows.length) return rows;

        // Fallback — the panel/tree is mounted but the expected row structure
        // yielded nothing (Blueprint bump, class rename). Anchor on the file
        // names the extension already controls via list-files, confined to the
        // panel subtree so editor chrome can never match.
        const scope = tree || panel;
        let listing;
        try {
            listing = await pageRequest('list-files');
        } catch {
            return rows;
        }
        for (const { path } of listing.contents) {
            const match = findElementByExactText(scope, path);
            if (!match) continue;
            const row = match.closest('[role="treeitem"], li') || match;
            rows.push({ row, path, labelEl: match });
        }
        return rows;
    }

    // Innermost element under `root` whose exact trimmed textContent equals
    // `text`. Document order visits parents before children, so overwriting
    // keeps the deepest match in a parent→child chain (file names are unique,
    // so at most one row).
    function findElementByExactText(root, text) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let match = root.textContent.trim() === text ? root : null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent.trim() === text) match = node;
        }
        return match;
    }

    function attachGestures(row, path) {
        row.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            void showMenu(path, ev.clientX, ev.clientY);
        });
        let pressTimer = null;
        row.addEventListener('touchstart', (ev) => {
            clearTimeout(pressTimer);
            const t = ev.touches[0];
            pressTimer = setTimeout(() => void showMenu(path, t.clientX, t.clientY), 600);
        });
        for (const type of ['touchend', 'touchmove', 'touchcancel']) {
            row.addEventListener(type, () => clearTimeout(pressTimer));
        }
    }

    async function showMenu(path, x, y) {
        document.querySelector('[data-pybricks-git-context-menu]')?.remove();
        const listing = await pageRequest('list-files');
        const file = listing.contents.find((c) => c.path === path);
        if (!file) return;
        const info = analyzeProgram(path, file.contents);
        if (!info.module || protectedPaths.has(path)) return;

        const menu = document.createElement('div');
        menu.dataset.pybricksGitContextMenu = '1';
        Object.assign(menu.style, {
            position: 'fixed',
            left: `${Math.min(x, window.innerWidth - 240)}px`,
            top: `${Math.min(y, window.innerHeight - 160)}px`,
            background: '#2d2d30',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            padding: '4px',
            zIndex: 10001,
            font: 'inherit',
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            minWidth: '180px',
        });

        // Single dismissal path for ALL exits (item click, Escape, outside
        // pointerdown) so the capture-phase window listeners always come off
        // with the menu.
        const dismiss = () => {
            menu.remove();
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKey, true);
        };
        const onPointerDown = (ev) => {
            if (!menu.contains(ev.target)) dismiss();
        };
        const onKey = (ev) => {
            if (ev.key === 'Escape') dismiss();
        };

        const entries = [{ label: `Add ${info.module} to menu`, fn: null }];
        for (const method of info.methods) {
            entries.push({ label: `Add ${info.module}.${method}() to menu`, fn: method });
        }
        for (const entry of entries) {
            const btn = document.createElement('button');
            btn.dataset.pybricksGitContextItem = entry.fn ? `${info.module}.${entry.fn}` : info.module;
            btn.textContent = entry.label;
            Object.assign(btn.style, {
                background: 'none', color: '#ddd', border: 'none',
                textAlign: 'left', padding: '6px 10px', cursor: 'pointer', font: 'inherit',
            });
            btn.addEventListener('mouseenter', () => (btn.style.background = '#3d3d40'));
            btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
            btn.addEventListener('click', () => {
                dismiss();
                void addSlot(info.module, entry.fn, entry.fn ? info.isBlocks : false);
            });
            menu.appendChild(btn);
        }

        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKey, true);

        document.body.appendChild(menu);
    }

    return { start };
}
