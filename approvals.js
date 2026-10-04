"use strict";

const {randomToken: randomToken, sha256: sha256, safeEqual: safeEqual} = require("./crypto");

const M = require("./model");

const V = require("./validation");

function refuse(message, status) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function pendingRecord(store, project, key) {
    V.text(project, "project");
    V.text(key, "key name");
    const p = store.findProject(project);
    if (!p) throw refuse("project not found", 404);
    const s = store.findSecret(p, key);
    if (!s) throw refuse("secret not found", 404);
    if (s.injectApproved !== false) throw refuse(`"${s.key}" is not awaiting approval`, 409);
    return {
        project: p,
        secret: s
    };
}

function approve(store, project, key, via = "desktop") {
    const {project: p, secret: s} = pendingRecord(store, project, key);
    store.approveInject(p.id, s.id, true);
    store.audit("approve_inject", `${p.name}/${s.key} via ${via}`, M.HUMAN);
    return {
        project: p.name,
        key: s.key,
        injectApproved: true
    };
}

function deny(store, project, key, via = "desktop") {
    const {project: p, secret: s} = pendingRecord(store, project, key);
    store.deleteSecret(p.id, s.id, M.HUMAN);
    store.audit("deny_inject", `${p.name}/${s.key} via ${via}`, M.HUMAN);
    return {
        project: p.name,
        key: s.key,
        denied: true,
        removed: true
    };
}

function approveAll(store, via = "desktop", project = null) {
    const wanted = project ? store.findProject(project) : null;
    if (project && !wanted) throw refuse("project not found", 404);
    const approved = [];
    for (const item of store.pendingApprovals()) {
        if (wanted && item.project !== wanted.name) continue;
        approved.push(approve(store, item.project, item.key, via));
    }
    return {
        approved: approved.map(x => ({
            project: x.project,
            key: x.key
        }))
    };
}

function approverConfigured(store) {
    return /^[a-f0-9]{64}$/.test(String((store.vault.settings || {}).approverTokenHash || ""));
}

function setApproverHash(store, hash) {
    if (hash !== null && !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid approver hash");
    const before = {
        approverConfigured: approverConfigured(store)
    };
    const settings = {
        ...store.vault.settings || {}
    };
    if (hash) settings.approverTokenHash = hash; else delete settings.approverTokenHash;
    store.vault.settings = settings;
    store.record("update_settings", {
        actor: M.HUMAN,
        before: before,
        after: {
            approverConfigured: !!hash
        }
    });
    store.persist();
    store.audit(hash ? "set_approver" : "clear_approver", "approval relay", M.HUMAN);
    return {
        approverConfigured: !!hash
    };
}

function issueApproverToken(store) {
    const token = randomToken();
    setApproverHash(store, sha256(token));
    return token;
}

function verifyApprover(store, presented) {
    if (!approverConfigured(store)) return false;
    if (typeof presented !== "string" || !presented || presented.length > 512) return false;
    return safeEqual(sha256(presented), store.vault.settings.approverTokenHash);
}

function relayDecision(store, presented, body) {
    if (!approverConfigured(store)) throw refuse("The approval relay is not configured", 403);
    if (!verifyApprover(store, presented)) throw refuse("Only the configured approval relay can decide pending keys", 403);
    V.object(body);
    if (typeof body.approve !== "boolean") throw new Error("project, key and approve (true/false) are required");
    return body.approve ? approve(store, body.project, body.key, "approval relay") : deny(store, body.project, body.key, "approval relay");
}

module.exports = {
    approve: approve,
    deny: deny,
    approveAll: approveAll,
    approverConfigured: approverConfigured,
    setApproverHash: setApproverHash,
    issueApproverToken: issueApproverToken,
    verifyApprover: verifyApprover,
    relayDecision: relayDecision
};
