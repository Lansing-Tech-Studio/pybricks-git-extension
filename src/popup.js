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
    // Empty token input = "no change", not "clear it": right after OAuth sign-in
    // the field is blank until the next refresh, so Save/Test must keep the
    // freshly stored token. Sign out is the way to clear the token.
    if (!$('token').value.trim()) next.token = settings.token ?? '';
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
        $('status').textContent = 'Repo/fork URL must look like https://github.com/owner/repo';
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

const send = (msg) => chrome.runtime.sendMessage(msg);

let prevSignedIn = false;

async function refreshAuth() {
    const st = await send({ op: 'authStatus' });
    if (st.error) {
        $('signIn').disabled = false;
        $('authState').textContent = st.error;
        $('status').textContent = st.error;
        return;
    }
    $('signedIn').hidden = !st.signedIn;
    $('signedOut').hidden = st.signedIn;
    // Keep Sign in disabled while a flow is pending so a second click can't
    // supersede the code the user is already typing; re-enable in every other state.
    $('signIn').disabled = st.state === 'pending';

    if (st.state === 'pending') {
        $('devicePrompt').hidden = false;
        $('verifyLink').href = st.verificationUri;
        $('verifyLink').textContent = st.verificationUri;
        $('userCode').textContent = st.userCode;
        $('authState').textContent = 'Waiting for GitHub…';
    } else if (st.state === 'error') {
        $('devicePrompt').hidden = false;
        $('authState').textContent = st.message || 'Sign-in failed.';
    } else {
        $('devicePrompt').hidden = true;
    }

    $('whoami').textContent = st.login ? `Signed in as ${st.login}` : 'Using pasted token';

    if (st.signedIn && !prevSignedIn) loadForm();
    prevSignedIn = st.signedIn;
}

$('signIn').addEventListener('click', async () => {
    $('signIn').disabled = true; // block a double-click superseding the flow mid-start
    const res = await send({ op: 'authStart' });
    if (res.error) $('status').textContent = res.error;
    await refreshAuth(); // reconciles the disabled state to the resulting flow state
});

$('cancelAuth').addEventListener('click', async () => {
    await send({ op: 'authCancel' });
    await refreshAuth();
});

$('signOut').addEventListener('click', async () => {
    await send({ op: 'authSignOut' });
    await refreshAuth();
    await loadForm();
});

loadForm();
refreshAuth();
setInterval(refreshAuth, 2000);
