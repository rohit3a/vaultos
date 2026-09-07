"use strict";

const fs = require("node:fs");

const path = require("node:path");

const {regularFile: regularFile} = require("./fs-safe");

function readSession(file) {
    try {
        regularFile(file, {
            maxBytes: 4096
        });
        const s = JSON.parse(fs.readFileSync(file, "utf8"));
        if (s.app !== "VaultOS-Preview" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || !/^[a-f0-9]{64}$/.test(s.token)) return null;
        return s;
    } catch {
        return null;
    }
}

async function probeSession(file, timeoutMs = 1e3) {
    const s = readSession(file);
    if (!s) return null;
    try {
        const r = await fetch(`http://127.0.0.1:${s.port}/status`, {
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "error"
        });
        return r.ok && (await r.json()).app === "VaultOS-Preview" ? s : null;
    } catch {
        return null;
    }
}

async function requestShutdown(file) {
    const s = await probeSession(file);
    if (!s) return true;
    try {
        await fetch(`http://127.0.0.1:${s.port}/shutdown`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${s.token}`
            },
            signal: AbortSignal.timeout(1e3),
            redirect: "error"
        });
    } catch {}
    for (let i = 0; i < 20; i++) {
        if (!await probeSession(file, 200)) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

function claim(dataDir, name = "owner.lock") {
    const file = path.join(dataDir, name);
    for (let i = 0; i < 2; i++) {
        try {
            const fd = fs.openSync(file, "wx", 384);
            fs.writeFileSync(fd, String(process.pid));
            fs.closeSync(fd);
            return () => {
                try {
                    if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
                } catch {}
            };
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
            regularFile(file, {
                maxBytes: 128
            });
            const pid = Number(fs.readFileSync(file, "utf8"));
            if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid owner lock; inspect it before removing it");
            try {
                process.kill(pid, 0);
                throw new Error("Another VaultOS process owns this vault");
            } catch (err) {
                if (err.code !== "ESRCH") throw err;
                fs.unlinkSync(file);
            }
        }
    }
    throw new Error("Could not claim vault");
}

module.exports = {
    readSession: readSession,
    probeSession: probeSession,
    requestShutdown: requestShutdown,
    claim: claim
};
