# Privacy Policy — Pybricks Git

*Effective date: July 3, 2026*

Pybricks Git is a Chrome extension that adds Git version control to the
[code.pybricks.com](https://code.pybricks.com) editor, committing your
programs to a GitHub repository your team controls.

**The short version: we operate no servers and receive no data.** Everything
the extension does happens in your browser, and the only external service it
ever talks to is GitHub.

## What the extension stores on your device

The extension keeps its settings in Chrome's local extension storage
(`chrome.storage.local`), on your device only:

- The GitHub repository URL and branch you configure
- The author name you type (shown in commit history)
- Your GitHub username and a GitHub `noreply` email address, used to attribute
  commits (obtained when you sign in with GitHub, or derived during **Test
  connection**)
- A GitHub access token — either an OAuth token from **Sign in with GitHub**
  or a personal access token you paste yourself
- Bookkeeping the extension needs to work: the list of file paths from your
  last Pull, sign-in progress state, and a temporary cache of Git data

None of this is transmitted anywhere except to GitHub, as described below.
Uninstalling the extension deletes all of it. **Sign out** in the popup
deletes the access token immediately.

## What the extension reads

To commit and pull your programs, the extension reads and writes the program
files that the code.pybricks.com editor stores in your browser's local
database. It does not read anything else from the page and does not access
any other website.

## What the extension sends, and to whom

The extension communicates only with GitHub (`github.com` and
`api.github.com`):

- **Your program files**, when you press Commit — they are pushed to the
  GitHub repository you configured, and are visible there under that
  repository's own visibility settings (public or private)
- **Your access token**, sent to GitHub to authenticate those Git operations
- **Sign-in requests**, when you use Sign in with GitHub (GitHub's standard
  Device Flow), and one request to look up your GitHub username afterward

Data you push to GitHub is governed by
[GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).

## What we don't do

- No analytics, telemetry, crash reporting, or tracking of any kind
- No data is sent to the extension's developers — we have no servers for this app
- No data is sold or shared with third parties
- No ads, no use of data for advertising or creditworthiness purposes
- The extension only runs on `code.pybricks.com` and does not observe your browsing

## Changes

If this policy changes, the new version will be published at this same
address with an updated effective date.

## Contact

Questions or concerns: open an issue at
<https://github.com/Lansing-Tech-Studio/pybricks-git-extension/issues>.
