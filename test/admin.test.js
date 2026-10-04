"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const {execFile: execFile} = require("node:child_process");

const {Store: Store} = require("../store"), {Agents: Agents} = require("../agents"), {startApi: startApi} = require("../api");

const {claim: claim} = require("../session");

const PASSWORD = "synthetic-admin-password";

function setup(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-admin-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const store = new Store(path.join(dir, "data"));
    store.init(PASSWORD);
    store.createProject("Alpha");
    store.createProject("Beta");
    fs.mkdirSync(path.join(dir, "project"));
    store.lock();
    const admin = (args, input = PASSWORD + "\n") => new Promise(resolve => {
        const child = execFile(process.execPath, [ path.resolve("cli.cjs"), ...args, "--password-stdin" ], {
            env: {
                PATH: process.env.PATH,
                VAULTOS_DATA_DIR: store.dataDir
            },
            timeout: 6e4
        }, (error, stdout, stderr) => resolve({
            code: error ? error.code : 0,
            out: stdout ? JSON.parse(stdout) : null,
            stdout: stdout,
            stderr: stderr
        }));
        child.stdin.end(input);
    });
    const open = (password = PASSWORD) => {
        const s = new Store(store.dataDir);
        s.unlock(password);
        return s;
    };
    return {
        dir: dir,
        store: store,
        admin: admin,
        open: open
    };
}

test("admin CLI enrolls with private token files, re-issues, grants wildcards and revokes", async t => {
    const {dir: dir, admin: admin, open: open} = setup(t);
    const tokenFile = path.join(dir, "tokens", "codex.token");
    const wrong = await admin([ "agents", "list" ], "not-the-password-at-all\n");
    assert.equal(wrong.code, 1);
    const missing = await admin([ "agents", "enroll", "codex" ]);
    assert.match(missing.stderr, /--token-file/);
    const enrolled = await admin([ "agents", "enroll", "codex", "--token-file", tokenFile, "--projects", "Alpha", "--roots", path.join(dir, "project") ]);
    assert.equal(enrolled.code, 0, enrolled.stderr);
    assert.equal(fs.statSync(tokenFile).mode & 511, 384);
    assert.equal(fs.statSync(path.dirname(tokenFile)).mode & 511, 448);
    const first = fs.readFileSync(tokenFile, "utf8").trim();
    assert(!enrolled.stdout.includes(first), "the token is never printed");
    assert.deepEqual(enrolled.out.scopes, [ "read", "inject" ]);
    assert.equal(enrolled.out.allProjects, false);
    assert.equal(enrolled.out.anyRoot, false);
    assert.equal(enrolled.out.reissued, false);
    assert.equal(new Agents(open()).authenticate(first).name, "codex");
    const again = await admin([ "agents", "enroll", "codex", "--token-file", tokenFile ]);
    assert.equal(again.out.reissued, true);
    const second = fs.readFileSync(tokenFile, "utf8").trim();
    assert.notEqual(first, second);
    const registry = new Agents(open());
    assert.equal(registry.authenticate(first), null);
    assert.equal(registry.authenticate(second).name, "codex");
    assert.equal(registry.byName("codex").projects.length, 1, "re-issue without access flags keeps grants");
    const conflict = await admin([ "agents", "grant", "codex", "--all-projects", "--projects", "Beta" ]);
    assert.equal(conflict.code, 1);
    const wide = await admin([ "agents", "grant", "codex", "--all-projects", "--any-root", "--scopes", "read,inject,add" ]);
    assert.equal(wide.code, 0, wide.stderr);
    assert.equal(wide.out.allProjects, true);
    assert.equal(wide.out.anyRoot, true);
    assert.deepEqual(wide.out.scopes, [ "read", "inject", "add" ]);
    const narrowed = await admin([ "agents", "grant", "codex", "--projects", "Beta" ]);
    assert.equal(narrowed.out.allProjects, false);
    assert.equal(narrowed.out.anyRoot, true, "an unspecified dimension is unchanged");
    const badScope = await admin([ "agents", "grant", "codex", "--scopes", "root" ]);
    assert.match(badScope.stderr, /unknown scope/);
    const wildcard = await admin([ "agents", "enroll", "claude", "--token-file", path.join(dir, "tokens", "claude.token"), "--all-projects" ]);
    assert.equal(wildcard.out.allProjects, true);
    assert.equal(wildcard.out.anyRoot, false);
    const revoked = await admin([ "agents", "revoke", "codex" ]);
    assert.equal(revoked.out.revoked, true);
    assert.equal(new Agents(open()).authenticate(second), null);
    const listed = await admin([ "agents", "list" ]);
    assert.deepEqual(listed.out.map(a => a.name), [ "codex", "claude" ]);
    assert(!listed.stdout.includes("tokenHash"));
});

test("admin CLI lists, approves and denies pending keys and refuses while an owner runs", async t => {
    const {store: store, admin: admin, open: open} = setup(t);
    const s = open();
    const agent = new Agents(s).enrol("worker", [ "read", "add" ], [ "Alpha", "Beta" ], []);
    for (const [project, key] of [ [ "Alpha", "ONE" ], [ "Alpha", "TWO" ], [ "Beta", "THREE" ], [ "Beta", "FOUR" ] ]) s.setSecret(project, {
        key: key,
        value: "synthetic-pending"
    }, `agent:${agent.id}`);
    s.lock();
    const pending = await admin([ "pending", "list" ]);
    assert.equal(pending.out.length, 4);
    assert(!pending.stdout.includes("synthetic-pending"));
    assert.equal((await admin([ "pending", "approve", "Alpha", "ONE" ])).out.injectApproved, true);
    assert.equal((await admin([ "pending", "approve", "Alpha", "ONE" ])).code, 1, "already approved");
    assert.equal((await admin([ "pending", "deny", "Alpha", "TWO" ])).out.removed, true);
    const scoped = await admin([ "pending", "approve", "--all", "--project", "Beta" ]);
    assert.deepEqual(scoped.out.approved.map(x => x.key).sort(), [ "FOUR", "THREE" ]);
    const check = open();
    assert.deepEqual(check.pendingApprovals(), []);
    assert(!check.findSecret(check.findProject("Alpha"), "TWO"));
    const release = claim(store.dataDir);
    t.after(release);
    const busy = await admin([ "pending", "list" ]);
    assert.equal(busy.code, 1);
    assert.match(busy.stderr, /VaultOS is running/);
});

test("admin CLI stops a headless backend only when asked", async t => {
    const {store: store, admin: admin} = setup(t);
    const owner = new Store(store.dataDir);
    owner.unlock(PASSWORD);
    const release = claim(store.dataDir);
    let stopped = false;
    const api = await startApi(owner, {
        onShutdown: () => {
            stopped = true;
            owner.clearSession();
            owner.lock();
            release();
            api.server.closeAllConnections();
            api.server.close();
        }
    });
    owner.writeSession(api.port, api.token);
    t.after(() => {
        if (!stopped) {
            release();
            api.server.closeAllConnections();
            api.server.close();
        }
    });
    assert.match((await admin([ "pending", "list" ])).stderr, /--stop-backend/);
    const r = await admin([ "pending", "list", "--stop-backend" ]);
    assert.equal(r.code, 0, r.stderr);
    assert(stopped);
});

test("admin CLI configures the approval relay secret without printing it", async t => {
    const {dir: dir, admin: admin, open: open} = setup(t);
    assert.equal((await admin([ "approver", "status" ])).out.approverConfigured, false);
    const file = path.join(dir, "relay", "approver.token");
    const set = await admin([ "approver", "set", "--token-file", file ]);
    assert.equal(set.code, 0, set.stderr);
    const secret = fs.readFileSync(file, "utf8").trim();
    assert.equal(fs.statSync(file).mode & 511, 384);
    assert(!set.stdout.includes(secret));
    assert(require("../approvals").verifyApprover(open(), secret));
    assert.equal((await admin([ "approver", "status" ])).out.approverConfigured, true);
    assert.equal((await admin([ "approver", "clear" ])).out.approverConfigured, false);
    assert.equal(require("../approvals").verifyApprover(open(), secret), false);
});

test("admin CLI rotates the master password headlessly", async t => {
    const {admin: admin, open: open} = setup(t);
    const next = "synthetic-rotated-password";
    assert.equal((await admin([ "rotate-password" ], `${PASSWORD}\n${PASSWORD}\n`)).code, 1);
    assert.equal((await admin([ "rotate-password" ], `${PASSWORD}\nshort\n`)).code, 1);
    assert.equal((await admin([ "rotate-password" ], `wrong-password-entirely\n${next}\n`)).code, 1);
    const r = await admin([ "rotate-password" ], `${PASSWORD}\n${next}\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out.ok, true);
    assert(!r.stdout.includes(next));
    assert.throws(() => open(PASSWORD));
    assert.equal(open(next).listProjects().length, 2);
});
