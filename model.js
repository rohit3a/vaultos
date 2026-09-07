"use strict";

const {randomId: randomId, contentHash: contentHash} = require("./crypto");

const FORMAT_VERSION = 3;

const MIN_READER_VERSION = 3;

const HUMAN = "human";

const isAgent = owner => typeof owner === "string" && owner.startsWith("agent:");

const agentRef = agentId => `agent:${agentId}`;

const ALL_SCOPES = [ "read", "add", "edit:own", "edit:delegated", "delete:own", "inject", "reveal" ];

const DEFAULT_SCOPES = [ "read", "inject" ];

const RECORD_FIELDS = [ "id", "key", "value", "provider", "note", "username", "email", "password", "url", "permission", "expiresAt", "owner", "createdBy", "modifiedBy", "editableBy", "injectApproved", "createdAt", "updatedAt", "rev" ];

function pickRecord(s) {
    const out = {};
    for (const f of RECORD_FIELDS) if (s[f] !== undefined) out[f] = s[f];
    return out;
}

function recordHash(s) {
    return contentHash(pickRecord(s));
}

function newSecret(fields, actor) {
    const now = (new Date).toISOString();
    const owner = actor === HUMAN ? HUMAN : actor;
    return {
        id: randomId(),
        key: fields.key,
        value: fields.value || "",
        provider: fields.provider || "",
        note: fields.note || "",
        username: fields.username || "",
        email: fields.email || "",
        password: fields.password || "",
        url: fields.url || "",
        permission: fields.permission || "",
        expiresAt: fields.expiresAt || "",
        owner: owner,
        createdBy: actor,
        modifiedBy: actor,
        editableBy: [],
        injectApproved: owner === HUMAN,
        createdAt: now,
        updatedAt: now,
        rev: 1
    };
}

function canEdit(secret, actor) {
    if (actor === HUMAN) return {
        ok: true
    };
    if (!isAgent(actor)) return {
        ok: false,
        why: "unknown caller"
    };
    if (secret.owner === actor) return {
        ok: true
    };
    if (Array.isArray(secret.editableBy) && secret.editableBy.includes(actor)) return {
        ok: true
    };
    if (secret.owner === HUMAN) {
        return {
            ok: false,
            why: `"${secret.key}" is yours, not the agent's. Delegate it in Vault OS if you want the agent to manage it.`
        };
    }
    return {
        ok: false,
        why: `"${secret.key}" belongs to ${secret.owner}; a different agent cannot change it.`
    };
}

function canDelete(secret, actor) {
    if (actor === HUMAN) return {
        ok: true
    };
    if (secret.owner === actor) return {
        ok: true
    };
    return {
        ok: false,
        why: `only the owner (${secret.owner}) or you can delete "${secret.key}".`
    };
}

function migrate(vault) {
    const v = vault || {};
    if ((v.formatVersion || 1) >= FORMAT_VERSION) return {
        vault: v,
        migrated: false,
        changed: 0
    };
    let changed = 0;
    const now = (new Date).toISOString();
    for (const p of v.projects || []) {
        p.createdAt = p.createdAt || now;
        p.updatedAt = p.updatedAt || now;
        p.owner = p.owner || HUMAN;
        for (const s of p.secrets || []) {
            if (s.owner) continue;
            s.owner = HUMAN;
            s.createdBy = HUMAN;
            s.modifiedBy = HUMAN;
            s.editableBy = [];
            s.injectApproved = true;
            s.createdAt = s.createdAt || s.updatedAt || now;
            s.updatedAt = s.updatedAt || now;
            s.rev = s.rev || 1;
            changed++;
        }
    }
    v.agents = v.agents || [];
    v.tombstones = v.tombstones || [];
    v.history = v.history || [];
    v.settings = v.settings || {};
    v.formatVersion = FORMAT_VERSION;
    v.minReaderVersion = MIN_READER_VERSION;
    return {
        vault: v,
        migrated: true,
        changed: changed
    };
}

function assertReadable(vault) {
    if (!vault || typeof vault !== "object" || !Array.isArray(vault.projects)) throw new Error("Invalid vault data");
    const need = Math.max(vault.minReaderVersion || 1, vault.formatVersion || 1);
    if (need > FORMAT_VERSION) {
        throw new Error(`This vault needs Vault OS format v${need}; this build understands v${FORMAT_VERSION}. ` + `Update Vault OS on this machine rather than opening it with the rules turned off.`);
    }
}

module.exports = {
    FORMAT_VERSION: FORMAT_VERSION,
    MIN_READER_VERSION: MIN_READER_VERSION,
    HUMAN: HUMAN,
    ALL_SCOPES: ALL_SCOPES,
    DEFAULT_SCOPES: DEFAULT_SCOPES,
    isAgent: isAgent,
    agentRef: agentRef,
    newSecret: newSecret,
    pickRecord: pickRecord,
    recordHash: recordHash,
    canEdit: canEdit,
    canDelete: canDelete,
    migrate: migrate,
    assertReadable: assertReadable
};
