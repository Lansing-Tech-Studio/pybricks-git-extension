const FIELDS = ['repoUrl', 'branch', 'token', 'name'];
const $ = (id) => document.getElementById(id);

async function loadForm() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    for (const f of FIELDS) $(f).value = settings[f] ?? '';
}

async function saveForm(extra = {}) {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const next = { ...settings, ...extra };
    for (const f of FIELDS) next[f] = $(f).value.trim();
    if (!next.branch) next.branch = 'main';
    await chrome.storage.local.set({ settings: next });
    return next;
}

$('save').addEventListener('click', async () => {
    await saveForm();
    $('status').textContent = 'Saved.';
});

$('test').addEventListener('click', async () => {
    $('status').textContent = 'Testing…';
    const s = await saveForm();
    // Owner then repo; repo is lazy so an optional .git suffix and any trailing
    // /, ?, # or end-of-string bound it without eating a dotted repo name.
    //   github.com/team/robot.code       → team / robot.code
    //   github.com/team/robot-code.git   → team / robot-code
    //   github.com/team/robot-code/      → team / robot-code
    //   (a URL with no github.com/owner/repo shape)  → no match (stays failed)
    const match = s.repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/);
    if (!match) {
        $('status').textContent = 'Fork URL must look like https://github.com/owner/repo';
        return;
    }
    const headers = {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/vnd.github+json',
    };
    try {
        const repo = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`, { headers });
        if (!repo.ok) throw new Error(`token cannot see ${match[1]}/${match[2]} (HTTP ${repo.status})`);
        const user = await fetch('https://api.github.com/user', { headers });
        const login = user.ok ? (await user.json()).login : null;
        const email = login
            ? `${login}@users.noreply.github.com`
            : 'team@users.noreply.github.com';
        await saveForm({ email });
        $('status').textContent = `OK — token can see ${match[1]}/${match[2]}` +
            (login ? `; commits will be authored as ${login}.` : '.');
    } catch (err) {
        $('status').textContent = `Failed: ${err.message}`;
    }
});

loadForm();
