"use strict";

const path = require("node:path");

const os = require("node:os");

function defaultDataDir({platform: platform = process.platform, env: env = process.env, home: home = os.homedir()} = {}) {
    if (env.VAULTOS_DATA_DIR) {
        if (!path.isAbsolute(env.VAULTOS_DATA_DIR)) throw new Error("VAULTOS_DATA_DIR must be absolute");
        return env.VAULTOS_DATA_DIR;
    }
    if (platform === "darwin") {
        return path.join(home, "Library", "Application Support", "VaultOS-Preview");
    }
    if (platform === "win32") {
        return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "VaultOS-Preview");
    }
    // The XDG base directory specification says relative values must be ignored.
    const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
    return path.join(config, "VaultOS-Preview");
}

module.exports = {
    defaultDataDir: defaultDataDir
};
