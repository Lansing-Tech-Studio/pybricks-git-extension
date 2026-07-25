import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bumpVersion, bumpManifest } from '../scripts/bump.mjs';

test('bumpVersion increments the right component', () => {
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(bumpVersion('0.1.0', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.1.0', 'major'), '1.0.0');
});

test('bumpVersion zeroes the components below the one it bumps', () => {
  assert.equal(bumpVersion('1.4.7', 'minor'), '1.5.0');
  assert.equal(bumpVersion('1.4.7', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.4.7', 'patch'), '1.4.8');
});

test('bumpVersion rejects a bad bump type rather than guessing', () => {
  assert.throws(() => bumpVersion('0.1.0', 'zzz'), /bump type/);
  assert.throws(() => bumpVersion('0.1.0', ''), /bump type/);
});

test('bumpVersion rejects a malformed version rather than writing garbage', () => {
  // A corrupt version breaks extension loading, so this must fail loudly.
  for (const bad of ['1.2', '1.2.3.4', 'x.y.z', '1.2.beta', '', '1..3']) {
    assert.throws(() => bumpVersion(bad, 'patch'), /manifest version/, `expected "${bad}" to throw`);
  }
});

test('bumpManifest changes only the version, preserving hand-written formatting', () => {
  // The real manifest uses compact arrays that JSON.stringify would expand.
  const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
  const { text, version } = bumpManifest(raw, 'minor');

  assert.equal(version, bumpVersion(JSON.parse(raw).version, 'minor'));
  assert.equal(JSON.parse(text).version, version);

  // Everything except the version line is byte-identical.
  const before = raw.split('\n');
  const after = text.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.map((line, i) => [i, line, after[i]]).filter(([, a, b]) => a !== b);
  assert.equal(changed.length, 1, `expected exactly 1 changed line, got ${changed.length}`);
  assert.match(changed[0][1], /"version"/);
});

test('bumpManifest does not mistake manifest_version for version', () => {
  const raw = '{\n  "manifest_version": 3,\n  "version": "0.1.0"\n}\n';
  const { text } = bumpManifest(raw, 'major');
  assert.match(text, /"manifest_version": 3/);
  assert.match(text, /"version": "1\.0\.0"/);
});

test('bumpManifest throws when there is no version field to replace', () => {
  assert.throws(() => bumpManifest('{"manifest_version": 3}', 'patch'), /manifest version/);
});
