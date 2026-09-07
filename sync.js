"use strict";

const fs = require("node:fs");

const path = require("node:path");

const {execFileSync: execFileSync} = require("node:child_process");

const crypto = require("node:crypto");

const {contentHash: contentHash, canonicalJson: canonicalJson, newSigningKey: newSigningKey, sign: sign, verify: verify, publicKeyOf: publicKeyOf, randomId: randomId} = require("./crypto");

const M = require("./model");

const {GitRepo: GitRepo} = require("./git");

const {atomicWrite: atomicWrite, regularFile: regularFile} = require("./fs-safe");

const opaque = ref => crypto.createHash("sha256").update(ref, "utf8").digest("hex");

class Sync {
    constructor(store, repoDir) {
        this.store = store;
        this.repo = repoDir;
        this.dirs = {
            records: path.join(repoDir, "records"),
            tombstones: path.join(repoDir, "tombstones"),
            machines: path.join(repoDir, "machines"),
            manifests: path.join(repoDir, "manifests"),
            peers: path.join(repoDir, "peers")
        };
        this.recipientsPath = path.join(repoDir, "recipients.txt");
        this.identityPath = path.join(store.dataDir, "sync-age.key");
        this.signingKeyPath = path.join(store.dataDir, "sync-signing.key");
        this.machineIdPath = path.join(store.dataDir, "machine-id");
        this.indexPath = path.join(store.dataDir, "sync-index.json");
        this.git = new GitRepo(repoDir);
    }
    receipt(extra = {}) {
        const div = this.git.isRepo() ? this.git.divergence() : {
            ok: false
        };
        const d = this.git.isRepo() ? this.git.dirty() : {
            ok: false
        };
        return {
            sourceFingerprint: this.store.contentFingerprint(),
            manifestCounter: (this.readIndex().lastPush || {}).counter || 0,
            machineId: this.machineId(),
            sourceCommit: this.git.isRepo() ? this.git.head() : null,
            remoteCommit: this.git.isRepo() ? this.git.remoteHead() : null,
            ahead: div.ok ? div.ahead : null,
            behind: div.ok ? div.behind : null,
            uncommitted: d.ok ? d.files.length : null,
            ...extra
        };
    }
    pushRemote({message: message} = {}) {
        const wrote = this.push();
        if (!this.git.isRepo()) {
            return {
                ...wrote,
                transport: "none",
                delivered: false,
                warning: `${this.repo} is not a git repo, so nothing left this machine`,
                receipt: this.receipt()
            };
        }
        const msg = message || `vault sync: ${wrote.written} record(s) from ${this.machineId()}`;
        const dirty = this.git.dirty();
        if (!dirty.ok || dirty.files.some(f => !/^(?:recipients\.txt|vaultos-sync\.json|(?:records|tombstones|machines|manifests|peers)\/)/.test(f.slice(3).replace(/^"|"$/g, "")))) throw new Error("Sync repository contains unrelated changes; refusing to commit");
        const commit = this.git.commitPaths([ "records", "tombstones", "machines", "manifests", "recipients.txt", "vaultos-sync.json" ], msg);
        this.publishHeartbeat();
        const heartbeatCommit = this.git.commitPaths([ "peers" ], `heartbeat: ${this.machineId()}`);
        if (!heartbeatCommit.ok) throw new Error("Could not commit the sync receipt");
        if (!commit.ok) {
            return {
                ...wrote,
                transport: "commit-failed",
                delivered: false,
                error: commit.error,
                receipt: this.receipt()
            };
        }
        const pushed = this.git.push();
        if (!pushed.ok) {
            return {
                ...wrote,
                transport: "push-failed",
                delivered: false,
                code: pushed.code,
                error: pushed.error,
                committed: commit.committed,
                sourceCommit: commit.sha,
                receipt: this.receipt()
            };
        }
        const finalSha = this.git.head();
        return {
            ...wrote,
            transport: "ok",
            delivered: true,
            committed: commit.committed,
            sourceCommit: finalSha,
            remoteCommit: pushed.remoteSha,
            rebased: finalSha !== commit.sha,
            receipt: this.receipt({
                sourceCommit: finalSha,
                remoteCommit: pushed.remoteSha
            })
        };
    }
    pullRemote(options = {}) {
        if (!this.git.isRepo()) {
            const merged = this.pull(options);
            return {
                ...merged,
                transport: "none",
                warning: `${this.repo} is not a git repo; merged only what was already local`
            };
        }
        const ff = this.git.pullFF();
        if (!ff.ok) {
            const e = new Error(`cannot update the sync repo: ${ff.error}`);
            e.code = ff.code || "REMOTE_UNREACHABLE";
            e.status = 409;
            throw e;
        }
        const merged = this.pull(options);
        return {
            ...merged,
            transport: "ok",
            fetched: ff.changed,
            receipt: this.receipt()
        };
    }
    statusRemote() {
        const base = this.status();
        if (!this.git.isRepo()) {
            return {
                ...base,
                state: "NO_GIT_REPO",
                remoteReachable: false,
                detail: `${this.repo} is not a git repo; records go nowhere`
            };
        }
        const f = this.git.fetch();
        const d = this.git.dirty();
        const div = f.ok ? this.git.divergence() : {
            ok: false
        };
        const out = {
            ...base,
            remoteReachable: f.ok,
            remote: this.git.remoteName(),
            sourceCommit: this.git.head(),
            remoteCommit: f.ok ? this.git.remoteHead() : null,
            ahead: div.ok ? div.ahead : null,
            behind: div.ok ? div.behind : null,
            uncommittedFiles: d.ok ? d.files : []
        };
        if (!f.ok) return {
            ...out,
            state: "REMOTE_UNREACHABLE",
            detail: f.error
        };
        if (d.ok && d.dirty) return {
            ...out,
            state: "LOCAL_SYNC_REPO_DIRTY",
            detail: `${d.files.length} record file(s) written but never committed, so they have not left this machine`
        };
        if (div.ok && div.ahead > 0 && div.behind > 0) return {
            ...out,
            state: "GIT_HISTORY_DIVERGED"
        };
        if (div.ok && div.ahead > 0) return {
            ...out,
            state: "UNPUSHED_COMMITS"
        };
        if (div.ok && div.behind > 0) return {
            ...out,
            state: "BEHIND_REMOTE"
        };
        if (base.error) return {
            ...out,
            state: "SIGNATURE_INVALID",
            detail: base.error
        };
        if (base.unreadable && base.unreadable.length) {
            return {
                ...out,
                state: "UNREADABLE_RECORDS",
                detail: `${base.unreadable.length} file(s) in the sync repo will not decrypt: ${base.unreadable.slice(0, 3).map(u => u.file).join(", ")}`
            };
        }
        const peers = this.readPeers();
        const peerIssues = this.peerProblems();
        const drift = base.outgoing + (base.incoming ? base.incoming.added + base.incoming.updated + base.incoming.deleted : 0);
        if (drift !== 0) return {
            ...out,
            peers: peers,
            state: "RECORDS_OUT_OF_SYNC"
        };
        if (peerIssues.length) return {
            ...out,
            peers: peers,
            state: "PEER_STALLED",
            detail: peerIssues.join("; ")
        };
        return {
            ...out,
            peers: peers,
            state: "IN_SYNC"
        };
    }
    age(args, input) {
        return execFileSync("age", args, {
            input: input,
            encoding: null,
            maxBuffer: 64 * 1024 * 1024,
            stdio: [ "pipe", "pipe", "pipe" ],
            timeout: 15e3
        });
    }
    requireAge() {
        try {
            execFileSync("age", [ "--version" ], {
                stdio: "ignore"
            });
        } catch {
            throw new Error("age is not installed. Install age for optional sync; see docs/SYNC.md.");
        }
    }
    machineId() {
        try {
            return fs.readFileSync(this.machineIdPath, "utf8").trim();
        } catch {}
        const id = randomId();
        atomicWrite(this.machineIdPath, id);
        return id;
    }
    signingKey() {
        try {
            return fs.readFileSync(this.signingKeyPath, "utf8");
        } catch {}
        const {privateKey: privateKey} = newSigningKey();
        atomicWrite(this.signingKeyPath, privateKey);
        return privateKey;
    }
    readIndex() {
        regularFile(this.indexPath, {
            optional: true
        });
        if (!fs.existsSync(this.indexPath)) return {
            records: {},
            tombstones: {},
            lastPush: null,
            seenManifests: {}
        };
        const idx = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
        if (!idx || typeof idx.records !== "object" || typeof idx.tombstones !== "object") throw new Error("Invalid sync index; restore a trusted backup");
        return idx;
    }
    writeIndex(idx) {
        atomicWrite(this.indexPath, JSON.stringify(idx, null, 2));
    }
    ensureDirs() {
        const marker = path.join(this.repo, "vaultos-sync.json");
        if (!fs.existsSync(marker)) {
            if (fs.existsSync(this.repo) && fs.readdirSync(this.repo).some(x => x !== ".git")) throw new Error("Use a new, empty repository for preview sync");
            fs.mkdirSync(this.repo, {
                recursive: true,
                mode: 448
            });
            atomicWrite(marker, JSON.stringify({
                app: "VaultOS-Preview",
                version: 1
            }));
        }
        regularFile(marker, {
            maxBytes: 1024
        });
        if (JSON.parse(fs.readFileSync(marker)).app !== "VaultOS-Preview") throw new Error("Not a preview sync repository");
        for (const d of Object.values(this.dirs)) {
            fs.mkdirSync(d, {
                recursive: true,
                mode: 448
            });
            if (fs.lstatSync(d).isSymbolicLink()) throw new Error("Sync directories cannot be symbolic links");
        }
    }
    encryptTo(obj) {
        this.verifyRecipients();
        if (!fs.existsSync(this.recipientsPath)) throw new Error("no recipients.txt. Run: vault-sync init");
        return this.age([ "-R", this.recipientsPath, "-o", "-" ], Buffer.from(canonicalJson(obj), "utf8"));
    }
    decryptFile(file) {
        if (!fs.existsSync(this.identityPath)) throw new Error(`no age identity at ${this.identityPath}`);
        const out = this.age([ "-d", "-i", this.identityPath, file ]);
        return JSON.parse(out.toString("utf8"));
    }
    tryDecrypt(file) {
        try {
            return {
                ok: true,
                payload: this.decryptFile(file)
            };
        } catch (e) {
            return {
                ok: false,
                error: String(e.message || e).split("\n")[0]
            };
        }
    }
    init(label) {
        require("./validation").text(label, "machine label", 100);
        if (/[\r\n]/.test(label)) throw new Error("Invalid machine label");
        this.requireAge();
        this.ensureDirs();
        if (!fs.existsSync(this.identityPath)) {
            const out = execFileSync("age-keygen", [], {
                encoding: "utf8",
                stdio: [ "ignore", "pipe", "pipe" ]
            });
            atomicWrite(this.identityPath, out);
        }
        const pub = execFileSync("age-keygen", [ "-y", this.identityPath ], {
            encoding: "utf8"
        }).trim();
        regularFile(this.recipientsPath, {
            optional: true
        });
        let recipients = fs.existsSync(this.recipientsPath) ? fs.readFileSync(this.recipientsPath, "utf8") : "";
        if (!recipients.split("\n").some(l => l.trim() === pub)) {
            atomicWrite(this.recipientsPath, recipients + `# ${label}\n${pub}\n`);
        }
        const id = this.machineId();
        const signingPub = publicKeyOf(this.signingKey());
        atomicWrite(path.join(this.dirs.machines, `${id}.json`), JSON.stringify({
            id: id,
            label: label,
            signingPublicKey: signingPub,
            agePublicKey: pub,
            enrolledAt: (new Date).toISOString()
        }, null, 2));
        const identity = {
            id: id,
            label: label,
            signingPublicKey: signingPub,
            agePublicKey: pub
        };
        this.trustMachine(identity);
        return identity;
    }
    localRecords() {
        const out = new Map;
        for (const p of this.store.vault.projects || []) {
            for (const s of p.secrets || []) {
                const ref = `${p.id}:${s.id}`;
                out.set(ref, {
                    ref: ref,
                    projectId: p.id,
                    projectName: p.name,
                    record: M.pickRecord(s),
                    hash: M.recordHash(s)
                });
            }
        }
        return out;
    }
    localTombstones() {
        const out = new Map;
        for (const t of this.store.vault.tombstones || []) out.set(t.ref, t);
        return out;
    }
    push() {
        this.requireAge();
        this.ensureDirs();
        const validation = this.verifyManifests();
        if (validation.problems.length) throw new Error(validation.problems.join("; "));
        const idx = this.readIndex();
        const local = this.localRecords();
        const tombs = this.localTombstones();
        const recipientsHash = (() => {
            try {
                return contentHash(fs.readFileSync(this.recipientsPath, "utf8"));
            } catch {
                return null;
            }
        })();
        const recipientsChanged = recipientsHash && idx.recipientsHash && idx.recipientsHash !== recipientsHash;
        if (recipientsChanged) idx.records = {};
        let written = 0, unchanged = 0, removed = 0;
        for (const [ref, entry] of local) {
            const file = path.join(this.dirs.records, `${opaque(ref)}.age`);
            if (idx.records[ref] === entry.hash && fs.existsSync(file)) {
                unchanged++;
                continue;
            }
            const payload = {
                ref: ref,
                projectId: entry.projectId,
                projectName: entry.projectName,
                record: entry.record,
                hash: entry.hash,
                pushedBy: this.machineId(),
                pushedAt: (new Date).toISOString()
            };
            atomicWrite(file, this.encryptTo(payload));
            idx.records[ref] = entry.hash;
            written++;
        }
        for (const ref of Object.keys(idx.records)) {
            if (local.has(ref)) continue;
            const file = path.join(this.dirs.records, `${opaque(ref)}.age`);
            try {
                fs.unlinkSync(file);
            } catch {}
            delete idx.records[ref];
            removed++;
        }
        if (recipientsChanged) idx.tombstones = {};
        for (const [ref, t] of tombs) {
            const file = path.join(this.dirs.tombstones, `${opaque(ref)}.age`);
            if (idx.tombstones[ref] === t.deletedAt && fs.existsSync(file)) continue;
            atomicWrite(file, this.encryptTo({
                ref: ref,
                deletedAt: t.deletedAt,
                by: t.by
            }));
            idx.tombstones[ref] = t.deletedAt;
        }
        const id = this.machineId();
        const prev = idx.lastPush ? idx.lastPush.counter || 0 : 0;
        const manifest = {
            machineId: id,
            counter: prev + 1,
            pushedAt: (new Date).toISOString(),
            fingerprint: this.store.contentFingerprint(),
            recordCount: local.size,
            records: Object.fromEntries([ ...local ].map(([r, e]) => [ r, e.hash ])),
            files: Object.fromEntries([ "records", "tombstones" ].flatMap(dir => fs.readdirSync(this.dirs[dir]).filter(f => f.endsWith(".age")).map(f => {
                const rel = dir + "/" + f;
                regularFile(path.join(this.repo, rel));
                return [ rel, crypto.createHash("sha256").update(fs.readFileSync(path.join(this.repo, rel))).digest("hex") ];
            })))
        };
        const signed = {
            manifest: manifest,
            signature: sign(this.signingKey(), manifest)
        };
        atomicWrite(path.join(this.dirs.manifests, `${id}.json`), JSON.stringify(signed, null, 2));
        idx.lastPush = {
            counter: manifest.counter,
            at: manifest.pushedAt,
            fingerprint: manifest.fingerprint
        };
        idx.recipientsHash = recipientsHash;
        this.writeIndex(idx);
        return {
            written: written,
            unchanged: unchanged,
            removed: removed,
            fingerprint: manifest.fingerprint,
            counter: manifest.counter,
            reencryptedForNewRecipients: !!recipientsChanged
        };
    }
    trustMachine(identity) {
        if (!identity || !/^[a-f0-9]{16}$/.test(identity.id) || !/^age1[a-z0-9]+$/.test(identity.agePublicKey)) throw new Error("Invalid peer identity");
        require("./validation").text(identity.label, "machine label", 100);
        if (crypto.createPublicKey(identity.signingPublicKey).asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519 signing key");
        const trusted = this.store.vault.syncTrust || {};
        const current = trusted[identity.id];
        if (current && (current.signingPublicKey !== identity.signingPublicKey || current.agePublicKey !== identity.agePublicKey)) throw new Error("Peer key changed; remove trust explicitly before replacing it");
        trusted[identity.id] = {
            id: identity.id,
            label: identity.label,
            signingPublicKey: identity.signingPublicKey,
            agePublicKey: identity.agePublicKey
        };
        this.store.vault.syncTrust = trusted;
        this.store.persist();
        return {
            id: identity.id,
            fingerprint: contentHash(trusted[identity.id])
        };
    }
    identity() {
        const id = this.machineId();
        const peer = (this.store.vault.syncTrust || {})[id];
        if (!peer) throw new Error("Initialize this machine first");
        return {
            ...peer,
            fingerprint: contentHash(peer)
        };
    }
    verifyRecipients() {
        const approved = new Set(Object.values(this.store.vault.syncTrust || {}).map(x => x.agePublicKey));
        const recipients = fs.readFileSync(this.recipientsPath, "utf8").split("\n").map(x => x.trim()).filter(x => x && !x.startsWith("#"));
        if (!recipients.length || recipients.some(x => !approved.has(x))) throw new Error("Unapproved encryption recipient; verify and trust the peer first");
    }
    verifyManifests() {
        const idx = this.readIndex(), problems = [], accepted = [];
        const trusted = this.store.vault.syncTrust || {};
        const present = new Set;
        for (const file of fs.existsSync(this.dirs.manifests) ? fs.readdirSync(this.dirs.manifests) : []) {
            if (!/^[a-f0-9]{16}\.json$/.test(file)) {
                problems.push("Invalid manifest filename");
                continue;
            }
            try {
                regularFile(path.join(this.dirs.manifests, file), {
                    maxBytes: 16 * 1024 * 1024
                });
                const signed = JSON.parse(fs.readFileSync(path.join(this.dirs.manifests, file), "utf8"));
                const m = signed.manifest, id = m?.machineId;
                present.add(id);
                if (file !== id + ".json" || !trusted[id]) {
                    problems.push("Untrusted sync machine");
                    continue;
                }
                if (!verify(trusted[id].signingPublicKey, m, signed.signature)) {
                    problems.push("BAD SIGNATURE");
                    continue;
                }
                if (!Number.isSafeInteger(m.counter) || m.counter < 1 || !m.files) {
                    problems.push("Unsupported manifest");
                    continue;
                }
                const hash = contentHash(m), seen = idx.seenManifests[id];
                if (seen && (m.counter < seen.counter || m.counter === seen.counter && seen.hash && seen.hash !== hash)) {
                    problems.push("ROLLBACK or manifest equivocation");
                    continue;
                }
                for (const [name, digest] of Object.entries(m.files)) if (!/^(records|tombstones)\/[a-f0-9]{64}\.age$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid manifest path");
                accepted.push({
                    id: id,
                    m: m,
                    hash: hash
                });
            } catch {
                problems.push("Invalid manifest");
            }
        }
        for (const id of Object.keys(idx.seenManifests)) if (!present.has(id)) problems.push("Previously seen manifest is missing");
        const signatures = new Map;
        for (const {m: m} of accepted) for (const [name, hash] of Object.entries(m.files)) {
            if (!signatures.has(name)) signatures.set(name, new Set);
            signatures.get(name).add(hash);
        }
        for (const dir of [ "records", "tombstones" ]) for (const file of fs.existsSync(this.dirs[dir]) ? fs.readdirSync(this.dirs[dir]) : []) {
            const rel = dir + "/" + file;
            try {
                regularFile(path.join(this.repo, rel));
                const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(this.repo, rel))).digest("hex");
                if (!signatures.get(rel)?.has(hash)) problems.push("Unsigned or modified ciphertext");
            } catch {
                problems.push("Invalid sync file");
            }
        }
        for (const name of signatures.keys()) if (!fs.existsSync(path.join(this.repo, name))) {
            const tomb = "tombstones/" + path.basename(name);
            if (!name.startsWith("records/") || !fs.existsSync(path.join(this.repo, tomb))) problems.push("Signed ciphertext is missing");
        }
        if (!problems.length) {
            for (const {id: id, m: m, hash: hash} of accepted) idx.seenManifests[id] = {
                counter: m.counter,
                hash: hash,
                at: m.pushedAt
            };
            this.writeIndex(idx);
        }
        return {
            checked: accepted.length,
            problems: problems
        };
    }
    pull({apply: apply = true} = {}) {
        this.requireAge();
        this.ensureDirs();
        const ver = this.verifyManifests();
        if (ver.problems.length) {
            const e = new Error(`refusing to pull:\n  ${ver.problems.join("\n  ")}`);
            e.status = 409;
            throw e;
        }
        const remote = new Map;
        const unreadable = [];
        for (const f of fs.readdirSync(this.dirs.records)) {
            if (!f.endsWith(".age")) continue;
            const r = this.tryDecrypt(path.join(this.dirs.records, f));
            if (!r.ok) {
                unreadable.push({
                    file: `records/${f}`,
                    error: r.error
                });
                continue;
            }
            const payload = r.payload;
            if (!payload || f !== opaque(payload.ref) + ".age" || payload.ref !== payload.projectId + ":" + payload.record?.id || M.recordHash(payload.record) !== payload.hash) throw new Error("Invalid record binding");
            require("./validation").secret(payload.record);
            remote.set(payload.ref, payload);
        }
        const remoteTombs = new Map;
        for (const f of fs.existsSync(this.dirs.tombstones) ? fs.readdirSync(this.dirs.tombstones) : []) {
            if (!f.endsWith(".age")) continue;
            const r = this.tryDecrypt(path.join(this.dirs.tombstones, f));
            if (!r.ok) {
                unreadable.push({
                    file: `tombstones/${f}`,
                    error: r.error
                });
                continue;
            }
            if (!r.payload || f !== opaque(r.payload.ref) + ".age" || !Number.isFinite(Date.parse(r.payload.deletedAt))) throw new Error("Invalid tombstone binding");
            remoteTombs.set(r.payload.ref, r.payload);
        }
        const local = this.localRecords();
        const plan = {
            added: [],
            updated: [],
            deleted: [],
            conflicts: [],
            unchanged: 0,
            unreadable: unreadable
        };
        for (const [ref, rp] of remote) {
            const tomb = remoteTombs.get(ref);
            const lo = local.get(ref);
            if (!lo) {
                const localTomb = this.localTombstones().get(ref);
                if (localTomb && Date.parse(localTomb.deletedAt) > Date.parse(rp.pushedAt)) continue;
                plan.added.push(rp);
                continue;
            }
            if (lo.hash === rp.hash) {
                plan.unchanged++;
                continue;
            }
            if (tomb && Date.parse(tomb.deletedAt) > Date.parse(lo.record.updatedAt || 0)) {
                plan.deleted.push(ref);
                continue;
            }
            const lrev = lo.record.rev || 1, rrev = rp.record.rev || 1;
            const lts = Date.parse(lo.record.updatedAt || 0), rts = Date.parse(rp.record.updatedAt || 0);
            const remoteWins = rrev > lrev || rrev === lrev && rts > lts;
            plan.conflicts.push({
                ref: ref,
                key: lo.record.key,
                project: lo.projectName,
                localRev: lrev,
                remoteRev: rrev,
                localUpdatedAt: lo.record.updatedAt,
                remoteUpdatedAt: rp.record.updatedAt,
                resolution: remoteWins ? "remote" : "local"
            });
            if (remoteWins) plan.updated.push(rp);
        }
        for (const [ref, t] of remoteTombs) {
            const lo = local.get(ref);
            if (!lo) continue;
            if (plan.deleted.includes(ref)) continue;
            if (Date.parse(t.deletedAt) > Date.parse(lo.record.updatedAt || 0)) plan.deleted.push(ref);
        }
        plan.deletedProjects = [];
        const projectTombs = [ ...remoteTombs.keys() ].filter(r => r.startsWith("project:")).map(r => r.slice("project:".length));
        if (apply && plan.conflicts.length && !arguments[0]?.acceptConflicts) throw new Error("Concurrent edits detected. Back up both vaults and review the conflict plan before accepting its revisions");
        if (apply && unreadable.length) {
            const e = new Error(`${unreadable.length} record file(s) in the sync repo could not be decrypted: ` + unreadable.slice(0, 3).map(u => u.file).join(", "));
            e.code = "UNREADABLE_RECORDS";
            e.status = 409;
            throw e;
        }
        if (!apply) {
            for (const pid of projectTombs) {
                const proj = (this.store.vault.projects || []).find(x => x.id === pid);
                if (!proj) continue;
                const live = (proj.secrets || []).filter(s2 => !plan.deleted.includes(`${pid}:${s2.id}`));
                if (live.length === 0) plan.deletedProjects.push({
                    id: pid,
                    name: proj.name
                });
            }
            return plan;
        }
        if (plan.added.length || plan.updated.length || plan.deleted.length || plan.deletedProjects.length) {
            const backupDir = path.join(this.store.dataDir, "backups");
            fs.mkdirSync(backupDir, {
                recursive: true,
                mode: 448
            });
            atomicWrite(path.join(backupDir, Date.now() + "-" + randomId() + ".enc"), fs.readFileSync(this.store.vaultPath));
        }
        const rollback = JSON.parse(JSON.stringify(this.store.vault));
        try {
            for (const rp of [ ...plan.added, ...plan.updated ]) this.applyRecord(rp);
            for (const ref of plan.deleted) {
                this.removeRecord(ref);
                const t = remoteTombs.get(ref);
                this.store.tombstone(ref, t ? t.by : "sync", {
                    via: "pull"
                });
            }
            for (const pid of projectTombs) {
                const proj = (this.store.vault.projects || []).find(x => x.id === pid);
                if (!proj || (proj.secrets || []).length !== 0) continue;
                this.store.vault.projects = (this.store.vault.projects || []).filter(x => x.id !== pid);
                this.store.tombstone(`project:${pid}`, "sync", {
                    project: proj.name,
                    via: "pull"
                });
                plan.deletedProjects.push({
                    id: pid,
                    name: proj.name
                });
            }
            if (plan.added.length || plan.updated.length || plan.deleted.length || plan.deletedProjects.length) this.store.persist();
        } catch (e) {
            this.store.vault = rollback;
            throw e;
        }
        const idx = this.readIndex();
        for (const [ref, e] of this.localRecords()) idx.records[ref] = e.hash;
        for (const ref of plan.deleted) delete idx.records[ref];
        this.writeIndex(idx);
        return plan;
    }
    applyRecord(payload) {
        const v = this.store.vault;
        let project = (v.projects || []).find(p => p.id === payload.projectId);
        if (!project) {
            if (v.projects.some(p => p.name.toLowerCase() === payload.projectName.toLowerCase())) throw new Error("Project name collision; resolve it before merging");
            project = {
                id: payload.projectId,
                name: payload.projectName,
                secrets: [],
                owner: M.HUMAN,
                createdAt: (new Date).toISOString(),
                updatedAt: (new Date).toISOString()
            };
            v.projects.push(project);
        }
        const i = (project.secrets || []).findIndex(s => s.id === payload.record.id);
        if (i === -1) {
            if (project.secrets.some(s => s.key === payload.record.key)) throw new Error("Secret name collision; resolve it before merging");
            project.secrets.push({
                ...payload.record
            });
        } else project.secrets[i] = {
            ...payload.record
        };
        project.updatedAt = (new Date).toISOString();
    }
    removeRecord(ref) {
        const [projectId, recordId] = ref.split(":");
        const project = (this.store.vault.projects || []).find(p => p.id === projectId);
        if (!project) return;
        project.secrets = (project.secrets || []).filter(s => s.id !== recordId);
    }
    publishHeartbeat() {
        this.ensureDirs();
        const d = this.git.isRepo() ? this.git.dirty() : {
            ok: false
        };
        const unsent = d.ok ? d.files.filter(f => !/\speers\//.test(f) && !f.includes("peers/")) : [];
        const beat = {
            machineId: this.machineId(),
            at: (new Date).toISOString(),
            fingerprint: this.store.contentFingerprint(),
            records: this.localRecords().size,
            manifestCounter: (this.readIndex().lastPush || {}).counter || 0,
            uncommitted: d.ok ? unsent.length : null,
            sourceCommit: this.git.isRepo() ? this.git.head() : null
        };
        const signed = {
            beat: beat,
            signature: sign(this.signingKey(), beat)
        };
        atomicWrite(path.join(this.dirs.peers, `${this.machineId()}.json`), JSON.stringify(signed, null, 2));
        return beat;
    }
    readPeers() {
        const out = [];
        if (!fs.existsSync(this.dirs.peers)) return out;
        for (const f of fs.readdirSync(this.dirs.peers)) {
            if (!f.endsWith(".json")) continue;
            let signed;
            try {
                signed = JSON.parse(fs.readFileSync(path.join(this.dirs.peers, f), "utf8"));
            } catch {
                continue;
            }
            const id = signed.beat && signed.beat.machineId;
            if (!/^[a-f0-9]{16}$/.test(id || "")) continue;
            if (!id || id === this.machineId()) continue;
            const mf = path.join(this.dirs.machines, `${id}.json`);
            let label = id, verified = false;
            if (fs.existsSync(mf)) {
                const machine = (this.store.vault.syncTrust || {})[id];
                if (!machine) {
                    out.push({
                        label: id,
                        verified: false
                    });
                    continue;
                }
                label = machine.label || id;
                verified = verify(machine.signingPublicKey, signed.beat, signed.signature);
            }
            const ageHours = (Date.now() - Date.parse(signed.beat.at)) / 36e5;
            out.push({
                ...signed.beat,
                label: label,
                verified: verified,
                ageHours: Math.round(ageHours * 10) / 10
            });
        }
        return out;
    }
    peerProblems({staleHours: staleHours = 48} = {}) {
        const problems = [];
        for (const p of this.readPeers()) {
            if (!p.verified) {
                problems.push(`${p.label}: heartbeat signature could not be verified`);
                continue;
            }
            if (p.uncommitted > 0) problems.push(`${p.label} has ${p.uncommitted} record file(s) written but never committed - they have not left that machine`);
            if (p.ageHours > staleHours) problems.push(`${p.label} has not reported for ${Math.round(p.ageHours)}h`);
        }
        return problems;
    }
    status() {
        const local = this.localRecords();
        const idx = this.readIndex();
        let remoteCount = 0;
        try {
            remoteCount = fs.readdirSync(this.dirs.records).filter(f => f.endsWith(".age")).length;
        } catch {}
        let plan = null, error = null;
        try {
            plan = this.pull({
                apply: false
            });
        } catch (e) {
            error = e.message;
        }
        return {
            machineId: this.machineId(),
            localRecords: local.size,
            repoRecords: remoteCount,
            fingerprint: this.store.contentFingerprint(),
            lastPush: idx.lastPush,
            incoming: plan ? {
                added: plan.added.length,
                updated: plan.updated.length,
                deleted: plan.deleted.length,
                conflicts: plan.conflicts.length
            } : null,
            outgoing: plan ? [ ...local ].filter(([ref, e]) => idx.records[ref] !== e.hash).length : null,
            conflicts: plan ? plan.conflicts : [],
            unreadable: plan ? plan.unreadable || [] : [],
            error: error
        };
    }
}

module.exports = {
    Sync: Sync,
    opaque: opaque
};
