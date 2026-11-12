# Block-program pictures on Commit

Date: 2026-11-12

## Intent

A block program in the repo is a `.py` file whose first line is one unreadable
line of JSON, so on GitHub nobody can see what the blocks look like. Pybricks'
block editor has a camera control that exports the canvas as a PNG. Commit
should take that picture for every block program that **changed** or that
**has no picture in the repo yet**, and commit it next to the program.

The pictures are for browsing the repo on GitHub and for reuse outside it
(engineering notebooks, slides).

## Goals

- `mission_01.py` gets `mission_01.png` beside it, taken by Pybricks' own
  camera control.
- A picture is retaken when its program changes and backfilled when missing,
  inside Commit, with no separate button.
- A picture in the repo always matches the program beside it, or is absent.

## Non-goals

- Showing pictures anywhere in the extension (History panel included).
- A white background. The PNG stays transparent, as Pybricks exports it.
- Removing the PNG when a block program is converted to a text program.
- A kid-facing notice when pictures are skipped (console only).

## Anti-goals

- Pictures must never appear in Pybricks Code.
- Pictures must never stop, slow to a failure, or change the outcome of a
  Commit of the programs themselves.
- An unlicensed browser must not get Pybricks' "Enable block coding" dialog
  raised by Commit.
- Nothing may land in the Downloads folder.

## Constraints

- The camera control only exists in a live block editor: the program has to be
  the active tab, and block coding has to be licensed.
- Pybricks keeps a single block editor, remounted per active file, so programs
  are pictured one at a time and the kid sees tabs flip.
- Opening a block program makes Pybricks regenerate and re-save the file.
- The block editor is closed source; everything about it is read from the
  deployed bundle and recorded in `test/e2e/blocks-screenshot-dom.md`.
- Commit carried only text `.py` files; PNGs need a binary path.

## Approaches

- **A. Click Pybricks' own camera control and intercept the download
  (chosen).** The output is exactly what the button gives, and there is little
  rendering code of our own.
- **B. Same capture, with the backfill behind a separate button.** Keeps Commit
  quick but leaves pictures missing until someone presses it. Brendon chose
  backfill inside Commit.
- **C. Re-implement the SVG-to-PNG rendering.** Survives the icon moving, but
  copies closed-source logic, drifts from the button's output and still needs
  the program open. Kept only as the fallback for the capture step if the
  click ever stops being accepted.

## Decided with Brendon

- Backfill happens inside Commit.
- PNGs live next to the program, on the condition that they stay out of the
  editor. They do by construction: Pull and History only read `.py` files.

## Design calls made while building (not Brendon's)

- **A changed program committed without a picture loses its old PNG.** A
  missing picture beats a wrong one, and the "missing" rule repairs it on a
  later Commit. This covers an unlicensed teammate, a failed capture and the
  Update-robot-setup snapshot commit.
- **Protected programs get no picture.** Opening one can re-stamp its file,
  which would raise a false "not committed" notice.
- **Deleting a block program deletes its PNG**, under the same conditions as
  the `.py`. A PNG beside a text program is never touched.
- **A hand-made `foo.png` next to a block `foo.py` gets overwritten.**
- **The gate is Pybricks' license record** (`localStorage['pybricks.license']`,
  checked the way Pybricks checks it), not "a block editor is on screen". A
  licensed browser takes pictures on every Commit that needs them.
- **The camera is found by its icon, not its position.** The neighboring
  controls rewrite the program when clicked, so a wrong guess must be
  impossible; a redrawn icon degrades to "no pictures".

## Rules

For each non-protected block program in the Commit payload, against the
freshly fetched branch tip:

| State | Picture wanted? | Commit with a picture | Commit without one |
|---|---|---|---|
| **changed**: this Commit writes a new version | yes | write the PNG | delete the PNG |
| **same**: the tip already holds exactly this | only if the PNG is missing | write it if missing | leave alone |
| **stale**: untouched since Pull, the tip moved on | no | ignore it | leave alone |

## Flow

1. `content.js` reads the editor's files. With no block program, or no valid
   license, it commits as before.
2. `imagesNeeded {files}` asks the engine which programs want a picture.
3. `capture-block-images {paths}` (page bridge) activates each program, waits
   for its block editor, clicks the camera control and keeps the PNG data URL
   instead of letting it download. It closes the tabs it opened, restores the
   active tab, stops at the first program whose block editor never opens, and
   never rejects.
4. The editor's files are read again, once two reads agree, so each picture is
   committed with the contents it was taken from.
5. `commit {files, message, images}` applies the rules table.

Any failure in steps 2 to 4 is logged and the Commit proceeds without pictures.

## Left to the builder

Nothing open. Verified end to end against the live block editor by
`test/e2e/drive-pictures.mjs`.
