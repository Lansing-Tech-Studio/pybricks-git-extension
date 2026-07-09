# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chrome MV3 extension that adds Git version control to `code.pybricks.com` (the hosted Pybricks block/Python editor for LEGO Powered Up hubs). The extension reads/writes the page's IndexedDB directly and performs the git operations itself, in the browser, talking to a GitHub fork over HTTPS. There is no local server and nothing to install beyond the extension.

This is a wrapper over the deployed site, not a fork of `pybricks-code`. We don't (and can't) ship the upstream block editor — that source is deployed-only and unlicensed for redistribution. Adding Git as an extension sidesteps the entire fork problem.

## Architecture

Everything runs in the browser; the only external party is `github.com`:

```
[code.pybricks.com page]
  ├─ inject.js (MAIN world)      ─── opens Pybricks' IndexedDB directly
  │   ↕ window.postMessage (pybricks-git:request / :response, id-correlated)
  ├─ ISOLATED world (5 scripts, loaded in this order):
  │     menu-config.js → blocksplice.js → menu-panel.js → file-list.js → content.js
  │   ─── inject toolbar/panel/file-list UI; bridge the page
  │   ↕ chrome.runtime.sendMessage    to the service worker
  └─ background.js (service worker) ─ the git engine (vendored isomorphic-git)
       ↕ HTTPS (GitHub smart-HTTP git protocol)
     [github.com — the team's fork]
```

**The ISOLATED world is five classic scripts**, listed in `manifest.json` `content_scripts` in load order: `menu-config.js` (pure parse/generate/analyze helpers, no DOM), `blocksplice.js` (pure block-file setup splicing, no DOM — phase 4), then `menu-panel.js` (`makeMenuPanel`) and `file-list.js` (`makeFileListWatcher`) which depend on those helpers being in scope, then `content.js` last — it wires the toolbar and constructs the panel/watcher. They share one global scope with no ESM `export`s, so **order matters** — a helper must be defined in an earlier file than its caller. The two pure-helper files have Node test shims (`test/load-menu-config.mjs`, `test/load-blocksplice.mjs`, same pattern as `load-inject.mjs`) and unit tests; the three DOM-heavy files have no Node loader and are exercised only via the browser E2E path. See the "Menu manager (phase 3)" and "Setup propagation (phase 4)" sections below.

**Why an ISOLATED/MAIN split:** The MAIN-world script (`inject.js`) can see the page's globals (and could in principle use the page's Dexie instance, though we don't); the ISOLATED-world scripts have access to `chrome.runtime` APIs so they can message the service worker. The split is mandatory — only the MAIN world reaches the page's IndexedDB, only the ISOLATED world reaches `chrome.runtime`. They communicate via `window.postMessage` with `pybricks-git:request` / `pybricks-git:response` envelopes; `content.js` reaches the service worker via `chrome.runtime.sendMessage`.

**Message ops (`content.js` ↔ `background.js`):** all one-shot request/response over `chrome.runtime.sendMessage`; any op can resolve to `{error}` on failure.

| Op | Request | Success response |
|---|---|---|
| `status` | — | `{ok, configured, branch, head: null}` |
| `commit` | `{files, message}` | `{committed, head, message, pushed, preserved, protectedSkipped}` |
| `pull` | — | `{head, files, pullWarning, protected}` |
| `authStart` | — | `{state, userCode, verificationUri, expiresAt, interval}` (or throws → `{error}` when no client_id is configured or the device-code endpoint fails) |
| `authStatus` | — | `{state, signedIn, login, userCode?, verificationUri?, expiresAt?, message?}` (last four only per state) |
| `authCancel` | — | `{state: 'idle'}` |
| `authSignOut` | — | `{signedIn: false}` |
| `openPopup` | — | `{opened: true}` (opens the action popup via `chrome.action.openPopup()`; `{error}` when Chrome refuses, e.g. a popup is already open) |

**Settings** live in `chrome.storage.local` under the key `settings`: `{repoUrl, branch, token, name, email, login}`, set via the action popup (`src/popup.html` / `popup.js`). `token` is either a GitHub OAuth token (from **Sign in with GitHub**, Device Flow) or a fine-grained PAT pasted under the popup's **Advanced** section. `login` is the GitHub login, set by OAuth sign-in and empty for pasted PATs. `email` is derived from the login (`<login>@users.noreply.github.com`, or `team@users.noreply.github.com` when unknown) during sign-in or **Test connection**, not typed. `branch` defaults to `main`. **Sign out** clears `token`/`email`/`login` but keeps `repoUrl`/`branch`/`name`.

The engine and UI keep more keys under `chrome.storage.local`:
- `lastPullPaths` — the snapshot described under "The git engine".
- `lastPullManifest` — `{protected, menuConfig, setupTemplate, teamSetup}`, written by every non-empty Pull (see "The git engine", "Menu manager", "Setup propagation"). `protected` is a plain array of paths; consumers **must intersect it with the live file list** before badging/hiding, because a manifest can name paths that don't exist in the editor. `teamSetup`/`setupTemplate` are file names (or null) from `.pybricks-git.json`; a null `teamSetup` hides the whole phase-4 new-program/propagate feature.
- `menuPanel` — the floating panel's persisted `{left, top, open}` (see "Menu manager").
- `spliceReport` — `{when, updated:[paths], skipped:[{path, reason}]}`, written by an Update-robot-setup run and rendered as the dismissable report block on the next panel open; dismiss sets it to null (see "Setup propagation").
- `authFlow` — the Device Flow state machine (`{state, ...}` with states `idle` / `pending` / `success` / `error`; a `pending` record also carries `deviceCode`, `userCode`, `verificationUri`, `expiresAt`, `interval`, `startedAt`). The poll loop is storage-driven off this key so it survives service-worker kills; cancel/sign-out overwrite it with `{state: 'idle'}` (there is no storage `remove`).

## Pybricks IndexedDB schema

The page's storage is **discovered, not documented**. `inject.js:openPybricksDb()` enumerates `indexedDB.databases()` and picks the one that has both `metadata` and `_contents` object stores, which is how we identify it without knowing its name.

- **`metadata`** — keyed by `uuid` (a UUID-ish string; Pybricks' generator is not strictly RFC-4122 v4 but Dexie just stores it as a string). Columns: `path` | `sha256` | `viewState` | `uuid`.
- **`_contents`** — keyed by `path`. Columns: `path` | `contents`.

`sha256` is hex-encoded SHA-256 of the contents string. Useful as a free change detector — Pybricks computes it for us. When updating an existing file, **always preserve `viewState` and `uuid` untouched** (Monaco scroll/cursor state lives in `viewState`; `uuid` is the stable identity). Only `sha256` and `contents` should change.

## Block files vs. text files

A "block program" is a regular `.py` file whose **first line** is a sentinel comment:

```
# pybricks blocks file:{...workspace JSON...}
<generated Python below>
```

The line-1 comment carries the entire Blockly workspace state. The rest of the file is valid Python that Pybricks runs verbatim. Both representations live in the single `_contents.contents` string. **In the git layer, treat this as opaque text** — Pull/Commit/`upsert-files`/`apply-files` never parse, regenerate, or "clean up" the line-1 JSON; they round-trip it byte-for-byte. **The one sanctioned exception is `src/blocksplice.js`** (phase 4): the setup-splice and new-program features parse and rewrite the line-1 JSON on purpose, under the safety rails documented in "Setup propagation (phase 4)". The empirically-verified format reference is `test/e2e/blocks-format.md` — read it before touching that JSON.

## The dexie-observable gotcha

Pybricks wraps Dexie with `dexie-observable`, which records mutations in a hidden `_changes` table via Dexie's hook system. Our raw-IndexedDB writes bypass those hooks, so the running React UI does not see our changes. After applying a Pull, `content.js` does `location.reload()` — that's the only currently-working refresh path.

If this becomes painful, the fix paths are (in order of effort): bundle Dexie into the extension and write through it; reverse-engineer `_changes` row format and write directly; or expose Pybricks' Dexie instance via a hook into the page's React tree. None are necessary for the current prototype.

## inject.js bridge ops (page ↔ MAIN world)

The ISOLATED scripts reach IndexedDB by `window.postMessage`-ing `inject.js` (`pybricks-git:request`, id-correlated). `inject.js:handle()` dispatches these ops:

| Op | Payload | Returns | Notes |
|---|---|---|---|
| `list-databases` | — | `indexedDB.databases()` result | discovery/debug helper |
| `list-files` | — | `{metadata, contents}` | `contents` is `[{path, contents}]` with binary fields stripped |
| `apply-files` | `{files}` | `{added, changed, deleted, unchanged}` | full-sync: adds/updates listed paths **and DELETES any IDB path not in `files`**. Used by Pull. **Never reuse for single-file writes.** |
| `upsert-files` | `{files}` | `{added, changed, deleted, unchanged}` | partial write: updates/inserts only the listed paths, **never deletes** (`deleted` is always 0). Used by the menu panel's Save. |

`apply-files` and `upsert-files` are the same `writeFiles(files, deleteUnlisted)` with the delete pass toggled; both preserve each existing metadata row's `viewState`/`uuid` and only touch `sha256`/`contents`.

## The git engine (`src/background.js`)

The service worker is the whole git implementation. It is **stateless**: there is no working tree and no persistent clone. Every operation starts by fetching the remote branch tip, and the commit tree is built directly against that tip in memory, then pushed. `makeEngine(deps)` takes its `git` / `http` / `fs` / `gitdir` / `storage` from outside so the same file runs under vendored isomorphic-git in Chrome and under Node's real `fs`/http in tests.

- **Fetch the head.** `fetchRemoteHead` does a bare `init`, registers a named `origin` remote (fetching a raw URL throws `NoRefspecError`, so the remote is required), then a shallow single-branch `fetch`. A branch with no commits yet (fresh fork) resolves to `null` — `fetchHead: null` on most hosts, or a `Could not find refs/heads/<branch>` throw that we special-case as empty. Every *other* fetch error (404, 401, broken response) is rethrown so the user sees the real problem instead of a false "no commits".
- **Pull** peels the fetched commit's tree, decodes every `.py` blob, and returns `{head, files, pullWarning, protected}` (`pullWarning` non-empty only for an empty fork). It also reads the `.pybricks-git.json` manifest from the fetched tree via `readManifestInfo` (schemaVersion-1 guard; absent or malformed → no protection, `menuConfig: null`) and returns the `protected` path list. On a non-empty pull it records **both** `lastPullPaths` (the set of paths the editor was last shown) and `lastPullManifest` (`{protected, menuConfig}`) in `chrome.storage.local`; an empty/missing-branch pull writes neither, so the last real snapshot survives. `lastPullManifest` is what the phase-3 panel and file-list watcher read.
- **Commit** is a stateless build-on-head: fetch the tip, take its full tree, overlay the editor's files (writing blobs), and delete tracked `.py` files that aren't in the payload — **but only if the path was in the last Pull's `lastPullPaths` snapshot.** Files never seen by a Pull (fork starter code) are kept and returned in `preserved`. Protected paths (from the same `.pybricks-git.json` manifest) always keep the tree's version — edits, new files, and deletions are all skipped — and are reported in `protectedSkipped` when the editor diverged; `content.js` shows a dismissable notice for them. **The order of `protectedSkipped` is unspecified** — deletions are appended while walking the existing tree, edits/creates while walking the payload, so callers must treat it as a set. If the recomputed tree equals the head's tree, it returns `{committed: false, message: 'no changes'}`. Empty commit message → `Update from Pybricks at <ISO-8601>`.
- **Push with retry.** After writing the commit and updating the local ref, it pushes. A `PushRejectedError` (someone else pushed between our fetch and push) restarts the whole build-on-head loop, up to **3 attempts**, so the commit lands on the newest tip. Any other push error is fatal.
- **Auth** is `onAuth` returning `{username: 'x-access-token', password: token}` — the GitHub convention for authenticating over HTTPS with a token (the same shape works for an OAuth token or a PAT).
- **The gitdir is a disposable cache.** `lightning-fs` backs a bare gitdir at `/pybricks.git`; it only holds fetched objects between the fetch and the push. It can be wiped at any time with no data loss — the source of truth is always the GitHub fork.

### GitHub Device Flow sign-in (`makeAuthFlow`)

The same file also holds the OAuth Device Flow. `makeAuthFlow(deps)` follows the identical DI pattern as `makeEngine` — it takes its `fetch` / `storage` (and optional `now` / `delay` / `clientId`) from outside — so it runs under Chrome's `fetch`/`chrome.storage` and under Node's injected fakes. It exposes `start` / `status` / `cancel` / `signOut`, wired to the `auth*` message ops. `test/auth-flow.test.mjs` covers it end-to-end, and `test/load-background.mjs` publishes `makeAuthFlow` alongside `makeEngine`/`makeMessageHandler`.

- **State machine in storage.** The whole flow lives under the `authFlow` key (`idle` → `pending` → `success` | `error`). `start` POSTs to GitHub's device-code endpoint (scope `public_repo`), stores the `pending` record, and kicks off a fire-and-forget poll loop. The loop re-reads `authFlow` each tick, so `cancel()` or a superseding `start()` kill it with no in-memory abort flag to lose on a worker kill; that recurring storage read also keeps the MV3 worker alive while the user is off authorizing.
- **Survives worker kills.** A module-level `activePollDeviceCode` marks which flow this worker instance is polling. On every service-worker wake-up the wiring block calls `auth.status()`, which restarts the poll loop for a stranded `pending` record — so sign-in completes even if the popup was closed.
- **On success** the token is written into `settings.token`; `settings.login` and `settings.email` (`<login>@users.noreply.github.com`) are derived from a best-effort `api.github.com/user` lookup (on failure the token is still saved with a team fallback identity).
- **`GITHUB_CLIENT_ID`** at the top of `background.js` holds the registered OAuth App's Client ID (a public identifier, safe to commit — Device Flow uses no client secret). If it's ever emptied, `start` throws a clear error and the paste-a-PAT path still works.

## Menu manager (phase 3)

The hub's on-device menu is driven by a `menu_config.py` file (a `MENU_ITEMS` list of slot dicts) in the fork. Phase 3 adds a floating panel and file-list gestures to edit it without hand-writing Python. Three ISOLATED scripts implement it (load order above):

- **`menu-config.js` — pure helpers, no DOM.** `parseMenuConfig` (a hand-rolled recursive-descent `PyLiteralParser` over the allowed Python-literal subset — int/str/bool/None/list-of-str, comments skipped), `generateMenuConfig` (rewrites the **whole** file from a fixed kid-facing header + normalized key order; comments inside the list are **not** preserved), `validateDisplay`/`validateItem`, and `analyzeProgram(path, contents)` which decides menu eligibility: bare module name, blocks sentinel, `setupOnly` (importing runs nothing → offer individual `def`s), and the public top-level method names. Loaded in tests by `test/load-menu-config.mjs`.
- **`menu-panel.js` — `makeMenuPanel(deps)`.** A draggable floating panel listing the current slots (reorder by drag or ▲/▼, toggle `enabled`, remove, edit the hub display via a number/char/5×5-grid popover) and the addable programs. Position and open state persist under the **`menuPanel`** storage key (`{left, top, open}`); `content.js` reopens the panel after a reload when `open` was true. **Save always reloads.** Save regenerates the file and writes it via `upsert-files` (single-path, never deletes), then `location.reload()`s — because dexie-observable can't see our raw IDB write, and if `menu_config.py` happens to be open in Monaco the app's stale buffer would clobber our save on its next write; reloading discards that buffer. The panel resolves the config path and protected set from `lastPullManifest` (defaulting to `menu_config.py`); it intersects `protected` with the live `list-files` result and then **excludes** those protected files (and the config file itself) from the "Programs you can add" list.
- **`file-list.js` — `makeFileListWatcher(deps)`.** A `MutationObserver` on `document.body` (debounced 250ms) that finds the page's file rows and (a) adds a 🔒 badge to protected files and (b) attaches right-click / long-press "Add to menu" gestures that call back into `menuPanel.addSlot`. **The selectors are documented in `test/e2e/file-list-dom.md`** — primary path is the Blueprint `[role="tree"][aria-label="Files"]` / `li[role="treeitem"]` / `span.bp5-tree-node-label` structure, with a scoped exact-text fallback. **Gated to the mounted Explorer:** it bails when neither `div.pb-activities-tabview` nor the tree is present, because the Explorer unmounts when closed (the default and the post-Pull-reload state) and without the gate every settled editor keystroke would trigger a `list-files` round-trip and a text-walk that could badge editor chrome. The badge is inserted as a **sibling after** the label (never inside it) so the label's `textContent` stays a clean path for the next decorate. `protected` here also comes from `lastPullManifest`.

Consumers of `lastPullManifest.protected` (panel and watcher) **must intersect it with the live file list** before badging/hiding — a manifest can name paths the editor doesn't have.

## Setup propagation (phase 4)

Teams share one robot setup (the `blockGlobalSetup` chain — hub, motors, drive base…). Phase 4 lets a coach push that setup into every mission without kids hand-copying blocks. It is the **only** code that parses the line-1 blocks JSON (the sanctioned exception to the opaque rule above). Two features, both in the menu panel; the format facts they rely on are in `test/e2e/blocks-format.md`.

- **`src/blocksplice.js` — pure, DI-free helpers, no DOM.** Every function returns `{..., error}` and **never throws**; all error strings are kid-facing. Loaded after `menu-config.js`; unit-tested via `test/load-blocksplice.mjs`.
  - `parseBlocksFile(contents) → {json, python, error}` — split line-1 JSON from the Python body.
  - `findSetupChain(json) → {head, chain, error}` — locate the `blockGlobalSetup` block and its `next`-linked chain (an empty chain is valid).
  - `chainVariableRefs(chain, variables) → {refs, error}` — the device variables the chain references (a `Map` id→{name,type}).
  - `setupSignature(contents) → {signature, error}` — a canonical **string** (`JSON.stringify`) of the setup chain with block/shadow **ids and canvas x/y stripped** and `VAR` id-refs resolved to `{name,type}`. Two setups are "the same" iff their signatures are `===`. This is what the nudge and the splice compare on.
  - `spliceSetup(target, template) → {contents, changed, error}` — replace `target`'s setup chain with `template`'s, **remapping variable ids by name**: template-only devices are ADDED; a device the target has in setup but the template lacks → **skip** (`error`, "its own device"); a name/type mismatch or id collision → **skip**. `changed:false` when the signatures already match (no-op).
  - `newProgramContents(teamSetupContents) → {contents, error}` — graft the team's setup chain onto the editor-authored **empty-program scaffold** (so the kid gets a `blockGlobalStart` to program under; a verbatim setup-only copy has none — see blocks-format.md).
- **New program from team setup** (`menu-panel.js` footer button `[data-pybricks-git-new-program]` + `file-list.js` context entry `[data-pybricks-git-context-item="new-program"]`, shown on every row incl. protected). Seeds a new `.py` via `newProgramContents` → `upsert-files`. Fully hidden when `lastPullManifest.teamSetup` is null. Name-checked against every editor path + the reserved config/setup/protected names.
- **Update robot setup** (`menu-panel.js` footer button `[data-pybricks-git-update-setup]`, shown only when ≥1 block program's signature differs from the team setup's — those rows get a `[data-pybricks-git-setup-differs]` ⚠ nudge). The propagate flow, whose **safety rails are non-negotiable**:
  1. **Snapshot first.** Commit the entire editor tree as `Before robot setup update` (via the `commit` op, which pushes). Any throw ABORTS with nothing changed; a `committed:false` "no changes" is fine and proceeds. **No editor file is mutated until the snapshot resolves** — this is the whole safety story.
  2. Splice each eligible target (block program that isn't the team setup / setup template / menuConfig / protected). Collect `updated` (`changed && !error`) and `skipped` (`{path, reason}`); a no-op is neither.
  3. `upsert-files` the updated files (never `apply-files`), persist a `spliceReport`, and reload. Only-skips → inline report, no reload; nothing at all → "All programs already match."
  4. On reload the panel renders a dismissable `[data-pybricks-git-splice-report]` (updated list + per-skip reason) from the persisted report.

Protected files and the team-setup/template files themselves are **never** spliced. The committed E2E `test/e2e/drive-splice.mjs` exercises the whole round-trip (nudge → new program → snapshot-first update → editor regeneration → Commit).

## Commands

```bash
# Load the extension: chrome://extensions → Developer mode → Load unpacked
# → select the repo root. After editing src/*, click ↻ on the extension card,
# then refresh code.pybricks.com.

# Run the tests (needs the real `git` binary, ≥ 2.28 — see Tests).
npm install   # once, pulls dev deps into gitignored node_modules
npm test

# Build the Chrome Web Store zip → dist/pybricks-git-v<version>.zip.
# Packages manifest.json + src/ + vendor/ + icons/ only, with the
# http://127.0.0.1/* E2E grant stripped from host_permissions.
npm run pack
```

There is no build step and nothing to run alongside the extension — the git work happens in the service worker.

## Tests

`npm test` runs Node's built-in test runner over `test/*.test.mjs`. The suite covers `src/inject.js` (the IndexedDB `applyFiles` diff + sha256) and `src/background.js` (the git engine end-to-end). **A real `git` binary of version ≥ 2.28 is required** — the harness seeds bare repos with `git init -b main` (`test/git-http-server.mjs`), and `-b`/`--initial-branch` first shipped in git 2.28.

- `test/git-http-server.mjs` is a hermetic git smart-HTTP server: it fronts `git http-backend` (CGI) with a Node `http` server bound to `127.0.0.1:0` (random port), serving throwaway bare repos. This is what the engine's fetch/push actually talk to, so the background suite doubles as integration coverage of the GitHub wire protocol.
- `test/load-background.mjs` loads `src/background.js` *unmodified* — it reads the file and evaluates it in a `Function` scope that publishes `makeEngine` / `makeMessageHandler` / `makeAuthFlow` onto `globalThis`. The service-worker wiring block is skipped because `importScripts` is undefined in Node. Same rule as `inject.js`: **don't add ESM `export`s** to `background.js`; that would break it as a classic service worker.
- `test/load-inject.mjs` does the equivalent for `src/inject.js` (appends a line publishing its internal functions), run against `fake-indexeddb`.
- `test/pack.test.mjs` covers `scripts/pack.mjs` (the Web Store zip). It validates the output with the real **`unzip` binary** — a second external-tool requirement alongside git.
- The `test` script globs `test/*.test.mjs` specifically so the `load-*.mjs` and other helpers aren't picked up as (empty) test files.
- `vendor/` holds the pinned isomorphic-git / lightning-fs UMDs the service worker loads via `importScripts`; versions and exposed globals are documented in `vendor/README.md`. Update by re-downloading a pinned version and editing that table.
- `package.json` exists **only** for the JS tests — it's tooling, not shipped. The extension still loads unpacked with no build step.

## Things to know before changing things

- `code.pybricks.com` sets **no CSP**, so script/style/eval restrictions are not a constraint. COEP/COOP are present (for `SharedArrayBuffer` / `crossOriginIsolated`, which Pyodide needs) but they don't bind extension behavior — the git traffic goes out of the service worker to `github.com`, not through the page context, so there is no cross-origin-isolation constraint to satisfy.
- The extension is plain JS, no build step. If you add a bundler, output to `dist/` (gitignored) and update `manifest.json` paths.
- `manifest.json` keeps `http://127.0.0.1/*` in `host_permissions` **on purpose** — the browser E2E driver (`test/e2e/`) points the extension at a local `git http-backend` server, and that grant is what lets the service worker fetch/push against it. Production traffic only ever goes to `github.com`; leave the localhost grant in place for the E2E path. The Web Store package is the exception: `npm run pack` strips this grant when building the zip, so the published extension never requests it — **always upload the `npm run pack` output, never a zip of the repo root.**
- The token lives in `chrome.storage.local` (device-local, but readable by anyone using the Chrome profile). It gets there one of two ways: **Sign in with GitHub** (Device Flow OAuth, `public_repo` scope — the primary path) or a pasted fine-grained PAT under the popup's **Advanced** section (the fallback, required for private forks and when the OAuth App is unavailable). The OAuth path requires `GITHUB_CLIENT_ID` in `background.js` (a registered OAuth App's Client ID — filled in since 965e7b1); if it's ever emptied, only the PAT path works.
- Chrome Web Store material: `docs/webstore-listing.md` is the copy-paste sheet for the entire developer-dashboard submission (listing text, permission justifications, data-usage checkboxes, reviewer notes). `PRIVACY.md` at the repo root is the listing's privacy policy — its GitHub blob URL (`https://github.com/Lansing-Tech-Studio/pybricks-git-extension/blob/main/PRIVACY.md`) goes in the dashboard, so **don't move or rename it** once the listing is live.
- ChromeOS: **unmanaged** Chromebooks now work — the whole product is a sideloaded extension with no server or Crostini requirement, so "Load unpacked" (or a future Web Store install) is all that's needed. **Managed** Chromebooks are still the open risk: they block sideloaded extensions, so those need the Web Store listing plus an admin force-install policy.

## Team-features roadmap (phases 2–4, all shipped)

The approved design spec lives in the sibling starter-repo checkout: `../pybricks-spike-prime-starter/docs/superpowers/specs/2026-07-08-team-features-roadmap-design.md` (branch `template-v2`, PR #1). **Read it before starting any phase** — it holds the cross-phase contract (`menu_config.py` MENU_ITEMS schema, `.pybricks-git.json` manifest, setup-file convention) plus the decisions already locked with Brendon (git-layer read-only, panel + file-list gestures, full setup splice with safety rails).

Phase 1 (template repo v2) is done in the starter repo; the manifest and menu-config contract committed there are the interfaces this extension codes against. Phase 2 (protected files) is done — engine + notice shipped: the engine reads `.pybricks-git.json` from the fetched tree, `commit` keeps the tree version of protected paths and reports `protectedSkipped`, `pull` returns the `protected` set, and `content.js` shows a dismissable notice (see the ops table and "The git engine"). Phase 3 (floating menu manager) is done — panel + file-list gestures shipped: `menu-config.js`/`menu-panel.js`/`file-list.js` implement the `menu_config.py` editor and protected-file badging, `inject.js` gained the `upsert-files` op, and `pull` persists `lastPullManifest` for the UI (see "Menu manager (phase 3)" and the bridge-ops table). Phase 4 (new-program-from-template + setup splice) is done — `src/blocksplice.js` (parse/locate/refs/signature/splice/new-program, unit-tested), the new-program + Update-robot-setup panel/file-list UI, the setup-differs nudge, the `spliceReport` + extended `lastPullManifest` keys, and the committed E2E `test/e2e/drive-splice.mjs` all shipped (see "Setup propagation (phase 4)"). The safety rails (snapshot commit first, skip-on-doubt, variable-id remap by name, never touch protected/templates) are implemented and covered end-to-end.

**Production prerequisite (the roadmap's only open item, a manual step for Brendon, not code):** the starter repo's `.pybricks-git.json` names `robot_setup_template.py`, but that file was never authored — it must be created **in the code.pybricks.com editor** (block editor state can't be hand-written) and committed to the starter repo, and each team's fork needs a `robot_setup.py` copied from it. Until then the phase-4 features have no `teamSetup` to act on and stay hidden. The extension's phase-4 tests use harvested/derived fixtures, not that unwritten template.
