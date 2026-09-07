"use strict";

const path = require("node:path");

const os = require("node:os");

function defaultDataDir() {
    if (process.env.VAULTOS_DATA_DIR) {
        if (!path.isAbsolute(process.env.VAULTOS_DATA_DIR)) throw new Error("VAULTOS_DATA_DIR must be absolute");
        return process.env.VAULTOS_DATA_DIR;
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "VaultOS-Preview");
    }
    if (process.platform === "win32") {
        return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "VaultOS-Preview");
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "VaultOS-Preview");
}

module.exports = {
    defaultDataDir: defaultDataDir
};
