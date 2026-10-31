// Shared floating-panel shell: a draggable, fixed-position dark panel with a
// title bar, a scrolling body, a footer, a maximize toggle, and a persisted
// position under one chrome.storage.local key. Extracted from menu-panel.js's
// buildShell/drag/persist/clamp; the History panel is its first consumer and
// menu-panel.js will migrate onto it in a follow-up (its persist() is woven
// into the Save race logic and the E2E drivers assert on its attribute names).
//
// Classic script — no exports. Every data attribute is namespaced by `attr`:
// makeFloatingPanel({attr: 'history'}) yields data-pybricks-git-history-panel,
// -panel-header, -panel-body, -panel-footer, -panel-close, -panel-max, so two
// panels never answer the same document-wide selector.

function makeFloatingPanel(opts) {
    const {
        title,
        attr,
        storageKey,
        storageGet,
        storageSet,
        width = 440,
        defaultPos = { left: 80, top: 80 },
        // Called with the extra fields to persist alongside position/open.
        extraState = () => ({}),
        onClose = () => {},
    } = opts;

    const cap = attr.charAt(0).toUpperCase() + attr.slice(1);
    const dataKey = (suffix) => `pybricksGit${cap}${suffix}`;

    let root = null;
    let body = null;
    let footer = null;
    let header = null;
    let pos = { ...defaultPos };
    let maximized = false;
    // In-flight open() promise, so concurrent callers all await the same
    // build (the menu panel learned this the hard way: a boolean guard let a
    // second caller return before the body existed).
    let opening = null;
    // Everything the shell was asked to remember from the last saved state,
    // handed back to the consumer from open() so it can restore its own bits.
    let saved = null;

    function isOpen() {
        return !!root;
    }

    // Opens the panel. `beforeShow` runs after the saved state is read and
    // before the shell is attached, so the consumer can load its state first;
    // it receives the saved record (or null).
    function open(beforeShow) {
        if (root) return Promise.resolve(saved);
        if (opening) return opening;
        opening = (async () => {
            try {
                const rec = await storageGet(storageKey);
                saved = rec && typeof rec === 'object' ? rec : null;
                if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                    pos = { left: saved.left, top: saved.top };
                }
                maximized = Boolean(saved && saved.maximized);
                if (beforeShow) await beforeShow(saved);
                buildShell();
                document.body.appendChild(root);
                applyGeometry();
                void persist(true);
                return saved;
            } finally {
                opening = null;
            }
        })();
        return opening;
    }

    function close() {
        if (!root) return;
        onClose();
        root.remove();
        root = null;
        body = null;
        footer = null;
        header = null;
        void persist(false);
    }

    async function toggle() {
        if (root) close();
        else await open();
    }

    function persist(openFlag) {
        return storageSet({
            [storageKey]: { left: pos.left, top: pos.top, open: openFlag, maximized, ...extraState() },
        });
    }

    function clampPos() {
        pos.left = Math.max(0, Math.min(pos.left, window.innerWidth - 120));
        pos.top = Math.max(0, Math.min(pos.top, window.innerHeight - 60));
    }

    function applyGeometry() {
        if (!root) return;
        if (maximized) {
            Object.assign(root.style, {
                left: '12px',
                top: '48px',
                width: 'calc(100vw - 24px)',
                height: 'calc(100vh - 60px)',
                maxHeight: 'calc(100vh - 60px)',
            });
        } else {
            clampPos();
            Object.assign(root.style, {
                left: `${pos.left}px`,
                top: `${pos.top}px`,
                width: `${width}px`,
                height: '',
                maxHeight: '80vh',
            });
        }
        const max = root.querySelector(`[data-pybricks-git-${attr}-panel-max]`);
        if (max) {
            max.textContent = maximized ? '⤡' : '⤢';
            max.title = maximized ? 'Restore size' : 'Maximize';
        }
    }

    function setMaximized(flag) {
        maximized = Boolean(flag);
        applyGeometry();
        void persist(true);
    }

    // Raise this panel above any sibling panel (both share zIndex 10000 by
    // default; the most recently clicked one wins).
    function bringToFront() {
        if (!root) return;
        for (const other of document.querySelectorAll('[data-pybricks-git-floating-panel]')) {
            other.style.zIndex = '10000';
        }
        root.style.zIndex = '10001';
    }

    function buildShell() {
        root = document.createElement('div');
        root.dataset[dataKey('Panel')] = '1';
        root.dataset.pybricksGitFloatingPanel = '1';
        Object.assign(root.style, {
            position: 'fixed',
            maxWidth: 'calc(100vw - 24px)',
            display: 'flex',
            flexDirection: 'column',
            background: '#252526',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '6px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            font: 'inherit',
            fontSize: '13px',
            zIndex: 10000,
        });
        root.addEventListener('pointerdown', bringToFront, { capture: true });

        header = document.createElement('div');
        header.dataset[dataKey('PanelHeader')] = '1';
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            padding: '8px 12px',
            background: '#2d2d30',
            borderBottom: '1px solid #555',
            borderRadius: '6px 6px 0 0',
            cursor: 'move',
            userSelect: 'none',
            flexShrink: '0',
        });
        const titleEl = document.createElement('span');
        titleEl.textContent = title;
        titleEl.style.fontWeight = 'bold';
        titleEl.style.flex = '1';

        const maxBtn = headerButton(dataKey('PanelMax'), '⤢', 'Maximize', () => setMaximized(!maximized));
        const closeBtn = headerButton(dataKey('PanelClose'), '✕', 'Close', close);
        header.appendChild(titleEl);
        header.appendChild(maxBtn);
        header.appendChild(closeBtn);

        header.addEventListener('pointerdown', (down) => {
            if (down.target.closest('button')) return; // don't hijack the buttons
            if (maximized) return;
            down.preventDefault();
            const startLeft = pos.left;
            const startTop = pos.top;
            const move = (ev) => {
                pos.left = startLeft + ev.clientX - down.clientX;
                pos.top = startTop + ev.clientY - down.clientY;
                clampPos();
                root.style.left = `${pos.left}px`;
                root.style.top = `${pos.top}px`;
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                void persist(true);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });
        header.addEventListener('dblclick', (ev) => {
            if (ev.target.closest('button')) return;
            setMaximized(!maximized);
        });

        body = document.createElement('div');
        body.dataset[dataKey('PanelBody')] = '1';
        Object.assign(body.style, {
            overflowY: 'auto',
            padding: '10px 12px',
            flex: '1',
            minHeight: '0',
        });

        footer = document.createElement('div');
        footer.dataset[dataKey('PanelFooter')] = '1';
        Object.assign(footer.style, {
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            flexShrink: '0',
            padding: '8px 12px',
            borderTop: '1px solid #444',
            background: '#2d2d30',
            borderRadius: '0 0 6px 6px',
        });

        root.appendChild(header);
        root.appendChild(body);
        root.appendChild(footer);
    }

    function headerButton(key, text, titleText, onClick) {
        const b = document.createElement('button');
        b.dataset[key] = '1';
        b.textContent = text;
        b.title = titleText;
        Object.assign(b.style, {
            background: 'none',
            color: '#ddd',
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '14px',
            padding: '0 4px',
        });
        b.addEventListener('click', onClick);
        return b;
    }

    return {
        open,
        close,
        toggle,
        isOpen,
        persist,
        setMaximized,
        isMaximized: () => maximized,
        get root() {
            return root;
        },
        get body() {
            return body;
        },
        get footer() {
            return footer;
        },
        get header() {
            return header;
        },
    };
}
