"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), {execFileSync: execFileSync} = require("node:child_process");

const {Store: Store} = require("../store"), {Sync: Sync} = require("../sync"), {AutoSync: AutoSync} = require("../autosync"), {startApi: startApi} = require("../api");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 2e4) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error("condition not reached");
        await sleep(25);
    }
}

// Two devices with separate checkouts of one bare remote, enrolled and trusting each other.
function gitPair(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-autosync-test-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const git = (...args) => execFileSync("git", args, {
        stdio: "pipe",
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1"
        }
    }).toString().trim();
    const identity = repo => {
        git("-C", repo, "config", "user.name", "Synthetic Test");
        git("-C", repo, "config", "user.email", "test@example.invalid");
    };
    const remote = path.join(dir, "remote.git");
    git("init", "--bare", "--initial-branch=main", remote);
    const a = new Store(path.join(dir, "a")), b = new Store(path.join(dir, "b"));
    a.init("synthetic-password-a");
    b.init("synthetic-password-b");
    const repoA = path.join(dir, "repo-a"), repoB = path.join(dir, "repo-b");
    git("init", "-b", "main", repoA);
    identity(repoA);
    git("-C", repoA, "remote", "add", "origin", remote);
    const sa = new Sync(a, repoA), ia = sa.init("Machine A");
    assert(sa.pushRemote().delivered);
    git("clone", "--quiet", remote, repoB);
    identity(repoB);
    const sb = new Sync(b, repoB), ib = sb.init("Machine B");
    sa.trustMachine(ib);
    sb.trustMachine(ia);
    assert(sb.pushRemote().delivered);
    sa.pullRemote();
    assert(sa.pushRemote().delivered);
    sb.pullRemote();
    return {
        a: a,
        b: b,
        sa: sa,
        sb: sb,
        repoA: repoA,
        repoB: repoB,
        remote: remote,
        git: git
    };
}

function counted(auto) {
    const run = auto.run.bind(auto);
    auto.runs = 0;
    auto.run = (...args) => {
        auto.runs++;
        return run(...args);
    };
    return auto;
}

test("autosync is off by default and validates its settings", t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-autosync-settings-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const store = new Store(dir);
    store.init("synthetic-settings-password");
    assert.deepEqual(store.getSettings().autoSync, {
        enabled: false,
        intervalSeconds: 120
    });
    assert.equal(store.getSettings().lockPolicy, "hard");
    for (const bad of [ {
        intervalSeconds: 5
    }, {
        enabled: "yes"
    }, {
        extra: true
    } ]) assert.throws(() => store.setSettings({
        autoSync: bad
    }));
    assert.throws(() => store.setSettings({
        autoSync: {
            enabled: true
        }
    }, "agent:x"), /human-only/);
    store.setSettings({
        autoSync: {
            enabled: true
        }
    });
    store.setSettings({
        autoSync: {
            intervalSeconds: 300
        }
    });
    assert.deepEqual(store.getSettings().autoSync, {
        enabled: true,
        intervalSeconds: 300
    });
    const auto = new AutoSync(store, {
        repo: path.join(dir, "no-repo")
    }).start();
    assert.equal(auto.status().state, "NOT_CONFIGURED");
    assert.throws(() => auto.run({
        manual: true
    }), /not initialized/);
    auto.stop();
});

test("autosync pushes once, debounced, after local changes and pulls on its interval", async t => {
    const {a: a, b: b, sb: sb, repoA: repoA, repoB: repoB} = gitPair(t);
    a.setSettings({
        autoSync: {
            enabled: true
        }
    });
    b.setSettings({
        autoSync: {
            enabled: true
        }
    });
    const autoA = counted(new AutoSync(a, {
        repo: repoA,
        intervalMs: 6e4,
        debounceMs: 300,
        startDelayMs: 6e4
    })).start();
    const autoB = counted(new AutoSync(b, {
        repo: repoB,
        intervalMs: 400,
        debounceMs: 6e4,
        startDelayMs: 6e4
    }));
    t.after(() => {
        autoA.stop();
        autoB.stop();
    });
    a.createProject("Example");
    a.setSecret("Example", {
        key: "FIRST",
        value: "synthetic-one"
    });
    a.setSecret("Example", {
        key: "SECOND",
        value: "synthetic-two"
    });
    assert.equal(autoA.runs, 0);
    await until(() => autoA.status().state === "OK");
    await sleep(400);
    assert.equal(autoA.runs, 1);
    assert.equal(autoA.status().sent, 2);
    assert(autoA.status().lastSyncAt);
    autoB.start();
    await until(() => b.findProject("Example") && b.listSecrets("Example").length === 2);
    assert(autoB.runs >= 1);
    assert.equal(b.revealSecret("Example", "SECOND").value, "synthetic-two");
    assert.equal(autoB.status().received.added, 2);
    assert.equal(sb.status().outgoing, 0);
});

test("autosync pauses while the vault is locked and resumes after unlock", async t => {
    const {a: a, repoA: repoA} = gitPair(t);
    a.setSettings({
        autoSync: {
            enabled: true
        }
    });
    const auto = counted(new AutoSync(a, {
        repo: repoA,
        intervalMs: 150,
        debounceMs: 50,
        startDelayMs: 50
    })).start();
    t.after(() => auto.stop());
    await until(() => auto.status().state === "OK");
    a.lock();
    auto.pause();
    const attempted = auto.status().lastAttemptAt, runs = auto.runs;
    assert.equal(auto.status().state, "PAUSED_LOCKED");
    await sleep(600);
    assert.equal(auto.runs, runs);
    assert.equal(auto.run().lastAttemptAt, attempted);
    assert.throws(() => auto.run({
        manual: true
    }), /locked/);
    a.unlock("synthetic-password-a");
    auto.refresh();
    await until(() => auto.status().lastAttemptAt !== attempted);
    assert.equal(auto.status().state, "OK");
});

test("autosync halts on a conflict, publishes nothing and leaves resolution to a human", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA} = gitPair(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "base"
    });
    assert(sa.pushRemote().delivered);
    sb.pullRemote();
    b.setSecret("Example", {
        key: "KEY",
        value: "right"
    });
    b.setSecret("Example", {
        key: "KEY",
        value: "right-again"
    });
    assert(sb.pushRemote().delivered);
    a.setSettings({
        autoSync: {
            enabled: true
        }
    });
    const auto = counted(new AutoSync(a, {
        repo: repoA,
        intervalMs: 200,
        debounceMs: 50,
        startDelayMs: 6e4
    })).start();
    t.after(() => auto.stop());
    a.setSecret("Example", {
        key: "KEY",
        value: "left"
    });
    await until(() => auto.status().halted);
    assert.equal(auto.status().state, "CONFLICTS_PENDING");
    assert.equal(auto.status().conflicts, 1);
    assert.equal(auto.timer, null);
    const runs = auto.runs;
    await sleep(500);
    assert.equal(auto.runs, runs);
    assert.equal(a.revealSecret("Example", "KEY").value, "left");
    sb.pullRemote();
    assert.equal(b.revealSecret("Example", "KEY").value, "right-again");
    // An owner-requested sync runs the same gated round: still refused, still halted.
    const api = await startApi(a, {
        autoSync: auto
    });
    t.after(() => {
        api.server.closeAllConnections();
        api.server.close();
    });
    const response = await fetch(`http://127.0.0.1:${api.port}/sync`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${api.token}`
        }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.state, "CONFLICTS_PENDING");
    assert.equal(a.revealSecret("Example", "KEY").value, "left");
    sa.pullRemote({
        acceptConflicts: true
    });
    auto.clearHalt();
    assert.equal(auto.status().halted, false);
    await until(() => auto.status().state === "OK");
    assert.equal(a.revealSecret("Example", "KEY").value, "right-again");
});

test("concurrent pushes from both devices rebase and deliver both records", t => {
    const {a: a, b: b, sa: sa, sb: sb} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "BASE",
        value: "synthetic-base"
    });
    assert(sa.pushRemote().delivered);
    sb.pullRemote();
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    b.setSecret("Shared", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert(sa.pushRemote().delivered);
    const pushed = sb.pushRemote();
    assert(pushed.delivered, JSON.stringify(pushed));
    assert.equal(pushed.rebased, true);
    sa.pullRemote();
    sb.pullRemote();
    for (const store of [ a, b ]) assert.deepEqual(store.listSecrets("Shared").map(s => s.key).sort(), [ "BASE", "FROM_A", "FROM_B" ]);
    assert.equal(sa.statusRemote().state, "IN_SYNC");
});

test("a peer whose signed heartbeat is older than 48 hours is reported as stalled", t => {
    const {a: a, sa: sa, repoA: repoA} = gitPair(t);
    assert.equal(sa.statusRemote().state, "IN_SYNC");
    assert.deepEqual(sa.peerProblems(), []);
    t.mock.timers.enable({
        apis: [ "Date" ],
        now: Date.now() + 49 * 36e5
    });
    const status = sa.statusRemote();
    assert.equal(status.state, "PEER_STALLED");
    assert.match(status.detail, /Machine B has not reported for 49h/);
    const auto = new AutoSync(a, {
        repo: repoA
    });
    const round = auto.run({
        manual: true
    });
    assert.equal(round.state, "OK");
    assert.equal(round.peerStalled, true);
    assert.equal(auto.publicStatus().peerStalled, true);
    assert.equal(auto.publicStatus().error, undefined);
});
