"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), {spawn: spawn} = require("node:child_process");

const {Store: Store} = require("../store"), {Agents: Agents} = require("../agents"), {startApi: startApi} = require("../api"), {AutoSync: AutoSync} = require("../autosync");

const {claim: claim, readSession: readSession, probeSession: probeSession, requestShutdown: requestShutdown} = require("../session");

const PW = "synthetic-service-password";

const ROOT = path.resolve(__dirname, "..");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 15e3) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error("condition not reached");
        await sleep(50);
    }
}

// A synthetic stand-in for the Keychain. Tests never call the real helper.
function fakeKeyring(password = PW) {
    const k = {
        password: password,
        get: () => k.password,
        set: pw => {
            k.password = pw;
            return k.describe();
        },
        clear: () => {
            k.password = null;
        },
        describe: () => ({
            store: "test",
            secure: true,
            detail: "synthetic"
        })
    };
    return k;
}

function fixture(t, {remember: remember = true} = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-service-test-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const store = new Store(dir);
    store.keyring = fakeKeyring();
    store.init(PW);
    store.vault.settings.rememberPassword = remember;
    store.persist();
    store.createProject("Example");
    const agent = new Agents(store).enrol("worker", [ "read", "add" ], [ "Example" ], []);
    return {
        dir: dir,
        store: store,
        agent: agent
    };
}

// Runs backend.cjs --service in a child process whose Keychain is replaced by a synthetic one.
function startService(t, dir) {
    const script = `
const root = ${JSON.stringify(ROOT)};
const {Keyring} = require(root + "/keyring");
Keyring.prototype.get = () => process.env.VAULTOS_TEST_PASSWORD;
Keyring.prototype.set = function () { return this.describe(); };
Keyring.prototype.clear = () => {};
Keyring.prototype.describe = () => ({store: "test", secure: true, detail: "synthetic"});
require(root + "/backend.cjs").main({service: true, pollMs: 100, maxUnlockWaitMs: 200, handoverDelayMs: 600, guardMs: 150, graceMs: 1500}).then((code) => process.exit(code));`;
    const child = spawn(process.execPath, [ "-e", script ], {
        env: {
            ...process.env,
            VAULTOS_DATA_DIR: dir,
            VAULTOS_TEST_PASSWORD: PW
        },
        stdio: [ "ignore", "ignore", "pipe" ]
    });
    child.log = "";
    child.stderr.on("data", d => child.log += d);
    child.exited = new Promise(r => child.on("exit", code => r(code)));
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
    });
    return child;
}

// The desktop's ownership steps, without Electron.
async function desktopOwns(store) {
    assert(await requestShutdown(store.sessionPath));
    const release = claim(store.dataDir);
    if (!store.isUnlocked()) store.unlock(PW);
    const api = await startApi(store);
    store.writeSession(api.port, api.token);
    return () => {
        api.server.close();
        api.server.closeAllConnections();
        store.clearSession();
        store.lock();
        release();
    };
}

async function agentCall(store, agent, p, body) {
    const s = readSession(store.sessionPath);
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, {
        method: body ? "POST" : "GET",
        headers: {
            authorization: `Bearer ${s.token}`,
            "x-vault-agent-token": agent.token,
            "content-type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });
    return {
        status: r.status,
        body: await r.json()
    };
}

const servedBy = (store, pid) => until(async () => readSession(store.sessionPath)?.pid === pid && await probeSession(store.sessionPath));

test("service waits for the desktop, takes over, hands back, and restores a removed session file", async t => {
    const {store: store, agent: agent} = fixture(t);
    let close = await desktopOwns(store);
    const child = startService(t, store.dataDir);
    await until(() => child.log.includes("waiting to take over"));
    assert.equal(readSession(store.sessionPath).pid, process.pid);
    close();
    await servedBy(store, child.pid);
    assert.equal(fs.readFileSync(path.join(store.dataDir, "owner.lock"), "utf8"), String(child.pid));
    assert.equal((await agentCall(store, agent, "/projects")).status, 200);
    fs.unlinkSync(store.sessionPath);
    await servedBy(store, child.pid);
    assert.match(child.log, /restored it/);
    // Opening the window takes ownership; the service stands by and reclaims after it closes.
    close = await desktopOwns(store);
    await sleep(1200);
    assert.equal(readSession(store.sessionPath).pid, process.pid);
    close();
    await servedBy(store, child.pid);
    child.kill("SIGTERM");
    assert.equal(await child.exited, 0);
    assert(!fs.existsSync(store.sessionPath));
    assert(!fs.existsSync(path.join(store.dataDir, "owner.lock")));
});

test("service reloads a vault replaced on disk and keeps both writes", async t => {
    const {store: store, agent: agent} = fixture(t);
    store.lock();
    const child = startService(t, store.dataDir);
    await servedBy(store, child.pid);
    const offline = new Store(store.dataDir);
    offline.keyring = fakeKeyring();
    offline.unlock(PW);
    offline.setSecret("Example", {
        key: "OFFLINE",
        value: "synthetic-offline"
    });
    const written = await agentCall(store, agent, "/projects/Example/secrets", {
        key: "AGENT",
        value: "synthetic-agent"
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.deepEqual((await agentCall(store, agent, "/projects/Example/secrets")).body.map(s => s.key).sort(), [ "AGENT", "OFFLINE" ]);
    child.kill("SIGTERM");
    assert.equal(await child.exited, 0);
    const check = new Store(store.dataDir);
    check.keyring = fakeKeyring();
    check.unlock(PW);
    assert.equal(check.revealSecret("Example", "OFFLINE").value, "synthetic-offline");
    assert.equal(check.revealSecret("Example", "AGENT").value, "synthetic-agent");
});

test("service waits out a manual lock and exits when background access is off", async t => {
    const {store: store} = fixture(t);
    store.blockAutoUnlock();
    store.lock();
    const child = startService(t, store.dataDir);
    await until(() => child.log.includes("manual lock requires a human unlock"));
    assert.equal(await probeSession(store.sessionPath), null);
    store.allowAutoUnlock();
    await servedBy(store, child.pid);
    child.kill("SIGTERM");
    assert.equal(await child.exited, 0);
    const off = fixture(t, {
        remember: false
    });
    off.store.lock();
    const idle = startService(t, off.store.dataDir);
    assert.equal(await idle.exited, 0);
    assert.match(idle.log, /background access is off/);
    assert.equal(await probeSession(off.store.sessionPath), null);
});

test("reload on a changed disk keeps the other writer's data and refuses to drop unsaved changes", t => {
    const {store: store} = fixture(t);
    const other = new Store(store.dataDir);
    other.keyring = fakeKeyring();
    other.unlock(PW);
    assert.equal(store.reloadIfChanged(), false);
    other.setSecret("Example", {
        key: "FROM_OTHER",
        value: "synthetic-other"
    });
    assert.throws(() => store.setSecret("Example", {
        key: "LOCAL",
        value: "x"
    }), /another process/);
    assert.equal(store.reloadIfChanged(), true);
    store.setSecret("Example", {
        key: "LOCAL",
        value: "synthetic-local"
    });
    other.reloadIfChanged();
    assert.deepEqual(other.listSecrets("Example").map(s => s.key).sort(), [ "FROM_OTHER", "LOCAL" ]);
    other.setSecret("Example", {
        key: "AGAIN",
        value: "y"
    });
    store.vault.projects[0].note = "unsaved in-memory change";
    assert.throws(() => store.reloadIfChanged(), /unsaved changes/);
    assert.equal(store.vault.projects[0].note, "unsaved in-memory change");
});

test("lock policy: hard by default; soft affects only automatic triggers; manual lock stays hard", t => {
    const {store: store} = fixture(t);
    const action = trigger => store.lockAction(trigger);
    assert.deepEqual([ "screen", "suspend", "idle", "manual", "window" ].map(action), [ "hard", "hard", "hard", "hard", "release" ]);
    assert.throws(() => store.setSettings({
        lockPolicy: "off"
    }), /lock policy/);
    assert.throws(() => store.setSettings({
        lockPolicy: "soft"
    }, "agent:x"), /human-only/);
    store.setSettings({
        lockPolicy: "soft"
    });
    assert.deepEqual([ "screen", "suspend", "idle", "manual", "window" ].map(action), [ "ui", "ui", "ui", "hard", "release" ]);
    // A soft lock leaves the owner unlocked and background unlock available.
    assert.deepEqual(store.autoUnlockStatus(), {
        ok: true
    });
    // The hard path (as main.js lock()) blocks background unlock until a human unlocks.
    store.blockAutoUnlock();
    store.keyring.clear();
    store.lock();
    assert.equal(store.lockAction("screen"), "hard");
    assert.equal(store.autoUnlockStatus().reason, "locked");
    store.allowAutoUnlock();
    assert.equal(store.autoUnlockStatus().reason, "no-password");
    store.keyring.set(PW);
    assert.equal(store.autoUnlock(), true);
});

test("POST /sync is owner-only: agents are refused even with every scope", async t => {
    const {store: store} = fixture(t);
    const all = new Agents(store).enrol("all-scopes", require("../model").ALL_SCOPES, [ "Example" ], []);
    const auto = new AutoSync(store, {
        repo: path.join(store.dataDir, "no-sync-repo")
    });
    let runs = 0;
    const run = auto.run.bind(auto);
    auto.run = (...args) => {
        runs++;
        return run(...args);
    };
    const api = await startApi(store, {
        autoSync: auto
    });
    t.after(async () => {
        api.server.closeAllConnections();
        await new Promise(r => api.server.close(r));
    });
    const post = headers => fetch(`http://127.0.0.1:${api.port}/sync`, {
        method: "POST",
        headers: headers
    });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({
        authorization: "Bearer " + "0".repeat(64)
    })).status, 401);
    assert.equal((await post({
        authorization: `Bearer ${api.token}`,
        "x-vault-agent-token": all.token
    })).status, 403);
    assert.equal((await post({
        authorization: `Bearer ${api.token}`,
        origin: "https://hostile.example"
    })).status, 403);
    assert.equal(runs, 0);
    const unconfigured = await post({
        authorization: `Bearer ${api.token}`
    });
    assert.equal(unconfigured.status, 409);
    assert.match((await unconfigured.json()).error, /not initialized/);
    assert.equal(runs, 1);
    const status = async headers => (await (await fetch(`http://127.0.0.1:${api.port}/status`, {
        headers: headers
    })).json()).sync;
    assert.equal((await status({})).error, undefined);
    assert.equal((await status({
        authorization: `Bearer ${api.token}`
    })).error, null);
    store.lock();
    assert.equal((await post({
        authorization: `Bearer ${api.token}`
    })).status, 423);
});
