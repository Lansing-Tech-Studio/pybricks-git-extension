// Tests scripts/pack.mjs — the Chrome Web Store packaging step.
//
// The zip is validated with the real `unzip` binary (like the git engine
// tests use the real `git`), so the hand-rolled zip container is checked
// against an independent implementation, not our own reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pack } from '../scripts/pack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { outFile, entries, stripped } = pack();

test('zip passes unzip -t integrity check', () => {
  const out = execFileSync('unzip', ['-t', outFile], { encoding: 'utf8' });
  assert.match(out, /No errors detected/);
});

test('packaged manifest has the localhost E2E grant stripped', () => {
  const packed = JSON.parse(
    execFileSync('unzip', ['-p', outFile, 'manifest.json'], { encoding: 'utf8' }),
  );
  assert.deepEqual(stripped, ['http://127.0.0.1/*']);
  assert.deepEqual(packed.host_permissions, [
    'https://code.pybricks.com/*',
    'https://github.com/*',
    'https://api.github.com/*',
  ]);
});

test('packaged manifest is otherwise identical to the repo manifest', () => {
  const repo = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const packed = JSON.parse(
    execFileSync('unzip', ['-p', outFile, 'manifest.json'], { encoding: 'utf8' }),
  );
  repo.host_permissions = repo.host_permissions.filter(
    (p) => p !== 'http://127.0.0.1/*',
  );
  assert.deepEqual(packed, repo);
});

test('zip contains exactly the shipped files, nothing else', () => {
  const listed = execFileSync('unzip', ['-Z1', outFile], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .sort();
  assert.deepEqual(listed, [...entries].sort());

  for (const required of [
    'manifest.json',
    'src/background.js',
    'src/content.js',
    'src/inject.js',
    'src/popup.html',
    'src/popup.js',
    'vendor/isomorphic-git.umd.js',
    'vendor/isomorphic-git-http-web.umd.js',
    'vendor/lightning-fs.umd.js',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
  ]) {
    assert.ok(listed.includes(required), `missing ${required}`);
  }

  for (const name of listed) {
    assert.ok(
      /^(manifest\.json$|src\/|vendor\/|icons\/)/.test(name),
      `unexpected file in zip: ${name}`,
    );
  }
});

test('packaged files round-trip byte-for-byte', () => {
  const original = readFileSync(join(ROOT, 'src', 'background.js'));
  const extracted = execFileSync('unzip', ['-p', outFile, 'src/background.js'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(original.equals(extracted));
});
