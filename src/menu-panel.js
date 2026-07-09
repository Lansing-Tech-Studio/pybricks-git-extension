// Floating menu-manager panel (phase 3). makeMenuPanel wires the DOM and
// interactions; the pure parse/generate/analyze helpers come from
// menu-config.js, loaded earlier in the same isolated world.
//
// Classic script — no exports. content.js calls makeMenuPanel({...}).

function makeMenuPanel(deps) {
    // serverRequest is added now for Task 6 (Pull-and-splice); Task 5 only uses
    // pageRequest/storage/reload, but keeping it in the deps contract here lets
    // content.js wire it once.
    const { pageRequest, storageGet, storageSet, reload, serverRequest } = deps;

    let panel = null;
    let pos = { left: 80, top: 80 };
    // state: { menuConfigPath, items, programs, protectedPaths, banner, dirty }
    let state = null;
    // In-flight open() promise (null when idle). A boolean guard let a second
    // caller return early — before `state` was assigned — so addSlot()'s
    // `await open()` could then touch a null `state` and throw. Concurrent
    // callers now await THIS promise, so `state`/`panel` are guaranteed set by
    // the time open() resolves for any of them.
    let opening = null;
    // Dismiss routine for the currently-open display-editor popover, or null.
    // Removes the popover plus its capture-phase window listeners; close() and
    // a reopen both route through it so nothing leaks (see openDisplayEditor).
    let displayEditorDismiss = null;

    async function toggle() {
        if (panel) close();
        else await open();
    }

    function isOpen() {
        return !!panel;
    }

    function open() {
        if (panel) return Promise.resolve();
        if (opening) return opening;
        opening = (async () => {
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
                opening = null;
            }
        })();
        return opening;
    }

    function close() {
        if (!panel) return;
        if (displayEditorDismiss) displayEditorDismiss();
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
        const [listing, manifest, spliceReport] = await Promise.all([
            pageRequest('list-files'),
            storageGet('lastPullManifest'),
            storageGet('spliceReport'),
        ]);
        const menuConfigPath = (manifest && manifest.menuConfig) || 'menu_config.py';
        // No default for teamSetup/setupTemplate: a null teamSetup hides the
        // whole New-program feature (no footer button, no context entry).
        const teamSetup = (manifest && manifest.teamSetup) || null;
        const setupTemplate = (manifest && manifest.setupTemplate) || null;
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
        // The team-setup file the new-program seed is grafted from and the
        // splice source. The manifest can name it even when it's not in the
        // editor yet (kid hasn't Pulled); teamSetupRow null in that case →
        // createProgram/updateSetup tell them to Pull.
        const teamSetupRow = teamSetup
            ? listing.contents.find((c) => c.path === teamSetup) || null
            : null;
        // The team setup's own signature, computed once. Null (or error) → no
        // program can be flagged as "differs" (nothing to compare against).
        const teamSig = teamSetupRow ? setupSignature(teamSetupRow.contents) : null;
        // Keep path+contents on each program (analyzeProgram drops them) so the
        // nudge and the splice have the source to work with.
        const programs = listing.contents
            .filter((c) => c.path !== menuConfigPath && !protectedPaths.has(c.path))
            .map((c) => ({ ...analyzeProgram(c.path, c.contents), path: c.path, contents: c.contents }))
            .filter((p) => p.module)
            .sort((a, b) => a.module.localeCompare(b.module));
        // Splice eligibility + setup-differs nudge. Eligible = a block program
        // that is NOT the team setup or setup template itself (menuConfig and
        // protected paths are already filtered out above). A program "differs"
        // only when BOTH its own and the team setup's signatures parse AND they
        // disagree — an unreadable signature is not "different", so those files
        // are never marked and never spliced (spliceSetup skips them too).
        for (const p of programs) {
            p.spliceEligible = p.isBlocks && p.path !== teamSetup && p.path !== setupTemplate;
            p.setupDiffers = false;
            if (p.spliceEligible && teamSig && !teamSig.error) {
                const sig = setupSignature(p.contents);
                if (!sig.error) p.setupDiffers = sig.signature !== teamSig.signature;
            }
        }
        // Name-collision must consider EVERY editor path, not just menu-eligible
        // programs (a new .py can't shadow a protected/config/non-program file).
        const allPaths = filePaths;
        return {
            menuConfigPath, items, programs, protectedPaths, banner, dirty: false,
            teamSetup, setupTemplate, teamSetupRow, allPaths,
            // Full editor file set — the snapshot commit before a splice sends
            // exactly this (path+contents), and it is the source of truth for
            // what "Before robot setup update" preserves.
            allFiles: listing.contents.map((c) => ({ path: c.path, contents: c.contents })),
            spliceReport: spliceReport || null,
        };
    }

    // --- render ----------------------------------------------------------

    function render() {
        if (!panel) return;
        const body = panel.querySelector('[data-pybricks-git-panel-body]');
        body.textContent = '';

        if (state.spliceReport) body.appendChild(spliceReportBlock(state.spliceReport));
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
        if (state.teamSetup) {
            const newBtn = miniIconButton(
                '+ New program',
                'Start a new block program with your robot setup',
                () => showNewProgramRow(),
            );
            newBtn.dataset.pybricksGitNewProgram = '1';
            footer.appendChild(newBtn);
        }
        // Offer the propagate flow only when there's a team setup to splice from
        // AND at least one program actually differs from it.
        if (state.teamSetupRow && state.programs.some((p) => p.setupDiffers)) {
            const updateBtn = miniIconButton(
                'Update robot setup',
                'Copy the team robot setup into every block program that differs (a safety snapshot is committed first)',
                () => void updateSetup(updateBtn),
            );
            updateBtn.dataset.pybricksGitUpdateSetup = '1';
            footer.appendChild(updateBtn);
        }
        const status = document.createElement('span');
        status.dataset.pybricksGitStatus = '1';
        footer.appendChild(save);
        footer.appendChild(status);
        body.appendChild(footer);
    }

    // --- new program from team setup -------------------------------------

    // Inline name row under the panel body. Guarded against double-open. When
    // the manifest names a teamSetup file the editor doesn't have yet, there's
    // nothing to graft from → tell the kid to Pull instead of showing the row.
    function showNewProgramRow() {
        if (!panel) return;
        if (panel.querySelector('[data-pybricks-git-new-name]')) {
            panel.querySelector('[data-pybricks-git-new-name]').focus();
            return;
        }
        if (!state.teamSetupRow) {
            setStatus(`Pull first — your repo's ${state.teamSetup} isn't in the editor yet.`);
            return;
        }
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '6px', marginTop: '6px' });
        const input = document.createElement('input');
        input.dataset.pybricksGitNewName = '1';
        input.type = 'text';
        input.placeholder = 'program name (letters, digits, _)';
        Object.assign(input.style, {
            flex: '1', padding: '4px 8px', background: '#1e1e1e', color: '#ddd',
            border: '1px solid #555', borderRadius: '4px', font: 'inherit',
        });
        const create = miniIconButton('Create', 'Create the program', () =>
            void createProgram(input.value.trim()),
        );
        create.dataset.pybricksGitNewCreate = '1';
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') void createProgram(input.value.trim());
            if (ev.key === 'Escape') row.remove();
        });
        row.appendChild(input);
        row.appendChild(create);
        panel.querySelector('[data-pybricks-git-panel-body]').appendChild(row);
        input.focus();
    }

    async function createProgram(name) {
        if (!isBareModuleName(name)) {
            setStatus('Names use letters, digits and _ — like mission_03.');
            return;
        }
        const path = name + '.py';
        // Reserved names (config/teamSetup/setupTemplate/protected) plus every
        // path currently in the editor. protectedPaths only holds files that
        // exist; the manifest-named config/setup files are added explicitly so
        // a collision is rejected even when they aren't in the editor yet.
        const reserved = new Set(
            [state.menuConfigPath, state.teamSetup, state.setupTemplate, ...state.protectedPaths]
                .filter(Boolean),
        );
        if (state.allPaths.has(path) || reserved.has(path)) {
            setStatus(`${path} already exists — pick another name.`);
            return;
        }
        // Graft the team's setup chain onto the editor-authored empty-program
        // scaffold so the kid gets a blockGlobalStart to program under. On any
        // splice doubt, write nothing and surface the kid-facing reason.
        const seed = newProgramContents(state.teamSetupRow.contents);
        if (seed.error) {
            setStatus(`Couldn't set up the program: ${seed.error}`);
            return;
        }
        setStatus('Creating…');
        try {
            await pageRequest('upsert-files', { files: [{ path, contents: seed.contents }] });
            await persist(true);
            setStatus(`Created ${path} — reloading…`);
            setTimeout(() => reload(), 800);
        } catch (err) {
            setStatus(`Couldn't create it: ${err.message}`);
        }
    }

    // --- update robot setup (propagate) ----------------------------------

    // Splice the team's robot setup into every block program that differs.
    // NON-NEGOTIABLE SAFETY RAIL: a snapshot commit ("Before robot setup
    // update") MUST land before any editor file is mutated. If the snapshot
    // throws, nothing is spliced and nothing is written — the kid can always
    // get back to exactly what they had.
    async function updateSetup(btn) {
        if (!state.teamSetupRow) {
            setStatus(`Pull first — your repo's ${state.teamSetup} isn't in the editor yet.`);
            return;
        }
        if (btn) btn.disabled = true;
        setStatus('Saving a safety snapshot…');
        // Snapshot the ENTIRE editor tree as it stands now. A "no changes"
        // result (committed:false) means the tree already matches the remote —
        // still safe to proceed. Only a THROW aborts.
        const files = state.allFiles.map(({ path, contents }) => ({ path, contents }));
        try {
            await serverRequest('commit', { files, message: 'Before robot setup update' });
        } catch (err) {
            setStatus(`Couldn't save the safety snapshot — nothing was changed. (${err.message})`);
            if (btn) btn.disabled = false;
            return;
        }
        // Snapshot is safe on the remote — now splice. Each eligible target is
        // a block program that isn't the team setup / setup template itself
        // (menuConfig + protected are already out of state.programs).
        const updated = [];
        const skipped = [];
        for (const p of state.programs) {
            if (!p.spliceEligible) continue;
            const res = spliceSetup(p.contents, state.teamSetupRow.contents);
            if (res.error) { skipped.push({ path: p.path, reason: res.error }); continue; }
            if (res.changed) updated.push({ path: p.path, contents: res.contents });
        }
        if (updated.length) {
            try {
                await pageRequest('upsert-files', {
                    files: updated.map((u) => ({ path: u.path, contents: u.contents })),
                });
            } catch (err) {
                setStatus(`Saved the snapshot, but couldn't write the updates: ${err.message}`);
                if (btn) btn.disabled = false;
                return;
            }
        }
        if (!updated.length && !skipped.length) {
            setStatus('All programs already match.');
            if (btn) btn.disabled = false;
            return;
        }
        const report = { when: new Date().toISOString(), updated: updated.map((u) => u.path), skipped };
        await storageSet({ spliceReport: report });
        if (updated.length) {
            // Editor IDB changed under dexie-observable's back — reload so the
            // app rebuilds from our write (same rule as Save/new-program). The
            // report renders after the reload from the persisted spliceReport.
            await persist(true);
            setStatus(`Updated ${updated.length} program(s)… reloading`);
            setTimeout(() => reload(), 800);
        } else {
            // Only skips — nothing was written, so no reload. Show the report
            // inline so the kid sees why each program was left alone.
            state.spliceReport = report;
            render();
            setStatus(`Couldn't update ${skipped.length} program(s) — see the report above.`);
        }
    }

    // Dismissable summary of the last splice, rendered at the top of the body
    // on open (from the persisted spliceReport) and on the inline skip-only
    // path. Dismiss clears the storage key and re-renders.
    function spliceReportBlock(report) {
        const box = document.createElement('div');
        box.dataset.pybricksGitSpliceReport = '1';
        Object.assign(box.style, {
            border: '1px solid #4a4a4a', background: '#2a2a2d', borderRadius: '4px',
            padding: '8px 10px', margin: '0 0 10px', fontSize: '12px',
        });
        if (report.updated && report.updated.length) {
            const line = document.createElement('div');
            line.textContent = `Robot setup updated in: ${report.updated.join(', ')}`;
            line.style.color = '#9ccc65';
            box.appendChild(line);
        }
        for (const s of report.skipped || []) {
            const line = document.createElement('div');
            line.textContent = `Skipped ${s.path} — ${s.reason}`;
            line.style.color = '#e2b93b';
            box.appendChild(line);
        }
        const dismiss = miniIconButton('Dismiss', 'Hide this report', () => void dismissSpliceReport());
        dismiss.dataset.pybricksGitSpliceReportDismiss = '1';
        dismiss.style.marginTop = '6px';
        box.appendChild(dismiss);
        return box;
    }

    async function dismissSpliceReport() {
        await storageSet({ spliceReport: null });
        state.spliceReport = null;
        render();
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

        // Nudge: this block program's robot setup no longer matches the team's.
        // Only shown when both signatures parse and disagree (see loadState).
        if (p.setupDiffers) {
            const warn = document.createElement('span');
            warn.dataset.pybricksGitSetupDiffers = '1';
            warn.textContent = '⚠ setup differs';
            warn.title = 'This program’s robot setup doesn’t match robot_setup.py — use Update robot setup';
            Object.assign(warn.style, { color: '#e2b93b', fontSize: '12px', whiteSpace: 'nowrap' });
            row.appendChild(warn);
        }

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
        if (displayEditorDismiss) displayEditorDismiss(); // replace any open one
        const pop = document.createElement('div');
        pop.dataset.pybricksGitDisplayEditor = '1';

        // Single dismissal path for ALL exits (Apply, Cancel, Escape, outside
        // pointerdown, panel close) so the capture-phase window listeners
        // always come off with the popover (mirrors file-list.js showMenu).
        const dismiss = () => {
            pop.remove();
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKey, true);
            if (displayEditorDismiss === dismiss) displayEditorDismiss = null;
        };
        const onPointerDown = (ev) => {
            if (!pop.contains(ev.target)) dismiss();
        };
        const onKey = (ev) => {
            if (ev.key === 'Escape') dismiss();
        };
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
            dismiss();
            markDirty();
        });
        const cancel = miniIconButton('Cancel', 'Keep the old display', () => dismiss());
        const buttons = document.createElement('div');
        buttons.style.marginTop = '6px';
        buttons.appendChild(apply);
        buttons.appendChild(cancel);
        pop.appendChild(buttons);

        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKey, true);

        document.body.appendChild(pop);
        displayEditorDismiss = dismiss;
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

    // Open the panel (if needed) and drop straight into the new-program name
    // row — the file-list context menu's "New program from team setup" entry.
    async function newProgram() {
        await open();
        showNewProgramRow();
    }

    return { toggle, open, close, isOpen, addSlot, newProgram };
}
