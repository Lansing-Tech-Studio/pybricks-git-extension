// Bumps the version in manifest.json — the single source of version truth for
// the extension (scripts/pack.mjs derives the zip name from it).
//
// Usage: node scripts/bump.mjs <major|minor|patch>
// Prints ONLY the new version to stdout; release.yml captures it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'manifest.json');
const TYPES = ['major', 'minor', 'patch'];

export function bumpVersion(version, type) {
  const index = TYPES.indexOf(type);
  if (index === -1) {
    throw new Error(`bump type must be one of ${TYPES.join('|')}, got "${type}"`);
  }
  const parts = String(version).split('.');
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) {
    throw new Error(`manifest version must be <major>.<minor>.<patch>, got "${version}"`);
  }
  const numbers = parts.map(Number);
  numbers[index] += 1;
  for (let i = index + 1; i < numbers.length; i++) numbers[i] = 0;
  return numbers.join('.');
}

// Targeted replace rather than JSON.stringify: the manifest's compact arrays
// ("permissions": ["storage"]) are hand-formatted, and restringifying would
// expand every one of them into a noisy multi-line diff on each release.
// The regex targets the first textual "version" match, which is positional,
// not semantic (the top-level `version` field the caller asked to bump) — so
// the result is verified by re-parsing rather than by comparing text to raw.
// That catches a nested "version" key stealing the match (top level would
// then silently keep its old value) as well as no match at all.
export function bumpManifest(raw, type) {
  const version = bumpVersion(JSON.parse(raw).version, type);
  const text = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (JSON.parse(text).version !== version) {
    throw new Error('manifest version field not found — nothing was replaced');
  }
  return { text, version };
}

export function bump(type) {
  const { text, version } = bumpManifest(readFileSync(MANIFEST, 'utf8'), type);
  writeFileSync(MANIFEST, text);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(bump(process.argv[2]) + '\n');
}
