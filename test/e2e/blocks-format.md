# code.pybricks.com block-file format & Python-regeneration behavior

Empirical discovery for **Phase 4 — new-program-from-template + setup splice**.
Later tasks build a "setup splicer" that edits a block file's line-1 workspace
JSON (`blockGlobalSetup` chain) and rewrites the generated-Python
`# Set up …` section, so it codes against the facts documented here.

**Everything below was observed live**, driving the unpacked extension in
headless Chromium against `https://code.pybricks.com` with scratchpad probes
patterned on `test/e2e/drive.mjs` (LNA-disable flags, trusted CDP input, the
`upsert-files` bridge op to seed files, `location.reload()` to surface them,
`list-files` to re-read IndexedDB, and the Explorer/file-row selectors from
`test/e2e/file-list-dom.md`).

- **Observed:** 2026-07-08
- **Browser:** HeadlessChrome/141.0.0.0 (`Chrome/141`), Playwright
  `chromium-1194` under `~/.cache/ms-playwright`.
- **pybricks-code build:** not surfaced as a version string in the DOM, **but
  the editor stamps `info.version` into every block file it saves — the current
  deployed build writes `"version":"2.0.0"`.** The two harvested team fixtures
  (`blocks-demo.py`, `blocks-team2.py`) were authored by an **older** build that
  wrote `"version":"1.3.2"`. Tie any regression re-check to the date above and
  to this version drift.

The four fixtures this doc references live in `test/fixtures/`:

| fixture | origin | `info.version` | marker | notes |
|---|---|---|---|---|
| `blocks-demo.py` | verbatim team file (`../pybricks-demo/blocks.py`) | 1.3.2 | `# Set up all devices.` | full program: setup + start + `run_task`/`multitask` |
| `blocks-team2.py` | verbatim team file (`../pybricks-demo/team2testing.py`) | 1.3.2 | `# Set up all devices.` | setup + start, flat (no `run_task`) |
| `setup-only.py` | **editor-regenerated** (derived, then opened in the editor) | 2.0.0 | `# Set up.` | `blockGlobalSetup` chain only, no start block |
| `empty-program.py` | **editor-created** via the new-file dialog | 2.0.0 | *(none)* | brand-new blocks program |

---

## Q1 — Regeneration semantics (LOAD-BEARING)

**When a block file is opened in the editor, does it regenerate the Python below
line 1 and persist it back to IndexedDB?**

**YES — on open, and it also re-serializes line 1.** Opening a file (trusted
click on its Explorer row) makes the editor deserialize the line-1 workspace JSON
into Blockly, **regenerate the entire Python body from the blocks**, re-serialize
the workspace, and **persist both back to IndexedDB through the app's own Dexie
writes** (so our raw `list-files` re-read sees the new bytes). No manual edit is
required; merely activating the file triggers it.

### Evidence

We upserted `blocks-demo.py` with a **deliberately perturbed** Python body:
setup lines reordered (`left_wheel` before `prime_hub`), the marker mangled to
`# Set up all devices. PERTURBED-BY-PROBE`, and an **unused**
`from pybricks.parameters import Color` import injected. Line 1 was left
untouched. After a reload + one trusted click on the row, re-reading IndexedDB
showed **every perturbation gone**:

```diff
- from pybricks.parameters import Color  # UNUSED-BY-PROBE   (injected)
- from pybricks.parameters import Axis, Direction, Port, Stop
+ from pybricks.parameters import Axis, Direction, Port, Stop  (Color dropped, merged)
- # Set up all devices. PERTURBED-BY-PROBE
+ # Set up.                                                    (canonical marker)
- left_wheel = Motor(Port.F, Direction.COUNTERCLOCKWISE)
- prime_hub  = PrimeHub(top_side=Axis.Z, front_side=Axis.X)
+ prime_hub  = PrimeHub(top_side=Axis.Z, front_side=Axis.X)    (block-chain order restored)
+ left_wheel = Motor(Port.F, Direction.COUNTERCLOCKWISE)
```

**Line 1 is also rewritten.** Block IDs, variable IDs, and block structure are
preserved byte-for-byte, but the editor:

- bumps `info.version` `"1.3.2"` → `"2.0.0"`, and
- appends a `workspaceOptions` object:
  `…,"info":{"type":"pybricks","version":"2.0.0"},"workspaceOptions":{"scrollX":0,"scrollY":0,"scale":1}}`

So opening any of the two v1.3.2 team fixtures **mutates them** (version bump +
`workspaceOptions` + marker change) even with zero user edits.

### Timing

The persist is **debounced**. Re-reading IndexedDB **1.8 s** after opening still
showed the pre-open bytes; at **4 s** (and reliably at **7 s**) the regenerated
bytes were present. A commit fired immediately after opening a file could race
this write — allow a few seconds, or don't depend on it.

---

## Q2 — Empty-program shape

Created a brand-new program through the editor's **own** new-file dialog (not a
raw upsert): Explorer → "Create a new file" button (the `.pb-explorer-header-
toolbar[role=toolbar]` "File Actions" toolbar). The dialog is a
`.bp5-dialog[role=dialog]` inside a `.bp5-portal > .bp5-overlay`; the **"Code
with blocks"** radio (`input[value="pybricks-blocks"]`) is **checked by
default**, the name input is `input.bp5-input[aria-label="File name"]` (a `.py`
tag is auto-appended), and submit is `button[type=submit]` ("Create", disabled
until a name is typed). See `test/fixtures/empty-program.py` for the verbatim
IndexedDB dump.

**Structure of a fresh blocks program:**

- Line-1 JSON has **two** top-level blocks:
  - `blockGlobalSetup` — **present but EMPTY**: `deletable:false` and it has
    **no `next` key at all** (an empty setup chain omits `next`, it is not
    `"next":null`).
  - `blockGlobalStart` — `deletable:false`, chained to a default
    `blockPrint "Hello, Pybricks!"`.
- `variables`: the **10 default `ColorDef`** entries (red…none), always seeded
  with fresh 20-char IDs.
- `info.version:"2.0.0"`, `workspaceOptions` present.

**Generated Python of the empty/default program (verbatim):**

```python
# The main program starts here.
print('Hello, Pybricks!')
```

So a program with an **empty setup**: **no imports** (nothing is used), **no
`# Set up.` section at all** (an empty `blockGlobalSetup` generates nothing), and
**no `run_task(...)` / no `async def main`** — the start block emits flat
top-level statements under `# The main program starts here.`. (`run_task` +
`async def` wrappers appear only when the program uses async constructs such as
`multitask`, as in `blocks-demo.py`; `blocks-team2.py`, also start-only-flat,
likewise has no `run_task`.)

---

## Q3 — Derived setup-only file: acceptance & regeneration

Built a best-guess `setup-only.py` by JSON surgery on `blocks-demo.py`: keep
**only** the `blockGlobalSetup` top-level block (drop `blockGlobalStart` and the
extra `blockImuConfigure`), keep the full 15-entry `variables` array, keep
`info`; hand-write a Python body (imports the chain needs + `# Set up all
devices.` + the five setup lines). Upserted it, reloaded, opened it in the
editor.

- **It loaded cleanly — no error toast and no dialog** (`.bp5-toast` /
  `.bp5-dialog` scan returned empty after open). A file with a setup chain and
  **no start block** is accepted.
- The editor **regenerated** it (per Q1). The committed
  `test/fixtures/setup-only.py` is that **editor-produced** output.

**Divergence between the best-guess and the editor's regeneration:**

| aspect | best-guess (input) | editor output (committed fixture) |
|---|---|---|
| marker comment | `# Set up all devices.` | `# Set up.` |
| `info.version` | `1.3.2` | `2.0.0` |
| `workspaceOptions` | absent | added (`scrollX/scrollY/scale`) |
| import lines | 4 lines, correct order & names | **identical** |
| setup statements | 5 lines, correct order & values | **identical** |

So the **body** (imports + setup statements) I hand-generated matched the
editor's output exactly; only the **marker string** and the line-1
version/`workspaceOptions` metadata differed. The editor emits **no** `# The main
program starts here.` line and **no** trailing statements for a start-less file —
just the imports and the `# Set up.` block.

> Note: the committed fixture's `workspaceOptions.scrollY` is
> `5.684341886080802e-14` (a Blockly float-rounding artifact ≈ 0). That is
> genuine editor output, left verbatim; treat `workspaceOptions` numbers as
> free-floating, never as exact `0`.

---

## Q4 — Import-line rules (observed)

From `blocks-demo.py` (the richest sample) and the Q1 regeneration:

- **Module (line) order is fixed by package, not alphabetical:**
  `pybricks.hubs` → `pybricks.parameters` → `pybricks.pupdevices` →
  `pybricks.robotics` → `pybricks.tools`.

  ```python
  from pybricks.hubs import PrimeHub
  from pybricks.parameters import Axis, Direction, Port, Stop
  from pybricks.pupdevices import Motor
  from pybricks.robotics import DriveBase
  from pybricks.tools import multitask, run_task, wait
  ```

- **Names within a line are alphabetical:** `Axis, Direction, Port, Stop`;
  `multitask, run_task, wait`.
- **A module line appears only if something from it is used.** `blocks-team2.py`
  (no async) has **no `pybricks.tools` line**; `setup-only.py` and
  `empty-program.py` (no devices) have **no imports at all**.
- **Unused imports are dropped on regeneration** — the injected `Color` import
  (Q1) was removed. One line per module; the editor merges (it did **not** keep
  a second `from pybricks.parameters import …`).
- `Stop` is imported by `blocks-demo.py`/`blocks-team2.py` because their **start**
  blocks use it; the setup chain alone does **not** pull in `Stop` (see
  `setup-only.py` — `Axis, Direction, Port` only).

---

## Q5 — ID rules (observed)

- **All Blockly block IDs and variable IDs are 20-character opaque strings**
  (verified across every ID in all four fixtures — the set of lengths is exactly
  `{20}`). They use a punctuation-heavy alphabet (e.g.
  `bjK,wS1MYO7aiYkFSwd{`, `^l)pZ_-A$[,Fyw0n?GOP`), **not** RFC-4122 and not
  restricted to `[A-Za-z0-9]` — treat them as opaque; do not parse or validate
  their charset.
- **Two files freely share block IDs.** `blocks-demo.py` and `blocks-team2.py`
  **both** carry `blockGlobalSetup` id `bjK,wS1MYO7aiYkFSwd{` and
  `blockGlobalStart` id `3tJe|AWl0baN(wH9a$@.` (these are the editor's fixed
  template IDs for the two undeletable anchor blocks). Both files were seeded and
  **opened in the same session with no error** — IDs are **workspace-local**, so
  the splicer may reuse a template's block IDs across files without collision.
- **Within a file, variable references must resolve.** A block's
  `fields.VAR.id` (and the `id` inside a `variables_get_*` shadow's
  `fields.VAR`) points at an entry in that file's top-level `variables[]` by
  `id`. When the splicer swaps in a new setup chain, every `VAR.id` it introduces
  **must** have a matching `variables[]` entry in the same file (the spec's
  "variable-ID remap by name" rail).

---

## Consequences for the setup splicer (`spliceSetup`)

1. **Line-1 JSON is the source of truth; the Python body self-heals.** Because
   the editor regenerates the Python from the blocks **on next open** (Q1), the
   splicer's Python rewrite does **not** have to be byte-perfect for
   *correctness* — the moment a student opens the spliced file, the editor
   rewrites the body from the `blockGlobalSetup` chain. **Get the line-1
   `blockGlobalSetup` chain (and matching `variables[]`) exactly right; the
   Python is downstream of it.**

2. **…but the committed Python still matters until that open.** Between the
   splice-commit and the next editor open, the checked-in Python is what a
   teammate reads in git and what would run if executed directly. So the Python
   rewrite should be a **best-effort faithful** regeneration (to keep the git
   diff small and the file runnable), even though it is not the correctness
   backstop. Q3 shows a hand-generated body can match the editor's output
   exactly for a setup section.

3. **Do not hard-code the marker string.** The setup marker is **version-
   dependent**: `# Set up all devices.` (v1.3.2 files) vs `# Set up.` (current
   v2.0.0 editor). Locate the setup section by a tolerant anchor (regex matching
   either `# Set up all devices.` or `# Set up.`, bounded by the next blank line
   / `# The main program starts here.` / EOF), never by an exact literal. Same
   caution for the start marker `# The main program starts here.`.

4. **A setup-only file has no start marker and no `run_task`.** When the target
   is a setup-only file, the region to replace runs from the `# Set up …` marker
   to end-of-imports-block boundary; there is no trailing start section. When the
   target is a full program (demo-shaped), the setup section ends at the blank
   line before `# The main program starts here.` (or before the first
   `async def` / `run_task`).

5. **Rewrite imports as a set, not by patching lines.** Since the editor drops
   unused imports and merges per-module lines alphabetically (Q4), the splicer
   should recompute the whole import block from the union of what the spliced
   setup needs (order: hubs, parameters, pupdevices, robotics, tools; names
   alphabetical within a line; omit empty modules) rather than string-inserting
   into the existing block.

6. **Expect and tolerate version drift in line 1.** Read-modify-write the JSON;
   do **not** assume `workspaceOptions` exists (v1.3.2 files lack it) and do
   **not** assume `info.version`. Preserve whatever is there for keys you don't
   touch; the editor will re-stamp version/`workspaceOptions` on next open
   anyway.

7. **The empty-program template is a safe "new program" seed.** `empty-program.py`
   is exactly what the editor's own new-file dialog produces for a blocks program
   (empty `blockGlobalSetup` with no `next`, default `blockGlobalStart` +
   `blockPrint`, 10 default ColorDef vars). Phase-4's "new-program-from-template"
   can start from this shape and splice the team setup chain into the empty
   `blockGlobalSetup` (add a `next` pointing at the first `variables_set_*`
   block).

---

## Appendix: how to reproduce

Three throwaway probes (scratchpad, not committed), each launching Playwright
Chromium with the LNA-disable flags and the unpacked extension:

- **probe 1** — upsert a perturbed `blocks-demo.py` + `blocks-team2.py` +
  best-guess `setup-only.py`; reload; open each via the Explorer; re-read
  IndexedDB and diff (Q1, Q4, Q5).
- **probe 2** — re-open `setup-only.py` with a 7 s wait + file-switch nudge to
  capture the editor-regenerated bytes (Q3); dump the new-file dialog's overlay
  HTML.
- **probe 3** — drive the new-file dialog end-to-end (blocks radio default →
  type name → Create) and dump the created file (Q2).

Mirror `test/e2e/drive.mjs` for the CDP scaffolding; use the `upsert-files`
bridge op (not `apply-files`, which deletes unlisted paths) to seed fixtures, and
the file-row selectors in `test/e2e/file-list-dom.md` to open files.
