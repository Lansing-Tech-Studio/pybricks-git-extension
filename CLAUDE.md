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
  ├─ content.js (ISOLATED world) ─── injects toolbar buttons; bridges the page
  │   ↕ chrome.runtime.sendMessage    to the service worker
  └─ background.js (service worker) ─ the git engine (vendored isomorphic-git)
       ↕ HTTPS (GitHub smart-HTTP git protocol)
     [github.com — the team's fork]
```

**Why two content scripts:** The MAIN-world script can see the page's globals (and could in principle use the page's Dexie instance, though we don't); the ISOLATED-world script has access to `chrome.runtime` APIs so it can message the service worker. The MAIN↔ISOLATED split is mandatory — only the MAIN world reaches the page's IndexedDB, only the ISOLATED world reaches `chrome.runtime`. They communicate via `window.postMessage` with `pybricks-git:request` / `pybricks-git:response` envelopes; `content.js` reaches the service worker via `chrome.runtime.sendMessage`.

**Message ops (`content.js` ↔ `background.js`):** all one-shot request/response over `chrome.runtime.sendMessage`; any op can resolve to `{error}` on failure.

| Op | Request | Success response |
|---|---|---|
| `status` | — | `{ok, configured, branch, head: null}` |
| `commit` | `{files, message}` | `{committed, head, message, pushed, preserved}` |
| `pull` | — | `{head, files, pullWarning}` |
| `authStart` | — | `{state, userCode, verificationUri, expiresAt, interval}` (or throws → `{error}` when no client_id) |
| `authStatus` | — | `{state, signedIn, login, userCode?, verificationUri?, expiresAt?, message?}` (last four only per state) |
| `authCancel` | — | `{state: 'idle'}` |
| `authSignOut` | — | `{signedIn: false}` |

**Settings** live in `chrome.storage.local` under the key `settings`: `{repoUrl, branch, token, name, email, login}`, set via the action popup (`src/popup.html` / `popup.js`). `token` is either a GitHub OAuth token (from **Sign in with GitHub**, Device Flow) or a fine-grained PAT pasted under the popup's **Advanced** section. `login` is the GitHub login, set by OAuth sign-in and empty for pasted PATs. `email` is derived from the login (`<login>@users.noreply.github.com`, or `team@users.noreply.github.com` when unknown) during sign-in or **Test connection**, not typed. `branch` defaults to `main`. **Sign out** clears `token`/`email`/`login` but keeps `repoUrl`/`branch`/`name`.

The engine keeps two more keys: `lastPullPaths` — the snapshot described under "The git engine" — and `authFlow`, the Device Flow state machine (`{state, ...}` with states `idle` / `pending` / `success` / `error`; a `pending` record also carries `deviceCode`, `userCode`, `verificationUri`, `expiresAt`, `interval`). The poll loop is storage-driven off this key so it survives service-worker kills; cancel/sign-out overwrite it with `{state: 'idle'}` (there is no storage `remove`).

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

The line-1 comment carries the entire Blockly workspace state. The rest of the file is valid Python that Pybricks runs verbatim. Both representations live in the single `_contents.contents` string. **Treat this as opaque text** — never parse, regenerate, or "clean up" the line-1 JSON. Round-trip it byte-for-byte.

## The dexie-observable gotcha

Pybricks wraps Dexie with `dexie-observable`, which records mutations in a hidden `_changes` table via Dexie's hook system. Our raw-IndexedDB writes bypass those hooks, so the running React UI does not see our changes. After applying a Pull, `content.js` does `location.reload()` — that's the only currently-working refresh path.

If this becomes painful, the fix paths are (in order of effort): bundle Dexie into the extension and write through it; reverse-engineer `_changes` row format and write directly; or expose Pybricks' Dexie instance via a hook into the page's React tree. None are necessary for the current prototype.

## The git engine (`src/background.js`)

The service worker is the whole git implementation. It is **stateless**: there is no working tree and no persistent clone. Every operation starts by fetching the remote branch tip, and the commit tree is built directly against that tip in memory, then pushed. `makeEngine(deps)` takes its `git` / `http` / `fs` / `gitdir` / `storage` from outside so the same file runs under vendored isomorphic-git in Chrome and under Node's real `fs`/http in tests.

- **Fetch the head.** `fetchRemoteHead` does a bare `init`, registers a named `origin` remote (fetching a raw URL throws `NoRefspecError`, so the remote is required), then a shallow single-branch `fetch`. A branch with no commits yet (fresh fork) resolves to `null` — `fetchHead: null` on most hosts, or a `Could not find refs/heads/<branch>` throw that we special-case as empty. Every *other* fetch error (404, 401, broken response) is rethrown so the user sees the real problem instead of a false "no commits".
- **Pull** peels the fetched commit's tree, decodes every `.py` blob, and returns `{head, files, pullWarning}` (`pullWarning` non-empty only for an empty fork). It records `lastPullPaths` in `chrome.storage.local` — the set of paths the editor was last shown.
- **Commit** is a stateless build-on-head: fetch the tip, take its full tree, overlay the editor's files (writing blobs), and delete tracked `.py` files that aren't in the payload — **but only if the path was in the last Pull's `lastPullPaths` snapshot.** Files never seen by a Pull (fork starter code) are kept and returned in `preserved`. If the recomputed tree equals the head's tree, it returns `{committed: false, message: 'no changes'}`. Empty commit message → `Update from Pybricks at <ISO-8601>`.
- **Push with retry.** After writing the commit and updating the local ref, it pushes. A `PushRejectedError` (someone else pushed between our fetch and push) restarts the whole build-on-head loop, up to **3 attempts**, so the commit lands on the newest tip. Any other push error is fatal.
- **Auth** is `onAuth` returning `{username: 'x-access-token', password: token}` — the GitHub convention for authenticating over HTTPS with a token (the same shape works for an OAuth token or a PAT).
- **The gitdir is a disposable cache.** `lightning-fs` backs a bare gitdir at `/pybricks.git`; it only holds fetched objects between the fetch and the push. It can be wiped at any time with no data loss — the source of truth is always the GitHub fork.

### GitHub Device Flow sign-in (`makeAuthFlow`)

The same file also holds the OAuth Device Flow. `makeAuthFlow(deps)` follows the identical DI pattern as `makeEngine` — it takes its `fetch` / `storage` (and optional `now` / `delay` / `clientId`) from outside — so it runs under Chrome's `fetch`/`chrome.storage` and under Node's injected fakes. It exposes `start` / `status` / `cancel` / `signOut`, wired to the `auth*` message ops. `test/auth-flow.test.mjs` covers it end-to-end, and `test/load-background.mjs` publishes `makeAuthFlow` alongside `makeEngine`/`makeMessageHandler`.

- **State machine in storage.** The whole flow lives under the `authFlow` key (`idle` → `pending` → `success` | `error`). `start` POSTs to GitHub's device-code endpoint (scope `public_repo`), stores the `pending` record, and kicks off a fire-and-forget poll loop. The loop re-reads `authFlow` each tick, so `cancel()` or a superseding `start()` kill it with no in-memory abort flag to lose on a worker kill; that recurring storage read also keeps the MV3 worker alive while the user is off authorizing.
- **Survives worker kills.** A module-level `activePollDeviceCode` marks which flow this worker instance is polling. On every service-worker wake-up the wiring block calls `auth.status()`, which restarts the poll loop for a stranded `pending` record — so sign-in completes even if the popup was closed.
- **On success** the token is written into `settings.token`; `settings.login` and `settings.email` (`<login>@users.noreply.github.com`) are derived from a best-effort `api.github.com/user` lookup (on failure the token is still saved with a team fallback identity).
- **`GITHUB_CLIENT_ID`** at the top of `background.js` is a placeholder (empty string) until the maintainer registers the OAuth App (see README). While empty, `start` throws a clear error and the paste-a-PAT path still works.

## Commands

```bash
# Load the extension: chrome://extensions → Developer mode → Load unpacked
# → select the repo root. After editing src/*, click ↻ on the extension card,
# then refresh code.pybricks.com.

# Run the tests (needs the real `git` binary, ≥ 2.28 — see Tests).
npm install   # once, pulls dev deps into gitignored node_modules
npm test
```

There is no build step and nothing to run alongside the extension — the git work happens in the service worker.

## Tests

`npm test` runs Node's built-in test runner over `test/*.test.mjs`. The suite covers `src/inject.js` (the IndexedDB `applyFiles` diff + sha256) and `src/background.js` (the git engine end-to-end). **A real `git` binary of version ≥ 2.28 is required** — the harness seeds bare repos with `git init -b main` (`test/git-http-server.mjs`), and `-b`/`--initial-branch` first shipped in git 2.28.

- `test/git-http-server.mjs` is a hermetic git smart-HTTP server: it fronts `git http-backend` (CGI) with a Node `http` server bound to `127.0.0.1:0` (random port), serving throwaway bare repos. This is what the engine's fetch/push actually talk to, so the background suite doubles as integration coverage of the GitHub wire protocol.
- `test/load-background.mjs` loads `src/background.js` *unmodified* — it reads the file and evaluates it in a `Function` scope that publishes `makeEngine` / `makeMessageHandler` / `makeAuthFlow` onto `globalThis`. The service-worker wiring block is skipped because `importScripts` is undefined in Node. Same rule as `inject.js`: **don't add ESM `export`s** to `background.js`; that would break it as a classic service worker.
- `test/load-inject.mjs` does the equivalent for `src/inject.js` (appends a line publishing its internal functions), run against `fake-indexeddb`.
- The `test` script globs `test/*.test.mjs` specifically so the `load-*.mjs` and other helpers aren't picked up as (empty) test files.
- `vendor/` holds the pinned isomorphic-git / lightning-fs UMDs the service worker loads via `importScripts`; versions and exposed globals are documented in `vendor/README.md`. Update by re-downloading a pinned version and editing that table.
- `package.json` exists **only** for the JS tests — it's tooling, not shipped. The extension still loads unpacked with no build step.

## Things to know before changing things

- `code.pybricks.com` sets **no CSP**, so script/style/eval restrictions are not a constraint. COEP/COOP are present (for `SharedArrayBuffer` / `crossOriginIsolated`, which Pyodide needs) but they don't bind extension behavior — the git traffic goes out of the service worker to `github.com`, not through the page context, so there is no cross-origin-isolation constraint to satisfy.
- The extension is plain JS, no build step. If you add a bundler, output to `dist/` (gitignored) and update `manifest.json` paths.
- `manifest.json` keeps `http://127.0.0.1/*` in `host_permissions` **on purpose** — the browser E2E driver (`test/e2e/`) points the extension at a local `git http-backend` server, and that grant is what lets the service worker fetch/push against it. Production traffic only ever goes to `github.com`; leave the localhost grant in place for the E2E path.
- The token lives in `chrome.storage.local` (device-local, but readable by anyone using the Chrome profile). It gets there one of two ways: **Sign in with GitHub** (Device Flow OAuth, `public_repo` scope — the primary path) or a pasted fine-grained PAT under the popup's **Advanced** section (the fallback, required for private forks and when the OAuth App is unavailable). The OAuth path is gated on `GITHUB_CLIENT_ID` in `background.js` being filled in with a registered OAuth App's Client ID; while it's the empty placeholder, only the PAT path works.
- ChromeOS: **unmanaged** Chromebooks now work — the whole product is a sideloaded extension with no server or Crostini requirement, so "Load unpacked" (or a future Web Store install) is all that's needed. **Managed** Chromebooks are still the open risk: they block sideloaded extensions, so those need the Web Store listing plus an admin force-install policy.
