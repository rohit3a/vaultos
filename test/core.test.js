"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const {Store: Store} = require("../store"), {Agents: Agents} = require("../agents"), {encryptVault: encryptVault, decryptVault: decryptVault} = require("../crypto");

const {writeEnv: writeEnv} = require("../env-file");

const PW = "synthetic-test-passphrase-only";

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-test-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const store = new Store(path.join(dir, "data"));
    store.init(PW);
    store.createProject("Example");
    return {
        dir: dir,
        store: store
    };
}

test("encrypted persistence rejects wrong password, tampering and invalid envelopes", t => {
    const {store: store} = fixture(t);
    store.setSecret("Example", {
        key: "API_KEY",
        value: "synthetic-private-value"
    });
    const bytes = fs.readFileSync(store.vaultPath, "utf8");
    assert(!bytes.includes("synthetic-private-value"));
    const e = JSON.parse(bytes);
    assert.throws(() => decryptVault(e, "wrong"));
    assert.throws(() => decryptVault({
        ...e,
        v: 99
    }, PW));
    assert.throws(() => decryptVault({
        ...e,
        tag: "AA=="
    }, PW));
    const other = new Store(store.dataDir);
    other.unlock(PW);
    assert.equal(other.revealSecret("Example", "API_KEY").value, "synthetic-private-value");
    assert(!fs.existsSync(path.join(store.dataDir, "backend.key")));
    assert.equal(fs.statSync(store.vaultPath).mode & 511, 384);
});

test("project lookup is exact, updates validate fields and agent ownership holds", t => {
    const {store: store} = fixture(t);
    store.createProject("Example Two");
    assert.equal(store.findProject("Exam"), null);
    assert.throws(() => store.createProject("example"));
    assert.throws(() => store.setSecret("Example", {
        key: "__proto__",
        value: "x"
    }));
    assert.throws(() => store.setSecret("Example", {
        key: "SAFE",
        value: {}
    }));
    store.setSecret("Example", {
        key: "KEY",
        value: "human"
    });
    const a = new Agents(store).enrol("test-agent", [], [ "Example" ]);
    assert.deepEqual(a.scopes, []);
    assert.throws(() => store.setSecret("Example", {
        key: "KEY",
        value: "changed"
    }, "agent:" + a.id));
    store.delegate("Example", "KEY", "agent:" + a.id);
    store.setSecret("Example", {
        key: "KEY",
        value: "changed"
    }, "agent:" + a.id);
    store.adopt("Example", "KEY");
    assert.throws(() => store.setSecret("Example", {
        key: "KEY",
        value: "x"
    }, "agent:" + a.id));
});

test("a stale writer cannot overwrite another process", t => {
    const {store: store} = fixture(t), other = new Store(store.dataDir);
    other.unlock(PW);
    store.setSecret("Example", {
        key: "A",
        value: "first"
    });
    assert.throws(() => other.setSecret("Example", {
        key: "B",
        value: "second"
    }), /another process/);
    assert(!other.listSecrets("Example").some(x => x.key === "B"));
    other.unlock(PW);
    assert.equal(other.revealSecret("Example", "A").value, "first");
});

test("shell export cannot execute substitutions; dotenv round-trips; JSON preserves unrelated keys", t => {
    const {dir: dir} = fixture(t), f = path.join(dir, "out.env"), marker = path.join(dir, "should-not-exist");
    const value = `$(touch ${marker}) \`touch ${marker}\` ' quote $HOME`;
    writeEnv(f, [ [ "KEY", value ] ], "shell", false);
    const out = require("node:child_process").execFileSync("/bin/sh", [ "-c", '. "$1"; printf "%s" "$KEY"', "sh", f ], {
        encoding: "utf8"
    });
    assert.equal(out, value);
    assert(!fs.existsSync(marker));
    writeEnv(f, [ [ "KEY", "hello\nworld $HOME # x" ] ], "dotenv", false);
    assert.equal(require("dotenv").parse(fs.readFileSync(f)).KEY, "hello\nworld $HOME # x");
    fs.writeFileSync(f, '{"existing":1}', {
        mode: 420
    });
    writeEnv(f, [ [ "KEY", value ] ], "json", true);
    assert.equal(JSON.parse(fs.readFileSync(f)).existing, 1);
    assert.equal(fs.statSync(f).mode & 511, 384);
    assert.throws(() => writeEnv(f, [ [ "BAD;touch", "x" ] ], "shell", false));
    const link = path.join(dir, "link");
    fs.symlinkSync(f, link);
    assert.throws(() => writeEnv(link, [ [ "KEY", "x" ] ], "json", false));
});

test("rotation preserves vault and backup contents under the new password", t => {
    const {store: store} = fixture(t);
    store.setSecret("Example", {
        key: "K",
        value: "v"
    });
    fs.mkdirSync(path.join(store.dataDir, "backups"));
    const backup = path.join(store.dataDir, "backups", "old.enc");
    fs.copyFileSync(store.vaultPath, backup);
    const result = store.changePassword(PW, "another-synthetic-password");
    assert.equal(result.backups[0].status, "re-encrypted");
    assert.throws(() => decryptVault(JSON.parse(fs.readFileSync(backup)), PW));
    assert.equal(decryptVault(JSON.parse(fs.readFileSync(backup)), "another-synthetic-password").projects[0].secrets[0].value, "v");
});

test("undo refuses stale history and creates a durable deletion", t => {
    const {store: store} = fixture(t);
    store.setSecret("Example", {
        key: "K",
        value: "first"
    });
    const created = store.listHistory()[0].id;
    store.setSecret("Example", {
        key: "K",
        value: "second"
    });
    const updated = store.listHistory()[0].id;
    assert.throws(() => store.revert(created), /newer work/);
    store.revert(updated);
    assert.equal(store.revealSecret("Example", "K").value, "first");
    assert.equal(store.listSecrets("Example")[0].rev, 3);
    store.setSecret("Example", {
        key: "TEMP",
        value: "v"
    });
    const id = store.listHistory()[0].id;
    store.revert(id);
    assert(!store.listSecrets("Example").some(x => x.key === "TEMP"));
    assert(store.vault.tombstones.length);
});
