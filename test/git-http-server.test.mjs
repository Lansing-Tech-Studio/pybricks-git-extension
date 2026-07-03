import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { startGitServer, makeBareRepo, bareHead, bareFile } from './git-http-server.mjs';

const execFileAsync = promisify(execFile);

function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

// NOTE: The server is a Node http server running in *this* process. Git commands
// that talk to it (clone, push) must run asynchronously — a blocking execFileSync
// would freeze the single event loop and deadlock against the in-process server.
// Local-only git commands (config/rev-parse/show/…) stay synchronous.
test('real git can clone from and push to the harness over HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pbgit-'));
    makeBareRepo(root, 'team', { 'main.py': 'print(1)\n' });
    const server = await startGitServer(root);
    try {
        const work = join(root, 'work');
        await execFileAsync('git', ['clone', '-q', `${server.url}/team.git`, work]);
        assert.equal(git(work, 'show', 'HEAD:main.py'), 'print(1)');

        git(work, 'config', 'user.email', 't@e.com');
        git(work, 'config', 'user.name', 'T');
        execFileSync('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'via http']);
        await execFileAsync('git', ['-C', work, 'push', '-q', 'origin', 'main']);
        assert.equal(bareHead(join(root, 'team.git')), git(work, 'rev-parse', 'HEAD'));
        assert.equal(bareFile(join(root, 'team.git'), 'main.py'), 'print(1)\n');
    } finally {
        await server.close();
    }
});
