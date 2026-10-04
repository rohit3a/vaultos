"use strict";

// One-time, human-run import of a data directory from the earlier "vault-os" fork.
// Never called automatically. The source directory is only read: its vault is copied
// to a private temporary file before decryption, and its plaintext password fallback
// (backend.key) and sync state are never opened.

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");

const {parseArgs: parseArgs} = require("node:util");

const {encryptVault: encryptVault, decryptVault: decryptVault, sha256: sha256} = require("./crypto");

const M = require("./model");

const V = require("./validation");

const {privateDir: privateDir, regularFile: regularFile, atomicWrite: atomicWrite} = require("./fs-safe");

const {defaultDataDir: defaultDataDir} = require("./paths");

const session = require("./session");

const {passwordPrompt: passwordPrompt} = require("./prompt");

const USAGE = "usage: node cli.cjs import-legacy --from <earlier-data-dir> [--plan] [--grant-all-existing-agents] [--lock-policy soft|hard] [--auto-sync] [--password-stdin]";

const UNDOABLE = new Set([ "create_secret", "update_secret", "delete_secret", "create_project", "delete_project" ]);

const SECRET_FIELDS = [ "key", "value", "password", "note", "username", "email", "url", "provider", "permission", "expiresAt" ];

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const TOKEN = /^[\x21-\x7e]{16,512}$/;

const KNOWN_ACTORS = actor => actor === M.HUMAN || actor === "sync" || M.isAgent(actor);

// Names are shown in reports; values never are.
const label = v => String(v ?? "").slice(0, 120);

const ruleOf = e => String(e && e.message || e).replace(/\s+/g, " ");

const pidAlive = pid => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === "EPERM";
    }
};

// The earlier fork's liveness rule: a session file whose port answers /status is live;
// while the named process exists, give a busy owner a few longer chances.
async function legacyOwner(file) {
    let s;
    try {
        regularFile(file, {
            maxBytes: 4096
        });
        s = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return false;
    }
    if (!s || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return false;
    const probe = async ms => {
        try {
            const r = await fetch(`http://127.0.0.1:${s.port}/status`, {
                signal: AbortSignal.timeout(ms),
                redirect: "error"
            });
            if (!r.ok) return false;
            await r.json();
            return true;
        } catch {
            return false;
        }
    };
    if (await probe(1500)) return true;
    if (!Number.isInteger(s.pid) || s.pid <= 0 || s.pid === process.pid) return false;
    for (let i = 0; i < 4 && pidAlive(s.pid); i++) if (await probe(2500)) return true;
    return false;
}

function readSourceVault(from) {
    const file = path.join(from, "vault.enc");
    regularFile(file);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vaultos-import-"));
    try {
        fs.chmodSync(tmp, 448);
        const copy = path.join(tmp, "vault.enc");
        fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(copy, 384);
        return JSON.parse(fs.readFileSync(copy, "utf8"));
    } finally {
        fs.rmSync(tmp, {
            recursive: true,
            force: true
        });
    }
}

function sourceTokens(from) {
    const out = [];
    const add = (file, name) => {
        try {
            regularFile(file, {
                maxBytes: 4096
            });
        } catch {
            return;
        }
        const token = fs.readFileSync(file, "utf8").trim();
        if (TOKEN.test(token)) out.push({
            source: name,
            token: token
        });
    };
    add(path.join(from, "agent-token"), "agent-token");
    const dir = path.join(from, "agents");
    try {
        if (!fs.lstatSync(dir).isDirectory()) return out;
        for (const name of fs.readdirSync(dir).sort()) if (name.endsWith(".token")) add(path.join(dir, name), `agents/${name}`);
    } catch {}
    return out;
}

function sourceBackups(from) {
    const dir = path.join(from, "backups");
    try {
        if (!fs.lstatSync(dir).isDirectory()) return [];
        return fs.readdirSync(dir).filter(n => n.endsWith(".enc") && !n.startsWith(".")).sort().filter(n => {
            try {
                regularFile(path.join(dir, n));
                return true;
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

// Convert a decrypted earlier-format vault into this build's v3 shape and report on it.
function transform(raw, options = {}) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects)) throw new Error("Invalid vault data");
    const fromFormat = raw.formatVersion || 1;
    if (fromFormat >= M.FORMAT_VERSION) throw new Error("This vault is already in VaultOS Preview format; restore it with the recovery steps instead of importing it");
    M.assertReadable(raw);
    const {vault: vault} = M.migrate(raw);
    const failures = [], denied = [], dropped = [];
    for (const k of Object.keys(vault)) {
        if (![ "formatVersion", "minReaderVersion", "projects", "agents", "tombstones", "history", "settings" ].includes(k)) {
            dropped.push(k);
            delete vault[k];
        }
    }
    const projectNames = new Map(), projectIds = new Set();
    let secrets = 0, pending = 0;
    for (const p of vault.projects) {
        const name = p && typeof p.name === "string" ? p.name : "";
        const fail = (rule, key) => failures.push({
            project: label(name),
            ...key === undefined ? {} : {
                key: label(key)
            },
            rule: rule
        });
        try {
            V.object(p);
            V.text(p.name, "project name");
            if (typeof p.id !== "string" || !p.id) throw new Error("Missing project id");
            if (!Array.isArray(p.secrets)) throw new Error("Project has no secret list");
        } catch (e) {
            fail(ruleOf(e));
            continue;
        }
        const lower = name.trim().toLowerCase();
        if (projectNames.has(lower)) fail(`Project name collides (case-insensitively) with ${label(projectNames.get(lower))}`); else projectNames.set(lower, name);
        if (projectIds.has(p.id)) fail("Duplicate project id"); else projectIds.add(p.id);
        const keys = new Set(), ids = new Set();
        for (const s of p.secrets) {
            secrets++;
            const key = s && typeof s.key === "string" ? s.key : "";
            try {
                V.object(s);
                const fields = {};
                for (const f of SECRET_FIELDS) if (s[f] !== undefined) fields[f] = s[f];
                V.secret(fields);
                if (typeof s.id !== "string" || !s.id) throw new Error("Missing secret id");
            } catch (e) {
                fail(ruleOf(e), key);
                continue;
            }
            if (keys.has(key)) fail("Duplicate key name in this project", key); else keys.add(key);
            if (ids.has(s.id)) fail("Duplicate secret id in this project", key); else ids.add(s.id);
            if (s.approvalDenied === true) {
                // This build models denial as removal. Keep the record but hold it from
                // injection, so the human re-decides it; never grant it silently.
                s.injectApproved = false;
                denied.push({
                    project: name,
                    key: key
                });
            }
            delete s.approvalDenied;
            if (s.injectApproved === false) pending++;
        }
    }
    const agentNames = new Set();
    let revoked = 0, granted = 0;
    for (const a of vault.agents) {
        const name = a && typeof a.name === "string" ? a.name : "";
        const fail = rule => failures.push({
            agent: label(name),
            rule: rule
        });
        try {
            V.object(a);
            V.text(a.name, "agent name", 100);
            if (typeof a.id !== "string" || !a.id) throw new Error("Missing agent id");
            if (!/^[a-f0-9]{64}$/.test(String(a.tokenHash || ""))) throw new Error("Invalid agent token hash");
            if (!Array.isArray(a.scopes) || a.scopes.some(x => !M.ALL_SCOPES.includes(x))) throw new Error("Unknown agent scope");
        } catch (e) {
            fail(ruleOf(e));
            continue;
        }
        const lower = name.trim().toLowerCase();
        if (agentNames.has(lower)) fail("Agent name collides (case-insensitively) with another agent"); else agentNames.add(lower);
        // Agents keep their identity and token hash, so existing tokens keep working, but
        // start with no project or folder access unless the human asked for all access.
        const grant = options.grantAll === true && !a.revokedAt;
        a.projects = [];
        a.roots = [];
        a.allProjects = grant;
        a.anyRoot = grant;
        if (a.revokedAt) revoked++;
        if (grant) granted++;
    }
    const notUndoable = {}, actors = {};
    for (const h of vault.history) {
        if (!h || h.reverted) continue;
        if (!UNDOABLE.has(h.action)) notUndoable[h.action] = (notUndoable[h.action] || 0) + 1;
        if (!KNOWN_ACTORS(h.actor)) actors[h.actor] = (actors[h.actor] || 0) + 1;
    }
    const old = vault.settings && typeof vault.settings === "object" ? vault.settings : {};
    const settings = {}, carried = [], warnings = [];
    if (old.approverTokenHash !== undefined) {
        if (/^[a-f0-9]{64}$/.test(String(old.approverTokenHash))) {
            settings.approverTokenHash = old.approverTokenHash;
            carried.push("approverTokenHash");
        } else warnings.push("The approval relay hash was malformed and was not carried over; configure the relay again.");
    }
    if (old.exportPassword) {
        try {
            V.password(old.exportPassword);
            settings.exportPassword = old.exportPassword;
            carried.push("exportPassword");
        } catch {
            warnings.push("The PDF export password does not meet this build's rules and was not carried over; set a new one in Settings.");
        }
    }
    if (options.lockPolicy) settings.lockPolicy = options.lockPolicy;
    if (options.autoSync) settings.autoSync = {
        enabled: true,
        intervalSeconds: 120
    };
    vault.settings = settings;
    const report = {
        fromFormat: fromFormat,
        toFormat: M.FORMAT_VERSION,
        counts: {
            projects: vault.projects.length,
            secrets: secrets,
            agents: vault.agents.length,
            revokedAgents: revoked,
            tombstones: vault.tombstones.length,
            history: vault.history.length
        },
        failures: failures,
        heldForApproval: pending,
        previouslyDenied: denied.map(d => ({
            project: label(d.project),
            key: label(d.key)
        })),
        history: {
            notUndoable: notUndoable,
            unfamiliarActors: actors
        },
        settings: {
            carried: carried,
            applied: {
                ...options.lockPolicy ? {
                    lockPolicy: options.lockPolicy
                } : {},
                ...options.autoSync ? {
                    autoSync: true
                } : {}
            },
            notCarried: Object.keys(old).filter(k => !carried.includes(k)).sort()
        },
        droppedVaultFields: dropped,
        agentAccess: {
            allAccessGranted: granted
        },
        warnings: warnings
    };
    return {
        vault: vault,
        report: report,
        denied: denied
    };
}

function matchTokens(vault, tokens) {
    const byHash = new Map(vault.agents.map(a => [ a.tokenHash, a ]));
    const out = [], seen = new Set();
    for (const t of tokens) {
        const agent = byHash.get(sha256(t.token));
        if (!agent) {
            out.push({
                source: t.source,
                agent: null,
                note: "matches no enrolled agent; not copied"
            });
            continue;
        }
        if (agent.revokedAt) {
            out.push({
                source: t.source,
                agent: agent.name,
                note: "belongs to a revoked agent; not copied"
            });
            continue;
        }
        if (!AGENT_NAME.test(agent.name)) {
            out.push({
                source: t.source,
                agent: agent.name,
                note: "agent name cannot be used as a token file name; reissue this agent's token with the admin CLI"
            });
            continue;
        }
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        out.push({
            source: t.source,
            agent: agent.name,
            token: t.token
        });
    }
    return out;
}

function parse(argv) {
    const {values: v, positionals: positionals} = parseArgs({
        args: argv,
        options: {
            from: {
                type: "string"
            },
            plan: {
                type: "boolean"
            },
            "grant-all-existing-agents": {
                type: "boolean"
            },
            "lock-policy": {
                type: "string"
            },
            "auto-sync": {
                type: "boolean"
            }
        },
        allowPositionals: true,
        strict: true
    });
    if (positionals.length || !v.from) throw new Error(USAGE);
    if (v["lock-policy"] !== undefined && ![ "soft", "hard" ].includes(v["lock-policy"])) throw new Error("--lock-policy must be soft or hard");
    return {
        from: path.resolve(v.from),
        plan: v.plan === true,
        grantAll: v["grant-all-existing-agents"] === true,
        lockPolicy: v["lock-policy"],
        autoSync: v["auto-sync"] === true
    };
}

const real = p => {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
};

const inside = (a, b) => a === b || a.startsWith(b + path.sep);

async function preflight(opts, dataDir) {
    if (!fs.existsSync(opts.from) || !fs.statSync(opts.from).isDirectory()) throw new Error("--from must be an existing data directory");
    const from = real(opts.from), target = real(dataDir);
    if (inside(from, target) || inside(target, from)) throw new Error("--from must be a different directory from the VaultOS Preview data directory");
    if (fs.existsSync(path.join(dataDir, "vault.enc"))) throw new Error("This VaultOS Preview data directory already has a vault. Import only into a new, empty data directory (set VAULTOS_DATA_DIR)");
    if (await legacyOwner(path.join(opts.from, "session.json"))) throw new Error("The earlier vault-os app or backend is running. Quit it (and stop its background service) before importing");
    if (fs.existsSync(dataDir) && (session.lockOwner(dataDir) || await session.findOwner(path.join(dataDir, "session.json")))) throw new Error("VaultOS Preview is running for this data directory. Quit it before importing");
}

function writeTarget(dataDir, from, vault, password, tokens, report) {
    if (fs.existsSync(path.join(dataDir, "vault.enc"))) throw new Error("A vault appeared in the target before import started; nothing was written");
    const written = {
        backups: [],
        skippedBackups: [],
        tokenFiles: [],
        auditLog: false
    };
    const backups = sourceBackups(from);
    if (backups.length) {
        const dir = path.join(dataDir, "backups");
        privateDir(dir);
        for (const name of backups) {
            const dest = path.join(dir, name);
            if (fs.existsSync(dest)) {
                written.skippedBackups.push(name);
                continue;
            }
            atomicWrite(dest, fs.readFileSync(path.join(from, "backups", name)));
            written.backups.push(name);
        }
    }
    for (const t of tokens.filter(t => t.token)) {
        const dir = path.join(dataDir, "agents");
        privateDir(dir);
        const dest = path.join(dir, `${t.agent}.token`);
        if (fs.existsSync(dest)) {
            t.note = "a token file for this agent already exists in the target; left unchanged";
            delete t.token;
            continue;
        }
        atomicWrite(dest, t.token + "\n");
        fs.chmodSync(dest, 384);
        t.file = dest;
        delete t.token;
        written.tokenFiles.push(dest);
    }
    const auditPath = path.join(dataDir, "audit.log");
    const parts = [];
    try {
        regularFile(path.join(from, "audit.log"), {
            maxBytes: 64 * 1024 * 1024
        });
        parts.push(fs.readFileSync(path.join(from, "audit.log"), "utf8"));
    } catch {}
    if (regularFile(auditPath, {
        optional: true,
        maxBytes: 64 * 1024 * 1024
    })) parts.push(fs.readFileSync(auditPath, "utf8"));
    const body = parts.map(x => x && !x.endsWith("\n") ? x + "\n" : x).join("");
    const c = report.counts;
    atomicWrite(auditPath, body + `${(new Date).toISOString()}\t${M.HUMAN}\timport_legacy\tformat v${report.fromFormat} -> v${report.toFormat}: ${c.projects} projects, ${c.secrets} secrets, ${c.agents} agents, ${report.previouslyDenied.length} previously denied keys held for approval\n`);
    fs.chmodSync(auditPath, 384);
    written.auditLog = true;
    vault.history.push({
        id: require("./crypto").randomId(),
        ts: (new Date).toISOString(),
        actor: M.HUMAN,
        action: "import_legacy",
        project: null,
        key: null,
        before: null,
        after: {
            from: report.fromFormat,
            to: report.toFormat,
            projects: c.projects,
            secrets: c.secrets,
            agents: c.agents
        },
        ref: null,
        reverted: false
    });
    const vaultPath = path.join(dataDir, "vault.enc");
    atomicWrite(vaultPath, JSON.stringify(encryptVault(vault, password)));
    const check = decryptVault(JSON.parse(fs.readFileSync(vaultPath, "utf8")), password);
    const count = v => v.projects.reduce((n, p) => n + p.secrets.length, 0);
    if (check.projects.length !== c.projects || count(check) !== c.secrets) throw new Error("The written vault did not verify; keep using the earlier app and report this");
    return written;
}

async function runImportLegacy(argv, {dataDir: dataDir = defaultDataDir(), readPassword: readPassword = () => passwordPrompt("Master password of the earlier vault: ")} = {}) {
    const opts = parse(argv);
    await preflight(opts, dataDir);
    const envelope = readSourceVault(opts.from);
    const password = await readPassword();
    let raw;
    try {
        raw = decryptVault(envelope, password);
    } catch {
        throw new Error("Wrong password, or the earlier vault is unreadable. Nothing was written");
    }
    const {vault: vault, report: report} = transform(raw, opts);
    const tokens = matchTokens(vault, sourceTokens(opts.from));
    const backups = sourceBackups(opts.from);
    const out = {
        mode: opts.plan ? "plan" : "import",
        source: opts.from,
        target: dataDir,
        ...report,
        agentTokens: tokens.map(({token: _t, ...t}) => ({
            ...t,
            ...t.agent && !t.note ? {
                target: path.join(dataDir, "agents", `${t.agent}.token`),
                env: `VAULTOS_AGENT=${t.agent}`
            } : {}
        })),
        files: {
            auditLog: fs.existsSync(path.join(opts.from, "audit.log")),
            backups: backups.length,
            notImported: [ "backend.key", "session.json", "sync keys, machine-id and sync-index.json", "Keychain / keyring entries" ]
        }
    };
    const reminders = [];
    if (!opts.grantAll && vault.agents.some(a => !a.revokedAt)) reminders.push("Imported agents have no project or folder access yet. Grant it in Settings → Agents or with `node cli.cjs agents grant`.");
    if (report.previouslyDenied.length) reminders.push("Keys denied in the earlier app are held for approval here (this build has no separate denied state). Deny (remove) or approve them in VaultOS.");
    if (opts.autoSync) reminders.push("Autosync does nothing until you set up a new sync group with `node cli.cjs sync init`.");
    reminders.push("Background access (remembered password) stays off; enable it in the app if you want it.");
    if (backups.length) reminders.push("Copied backups are still in the earlier format and use the earlier password; this build can read them.");
    out.reminders = reminders;
    out.ok = report.failures.length === 0;
    if (!out.ok && !opts.plan) {
        const e = new Error(`${report.failures.length} record(s) fail VaultOS validation. Fix them in the earlier app, then retry. Nothing was written.`);
        e.report = out;
        throw e;
    }
    if (opts.plan) return out;
    privateDir(dataDir);
    const release = session.claim(dataDir);
    process.on("exit", release);
    try {
        out.written = writeTarget(dataDir, opts.from, vault, password, tokens, report);
    } finally {
        release();
    }
    out.agentTokens = tokens.map(({token: _t, ...t}) => ({
        ...t,
        ...t.file ? {
            env: `VAULTOS_AGENT=${t.agent}`
        } : {}
    }));
    out.rollback = "The earlier data directory was not modified. To roll back, quit VaultOS Preview, remove this data directory, and keep using the earlier app.";
    return out;
}

module.exports = {
    runImportLegacy: runImportLegacy,
    transform: transform,
    legacyOwner: legacyOwner,
    USAGE: USAGE
};
