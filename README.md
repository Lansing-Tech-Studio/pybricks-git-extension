# Pybricks Git

A Chrome extension that adds Git version control to [code.pybricks.com](https://code.pybricks.com) — the hosted Pybricks editor for LEGO Powered Up hubs.

## Why this exists

Pybricks Code is a great in-browser editor, but every program lives in IndexedDB inside one browser profile on one machine. There's no version history, no way to share a starter file with a team, no way to recover yesterday's working program. This extension wraps the deployed site (without forking it) and adds a Git workflow on top: commit your current set of files to your team's GitHub repository, and pull updates from GitHub back into the editor.

It works equally well for block-based programs and Python programs — block files are stored as `.py` files with their workspace JSON in a line-1 comment, so Git just sees text.

## Current capabilities

- **Commit button** in the editor toolbar — prompts for a commit message (blank = auto-timestamped), then commits *and pushes* every file from the editor straight to your team's GitHub fork.
- **Pull button** — fetches the fork and applies its files back into the editor: adds new files, updates changed ones, deletes removed ones. Monaco scroll/cursor state and file identities (UUIDs) are preserved on update.
- **Works on both program types** — Python and block programs round-trip identically; the extension treats the file body as opaque text.
- **No local server, no install** — the extension does the Git work itself, entirely in the browser. It runs on anything that can sideload a Chrome extension, **including unmanaged (personal) Chromebooks** via Load-unpacked. Managed (school-district) Chromebooks block Load-unpacked, so those need the future Web Store listing plus an admin force-install policy.

## How it works

The extension performs Git itself: a vendored copy of [isomorphic-git](https://isomorphic-git.org) runs in the extension's service worker and speaks GitHub's HTTPS Git protocol directly. Every Commit is built on the freshly fetched remote head, so there is no local clone that can drift or get corrupted — the service worker fetches, builds the new tree, commits, and pushes in one shot. A snapshot of the last Pull guards the first Commit against deleting a fork's starter code it has never seen.

## Setup (fork-per-team)

Each team gets its own fork of a shared-code repository and its own token. A mentor sets up the upstream repo once; each team does the rest.

1. **Fork the shared repo.** The mentor maintains an upstream repository of shared starter code. Each team opens it on GitHub and clicks **Fork** to make their own copy.
2. **Create a fine-grained personal access token (PAT).** On GitHub: *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*. Set **Repository access** to **Only select repositories** and choose **only the team's fork**. Under **Permissions → Repository permissions**, set **Contents: Read and write**. Generate the token and copy it (you only see it once).
3. **Load the extension.** Open `chrome://extensions`, enable **Developer mode** (top right), click **Load unpacked**, and select this repository's root.
4. **Configure the extension.** Click the Pybricks Git icon in the Chrome toolbar. Enter the fork URL, the token, and the team name, then click **Test connection** to confirm the token can reach the fork (this also records the GitHub identity that commits will be authored under). Click **Save**.
5. **Use it on code.pybricks.com.** Open or refresh `https://code.pybricks.com`. **Pull first** to bring the fork's starter code into the editor, then work, then **Commit** to push your changes back.

## Usage

| Action | What it does |
|---|---|
| Click **Commit** | Opens a message input under the button — **Enter** commits (blank message = timestamped default), **Escape** cancels. The extension fetches the fork's head, builds a commit from the editor's files, and pushes it. Button shows `✓ <short-sha> ↑` (committed and pushed), `no changes`, `setup needed` (extension not configured yet), or `error` (see the console). |
| Click **Pull** | The extension fetches the fork and applies its files into the editor. Button shows `↓ +N ~N -N` (added / changed / deleted), or `nothing to pull` when the fork has no commits on the configured branch yet (nothing is applied in that case). When anything changed, the page reloads so the editor picks up the new files. |

## Shared-code updates

When the mentor updates the upstream shared repository, each team pulls the changes into their own fork by pressing **Sync fork** on GitHub (on the fork's page), then clicking **Pull** in the editor to bring them into Pybricks.

## Known limitations

- **The page reloads after a Pull that changes files.** Pybricks wraps Dexie with `dexie-observable`, and the extension's raw IndexedDB writes bypass its hook system, so React doesn't see them until a reload.
- **The token is stored in `chrome.storage.local`.** That is device-local, but it is readable by anyone who can use that Chrome profile. Treat the fork's PAT accordingly (scope it to the single fork with Contents-only write, as in Setup).
- **A Commit made before the first Pull preserves unknown files rather than deleting them.** Since the extension has no snapshot of what the fork contained, it won't delete starter code it has never seen. This is by design; the preserved paths are logged to the console.

## Roadmap

In rough priority order:

1. **GitHub Device Flow OAuth** — replace pasted PATs with a login flow so teams never handle a raw token.
2. **Open-tab cleanup on delete** — when Pull deletes a file, also clean up its entry in Pybricks' "open tabs" state so the page doesn't log a non-fatal error after reload.
3. **Chrome Web Store listing** — publish the extension so teams install it from the store, removing even the sideloading step.

## License

MIT — see [LICENSE](LICENSE).
