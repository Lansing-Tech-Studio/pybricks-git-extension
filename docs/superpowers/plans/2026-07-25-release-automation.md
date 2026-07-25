# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual hand-edit-`manifest.json` → `npm run pack` → dashboard-upload release chore with a one-click GitHub Actions workflow that bumps the version, gates on tests, publishes to the Chrome Web Store, and records what shipped.

**Architecture:** Two workflows. `test.yml` runs the existing Node test suite on push and PR. `release.yml` is a `workflow_dispatch` with a `patch`/`minor`/`major` dropdown that bumps `manifest.json` via a new `scripts/bump.mjs`, packs the zip with the existing `scripts/pack.mjs`, authenticates to Google keyless via Workload Identity Federation, uploads and publishes through the Chrome Web Store **v2** API with hand-rolled `curl`, then commits the bump and cuts a GitHub Release with the zip attached.

**Tech Stack:** GitHub Actions, Node 22 (`node --test`), `curl` + `jq`, Chrome Web Store API v2, Google Workload Identity Federation.

**Spec:** `docs/superpowers/specs/2026-07-25-release-automation-design.md`

## Global Constraints

- **`manifest.json` is the single source of version truth.** `scripts/pack.mjs` derives the zip name from it. Never introduce a second version number.
- **Never reformat `manifest.json`.** It uses hand-written compact arrays (`"permissions": ["storage"]`) that `JSON.stringify(_, null, 2)` would expand into multi-line form. Version edits must be a targeted string replace, not a parse-and-restringify.
- **Target Chrome Web Store API v2 only.** v1 sunsets **2026-10-15**. Endpoints:
  - Upload: `POST https://chromewebstore.googleapis.com/upload/v2/publishers/$PUB/items/$EXT:upload`
  - Publish: `POST https://chromewebstore.googleapis.com/v2/publishers/$PUB/items/$EXT:publish`
- **OAuth scope:** `https://www.googleapis.com/auth/chromewebstore`
- **Never trust `curl`'s exit code alone** on Chrome Web Store calls. The v1 upload endpoint returns HTTP 200 with a failure body (`{"uploadState": "FAILURE", "itemError": [...]}`). Every store call parses the response body and fails explicitly.
- **Publish before tag.** The store call runs *before* the commit/tag/push. A missing release record is recoverable; a false one is not.
- **Pin `google-github-actions/auth` to a commit SHA**, not a tag. It handles the publishing credential.
- **No new npm dependencies.** `package.json` is tooling-only and must stay that way.
- **All four config values are repo `vars`, not `secrets`** — under WIF none are sensitive: `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`, `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID`.
- Runner is `ubuntu-latest`, which already provides `git` ≥ 2.28, `unzip`, `curl`, and `jq` — the test suite requires the first two.
- `package-lock.json` is tracked, so `npm ci` works.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/bump.mjs` (create) | Pure version arithmetic + targeted `manifest.json` rewrite. CLI prints the new version. |
| `test/bump.test.mjs` (create) | Unit tests for the above. |
| `.github/workflows/test.yml` (create) | `npm ci && npm test` on push + PR. |
| `.github/workflows/prove-cws-auth.yml` (create, then delete) | Throwaway: proves a WIF-minted token is accepted by CWS v2. |
| `.github/workflows/release.yml` (create) | The release pipeline. |
| `package.json` (modify) | Delete the vestigial `"version": "0.0.1"` field. |
| `CLAUDE.md` (modify) | Document the release process; correct the now-stale manual-upload instruction. |
| `README.md` (modify) | Correct two claims that call the Web Store listing "future" when it is live. |

**Task order rationale:** Tasks 1 and 2 are independent and unblocked. Task 3 is blocked on Brendon's manual Google Cloud setup (see Prerequisites) and must complete before Task 4, because Task 4's response-shape assertions are written against what Task 3 observes.

---

## Prerequisites (Brendon, manual — blocks Task 3)

Not code. These must be done before Task 3 can run:

1. Google Cloud project with the **Chrome Web Store API** enabled.
2. Create a service account (no key file — WIF needs none).
3. Chrome Web Store Developer Dashboard → **Account** → add the service account email. Only **one** service account per publisher is permitted.
4. Create a Workload Identity Pool + GitHub OIDC provider, with the attribute condition restricted to the `Lansing-Tech-Studio/pybricks-git-extension` repository. **An unrestricted provider would let any GitHub repository impersonate this service account.**
5. Grant the WIF principal `roles/iam.serviceAccountTokenCreator` on the service account.
6. Set the four repo variables (Settings → Secrets and variables → Actions → **Variables** tab):
   - `WIF_PROVIDER` — full provider resource name, `projects/…/locations/global/workloadIdentityPools/…/providers/…`
   - `WIF_SERVICE_ACCOUNT` — service account email
   - `CWS_EXTENSION_ID` — from the dashboard URL
   - `CWS_PUBLISHER_ID` — Dashboard → Publisher → Settings

---

## Task 1: Test workflow

Runs the existing 134-test suite on every push and PR. The repo currently has no CI at all.

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks. Independent.

- [ ] **Step 1: Create the workflow**

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      # ubuntu-latest already ships git >= 2.28 and unzip, which the suite
      # requires (test/git-http-server.mjs seeds repos with `git init -b main`,
      # and test/pack.test.mjs validates the zip with the real unzip binary).
      - run: npm ci
      - run: npm test
```

- [ ] **Step 2: Verify the suite passes locally first**

Run: `npm test`
Expected: `# pass 134` and `# fail 0`. If this is red locally, stop — fix that before adding CI.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run the test suite on push and PR"
```

- [ ] **Step 4: Push and confirm the run goes green**

```bash
git push
gh run watch
```

Expected: the `Test` workflow completes successfully. If `npm ci` fails, confirm `package-lock.json` is tracked (`git ls-files package-lock.json`).

---

## Task 2: Version bump script

Pure version arithmetic plus a formatting-preserving `manifest.json` rewrite, with the vestigial `package.json` version removed so exactly one version number remains in the repo.

**Files:**
- Create: `scripts/bump.mjs`
- Create: `test/bump.test.mjs`
- Modify: `package.json` (delete the `"version"` line)

**Interfaces:**
- Consumes: nothing.
- Produces — Task 4 depends on all three:
  - `bumpVersion(version: string, type: 'major'|'minor'|'patch') → string` — pure, throws on bad input.
  - `bumpManifest(raw: string, type: string) → {text: string, version: string}` — pure, throws on bad input.
  - CLI: `node scripts/bump.mjs <type>` writes `manifest.json` and prints **only** the new version to stdout (Task 4 captures it via command substitution, so nothing else may be printed).

- [ ] **Step 1: Write the failing tests**

Create `test/bump.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bumpVersion, bumpManifest } from '../scripts/bump.mjs';

test('bumpVersion increments the right component', () => {
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(bumpVersion('0.1.0', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.1.0', 'major'), '1.0.0');
});

test('bumpVersion zeroes the components below the one it bumps', () => {
  assert.equal(bumpVersion('1.4.7', 'minor'), '1.5.0');
  assert.equal(bumpVersion('1.4.7', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.4.7', 'patch'), '1.4.8');
});

test('bumpVersion rejects a bad bump type rather than guessing', () => {
  assert.throws(() => bumpVersion('0.1.0', 'zzz'), /bump type/);
  assert.throws(() => bumpVersion('0.1.0', ''), /bump type/);
});

test('bumpVersion rejects a malformed version rather than writing garbage', () => {
  // A corrupt version breaks extension loading, so this must fail loudly.
  for (const bad of ['1.2', '1.2.3.4', 'x.y.z', '1.2.beta', '', '1..3']) {
    assert.throws(() => bumpVersion(bad, 'patch'), /manifest version/, `expected "${bad}" to throw`);
  }
});

test('bumpManifest changes only the version, preserving hand-written formatting', () => {
  // The real manifest uses compact arrays that JSON.stringify would expand.
  const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
  const { text, version } = bumpManifest(raw, 'minor');

  assert.equal(version, bumpVersion(JSON.parse(raw).version, 'minor'));
  assert.equal(JSON.parse(text).version, version);

  // Everything except the version line is byte-identical.
  const before = raw.split('\n');
  const after = text.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.map((line, i) => [i, line, after[i]]).filter(([, a, b]) => a !== b);
  assert.equal(changed.length, 1, `expected exactly 1 changed line, got ${changed.length}`);
  assert.match(changed[0][1], /"version"/);
});

test('bumpManifest does not mistake manifest_version for version', () => {
  const raw = '{\n  "manifest_version": 3,\n  "version": "0.1.0"\n}\n';
  const { text } = bumpManifest(raw, 'major');
  assert.match(text, /"manifest_version": 3/);
  assert.match(text, /"version": "1\.0\.0"/);
});

test('bumpManifest throws when there is no version field to replace', () => {
  assert.throws(() => bumpManifest('{"manifest_version": 3}', 'patch'), /manifest version/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/bump.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/bump.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/bump.mjs`:

```js
// Bumps the version in manifest.json — the single source of version truth for
// the extension (scripts/pack.mjs derives the zip name from it).
//
// Usage: node scripts/bump.mjs <major|minor|patch>
// Prints ONLY the new version to stdout; release.yml captures it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'manifest.json');
const TYPES = ['major', 'minor', 'patch'];

export function bumpVersion(version, type) {
  const index = TYPES.indexOf(type);
  if (index === -1) {
    throw new Error(`bump type must be one of ${TYPES.join('|')}, got "${type}"`);
  }
  const parts = String(version).split('.');
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) {
    throw new Error(`manifest version must be <major>.<minor>.<patch>, got "${version}"`);
  }
  const numbers = parts.map(Number);
  numbers[index] += 1;
  for (let i = index + 1; i < numbers.length; i++) numbers[i] = 0;
  return numbers.join('.');
}

// Targeted replace rather than JSON.stringify: the manifest's compact arrays
// ("permissions": ["storage"]) are hand-formatted, and restringifying would
// expand every one of them into a noisy multi-line diff on each release.
// The pattern cannot match "manifest_version" — that key has no `"version"`
// substring preceded by a quote, and its value is unquoted anyway.
export function bumpManifest(raw, type) {
  const version = bumpVersion(JSON.parse(raw).version, type);
  const text = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (text === raw) {
    throw new Error('manifest version field not found — nothing was replaced');
  }
  return { text, version };
}

export function bump(type) {
  const { text, version } = bumpManifest(readFileSync(MANIFEST, 'utf8'), type);
  writeFileSync(MANIFEST, text);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(bump(process.argv[2]) + '\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/bump.test.mjs`
Expected: all 7 tests pass.

Note the `bumpManifest` test reads the **real** `manifest.json` but never writes it, so the working tree stays clean.

- [ ] **Step 5: Verify the CLI end-to-end, then revert**

```bash
node scripts/bump.mjs patch     # expect: 0.1.1
git diff manifest.json          # expect: exactly one changed line
git checkout manifest.json      # undo — the real bump happens in CI
```

Expected: stdout is exactly `0.1.1`, and the diff touches only the version line. If more lines changed, the targeted-replace logic is wrong — do not proceed.

- [ ] **Step 6: Delete the vestigial version from package.json**

Remove this line from `package.json`:

```json
  "version": "0.0.1",
```

It has never matched `manifest.json`, is never read, and the package is `private: true` so npm does not require it. Removing it leaves exactly one version number in the repo.

- [ ] **Step 7: Verify nothing depended on it**

```bash
grep -rn "package.json" scripts/ test/ src/ | grep -i version   # expect: no matches
npm ci && npm test
```

Expected: `# pass 141` (134 existing + 7 new), `# fail 0`. `npm ci` must still succeed with no `version` field.

- [ ] **Step 8: Commit**

```bash
git add scripts/bump.mjs test/bump.test.mjs package.json
git commit -m "feat: bump.mjs — formatting-preserving manifest version bump

Drops package.json's vestigial 0.0.1, which never matched manifest.json
and is never read, so the repo carries exactly one version number."
```

---

## Task 3: Prove WIF auth against the Chrome Web Store

**Blocked on:** the Prerequisites above.

The spec's central risk: Workload Identity Federation is *not* named in the Chrome Web Store documentation. The reasoning that it works — WIF is impersonation, and CWS receives an ordinary service-account access token — is sound but unconfirmed. This task settles it with a read-only call before any release machinery depends on it, and captures the real v2 response shape that Task 4 asserts against.

**Files:**
- Create: `.github/workflows/prove-cws-auth.yml` (deleted at the end of this task)

**Interfaces:**
- Consumes: `bump.mjs` — no. Independent of Task 2.
- Produces (for Task 4): the pinned `google-github-actions/auth` SHA, and a recorded answer to "does the upload/read response carry a `uploadState`-style field, or plain HTTP status codes?"

- [ ] **Step 1: Find and pin the auth action SHA**

```bash
TAG=$(gh release view --repo google-github-actions/auth --json tagName -q .tagName)
SHA=$(gh api repos/google-github-actions/auth/commits/"$TAG" --jq .sha)
echo "google-github-actions/auth@$SHA # $TAG"
```

Record that line — it goes into this workflow and into Task 4's.

- [ ] **Step 2: Create the proving workflow**

Substitute the SHA from Step 1 for `<SHA>` and keep the tag comment.

```yaml
name: Prove CWS auth

# Throwaway. Deleted once it has answered two questions:
#   1. Does a WIF-minted token get accepted by the Chrome Web Store v2 API?
#   2. What shape is the response body?

on: workflow_dispatch

permissions:
  contents: read
  id-token: write     # required to mint the GitHub OIDC token for WIF

jobs:
  prove:
    runs-on: ubuntu-latest
    steps:
      - id: auth
        uses: google-github-actions/auth@<SHA>   # <TAG>
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: ${{ vars.WIF_SERVICE_ACCOUNT }}
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/chromewebstore

      - name: Read the item
        env:
          TOKEN: ${{ steps.auth.outputs.access_token }}
          PUB: ${{ vars.CWS_PUBLISHER_ID }}
          EXT: ${{ vars.CWS_EXTENSION_ID }}
        run: |
          set -euo pipefail
          code=$(curl -sS -o response.json -w '%{http_code}' \
            -H "Authorization: Bearer $TOKEN" \
            "https://chromewebstore.googleapis.com/v2/publishers/$PUB/items/$EXT")

          echo "HTTP $code"
          jq . response.json || cat response.json

          # Distinguish the three outcomes that matter:
          #   200     -> auth works and the path is right
          #   404     -> auth works, this read path is wrong (harmless here)
          #   401/403 -> auth REJECTED; WIF is not viable, fall back to a JSON key
          case "$code" in
            200) echo "::notice::WIF token accepted" ;;
            404) echo "::notice::WIF token accepted (404 = wrong read path, auth fine)" ;;
            401|403) echo "::error::WIF token REJECTED — use the JSON-key fallback"; exit 1 ;;
            *) echo "::error::unexpected HTTP $code"; exit 1 ;;
          esac
```

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/prove-cws-auth.yml
git commit -m "ci: throwaway workflow proving WIF auth against CWS v2"
git push
```

- [ ] **Step 4: Run it and read the result**

```bash
gh workflow run "Prove CWS auth"
gh run watch
```

Expected: a `WIF token accepted` notice (from either 200 or 404).

**Decision point:**
- **200 or 404** → WIF is viable. Continue to Step 5.
- **401 or 403** → WIF is not viable. **Stop and report to Brendon.** The fallback is the spec's documented JSON-key path: generate a service-account key, store it as the single secret `CWS_SERVICE_ACCOUNT_KEY`, and replace the `google-github-actions/auth` step with a JWT exchange. Everything else in Task 4 is unchanged. Do not silently switch approaches — this is Brendon's call.

- [ ] **Step 5: Record the response shape**

From the run log, note whether the JSON body carries a `uploadState`/`state`/`status` field or is a plain resource. Add a one-line note to the spec's Error handling section stating what v2 actually returns, replacing the "unconfirmed" wording.

- [ ] **Step 6: Delete the throwaway workflow**

```bash
git rm .github/workflows/prove-cws-auth.yml
git add docs/superpowers/specs/2026-07-25-release-automation-design.md
git commit -m "ci: drop the WIF proving workflow; record the confirmed v2 response shape"
git push
```

---

## Task 4: Release workflow

**Blocked on:** Tasks 2 and 3.

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `CLAUDE.md` (Commands section ~line 143; the manual-upload warning in "Things to know")
- Modify: `README.md` (two stale "future Web Store listing" claims)

**Interfaces:**
- Consumes: `node scripts/bump.mjs <type>` printing only the new version (Task 2); the pinned auth SHA and confirmed response shape (Task 3).
- Produces: the release pipeline. Nothing downstream.

- [ ] **Step 1: Create the release workflow**

Substitute the Task 3 SHA for `<SHA>`.

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      bump:
        description: Version bump
        required: true
        type: choice
        options: [patch, minor, major]

# Two releases must never race an irreversible publish.
concurrency: release

permissions:
  contents: write   # push the bump commit and create the Release
  id-token: write   # mint the GitHub OIDC token for WIF

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # --generate-notes needs history

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      # Gate: a red build never reaches the store.
      - run: npm test

      - id: bump
        run: |
          set -euo pipefail
          version=$(node scripts/bump.mjs ${{ inputs.bump }})
          echo "version=$version" >> "$GITHUB_OUTPUT"

      - run: npm run pack

      - id: auth
        uses: google-github-actions/auth@<SHA>   # <TAG>
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: ${{ vars.WIF_SERVICE_ACCOUNT }}
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/chromewebstore

      # Publish runs BEFORE the commit/tag/push. A store failure then leaves
      # nothing persisted and the run can simply be repeated; the reverse order
      # would leave the repo claiming a release that never shipped.
      - name: Upload to the Chrome Web Store
        env:
          TOKEN: ${{ steps.auth.outputs.access_token }}
          VERSION: ${{ steps.bump.outputs.version }}
          PUB: ${{ vars.CWS_PUBLISHER_ID }}
          EXT: ${{ vars.CWS_EXTENSION_ID }}
        run: |
          set -euo pipefail
          code=$(curl -sS -o upload.json -w '%{http_code}' -X POST \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/zip" \
            --data-binary "@dist/pybricks-git-v$VERSION.zip" \
            "https://chromewebstore.googleapis.com/upload/v2/publishers/$PUB/items/$EXT:upload")

          jq . upload.json || cat upload.json
          test "$code" = "200" || { echo "::error::upload returned HTTP $code"; exit 1; }

          # HTTP 200 is not sufficient: v1 returned 200 with a failure body, and
          # this check is correct whether or not v2 kept that behavior.
          if jq -e '(.uploadState? == "FAILURE") or (.error? != null) or ((.itemError? // [] | length) > 0)' upload.json >/dev/null; then
            echo "::error::upload rejected by the store"
            exit 1
          fi

      - name: Publish
        env:
          TOKEN: ${{ steps.auth.outputs.access_token }}
          PUB: ${{ vars.CWS_PUBLISHER_ID }}
          EXT: ${{ vars.CWS_EXTENSION_ID }}
        run: |
          set -euo pipefail
          code=$(curl -sS -o publish.json -w '%{http_code}' -X POST \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Length: 0" \
            "https://chromewebstore.googleapis.com/v2/publishers/$PUB/items/$EXT:publish")

          jq . publish.json || cat publish.json
          test "$code" = "200" || { echo "::error::publish returned HTTP $code"; exit 1; }

          if jq -e '(.error? != null) or ((.itemError? // [] | length) > 0)' publish.json >/dev/null; then
            echo "::error::publish rejected by the store"
            exit 1
          fi

      # Only now record it. gh release create makes the tag itself, and the
      # bump commit is already pushed, so it tags the right commit.
      - name: Record the release
        env:
          VERSION: ${{ steps.bump.outputs.version }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add manifest.json
          git commit -m "chore: release v$VERSION"
          git push
          gh release create "v$VERSION" \
            --title "v$VERSION" \
            --generate-notes \
            "dist/pybricks-git-v$VERSION.zip"
```

- [ ] **Step 2: Lint the workflow before pushing**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"
```

Expected: `yaml ok`. A malformed workflow fails silently at dispatch time otherwise.

- [ ] **Step 3: Update the Commands section of CLAUDE.md**

Replace the `npm run pack` block (currently ~lines 154–157) with:

````markdown
# Build the Chrome Web Store zip locally → dist/pybricks-git-v<version>.zip.
# Packages manifest.json + src/ + vendor/ + icons/ only, with the
# http://127.0.0.1/* E2E grant stripped from host_permissions.
# Releases do this in CI — this is for inspecting the package by hand.
npm run pack

# Bump the version locally (CI does this during a release; rarely needed by hand).
node scripts/bump.mjs <major|minor|patch>
````

Then add a `## Releasing` section immediately after the Commands section:

````markdown
## Releasing

Releases are a one-click GitHub Actions run — **do not hand-edit `manifest.json`
or upload through the dashboard.**

Actions → **Release** → *Run workflow* → pick `patch` / `minor` / `major`.

The workflow bumps `manifest.json`, runs the full test suite as a gate, packs the
zip, publishes to the Chrome Web Store v2 API, then commits the bump and cuts a
GitHub Release with the zip attached. It authenticates keyless via Workload
Identity Federation — there are no long-lived store credentials to rotate.

**Publish happens before the commit and tag, deliberately.** If the store call
fails, nothing has been persisted and the run can simply be repeated. The reverse
order would leave the repo claiming a release that never shipped.

Configuration lives in repo *variables* (not secrets — none are sensitive under
WIF): `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`, `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID`.

Design: `docs/superpowers/specs/2026-07-25-release-automation-design.md`.
Note the Chrome Web Store **v1 API sunsets 2026-10-15**; this uses v2.
````

- [ ] **Step 4: Correct the stale manual-upload instruction in CLAUDE.md**

In the "Things to know before changing things" section, the `host_permissions` bullet currently ends:

> **always upload the `npm run pack` output, never a zip of the repo root.**

Replace that sentence with:

> The release workflow packs and uploads for you; if you ever upload by hand, use the `npm run pack` output, never a zip of the repo root.

- [ ] **Step 5: Correct two stale claims in README.md**

Both call the Web Store listing "future" when it is live:

- Line ~16: `...those need the future Web Store listing plus an admin force-install policy.` → drop "future": `...those need the Web Store listing plus an admin force-install policy.`
- Line ~71: the roadmap item `**Chrome Web Store listing** — publish the extension so teams install it from the store, removing even the sideloading step.` is done. Remove it from the future-work list, renumbering the remaining items.

- [ ] **Step 6: Verify the docs are accurate**

```bash
grep -n "future Web Store" README.md          # expect: no matches
grep -n "never a zip of the repo root" CLAUDE.md   # expect: the reworded sentence
grep -n "^## Releasing" CLAUDE.md             # expect: one match
npm test                                       # expect: pass 141, fail 0
```

- [ ] **Step 7: Commit and push**

```bash
git add .github/workflows/release.yml CLAUDE.md README.md
git commit -m "ci: one-click release — bump, test-gate, CWS v2 publish, GitHub Release

Authenticates keyless via WIF; publishes before tagging so a store
failure leaves nothing persisted and the run can be repeated."
git push
```

- [ ] **Step 8: Cut the first release**

The pending work spans three feature phases, so the first run is **`minor`** → **0.2.0**, not a patch.

```bash
gh workflow run Release -f bump=minor
gh run watch
```

Then verify all four outcomes:

```bash
git pull
grep '"version"' manifest.json                 # expect: 0.2.0
git log --oneline -1                           # expect: chore: release v0.2.0
gh release view v0.2.0                         # expect: notes + the zip asset
```

And confirm in the Developer Dashboard that 0.2.0 is submitted for review.

**If the run fails partway,** consult the spec's "Step order" section before re-running. In particular: if publish succeeded but the push failed, a naive re-run will bump to 0.2.0 again and the upload will fail with "version already exists" — fix by committing and tagging the bump by hand rather than re-running.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `scripts/bump.mjs` | Task 2 |
| `package.json` version deleted | Task 2, Step 6 |
| `.github/workflows/test.yml` | Task 1 |
| `.github/workflows/release.yml` | Task 4, Step 1 |
| Target v2, not v1 | Global Constraints; Task 4 endpoints |
| WIF keyless auth | Task 3 (proof), Task 4 (use) |
| JSON-key fallback | Task 3, Step 4 decision point |
| Four repo variables | Prerequisites, Step 6 |
| Publish-before-tag ordering | Task 4, Step 1 comment + CLAUDE.md |
| Upload response body check | Task 4, Step 1 |
| Concurrency guard | Task 4, Step 1 |
| Testing (bump asserts) | Task 2, Steps 1–4 |
| Prerequisites | Prerequisites section |
| First release = minor → 0.2.0 | Task 4, Step 8 |
| Listing copy refresh | Out of scope per spec — **not** planned |

No gaps.

**Placeholder scan:** `<SHA>` and `<TAG>` appear in Tasks 3 and 4, each with the exact `gh` command that produces them (Task 3, Step 1). These are values the engineer computes, not undefined work.

**Type consistency:** `bumpVersion`, `bumpManifest`, and `bump` are defined in Task 2 and used with matching signatures in Task 2's tests and Task 4's workflow. The CLI's stdout contract ("only the version") is stated in Task 2's Interfaces and relied on by Task 4's `steps.bump.outputs.version`.
