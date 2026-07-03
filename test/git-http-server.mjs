// Serves bare git repos over smart HTTP by fronting `git http-backend` (CGI)
// with a Node http server. Hermetic: binds 127.0.0.1:0, needs only `git`.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

export function startGitServer(projectRoot) {
    const server = createServer((req, res) => {
        const [path, query = ''] = req.url.split('?');
        const cgi = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: decodeURIComponent(path),
                QUERY_STRING: query,
                REQUEST_METHOD: req.method,
                CONTENT_TYPE: req.headers['content-type'] ?? '',
                CONTENT_LENGTH: req.headers['content-length'] ?? '',
            },
        });
        req.pipe(cgi.stdin);
        let buf = Buffer.alloc(0);
        let headerDone = false;
        cgi.stdout.on('data', (chunk) => {
            if (headerDone) return void res.write(chunk);
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) return;
            for (const line of buf.subarray(0, idx).toString().split('\r\n')) {
                const sep = line.indexOf(': ');
                const key = line.slice(0, sep);
                const value = line.slice(sep + 2);
                if (key.toLowerCase() === 'status') res.statusCode = parseInt(value, 10);
                else res.setHeader(key, value);
            }
            headerDone = true;
            res.write(buf.subarray(idx + 4));
        });
        cgi.on('close', () => res.end());
        cgi.stderr.on('data', (d) => process.stderr.write(`[git-http] ${d}`));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

export function makeBareRepo(root, name, files = {}) {
    const bare = join(root, `${name}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(bare, 'config', 'http.receivepack', 'true');
    if (Object.keys(files).length) pushCompeting(bare, files, 'seed');
    return bare;
}

export function pushCompeting(bare, files, message) {
    const work = mkdtempSync(join(tmpdir(), 'pbgit-work-'));
    // stderr ignored: cloning a freshly-created empty bare repo prints a benign
    // "You appear to have cloned an empty repository" warning that pollutes test
    // output. execFileSync still throws on a non-zero exit, so real failures surface.
    execFileSync('git', ['clone', '-q', bare, join(work, 'w')], { stdio: ['ignore', 'ignore', 'ignore'] });
    const w = join(work, 'w');
    git(w, 'config', 'user.email', 'seed@example.com');
    git(w, 'config', 'user.name', 'Seed');
    git(w, 'config', 'commit.gpgsign', 'false');
    git(w, 'checkout', '-q', '-B', 'main');
    for (const [rel, contents] of Object.entries(files)) {
        const full = join(w, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
    }
    git(w, 'add', '-A');
    git(w, 'commit', '-q', '-m', message);
    git(w, 'push', '-q', 'origin', 'main');
}

export function bareHead(bare) {
    try {
        return git(bare, 'rev-parse', 'main');
    } catch {
        return '';
    }
}

export function bareFile(bare, path) {
    return execFileSync('git', ['-C', bare, 'show', `main:${path}`], { encoding: 'utf8' });
}

export function bareSubjects(bare) {
    return git(bare, 'log', '--format=%s', 'main').split('\n');
}
