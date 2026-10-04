#!/usr/bin/env node
"use strict";

const {Store: Store} = require("./store");

const {startApi: startApi} = require("./api");

const {readSession: readSession, probeSession: probeSession, findOwner: findOwner, lockOwner: lockOwner, claim: claim} = require("./session");

const {AutoSync: AutoSync} = require("./autosync");

const sleep = ms => new Promise(r => setTimeout(r, ms));

const WAITING = {
    locked: "a manual lock requires a human unlock in the app",
    "no-password": "no remembered password (background access is off, or the Keychain is not available yet)",
    "unlock-failed": "the remembered password did not open the vault"
};

// Serve the unlocked, claimed vault until a handover request, a signal, or a lost claim.
// Resolves with the reason after the API is closed, the vault locked and the claim released.
async function serve(store, release, {log: log, guardMs: guardMs, setStop: setStop}) {
    let stopping = false, done;
    const finished = new Promise(r => done = r);
    const autoSync = new AutoSync(store, {
        log: log
    });
    const api = await startApi(store, {
        onShutdown: () => stop("handover to the VaultOS window"),
        autoSync: autoSync
    });
    store.writeSession(api.port, api.token);
    autoSync.start();
    log(`listening on 127.0.0.1:${api.port}`);
    const guard = setInterval(async () => {
        if (stopping) return;
        const s = readSession(store.sessionPath);
        if (!s || s.pid !== process.pid || s.port !== api.port) {
            // This process holds owner.lock. A different live session means a writer that
            // ignored it; two writers must not coexist, so this one leaves.
            const other = s && s.pid !== process.pid ? await probeSession(store.sessionPath) : null;
            if (other) return stop(`pid ${other.pid} also serves this vault`);
            if (stopping) return;
            store.writeSession(api.port, api.token);
            log("the session file was missing; restored it");
        }
        try {
            if (store.reloadIfChanged()) log("vault.enc changed on disk; reloaded it");
        } catch (e) {
            stop(`could not reload the changed vault: ${e.message}`);
        }
    }, guardMs);
    function stop(reason) {
        if (stopping) return;
        stopping = true;
        clearInterval(guard);
        autoSync.stop();
        store.clearSession();
        store.lock();
        release();
        api.server.close();
        api.server.closeAllConnections();
        log(`stopped serving: ${reason}`);
        done(reason);
    }
    setStop(stop);
    return finished;
}

async function main({service: service = process.argv.includes("--service"), store: store = new Store, pollMs: pollMs = 5e3, maxUnlockWaitMs: maxUnlockWaitMs = 6e4, handoverDelayMs: handoverDelayMs = 3e3, guardMs: guardMs = 1e4, graceMs: graceMs = 3e5} = {}) {
    const log = m => process.stderr.write(`vaultos backend: ${m}\n`);
    let stop = null, signalled = false;
    for (const sig of [ "SIGINT", "SIGTERM", "SIGHUP" ]) process.on(sig, () => {
        signalled = true;
        if (stop) stop("signal"); else process.exit(0);
    });
    process.on("exit", () => {
        try {
            store.clearSession();
        } catch {}
    });
    const setStop = fn => stop = fn;
    // Permanent conditions exit 0 in service mode so launchd (KeepAlive SuccessfulExit=false)
    // and systemd (Restart=on-failure) do not relaunch the service in a loop.
    if (!store.exists()) {
        log("no vault yet. Open VaultOS Preview once to create one.");
        return service ? 0 : 2;
    }
    if (!service) {
        const live = await probeSession(store.sessionPath);
        if (live) {
            log(`already running on port ${live.port}; nothing to do`);
            return 0;
        }
        const release = claim(store.dataDir);
        process.on("exit", release);
        if (!store.autoUnlock()) {
            log("could not auto-unlock. Open VaultOS Preview once and enter the master password.");
            return 3;
        }
        await serve(store, release, {
            log: log,
            guardMs: guardMs,
            setStop: setStop
        });
        return 0;
    }
    // --service: a long-running owner. It waits while another process owns the vault and
    // takes over when that process stops. It never holds owner.lock while waiting, so the
    // desktop can always claim the vault first.
    if (!store.keyring.describe().secure) {
        log("service mode needs secure remembered-password storage (on macOS, build the Keychain helper with npm run build:native) and background access enabled in Settings.");
        return 0;
    }
    let said = null, noPasswordSince = null, unlockWait = pollMs;
    const wait = async (message, ms) => {
        if (message !== said) log(message);
        said = message;
        await sleep(ms);
    };
    while (!signalled) {
        const owner = await findOwner(store.sessionPath);
        const holder = owner ? owner.pid : lockOwner(store.dataDir);
        if (holder && holder !== process.pid) {
            noPasswordSince = null;
            unlockWait = pollMs;
            await wait(`the vault is owned by pid ${holder}; waiting to take over when it stops`, pollMs);
            continue;
        }
        const status = store.autoUnlockStatus();
        if (!status.ok) {
            if (status.reason === "disabled") {
                log("background access is off in Settings, so the service does not run. Enable it, then restart the service.");
                return 0;
            }
            if (status.reason === "no-vault") {
                log("no vault yet. Open VaultOS Preview once to create one.");
                return 0;
            }
            if (status.reason === "no-password") {
                noPasswordSince = noPasswordSince || Date.now();
                if (Date.now() - noPasswordSince >= graceMs) {
                    log("no remembered password. Enable background access in Settings and unlock once, then restart the service.");
                    return 0;
                }
            } else noPasswordSince = null;
            await wait(`waiting to unlock: ${WAITING[status.reason] || status.reason}`, unlockWait);
            unlockWait = Math.min(unlockWait * 2, maxUnlockWaitMs);
            continue;
        }
        noPasswordSince = null;
        unlockWait = pollMs;
        let release;
        try {
            release = claim(store.dataDir);
        } catch {
            store.lock();
            await wait("another owner appeared; standing by", pollMs);
            continue;
        }
        said = null;
        const reason = await serve(store, release, {
            log: log,
            guardMs: guardMs,
            setStop: setStop
        });
        stop = null;
        if (signalled || reason === "signal") break;
        await sleep(handoverDelayMs);
    }
    return 0;
}

if (require.main === module) {
    main().then(code => process.exit(code), e => {
        process.stderr.write(`vaultos backend: ${e && e.message ? e.message : e}\n`);
        process.exit(1);
    });
}

module.exports = {
    main: main
};
