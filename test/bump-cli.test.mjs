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
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI prints only the new version to stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bump-cli-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(new URL('../scripts/bump.mjs', import.meta.url), join(dir, 'scripts/bump.mjs'));
    copyFileSync(new URL('../manifest.json', import.meta.url), join(dir, 'manifest.json'));

    const result = spawnSync(process.execPath, [join(dir, 'scripts/bump.mjs'), 'patch'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '0.1.1\n');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
