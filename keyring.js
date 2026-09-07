"use strict";

const fs = require("node:fs");

const path = require("node:path");

const {createHash: createHash} = require("node:crypto");

const {execFileSync: execFileSync} = require("node:child_process");

class Keyring {
    constructor(dataDir) {
        this.service = "org.vaultos.preview." + createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 24);
        this.helper = __dirname.endsWith("app.asar") && process.resourcesPath ? path.join(process.resourcesPath, "vaultos-keychain") : path.join(__dirname, "build", "native", "vaultos-keychain");
    }
    describe() {
        return {
            store: process.platform === "darwin" && fs.existsSync(this.helper) ? "macos-keychain" : "unavailable",
            secure: process.platform === "darwin" && fs.existsSync(this.helper),
            detail: "Remembering the password is optional. No plaintext fallback is used."
        };
    }
    call(action, password) {
        if (!this.describe().secure) throw new Error("macOS Keychain helper is unavailable; build it first or leave password remembering off");
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
    get() {
        try {
            return this.call("get").password || null;
        } catch {
            return null;
        }
    }
    set(password) {
        this.call("set", password);
        if (this.get() !== password) throw new Error("Keychain readback failed");
        return this.describe();
    }
    clear() {
        if (this.describe().secure) this.call("delete");
    }
}

module.exports = {
    Keyring: Keyring
};
