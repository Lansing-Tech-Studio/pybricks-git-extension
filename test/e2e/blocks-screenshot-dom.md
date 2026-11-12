# The block editor's camera control: what `capture-block-images` relies on

Pybricks' block editor is closed source. These facts were read from the
deployed bundle (`main.<hash>.js` and the block-editor chunk it lazy-loads) on
2026-11-12, and the ones marked **live** are exercised by
`test/e2e/drive-pictures.mjs` against the real page with a license.

If Commit stops taking pictures after a code.pybricks.com update, check these
in order.

## License record

- `localStorage['pybricks.license']` holds JSON:
  `{expiryDate, signature, loginType, licenseKey?}`. `loginType` is `license`,
  `patreon` or `trial`. A perpetual license carries a far-future `expiryDate`.
- Pybricks treats it as valid when `expiryDate` and `signature` are present and
  `expiryDate` is in the future (it also verifies the signature).
  `content.js:blockCodingEnabled()` mirrors the first part. **live**
- Without a valid record the block editor still mounts, read-only, and every
  mount raises the "Enable block coding" dialog. That is why the picture pass
  is gated on the record instead of on the editor being present.

## One block editor, remounted per file

- The editor area is `div.pb-editor` → `div.pb-editor-tabpanel[role=tabpanel]`.
  Tabs are `.pb-editor-tablist-tab`.
- There is a single block editor, `div.pb-editor-blocks-panel`, rendered only
  when the active file is a block program and **keyed by the active file's
  uuid**: switching files unmounts it and mounts a new element. So "a
  different `.pb-editor-blocks-panel` element than before the switch" means
  "this is the new file's editor". **live**
- While loading it contains `div.pb-editor-blocks-panel__overlay` (also used
  for a load error). Blockly's `svg.blocklySvg` is injected into the panel.
- Blocks render a frame or two after mount. The capture waits until
  `svg.blocklySvg .blocklyBlockCanvas`'s `getBBox()` is the same on two polls;
  clicking earlier pictures an empty canvas. **live**
- Opening a block program fires a workspace update that regenerates the file
  (`info.version` is re-stamped, `workspaceOptions` added) and saves it. Commit
  re-reads the editor's files after the capture for this reason. **live**

## The camera control

- Three custom controls sit on the canvas, each an SVG
  `<image class="controlsIconStyleLightTheme">` (or `…DarkTheme`) with its icon
  in `xlink:href` as a `data:image/svg+xml;base64,…` URL: **zoom-to-fit**,
  **align-blocks** and **download-screenshot**.
- **Only the camera is safe to click.** zoom-to-fit changes the saved scroll
  and scale; align-blocks moves the blocks. Both rewrite the program.
- The camera is identified by decoding the icon and looking for
  `CAMERA_ICON_MARKER` (`inject.js`), the start of its path data:
  `m15.277 4.0198`. **live**
- To re-derive the marker after an icon change: in `main.<hash>.js`, find
  `CONTROLS_SCREENSHOT:{type:"field_image",src:"data:image/svg+xml;base64,…"`,
  base64-decode the payload and take a distinctive fragment of its `<path d>`.
- The control is bound with Blockly's `conditionalBind(…, 'click', …)`. A
  synthetic `MouseEvent('click')` is accepted. **live**

## What a click does

1. Clones the block canvas into a standalone SVG sized to the blocks' bounding
   box plus a 20px margin, with Blockly's CSS inlined.
2. Draws it to a `<canvas>` at **2×** and calls `toDataURL('image/png')`. The
   background is transparent.
3. Creates `<a download="pybricks_program_<ISO time>.png" href="data:image/png;base64,…">`,
   appends it to `<body>`, calls `.click()` and removes it.

`capture-block-images` patches `HTMLAnchorElement.prototype.click` for the
duration of one click, takes the `href` of an anchor whose `download` ends in
`.png` and whose `href` starts with `data:image/png`, and does not call the
original, so nothing is downloaded. Any other anchor click passes through.
**live**
