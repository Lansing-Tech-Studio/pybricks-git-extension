// Builds the Chrome Web Store zip: dist/pybricks-git-v<version>.zip
//
// The packaged manifest differs from the repo manifest in exactly one way:
// the `http://127.0.0.1/*` host permission (needed only by the local E2E
// harness, see CLAUDE.md) is stripped, so the published extension asks for
// nothing beyond code.pybricks.com and GitHub.
//
// Pure Node — the zip container is written by hand (DEFLATE via zlib), so
// no `zip` binary or npm package is required.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED_DIRS = ['src', 'vendor', 'icons'];
const STRIP_HOSTS = ['http://127.0.0.1/*'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function transformManifest(json) {
  const manifest = JSON.parse(json);
  const before = manifest.host_permissions ?? [];
  manifest.host_permissions = before.filter((p) => !STRIP_HOSTS.includes(p));
  const stripped = before.filter((p) => STRIP_HOSTS.includes(p));
  return { manifest, stripped };
}

// --- minimal zip writer (local headers + central directory + EOCD) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed timestamp (1980-01-01) so repeated packs of the same tree are
// byte-identical.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0);
    cdir.writeUInt16LE(20, 4); // version made by
    cdir.writeUInt16LE(20, 6); // version needed
    cdir.writeUInt16LE(0, 8); // flags
    cdir.writeUInt16LE(8, 10); // method
    cdir.writeUInt16LE(DOS_TIME, 12);
    cdir.writeUInt16LE(DOS_DATE, 14);
    cdir.writeUInt32LE(crc, 16);
    cdir.writeUInt32LE(deflated.length, 20);
    cdir.writeUInt32LE(data.length, 24);
    cdir.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs left zero
    cdir.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, deflated);
    central.push(Buffer.concat([cdir, nameBuf]));
    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

export function pack() {
  const { manifest, stripped } = transformManifest(
    readFileSync(join(ROOT, 'manifest.json'), 'utf8'),
  );

  const entries = [
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    },
  ];
  for (const dir of PACKAGED_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      entries.push({
        name: file.slice(ROOT.length + 1).replaceAll('\\', '/'),
        data: readFileSync(file),
      });
    }
  }

  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `pybricks-git-v${manifest.version}.zip`);
  writeFileSync(outFile, buildZip(entries));
  return { outFile, entries: entries.map((e) => e.name), stripped, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outFile, entries, stripped, manifest } = pack();
  console.log(`wrote ${outFile} (${entries.length} files)`);
  console.log(`stripped host_permissions: ${stripped.join(', ') || '(none)'}`);
  console.log(`shipped host_permissions: ${manifest.host_permissions.join(', ')}`);
}
