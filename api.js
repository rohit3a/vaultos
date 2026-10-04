"use strict";

const http = require("node:http");

const path = require("node:path");

const fs = require("node:fs");

const {randomToken: randomToken, safeEqual: safeEqual} = require("./crypto");

const {Agents: Agents} = require("./agents");

const {checkedPath: checkedPath} = require("./fs-safe");

const {deployment: deployment} = require("./version");

const M = require("./model");

const V = require("./validation");

const {relayDecision: relayDecision} = require("./approvals");

const MAX_BODY = 1024 * 1024;

function startApi(store, {onShutdown: onShutdown = null, autoSync: autoSync = null} = {}) {
    const token = randomToken();
    const agents = new Agents(store);
    const server = http.createServer({
        maxHeaderSize: 8192
    }, (req, res) => {
        const send = (code, obj) => {
            if (res.writableEnded) return;
            res.writeHead(code, {
                "content-type": "application/json",
                "cache-control": "no-store",
                "x-content-type-options": "nosniff"
            });
            res.end(JSON.stringify(obj));
        };
        if (req.headers.origin || req.headers["sec-fetch-site"]) return send(403, {
            error: "Browser requests are not allowed"
        });
        if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")) return send(403, {
            error: "Invalid host"
        });
        const owner = safeEqual(req.headers.authorization, `Bearer ${token}`);
        if (req.url === "/status" && req.method === "GET") return send(200, {
            app: "VaultOS-Preview",
            ok: true,
            locked: !store.isUnlocked(),
            formatVersion: M.FORMAT_VERSION,
            deployment: deployment(),
            sync: autoSync ? owner ? autoSync.status() : autoSync.publicStatus() : {
                state: "NOT_RUNNING"
            }
        });
        if (!owner) return send(401, {
            error: "Unauthorized"
        });
        if (req.url === "/shutdown" && req.method === "POST" && onShutdown) {
            send(200, {
                ok: true
            });
            setTimeout(onShutdown, 10);
            return;
        }
        // Owner control, like /shutdown: the session token alone, never an agent. It cannot
        // accept conflicts or return values; it runs the same round autosync would.
        if (req.url === "/sync" && req.method === "POST") {
            if (req.headers["x-vault-agent-token"]) return send(403, {
                error: "Agents cannot trigger sync"
            });
            if (!autoSync) return send(404, {
                error: "Not found"
            });
            try {
                const result = autoSync.run({
                    manual: true
                });
                return send(200, {
                    ok: result.state === "OK",
                    ...result
                });
            } catch (e) {
                return send(e.status || 409, {
                    error: e.message
                });
            }
        }
        if (!store.isUnlocked()) return send(423, {
            error: "Vault is locked. Unlock the app."
        });
        try {
            store.reloadIfChanged();
        } catch {
            return send(409, {
                error: "The vault changed on disk and could not be reloaded. Unlock the app again."
            });
        }
        const relay = req.url === "/pending/decide" && req.method === "POST";
        const agent = relay ? null : agents.authenticate(req.headers["x-vault-agent-token"]);
        if (!relay && !agent) return send(403, {
            error: "An enrolled, active agent token is required"
        });
        if (agent) agents.touch(agent);
        let size = 0, exceeded = false;
        const chunks = [];
        req.on("error", () => send(400, {
            error: "Incomplete request"
        }));
        req.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_BODY) {
                exceeded = true;
                chunks.length = 0;
                send(413, {
                    error: "Request too large"
                });
            } else if (!exceeded) chunks.push(chunk);
        });
        req.on("end", () => {
            if (exceeded) return;
            try {
                if (!store.isUnlocked()) return send(423, {
                    error: "Vault is locked. Unlock the app."
                });
                const currentAgent = relay ? null : agents.authenticate(req.headers["x-vault-agent-token"]);
                if (!relay && !currentAgent) return send(403, {
                    error: "Agent access was revoked"
                });
                let body = {};
                if (size) {
                    if (!String(req.headers["content-type"]).startsWith("application/json")) return send(415, {
                        error: "JSON required"
                    });
                    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    V.object(body);
                }
                const result = relay ? relayDecision(store, req.headers["x-vault-approver"], body) : route(req, body, store, currentAgent, agents);
                send(200, result);
            } catch (e) {
                send(e.status || 400, {
                    error: e instanceof SyntaxError ? "Invalid JSON" : e.code ? "File operation failed; check permissions and retry" : e.message
                });
            }
        });
    });
    server.requestTimeout = 15e3;
    server.headersTimeout = 1e4;
    server.timeout = 15e3;
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({
            server: server,
            port: server.address().port,
            token: token
        }));
    });
}

function route(req, body, store, agent, agents) {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname, m = req.method, actor = M.agentRef(agent.id);
    const deny = message => {
        const e = new Error(message);
        e.status = 403;
        throw e;
    };
    const scope = name => {
        if (!agent.scopes.includes(name)) deny("This agent does not have the " + name + " scope");
    };
    const allowed = id => !!id && (agent.allProjects === true || (agent.projects || []).includes(id));
    const project = name => {
        const result = store.findProject(name);
        if (!result || !allowed(result.id)) deny("Project is not approved for this agent");
        return result;
    };
    const file = target => {
        const resolved = agent.anyRoot === true ? canonicalTarget(target) : checkedPath(target, agent.roots || []);
        const data = fs.realpathSync(store.dataDir);
        for (const dir of [ store.dataDir, data ]) if (resolved === dir || resolved.startsWith(dir + path.sep)) deny("Vault files are not export destinations");
        return resolved;
    };
    const createProject = name => {
        scope("add");
        const created = store.createProject(name, actor);
        agent.projects = [ ...agent.projects || [], created.id ];
        store.persist();
        return created;
    };
    const writeSecret = (proj, fields) => {
        const existing = store.findSecret(proj, fields.key);
        if (!existing) scope("add"); else scope(existing.owner === actor ? "edit:own" : "edit:delegated");
        return store.setSecret(proj.id, fields, actor);
    };
    if (p === "/whoami" && m === "GET") return {
        identity: actor,
        name: agent.name,
        scopes: agent.scopes,
        projects: agent.projects || [],
        roots: agent.roots || [],
        allProjects: agent.allProjects === true,
        anyRoot: agent.anyRoot === true
    };
    if (p === "/projects" && m === "GET") {
        scope("read");
        return store.listProjects().filter(x => allowed(x.id));
    }
    if (p === "/projects" && m === "POST") return createProject(body.name);
    const match = p.match(/^\/projects\/([^/]+)\/secrets(?:\/([^/]+))?$/);
    if (match) {
        const proj = project(decodeURIComponent(match[1]));
        if (m === "GET" && !match[2]) {
            scope("read");
            return store.listSecrets(proj.id);
        }
        if (m === "POST" && !match[2]) return writeSecret(proj, body);
        if (m === "DELETE" && match[2]) {
            scope("delete:own");
            return store.deleteSecret(proj.id, decodeURIComponent(match[2]), actor);
        }
    }
    if (p === "/search" && m === "GET") {
        scope("read");
        return store.search(url.searchParams.get("q")).filter(x => allowed(store.findProject(x.project)?.id));
    }
    if (p === "/pending" && m === "GET") {
        scope("read");
        return store.pendingApprovals().filter(x => allowed(store.findProject(x.project)?.id));
    }
    if (p === "/reveal" && m === "POST") {
        scope("reveal");
        return store.revealSecret(project(body.project).id, body.key, actor);
    }
    if (p === "/compare" && m === "GET") {
        scope("reveal");
        return store.fingerprints().filter(x => allowed(x.projectId));
    }
    if (p === "/inject" && m === "POST") {
        scope("inject");
        const proj = project(body.project);
        if (body.keys !== undefined && body.keys !== null && (!Array.isArray(body.keys) || body.keys.some(k => typeof k !== "string"))) throw new Error("keys must be a list of names");
        if (body.merge !== undefined && typeof body.merge !== "boolean") throw new Error("merge must be boolean");
        return store.inject(proj.id, file(body.target_path), body.format || "dotenv", {
            merge: body.merge !== false,
            keys: body.keys,
            actor: actor
        });
    }
    if (p === "/import" && m === "POST") {
        scope("add");
        if (body.createProject !== undefined && typeof body.createProject !== "boolean") throw new Error("createProject must be boolean");
        const source = file(body.env_path);
        require("./fs-safe").regularFile(source, {
            maxBytes: 1024 * 1024
        });
        const proj = body.createProject === true && !store.findProject(body.project) ? createProject(body.project) : project(body.project);
        const values = require("dotenv").parse(require("node:fs").readFileSync(source));
        const keys = [], refused = [];
        for (const [key, value] of Object.entries(values)) {
            try {
                writeSecret(proj, {
                    key: key,
                    value: value
                });
                keys.push(key);
            } catch {
                refused.push(key);
            }
        }
        store.audit("import", `${proj.name}: ${keys.length} keys`, actor);
        return {
            project: proj.name,
            keys: keys,
            refused: refused
        };
    }
    const e = new Error("Not found");
    e.status = 404;
    throw e;
}

function canonicalTarget(file) {
    if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw new Error("An absolute file path is required");
    let base = path.resolve(file);
    const rest = [];
    for (;;) {
        try {
            fs.lstatSync(base);
            break;
        } catch (e) {
            if (e.code !== "ENOENT" || base === path.dirname(base)) throw e;
            rest.unshift(path.basename(base));
            base = path.dirname(base);
        }
    }
    if (!rest.length && fs.lstatSync(base).isSymbolicLink()) throw new Error("Symbolic links are not allowed as file paths");
    return path.join(fs.realpathSync(base), ...rest);
}

module.exports = {
    startApi: startApi
};
