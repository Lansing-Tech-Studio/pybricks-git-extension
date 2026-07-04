# Chrome Web Store submission — copy-paste sheet

Everything the developer dashboard asks for, pre-written. Upload the zip from
`npm run pack` (it strips the `http://127.0.0.1/*` E2E grant — never upload a
zip of the repo root).

## Store listing tab

- **Title:** Pybricks Git
- **Summary (short description):** Version control for code.pybricks.com —
  commits straight to your team's GitHub fork
- **Category:** Developer Tools
- **Language:** English (United States)
- **Detailed description:**

  > Pybricks Git adds Git version control to code.pybricks.com, the online
  > editor for LEGO® Powered Up hubs.
  >
  > Robotics teams write their programs in the Pybricks editor, but the
  > programs live only in that browser's local storage — one cleared profile
  > or lost Chromebook and the season's code is gone. Pybricks Git adds Pull
  > and Commit buttons to the editor toolbar so the team's programs are backed
  > up to a GitHub repository the team controls, with full history.
  >
  > • Sign in with GitHub (no tokens to manage), or paste a fine-grained
  >   personal access token for private repositories
  > • Commit all programs with one click; pull the latest from GitHub on any
  >   machine
  > • Block programs round-trip byte-for-byte — workspace layout, scroll
  >   position, and file identity are preserved
  > • Everything runs in your browser: no account with us, no server, no
  >   telemetry. The extension talks only to GitHub.
  >
  > Requires a GitHub repository (a fork per team works well). Not affiliated
  > with Pybricks or LEGO.

- **Store icon:** 128×128 — upload `icons/icon128.png`
- **Screenshots:** at least one, 1280×800 (see the screenshot walkthrough in
  the project notes)

## Privacy tab

- **Single purpose description:**

  > Adds Git version control to the code.pybricks.com editor: commits the
  > user's Pybricks programs to a GitHub repository they configure, and pulls
  > them back.

- **Permission justifications:**
  - `storage` — Stores the user's settings (repository URL, branch, author
    name) and their GitHub access token locally so they don't re-enter them
    each session.
  - `https://code.pybricks.com/*` (host + content scripts) — The extension's
    sole target site: it adds Pull/Commit buttons to the editor toolbar and
    reads/writes the editor's locally stored program files to sync them with
    GitHub.
  - `https://github.com/*` — Git fetch/push over GitHub's smart-HTTP protocol,
    and GitHub's OAuth Device Flow sign-in endpoints.
  - `https://api.github.com/*` — One request after sign-in to look up the
    authenticated user's login for commit attribution.
  - **Remote code:** No, I am not using remote code. (All code ships in the
    package; the vendored isomorphic-git library is loaded via
    `importScripts` from inside the package.)

- **Data usage — check exactly these:**
  - ☑ **Authentication information** (the GitHub access token, stored locally
    and sent only to GitHub)
  - ☑ **Personally identifiable information** (the author name the user
    types; their GitHub username/noreply email for commit attribution)
  - ☑ **Website content** (the user's program files from the
    code.pybricks.com editor, pushed to the user's own GitHub repository)
  - Everything else (health, financial, location, web history, user activity,
    personal communications) — leave unchecked.

- **Data usage certifications — check all three:**
  - ☑ I do not sell or transfer user data to third parties, outside of the
    approved use cases
  - ☑ I do not use or transfer user data for purposes that are unrelated to
    my item's single purpose
  - ☑ I do not use or transfer user data to determine creditworthiness or
    for lending purposes

- **Privacy policy URL:**
  `https://github.com/Lansing-Tech-Studio/pybricks-git-extension/blob/main/PRIVACY.md`

## Distribution tab

- **Visibility:** Unlisted is sufficient for the managed-Chromebook goal —
  admins force-install by extension ID, and teams can install from the direct
  link. Switch to Public later if wider discovery is wanted.
- **Regions:** all regions (default).

## Reviewer notes (the "additional details" box on submit)

> This extension only operates on code.pybricks.com (an online editor for
> LEGO robotics hubs). It reads the editor's locally stored program files and
> syncs them with a GitHub repository the user configures. Authentication is
> GitHub's OAuth Device Flow (or a user-pasted personal access token). There
> is no backend: the only network traffic is Git smart-HTTP and OAuth calls
> to github.com/api.github.com. The vendored files under vendor/ are pinned,
> unmodified UMD builds of the MIT-licensed isomorphic-git and lightning-fs
> libraries (sources and versions listed in the repository:
> https://github.com/Lansing-Tech-Studio/pybricks-git-extension).
