# Vendored libraries

Checked in so the extension loads unpacked with no build step. Loaded by
`src/background.js` via `importScripts` (classic service worker).

| File | Package | Version | Global | Source URL |
|---|---|---|---|---|
| isomorphic-git.umd.js | isomorphic-git | 1.27.1 | `git` | https://unpkg.com/isomorphic-git@1.27.1/index.umd.min.js |
| isomorphic-git-http-web.umd.js | isomorphic-git (http/web) | 1.27.1 | `GitHttp` | https://unpkg.com/isomorphic-git@1.27.1/http/web/index.umd.js |
| lightning-fs.umd.js | @isomorphic-git/lightning-fs | 4.6.0 | `LightningFS` | https://unpkg.com/@isomorphic-git/lightning-fs@4.6.0/dist/lightning-fs.min.js |

Global names were verified by inspecting each UMD wrapper and by executing the
file in a VM sandbox with `self` defined (mimicking a service worker):
- `isomorphic-git.umd.js` — webpack UMD ends with `t.git=e()`; loaded global
  `git`, `git.version()` returns `1.27.1`.
- `isomorphic-git-http-web.umd.js` — rollup UMD does `factory(global.GitHttp = {})`;
  loaded global `GitHttp` (exposes `default` and `request`). Use `GitHttp.default`
  (or `GitHttp` directly) as the `http` client passed to isomorphic-git.
- `lightning-fs.umd.js` — webpack UMD ends with `t.LightningFS=e()`; loaded global
  `LightningFS` is the constructor.

All MIT-licensed. Update by re-downloading a pinned version and editing this table.
