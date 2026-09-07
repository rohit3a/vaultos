"use strict";

const {randomId: randomId, randomToken: randomToken, sha256: sha256, safeEqual: safeEqual} = require("./crypto");

const {DEFAULT_SCOPES: DEFAULT_SCOPES, ALL_SCOPES: ALL_SCOPES, agentRef: agentRef} = require("./model");

class Agents {
    constructor(store) {
        this.store = store;
    }
    all() {
        this.store.vault.agents = this.store.vault.agents || [];
        return this.store.vault.agents;
    }
    list() {
        return this.all().map(a => ({
            id: a.id,
            name: a.name,
            ref: agentRef(a.id),
            scopes: a.scopes,
            enrolledAt: a.enrolledAt,
            lastSeenAt: a.lastSeenAt || null,
            revoked: !!a.revokedAt,
            revokedAt: a.revokedAt || null,
            projects: a.projects || [],
            roots: a.roots || []
        }));
    }
    find(id) {
        return this.all().find(a => a.id === id) || null;
    }
    byName(name) {
        const v = String(name || "").toLowerCase();
        return this.all().find(a => a.name.toLowerCase() === v) || null;
    }
    enrol(name, scopes, projects = [], roots = []) {
        require("./validation").text(name, "agent name", 100);
        const access = this.validateAccess(projects, roots);
        if (!name || !String(name).trim()) throw new Error("agent name required");
        if (this.byName(name)) throw new Error(`an agent named "${name}" is already enrolled`);
        if (scopes !== undefined && !Array.isArray(scopes)) throw new Error("Scopes must be an array");
        const bad = (scopes || []).filter(s => !ALL_SCOPES.includes(s));
        if (bad.length) throw new Error(`unknown scope(s): ${bad.join(", ")}`);
        const token = randomToken();
        const agent = {
            id: randomId(),
            name: String(name).trim(),
            tokenHash: sha256(token),
            scopes: scopes === undefined ? [ ...DEFAULT_SCOPES ] : [ ...new Set(scopes) ],
            ...access,
            enrolledAt: (new Date).toISOString(),
            lastSeenAt: null,
            revokedAt: null
        };
        this.all().push(agent);
        this.store.persist();
        return {
            id: agent.id,
            name: agent.name,
            ref: agentRef(agent.id),
            scopes: agent.scopes,
            token: token
        };
    }
    validateAccess(projects, roots) {
        const fs = require("node:fs"), path = require("node:path");
        if (!Array.isArray(projects) || !Array.isArray(roots) || projects.length > 1e3 || roots.length > 100) throw new Error("Invalid agent access");
        const ids = projects.map(id => {
            const project = this.store.findProject(id);
            if (!project) throw new Error("Project not found");
            return project.id;
        });
        const folders = roots.map(root => {
            if (typeof root !== "string" || !path.isAbsolute(root) || !fs.statSync(root).isDirectory()) throw new Error("Choose an existing absolute folder");
            const canonical = fs.realpathSync(root);
            const data = fs.realpathSync(this.store.dataDir);
            if (canonical === path.parse(canonical).root || data === canonical || data.startsWith(canonical + path.sep)) throw new Error("Choose a project folder, not a folder containing the vault");
            return canonical;
        });
        return {
            projects: [ ...new Set(ids) ],
            roots: [ ...new Set(folders) ]
        };
    }
    setAccess(id, projects, roots) {
        const a = this.find(id);
        if (!a) throw new Error("Agent not found");
        Object.assign(a, this.validateAccess(projects, roots));
        this.store.persist();
        return {
            id: a.id,
            projects: a.projects,
            roots: a.roots
        };
    }
    reissue(id) {
        const a = this.find(id);
        if (!a) throw new Error("agent not found");
        const token = randomToken();
        a.tokenHash = sha256(token);
        a.revokedAt = null;
        this.store.persist();
        return {
            id: a.id,
            name: a.name,
            ref: agentRef(a.id),
            token: token
        };
    }
    revoke(id) {
        const a = this.find(id);
        if (!a) throw new Error("agent not found");
        a.revokedAt = (new Date).toISOString();
        this.store.persist();
        return {
            id: a.id,
            name: a.name,
            revoked: true
        };
    }
    setScopes(id, scopes) {
        const a = this.find(id);
        if (!a) throw new Error("agent not found");
        if (scopes !== undefined && !Array.isArray(scopes)) throw new Error("Scopes must be an array");
        const bad = (scopes || []).filter(s => !ALL_SCOPES.includes(s));
        if (bad.length) throw new Error(`unknown scope(s): ${bad.join(", ")}`);
        a.scopes = scopes || [];
        this.store.persist();
        return {
            id: a.id,
            name: a.name,
            scopes: a.scopes
        };
    }
    authenticate(token) {
        if (!token) return null;
        const h = sha256(token);
        for (const a of this.all()) {
            if (safeEqual(a.tokenHash, h)) return a.revokedAt ? null : a;
        }
        return null;
    }
    touch(agent) {
        if (agent) agent.lastSeenAt = (new Date).toISOString();
    }
}

module.exports = {
    Agents: Agents
};
