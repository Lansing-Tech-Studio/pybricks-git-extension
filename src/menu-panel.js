// Floating menu-manager panel (phase 3). makeMenuPanel wires the DOM and
// interactions; the pure parse/generate/analyze helpers come from
// menu-config.js, loaded earlier in the same isolated world.
//
// Classic script — no exports. content.js calls makeMenuPanel({...}).

function makeMenuPanel(deps) {
    const { pageRequest, storageGet, storageSet, reload } = deps;

    let panel = null;
    let pos = { left: 80, top: 80 };
    // state: { menuConfigPath, items, programs, protectedPaths, banner, dirty }
    let state = null;
    // Synchronous re-entrancy guard: set BEFORE the first await so two
    // interleaved open() calls can't both build a panel (the `if (panel)` check
    // alone races across the awaits below).
    let opening = false;

    async function toggle() {
        if (panel) close();
        else await open();
    }

    function isOpen() {
        return !!panel;
    }

    async function open() {
        if (panel || opening) return;
        opening = true;
        try {
            const saved = await storageGet('menuPanel');
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                pos = { left: saved.left, top: saved.top };
            }
            state = await loadState();
            panel = buildShell();
            document.body.appendChild(panel);
            clampIntoViewport();
            void persist(true);
            render();
        } finally {
            opening = false;
        }
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

    // --- state loading ---------------------------------------------------

    async function loadState() {
        const [listing, manifest] = await Promise.all([
            pageRequest('list-files'),
            storageGet('lastPullManifest'),
        ]);
        const menuConfigPath = (manifest && manifest.menuConfig) || 'menu_config.py';
        const filePaths = new Set(listing.contents.map((c) => c.path));
        // Manifests can name paths that aren't in the editor — only badge/hide
        // files that actually exist.
        const protectedPaths = new Set(
            ((manifest && manifest.protected) || []).filter((p) => filePaths.has(p)),
        );
        let items = [];
        let banner = '';
        const configRow = listing.contents.find((c) => c.path === menuConfigPath);
        if (!configRow) {
            banner = `${menuConfigPath} doesn't exist yet — Save will create it.`;
        } else {
            const parsed = parseMenuConfig(configRow.contents);
            if (parsed.error) {
                banner = `Couldn't read ${menuConfigPath} (${parsed.error}). Saving will rewrite it from scratch.`;
            } else {
                items = parsed.items;
            }
        }
        const programs = listing.contents
            .filter((c) => c.path !== menuConfigPath && !protectedPaths.has(c.path))
            .map((c) => analyzeProgram(c.path, c.contents))
            .filter((p) => p.module)
            .sort((a, b) => a.module.localeCompare(b.module));
        return { menuConfigPath, items, programs, protectedPaths, banner, dirty: false };
    }

    // --- render ----------------------------------------------------------

    function render() {
        const body = panel.querySelector('[data-pybricks-git-panel-body]');
        body.textContent = '';

        if (state.banner) body.appendChild(noteEl(state.banner));

        body.appendChild(sectionTitle('Menu slots (drag to reorder)'));
        const slots = document.createElement('div');
        slots.dataset.pybricksGitSlots = '1';
        state.items.forEach((item, index) => slots.appendChild(slotRow(item, index)));
        if (!state.items.length) slots.appendChild(noteEl('No slots yet — add a program below.'));
        body.appendChild(slots);

        body.appendChild(sectionTitle('Programs you can add'));
        const programs = document.createElement('div');
        programs.dataset.pybricksGitPrograms = '1';
        for (const p of state.programs) {
            programs.appendChild(programRow(p));
        }
        if (!state.programs.length) programs.appendChild(noteEl('No programs found — Pull first?'));
        body.appendChild(programs);

        const footer = document.createElement('div');
        Object.assign(footer.style, {
            display: 'flex', gap: '8px', alignItems: 'center',
            paddingTop: '10px', borderTop: '1px solid #444', marginTop: '10px',
        });
        const save = document.createElement('button');
        save.dataset.pybricksGitSave = '1';
        save.textContent = state.dirty ? 'Save menu' : 'Saved';
        save.disabled = !state.dirty;
        styleMiniButton(save);
        save.addEventListener('click', () => void saveConfig(save));
        const status = document.createElement('span');
        status.dataset.pybricksGitStatus = '1';
        footer.appendChild(save);
        footer.appendChild(status);
        body.appendChild(footer);
    }

    // Section heading inside the panel body.
    function sectionTitle(text) {
        const el = document.createElement('div');
        el.textContent = text;
        Object.assign(el.style, {
            fontWeight: 'bold',
            margin: '10px 0 4px',
            color: '#bbb',
        });
        return el;
    }

    // Muted informational / empty-state line.
    function noteEl(text) {
        const el = document.createElement('div');
        el.textContent = text;
        Object.assign(el.style, {
            color: '#999',
            fontStyle: 'italic',
            padding: '4px 0',
        });
        return el;
    }

    // Shared button look (matches the panel's dark chrome).
    function styleMiniButton(btn) {
        Object.assign(btn.style, {
            background: '#2d2d30',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            padding: '4px 10px',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '13px',
        });
    }

    // --- slot rows -------------------------------------------------------

    function slotRow(item, index) {
        const row = document.createElement('div');
        row.dataset.pybricksGitSlot = String(index);
        row.draggable = true;
        Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '5px 6px', margin: '2px 0',
            background: '#2d2d30', border: '1px solid #444', borderRadius: '4px',
            opacity: item.enabled === false ? '0.5' : '1',
        });

        // HTML5 drag-to-reorder: remember the source index on dragstart, move
        // the item on drop over another row.
        row.addEventListener('dragstart', (ev) => {
            ev.dataTransfer.setData('text/plain', String(index));
            ev.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('drop', (ev) => {
            ev.preventDefault();
            const from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
            if (Number.isNaN(from) || from === index) return;
            moveSlot(from, index);
        });

        const grip = document.createElement('span');
        grip.textContent = '≡';
        grip.style.cursor = 'grab';
        row.appendChild(grip);

        const displayBtn = document.createElement('button');
        displayBtn.dataset.pybricksGitSlotDisplay = '1';
        displayBtn.textContent = displayLabel(item.display);
        displayBtn.title = 'Change what the hub shows for this slot';
        styleMiniButton(displayBtn);
        displayBtn.style.minWidth = '44px';
        displayBtn.addEventListener('click', () => openDisplayEditor(displayBtn, item));
        row.appendChild(displayBtn);

        const label = document.createElement('span');
        label.style.flex = '1';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        label.textContent = item.function
            ? `${item.module}.${item.function}()${item.blocks ? ' [blocks]' : ''}`
            : `${item.module} (whole program)`;
        row.appendChild(label);

        const up = miniIconButton('▲', 'Move up', () => moveSlot(index, index - 1));
        up.dataset.pybricksGitSlotUp = '1';
        up.disabled = index === 0;
        const down = miniIconButton('▼', 'Move down', () => moveSlot(index, index + 1));
        down.dataset.pybricksGitSlotDown = '1';
        down.disabled = index === state.items.length - 1;
        row.appendChild(up);
        row.appendChild(down);

        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.dataset.pybricksGitSlotEnabled = '1';
        enabled.checked = item.enabled !== false;
        enabled.title = 'Show this slot in the menu';
        enabled.addEventListener('change', () => {
            if (enabled.checked) delete item.enabled;
            else item.enabled = false;
            markDirty();
        });
        row.appendChild(enabled);

        const remove = miniIconButton('✕', 'Remove this slot', () => {
            state.items.splice(index, 1);
            markDirty();
        });
        remove.dataset.pybricksGitSlotRemove = '1';
        row.appendChild(remove);

        return row;
    }

    function moveSlot(from, to) {
        if (to < 0 || to >= state.items.length) return;
        const [item] = state.items.splice(from, 1);
        state.items.splice(to, 0, item);
        markDirty();
    }

    function markDirty() {
        state.dirty = true;
        render();
    }

    function displayLabel(display) {
        if (Array.isArray(display)) return '▦';
        return String(display);
    }

    function miniIconButton(text, title, onClick) {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        styleMiniButton(b);
        b.style.padding = '2px 6px';
        b.addEventListener('click', onClick);
        return b;
    }

    // --- program rows ----------------------------------------------------

    function programRow(p) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
            padding: '4px 6px', margin: '2px 0',
        });
        const name = document.createElement('span');
        name.textContent = p.module + (p.isBlocks ? ' 🧩' : '');
        name.title = p.isBlocks ? 'Block program' : 'Python program';
        name.style.flex = '1';
        row.appendChild(name);

        const addWhole = miniIconButton('+ program', `Run all of ${p.module}`, () =>
            void addSlot(p.module, null, false),
        );
        addWhole.dataset.pybricksGitAdd = p.module;
        row.appendChild(addWhole);

        for (const fn of p.methods) {
            const addFn = miniIconButton(`+ ${fn}()`, `Run just ${fn}() from ${p.module}`, () =>
                void addSlot(p.module, fn, p.isBlocks),
            );
            addFn.dataset.pybricksGitAdd = `${p.module}.${fn}`;
            row.appendChild(addFn);
        }
        return row;
    }

    // Also called by the file-list context menu ("Add to menu").
    async function addSlot(module, fn, blocks) {
        await open();
        const item = { display: nextFreeDisplayNumber(state.items), module };
        if (fn) item.function = fn;
        if (blocks) item.blocks = true;
        state.items.push(item);
        markDirty();
    }

    // --- display editor popover ------------------------------------------

    function openDisplayEditor(anchorBtn, item) {
        document.querySelector('[data-pybricks-git-display-editor]')?.remove();
        const pop = document.createElement('div');
        pop.dataset.pybricksGitDisplayEditor = '1';
        const rect = anchorBtn.getBoundingClientRect();
        Object.assign(pop.style, {
            position: 'fixed',
            left: `${Math.min(rect.left, window.innerWidth - 240)}px`,
            top: `${rect.bottom + 4}px`,
            width: '220px',
            padding: '10px',
            background: '#2d2d30',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            zIndex: 10001,
            font: 'inherit',
            fontSize: '13px',
        });

        // Mode radios
        const current = item.display;
        let mode = Array.isArray(current) ? 'pattern' : typeof current === 'string' ? 'char' : 'number';

        const numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.min = '0';
        numberInput.max = '99';
        numberInput.value = typeof current === 'number' ? String(current) : '1';

        const charInput = document.createElement('input');
        charInput.type = 'text';
        charInput.maxLength = 1;
        charInput.value = typeof current === 'string' ? current : 'A';

        // 5x5 grid of toggle cells
        const pattern = Array.isArray(current)
            ? current.map((row) => row.split(''))
            : Array.from({ length: 5 }, () => Array(5).fill(' '));
        const grid = document.createElement('div');
        Object.assign(grid.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 24px)',
            gap: '2px',
        });
        pattern.forEach((rowChars, r) => {
            rowChars.forEach((ch, c) => {
                const cell = document.createElement('button');
                const isOn = () => pattern[r][c] !== ' ' && pattern[r][c] !== '0';
                const paint = () => {
                    cell.style.background = isOn() ? '#e9b64d' : '#1e1e1e';
                };
                Object.assign(cell.style, {
                    width: '24px', height: '24px',
                    border: '1px solid #555', borderRadius: '3px', cursor: 'pointer',
                });
                paint();
                cell.addEventListener('click', () => {
                    pattern[r][c] = isOn() ? ' ' : '#';
                    paint();
                });
                grid.appendChild(cell);
            });
        });

        const sections = [
            ['number', 'Number (0–99)', numberInput],
            ['char', 'One character', charInput],
            ['pattern', '5×5 picture', grid],
        ];
        for (const [value, labelText, control] of sections) {
            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.margin = '4px 0';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'pybricks-git-display-mode';
            radio.value = value;
            radio.checked = mode === value;
            radio.addEventListener('change', () => { mode = value; });
            label.appendChild(radio);
            label.appendChild(document.createTextNode(' ' + labelText));
            pop.appendChild(label);
            control.style.margin = '2px 0 6px 20px';
            pop.appendChild(control);
        }

        const apply = miniIconButton('Apply', 'Use this display', () => {
            let next;
            if (mode === 'number') next = parseInt(numberInput.value, 10);
            else if (mode === 'char') next = charInput.value;
            else next = pattern.map((rowChars) => rowChars.join(''));
            const problem = validateDisplay(next);
            if (problem) {
                apply.textContent = problem;
                setTimeout(() => (apply.textContent = 'Apply'), 2500);
                return;
            }
            item.display = next;
            pop.remove();
            markDirty();
        });
        const cancel = miniIconButton('Cancel', 'Keep the old display', () => pop.remove());
        const buttons = document.createElement('div');
        buttons.style.marginTop = '6px';
        buttons.appendChild(apply);
        buttons.appendChild(cancel);
        pop.appendChild(buttons);

        document.body.appendChild(pop);
    }

    // --- save ------------------------------------------------------------

    // Save = regenerate the whole file and upsert ONLY that path. Always
    // reload afterwards: dexie-observable can't see raw IDB writes, and if
    // menu_config.py is open in Monaco a stale buffer would clobber this save
    // on the app's next write. The persisted open flag reopens the panel.
    async function saveConfig(saveBtn) {
        for (const [i, item] of state.items.entries()) {
            const problem = validateItem(item);
            if (problem) {
                setStatus(`Slot ${i + 1}: ${problem}`);
                return;
            }
        }
        saveBtn.disabled = true;
        setStatus('Saving…');
        try {
            const text = generateMenuConfig(state.items);
            await pageRequest('upsert-files', {
                files: [{ path: state.menuConfigPath, contents: text }],
            });
            await persist(true);
            setStatus('Saved ✓ — reloading…');
            setTimeout(() => reload(), 800);
        } catch (err) {
            console.error('[pybricks-git] menu save failed:', err);
            setStatus(`Save failed: ${err.message}`);
            saveBtn.disabled = false;
        }
    }

    function setStatus(text) {
        const status = panel && panel.querySelector('[data-pybricks-git-status]');
        if (status) status.textContent = text;
    }

    return { toggle, open, close, isOpen, addSlot };
}
