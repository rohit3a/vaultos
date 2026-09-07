"use strict";

const fs = require("node:fs");

const path = require("node:path");

const {encryptVault: encryptVault, decryptVault: decryptVault, randomId: randomId, contentHash: contentHash} = require("./crypto");

const providers = require("./providers");

const {defaultDataDir: defaultDataDir} = require("./paths");

const {Keyring: Keyring} = require("./keyring");

const M = require("./model");

const V = require("./validation");

const {privateDir: privateDir, regularFile: regularFile, atomicWrite: atomicWrite} = require("./fs-safe");

const {writeEnv: writeEnv} = require("./env-file");

const {createHash: createHash} = require("node:crypto");

const clone = x => x === null || x === undefined ? x : JSON.parse(JSON.stringify(x));

function expiryInfo(expiresAt) {
    if (!expiresAt) return {
        expiryStatus: "none",
        daysLeft: null
    };
    const ms = Date.parse(expiresAt) - Date.now();
    const daysLeft = Math.ceil(ms / 864e5);
    let expiryStatus = "active";
    if (ms <= 0) expiryStatus = "expired"; else if (daysLeft <= 7) expiryStatus = "expiring";
    return {
        expiryStatus: expiryStatus,
        daysLeft: daysLeft
    };
}

class Store {
    constructor(dataDir = defaultDataDir()) {
        this.dataDir = dataDir;
        this.vaultPath = path.join(dataDir, "vault.enc");
        this.sessionPath = path.join(dataDir, "session.json");
        this.auditPath = path.join(dataDir, "audit.log");
        this.password = null;
        this.vault = null;
        privateDir(dataDir);
        this.diskHash = null;
        this.savedVault = null;
        this.keyring = new Keyring(dataDir);
    }
    exists() {
        return fs.existsSync(this.vaultPath);
    }
    isUnlocked() {
        return this.vault !== null;
    }
    init(password) {
        V.password(password);
        if (this.exists()) throw new Error("vault already exists");
        this.vault = {
            formatVersion: M.FORMAT_VERSION,
            minReaderVersion: M.MIN_READER_VERSION,
            projects: [],
            agents: [],
            tombstones: [],
            history: [],
            settings: {}
        };
        this.password = password;
        this.persist();
        if (this.vault.settings.rememberPassword === true) {
            try {
                this.keyring.set(password);
            } catch {}
        }
    }
    unlock(password) {
        regularFile(this.vaultPath);
        const bytes = fs.readFileSync(this.vaultPath, "utf8");
        const envelope = JSON.parse(bytes);
        const raw = decryptVault(envelope, password);
        M.assertReadable(raw);
        const {vault: vault, migrated: migrated, changed: changed} = M.migrate(raw);
        this.vault = vault;
        this.password = password;
        this.diskHash = createHash("sha256").update(bytes).digest("hex");
        this.savedVault = clone(vault);
        if (this.vault.settings.rememberPassword === true) {
            try {
                this.keyring.set(password);
            } catch {}
        }
        if (migrated) {
            this.record("migrate", {
                actor: M.HUMAN,
                after: {
                    to: M.FORMAT_VERSION,
                    records: changed
                }
            });
            this.persist();
        }
        return {
            migrated: migrated,
            changed: changed
        };
    }
    lock() {
        this.vault = null;
        this.password = null;
        this.savedVault = null;
    }
    changePassword(oldPassword, newPassword, {reencryptBackups: reencryptBackups = true} = {}) {
        V.password(newPassword);
        const envelope = JSON.parse(fs.readFileSync(this.vaultPath, "utf8"));
        let current;
        try {
            current = decryptVault(envelope, oldPassword);
        } catch {
            throw new Error("current password is wrong");
        }
        M.assertReadable(current);
        if (!this.isUnlocked()) this.unlock(oldPassword);
        this.password = newPassword;
        this.persist();
        this.keyring.clear();
        const keyring = this.vault.settings.rememberPassword === true ? this.keyring.set(newPassword) : this.keyring.describe();
        const backups = [];
        const dir = path.join(this.dataDir, "backups");
        if (reencryptBackups && fs.existsSync(dir)) {
            for (const name of fs.readdirSync(dir)) {
                const file = path.join(dir, name);
                if (!fs.statSync(file).isFile()) continue;
                let data;
                try {
                    data = decryptVault(JSON.parse(fs.readFileSync(file, "utf8")), oldPassword);
                } catch {
                    backups.push({
                        file: name,
                        status: "skipped (not readable with the old password)"
                    });
                    continue;
                }
                atomicWrite(file, JSON.stringify(encryptVault(data, newPassword)));
                backups.push({
                    file: name,
                    status: "re-encrypted"
                });
            }
        }
        this.audit("rotate_master_password", `backups re-encrypted: ${backups.filter(b => b.status === "re-encrypted").length}`, M.HUMAN);
        return {
            ok: true,
            keyring: keyring,
            backups: backups
        };
    }
    blockAutoUnlock() {
        atomicWrite(path.join(this.dataDir, "locked"), "Human unlock required");
    }
    allowAutoUnlock() {
        const file = path.join(this.dataDir, "locked");
        regularFile(file, {
            optional: true
        });
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    autoUnlock() {
        if (fs.existsSync(path.join(this.dataDir, "locked"))) return false;
        if (this.isUnlocked()) return true;
        if (!this.exists()) return false;
        const pw = this.keyring.get();
        if (!pw) return false;
        try {
            this.unlock(pw);
            if (this.vault.settings.rememberPassword !== true) {
                this.lock();
                return false;
            }
            return true;
        } catch {
            this.lock();
            return false;
        }
    }
    persist() {
        if (!this.isUnlocked()) throw new Error("vault is locked");
        let releaseWrite;
        try {
            releaseWrite = require("./session").claim(this.dataDir, "write.lock");
            const current = this.exists() ? createHash("sha256").update(fs.readFileSync(this.vaultPath)).digest("hex") : null;
            if (current !== this.diskHash) throw new Error("Vault changed in another process; lock and unlock before retrying");
            const bytes = JSON.stringify(encryptVault(this.vault, this.password));
            atomicWrite(this.vaultPath, bytes);
            this.diskHash = createHash("sha256").update(bytes).digest("hex");
            this.savedVault = clone(this.vault);
        } catch (e) {
            this.vault = clone(this.savedVault);
            throw e;
        } finally {
            if (releaseWrite) releaseWrite();
        }
    }
    contentFingerprint() {
        const records = [];
        for (const p of this.vault.projects || []) {
            for (const s of p.secrets || []) records.push([ p.id, s.key, M.recordHash(s) ]);
        }
        records.sort();
        return contentHash({
            records: records
        });
    }
    fingerprints() {
        const out = [];
        for (const p of this.vault.projects || []) {
            for (const s of p.secrets || []) {
                out.push({
                    project: p.name,
                    projectId: p.id,
                    key: s.key,
                    hash: M.recordHash(s),
                    owner: s.owner,
                    updatedAt: s.updatedAt
                });
            }
        }
        return out.sort((a, b) => (a.project + a.key).localeCompare(b.project + b.key));
    }
    audit(action, detail, actor = M.HUMAN) {
        const clean = v => String(v).replace(/[\r\n\t]/g, " ");
        const line = `${(new Date).toISOString()}\t${clean(actor)}\t${clean(action)}\t${clean(detail)}\n`;
        regularFile(this.auditPath, {
            optional: true
        });
        fs.appendFileSync(this.auditPath, line, {
            mode: 384,
            flag: "a"
        });
        fs.chmodSync(this.auditPath, 384);
    }
    readAudit(limit = 500) {
        try {
            return fs.readFileSync(this.auditPath, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse().map(l => {
                const [ts, actor, action, detail] = l.split("\t");
                return {
                    ts: ts,
                    actor: actor,
                    action: action,
                    detail: detail
                };
            });
        } catch {
            return [];
        }
    }
    record(action, {actor: actor = M.HUMAN, project: project = null, key: key = null, before: before = null, after: after = null, ref: ref = null} = {}) {
        this.vault.history = this.vault.history || [];
        this.vault.history.push({
            id: randomId(),
            ts: (new Date).toISOString(),
            actor: actor,
            action: action,
            project: project,
            key: key,
            before: before,
            after: after,
            ref: ref,
            reverted: false
        });
        if (this.vault.history.length > 2e3) this.vault.history.splice(0, this.vault.history.length - 2e3);
    }
    listHistory(limit = 500) {
        const h = (this.vault.history || []).slice().reverse();
        return (limit ? h.slice(0, limit) : h).map(({before: before, after: after, ...entry}) => entry);
    }
    revert(historyId, actor = M.HUMAN) {
        const h = this.vault.history || [];
        const entry = h.find(e => e.id === historyId);
        if (!entry) throw new Error("history entry not found");
        if (entry.reverted) throw new Error("this change was already undone");
        if (actor !== M.HUMAN) throw new Error("undo is human-only, in the Vault OS app");
        const project = this.findProject(entry.project);
        const current = project && this.findSecret(project, entry.key);
        const refuse = () => {
            throw new Error("This record changed after that operation; undo would overwrite newer work");
        };
        const restore = record => ({
            ...clone(record),
            rev: Math.max(record.rev || 1, current?.rev || 0, entry.after?.rev || 0) + 1,
            updatedAt: (new Date).toISOString(),
            modifiedBy: M.HUMAN
        });
        switch (entry.action) {
          case "create_secret":
            if (!current || M.recordHash(current) !== M.recordHash(entry.after)) refuse();
            project.secrets = project.secrets.filter(s => s.id !== current.id);
            this.tombstone(project.id + ":" + current.id, actor);
            break;

          case "update_secret":
            if (!current || M.recordHash(current) !== M.recordHash(entry.after)) refuse();
            project.secrets[project.secrets.indexOf(current)] = restore(entry.before);
            break;

          case "delete_secret":
            if (!project || current) refuse();
            project.secrets.push(restore(entry.before));
            this.vault.tombstones = this.vault.tombstones.filter(t => t.ref !== project.id + ":" + entry.before.id);
            break;

          case "create_project":
            if (!project || project.id !== entry.after.id || project.secrets.length) refuse();
            this.vault.projects = this.vault.projects.filter(p => p.id !== project.id);
            this.tombstone("project:" + project.id, actor);
            break;

          case "delete_project":
            {
                if (project) refuse();
                const restored = clone(entry.before);
                restored.secrets = restored.secrets.map(restore);
                this.vault.projects.push(restored);
                this.vault.tombstones = this.vault.tombstones.filter(t => t.ref !== "project:" + restored.id && !t.ref.startsWith(restored.id + ":"));
                break;
            }

          case "update_settings":
            throw new Error("Change settings explicitly; security settings cannot be undone through history");

          default:
            throw new Error("This action cannot be undone");
        }
        entry.reverted = true;
        this.record("revert", {
            actor: actor,
            project: entry.project,
            key: entry.key,
            ref: entry.id
        });
        this.persist();
        return {
            ok: true,
            undone: entry.action,
            project: entry.project,
            key: entry.key
        };
    }
    listProjects() {
        return (this.vault.projects || []).map(p => ({
            id: p.id,
            name: p.name,
            secretCount: (p.secrets || []).length,
            agentKeyCount: (p.secrets || []).filter(s => M.isAgent(s.owner)).length,
            pendingCount: (p.secrets || []).filter(s => !s.injectApproved).length,
            providers: [ ...new Set((p.secrets || []).map(s => s.provider).filter(Boolean)) ],
            updatedAt: p.updatedAt || p.createdAt
        }));
    }
    findProject(idOrName) {
        const v = String(idOrName).toLowerCase();
        const ps = this.vault.projects || [];
        return ps.find(p => p.id === idOrName) || ps.find(p => p.name.toLowerCase() === v) || null;
    }
    createProject(name, actor = M.HUMAN) {
        V.text(name, "project name");
        name = name.trim();
        if (this.findProject(name)) throw new Error("Project already exists");
        const now = (new Date).toISOString();
        const p = {
            id: randomId(),
            name: name,
            secrets: [],
            owner: actor,
            createdAt: now,
            updatedAt: now
        };
        this.vault.projects.push(p);
        this.record("create_project", {
            actor: actor,
            project: p.name,
            after: {
                id: p.id,
                name: p.name
            }
        });
        this.persist();
        return {
            id: p.id,
            name: p.name
        };
    }
    deleteProject(idOrName, actor = M.HUMAN) {
        if (actor !== M.HUMAN) throw new Error("deleting a project is human-only, in the Vault OS app");
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        this.vault.projects = this.vault.projects.filter(x => x.id !== p.id);
        for (const s of p.secrets || []) this.tombstone(`${p.id}:${s.id}`, actor, {
            project: p.name,
            key: s.key
        });
        this.tombstone(`project:${p.id}`, actor, {
            project: p.name
        });
        this.record("delete_project", {
            actor: actor,
            project: p.name,
            before: clone(p)
        });
        this.persist();
        return {
            id: p.id,
            name: p.name
        };
    }
    tombstone(ref, actor, label = {}) {
        this.vault.tombstones = this.vault.tombstones || [];
        this.vault.tombstones = this.vault.tombstones.filter(t => t.ref !== ref);
        this.vault.tombstones.push({
            ref: ref,
            deletedAt: (new Date).toISOString(),
            by: actor,
            ...label
        });
    }
    listSecrets(idOrName) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        return (p.secrets || []).map(s => ({
            id: s.id,
            key: s.key,
            provider: s.provider,
            note: s.note || "",
            username: s.username || "",
            email: s.email || "",
            url: s.url || "",
            permission: s.permission || "",
            expiresAt: s.expiresAt || "",
            ...expiryInfo(s.expiresAt),
            owner: s.owner || M.HUMAN,
            createdBy: s.createdBy || M.HUMAN,
            editableBy: s.editableBy || [],
            injectApproved: s.injectApproved !== false,
            hasValue: !!s.value,
            hasPassword: !!s.password,
            updatedAt: s.updatedAt,
            rev: s.rev || 1
        }));
    }
    findSecret(project, keyOrId) {
        return (project.secrets || []).find(x => x.key === keyOrId || x.id === keyOrId) || null;
    }
    setSecret(idOrName, fields, actor = M.HUMAN) {
        V.secret(fields);
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        const now = (new Date).toISOString();
        const existing = this.findSecret(p, fields.key);
        if (existing) {
            const verdict = M.canEdit(existing, actor);
            if (!verdict.ok) {
                const e = new Error(verdict.why);
                e.status = 403;
                throw e;
            }
            const before = clone(existing);
            for (const f of [ "value", "provider", "note", "username", "email", "password", "url", "permission", "expiresAt" ]) {
                if (fields[f] !== undefined) existing[f] = fields[f];
            }
            existing.modifiedBy = actor;
            existing.updatedAt = now;
            existing.rev = (existing.rev || 1) + 1;
            p.updatedAt = now;
            this.record("update_secret", {
                actor: actor,
                project: p.name,
                key: existing.key,
                before: before,
                after: clone(existing)
            });
            this.persist();
            return {
                id: existing.id,
                key: existing.key,
                provider: existing.provider,
                owner: existing.owner,
                injectApproved: existing.injectApproved
            };
        }
        const s = M.newSecret({
            ...fields,
            provider: fields.provider || providers.match(fields.key).id
        }, actor);
        p.secrets.push(s);
        p.updatedAt = now;
        this.vault.tombstones = (this.vault.tombstones || []).filter(t => t.ref !== `${p.id}:${s.id}`);
        this.record("create_secret", {
            actor: actor,
            project: p.name,
            key: s.key,
            after: clone(s)
        });
        this.persist();
        return {
            id: s.id,
            key: s.key,
            provider: s.provider,
            owner: s.owner,
            injectApproved: s.injectApproved
        };
    }
    deleteSecret(idOrName, keyOrId, actor = M.HUMAN) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        const s = this.findSecret(p, keyOrId);
        if (!s) throw new Error("secret not found");
        const verdict = M.canDelete(s, actor);
        if (!verdict.ok) {
            const e = new Error(verdict.why);
            e.status = 403;
            throw e;
        }
        p.secrets = p.secrets.filter(x => x.id !== s.id);
        p.updatedAt = (new Date).toISOString();
        this.tombstone(`${p.id}:${s.id}`, actor, {
            project: p.name,
            key: s.key
        });
        this.record("delete_secret", {
            actor: actor,
            project: p.name,
            key: s.key,
            before: clone(s)
        });
        this.persist();
        return {
            ok: true,
            key: s.key
        };
    }
    delegate(idOrName, keyOrId, agentRef, on = true) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        const s = this.findSecret(p, keyOrId);
        if (!s) throw new Error("secret not found");
        const before = clone(s);
        s.editableBy = s.editableBy || [];
        if (on && !s.editableBy.includes(agentRef)) s.editableBy.push(agentRef);
        if (!on) s.editableBy = s.editableBy.filter(a => a !== agentRef);
        s.updatedAt = (new Date).toISOString();
        s.rev = (s.rev || 1) + 1;
        this.record("update_secret", {
            actor: M.HUMAN,
            project: p.name,
            key: s.key,
            before: before,
            after: clone(s)
        });
        this.persist();
        return {
            key: s.key,
            editableBy: s.editableBy
        };
    }
    moveSecret(fromProject, keyOrId, toProject, actor = M.HUMAN) {
        if (actor !== M.HUMAN) throw new Error("moving a key between projects is human-only");
        const src = this.findProject(fromProject);
        if (!src) throw new Error(`project not found: ${fromProject}`);
        const dst = this.findProject(toProject);
        if (!dst) throw new Error(`project not found: ${toProject}`);
        if (src.id === dst.id) return {
            moved: false,
            why: "already there"
        };
        const s = this.findSecret(src, keyOrId);
        if (!s) throw new Error(`secret not found: ${keyOrId}`);
        if (this.findSecret(dst, s.key)) {
            throw new Error(`"${s.key}" already exists in "${dst.name}" — resolve the collision first`);
        }
        const before = clone(s);
        src.secrets = src.secrets.filter(x => x.id !== s.id);
        this.tombstone(`${src.id}:${s.id}`, actor, {
            project: src.name,
            key: s.key,
            movedTo: dst.name
        });
        s.updatedAt = (new Date).toISOString();
        s.rev = (s.rev || 1) + 1;
        dst.secrets.push(s);
        src.updatedAt = dst.updatedAt = s.updatedAt;
        this.record("move_secret", {
            actor: actor,
            project: dst.name,
            key: s.key,
            before: before,
            after: clone(s),
            ref: src.name
        });
        this.persist();
        return {
            moved: true,
            key: s.key,
            from: src.name,
            to: dst.name
        };
    }
    adopt(idOrName, keyOrId) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        const s = this.findSecret(p, keyOrId);
        if (!s) throw new Error("secret not found");
        const before = clone(s);
        s.owner = M.HUMAN;
        s.editableBy = [];
        s.injectApproved = true;
        s.updatedAt = (new Date).toISOString();
        s.rev = (s.rev || 1) + 1;
        this.record("update_secret", {
            actor: M.HUMAN,
            project: p.name,
            key: s.key,
            before: before,
            after: clone(s)
        });
        this.persist();
        return {
            key: s.key,
            owner: s.owner
        };
    }
    approveInject(idOrName, keyOrId, approved = true) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        const s = this.findSecret(p, keyOrId);
        if (!s) throw new Error("secret not found");
        const before = clone(s);
        s.injectApproved = !!approved;
        s.updatedAt = (new Date).toISOString();
        s.rev = (s.rev || 1) + 1;
        this.record("update_secret", {
            actor: M.HUMAN,
            project: p.name,
            key: s.key,
            before: before,
            after: clone(s)
        });
        this.persist();
        return {
            key: s.key,
            injectApproved: s.injectApproved
        };
    }
    pendingApprovals() {
        const out = [];
        for (const p of this.vault.projects || []) {
            for (const s of p.secrets || []) {
                if (s.injectApproved === false) out.push({
                    project: p.name,
                    key: s.key,
                    owner: s.owner,
                    createdAt: s.createdAt
                });
            }
        }
        return out;
    }
    revealSecret(idOrName, key, actor = M.HUMAN) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        const s = this.findSecret(p, key);
        if (!s) throw new Error("secret not found");
        this.audit("reveal", `${p.name}/${s.key}`, actor);
        return {
            key: s.key,
            value: s.value,
            provider: s.provider,
            username: s.username || "",
            email: s.email || "",
            password: s.password || "",
            url: s.url || ""
        };
    }
    getSettings() {
        this.vault.settings = this.vault.settings || {};
        return {
            hasExportPassword: !!this.vault.settings.exportPassword,
            rememberPassword: this.vault.settings.rememberPassword === true,
            keyring: this.keyring.describe(),
            formatVersion: this.vault.formatVersion
        };
    }
    setSettings(patch, actor = M.HUMAN) {
        if (actor !== M.HUMAN) throw new Error("Settings are human-only");
        V.object(patch);
        if (Object.keys(patch).some(k => ![ "exportPassword", "rememberPassword" ].includes(k))) throw new Error("Unknown setting");
        if (patch.exportPassword !== undefined && patch.exportPassword !== "") V.password(patch.exportPassword);
        if (patch.rememberPassword !== undefined && typeof patch.rememberPassword !== "boolean") throw new Error("Invalid remember setting");
        if (patch.rememberPassword === true) this.keyring.set(this.password);
        if (patch.rememberPassword === false) this.keyring.clear();
        const before = clone(this.vault.settings || {});
        this.vault.settings = {
            ...this.vault.settings || {},
            ...patch
        };
        this.record("update_settings", {
            actor: actor,
            before: before,
            after: clone(this.vault.settings)
        });
        this.persist();
        return this.getSettings();
    }
    exportData(idOrName) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        this.audit("export", p.name, M.HUMAN);
        return {
            project: p.name,
            entries: (p.secrets || []).map(s => ({
                key: s.key,
                value: s.value || "",
                provider: s.provider,
                note: s.note || "",
                username: s.username || "",
                email: s.email || "",
                password: s.password || "",
                url: s.url || "",
                permission: s.permission || "",
                expiresAt: s.expiresAt || "",
                owner: s.owner || M.HUMAN
            }))
        };
    }
    inject(idOrName, targetPath, format = "dotenv", {merge: merge = true, keys: keys = null, actor: actor = M.HUMAN} = {}) {
        const p = this.findProject(idOrName);
        if (!p) throw new Error("project not found");
        if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) throw new Error("target_path must be absolute");
        const canonical = path.resolve(targetPath);
        if (canonical === this.dataDir || canonical.startsWith(this.dataDir + path.sep)) throw new Error("Cannot export over vault data");
        let secrets = (p.secrets || []).filter(s => s.value);
        const held = secrets.filter(s => s.injectApproved === false).map(s => s.key);
        secrets = secrets.filter(s => s.injectApproved !== false);
        if (Array.isArray(keys)) {
            const want = new Set(keys);
            secrets = secrets.filter(s => want.has(s.key));
        }
        const pairs = secrets.map(s => [ s.key, s.value ]);
        this.audit("inject", `${p.name} -> ${targetPath} (${pairs.length} keys, ${format})`, actor);
        writeEnv(targetPath, pairs, format, merge);
        return {
            project: p.name,
            target: targetPath,
            count: pairs.length,
            format: format,
            heldForApproval: held
        };
    }
    search(q) {
        const v = String(q || "").toLowerCase();
        const out = [];
        for (const p of this.vault.projects || []) {
            if (p.name.toLowerCase().includes(v)) out.push({
                type: "project",
                project: p.name
            });
            for (const s of p.secrets || []) {
                if (s.key.toLowerCase().includes(v) || (s.provider || "").toLowerCase().includes(v)) {
                    out.push({
                        type: "secret",
                        project: p.name,
                        key: s.key,
                        provider: s.provider,
                        owner: s.owner
                    });
                }
            }
        }
        return out;
    }
    importEnv(idOrName, envPath, actor = M.HUMAN) {
        if (!path.isAbsolute(envPath)) throw new Error("env_path must be absolute");
        let p = this.findProject(idOrName);
        if (!p) {
            this.createProject(idOrName, actor);
            p = this.findProject(idOrName);
        }
        regularFile(envPath, {
            maxBytes: 1024 * 1024
        });
        const parsed = require("dotenv").parse(fs.readFileSync(envPath, "utf8"));
        const keys = [], refused = [];
        for (const [key, value] of Object.entries(parsed)) {
            try {
                this.setSecret(p.name, {
                    key: key,
                    value: value
                }, actor);
                keys.push(key);
            } catch (e) {
                refused.push({
                    key: key,
                    why: e.message
                });
            }
        }
        this.audit("import", `${envPath} -> ${p.name} (${keys.length} keys)`, actor);
        return {
            project: p.name,
            count: keys.length,
            keys: keys,
            refused: refused
        };
    }
    writeSession(port, token) {
        atomicWrite(this.sessionPath, JSON.stringify({
            app: "VaultOS-Preview",
            port: port,
            token: token,
            pid: process.pid
        }));
    }
    clearSession() {
        try {
            const s = JSON.parse(fs.readFileSync(this.sessionPath, "utf8"));
            if (s.pid === process.pid) fs.unlinkSync(this.sessionPath);
        } catch {}
    }
}

module.exports = {
    Store: Store,
    defaultDataDir: defaultDataDir
};
