#!/usr/bin/env node
"use strict";

const {Store: Store} = require("./store");

const {startApi: startApi} = require("./api");

const {probeSession: probeSession, claim: claim} = require("./session");

async function main() {
    const store = new Store;
    const log = m => process.stderr.write(`vault-os backend: ${m}\n`);
    if (!store.exists()) {
        log("no vault yet. Open the Vault OS app once to create one.");
        process.exit(2);
    }
    const live = await probeSession(store.sessionPath);
    if (live) {
        log(`already running on port ${live.port}; nothing to do`);
        process.exit(0);
    }
    const release = claim(store.dataDir);
    process.on("exit", release);
    if (!store.autoUnlock()) {
        log("could not auto-unlock. Open the Vault OS app once and enter the master password.");
        process.exit(3);
    }
    const api = await startApi(store, {
        onShutdown: stop
    });
    store.writeSession(api.port, api.token);
    log(`listening on 127.0.0.1:${api.port}`);
    let stopping = false;
    function stop() {
        if (stopping) return;
        stopping = true;
        store.clearSession();
        store.lock();
        release();
        api.server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1e3).unref();
    }
    for (const sig of [ "SIGINT", "SIGTERM", "SIGHUP" ]) process.on(sig, stop);
    process.on("exit", () => {
        try {
            store.clearSession();
        } catch {}
    });
}

main().catch(e => {
    process.stderr.write(`vault-os backend: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
});
