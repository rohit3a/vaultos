"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const {Store: Store} = require("../store"), {Sync: Sync} = require("../sync");

function make(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-sync-test-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const a = new Store(path.join(dir, "a")), b = new Store(path.join(dir, "b"));
    a.init("synthetic-password-a");
    b.init("synthetic-password-b");
    const repo = path.join(dir, "repo"), sa = new Sync(a, repo), sb = new Sync(b, repo);
    const ia = sa.init("Machine A"), ib = sb.init("Machine B");
    sa.trustMachine(ib);
    sb.trustMachine(ia);
    return {
        a: a,
        b: b,
        sa: sa,
        sb: sb,
        repo: repo,
        dir: dir
    };
}

test("sync merges synthetic records and propagates a deletion without disclosing values", t => {
    const {a: a, b: b, sa: sa, sb: sb} = make(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "API_KEY",
        value: "synthetic-sync-private"
    });
    sa.push();
    sb.pull();
    assert.equal(b.revealSecret("Example", "API_KEY").value, "synthetic-sync-private");
    b.setSecret("Example", {
        key: "SECOND",
        value: "b"
    });
    sb.push();
    sa.pull();
    assert.equal(a.revealSecret("Example", "SECOND").value, "b");
    a.deleteSecret("Example", "SECOND");
    sa.push();
    sb.pull();
    assert(!b.listSecrets("Example").some(x => x.key === "SECOND"));
});

test("sync rejects recipient injection, signing key substitution, tampered ciphertext and replay", t => {
    const {a: a, sa: sa, repo: repo} = make(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "API_KEY",
        value: "synthetic-only"
    });
    sa.push();
    const recipients = fs.readFileSync(sa.recipientsPath, "utf8");
    fs.appendFileSync(sa.recipientsPath, "age1unapproved\n");
    assert.throws(() => sa.encryptTo({
        test: true
    }), /Unapproved/);
    fs.writeFileSync(sa.recipientsPath, recipients);
    const mf = path.join(repo, "manifests", sa.machineId() + ".json"), original = fs.readFileSync(mf);
    const m = JSON.parse(original);
    m.manifest.counter++;
    fs.writeFileSync(mf, JSON.stringify(m));
    assert(sa.verifyManifests().problems.includes("BAD SIGNATURE"));
    fs.writeFileSync(mf, original);
    const file = path.join(repo, "records", fs.readdirSync(path.join(repo, "records"))[0]), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, "bad");
    assert(sa.verifyManifests().problems.some(x => x.includes("ciphertext")));
    fs.writeFileSync(file, bytes);
    sa.push();
    sa.verifyManifests();
    fs.writeFileSync(mf, original);
    assert(sa.verifyManifests().problems.some(x => x.includes("ROLLBACK")));
});

test("sync refuses concurrent edits until explicitly accepted and preserves a backup", t => {
    const {a: a, b: b, sa: sa, sb: sb} = make(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "KEY",
        value: "base"
    });
    sa.push();
    sb.pull();
    a.setSecret("Example", {
        key: "KEY",
        value: "left"
    });
    b.setSecret("Example", {
        key: "KEY",
        value: "right"
    });
    b.setSecret("Example", {
        key: "KEY",
        value: "right-again"
    });
    sb.push();
    assert.throws(() => sa.pull(), /Concurrent/);
    sa.pull({
        acceptConflicts: true
    });
    assert.equal(a.revealSecret("Example", "KEY").value, "right-again");
    assert(fs.readdirSync(path.join(a.dataDir, "backups")).length > 0);
});

test("new approved recipients receive re-encrypted existing records", t => {
    const {a: a, sa: sa, sb: sb, repo: repo, dir: dir} = make(t);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "K",
        value: "existing-synthetic"
    });
    sa.push();
    sb.pull();
    const c = new Store(path.join(dir, "c"));
    c.init("synthetic-password-c");
    const sc = new Sync(c, repo), ic = sc.init("Machine C");
    sc.trustMachine(sa.identity());
    sc.trustMachine(sb.identity());
    sa.trustMachine(ic);
    const result = sa.push();
    assert(result.reencryptedForNewRecipients);
    sc.pull();
    assert.equal(c.revealSecret("Example", "K").value, "existing-synthetic");
});

test("Git transport verifies a real remote receipt and refuses unrelated files", t => {
    const {a: a, sa: sa, repo: repo, dir: dir} = make(t), {execFileSync: execFileSync} = require("node:child_process");
    const git = (...args) => execFileSync("git", args, {
        stdio: "pipe",
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1"
        }
    });
    const remote = path.join(dir, "remote.git");
    git("init", "--bare", "--initial-branch=main", remote);
    git("-C", repo, "init", "-b", "main");
    git("-C", repo, "config", "user.name", "Synthetic Test");
    git("-C", repo, "config", "user.email", "test@example.invalid");
    git("-C", repo, "remote", "add", "origin", remote);
    a.createProject("Example");
    a.setSecret("Example", {
        key: "K",
        value: "transport-synthetic"
    });
    const result = sa.pushRemote();
    assert(result.delivered, JSON.stringify(result));
    assert.equal(result.remoteCommit, result.sourceCommit);
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "must not publish");
    assert.throws(() => sa.pushRemote(), /unrelated/);
    assert(!git("--git-dir", remote, "ls-tree", "--name-only", "HEAD").toString().includes("unrelated"));
});
