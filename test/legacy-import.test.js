"use strict";

// Synthetic fixtures only: the earlier fork's data directory is generated here with its
// v1 envelope (scrypt N=2^15, AES-256-GCM), never copied from a real installation.

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");

const {execFile: execFile} = require("node:child_process");

const {Store: Store} = require("../store"), {Agents: Agents} = require("../agents"), {discoverToken: discoverToken} = require("../agent-client");

const {decryptVault: decryptVault} = require("../crypto");

const PASSWORD = "synthetic-legacy-password";

const BACKEND_KEY = "synthetic-backend-key-must-not-travel";

const sha = s => crypto.createHash("sha256").update(s).digest("hex");

function legacyEnvelope(obj, password) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(password, salt, 32, {
        N: 1 << 15,
        r: 8,
        p: 1,
        maxmem: 256 * 1024 * 1024
    });
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([ cipher.update(JSON.stringify(obj), "utf8"), cipher.final() ]);
    return JSON.stringify({
        v: 1,
        kdf: "scrypt",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64")
    });
}

const T = "2026-01-02T03:04:05.000Z";

const secret = (id, key, value, extra = {}) => ({
    id: id,
    key: key,
    value: value,
    provider: "",
    note: "",
    username: "",
    email: "",
    password: "",
    url: "",
    permission: "",
    expiresAt: "",
    owner: "human",
    createdBy: "human",
    modifiedBy: "human",
    editableBy: [],
    injectApproved: true,
    createdAt: T,
    updatedAt: T,
    rev: 1,
    ...extra
});

function legacyFixture(root, mutate = v => v) {
    const dir = path.join(root, "legacy");
    fs.mkdirSync(path.join(dir, "backups"), {
        recursive: true,
        mode: 448
    });
    fs.mkdirSync(path.join(dir, "agents"), {
        mode: 448
    });
    const tokens = {
        claude: crypto.randomBytes(32).toString("hex"),
        codex: crypto.randomBytes(32).toString("hex"),
        old: crypto.randomBytes(32).toString("hex")
    };
    const agent = (id, name, extra = {}) => ({
        id: id,
        name: name,
        tokenHash: sha(tokens[name]),
        scopes: [ "read", "add", "edit:own", "edit:delegated", "delete:own", "inject" ],
        enrolledAt: T,
        lastSeenAt: null,
        revokedAt: null,
        ...extra
    });
    const vault = mutate({
        formatVersion: 2,
        minReaderVersion: 2,
        projects: [ {
            id: "p1",
            name: "Alpha",
            owner: "human",
            createdAt: T,
            updatedAt: T,
            secrets: [ secret("s1", "API_KEY", "synthetic-value-one"), secret("s2", "AGENT_KEY", "synthetic-value-two", {
                owner: "agent:a1",
                createdBy: "agent:a1",
                modifiedBy: "agent:a1",
                injectApproved: false,
                approvalDenied: true
            }), secret("s3", "NEW_KEY", "synthetic-value-three", {
                owner: "agent:a1",
                injectApproved: false
            }) ]
        }, {
            id: "p2",
            name: "Beta",
            owner: "human",
            createdAt: T,
            updatedAt: T,
            secrets: [ secret("s4", "DB_URL", "synthetic-value-four", {
                expiresAt: "2030-01-01T00:00:00.000Z"
            }) ]
        } ],
        agents: [ agent("a1", "claude"), agent("a2", "codex"), agent("a3", "old", {
            revokedAt: T
        }) ],
        tombstones: [ {
            ref: "p1:gone",
            deletedAt: T,
            by: "human"
        } ],
        history: [ {
            id: "h1",
            ts: T,
            actor: "human",
            action: "create_secret",
            project: "Alpha",
            key: "API_KEY",
            before: null,
            after: secret("s1", "API_KEY", "synthetic-value-one"),
            ref: null,
            reverted: false
        }, {
            id: "h2",
            ts: T,
            actor: "sync",
            action: "sync_replace",
            project: "Beta",
            key: "DB_URL",
            before: null,
            after: null,
            ref: null,
            reverted: false
        }, {
            id: "h3",
            ts: T,
            actor: "human:remote",
            action: "update_secret",
            project: "Alpha",
            key: "AGENT_KEY",
            before: null,
            after: null,
            ref: null,
            reverted: false
        }, {
            id: "h4",
            ts: T,
            actor: "human",
            action: "move_secret",
            project: "Beta",
            key: "DB_URL",
            before: null,
            after: null,
            ref: "Alpha",
            reverted: false
        } ],
        settings: {
            exportPassword: "synthetic-export-password",
            approverTokenHash: sha("synthetic-approver"),
            legacyOnly: true
        }
    });
    const write = (name, content) => fs.writeFileSync(path.join(dir, name), content, {
        mode: 384
    });
    write("vault.enc", legacyEnvelope(vault, PASSWORD));
    write("audit.log", `${T}\thuman\tunlock\tsynthetic\n${T}\tagent:a1\tinject\tAlpha -> synthetic\n`);
    write("backups/vault-2026-01-01.enc", legacyEnvelope({
        formatVersion: 2,
        projects: []
    }, PASSWORD));
    write("machine-id", "synthetic-machine\n");
    write("sync-index.json", "{}");
    write("session.json", JSON.stringify({
        port: 1,
        token: "f".repeat(64),
        pid: 99999999
    }));
    write("backend.key", BACKEND_KEY);
    write("agent-token", tokens.claude + "\n");
    write("agents/codex.token", tokens.codex + "\n");
    return {
        dir: dir,
        tokens: tokens
    };
}

function treeHash(dir) {
    const h = crypto.createHash("sha256");
    const walk = d => {
        for (const e of fs.readdirSync(d, {
            withFileTypes: true
        }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(d, e.name), st = fs.lstatSync(p);
            h.update(`${path.relative(dir, p)}\0${st.mode}\0${st.mtimeMs}\0`);
            if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
        }
    };
    walk(dir);
    return h.digest("hex");
}

function setup(t, mutate) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-legacy-"));
    t.after(() => fs.rmSync(root, {
        recursive: true,
        force: true
    }));
    const legacy = legacyFixture(root, mutate);
    const target = path.join(root, "target");
    const run = (args, {input: input = PASSWORD + "\n", dataDir: dataDir = target} = {}) => new Promise(resolve => {
        const child = execFile(process.execPath, [ path.resolve("cli.cjs"), "import-legacy", ...args, "--password-stdin" ], {
            env: {
                PATH: process.env.PATH,
                HOME: root,
                VAULTOS_DATA_DIR: dataDir
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
    return {
        root: root,
        legacy: legacy,
        target: target,
        run: run
    };
}

function assertNoValues(text, legacy) {
    for (const v of [ "synthetic-value-one", "synthetic-value-two", "synthetic-value-three", "synthetic-value-four", "synthetic-export-password", BACKEND_KEY, ...Object.values(legacy.tokens) ]) assert.ok(!text.includes(v), "output must not contain secret material");
}

test("import-legacy imports a synthetic earlier vault and leaves the source untouched", async t => {
    const {legacy: legacy, target: target, run: run} = setup(t);
    const before = treeHash(legacy.dir);
    const r = await run([ "--from", legacy.dir ]);
    assert.equal(r.code, 0, r.stderr);
    assertNoValues(r.stdout + r.stderr, legacy);
    assert.equal(treeHash(legacy.dir), before);
    assert.deepEqual(r.out.counts, {
        projects: 2,
        secrets: 4,
        agents: 3,
        revokedAgents: 1,
        tombstones: 1,
        history: 4
    });
    assert.equal(r.out.ok, true);
    assert.match(r.out.rollback, /not modified/);
    const envelope = JSON.parse(fs.readFileSync(path.join(target, "vault.enc"), "utf8"));
    assert.equal(envelope.v, 2);
    const store = new Store(target);
    store.unlock(PASSWORD);
    assert.equal(store.vault.formatVersion, 3);
    assert.equal(store.revealSecret("Alpha", "API_KEY").value, "synthetic-value-one");
    assert.equal(store.revealSecret("Beta", "DB_URL").value, "synthetic-value-four");
    assert.equal(store.listSecrets("Alpha").length + store.listSecrets("Beta").length, 4);
    const denied = store.findSecret(store.findProject("Alpha"), "AGENT_KEY");
    assert.equal(denied.injectApproved, false);
    assert.equal("approvalDenied" in denied, false);
    assert.deepEqual(store.pendingApprovals().map(p => p.key).sort(), [ "AGENT_KEY", "NEW_KEY" ]);
    assert.deepEqual(r.out.previouslyDenied, [ {
        project: "Alpha",
        key: "AGENT_KEY"
    } ]);
    for (const a of store.vault.agents) {
        assert.deepEqual([ a.projects, a.roots, a.allProjects, a.anyRoot ], [ [], [], false, false ]);
    }
    assert.ok(r.out.reminders.some(x => /no project or folder access/.test(x)));
    assert.deepEqual(Object.keys(store.vault.settings).sort(), [ "approverTokenHash", "exportPassword" ]);
    assert.equal(store.vault.settings.rememberPassword, undefined);
    assert.deepEqual(r.out.settings.notCarried, [ "legacyOnly" ]);
    assert.equal(store.vault.history.at(-1).action, "import_legacy");
    // Agent tokens map to per-agent files the bridge discovers by name.
    const registry = new Agents(store);
    assert.equal(registry.authenticate(legacy.tokens.claude).name, "claude");
    for (const name of [ "claude", "codex" ]) {
        const file = path.join(target, "agents", `${name}.token`);
        assert.equal(fs.statSync(file).mode & 511, 384);
        assert.equal(discoverToken({
            VAULTOS_AGENT: name
        }, target).token, legacy.tokens[name]);
    }
    assert.equal(fs.existsSync(path.join(target, "agents", "old.token")), false);
    assert.deepEqual(r.out.agentTokens.filter(x => x.env).map(x => x.env).sort(), [ "VAULTOS_AGENT=claude", "VAULTOS_AGENT=codex" ]);
    // Audit and backups are copied privately; backend.key and sync/session state are not.
    const audit = fs.readFileSync(path.join(target, "audit.log"), "utf8");
    assert.match(audit, /\tunlock\tsynthetic\n/);
    assert.match(audit, /\timport_legacy\t/);
    assert.equal(fs.statSync(path.join(target, "audit.log")).mode & 511, 384);
    const backup = path.join(target, "backups", "vault-2026-01-01.enc");
    assert.deepEqual(fs.readFileSync(backup), fs.readFileSync(path.join(legacy.dir, "backups", "vault-2026-01-01.enc")));
    assert.equal(fs.statSync(backup).mode & 511, 384);
    assert.equal(decryptVault(JSON.parse(fs.readFileSync(backup, "utf8")), PASSWORD).formatVersion, 2);
    const names = [];
    const walk = d => fs.readdirSync(d, {
        withFileTypes: true
    }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : names.push(path.join(d, e.name)));
    walk(target);
    for (const f of names) {
        assert.ok(!/backend\.key|machine-id|sync-index\.json|session\.json/.test(path.basename(f)), f);
        assert.ok(!fs.readFileSync(f, "utf8").includes(BACKEND_KEY));
    }
});

test("import-legacy --plan reports without writing anything", async t => {
    const {legacy: legacy, target: target, run: run} = setup(t);
    const before = treeHash(legacy.dir);
    const r = await run([ "--from", legacy.dir, "--plan" ]);
    assert.equal(r.code, 0, r.stderr);
    assertNoValues(r.stdout + r.stderr, legacy);
    assert.equal(r.out.mode, "plan");
    assert.equal(r.out.ok, true);
    assert.equal(r.out.counts.secrets, 4);
    assert.deepEqual(r.out.history.notUndoable, {
        sync_replace: 1,
        move_secret: 1
    });
    assert.deepEqual(r.out.history.unfamiliarActors, {
        "human:remote": 1
    });
    assert.equal(r.out.heldForApproval, 2);
    assert.equal(fs.existsSync(target), false);
    assert.equal(treeHash(legacy.dir), before);
});

test("import-legacy refuses records that fail validation and names them without values", async t => {
    const big = "synthetic-oversized-" + "x".repeat(70 * 1024);
    const {legacy: legacy, target: target, run: run} = setup(t, v => {
        v.projects[0].secrets.push(secret("s5", "BAD\tKEY", "synthetic-value-five"), secret("s6", "HUGE", big), secret("s7", "WHEN", "synthetic-value-six", {
            expiresAt: "not a date"
        }));
        v.projects.push({
            id: "p3",
            name: "alpha",
            secrets: []
        });
        return v;
    });
    const plan = await run([ "--from", legacy.dir, "--plan" ]);
    assert.equal(plan.code, 2);
    assert.equal(plan.out.ok, false);
    assert.ok(!plan.stdout.includes("synthetic-oversized") && !plan.stdout.includes("synthetic-value-six"));
    const rules = plan.out.failures.map(f => `${f.project}/${f.key || ""}: ${f.rule}`);
    assert.ok(rules.includes("Alpha/BAD\tKEY: Invalid key name"), rules.join("\n"));
    assert.ok(rules.includes("Alpha/HUGE: Invalid value"));
    assert.ok(rules.includes("Alpha/WHEN: Invalid expiry date"));
    assert.ok(rules.some(r => /^alpha\/: Project name collides/.test(r)));
    const real = await run([ "--from", legacy.dir ]);
    assert.equal(real.code, 1);
    assert.match(real.stderr, /4 record\(s\) fail VaultOS validation/);
    assert.equal(fs.existsSync(path.join(target, "vault.enc")), false);
    assert.equal(fs.existsSync(target), false);
});

test("import-legacy refuses an existing target vault, the same directory, a wrong password and a running earlier app", async t => {
    const {root: root, legacy: legacy, target: target, run: run} = setup(t);
    const other = new Store(target);
    other.init("synthetic-other-password");
    other.lock();
    const vaultBefore = fs.readFileSync(path.join(target, "vault.enc"));
    const existing = await run([ "--from", legacy.dir ]);
    assert.equal(existing.code, 1);
    assert.match(existing.stderr, /already has a vault/);
    assert.deepEqual(fs.readFileSync(path.join(target, "vault.enc")), vaultBefore);
    const same = await run([ "--from", legacy.dir ], {
        dataDir: legacy.dir
    });
    assert.equal(same.code, 1);
    assert.match(same.stderr, /different directory/);
    const fresh = path.join(root, "fresh");
    const wrong = await run([ "--from", legacy.dir ], {
        dataDir: fresh,
        input: "not-the-password\n"
    });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /Wrong password/);
    assert.equal(fs.existsSync(fresh), false);
    const server = http.createServer((req, res) => res.end(JSON.stringify({
        ok: true
    })));
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    fs.writeFileSync(path.join(legacy.dir, "session.json"), JSON.stringify({
        port: server.address().port,
        token: "e".repeat(64),
        pid: process.pid
    }));
    const running = await run([ "--from", legacy.dir ], {
        dataDir: fresh
    });
    assert.equal(running.code, 1);
    assert.match(running.stderr, /earlier vault-os app or backend is running/);
    assert.equal(fs.existsSync(fresh), false);
});

test("import-legacy --grant-all-existing-agents grants non-revoked agents and applies lock/autosync options", async t => {
    const {legacy: legacy, target: target, run: run} = setup(t);
    const r = await run([ "--from", legacy.dir, "--grant-all-existing-agents", "--lock-policy", "soft", "--auto-sync" ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out.agentAccess.allAccessGranted, 2);
    assert.ok(!r.out.reminders.some(x => /no project or folder access/.test(x)));
    const store = new Store(target);
    store.unlock(PASSWORD);
    const access = Object.fromEntries(store.vault.agents.map(a => [ a.name, [ a.allProjects, a.anyRoot ] ]));
    assert.deepEqual(access, {
        claude: [ true, true ],
        codex: [ true, true ],
        old: [ false, false ]
    });
    const settings = store.getSettings();
    assert.equal(settings.lockPolicy, "soft");
    assert.equal(settings.autoSync.enabled, true);
    assert.equal(settings.rememberPassword, false);
});

test("import-legacy --touch-id needs --remember-password, and --plan reports both options without touching a keyring", async t => {
    const {legacy: legacy, target: target, run: run} = setup(t);
    const lone = await run([ "--from", legacy.dir, "--touch-id", "--plan" ]);
    assert.notEqual(lone.code, 0);
    assert.match(lone.stderr, /--touch-id needs --remember-password/);
    const plan = await run([ "--from", legacy.dir, "--remember-password", "--touch-id", "--plan" ]);
    assert.equal(plan.code, 0, plan.stderr);
    assert.deepEqual(plan.out.settings.applied, {
        rememberPassword: true,
        touchIdUnlock: true
    });
    assert.equal(fs.existsSync(path.join(target, "vault.enc")), false);
    assert.equal(fs.existsSync(path.join(target, "touch-id")), false);
});
