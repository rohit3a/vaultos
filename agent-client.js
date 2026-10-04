"use strict";

const fs = require("node:fs");

const path = require("node:path");

const {spawn: spawn, spawnSync: spawnSync} = require("node:child_process");

const {defaultDataDir: defaultDataDir} = require("./paths");

const {readSession: readSession} = require("./session");

const {regularFile: regularFile} = require("./fs-safe");

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const STALE_START_MS = 3e4;

const MESSAGES = {
    noToken: "No agent token is configured. Ask the human to enroll this agent in VaultOS and set VAULTOS_AGENT_TOKEN_FILE (or VAULTOS_AGENT with a per-agent token file).",
    locked: "VaultOS is running but locked. Ask the human to unlock VaultOS Preview; do not retry in a loop.",
    humanLocked: "VaultOS was locked by a human, which blocks background start. Ask the human to open and unlock VaultOS Preview; do not retry in a loop.",
    notRunning: "VaultOS is not running and could not be started. Ask the human to open and unlock VaultOS Preview; background start works only when background access is enabled in Settings.",
    noBackground: "VaultOS is not running and could not unlock in the background (background access is off or the Keychain helper is unavailable). Ask the human to open and unlock VaultOS Preview.",
    noVault: "No VaultOS vault exists in this data directory. Check VAULTOS_DATA_DIR or ask the human to create the vault in VaultOS Preview.",
    interrupted: "Connection interrupted. Check the operation result before retrying a write"
};

class VaultError extends Error {
    constructor(code, message, status = null) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readTokenFile(file) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new VaultError("token", "The agent token file path must be absolute");
    let st;
    try {
        st = regularFile(file, {
            maxBytes: 4096
        });
    } catch (e) {
        throw new VaultError("token", e.code === "ENOENT" ? "The agent token file does not exist" : "The agent token file must be a regular, unlinked file");
    }
    if ((st.mode & 63) !== 0) throw new VaultError("token", "The agent token file must be private (mode 0600)");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new VaultError("token", "The agent token file must be owned by the current user");
    const token = fs.readFileSync(file, "utf8").trim();
    if (!/^[\x21-\x7e]{16,512}$/.test(token)) throw new VaultError("token", "The agent token file is empty or malformed");
    return token;
}

function agentTokenPath(dataDir, name) {
    if (!AGENT_NAME.test(String(name || ""))) throw new VaultError("token", "VAULTOS_AGENT must be a plain agent name (letters, digits, dot, dash, underscore)");
    return path.join(dataDir, "agents", `${name}.token`);
}

function discoverToken(env = process.env, dataDir = defaultDataDir()) {
    if (env.VAULTOS_AGENT_TOKEN) {
        const token = env.VAULTOS_AGENT_TOKEN.trim();
        if (!/^[\x21-\x7e]{16,512}$/.test(token)) throw new VaultError("token", "VAULTOS_AGENT_TOKEN is malformed");
        return {
            token: token,
            source: "VAULTOS_AGENT_TOKEN"
        };
    }
    if (env.VAULTOS_AGENT_TOKEN_FILE) return {
        token: readTokenFile(env.VAULTOS_AGENT_TOKEN_FILE),
        source: "VAULTOS_AGENT_TOKEN_FILE"
    };
    if (env.VAULTOS_AGENT) return {
        token: readTokenFile(agentTokenPath(dataDir, env.VAULTOS_AGENT)),
        source: "VAULTOS_AGENT"
    };
    return {
        token: "",
        source: null
    };
}

function takeStartLock(file) {
    for (let i = 0; i < 2; i++) {
        try {
            const fd = fs.openSync(file, "wx", 384);
            fs.writeFileSync(fd, String(process.pid));
            fs.closeSync(fd);
            return true;
        } catch (e) {
            if (e.code !== "EEXIST") return false;
            try {
                const st = fs.lstatSync(file);
                if (!st.isFile() || Date.now() - st.mtimeMs <= STALE_START_MS) return false;
                fs.unlinkSync(file);
            } catch {
                return false;
            }
        }
    }
    return false;
}

function releaseStartLock(file) {
    try {
        if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
    } catch {}
}

function startService() {
    if (process.platform === "darwin" && typeof process.getuid === "function") {
        return spawnSync("/bin/launchctl", [ "kickstart", `gui/${process.getuid()}/org.vaultos.preview.backend` ], {
            stdio: "ignore",
            timeout: 1e4
        }).status === 0;
    }
    if (process.platform === "linux") {
        return spawnSync("systemctl", [ "--user", "start", "vaultos-preview-backend.service" ], {
            stdio: "ignore",
            timeout: 1e4
        }).status === 0;
    }
    return false;
}

function defaultStartBackend(dataDir, {useService: useService}) {
    const outcome = {
        exited: null
    };
    if (useService && startService()) return outcome;
    const child = spawn(process.execPath, [ path.join(__dirname, "backend.cjs") ], {
        detached: true,
        stdio: "ignore",
        env: {
            ...process.env,
            VAULTOS_DATA_DIR: dataDir
        }
    });
    child.on("error", () => {
        outcome.exited = -1;
    });
    child.on("exit", code => {
        outcome.exited = code;
    });
    child.unref();
    return outcome;
}

class VaultClient {
    constructor({dataDir: dataDir = defaultDataDir(), env: env = process.env, autostart: autostart = true, startBackend: startBackend = defaultStartBackend, attempts: attempts = 30, interval: interval = 300} = {}) {
        this.dataDir = dataDir;
        this.sessionPath = path.join(dataDir, "session.json");
        this.startPath = path.join(dataDir, "session.json.starting");
        this.autostart = autostart;
        this.startBackend = startBackend;
        this.attempts = attempts;
        this.interval = interval;
        this.useService = !env.VAULTOS_DATA_DIR && !process.env.VAULTOS_DATA_DIR && path.resolve(dataDir) === path.resolve(defaultDataDir());
        this.launching = null;
        try {
            const found = discoverToken(env, dataDir);
            this.token = found.token;
            this.tokenSource = found.source;
            this.tokenProblem = found.token ? null : MESSAGES.noToken;
        } catch (e) {
            this.token = "";
            this.tokenSource = null;
            this.tokenProblem = e.message;
        }
    }
    async live(timeoutMs = 1500) {
        const session = readSession(this.sessionPath);
        if (!session) return null;
        try {
            const r = await fetch(`http://127.0.0.1:${session.port}/status`, {
                signal: AbortSignal.timeout(timeoutMs),
                redirect: "error"
            });
            if (!r.ok) return null;
            const status = await r.json();
            return status && status.app === "VaultOS-Preview" ? {
                session: session,
                status: status
            } : null;
        } catch {
            return null;
        }
    }
    async ensureUp() {
        const current = await this.live();
        if (current) return current;
        if (!this.autostart) throw new VaultError("not_running", MESSAGES.notRunning);
        if (fs.existsSync(path.join(this.dataDir, "locked"))) throw new VaultError("locked", MESSAGES.humanLocked);
        if (!fs.existsSync(path.join(this.dataDir, "vault.enc"))) throw new VaultError("not_running", MESSAGES.noVault);
        if (!this.launching) this.launching = this.launch().finally(() => {
            this.launching = null;
        });
        return this.launching;
    }
    async launch() {
        const mine = takeStartLock(this.startPath);
        let outcome = {
            exited: null
        };
        try {
            if (mine) outcome = this.startBackend(this.dataDir, {
                useService: this.useService
            }) || outcome;
            for (let i = 0; i < this.attempts; i++) {
                await sleep(this.interval);
                const current = await this.live(500);
                if (current) return current;
                if (outcome.exited !== null && outcome.exited !== undefined) break;
                if (!mine && !fs.existsSync(this.startPath)) {
                    const settled = await this.live(500);
                    if (settled) return settled;
                    break;
                }
            }
        } finally {
            if (mine) releaseStartLock(this.startPath);
        }
        throw new VaultError("not_running", outcome.exited === 3 ? MESSAGES.noBackground : MESSAGES.notRunning);
    }
    async status() {
        let current;
        try {
            current = await this.ensureUp();
        } catch (e) {
            return {
                running: false,
                unlocked: false,
                reason: e.code || "not_running",
                message: e.message
            };
        }
        const st = current.status;
        return {
            running: true,
            unlocked: st.locked === false,
            ...st.locked === false ? {} : {
                reason: "locked",
                message: MESSAGES.locked
            },
            formatVersion: st.formatVersion,
            deployment: st.deployment,
            ...st.sync !== undefined ? {
                sync: {
                    autoSync: st.sync.enabled === true,
                    state: st.sync.state || "NOT_RUNNING",
                    halted: st.sync.halted === true,
                    lastSyncAt: st.sync.lastSyncAt || null,
                    error: st.sync.error || null,
                    peerStalled: st.sync.peerStalled === true,
                    peerProblems: st.sync.peerProblems || []
                }
            } : {}
        };
    }
    async request(method, route, body, {agent: agent = true} = {}) {
        if (agent && !this.token) throw new VaultError("token", this.tokenProblem || MESSAGES.noToken);
        const current = await this.ensureUp();
        if (current.status.locked !== false) throw new VaultError("locked", MESSAGES.locked);
        let response;
        try {
            response = await fetch(`http://127.0.0.1:${current.session.port}${route}`, {
                method: method,
                headers: {
                    authorization: `Bearer ${current.session.token}`,
                    ...agent ? {
                        "x-vault-agent-token": this.token
                    } : {},
                    "content-type": "application/json"
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(13e4),
                redirect: "error"
            });
        } catch {
            throw new VaultError("interrupted", MESSAGES.interrupted);
        }
        const result = await response.json().catch(() => ({}));
        if (response.status === 423) throw new VaultError("locked", MESSAGES.locked, 423);
        if (!response.ok) throw new VaultError("refused", result.error || `Vault operation refused (HTTP ${response.status})`, response.status);
        return result;
    }
}

module.exports = {
    AGENT_NAME: AGENT_NAME,
    VaultClient: VaultClient,
    VaultError: VaultError,
    MESSAGES: MESSAGES,
    discoverToken: discoverToken,
    readTokenFile: readTokenFile,
    agentTokenPath: agentTokenPath
};
