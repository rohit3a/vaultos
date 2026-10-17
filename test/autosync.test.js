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
    // The halt and its reason are in the activity log, not only in a log nobody reads.
    assert(a.readAudit().some(e => e.actor === "autosync" && e.action === "sync_halted" && e.detail.startsWith("CONFLICTS_PENDING")));
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

// What a round that stopped between writing and committing leaves behind: ciphertext and this
// machine's manifest written but never committed, and a heartbeat committed but never pushed.
function leaveRoundUncommitted(sync) {
    sync.push();
    sync.publishHeartbeat();
    assert(sync.git.commitPaths([ "peers" ], `heartbeat: ${sync.machineId()}`).committed);
}

function autosyncFor(store, repo) {
    store.setSettings({
        autoSync: {
            enabled: true
        }
    });
    return new AutoSync(store, {
        repo: repo
    });
}

test("a round commits what an earlier round left uncommitted, so it can rebase onto the peer", t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, git: git} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    leaveRoundUncommitted(sa);
    b.createProject("Other");
    b.setSecret("Other", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert(sb.pushRemote().delivered);
    assert.match(git("-C", repoA, "status", "--porcelain"), new RegExp(`manifests/${sa.machineId()}\\.json`));
    // Git will not rebase over the uncommitted manifest; this halted every later round.
    assert.equal(sa.git.pullFF().code, "LOCAL_SYNC_REPO_DIRTY");
    const round = autosyncFor(a, repoA).run();
    assert.equal(round.state, "OK", round.error);
    assert.equal(round.halted, false);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    assert.equal(a.revealSecret("Other", "FROM_B").value, "synthetic-b");
    sb.pullRemote();
    assert.equal(b.revealSecret("Shared", "FROM_A").value, "synthetic-a");
    assert.equal(sa.statusRemote().state, "IN_SYNC");
});

test("a commit refused over another staged file is retried, and the next round delivers", t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, git: git} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    sa.pullRemote();
    // This machine's heartbeat is staged when the round comes to commit its records.
    sa.publishHeartbeat();
    git("-C", repoA, "add", "--", `peers/${sa.machineId()}.json`);
    const refused = sa.pushRemote();
    assert.equal(refused.delivered, false);
    assert.equal(refused.code, "COMMIT_FAILED");
    assert.match(refused.error, /^Unrelated staged files; refusing to commit: peers\//);
    // The heartbeat commit still went ahead, leaving the manifest uncommitted on top of it.
    assert.match(git("-C", repoA, "status", "--porcelain"), /manifests\//);
    assert.equal(git("-C", repoA, "diff", "--cached", "--name-only"), "");
    b.createProject("Other");
    b.setSecret("Other", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert(sb.pushRemote().delivered);
    const round = autosyncFor(a, repoA).run();
    assert.equal(round.state, "OK", round.error);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    sb.pullRemote();
    assert.equal(b.revealSecret("Shared", "FROM_A").value, "synthetic-a");
});

test("a failed commit unstages what it staged, and autosync retries instead of halting", t => {
    const {a: a, b: b, sb: sb, repoA: repoA, git: git} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    // Another Git process holding the branch lock makes `git commit` fail after `git add`.
    const lock = path.join(repoA, ".git", "refs", "heads", "main.lock");
    fs.writeFileSync(lock, "");
    const auto = autosyncFor(a, repoA);
    const failed = auto.run();
    assert.equal(failed.state, "PUSH_NOT_DELIVERED");
    assert.equal(failed.halted, false);
    assert.match(failed.error, /main\.lock/);
    assert.equal(git("-C", repoA, "diff", "--cached", "--name-only"), "");
    assert.match(git("-C", repoA, "status", "--porcelain"), /records\//);
    assert(!a.readAudit().some(e => e.action === "sync_halted"));
    fs.unlinkSync(lock);
    b.createProject("Other");
    b.setSecret("Other", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert(sb.pushRemote().delivered);
    const round = auto.run();
    assert.equal(round.state, "OK", round.error);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    sb.pullRemote();
    assert.equal(b.revealSecret("Shared", "FROM_A").value, "synthetic-a");
});

test("a round still halts when both machines changed the same record, and discards neither", t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, remote: remote, git: git} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "KEY",
        value: "synthetic-base"
    });
    assert(sa.pushRemote().delivered);
    sb.pullRemote();
    a.setSecret("Shared", {
        key: "KEY",
        value: "synthetic-from-a"
    });
    leaveRoundUncommitted(sa);
    b.setSecret("Shared", {
        key: "KEY",
        value: "synthetic-from-b"
    });
    assert(sb.pushRemote().delivered);
    const remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = autosyncFor(a, repoA).run();
    assert.equal(round.state, "GIT_HISTORY_DIVERGED");
    assert.equal(round.halted, true);
    assert(a.readAudit().some(e => e.actor === "autosync" && e.action === "sync_halted" && e.detail.startsWith("GIT_HISTORY_DIVERGED")));
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
    // A's ciphertext is now a local commit rather than loose files; nothing was thrown away.
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    assert.match(git("-C", repoA, "log", "-1", "--format=%s"), /left uncommitted by an earlier round/);
    assert.equal(a.revealSecret("Shared", "KEY").value, "synthetic-from-a");
});

test("leftovers that fail verification stay uncommitted, and the round halts", t => {
    const {a: a, sa: sa, repoA: repoA, remote: remote, git: git} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    leaveRoundUncommitted(sa);
    const record = fs.readdirSync(path.join(repoA, "records"))[0];
    fs.writeFileSync(path.join(repoA, "records", record), "tampered");
    const before = git("-C", repoA, "status", "--porcelain"), remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = autosyncFor(a, repoA).run();
    assert.equal(round.halted, true);
    assert.match(round.error, /refusing to pull/);
    assert.equal(git("-C", repoA, "status", "--porcelain"), before);
    assert.equal(fs.readFileSync(path.join(repoA, "records", record), "utf8"), "tampered");
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
});

test("leftovers do not carry a round past tampered ciphertext from a peer", t => {
    const {a: a, sa: sa, sb: sb, repoA: repoA, repoB: repoB, remote: remote, git: git} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    assert(sa.pushRemote().delivered);
    sb.pullRemote();
    const record = fs.readdirSync(path.join(repoB, "records"))[0];
    fs.writeFileSync(path.join(repoB, "records", record), "tampered");
    git("-C", repoB, "commit", "--quiet", "-am", "tamper");
    git("-C", repoB, "push", "--quiet", "origin", "HEAD:main");
    leaveRoundUncommitted(sa);
    const remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = autosyncFor(a, repoA).run();
    assert.equal(round.halted, true);
    assert.match(round.error, /refusing to pull/);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
    assert.equal(a.revealSecret("Shared", "FROM_A").value, "synthetic-a");
});

test("leftovers do not carry a round past records this machine cannot decrypt", t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, repoB: repoB, remote: remote, git: git} = gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    assert(sa.pushRemote().delivered);
    sb.pullRemote();
    // B re-encrypts every record for itself alone.
    fs.writeFileSync(path.join(repoB, "recipients.txt"), `# Machine B\n${sb.identity().agePublicKey}\n`);
    b.setSecret("Shared", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert(sb.pushRemote().delivered);
    leaveRoundUncommitted(sa);
    const remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = autosyncFor(a, repoA).run();
    assert.equal(round.state, "UNREADABLE_RECORDS");
    assert.equal(round.halted, true);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
    assert.throws(() => a.revealSecret("Shared", "FROM_B"));
});
