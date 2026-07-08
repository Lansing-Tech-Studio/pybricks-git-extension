# code.pybricks.com file-list (Explorer) DOM reference

Empirical discovery for **Phase 3 — floating menu manager** (Task 7). The next
task attaches a `MutationObserver`, protected-file badges, and a context menu to
this file list, so it codes against the structure documented here.

**Everything below was observed live**, driving the unpacked extension in
headless Chromium against `https://code.pybricks.com` with a probe script
patterned on `test/e2e/drive.mjs` (git-http harness seeded with `starter.py`,
settings written to the SW, Welcome Tour dismissed, Pull + reload, then a second
file seeded via the `apply-files` op). Snippets are real `outerHTML`, trimmed.

- **Observed:** 2026-07-08
- **Browser:** Chrome/141.0.7390.37 (HeadlessChrome), Playwright `chromium-1194`
  under `~/.cache/ms-playwright`
- **pybricks-code build:** not surfaced by the probe (deployed site, no version
  string in the tree DOM); tie any regression re-check to the date above.
- **Underlying library:** the tree is Blueprint.js **v5** (`bp5-*` classes) wired
  through **`react-complex-tree`** (the `data-rct-*` attributes, `rct` =
  react-complex-tree).

---

## 0. CRITICAL: the file list is NOT in the DOM until the Explorer is opened

On a fresh load (and after every `location.reload()` — which the extension does
after a Pull) **the file tree is not mounted at all**. `document.body.innerText`
contains none of the file names, and there is no `[role=tree]` in the document.

The tree lives in a left-hand **activities panel** toggled by a toolbar button:

```
button#pb-toolbar-explorer-button.bp5-button.bp5-intent-primary.bp5-popover-target.pb-toolbar-action-button
  aria-label="File Explorer"
```

Clicking it **mounts** `div.pb-activities-tabview` (which contains the whole
Explorer); clicking it again **unmounts** that node entirely. So Task 7 cannot
assume the tree exists — it must observe for the panel appearing, and re-attach
its badges/handlers each time the panel mounts. See §5 (mutation behavior).

The probe verified: with the panel closed there is no `[role=tree]`; one trusted
click on `#pb-toolbar-explorer-button` makes it appear.

---

## 1. Container structure (top → leaf)

When the Explorer is open, the file list nests like this:

```
div.pb-activities-tabview                         ← mounts/unmounts as a whole
  div.pb-explorer
    div.pb-explorer-header-toolbar[role=toolbar]  aria-label="File Actions"
        (backup / import / new-file buttons — NOT file rows)
    div.pb-explorer-file-tree
      div                                          ← react-complex-tree wrapper
        div.bp5-tree.bp5-focus-style-manager-ignore[role=tree]
            aria-label="Files"  data-rct-tree="pb-explorer-file-tree"
          ul.bp5-tree-node-list.bp5-tree-root       ← the row list (LCA of all rows)
            li.bp5-tree-node.pb-tree-node[role=treeitem]   ← ONE FILE ROW
            li.bp5-tree-node.pb-tree-node[role=treeitem]
            …
```

### Recommended selectors (most stable first)

| Purpose | Recommended selector | Why |
|---|---|---|
| **Explorer mounted?** | `div.pb-activities-tabview` **or** `[data-rct-tree="pb-explorer-file-tree"]` | The panel node the observer waits for. |
| **Tree container** | `[role="tree"][aria-label="Files"]` | Role + aria are semantic and stable; the `data-rct-tree="pb-explorer-file-tree"` attribute is an equally good anchor. |
| **Row list (attach observer here)** | `ul.bp5-tree-node-list.bp5-tree-root` | Lowest common ancestor of all file rows; new rows are appended here. Reach it as `[role=tree] > div > ul.bp5-tree-root` or just `[role=tree] ul.bp5-tree-root`. |
| **Per-file row (boundary element)** | `li.bp5-tree-node[role="treeitem"]` (also carries `.pb-tree-node`) | The row boundary — attach badges/click/context-menu handlers here. One per file. |
| **Row content (hover/click target)** | `div.bp5-tree-node-content` inside the `li` | Full-width clickable strip. |
| **File-name text** | `span.bp5-tree-node-label` inside the row | Its `textContent` is the file name (see §3). |
| **Per-row action toolbar** | `div.pb-explorer-file-tree-action-toolbar[role="toolbar"]` in `span.bp5-tree-node-secondary-label` | Existing rename/duplicate/export/delete buttons — a model for adding our own, and a region to avoid when hit-testing the label. |

Prefer the **role/aria/`data-rct-*`** anchors over the `bp5-*` classes where a
choice exists (see §4).

---

## 2. A single file row — real HTML (trimmed)

`li[role=treeitem]` for `starter.py` (SVG path data elided):

```html
<li class="bp5-tree-node pb-tree-node" role="treeitem" tabindex="0"
    data-rct-item-interactive="true" data-rct-item-focus="true"
    data-rct-item-id="872d3e88-e677-4436-b9b5-a9f5c3550fc9">
  <div class="bp5-tree-node-content bp5-tree-node-content-0" data-rct-item-container="true">
    <span class="bp5-tree-node-caret-none"></span>
    <span aria-hidden="true" class="bp5-icon bp5-icon-document bp5-tree-node-icon">
      <svg data-icon="document" …></svg>
    </span>
    <span class="bp5-tree-node-label">starter.py</span>
    <span class="bp5-tree-node-secondary-label">
      <div class="bp5-button-group bp5-minimal pb-explorer-file-tree-action-button-group">
        <div class="pb-explorer-file-tree-action-toolbar" role="toolbar">
          <button title="Rename starter.py"  class="bp5-button">…</button>
          <button title="Duplicate starter.py" class="bp5-button">…</button>
          <button title="Export starter.py"  class="bp5-button">…</button>
          <button title="Delete starter.py"  class="bp5-button">…</button>
        </div>
      </div>
    </span>
  </div>
</li>
```

Notes:
- **`data-rct-item-id` is the file's IndexedDB `metadata.uuid`** (e.g.
  `872d3e88-…`), *not* the path. It is a stable per-file identity that survives
  rename, so it is the best key for tracking a row across re-renders. (The path is
  in the label text; the uuid is here.)
- The focused row has `tabindex="0"` / `data-rct-item-focus="true"`; unfocused
  rows have `tabindex="-1"` / `data-rct-item-focus="false"`. Do not rely on
  `tabindex` to find rows.
- `bp5-tree-node-content-0` — the trailing `-0` is the **indent depth** (0 =
  root). Today all files render at depth 0 (flat list). If Pybricks ever nests
  folders the suffix increments; don't hard-code `-0`, match the class prefix.
- Each row already ships a per-file action toolbar (rename/duplicate/export/
  delete) in `span.bp5-tree-node-secondary-label` — the natural place to add a
  protected badge or extra action, and a precedent for the pattern.

### Two-file state

With `starter.py` and a seeded `second.py`, `ul.bp5-tree-node-list.bp5-tree-root`
holds exactly two `li[role=treeitem]` children, **sorted alphabetically**
(`second.py` before `starter.py`). Each row is structurally identical to the
snippet above; only the label text, the `title="… <name>"` on the action
buttons, and `data-rct-item-id` differ.

---

## 3. File-name extraction — maps 1:1 to the IndexedDB `path`

**Rule:** the file name is `row.querySelector('span.bp5-tree-node-label').textContent`
(no trimming needed — the label holds only the name).

Verified against both files:

| IndexedDB `path` | `span.bp5-tree-node-label` textContent |
|---|---|
| `starter.py` | `starter.py` |
| `second.py`  | `second.py`  |

- The name is shown **with the `.py` extension**, exactly equal to the `path`.
- Files observed were flat (no folders), so label === full path. If nested paths
  ever appear, the label likely shows only the leaf segment while the row's
  indent depth (`bp5-tree-node-content-N`) encodes the folder level — re-verify
  before assuming label === full path in that case.
- **Do not** use `li.textContent` for the name: the row's full `textContent`
  is just the label (the action buttons are icon-only), but it also is not
  guaranteed empty of whitespace — always read the `.bp5-tree-node-label` span.
- To map a name back to its IndexedDB record, prefer `data-rct-item-id`
  (= `metadata.uuid`); the path/name is the label text.

---

## 4. Class-name stability assessment

Blueprint's `bp5-*` classes are **library-versioned, not build-hashed** — they
are stable string constants for Blueprint v5 (they'd only change on a major
Blueprint bump, e.g. `bp6-`). They are NOT CSS-module hashes. So they are usable,
but a Blueprint major upgrade would break them.

More durable anchors, in preference order:

1. **Roles / aria:** `[role="tree"]`, `[role="treeitem"]`, `aria-label="Files"`,
   `[role="toolbar"] aria-label="File Actions"`.
2. **Pybricks `data-rct-*` / `data-*`:** `data-rct-tree="pb-explorer-file-tree"`,
   `data-rct-item-id` (the uuid), `data-rct-item-container`.
3. **Pybricks `pb-*` classes:** `pb-tree-node`, `pb-explorer`,
   `pb-explorer-file-tree`, `pb-activities-tabview`,
   `#pb-toolbar-explorer-button` — app-owned, semantic, and more stable than the
   `bp5-*` set.
4. **`bp5-*` classes:** fine as a fallback but the first thing to break on a
   Blueprint upgrade.

The generated bits to **avoid** matching on: `react-aria…:rNN:` ids on the
per-row action buttons, and `data-rct-item-id` values (they're per-file UUIDs —
use them as *keys*, never as selectors).

---

## 5. Mutation behavior (what the observer will see) — observed, not guessed

An observer on `document.body` with `{childList:true, subtree:true}` was used to
record each event below.

**A. Panel open (mount).** Clicking `#pb-toolbar-explorer-button` when closed
adds `div.pb-activities-tabview`; nested inside the same batch, a `div` whose
subtree contains `div.bp5-tree[role=tree]` is added. So the Task-7 observer
should, on any added node, check `addedNode.matches?.('[data-rct-tree="pb-explorer-file-tree"]')`
or `addedNode.querySelector?.('[role=tree][aria-label="Files"]')` and (re)scan the
rows when it fires.

**B. Panel close (unmount).** Clicking the button again **removes**
`div.pb-activities-tabview` from the DOM entirely (recorded as a `REMOVE` of that
node). The tree and all rows go with it — any handlers/badges attached to rows
are discarded and must be re-added on the next mount.

**C. Raw IndexedDB writes do NOT update an open tree (the dexie-observable
gotcha).** With the Explorer open, seeding a third file via the extension's
`apply-files` op produced **zero mutations** and the new name did not appear —
Pybricks' React tree is driven by dexie-observable hooks that our raw writes
bypass (this is the documented gotcha; it's why the extension does
`location.reload()` after a Pull). Practical consequence for Task 7:
  - After a **Pull**, the extension reloads the page → the panel is closed → the
    observer must wait for the user to reopen the Explorer, then scan.
  - Rows appear/disappear via **user actions in Pybricks' own UI** (new file,
    delete, rename, import) — those go through Dexie hooks and *do* re-render the
    tree, appending/removing `li[role=treeitem]` under `ul.bp5-tree-root`. That
    is the per-row mutation the observer reacts to for incremental badge upkeep.

**Recommended observer shape for Task 7:** observe `document.body` (subtree) for
the panel mount, and once mounted, also observe `ul.bp5-tree-node-list.bp5-tree-root`
for `childList` changes to catch individual row add/remove without a full rescan.

---

## 6. Hit-test (`elementFromPoint`) at a row's center — for context-menu targeting

For the `starter.py` row at bounding rect `{x:40, y:139, w:193, h:18}`,
`document.elementFromPoint(centerX, centerY)` returned:

```
span.bp5-tree-node-label
  < div.bp5-tree-node-content.bp5-tree-node-content-0
  < li.bp5-tree-node.pb-tree-node[role=treeitem]
  < ul.bp5-tree-node-list.bp5-tree-root
  < div.bp5-tree[role=tree]
```

So a click at the row center lands on the **label span**, and the nearest
`[role=treeitem]` ancestor is the row. For a right-click context menu, resolve
the target row with `event.target.closest('li[role="treeitem"]')` and read the
name from that row's `.bp5-tree-node-label`. (Beware the right edge of the row:
the secondary-label action toolbar sits there, so `elementFromPoint` over that
zone returns a `button`, not the label — always resolve via `closest()`.)

---

## 7. Fallback strategy (when the DOM shape changes)

If a future Pybricks build renames these classes/roles, fall back to matching on
the **known file names** (which the extension already has from the `list-files`
op) rather than on structure:

1. Get the current paths from `pageRequest('list-files')`.
2. For each `path`, walk `document.body` depth-first and find the **innermost**
   element whose exact trimmed `textContent === path` (or, for nested paths, the
   leaf segment). That element is (or is inside) the file's row.
3. The row boundary is then `match.closest('[role="treeitem"], li')` — or, if
   roles are gone too, climb ancestors until the element's `textContent` starts
   including a *sibling* file's name (i.e. stop at the last ancestor that still
   uniquely contains just this one name).

This text-anchored approach is how this document itself was bootstrapped, and it
degrades gracefully because file names are data the extension controls, not
markup it depends on.

---

## Appendix: how to reproduce

The throwaway probe (not committed) opened the git-http harness with a seeded
`starter.py`, launched Playwright Chromium with the LNA-disable flags
(`--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults`),
wrote settings to the service worker, dismissed the Welcome Tour, Pulled,
reopened the Explorer via `#pb-toolbar-explorer-button`, dumped the DOM around
each file name plus five ancestor levels, seeded a second file via `apply-files`,
reloaded, reopened, and re-dumped — then toggled the panel with a body-level
`MutationObserver` attached to record the mount/unmount events in §5. Mirror
`test/e2e/drive.mjs` to rebuild it.
