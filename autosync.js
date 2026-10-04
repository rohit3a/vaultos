"use strict";

// Automatic sync, run by whichever process owns the unlocked vault. It pulls, then pushes,
// a few seconds after a local change and on a fixed interval. It uses the normal sync engine
// with every check intact and never accepts conflicts: a pull that would need acceptance, or
// any verification failure, halts autosync until a human acts.

const fs = require("node:fs");

const path = require("node:path");

const {Sync: Sync} = require("./sync");

const DEBOUNCE_MS = 5e3;

const START_DELAY_MS = 1500;

// Network trouble is retried on the next round. Every other failure needs a human.
const TRANSIENT = new Set([ "REMOTE_UNREACHABLE", "PUSH_REJECTED", "RECEIPT_UNVERIFIED" ]);

const IDLE = new Set([ "STOPPED", "SCHEDULED", "DISABLED", "PAUSED_LOCKED", "NOT_CONFIGURED" ]);

const syncRepo = store => process.env.VAULTOS_SYNC_REPO || path.join(store.dataDir, "sync-repository");

const firstLine = v => String(v || "").split("\n")[0].slice(0, 500);

class AutoSync {
    constructor(store, {repo: repo = syncRepo(store), intervalMs: intervalMs = null, debounceMs: debounceMs = DEBOUNCE_MS, startDelayMs: startDelayMs = START_DELAY_MS, log: log = () => {}} = {}) {
        this.store = store;
        this.repo = repo;
        this.fixedIntervalMs = intervalMs;
        this.debounceMs = debounceMs;
        this.startDelayMs = startDelayMs;
        this.log = log;
        this.timer = null;
        this.soonTimer = null;
        this.unsubscribe = null;
        this.started = false;
        this.running = false;
        this.halted = false;
        this.state = {
            state: "STOPPED",
            lastSyncAt: null,
            lastAttemptAt: null,
            error: null,
            peerStalled: false,
            peerProblems: []
        };
    }
    settings() {
        return this.store.isUnlocked() ? this.store.autoSyncSettings() : {
            enabled: false,
            intervalSeconds: 120
        };
    }
    intervalMs() {
        return this.fixedIntervalMs || this.settings().intervalSeconds * 1e3;
    }
    configured() {
        return fs.existsSync(path.join(this.repo, "vaultos-sync.json")) && fs.existsSync(path.join(this.repo, ".git")) && fs.existsSync(path.join(this.store.dataDir, "sync-age.key"));
    }
    set(state, error = null) {
        this.state = {
            ...this.state,
            state: state,
            error: error
        };
        return this;
    }
    start() {
        // Persists made by sync itself happen while running and are ignored.
        if (!this.unsubscribe) this.unsubscribe = this.store.onPersist(() => {
            if (!this.running) this.soon();
        });
        this.started = true;
        return this.refresh();
    }
    refresh() {
        this.clearTimers();
        if (!this.started) return this;
        const idle = IDLE.has(this.state.state);
        if (!this.store.isUnlocked()) return this.set("PAUSED_LOCKED");
        if (!this.settings().enabled) return idle ? this.set("DISABLED") : this;
        if (this.halted) return this;
        if (!this.configured()) return this.set("NOT_CONFIGURED", "Initialize Git sync on this device first");
        this.timer = setInterval(() => this.run(), this.intervalMs());
        this.timer.unref();
        if (idle) this.set("SCHEDULED");
        this.soon(this.startDelayMs);
        return this;
    }
    pause() {
        this.clearTimers();
        return this.set("PAUSED_LOCKED");
    }
    stop() {
        this.clearTimers();
        if (this.unsubscribe) this.unsubscribe();
        this.unsubscribe = null;
        this.started = false;
        return this.set("STOPPED");
    }
    clearHalt() {
        this.halted = false;
        return this.refresh();
    }
    clearTimers() {
        clearInterval(this.timer);
        clearTimeout(this.soonTimer);
        this.timer = this.soonTimer = null;
    }
    soon(delay = this.debounceMs) {
        if (!this.timer) return;
        clearTimeout(this.soonTimer);
        this.soonTimer = setTimeout(() => this.run(), delay);
        this.soonTimer.unref();
    }
    halt(state, error) {
        this.halted = true;
        this.clearTimers();
        this.log(`autosync halted (${state}): ${error}`);
    }
    // One pull-then-push round. Git and age run synchronously, so nothing else in this
    // process (including another round or a vault write) interleaves with it.
    run({manual: manual = false} = {}) {
        if (this.running) return this.status();
        if (!this.store.isUnlocked()) {
            if (manual) throw Object.assign(new Error("Vault is locked"), {
                status: 423
            });
            return this.status();
        }
        if (!manual && (this.halted || !this.settings().enabled)) return this.status();
        if (manual && !this.configured()) throw Object.assign(new Error("Git sync is not initialized on this device"), {
            status: 409
        });
        this.running = true;
        const wasHalted = this.halted;
        const attemptAt = (new Date).toISOString();
        try {
            this.store.reloadIfChanged();
            const sync = new Sync(this.store, this.repo);
            const pulled = sync.pullRemote();
            const pushed = sync.pushRemote({
                message: `autosync from ${sync.machineId()}`
            });
            const problems = sync.peerProblems();
            const failure = pushed.delivered ? null : pushed.code || pushed.transport || "PUSH_NOT_DELIVERED";
            this.state = {
                state: pushed.delivered ? "OK" : "PUSH_NOT_DELIVERED",
                lastSyncAt: pushed.delivered ? attemptAt : this.state.lastSyncAt,
                lastAttemptAt: attemptAt,
                error: pushed.delivered ? null : firstLine(pushed.error || pushed.warning || failure),
                received: {
                    added: pulled.added.length,
                    updated: pulled.updated.length,
                    deleted: pulled.deleted.length
                },
                sent: pushed.written || 0,
                peerStalled: problems.length > 0,
                peerProblems: problems
            };
            if (manual) this.halted = false;
            if (failure && !TRANSIENT.has(failure)) this.halt(failure, this.state.error); else if (manual && wasHalted) this.refresh();
            if (pulled.added.length || pulled.updated.length || pulled.deleted.length || pushed.written) this.log(`synced: +${pulled.added.length} ~${pulled.updated.length} -${pulled.deleted.length} in, ${pushed.written || 0} out`);
        } catch (e) {
            const state = e.state || e.code || "ERROR";
            this.state = {
                ...this.state,
                state: state,
                lastAttemptAt: attemptAt,
                error: firstLine(e.message),
                conflicts: e.conflicts || 0
            };
            if (TRANSIENT.has(state)) this.log(`sync failed: ${this.state.error}`); else this.halt(state, this.state.error);
        } finally {
            this.running = false;
        }
        return this.status();
    }
    status() {
        const s = this.settings();
        return {
            enabled: s.enabled,
            intervalSeconds: this.intervalMs() / 1e3,
            halted: this.halted,
            running: this.running,
            ...this.state
        };
    }
    // The subset served on the unauthenticated /status route: no messages or peer labels.
    publicStatus() {
        const s = this.status();
        return {
            enabled: s.enabled,
            state: s.state,
            halted: s.halted,
            lastSyncAt: s.lastSyncAt,
            peerStalled: s.peerStalled
        };
    }
}

module.exports = {
    AutoSync: AutoSync,
    syncRepo: syncRepo
};
