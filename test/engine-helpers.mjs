import git from 'isomorphic-git';
// Node 22 ESM won't resolve the bare directory 'isomorphic-git/http/node'
// (the subpackage ships no "exports" map), so point at the file directly.
import http from 'isomorphic-git/http/node/index.cjs';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine } from './load-background.mjs';
import { startGitServer, makeBareRepo } from './git-http-server.mjs';

export function memStorage() {
    const m = new Map();
    return {
        get: async (key) => m.get(key),
        set: async (obj) => {
            for (const [k, v] of Object.entries(obj)) m.set(k, v);
        },
    };
}

// What content.js does after a Pull: record the returned base snapshot, but
// only once the editor write has landed. The engine deliberately does NOT
// store it (see pullOp), so any test that needs a base must go through here.
export async function pullAndRecord(engine, storage) {
    const result = await engine.pull();
    if (result.shas) await storage.set({ lastPullShas: result.shas });
    return result;
}

// Spins up a served bare repo (optionally seeded) plus an engine pointed at it.
export async function setupEngine(files = {}) {
    const root = mkdtempSync(join(tmpdir(), 'pbgit-engine-'));
    const bare = makeBareRepo(root, 'team', files);
    const server = await startGitServer(root);
    const storage = memStorage();
    await storage.set({
        settings: {
            repoUrl: `${server.url}/team.git`,
            branch: 'main',
            token: 'test-token',
            name: 'Test Team',
            email: 'team@example.com',
        },
    });
    const gitdir = join(root, 'cache.git');
    const engine = makeEngine({ git, http, fs, gitdir, storage });
    return { engine, storage, bare, server, gitdir };
}
