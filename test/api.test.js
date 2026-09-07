"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const {Store: Store} = require("../store"), {Agents: Agents} = require("../agents"), {startApi: startApi} = require("../api");

test("API enforces identity, scopes, project allowlists, path allowlists and lock", async t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-api-"));
    const store = new Store(path.join(dir, "data"));
    store.init("synthetic-test-password");
    fs.mkdirSync(path.join(dir, "project"));
    store.createProject("Allowed");
    store.createProject("Private");
    store.setSecret("Allowed", {
        key: "API_KEY",
        value: "private-test-value"
    });
    const registry = new Agents(store), agent = registry.enrol("worker", [ "read", "add", "inject" ], [ "Allowed" ], [ path.join(dir, "project") ]);
    const api = await startApi(store);
    t.after(async () => {
        api.server.closeAllConnections();
        await new Promise(r => api.server.close(r));
        fs.rmSync(dir, {
            recursive: true,
            force: true
        });
    });
    const call = async (p, body, headers = {}) => fetch(`http://127.0.0.1:${api.port}${p}`, {
        method: body ? "POST" : "GET",
        headers: {
            authorization: `Bearer ${api.token}`,
            "x-vault-agent-token": agent.token,
            "content-type": "application/json",
            ...headers
        },
        body: body ? JSON.stringify(body) : undefined
    });
    assert.equal((await call("/projects", null, {
        "x-vault-agent-token": ""
    })).status, 403);
    assert.equal((await call("/projects", null, {
        origin: "https://hostile.example"
    })).status, 403);
    const badHost = await new Promise(resolve => {
        require("node:http").get({
            hostname: "127.0.0.1",
            port: api.port,
            path: "/projects",
            headers: {
                host: "hostile.example"
            }
        }, r => {
            r.resume();
            resolve(r.statusCode);
        });
    });
    assert.equal(badHost, 403);
    const projects = await (await call("/projects")).json();
    assert.deepEqual(projects.map(x => x.name), [ "Allowed" ]);
    assert.equal((await call("/projects/Private/secrets")).status, 403);
    const names = await (await call("/projects/Allowed/secrets")).text();
    assert(!names.includes("private-test-value"));
    assert(!names.includes('"hash"'));
    assert.equal((await call("/reveal", {
        project: "Allowed",
        key: "API_KEY"
    })).status, 403);
    assert.equal((await call("/projects/Allowed/secrets", {
        key: "API_KEY",
        value: "new"
    })).status, 403);
    assert.equal((await call("/inject", {
        project: "Allowed",
        target_path: path.join(dir, "outside.env")
    })).status, 400);
    assert.equal((await call("/inject", {
        project: "Allowed",
        target_path: path.join(dir, "project", ".env")
    })).status, 200);
    fs.symlinkSync(path.join(dir, "data"), path.join(dir, "project", "link"));
    assert.equal((await call("/inject", {
        project: "Allowed",
        target_path: path.join(dir, "project", "link", "vault.enc")
    })).status, 400);
    assert.equal((await call("/projects/Allowed/secrets", {
        key: "NEW",
        value: "new"
    })).status, 200);
    const output = await (await call("/inject", {
        project: "Allowed",
        target_path: path.join(dir, "project", ".env")
    })).json();
    assert(output.heldForApproval.includes("NEW"));
    registry.revoke(agent.id);
    assert.equal((await call("/projects")).status, 403);
    store.lock();
    assert.equal((await call("/projects")).status, 423);
});
