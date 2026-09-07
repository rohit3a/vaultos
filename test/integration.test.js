"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), path = require("node:path"), os = require("node:os");

const {Store: Store} = require("../store"), {Agents: Agents} = require("../agents"), {startApi: startApi} = require("../api"), {claim: claim} = require("../session");

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-integration-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    return dir;
}

test("manual lock blocks remembered background unlock; dead write locks recover", t => {
    const dir = fixture(t), store = new Store(dir);
    store.init("synthetic-integration-password");
    store.keyring = {
        get: () => "synthetic-integration-password",
        set: () => {}
    };
    store.vault.settings.rememberPassword = true;
    store.persist();
    store.blockAutoUnlock();
    store.lock();
    assert.equal(store.autoUnlock(), false);
    store.allowAutoUnlock();
    assert.equal(store.autoUnlock(), true);
    const release = claim(dir);
    assert.throws(() => claim(dir), /Another/);
    release();
    fs.writeFileSync(path.join(dir, "write.lock"), "2147483647");
    store.createProject("Recovered");
    assert.equal(store.listProjects()[0].name, "Recovered");
});

test("legacy encryption remains readable", () => {
    const crypto = require("node:crypto"), {decryptVault: decryptVault} = require("../crypto");
    const salt = Buffer.alloc(16, 1), iv = Buffer.alloc(12, 2), pw = "synthetic-legacy-password";
    const key = crypto.scryptSync(pw, salt, 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
    }), cipher = crypto.createCipheriv("aes-256-gcm", key, iv), value = {
        projects: []
    };
    const data = Buffer.concat([ cipher.update(JSON.stringify(value)), cipher.final() ]);
    assert.deepEqual(decryptVault({
        v: 1,
        kdf: "scrypt",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64")
    }, pw), value);
});

test("MCP stdio injects through real authenticated HTTP without returning values", async t => {
    const dir = fixture(t), store = new Store(path.join(dir, "data"));
    store.init("synthetic-integration-password");
    store.createProject("Example");
    store.setSecret("Example", {
        key: "DEMO",
        value: "synthetic-mcp-private"
    });
    const output = path.join(dir, "project");
    fs.mkdirSync(output);
    const agent = new Agents(store).enrol("MCP test", [ "read", "inject" ], [ "Example" ], [ output ]);
    const api = await startApi(store);
    store.writeSession(api.port, api.token);
    t.after(async () => {
        api.server.closeAllConnections();
        await new Promise(r => api.server.close(r));
    });
    const {Client: Client} = await import("@modelcontextprotocol/sdk/client/index.js"), {StdioClientTransport: StdioClientTransport} = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [ path.resolve("mcp/server.mjs") ],
        env: {
            ...process.env,
            VAULTOS_DATA_DIR: store.dataDir,
            VAULTOS_AGENT_TOKEN: agent.token
        },
        stderr: "pipe"
    });
    const client = new Client({
        name: "synthetic-test",
        version: "1.0.0"
    });
    t.after(() => client.close());
    await client.connect(transport);
    assert((await client.listTools()).tools.some(x => x.name === "inject_secrets"));
    const result = await client.callTool({
        name: "inject_secrets",
        arguments: {
            project: "Example",
            target_path: path.join(output, ".env"),
            format: "dotenv",
            merge: false
        }
    });
    assert(!result.isError, JSON.stringify(result));
    assert(!JSON.stringify(result).includes("synthetic-mcp-private"));
    assert(fs.readFileSync(path.join(output, ".env"), "utf8").includes("synthetic-mcp-private"));
    const denied = await client.callTool({
        name: "reveal_secret",
        arguments: {
            project: "Example",
            key: "DEMO"
        }
    });
    assert(denied.isError);
});

test("native Keychain set/read/delete in a disposable test-only Keychain", {
    skip: process.platform !== "darwin"
}, t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-keychain-test-")), {execFileSync: execFileSync} = require("node:child_process"), file = path.join(dir, "test.keychain-db");
    const helper = path.resolve("build/native/vaultos-keychain-test");
    assert(fs.existsSync(helper), "Build with VAULTOS_BUILD_TEST_HELPER=1");
    execFileSync("/usr/bin/security", [ "create-keychain", "-p", "synthetic-test-keychain-password", file ], {
        stdio: "pipe"
    });
    t.after(() => {
        try {
            execFileSync("/usr/bin/security", [ "delete-keychain", file ], {
                stdio: "pipe"
            });
        } finally {
            fs.rmSync(dir, {
                recursive: true,
                force: true
            });
        }
    });
    execFileSync("/usr/bin/security", [ "unlock-keychain", "-p", "synthetic-test-keychain-password", file ], {
        stdio: "pipe"
    });
    const request = action => JSON.parse(execFileSync(helper, [], {
        input: JSON.stringify({
            action: action,
            service: "org.vaultos.preview.test." + path.basename(dir),
            password: "synthetic-keychain-only"
        }),
        encoding: "utf8",
        env: {
            ...process.env,
            VAULTOS_TEST_KEYCHAIN: file
        },
        stdio: [ "pipe", "pipe", "pipe" ]
    }));
    request("set");
    assert.equal(request("get").password, "synthetic-keychain-only");
    request("delete");
    assert.equal(request("get").password, undefined);
});
