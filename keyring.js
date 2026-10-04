"use strict";

const fs = require("node:fs");

const path = require("node:path");

const {createHash: createHash} = require("node:crypto");

const {execFileSync: execFileSync} = require("node:child_process");

const ACCOUNT = "master-password";

const DETAIL = "Remembering the password is optional. No plaintext fallback is used.";

function findExecutable(name, env) {
    for (const dir of String(env.PATH || "").split(path.delimiter)) {
        if (!path.isAbsolute(dir)) continue;
        const file = path.join(dir, name);
        try {
            fs.accessSync(file, fs.constants.X_OK);
            if (fs.statSync(file).isFile()) return file;
        } catch {}
    }
    return null;
}

// systemd user units, cron and SSH sessions can lack DBUS_SESSION_BUS_ADDRESS although the
// user's session bus socket exists. Without a bus the Secret Service is unreachable.
function sessionBusEnv(env) {
    if (env.DBUS_SESSION_BUS_ADDRESS) return env;
    const runtime = env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : "");
    if (!path.isAbsolute(runtime)) return null;
    const bus = path.join(runtime, "bus");
    try {
        if (!fs.statSync(bus).isSocket()) return null;
    } catch {
        return null;
    }
    return {
        ...env,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`
    };
}

class Keyring {
    constructor(dataDir, {platform: platform = process.platform, env: env = process.env} = {}) {
        this.service = "org.vaultos.preview." + createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 24);
        this.platform = platform;
        this.env = env;
        this.helper = __dirname.endsWith("app.asar") && process.resourcesPath ? path.join(process.resourcesPath, "vaultos-keychain") : path.join(__dirname, "build", "native", "vaultos-keychain");
    }
    describe() {
        if (this.platform === "linux") return this.linux().describe;
        const secure = this.platform === "darwin" && fs.existsSync(this.helper);
        return {
            store: secure ? "macos-keychain" : "unavailable",
            secure: secure,
            detail: DETAIL
        };
    }
    linux() {
        const tool = findExecutable("secret-tool", this.env);
        const env = tool && sessionBusEnv(this.env);
        const describe = !tool ? {
            store: "unavailable",
            secure: false,
            detail: "Remembering the password needs secret-tool (libsecret) and a Secret Service such as GNOME Keyring. No plaintext fallback is used."
        } : !env ? {
            store: "unavailable",
            secure: false,
            detail: "No D-Bus session bus was found, so the Secret Service is unreachable. No plaintext fallback is used."
        } : {
            store: "libsecret",
            secure: true,
            detail: "Remembering the password is optional and uses the Secret Service (libsecret). No plaintext fallback is used."
        };
        return {
            tool: tool,
            env: env,
            describe: describe
        };
    }
    call(action, password) {
        if (this.platform === "linux") return this.callSecretService(action, password);
        if (!this.describe().secure) throw new Error(this.platform === "darwin" ? "macOS Keychain helper is unavailable; build it first or leave password remembering off" : "Password remembering is unavailable on this platform");
        let output;
        try {
            output = execFileSync(this.helper, [], {
                input: JSON.stringify({
                    action: action,
                    service: this.service,
                    password: password
                }),
                encoding: "utf8",
                timeout: 1e4,
                maxBuffer: 16384,
                stdio: [ "pipe", "pipe", "pipe" ]
            });
        } catch {
            throw new Error("Keychain operation failed; unlock your login Keychain and retry");
        }
        return JSON.parse(output);
    }
    callSecretService(action, password) {
        const {tool: tool, env: env, describe: describe} = this.linux();
        if (!describe.secure) throw new Error(describe.detail);
        const attributes = [ "service", this.service, "account", ACCOUNT ];
        const args = {
            get: [ "lookup", ...attributes ],
            set: [ "store", "--label=VaultOS Preview master password", ...attributes ],
            delete: [ "clear", ...attributes ]
        }[action];
        if (!args) throw new Error("Unknown keyring action");
        let output;
        try {
            // secret-tool reads the secret from stdin, so it never appears in process arguments.
            output = execFileSync(tool, args, {
                input: action === "set" ? password : "",
                encoding: "utf8",
                timeout: 1e4,
                maxBuffer: 16384,
                stdio: [ "pipe", "pipe", "pipe" ],
                env: env
            });
        } catch (e) {
            // A missing item exits 1 without a message; Secret Service failures explain themselves on stderr.
            if (action !== "set" && e.status === 1 && !String(e.stderr || "").trim()) return {};
            throw new Error("Secret Service operation failed; unlock your login keyring and retry");
        }
        return action === "get" ? output ? {
            password: output
        } : {} : {
            ok: "true"
        };
    }
    get() {
        try {
            return this.call("get").password || null;
        } catch {
            return null;
        }
    }
    set(password) {
        this.call("set", password);
        if (this.get() !== password) throw new Error(this.platform === "linux" ? "Secret Service readback failed" : "Keychain readback failed");
        return this.describe();
    }
    clear() {
        if (this.describe().secure) this.call("delete");
    }
}

module.exports = {
    Keyring: Keyring
};
