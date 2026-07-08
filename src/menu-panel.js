// Floating menu-manager panel (phase 3). makeMenuPanel wires the DOM and
// interactions; the pure parse/generate/analyze helpers come from
// menu-config.js, loaded earlier in the same isolated world.
//
// Classic script — no exports. content.js calls makeMenuPanel({...}).

function makeMenuPanel(deps) {
    const { pageRequest, storageGet, storageSet, reload } = deps;

    let panel = null;
    let pos = { left: 80, top: 80 };

    async function toggle() {
        if (panel) close();
        else await open();
    }

    function isOpen() {
        return !!panel;
    }

    async function open() {
        if (panel) return;
        const saved = await storageGet('menuPanel');
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
            pos = { left: saved.left, top: saved.top };
        }
        panel = buildShell();
        document.body.appendChild(panel);
        clampIntoViewport();
        void persist(true);
        await refresh(); // no-op shell body until the slot-editing task
    }

    function close() {
        if (!panel) return;
        panel.remove();
        panel = null;
        void persist(false);
    }

    function persist(openFlag) {
        return storageSet({ menuPanel: { left: pos.left, top: pos.top, open: openFlag } });
    }

    function clampIntoViewport() {
        pos.left = Math.max(0, Math.min(pos.left, window.innerWidth - 120));
        pos.top = Math.max(0, Math.min(pos.top, window.innerHeight - 60));
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
    }

    function buildShell() {
        const root = document.createElement('div');
        root.dataset.pybricksGitPanel = '1';
        Object.assign(root.style, {
            position: 'fixed',
            left: `${pos.left}px`,
            top: `${pos.top}px`,
            width: '440px',
            maxHeight: '70vh',
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

        const header = document.createElement('div');
        header.dataset.pybricksGitPanelHeader = '1';
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: '#2d2d30',
            borderBottom: '1px solid #555',
            borderRadius: '6px 6px 0 0',
            cursor: 'move',
            userSelect: 'none',
        });
        const title = document.createElement('span');
        title.textContent = 'Robot Menu';
        title.style.fontWeight = 'bold';
        const closeBtn = document.createElement('button');
        closeBtn.dataset.pybricksGitPanelClose = '1';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close';
        Object.assign(closeBtn.style, {
            background: 'none',
            color: '#ddd',
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '14px',
        });
        closeBtn.addEventListener('click', close);
        header.appendChild(title);
        header.appendChild(closeBtn);

        header.addEventListener('pointerdown', (down) => {
            if (down.target.closest('button')) return; // don't hijack the ✕
            down.preventDefault();
            const startLeft = pos.left;
            const startTop = pos.top;
            const move = (ev) => {
                pos.left = Math.max(0, Math.min(startLeft + ev.clientX - down.clientX, window.innerWidth - 120));
                pos.top = Math.max(0, Math.min(startTop + ev.clientY - down.clientY, window.innerHeight - 60));
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

        const body = document.createElement('div');
        body.dataset.pybricksGitPanelBody = '1';
        Object.assign(body.style, {
            overflowY: 'auto',
            padding: '10px 12px',
            flex: '1',
        });

        root.appendChild(header);
        root.appendChild(body);
        return root;
    }

    // Loads editor state and renders the panel body. Filled in by the
    // slot-editing task; the shell just shows a placeholder line.
    async function refresh() {
        const body = panel.querySelector('[data-pybricks-git-panel-body]');
        body.textContent = 'Loading…';
    }

    // Adds a slot for module(.fn) — filled in by the slot-editing task.
    async function addSlot(module, fn, blocks) {
        await open();
    }

    return { toggle, open, close, isOpen, addSlot };
}
