# Browser end-to-end verification

`drive.mjs` drives the **real** Pybricks Git extension in headless Chromium
against `https://code.pybricks.com`, exercising the whole Pull → edit → Commit →
push round-trip over raw CDP (no Playwright/puppeteer client, no npm deps — just
Node 22's built-in `WebSocket` and `fetch`). The remote it pushes to is the
in-repo git HTTP harness (`test/git-http-server.mjs`, Task 2), so the run is
hermetic: no GitHub, no network beyond `code.pybricks.com` itself.

This is a manual/CI smoke test, **not** part of `npm test` (it lives outside the
`test/*.test.mjs` glob on purpose). The fast, hermetic engine coverage is the
Node suite; this proves the same engine works when driven through the actual
browser UI, IndexedDB bridge, and service worker.

## How to run

```bash
node test/e2e/drive.mjs
```

Exit code `0` = PASS, non-zero = FAIL (a `failure.png` screenshot is written to
this directory on failure; a `toolbar.png` on success). The script is fully
self-contained — it starts the git harness, launches Chromium, runs the flow,
asserts on both the browser and git-server sides, screenshots, and cleans up.

### Requirements / environment facts baked into the driver

Each of these cost real debugging time; the driver encodes them so you don't
have to rediscover them:

- **Playwright's Chromium, not branded Chrome.** Branded Google Chrome silently
  ignores `--load-extension`. The driver auto-locates the newest
  `~/.cache/ms-playwright/chromium-<rev>/chrome-linux/chrome` (the
  `chromium_headless_shell-*` builds and metadata-only rev dirs are skipped —
  they don't ship the branded binary). Install with `npx playwright install chromium`.
- **Local Network Access gate.** Chrome ≥138 silently *hangs* `fetch()` to
  `127.0.0.1` awaiting a permission prompt that never comes in headless. The
  launch passes
  `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults`
  to bypass it. Without this the Commit/Pull buttons stick at `Committing…`/`Pulling…` forever.
- **Trusted CDP input, not synthetic DOM events.** UI is driven with
  `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent`.
- **The Pybricks Welcome Tour blocks clicks.** On a fresh profile Pybricks mounts
  a full-viewport `react-joyride__overlay` that intercepts hit-testing, so
  trusted clicks never reach the toolbar (`elementFromPoint` at the button
  center returns the overlay `DIV`, not the `BUTTON`). The driver dismisses the
  tour (clicks its `data-action="close"` button, Escape fallback) before driving
  the toolbar. This is environmental — not an extension bug.
- **Pull triggers a reload.** After a non-empty apply, `content.js` schedules
  `location.reload()` ~1.5s later; execution contexts are torn down and rebuilt,
  so the driver re-enumerates the isolated world after the reload.

### What the driver does (maps to acceptance steps)

1. Starts the git harness with a seeded bare repo containing `starter.py`.
2. Launches Chromium with the unpacked extension.
3. Attaches to the extension **service_worker** target, writes settings via
   `chrome.storage.local.set({settings:{repoUrl,branch,token,name,email}})`,
   pointing `repoUrl` at the harness (`http://127.0.0.1:<port>/team.git`), and
   captures `Runtime.exceptionThrown` on the SW (tagged `sw:`) — the git engine
   runs in this target, so a throw there must not be invisible to the gate.
4. Attaches to the `code.pybricks.com` page target, finds the extension's
   **isolated world** (`Runtime.executionContextCreated`, name `Pybricks Git`),
   and captures `Runtime.exceptionThrown` (tagged `page:`) from attach onward.
5. Waits for the toolbar buttons, dismisses the Welcome Tour, then **Pull**
   (trusted click) → asserts label `↓ +1 ~0 -0` → waits for reload →
   `pageRequest('list-files')` contains `starter.py`.
6. Seeds a second file (`e2e.py`) via `pageRequest('apply-files', …)`, real-clicks
   **Commit**, trusted-types `e2e message`, trusted Enter → asserts the label
   timeline `Committing…` → `✓ <sha> ↑`.
7. Asserts harness-side: `bareSubjects` includes `e2e message`, `e2e.py` is in
   the bare repo, and `starter.py` is still present (first-commit guard held).
8. Asserts zero **extension** exceptions across **both** the page and the
   service worker, and writes `toolbar.png`.

## What PASS looks like

Recorded from a real passing run (Chromium 1194, `2026-07-03`):

```
[e2e] === STEP 2: Configure settings via the service_worker target ===
[e2e] service worker target: chrome-extension://<id>/src/background.js
[e2e] PASS: settings written to chrome.storage.local via SW

[e2e] === STEP 3: Dismiss the Pybricks Welcome Tour if present ===
[e2e] joyride buttons: [{"action":"primary","text":"Next (1/7)"},{"action":"close","text":""}]
[e2e] clicking tour dismiss: close (368,416)
[e2e] welcome tour dismissed

[e2e] === STEP 3: Pull: real-click, expect label "↓ +1 ~0 -0", then reload ===
[e2e] elementFromPoint(pull center): BUTTON [1335,10 50x60]  <  DIV.pb-toolbar ...
[e2e]   pull label -> "Pulling…"
[e2e]   pull label -> "↓ +1 ~0 -0"
[e2e] PASS: Pull label is "↓ +1 ~0 -0" (got "↓ +1 ~0 -0")
[e2e] editor files after pull: [ 'starter.py' ]
[e2e] PASS: starter.py present in editor IndexedDB after Pull+reload

[e2e] === STEP 4: Seed a second file, then Commit with message "e2e message" ===
[e2e] apply-files summary: { added: 1, changed: 0, deleted: 0, unchanged: 1 }
[e2e] commit label timeline: [ 'Committing…', '✓ f74d29e ↑' ]
[e2e] PASS: commit label showed "Committing…"
[e2e] PASS: commit label shows "✓ <sha> ↑" (got "✓ f74d29e ↑")

[e2e] === STEP 5: Harness-side assertions on the pushed commit ===
[e2e] bare subjects: [ 'e2e message', 'seed' ]
[e2e] PASS: bareSubjects includes "e2e message"
[e2e] bareFile e2e.py = "print(\"e2e\")\n"
[e2e] PASS: e2e.py pushed to the bare repo
[e2e] PASS: starter.py still present in the bare repo (first-commit guard held)

[e2e] === STEP 6: Zero extension exceptions (page + service worker) ===
[e2e] PASS: zero extension exceptions (saw 0)

[e2e] ================= PASS =================
[e2e] Pull label:       ↓ +1 ~0 -0
[e2e] Commit timeline:  Committing…  ->  ✓ f74d29e ↑
[e2e] Commit head:      ✓ f74d29e ↑
```

### Label timelines (the load-bearing evidence)

| Action | Button label timeline |
|---|---|
| Pull   | `Pull` → `Pulling…` → `↓ +1 ~0 -0` → (page reloads) |
| Commit | `Commit` → `Committing…` → `✓ f74d29e ↑` |

`toolbar.png` (committed alongside this README) is the screenshot after the
push: the Commit button reads `✓ f74d29e ↑`.

## Bugs found

None in the extension. The only obstacle was environmental — the Pybricks
Welcome Tour overlay swallowing trusted clicks — which the driver now dismisses
before interacting. Zero `Runtime.exceptionThrown` events originated from the
extension across the run.
