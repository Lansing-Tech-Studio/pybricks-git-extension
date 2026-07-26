# Release automation: version bump and Chrome Web Store publish via GitHub Actions

**Date:** 2026-07-25
**Status:** Approved direction. Trigger, publish behavior, GitHub Release, CWS-call style, and keyless auth confirmed by Brendon 2026-07-25.

## Why

`manifest.json` has read `"version": "0.1.0"` since the initial commit on 2026-05-07 — through a complete architectural rewrite (native host + Go server → in-extension git) and three shipped feature phases. There are no git tags and no changelog, so the repo carries **no record of what is live in the store**. Determining that at the start of this work required diffing the built zip against `HEAD` and inferring from file mtimes.

Version 0.1.0 is published and live. Everything after `d6ddf50` (2026-07-03) is unreleased: 20 commits, +2086/−24 across `src/`, covering protected files (phase 2), the menu manager (phase 3), and setup propagation (phase 4).

Two problems to solve, in order of severity:

1. **Releasing is a manual multi-step chore** — hand-edit `manifest.json`, `npm run pack`, upload through the dashboard — which is why it hasn't happened in three weeks of shipped work.
2. **Nothing records what shipped.** Any future "what's in the store?" question repeats the same forensics.

## Current state

- `manifest.json` is the single source of version truth. `scripts/pack.mjs` reads it and derives the zip name (`dist/pybricks-git-v<version>.zip`).
- `package.json` carries a vestigial `"version": "0.0.1"` that has never matched and is never consumed — the package is `private: true` and never published to npm.
- `pack.mjs` is already deterministic (fixed DOS timestamp, `1980-01-01`), so repeated packs of the same tree are byte-identical. Good for CI reproducibility.
- **No CI exists.** There is no `.github/` directory at all.
- `main` is unprotected and the repo is public; the default `GITHUB_TOKEN` can push directly.
- `npm test` requires a real `git` binary ≥ 2.28 and `unzip`. Both are present on `ubuntu-latest`.

## What we're building

A `workflow_dispatch` release workflow with a `patch`/`minor`/`major` dropdown that bumps the manifest, runs the tests, packs the zip, publishes to the Chrome Web Store, then records the release as a commit, tag, and GitHub Release. Plus a plain test workflow, because the repo has 134 tests and nothing running them.

Deliberately **not** automatic-on-merge: releases land in front of kids mid-season, and the decision of *when* to ship should stay a human one. Conventional-commit-derived versioning was considered and rejected on that basis, not on tooling grounds — the history's `feat:`/`fix:` discipline would have supported it.

## Chrome Web Store API: target v2, not v1

**The v1 API sunsets 2026-10-15** — roughly twelve weeks from this spec's date. Building against v1 would mean rebuilding before the season ends. v2 is the only sensible target.

v2 endpoints:

```
POST https://chromewebstore.googleapis.com/upload/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:upload
POST https://chromewebstore.googleapis.com/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:publish
```

v2 additionally offers staged publishing (`STAGED_PUBLISH`), percentage rollout, and cancelling a pending submission. **All out of scope** — we publish straight to `default`. They are noted only so a future change knows they exist without re-researching.

## Authentication: Workload Identity Federation, keyless

Service-account access to the Chrome Web Store API is a recent addition and is what makes keyless auth possible. The service account email is linked in the Developer Dashboard under **Account**. Note the constraint: **one service account per publisher**, so this SA is a shared resource for any future automation.

Google documents two service-account auth methods for CWS: **impersonation** (`roles/iam.serviceAccountTokenCreator`) and a **JSON key file** — with their own docs cautioning that key files "introduce security risks if not handled properly."

### Why WIF over a refresh token

The refresh-token approach (OAuth client + user consent) was the initial proposal and is rejected. Google revokes refresh tokens after **7 days** while the OAuth consent screen is in "Testing," and after **6 months of non-use** even in production. This project releases a handful of times per season — a 6-month idle window is realistic, and the failure surfaces as an opaque `invalid_grant` at exactly the moment a release is wanted. WIF has no credential to rotate and nothing to expire.

More one-time setup, zero ongoing upkeep. The more secure option is here also the lower-maintenance one.

### Why WIF should work, and how we confirm it

WIF is not named in the Chrome Web Store documentation. The reasoning that it works: WIF *is* impersonation. GitHub's OIDC token → WIF pool → `roles/iam.workloadIdentityUser` on the linked service account → a short-lived access token scoped to `https://www.googleapis.com/auth/chromewebstore`. The Chrome Web Store receives an ordinary service-account access token and has no way to distinguish how it was minted.

**On the role:** `roles/iam.workloadIdentityUser` is the correct and sufficient binding — it carries `iam.serviceAccounts.getAccessToken`, which is exactly what minting the token requires. `roles/iam.serviceAccountTokenCreator` appears in the Chrome Web Store docs only for their *local gcloud impersonation* path (a human at a terminal), and in `google-github-actions/auth` only for Domain-Wide Delegation, which this is not. Granting only `serviceAccountTokenCreator` to the WIF principal fails with a 403.

**CONFIRMED 2026-07-25 (Task 3).** This started as inference, and the plan opened with a throwaway proving step before anything depended on it. That probe now returns **HTTP 200** from `publishers.items.fetchStatus` using a WIF-minted, `chromewebstore`-scoped token — the full chain (GitHub OIDC → WIF pool → service-account impersonation → v2 API) works against the live listing. The JSON-key fallback is not needed.

Two corrections the probe forced, both recorded below: the IAM role is `workloadIdentityUser`, and the first probe's HTML 404 revealed there is no plain `GET` on an item.

### Fallback

If Phase 0 fails, the fallback is a service-account **JSON key** stored in a single repo secret (`CWS_SERVICE_ACCOUNT_KEY`), exchanged for an access token via JWT. Every other part of this design is unchanged — only the token-acquisition step differs. The refresh-token path is not a fallback; it is rejected outright for the expiry reasons above.

### Configuration

Under WIF, none of these values are sensitive, so all four are plain repo **variables**, not secrets:

| Variable | Source |
|---|---|
| `WIF_PROVIDER` | Workload identity provider resource name (`projects/…/locations/global/workloadIdentityPools/…/providers/…`) |
| `WIF_SERVICE_ACCOUNT` | Service account email — the same address pasted into the CWS dashboard |
| `CWS_EXTENSION_ID` | The extension ID from the dashboard URL |
| `CWS_PUBLISHER_ID` | Dashboard → Publisher → Settings |

## Components

### `scripts/bump.mjs`

Reads `manifest.json`, increments the version per a `patch`/`minor`/`major` argument, writes it back, prints the new version to stdout. Structured like `pack.mjs`: an exported pure function plus a CLI wrapper guarded by the `import.meta.url` check, so it is unit-testable without spawning a process.

```js
export function bumpVersion(version, type)  // '0.1.0', 'minor' → '0.2.0'
export function bump(type)                  // reads/writes manifest.json, returns new version
```

Rejects a malformed or non-three-part version with a thrown error rather than writing garbage into `manifest.json` — a corrupt manifest breaks extension loading, and the release job must fail loudly instead.

**`package.json`'s `version` field is deleted** rather than kept in sync. It is `private: true`, never published, and its value has been wrong since the initial commit. Removing it leaves exactly one version number in the repo instead of two that disagree.

### `.github/workflows/test.yml`

`push` and `pull_request` → `actions/checkout`, `actions/setup-node`, `npm ci`, `npm test`. No matrix; the extension targets one runtime. `ubuntu-latest` provides `git` ≥ 2.28 and `unzip` with no extra install steps.

The release workflow also gates on tests, so this workflow does not prevent a bad release — it exists so a break is discovered when it is introduced rather than when a release is wanted.

### `.github/workflows/release.yml`

`workflow_dispatch` with a required `bump` choice input (`patch` | `minor` | `major`).

```yaml
concurrency: release        # two releases must never race an irreversible publish
permissions:
  contents: write           # push the bump commit, tag, and create the Release
  id-token: write           # mint the GitHub OIDC token for WIF
```

Steps:

```
actions/checkout                    (fetch-depth: 0 — release notes need history)
actions/setup-node
npm ci
npm test                            ← gate: a red build never reaches the store
node scripts/bump.mjs <input>       → new version, e.g. 0.1.0 → 0.2.0
npm run pack                        → dist/pybricks-git-v<version>.zip
google-github-actions/auth          → short-lived access token (pinned to a SHA)
curl :upload                        → check response, fail explicitly on error
curl :publish                       → check response, fail explicitly on error
git commit manifest.json + push
gh release create v<version> --generate-notes  → tags HEAD, attaches the zip
```

There is no separate `git tag` step: `gh release create` creates the tag itself, and the bump commit is already pushed by that point so it tags the right commit.

`google-github-actions/auth` is Google's own action, pinned to a commit SHA. The CWS calls themselves stay hand-rolled `curl` — no third-party code handles the publishing credential.

## Step order: publish before tag

The publish step runs **before** the commit, tag, and push. This is deliberate. Two failure modes:

- **Tag first, then publish fails** → the repo claims v0.2.0 shipped while the store is still on 0.1.0. A **false** record, which someone must notice and unwind.
- **Publish first, then push fails** → the store has v0.2.0 and the repo has no record. A **missing** record, fixable with one manual tag.

Missing beats false. A missing record is self-evidently incomplete; a false one is trusted and wrong — and this whole spec exists because of untrustworthy release records. Additionally, under this ordering a store rejection (bad zip, auth failure, quota) costs nothing: nothing was persisted, so the run can simply be repeated.

The one awkward case is publish-succeeds-then-push-fails followed by a naive re-run: the bump produces the same version and the upload fails with a clear "version already exists." Recoverable by hand, and loud rather than silent.

## Error handling

**The v1 upload endpoint returns HTTP 200 with a failure body:**

```json
{"uploadState": "FAILURE", "itemError": [{"error_detail": "..."}]}
```

`curl` exits 0 on that, so a naive step goes green on a failed upload — the single most likely way this automation breaks silently. Both the upload and publish steps must parse the response body with `jq` and fail explicitly on any non-success state, never trusting the exit code alone.

**CONFIRMED 2026-07-25 (Task 3)**, from the authoritative v2 discovery document at
`https://chromewebstore.googleapis.com/$discovery/rest?version=v2` — the reference to consult before touching these calls again:

| Method | Verb + path |
|---|---|
| read | `GET v2/{+name}:fetchStatus` — there is **no plain `GET`** on an item; without `:fetchStatus` you get an HTML 404 |
| upload | `POST /upload/v2/{+name}:upload` |
| publish | `POST v2/{+name}:publish` |

`{+name}` is `publishers/{publisher}/items/{item}`. Scopes: `.../auth/chromewebstore` and `.../auth/chromewebstore.readonly`.

v2 **does** keep a state field in the body, so the explicit body check stays. The exact values matter:

- `UploadItemPackageResponse.uploadState` ∈ `SUCCEEDED | IN_PROGRESS | FAILED | NOT_FOUND | UPLOAD_STATE_UNSPECIFIED`. **It is `SUCCEEDED`/`FAILED`, not `SUCCESS`/`FAILURE`** — this spec's earlier draft had the v1 strings, which would have failed every good upload.
- `PublishItemResponse.state` ∈ `PENDING_REVIEW | STAGED | PUBLISHED | PUBLISHED_TO_TESTERS | REJECTED | CANCELLED | ITEM_STATE_UNSPECIFIED`. The field is **`state`, not `status`**, and the happy path is `PENDING_REVIEW`. There is also a `warningInfo` field worth surfacing.

An HTML (non-JSON) body means the request never reached the API at all and says nothing about auth — an unauthenticated request to a bad path returns the same page. Any store-call check must therefore require a parseable JSON body before interpreting a status code.

## Testing

- `scripts/bump.mjs` gets asserts in `test/`: each of patch/minor/major from a known version, plus rejection of a malformed version. Real branching, so per the repo's existing standard it gets a check.
- `pack.test.mjs` already validates the built zip with the real `unzip` binary, so the release job's `npm test` gate covers packaging integrity.
- The workflows themselves cannot be unit-tested. Phase 0 de-risks the auth half; the first real release is the smoke test for the rest.

## Prerequisites (manual, Brendon)

Not code. Ordered:

1. Google Cloud project with the **Chrome Web Store API** enabled.
2. Create a service account. No key is generated under the WIF path.
3. Chrome Web Store Developer Dashboard → **Account** → add the service account email. (One per publisher.)
4. Create a Workload Identity Pool and a GitHub OIDC provider, with the attribute condition restricted to the `Lansing-Tech-Studio/pybricks-git-extension` repository — an unrestricted provider would let any GitHub repo impersonate the account.
5. Grant the WIF principal `roles/iam.workloadIdentityUser` on the service account (NOT `serviceAccountTokenCreator` — see "On the role" above).
6. Set the four repo variables listed above.

## First release

The pending work spans three feature phases, so the first automated run should be **`minor`** → **0.2.0**, not a patch.

`docs/webstore-listing.md` has not been touched since 2026-07-03 and describes none of the menu manager or setup propagation. Permissions are unchanged (`storage` only; `pack.mjs` still strips the `127.0.0.1` grant), so this is a copy refresh, not a re-review risk. **Out of scope for this spec** — noted so it is not forgotten.

## Out of scope

- Refreshing the store listing copy (above).
- Staged publishing, percentage rollout, trusted-tester channel.
- Auto-generated `CHANGELOG.md` — GitHub's `--generate-notes` covers it from commit history.
- Rollback automation. The store's own dashboard handles rollback, and it is rare enough not to warrant code.
- Firefox/Edge store publishing. Not currently targets.

## Verification steps carried into the plan

1. **Phase 0:** prove a WIF-minted token is accepted by the CWS v2 API via a read-only call, before building anything that depends on it.
2. Capture the real v2 upload response shape and write the failure check against it.
3. Confirm `gh release create` can attach the packed zip and create the tag from within the same job.
