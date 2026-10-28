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
async function gitPair(t) {
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
    assert((await sa.pushRemote()).delivered);
    git("clone", "--quiet", remote, repoB);
    identity(repoB);
    const sb = new Sync(b, repoB), ib = sb.init("Machine B");
    sa.trustMachine(ib);
    sb.trustMachine(ia);
    assert((await sb.pushRemote()).delivered);
    await sa.pullRemote();
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
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

test("autosync is off by default and validates its settings", async t => {
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
    await assert.rejects(auto.run({
        manual: true
    }), /not initialized/);
    auto.stop();
});

test("autosync pushes once, debounced, after local changes and pulls on its interval", async t => {
    const {a: a, b: b, sb: sb, repoA: repoA, repoB: repoB} = await gitPair(t);
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
    // Pulled records land before the round's push finishes, so wait for the round itself.
    await until(() => autoB.status().received?.added === 2);
    assert.equal(b.listSecrets("Example").length, 2);
    assert(autoB.runs >= 1);
    assert.equal(b.revealSecret("Example", "SECOND").value, "synthetic-two");
    assert.equal(autoB.status().received.added, 2);
    assert.equal(sb.status().outgoing, 0);
});

test("autosync pauses while the vault is locked and resumes after unlock", async t => {
    const {a: a, repoA: repoA} = await gitPair(t);
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
    assert.equal((await auto.run()).lastAttemptAt, attempted);
    await assert.rejects(auto.run({
        manual: true
    }), /locked/);
    a.unlock("synthetic-password-a");
    auto.refresh();
    await until(() => auto.status().lastAttemptAt !== attempted);
    assert.equal(auto.status().state, "OK");
});

test("autosync halts on a conflict, publishes nothing and leaves resolution to a human", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA} = await gitPair(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "base"
    });
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
    b.setSecret("Example", {
        key: "KEY",
        value: "right"
    });
    b.setSecret("Example", {
        key: "KEY",
        value: "right-again"
    });
    assert((await sb.pushRemote()).delivered);
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
    await sb.pullRemote();
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
    await sa.pullRemote({
        acceptConflicts: true
    });
    auto.clearHalt();
    assert.equal(auto.status().halted, false);
    await until(() => auto.status().state === "OK");
    assert.equal(a.revealSecret("Example", "KEY").value, "right-again");
});

test("concurrent pushes from both devices rebase and deliver both records", async t => {
    const {a: a, b: b, sa: sa, sb: sb} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "BASE",
        value: "synthetic-base"
    });
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    b.setSecret("Shared", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert((await sa.pushRemote()).delivered);
    const pushed = await sb.pushRemote();
    assert(pushed.delivered, JSON.stringify(pushed));
    assert.equal(pushed.rebased, true);
    await sa.pullRemote();
    await sb.pullRemote();
    for (const store of [ a, b ]) assert.deepEqual(store.listSecrets("Shared").map(s => s.key).sort(), [ "BASE", "FROM_A", "FROM_B" ]);
    assert.equal((await sa.statusRemote()).state, "IN_SYNC");
});

test("a peer whose signed heartbeat is older than 48 hours is reported as stalled", async t => {
    const {a: a, sa: sa, repoA: repoA} = await gitPair(t);
    assert.equal((await sa.statusRemote()).state, "IN_SYNC");
    assert.deepEqual(sa.peerProblems(), []);
    t.mock.timers.enable({
        apis: [ "Date" ],
        now: Date.now() + 49 * 36e5
    });
    const status = await sa.statusRemote();
    assert.equal(status.state, "PEER_STALLED");
    assert.match(status.detail, /Machine B has not reported for 49h/);
    const auto = new AutoSync(a, {
        repo: repoA
    });
    const round = await auto.run({
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

test("a round commits what an earlier round left uncommitted, so it can rebase onto the peer", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, git: git} = await gitPair(t);
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
    assert((await sb.pushRemote()).delivered);
    assert.match(git("-C", repoA, "status", "--porcelain"), new RegExp(`manifests/${sa.machineId()}\\.json`));
    // Git will not rebase over the uncommitted manifest; this halted every later round.
    assert.equal((await sa.git.pullFF()).code, "LOCAL_SYNC_REPO_DIRTY");
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.state, "OK", round.error);
    assert.equal(round.halted, false);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    assert.equal(a.revealSecret("Other", "FROM_B").value, "synthetic-b");
    await sb.pullRemote();
    assert.equal(b.revealSecret("Shared", "FROM_A").value, "synthetic-a");
    assert.equal((await sa.statusRemote()).state, "IN_SYNC");
});

test("a commit refused over another staged file is retried, and the next round delivers", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    await sa.pullRemote();
    // This machine's heartbeat is staged when the round comes to commit its records.
    sa.publishHeartbeat();
    git("-C", repoA, "add", "--", `peers/${sa.machineId()}.json`);
    const refused = await sa.pushRemote();
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
    assert((await sb.pushRemote()).delivered);
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.state, "OK", round.error);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    await sb.pullRemote();
    assert.equal(b.revealSecret("Shared", "FROM_A").value, "synthetic-a");
});

test("a failed commit unstages what it staged, and autosync retries instead of halting", async t => {
    const {a: a, b: b, sb: sb, repoA: repoA, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    // Another Git process holding the branch lock makes `git commit` fail after `git add`.
    const lock = path.join(repoA, ".git", "refs", "heads", "main.lock");
    fs.writeFileSync(lock, "");
    const auto = autosyncFor(a, repoA);
    const failed = await auto.run();
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
    assert((await sb.pushRemote()).delivered);
    const round = await auto.run();
    assert.equal(round.state, "OK", round.error);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    await sb.pullRemote();
    assert.equal(b.revealSecret("Shared", "FROM_A").value, "synthetic-a");
});

test("a round waits for another process that is still saving the vault, and does not halt", async t => {
    const {a: a, b: b, sb: sb, repoA: repoA} = await gitPair(t);
    const auto = autosyncFor(a, repoA);
    const other = new Store(a.dataDir);
    other.unlock("synthetic-password-a");
    other.createProject("Saved elsewhere");
    other.setSecret("Saved elsewhere", {
        key: "OTHER",
        value: "synthetic-other"
    });
    // That process (the CLI, say) has renamed vault.enc into place but not yet released its
    // lock. A live pid that is not this process stands in for it.
    const lock = path.join(a.dataDir, "write.lock");
    fs.writeFileSync(lock, String(process.ppid));
    const waiting = await auto.run();
    assert.equal(waiting.state, "VAULT_BUSY");
    assert.equal(waiting.halted, false);
    assert(!a.readAudit().some(e => e.action === "sync_halted"));
    fs.unlinkSync(lock);
    const round = await auto.run();
    assert.equal(round.state, "OK", round.error);
    await sb.pullRemote();
    assert.equal(b.revealSecret("Saved elsewhere", "OTHER").value, "synthetic-other");
});

test("a commit that keeps failing halts after three rounds, with Git's reason in the activity log", async t => {
    const {a: a, repoA: repoA, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    // Left by a Git process that crashed: every add and commit fails until someone removes it.
    const lock = path.join(repoA, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const auto = autosyncFor(a, repoA);
    for (const round of [ 1, 2 ]) {
        const failed = await auto.run();
        assert.equal(failed.halted, false, `round ${round}`);
        assert.match(failed.error, /index\.lock/);
    }
    const halted = await auto.run();
    assert.equal(halted.halted, true);
    assert.equal(halted.state, "COMMIT_FAILED");
    assert(a.readAudit().some(e => e.actor === "autosync" && e.action === "sync_halted" && /^COMMIT_FAILED: .*index\.lock/.test(e.detail)));
    assert.equal((await auto.run()).lastAttemptAt, halted.lastAttemptAt);
    fs.unlinkSync(lock);
    const round = await auto.run({
        manual: true
    });
    assert.equal(round.state, "OK", round.error);
    assert.equal(round.halted, false);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
});

test("a round still halts when both machines changed the same record, and discards neither", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, remote: remote, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "KEY",
        value: "synthetic-base"
    });
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
    a.setSecret("Shared", {
        key: "KEY",
        value: "synthetic-from-a"
    });
    leaveRoundUncommitted(sa);
    b.setSecret("Shared", {
        key: "KEY",
        value: "synthetic-from-b"
    });
    assert((await sb.pushRemote()).delivered);
    const remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.state, "GIT_HISTORY_DIVERGED");
    assert.equal(round.halted, true);
    assert(a.readAudit().some(e => e.actor === "autosync" && e.action === "sync_halted" && e.detail.startsWith("GIT_HISTORY_DIVERGED")));
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
    // A's ciphertext is now a local commit rather than loose files; nothing was thrown away.
    assert.equal(git("-C", repoA, "status", "--porcelain"), "");
    assert.match(git("-C", repoA, "log", "-1", "--format=%s"), /left uncommitted by an earlier round/);
    assert.equal(a.revealSecret("Shared", "KEY").value, "synthetic-from-a");
});

test("leftovers that fail verification stay uncommitted, and the round halts", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, remote: remote, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    leaveRoundUncommitted(sa);
    const record = fs.readdirSync(path.join(repoA, "records"))[0];
    fs.writeFileSync(path.join(repoA, "records", record), "tampered");
    // The peer moves on too, so the halt must give the verification failure, not the rebase.
    b.createProject("Other");
    b.setSecret("Other", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert((await sb.pushRemote()).delivered);
    const before = git("-C", repoA, "status", "--porcelain"), remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.halted, true);
    assert.equal(round.state, "SIGNATURE_INVALID");
    assert.match(round.error, /^refusing to pull: .*ciphertext/);
    assert.equal(git("-C", repoA, "status", "--porcelain"), before);
    assert.equal(fs.readFileSync(path.join(repoA, "records", record), "utf8"), "tampered");
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
});

test("leftovers do not carry a round past tampered ciphertext from a peer", async t => {
    const {a: a, sa: sa, sb: sb, repoA: repoA, repoB: repoB, remote: remote, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
    const record = fs.readdirSync(path.join(repoB, "records"))[0];
    fs.writeFileSync(path.join(repoB, "records", record), "tampered");
    git("-C", repoB, "commit", "--quiet", "-am", "tamper");
    git("-C", repoB, "push", "--quiet", "origin", "HEAD:main");
    leaveRoundUncommitted(sa);
    const remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.halted, true);
    assert.match(round.error, /refusing to pull/);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
    assert.equal(a.revealSecret("Shared", "FROM_A").value, "synthetic-a");
});

test("leftovers do not carry a round past records this machine cannot decrypt", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, repoB: repoB, remote: remote, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
    // B re-encrypts every record for itself alone.
    fs.writeFileSync(path.join(repoB, "recipients.txt"), `# Machine B\n${sb.identity().agePublicKey}\n`);
    b.setSecret("Shared", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert((await sb.pushRemote()).delivered);
    leaveRoundUncommitted(sa);
    const remoteHead = git("--git-dir", remote, "rev-parse", "main");
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.state, "UNREADABLE_RECORDS");
    assert.equal(round.halted, true);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), remoteHead);
    assert.throws(() => a.revealSecret("Shared", "FROM_B"));
});

test("files sync did not write are never committed, read or deleted, and halt neither device", async t => {
    const {a: a, b: b, sa: sa, repoA: repoA, repoB: repoB, remote: remote, git: git} = await gitPair(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "synthetic-stray"
    });
    // Finder's .DS_Store, a stray .age file and the temporary file of an interrupted atomicWrite.
    const strays = [ "records/.DS_Store", "records/notes.age", `tombstones/.${"0".repeat(64)}.age.${"0".repeat(24)}`, "manifests/.DS_Store", "machines/.DS_Store" ];
    // Finder writes .DS_Store whenever a folder is open, so one can land after push() has
    // verified the checkout and before Git stages it.
    const push = sa.push.bind(sa);
    sa.push = () => {
        const wrote = push();
        for (const f of strays) fs.writeFileSync(path.join(repoA, f), "not ciphertext");
        return wrote;
    };
    await sa.pullRemote();
    assert((await sa.pushRemote()).delivered);
    sa.push = push;
    const autoB = new AutoSync(b, {
        repo: repoB
    });
    const roundB = await autoB.run({
        manual: true
    });
    assert.deepEqual({
        state: roundB.state,
        halted: roundB.halted,
        error: roundB.error
    }, {
        state: "OK",
        halted: false,
        error: null
    });
    assert.equal(b.revealSecret("Example", "KEY").value, "synthetic-stray");
    // Already there when the next round starts.
    a.setSecret("Example", {
        key: "SECOND",
        value: "synthetic-second"
    });
    const roundA = await new AutoSync(a, {
        repo: repoA
    }).run({
        manual: true
    });
    assert.deepEqual({
        state: roundA.state,
        error: roundA.error
    }, {
        state: "OK",
        error: null
    });
    const roundB2 = await autoB.run({
        manual: true
    });
    assert.equal(roundB2.state, "OK");
    assert.equal(b.revealSecret("Example", "SECOND").value, "synthetic-second");
    // Nor do they count as records waiting to be sent, here or in the heartbeat B reads.
    assert.deepEqual(roundB2.peerProblems, []);
    assert.deepEqual((await sa.statusRemote()).uncommittedFiles, []);
    // A record sync removes is still committed as removed.
    a.deleteSecret("Example", "SECOND");
    assert.equal((await new AutoSync(a, {
        repo: repoA
    }).run({
        manual: true
    })).state, "OK");
    assert.equal((await autoB.run({
        manual: true
    })).state, "OK");
    assert.deepEqual(b.listSecrets("Example").map(s => s.key), [ "KEY" ]);
    const published = git("--git-dir", remote, "log", "--format=", "--name-only").split("\n");
    for (const f of strays) {
        assert(!published.includes(f), `${f} was committed`);
        assert(fs.existsSync(path.join(repoA, f)), `${f} was deleted`);
    }
});

test("a file sync did not write is refused once it arrives in a commit", async t => {
    const {sa: sa, repoA: repoA, repoB: repoB, git: git} = await gitPair(t);
    // An untracked file with a record's name is still checked like any record.
    const forged = path.join(repoA, "records", "f".repeat(64) + ".age");
    fs.writeFileSync(forged, "not signed");
    assert(sa.verifyManifests().problems.includes("Unsigned or modified ciphertext"));
    fs.unlinkSync(forged);
    // As an older VaultOS, a hand-made commit or anyone with write access to the remote could.
    fs.writeFileSync(path.join(repoB, "records", ".DS_Store"), "not ciphertext");
    fs.mkdirSync(path.join(repoB, "tombstones", "nested"));
    fs.writeFileSync(path.join(repoB, "tombstones", "nested", "file"), "not ciphertext");
    git("-C", repoB, "add", "records/.DS_Store", "tombstones/nested/file");
    git("-C", repoB, "commit", "--quiet", "-m", "stray files");
    git("-C", repoB, "push", "--quiet", "origin", "main");
    await assert.rejects(sa.pullRemote(), /refusing to pull/);
    assert.deepEqual(sa.verifyManifests().problems, [ 'Unexpected file in the sync repository: "records/.DS_Store"', 'Unexpected file in the sync repository: "tombstones/nested"' ]);
});

test("the next push takes stray files Git already tracks out of the repository and keeps the local copies", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, repoB: repoB, remote: remote, git: git} = await gitPair(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "synthetic-stray"
    });
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
    // Committed by hand, or by an older version that ran `git add` on whole folders.
    const strays = [ "records/.DS_Store", "tombstones/.DS_Store", "peers/.DS_Store" ];
    for (const f of strays) fs.writeFileSync(path.join(repoB, f), "not ciphertext");
    git("-C", repoB, "add", ...strays);
    git("-C", repoB, "commit", "--quiet", "-m", "stray files");
    git("-C", repoB, "push", "--quiet", "origin", "main");
    await assert.rejects(sa.pullRemote(), /refusing to pull/);
    // Removed with `git rm` as docs/SYNC.md says, deleted by hand, and rewritten by Finder in a
    // folder verification does not check.
    git("-C", repoA, "rm", "--quiet", "records/.DS_Store");
    fs.unlinkSync(path.join(repoA, "tombstones", ".DS_Store"));
    fs.writeFileSync(path.join(repoA, "peers", ".DS_Store"), "rewritten by Finder");
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.state, "OK", round.error);
    assert.doesNotMatch(git("--git-dir", remote, "ls-tree", "-r", "--name-only", "main"), /DS_Store/);
    assert.equal(fs.readFileSync(path.join(repoA, "peers", ".DS_Store"), "utf8"), "rewritten by Finder");
    assert.equal(git("-C", repoA, "status", "--porcelain"), "?? peers/.DS_Store");
    await sb.pullRemote();
    assert.equal(b.revealSecret("Example", "KEY").value, "synthetic-stray");
});

test("a stray file named like a wildcard is not read as one", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, remote: remote, git: git} = await gitPair(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "synthetic-key"
    });
    assert((await sa.pushRemote()).delivered);
    await sb.pullRemote();
    const tree = () => git("--git-dir", remote, "ls-tree", "-r", "--name-only", "main").split("\n");
    const before = tree();
    // Git reads `records/*` in a pathspec as every record unless told to take names literally.
    for (const dir of [ "records", "machines", "peers" ]) fs.writeFileSync(path.join(repoA, dir, "*"), "not ciphertext");
    a.setSecret("Example", {
        key: "OTHER",
        value: "synthetic-other"
    });
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.state, "OK", round.error);
    const after = tree();
    for (const f of before) assert(after.includes(f), `${f} was removed from the remote`);
    assert(!after.some(f => f.endsWith("*")));
    await sb.pullRemote();
    assert.equal(b.revealSecret("Example", "OTHER").value, "synthetic-other");
});

test("a halt on failed verification records the reason, not just that the pull was refused", async t => {
    const {a: a, sa: sa, repoA: repoA, repoB: repoB, git: git} = await gitPair(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "synthetic-tamper"
    });
    assert((await sa.pushRemote()).delivered);
    // Someone with write access to the remote alters a record.
    git("-C", repoB, "pull", "--quiet", "--ff-only");
    const record = fs.readdirSync(path.join(repoB, "records")).find(f => f.endsWith(".age"));
    fs.appendFileSync(path.join(repoB, "records", record), "tampered");
    git("-C", repoB, "commit", "--quiet", "-am", "tamper");
    git("-C", repoB, "push", "--quiet", "origin", "main");
    const auto = new AutoSync(a, {
        repo: repoA
    });
    const round = await auto.run({
        manual: true
    });
    assert.deepEqual({
        state: round.state,
        halted: round.halted,
        error: round.error
    }, {
        state: "SIGNATURE_INVALID",
        halted: true,
        error: "refusing to pull: Unsigned or modified ciphertext"
    });
    assert(a.readAudit().some(e => e.actor === "autosync" && e.action === "sync_halted" && e.detail === "SIGNATURE_INVALID: refusing to pull: Unsigned or modified ciphertext"));
    // The unauthenticated status route still gets the state alone, never the message.
    assert.equal(auto.publicStatus().state, "SIGNATURE_INVALID");
    assert.equal(auto.publicStatus().error, undefined);
    assert.equal(a.revealSecret("Example", "KEY").value, "synthetic-tamper");
});

test("files only this checkout has are left alone outside the sync folders too", async t => {
    const {a: a, b: b, sa: sa, repoA: repoA, repoB: repoB, remote: remote, git: git} = await gitPair(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "synthetic-root"
    });
    // Finder's .DS_Store in the checkout itself, Vim's swap file for recipients.txt, an editor's settings.
    const strays = [ ".DS_Store", ".recipients.txt.swp", ".vscode/settings.json" ];
    fs.mkdirSync(path.join(repoA, ".vscode"));
    for (const f of strays) fs.writeFileSync(path.join(repoA, f), "not sync's");
    const roundA = await new AutoSync(a, {
        repo: repoA
    }).run({
        manual: true
    });
    assert.deepEqual({
        state: roundA.state,
        halted: roundA.halted,
        error: roundA.error
    }, {
        state: "OK",
        halted: false,
        error: null
    });
    const roundB = await new AutoSync(b, {
        repo: repoB
    }).run({
        manual: true
    });
    assert.equal(roundB.state, "OK");
    assert.equal(b.revealSecret("Example", "KEY").value, "synthetic-root");
    assert.deepEqual(roundB.peerProblems, []);
    assert.deepEqual((await sa.statusRemote()).uncommittedFiles, []);
    const published = git("--git-dir", remote, "log", "--format=", "--name-only").split("\n");
    for (const f of strays) {
        assert(!published.includes(f), `${f} was committed`);
        assert(fs.existsSync(path.join(repoA, f)), `${f} was deleted`);
    }
});

test("a sync file that Git ignores outside the checkout stops a push instead of going missing", async t => {
    const {a: a, b: b, repoA: repoA, repoB: repoB} = await gitPair(t);
    const autoA = new AutoSync(a, {
        repo: repoA
    }), autoB = new AutoSync(b, {
        repo: repoB
    });
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "synthetic-excluded"
    });
    // An exclude rule outside any .gitignore (here .git/info/exclude, or a global excludes file)
    // hides the new record from `git status`. Committed without it, the manifest would sign a
    // file no peer receives.
    const exclude = path.join(repoA, ".git", "info", "exclude");
    fs.appendFileSync(exclude, "*.age\n");
    const round = await autoA.run({
        manual: true
    });
    assert.equal(round.state, "ERROR");
    assert.match(round.error, /^Git ignores files sync wrote; refusing to commit: "records\/[a-f0-9]{64}\.age"/);
    assert.equal((await autoB.run({
        manual: true
    })).state, "OK");
    fs.writeFileSync(exclude, "");
    assert.equal((await autoA.run({
        manual: true
    })).state, "OK");
    assert.equal((await autoB.run({
        manual: true
    })).state, "OK");
    assert.equal(b.revealSecret("Example", "KEY").value, "synthetic-excluded");
});

test("a file only this checkout has does not stop a round committing what an earlier round left", async t => {
    const {a: a, b: b, sa: sa, sb: sb, repoA: repoA, git: git} = await gitPair(t);
    a.createProject("Shared");
    a.setSecret("Shared", {
        key: "FROM_A",
        value: "synthetic-a"
    });
    leaveRoundUncommitted(sa);
    fs.writeFileSync(path.join(repoA, ".DS_Store"), "not sync's");
    b.createProject("Other");
    b.setSecret("Other", {
        key: "FROM_B",
        value: "synthetic-b"
    });
    assert((await sb.pushRemote()).delivered);
    const round = await autosyncFor(a, repoA).run();
    assert.equal(round.state, "OK", round.error);
    assert.equal(git("-C", repoA, "status", "--porcelain"), "?? .DS_Store");
    await sb.pullRemote();
    assert.equal(b.revealSecret("Shared", "FROM_A").value, "synthetic-a");
});

test("a Git control file in the checkout stops a push instead of changing what it commits", async t => {
    const {a: a, b: b, repoA: repoA, repoB: repoB} = await gitPair(t);
    const autoA = new AutoSync(a, {
        repo: repoA
    }), autoB = new AutoSync(b, {
        repo: repoB
    });
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "synthetic-control"
    });
    // Committed without the record it hid, this device's manifest would sign a file no peer
    // receives, and every peer would refuse the repository.
    const ignore = path.join(repoA, "records", ".gitignore");
    fs.writeFileSync(ignore, "*.age\n");
    let round = await autoA.run({
        manual: true
    });
    assert.equal(round.state, "ERROR");
    assert.match(round.error, /unrelated changes; refusing to commit: "records\/\.gitignore"/);
    assert.equal((await autoB.run({
        manual: true
    })).state, "OK");
    fs.unlinkSync(ignore);
    // .gitattributes can rewrite the bytes Git stores for ciphertext.
    const attributes = path.join(repoA, ".gitattributes");
    fs.writeFileSync(attributes, "*.age text\n");
    round = await autoA.run({
        manual: true
    });
    assert.match(round.error, /refusing to commit: "\.gitattributes"/);
    fs.unlinkSync(attributes);
    assert.equal((await autoA.run({
        manual: true
    })).state, "OK");
    assert.equal((await autoB.run({
        manual: true
    })).state, "OK");
    assert.equal(b.revealSecret("Example", "KEY").value, "synthetic-control");
});
