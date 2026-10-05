"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");

const {execFile: execFile} = require("node:child_process");

const {Store: Store} = require("../store"), {Agents: Agents} = require("../agents"), {startApi: startApi} = require("../api");

const {VaultClient: VaultClient, discoverToken: discoverToken} = require("../agent-client");

const {issueApproverToken: issueApproverToken} = require("../approvals");

const PASSWORD = "synthetic-tooling-password";

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-tooling-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    return dir;
}

async function serve(t, store) {
    const api = await startApi(store);
    store.writeSession(api.port, api.token);
    t.after(async () => {
        api.server.closeAllConnections();
        await new Promise(r => api.server.close(r));
    });
    const call = async (p, body, headers = {}, method) => {
        const r = await fetch(`http://127.0.0.1:${api.port}${p}`, {
            method: method || (body ? "POST" : "GET"),
            headers: {
                authorization: `Bearer ${api.token}`,
                "content-type": "application/json",
                ...headers
            },
            body: body ? JSON.stringify(body) : undefined
        });
        return {
            status: r.status,
            body: await r.json()
        };
    };
    return {
        api: api,
        call: call
    };
}

function vault(t) {
    const dir = fixture(t), store = new Store(path.join(dir, "data"));
    store.init(PASSWORD);
    fs.mkdirSync(path.join(dir, "project"));
    store.createProject("Alpha");
    store.createProject("Beta");
    store.setSecret("Alpha", {
        key: "ALPHA_KEY",
        value: "synthetic-alpha-value"
    });
    store.setSecret("Beta", {
        key: "BETA_KEY",
        value: "synthetic-beta-value"
    });
    return {
        dir: dir,
        store: store,
        agents: new Agents(store)
    };
}

function agentCli(env, args, input) {
    return new Promise(resolve => {
        const child = execFile(process.execPath, [ path.resolve("agent-cli.cjs"), ...args ], {
            env: {
                PATH: process.env.PATH,
                ...env
            },
            timeout: 3e4
        }, (error, stdout, stderr) => resolve({
            code: error ? error.code : 0,
            stdout: stdout,
            stderr: stderr
        }));
        if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
}

test("wildcard grants default off, are human-set only, and widen projects and folders when set", async t => {
    const {dir: dir, store: store, agents: agents} = vault(t);
    const scoped = agents.enrol("scoped", [ "read", "inject", "add" ], [ "Alpha" ], [ path.join(dir, "project") ]);
    const wide = agents.enrol("wide", [ "read", "inject", "add" ], [], [], {
        allProjects: true,
        anyRoot: true
    });
    assert.throws(() => agents.enrol("bad", [ "read" ], [], [], {
        allProjects: "yes"
    }), /true or false/);
    assert.throws(() => agents.enrol("bad", [ "read" ], [], [], {
        everything: true
    }), /Unknown agent access option/);
    const listed = Object.fromEntries(agents.list().map(a => [ a.name, a ]));
    assert.equal(listed.scoped.allProjects, false);
    assert.equal(listed.scoped.anyRoot, false);
    assert.equal(listed.wide.allProjects, true);
    const {call: call} = await serve(t, store);
    const as = token => ({
        "x-vault-agent-token": token
    });
    assert.deepEqual((await call("/projects", null, as(scoped.token))).body.map(x => x.name), [ "Alpha" ]);
    assert.deepEqual((await call("/projects", null, as(wide.token))).body.map(x => x.name).sort(), [ "Alpha", "Beta" ]);
    store.createProject("Gamma");
    assert((await call("/projects", null, as(wide.token))).body.some(x => x.name === "Gamma"));
    assert.equal((await call("/projects/Beta/secrets", null, as(scoped.token))).status, 403);
    assert.equal((await call("/search?q=KEY", null, as(wide.token))).body.length, 2);
    const who = (await call("/whoami", null, as(wide.token))).body;
    assert.equal(who.allProjects, true);
    assert.equal(who.anyRoot, true);
    const outside = path.join(dir, "elsewhere");
    fs.mkdirSync(outside);
    assert.equal((await call("/inject", {
        project: "Alpha",
        target_path: path.join(outside, ".env")
    }, as(scoped.token))).status, 400);
    const wrote = await call("/inject", {
        project: "Beta",
        target_path: path.join(outside, ".env")
    }, as(wide.token));
    assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
    assert(!JSON.stringify(wrote.body).includes("synthetic-beta-value"));
    assert.equal((await call("/inject", {
        project: "Beta",
        target_path: path.join(store.dataDir, "x.env")
    }, as(wide.token))).status, 403);
    fs.symlinkSync(store.dataDir, path.join(dir, "data-link"));
    assert.equal((await call("/inject", {
        project: "Beta",
        target_path: path.join(dir, "data-link", "x.env")
    }, as(wide.token))).status, 403);
    fs.writeFileSync(path.join(dir, "real.env"), "");
    fs.symlinkSync(path.join(dir, "real.env"), path.join(outside, "link.env"));
    assert.equal((await call("/inject", {
        project: "Beta",
        target_path: path.join(outside, "link.env")
    }, as(wide.token))).status, 400);
    assert.equal((await call("/inject", {
        project: "Beta",
        target_path: "relative/.env"
    }, as(wide.token))).status, 400);
    assert.equal((await call("/agents", {
        allProjects: true
    }, as(scoped.token))).status, 404);
    agents.setAccess(agents.byName("wide").id, [], []);
    assert.equal(agents.byName("wide").allProjects, true, "omitting wildcards keeps them");
    agents.setAccess(agents.byName("wide").id, [], [], {
        allProjects: false,
        anyRoot: false
    });
    assert.deepEqual((await call("/projects", null, as(wide.token))).body, []);
});

test("import_env createProject creates only missing projects and checks the path first", async t => {
    const {dir: dir, store: store, agents: agents} = vault(t);
    const root = path.join(dir, "project");
    fs.writeFileSync(path.join(root, ".env"), "NEW_ONE=synthetic-import-value\n");
    const adder = agents.enrol("adder", [ "read", "add" ], [], [ root ]);
    const reader = agents.enrol("reader", [ "read" ], [], [ root ]);
    const {call: call} = await serve(t, store);
    const as = token => ({
        "x-vault-agent-token": token
    });
    assert.equal((await call("/import", {
        project: "Beta",
        env_path: path.join(root, ".env"),
        createProject: true
    }, as(adder.token))).status, 403, "an existing unapproved project is not adopted");
    assert.equal((await call("/import", {
        project: "Fresh",
        env_path: path.join(dir, "outside.env"),
        createProject: true
    }, as(adder.token))).status, 400);
    assert.equal(store.findProject("Fresh"), null, "a refused path creates nothing");
    assert.equal((await call("/import", {
        project: "Fresh",
        env_path: path.join(root, ".env"),
        createProject: "yes"
    }, as(adder.token))).status, 400);
    assert.equal((await call("/import", {
        project: "Fresh",
        env_path: path.join(root, ".env"),
        createProject: true
    }, as(reader.token))).status, 403);
    const made = await call("/import", {
        project: "Fresh",
        env_path: path.join(root, ".env"),
        createProject: true
    }, as(adder.token));
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.deepEqual(made.body.keys, [ "NEW_ONE" ]);
    assert(!JSON.stringify(made.body).includes("synthetic-import-value"));
    assert.equal(store.pendingApprovals()[0].key, "NEW_ONE");
    assert.equal(store.pendingApprovals()[0].ownerName, "adder", "approval prompts name the agent");
    assert.equal((await call("/import", {
        project: "Missing",
        env_path: path.join(root, ".env")
    }, as(adder.token))).status, 403, "without createProject nothing is created");
});

test("approval relay is off by default, needs its own secret, and approves or removes pending keys", async t => {
    const {dir: dir, store: store, agents: agents} = vault(t);
    const worker = agents.enrol("worker", [ "read", "add" ], [ "Alpha" ], [ path.join(dir, "project") ]);
    store.setSecret("Alpha", {
        key: "AGENT_ONE",
        value: "synthetic-one"
    }, `agent:${worker.id}`);
    store.setSecret("Alpha", {
        key: "AGENT_TWO",
        value: "synthetic-two"
    }, `agent:${worker.id}`);
    const {call: call} = await serve(t, store);
    const decide = (body, headers = {}) => call("/pending/decide", body, headers);
    const off = await decide({
        project: "Alpha",
        key: "AGENT_ONE",
        approve: true
    }, {
        "x-vault-approver": "anything-at-all-here"
    });
    assert.equal(off.status, 403);
    assert.match(off.body.error, /not configured/);
    const secret = issueApproverToken(store);
    assert.equal((await decide({
        project: "Alpha",
        key: "AGENT_ONE",
        approve: true
    }, {
        "x-vault-agent-token": worker.token
    })).status, 403, "agent tokens cannot approve");
    assert.equal((await decide({
        project: "Alpha",
        key: "AGENT_ONE",
        approve: true
    }, {
        "x-vault-approver": secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0")
    })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${JSON.parse(fs.readFileSync(store.sessionPath)).port}/pending/decide`, {
        method: "POST",
        headers: {
            "x-vault-approver": secret
        }
    })).status, 401, "the session bearer token is still required");
    assert.equal((await decide({
        project: "Alpha",
        key: "AGENT_ONE",
        approve: "yes"
    }, {
        "x-vault-approver": secret
    })).status, 400);
    const yes = await decide({
        project: "Alpha",
        key: "AGENT_ONE",
        approve: true
    }, {
        "x-vault-approver": secret
    });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.injectApproved, true);
    assert.equal((await decide({
        project: "Alpha",
        key: "AGENT_ONE",
        approve: false
    }, {
        "x-vault-approver": secret
    })).status, 409, "only pending keys can be decided");
    assert.equal((await decide({
        project: "Alpha",
        key: "ALPHA_KEY",
        approve: false
    }, {
        "x-vault-approver": secret
    })).status, 409, "human keys are never removed by the relay");
    const no = await decide({
        project: "Alpha",
        key: "AGENT_TWO",
        approve: false
    }, {
        "x-vault-approver": secret
    });
    assert.equal(no.status, 200);
    assert.equal(no.body.removed, true);
    assert(!store.findSecret(store.findProject("Alpha"), "AGENT_TWO"));
    assert.deepEqual(store.pendingApprovals(), []);
    assert(!JSON.stringify(store.vault.history).includes(secret));
});

test("token discovery uses env, a private token file, then a per-agent default file", t => {
    const dir = fixture(t), data = path.join(dir, "data"), file = path.join(dir, "token");
    fs.mkdirSync(path.join(data, "agents"), {
        recursive: true
    });
    const token = "a".repeat(64);
    assert.equal(discoverToken({
        VAULTOS_AGENT_TOKEN: token
    }, data).source, "VAULTOS_AGENT_TOKEN");
    fs.writeFileSync(file, token + "\n", {
        mode: 420
    });
    assert.throws(() => discoverToken({
        VAULTOS_AGENT_TOKEN_FILE: file
    }, data), /private/);
    fs.chmodSync(file, 384);
    assert.equal(discoverToken({
        VAULTOS_AGENT_TOKEN_FILE: file
    }, data).token, token);
    assert.throws(() => discoverToken({
        VAULTOS_AGENT_TOKEN_FILE: "relative/token"
    }, data), /absolute/);
    assert.throws(() => discoverToken({
        VAULTOS_AGENT: "../escape"
    }, data), /plain agent name/);
    assert.throws(() => discoverToken({
        VAULTOS_AGENT: "codex"
    }, data), /does not exist/);
    fs.writeFileSync(path.join(data, "agents", "codex.token"), token, {
        mode: 384
    });
    assert.deepEqual(discoverToken({
        VAULTOS_AGENT: "codex"
    }, data), {
        token: token,
        source: "VAULTOS_AGENT"
    });
    assert.equal(discoverToken({}, data).token, "");
});

test("concurrent clients start one backend under the start lock and report the outcome", async t => {
    const {store: store} = vault(t);
    store.lock();
    const unlocked = new Store(store.dataDir);
    let starts = 0;
    const startBackend = () => {
        starts++;
        setTimeout(async () => {
            unlocked.unlock(PASSWORD);
            const api = await startApi(unlocked);
            unlocked.writeSession(api.port, api.token);
            t.after(async () => {
                api.server.closeAllConnections();
                await new Promise(r => api.server.close(r));
            });
        }, 300);
        return {
            exited: null
        };
    };
    const options = {
        dataDir: store.dataDir,
        env: {},
        startBackend: startBackend,
        attempts: 40,
        interval: 100
    };
    const [a, b] = await Promise.all([ new VaultClient(options).status(), new VaultClient(options).status() ]);
    assert.equal(starts, 1);
    assert.equal(a.running && b.running, true);
    assert.equal(a.unlocked, true);
    assert(!fs.existsSync(path.join(store.dataDir, "session.json.starting")));
});

test("client distinguishes not running, background refusal, human lock and a locked owner", async t => {
    const {store: store} = vault(t);
    const empty = path.join(fixture(t), "empty");
    fs.mkdirSync(empty);
    const noVault = await new VaultClient({
        dataDir: empty,
        env: {},
        startBackend: () => assert.fail("must not start without a vault")
    }).status();
    assert.equal(noVault.running, false);
    assert.match(noVault.message, /No VaultOS vault/);
    const refused = await new VaultClient({
        dataDir: store.dataDir,
        env: {},
        startBackend: () => ({
            exited: 3
        }),
        attempts: 3,
        interval: 20
    }).status();
    assert.match(refused.message, /could not unlock in the background/);
    const stale = path.join(store.dataDir, "session.json.starting");
    fs.writeFileSync(stale, "999999");
    let took = false;
    await new VaultClient({
        dataDir: store.dataDir,
        env: {},
        startBackend: () => assert.fail("a fresh foreign start lock means another bridge is starting it"),
        attempts: 2,
        interval: 20
    }).status();
    assert(fs.existsSync(stale), "a fresh foreign start lock is respected");
    const old = new Date(Date.now() - 6e4);
    fs.utimesSync(stale, old, old);
    await new VaultClient({
        dataDir: store.dataDir,
        env: {},
        startBackend: () => {
            took = true;
            return {
                exited: 1
            };
        },
        attempts: 2,
        interval: 20
    }).status();
    assert(took, "a stale start lock is taken over");
    assert(!fs.existsSync(stale));
    store.blockAutoUnlock();
    const blocked = await new VaultClient({
        dataDir: store.dataDir,
        env: {},
        startBackend: () => assert.fail("a human lock blocks background start")
    }).status();
    assert.equal(blocked.reason, "locked");
    assert.match(blocked.message, /locked by a human/);
    store.allowAutoUnlock();
    const {api: api} = await serve(t, store);
    store.lock();
    const lockedClient = new VaultClient({
        dataDir: store.dataDir,
        env: {
            VAULTOS_AGENT_TOKEN: "b".repeat(64)
        }
    });
    const locked = await lockedClient.status();
    assert.equal(locked.running, true);
    assert.equal(locked.unlocked, false);
    await assert.rejects(lockedClient.request("GET", "/projects"), e => e.code === "locked" && /running but locked/.test(e.message));
    assert(api.port);
});

test("status passes through sync health when the owner reports it", async t => {
    const dir = fixture(t);
    const server = http.createServer((req, res) => {
        res.writeHead(200, {
            "content-type": "application/json"
        });
        res.end(JSON.stringify({
            app: "VaultOS-Preview",
            ok: true,
            locked: false,
            formatVersion: 3,
            sync: {
                state: "IN_SYNC"
            }
        }));
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({
        app: "VaultOS-Preview",
        port: server.address().port,
        token: "c".repeat(64)
    }), {
        mode: 384
    });
    const status = await new VaultClient({
        dataDir: dir,
        env: {},
        autostart: false
    }).status();
    assert.deepEqual(status.sync, {
        autoSync: false,
        state: "IN_SYNC",
        halted: false,
        lastSyncAt: null,
        error: null,
        peerStalled: false,
        peerProblems: []
    });
});

test("agent CLI uses the enrolled token, never prints values, and reads add values from stdin", async t => {
    const {dir: dir, store: store, agents: agents} = vault(t);
    const root = path.join(dir, "project");
    const worker = agents.enrol("codex", [ "read", "inject", "add" ], [ "Alpha" ], [ root ]);
    fs.mkdirSync(path.join(store.dataDir, "agents"), {
        mode: 448
    });
    fs.writeFileSync(path.join(store.dataDir, "agents", "codex.token"), worker.token + "\n", {
        mode: 384
    });
    await serve(t, store);
    const env = {
        VAULTOS_DATA_DIR: store.dataDir,
        VAULTOS_AGENT: "codex"
    };
    const run = (args, input) => agentCli(env, args, input);
    const who = await run([ "whoami" ]);
    assert.equal(who.code, 0, who.stderr);
    assert.equal(JSON.parse(who.stdout).name, "codex");
    const status = JSON.parse((await run([ "status" ])).stdout);
    assert.equal(status.running, true);
    assert.equal(status.unlocked, true);
    assert.deepEqual(JSON.parse((await run([ "projects" ])).stdout).map(x => x.name), [ "Alpha" ]);
    const keys = await run([ "keys", "Alpha" ]);
    assert(keys.stdout.includes("ALPHA_KEY") && !keys.stdout.includes("synthetic-alpha-value"));
    assert(!(await run([ "search", "KEY" ])).stdout.includes("synthetic"));
    const inject = await run([ "inject", "Alpha", path.join(root, ".env"), "--keys", "ALPHA_KEY", "--replace" ]);
    assert.equal(inject.code, 0, inject.stderr);
    assert.equal(JSON.parse(inject.stdout).wrote, 1);
    assert(!inject.stdout.includes("synthetic-alpha-value"));
    assert(fs.readFileSync(path.join(root, ".env"), "utf8").includes("synthetic-alpha-value"));
    const add = await run([ "add", "Alpha", "PIPED_KEY", "--note", "synthetic" ], "synthetic-piped-value\n");
    assert.equal(add.code, 0, add.stderr);
    assert.equal(JSON.parse(add.stdout).injectApproved, false);
    assert(!add.stdout.includes("synthetic-piped-value") && !add.stderr.includes("synthetic-piped-value"));
    assert.equal(store.findSecret(store.findProject("Alpha"), "PIPED_KEY").value, "synthetic-piped-value");
    const argv = await run([ "add", "Alpha", "ARGV_KEY", "synthetic-argv-value" ], "");
    assert.equal(argv.code, 2);
    assert(!argv.stderr.includes("synthetic-argv-value"));
    const flagged = await run([ "add", "Alpha", "ARGV_KEY", "--value", "synthetic-flag-value" ], "");
    assert.equal(flagged.code, 2);
    assert.deepEqual(JSON.parse((await run([ "pending" ])).stdout).map(x => x.key), [ "PIPED_KEY" ]);
    const sync = await run([ "sync" ]);
    assert.equal(sync.code, 1);
    assert.match(sync.stderr, /owner action, not an agent permission/);
    const denied = await run([ "keys", "Beta" ]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /not approved/);
    fs.chmodSync(path.join(store.dataDir, "agents", "codex.token"), 416);
    const loose = await run([ "whoami" ]);
    assert.equal(loose.code, 5);
    assert.match(loose.stderr, /private/);
    store.lock();
    const locked = await agentCli({
        VAULTOS_DATA_DIR: store.dataDir,
        VAULTOS_AGENT_TOKEN: worker.token
    }, [ "projects" ]);
    assert.equal(locked.code, 4);
    assert.match(locked.stderr, /running but locked/);
});

test("agent CLI reports a missing vault as not running without starting anything", async t => {
    const dir = fixture(t);
    const r = await agentCli({
        VAULTOS_DATA_DIR: dir,
        VAULTOS_AGENT_TOKEN: "d".repeat(64)
    }, [ "projects" ]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /No VaultOS vault/);
});

test("MCP bridge discovers per-agent tokens, reports status with its hash, and supports createProject", async t => {
    const {dir: dir, store: store, agents: agents} = vault(t);
    const root = path.join(dir, "project");
    fs.writeFileSync(path.join(root, ".env"), "MCP_IMPORTED=synthetic-mcp-import\n");
    const worker = agents.enrol("claude", [ "read", "add" ], [], [ root ]);
    fs.mkdirSync(path.join(store.dataDir, "agents"), {
        mode: 448
    });
    fs.writeFileSync(path.join(store.dataDir, "agents", "claude.token"), worker.token, {
        mode: 384
    });
    await serve(t, store);
    const {Client: Client} = await import("@modelcontextprotocol/sdk/client/index.js"), {StdioClientTransport: StdioClientTransport} = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({
        name: "synthetic-test",
        version: "1.0.0"
    });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [ path.resolve("mcp/server.mjs") ],
        env: {
            PATH: process.env.PATH,
            VAULTOS_DATA_DIR: store.dataDir,
            VAULTOS_AGENT: "claude"
        },
        stderr: "pipe"
    }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 13);
    assert(tools.find(x => x.name === "import_env").inputSchema.properties.createProject);
    const text = r => JSON.parse(r.content[0].text);
    const status = text(await client.callTool({
        name: "vault_status",
        arguments: {}
    }));
    assert.equal(status.unlocked, true);
    assert.equal(status.sync.state, "NOT_RUNNING");
    assert.equal(status.bridge.sha256, require("node:crypto").createHash("sha256").update(fs.readFileSync("mcp/server.mjs")).digest("hex"));
    assert.equal(text(await client.callTool({
        name: "whoami",
        arguments: {}
    })).name, "claude");
    const imported = await client.callTool({
        name: "import_env",
        arguments: {
            project: "Created By Import",
            env_path: path.join(root, ".env"),
            createProject: true
        }
    });
    assert(!imported.isError, JSON.stringify(imported));
    assert(!JSON.stringify(imported).includes("synthetic-mcp-import"));
    assert(store.findProject("Created By Import"));
    store.lock();
    const locked = await client.callTool({
        name: "list_projects",
        arguments: {}
    });
    assert(locked.isError);
    assert.match(locked.content[0].text, /running but locked/);
});

test("client waits for a live but busy owner instead of reporting it as not running", async t => {
    const dir = fixture(t);
    let calls = 0;
    const server = http.createServer((req, res) => {
        // The first probes hang past their timeout, as during a synchronous sync round.
        if (++calls <= 2) return setTimeout(() => res.destroy(), 3e3);
        res.writeHead(200, {
            "content-type": "application/json"
        });
        res.end(JSON.stringify({
            app: "VaultOS-Preview",
            ok: true,
            locked: false,
            formatVersion: 3
        }));
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const owner = require("node:child_process").spawn("sleep", [ "30" ]);
    t.after(() => owner.kill());
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({
        app: "VaultOS-Preview",
        port: server.address().port,
        token: "d".repeat(64),
        pid: owner.pid
    }), {
        mode: 384
    });
    let started = 0;
    const status = await new VaultClient({
        dataDir: dir,
        env: {},
        startBackend: () => {
            started++;
        }
    }).status();
    assert.equal(status.running, true);
    assert.equal(started, 0);
});
