// Covers the CLI stdout contract: Task 4's release workflow captures the new
// version via `$(node scripts/bump.mjs <type>)`, so stdout must be exactly
// the version and nothing else — no trailing log lines, no extra newlines
// beyond the one terminating it.
//
// Runs against a temp copy of scripts/bump.mjs + manifest.json (bump.mjs
// resolves MANIFEST relative to its own location), so the real manifest.json
// is never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI prints only the new version to stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bump-cli-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(new URL('../scripts/bump.mjs', import.meta.url), join(dir, 'scripts/bump.mjs'));

    // A fixture with a KNOWN version, deliberately not the repo's real
    // manifest.json. Copying the real one couples this assertion to whatever
    // version we last released, so the test breaks after every release — which
    // it did, the first time, when 1.0.0 shipped. Formatting preservation
    // against the real manifest is bump.test.mjs's job; this test pins only the
    // stdout contract, which needs a fixed input to assert against.
    writeFileSync(
      join(dir, 'manifest.json'),
      '{\n  "manifest_version": 3,\n  "version": "4.5.6"\n}\n',
    );

    const result = spawnSync(process.execPath, [join(dir, 'scripts/bump.mjs'), 'patch'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '4.5.7\n');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
