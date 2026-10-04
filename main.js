"use strict";

const {app: app, BrowserWindow: BrowserWindow, ipcMain: ipcMain, dialog: dialog, protocol: protocol, powerMonitor: powerMonitor, clipboard: clipboard, systemPreferences: systemPreferences} = require("electron");

const fs = require("node:fs");

const path = require("node:path");

const {Store: Store} = require("./store");

const {Agents: Agents} = require("./agents");

const {startApi: startApi} = require("./api");

const {requestShutdown: requestShutdown, claim: claim} = require("./session");

const {AutoSync: AutoSync, syncRepo: syncRepo} = require("./autosync");

const {safeEqual: safeEqual} = require("./crypto");

const {defaultDataDir: defaultDataDir} = require("./paths");

const {PROVIDERS: PROVIDERS} = require("./providers");

const M = require("./model");

const {HumanAuth: HumanAuth, touchIdUnlockStatus: touchIdUnlockStatus, weakensSecurity: weakensSecurity, checkTouchIdPatch: checkTouchIdPatch} = require("./human-auth");

app.setName("VaultOS Preview");

app.setPath("userData", path.join(defaultDataDir(), "desktop"));

protocol.registerSchemesAsPrivileged([ {
    scheme: "vaultos-preview",
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true
    }
} ]);

const store = new Store;

let win, api, autoSync, release, humanUnlocked = false, timer, failed = 0, retryAt = 0;

const URL_HOME = "vaultos-preview://app/index.html";

const backendOnly = process.argv.includes("--backend");

// Touch ID is optional and off by default. Human-only handlers below call gate(); it does
// nothing unless the human turned on touchId.humanActions.
const humanAuth = new HumanAuth({
    canPrompt: () => typeof systemPreferences.canPromptTouchID === "function" && systemPreferences.canPromptTouchID(),
    prompt: reason => systemPreferences.promptTouchID(reason),
    verifyPassword: pw => store.isUnlocked() && safeEqual(pw, store.password)
});

const gate = (reason, options) => humanAuth.require(store.touchIdSettings().humanActions, reason, options);

function unlockStatus() {
    const unlocked = store.isUnlocked();
    return touchIdUnlockStatus({
        available: humanAuth.available(),
        exists: store.exists(),
        blocked: store.isAutoUnlockBlocked(),
        unlocked: unlocked,
        settings: unlocked ? store.getSettings() : null,
        hint: unlocked ? null : store.touchIdHint()
    });
}

const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

function lock({forget: forget = true} = {}) {
    humanUnlocked = false;
    humanAuth.reset();
    clearTimeout(timer);
    if (forget) {
        try {
            store.blockAutoUnlock();
        } catch {}
        try {
            store.keyring.clear();
        } catch {}
    }
    if (autoSync) {
        autoSync.stop();
        autoSync = null;
    }
    if (api) {
        api.server.close();
        api.server.closeAllConnections();
        api = null;
    }
    store.clearSession();
    store.lock();
    if (release) {
        release();
        release = null;
    }
    if (win && !win.isDestroyed()) win.webContents.send("vault:locked");
}

// Locks only the window: the human must unlock again to view or change anything, while
// this process keeps owning the vault and serving enrolled agents.
function lockWindow() {
    humanUnlocked = false;
    humanAuth.reset();
    clearTimeout(timer);
    if (win && !win.isDestroyed()) win.webContents.send("vault:locked");
}

// Screen lock, sleep and idle follow the vault's lock policy (hard unless the human chose soft).
function autoLock(trigger) {
    if (store.lockAction(trigger) === "ui") lockWindow(); else lock();
}

function touch() {
    clearTimeout(timer);
    if (humanUnlocked) timer = setTimeout(() => autoLock("idle"), 15 * 60 * 1e3);
}

async function own() {
    if (release) return;
    if (!await requestShutdown(store.sessionPath)) throw new Error("Close the other VaultOS Preview instance before unlocking");
    release = claim(store.dataDir);
}

async function serve() {
    if (!api) {
        autoSync = new AutoSync(store);
        api = await startApi(store, {
            autoSync: autoSync
        });
        store.writeSession(api.port, api.token);
        autoSync.start();
    }
}

function handle(channel, fn, publicCall = false) {
    ipcMain.handle("vault:" + channel, async (event, ...args) => {
        if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== URL_HOME) throw new Error("Untrusted IPC sender");
        if (!publicCall && (!humanUnlocked || !store.isUnlocked())) throw new Error("Vault is locked");
        if (!publicCall) touch();
        try {
            if (!publicCall) store.reloadIfChanged();
            return await fn(...args);
        } catch (e) {
            throw new Error(e instanceof SyntaxError ? "Invalid file format" : e.code ? "File operation failed; check permissions and retry" : e.message);
        }
    });
}

handle("state", () => ({
    exists: store.exists(),
    unlocked: humanUnlocked,
    isMac: process.platform === "darwin",
    dataDir: store.dataDir,
    touchId: (t => ({
        available: humanAuth.available(),
        enabled: t.enabled,
        ready: t.ready,
        autoPrompt: t.ready && t.autoPrompt
    }))(unlockStatus())
}), true);

handle("providers", () => PROVIDERS, true);

handle("init", async pw => {
    if (Date.now() < retryAt) return {
        ok: false,
        error: "Wait a moment before trying again"
    };
    await own();
    try {
        store.init(pw);
        store.allowAutoUnlock();
        humanUnlocked = true;
        humanAuth.markProven();
        await serve();
        touch();
        return {
            ok: true
        };
    } catch (e) {
        lock({
            forget: false
        });
        throw e;
    }
}, true);

handle("unlock", async pw => {
    if (typeof pw !== "string" || pw.length > 1024) return {
        ok: false,
        error: "Invalid password"
    };
    if (Date.now() < retryAt) return {
        ok: false,
        error: "Wait a moment before trying again"
    };
    await own();
    try {
        if (store.isUnlocked()) {
            if (!safeEqual(pw, store.password)) throw new Error("Wrong password");
        } else store.unlock(pw);
        store.allowAutoUnlock();
        store.writeTouchIdHint();
        humanUnlocked = true;
        humanAuth.markProven();
        failed = 0;
        await serve();
        touch();
        return {
            ok: true
        };
    } catch {
        retryAt = Date.now() + Math.min(3e4, 500 * 2 ** Math.min(++failed, 6));
        if (!store.isUnlocked() && release) {
            release();
            release = null;
        }
        return {
            ok: false,
            error: "Could not unlock. Check the password and vault file."
        };
    }
}, true);

// Touch ID opens the window with the password the Keychain remembers, through the same
// checks as a typed unlock. Cancel or failure leaves the password field as the fallback.
handle("unlockTouchId", async () => {
    if (Date.now() < retryAt) return {
        ok: false,
        error: "Wait a moment before trying again"
    };
    const status = unlockStatus();
    if (!status.ready) return {
        ok: false,
        error: status.error
    };
    try {
        await humanAuth.prompt("unlock VaultOS");
    } catch {
        return {
            ok: false,
            canceled: true,
            error: "Touch ID was not confirmed. Enter the master password."
        };
    }
    try {
        await own();
    } catch (e) {
        humanAuth.reset();
        throw e;
    }
    const wasUnlocked = store.isUnlocked();
    try {
        if (store.isAutoUnlockBlocked()) throw new Error("blocked");
        const pw = store.keyring.get();
        if (!pw) throw new Error("no remembered password");
        if (wasUnlocked) {
            if (!safeEqual(pw, store.password)) throw new Error("stale remembered password");
        } else store.unlock(pw);
        const s = store.getSettings();
        if (!s.touchId.unlock || !s.rememberPassword) throw new Error("Touch ID unlock is off");
        store.writeTouchIdHint();
        humanUnlocked = true;
        humanAuth.markProven();
        failed = 0;
        await serve();
        touch();
        return {
            ok: true
        };
    } catch {
        if (!wasUnlocked) {
            if (store.isUnlocked()) store.writeTouchIdHint();
            store.lock();
            if (release) {
                release();
                release = null;
            }
        }
        humanAuth.reset();
        return {
            ok: false,
            error: "Touch ID unlock is unavailable. Enter the master password."
        };
    }
}, true);

// Answers a NEED_PASSWORD refusal: verifies the master password in memory without changing
// the vault, then the renderer retries the action within the grace window.
handle("confirmHuman", pw => humanAuth.confirmPassword(pw));

handle("lock", () => {
    lock();
    return {
        ok: true
    };
});

handle("projects", () => store.listProjects());

handle("createProject", name => store.createProject(name));

handle("deleteProject", id => store.deleteProject(id));

handle("secrets", project => store.listSecrets(project));

handle("setSecret", (project, secret) => store.setSecret(project, secret));

handle("deleteSecret", (project, key) => store.deleteSecret(project, key));

handle("reveal", async (project, key) => {
    await gate("reveal a secret value");
    return store.revealSecret(project, key);
});

handle("copy", async (project, key) => {
    await gate("copy a secret value");
    const secret = store.revealSecret(project, key);
    const value = secret.value || secret.password;
    clipboard.writeText(value);
    setTimeout(() => {
        if (clipboard.readText() === value) clipboard.clear();
    }, 3e4);
    return {
        ok: true
    };
});

handle("getSettings", () => store.getSettings());

handle("setSettings", async patch => {
    const current = store.getSettings();
    checkTouchIdPatch(patch, current, humanAuth.available());
    if (weakensSecurity(patch, current)) await gate("change security settings");
    const result = store.setSettings(patch);
    if (autoSync) autoSync.refresh();
    return result;
});

handle("changePassword", async (oldPw, newPw) => {
    await gate("change the master password", {
        password: oldPw
    });
    return store.changePassword(oldPw, newPw);
});

handle("export", async project => {
    const password = store.vault.settings.exportPassword;
    if (!password) return {
        ok: false,
        error: "Set an export password in Settings first"
    };
    await gate("export secret values");
    const result = await dialog.showSaveDialog(win, {
        title: "Export encrypted PDF",
        defaultPath: "vault-export.pdf",
        filters: [ {
            name: "PDF",
            extensions: [ "pdf" ]
        } ]
    });
    if (result.canceled || !result.filePath) return {
        ok: false,
        canceled: true
    };
    if (!humanUnlocked) throw new Error("Vault is locked");
    if (result.filePath === store.dataDir || result.filePath.startsWith(store.dataDir + path.sep)) throw new Error("Export outside the vault data directory");
    await require("./export").exportProjectPdf(store.exportData(project), result.filePath, password, (new Date).toISOString());
    return {
        ok: true
    };
});

const agents = () => new Agents(store);

handle("agents", () => agents().list());

handle("enrolAgent", async (name, scopes, projects, roots, wildcards) => {
    await gate("enrol an agent");
    return agents().enrol(name, scopes, projects, roots, wildcards);
});

handle("reissueAgent", async id => {
    await gate("issue an agent token");
    return agents().reissue(id);
});

handle("revokeAgent", async id => {
    await gate("revoke an agent");
    return agents().revoke(id);
});

handle("setAgentScopes", async (id, scopes) => {
    await gate("change agent scopes");
    return agents().setScopes(id, scopes);
});

handle("setAgentAccess", async (id, projects, roots, wildcards) => {
    await gate("change agent access");
    return agents().setAccess(id, projects, roots, wildcards);
});

handle("chooseFolder", async () => {
    const r = await dialog.showOpenDialog(win, {
        properties: [ "openDirectory" ]
    });
    return r.canceled ? null : fs.realpathSync(r.filePaths[0]);
});

handle("allScopes", () => M.ALL_SCOPES);

handle("delegate", async (...args) => {
    await gate("delegate a key to an agent");
    return store.delegate(...args);
});

handle("adopt", async (...args) => {
    await gate("adopt an agent's key");
    return store.adopt(...args);
});

handle("approveInject", async (...args) => {
    await gate("approve keys for .env");
    return store.approveInject(...args);
});

handle("pending", () => store.pendingApprovals());

handle("history", limit => store.listHistory(limit));

handle("revert", id => store.revert(id));

handle("audit", limit => store.readAudit(limit));

const sync = () => new (require("./sync").Sync)(store, syncRepo(store));

handle("syncStatus", () => ({
    ...sync().statusRemote(),
    autoSync: autoSync ? autoSync.status() : null
}));

handle("syncPush", () => {
    const r = sync().pushRemote();
    if (autoSync && r.delivered) autoSync.clearHalt();
    return r;
});

handle("syncPull", accept => {
    const r = sync().pullRemote({
        acceptConflicts: accept === true
    });
    if (autoSync) autoSync.clearHalt();
    return {
        added: r.added.map(p => ({
            project: p.projectName,
            key: p.record.key
        })),
        updated: r.updated.map(p => ({
            project: p.projectName,
            key: p.record.key
        })),
        deleted: r.deleted,
        conflicts: r.conflicts,
        unchanged: r.unchanged
    };
});

handle("syncInit", label => sync().init(label));

handle("syncIdentity", () => sync().identity());

handle("syncTrust", async identity => {
    await gate("trust a sync peer");
    return sync().trustMachine(identity);
});

handle("quit", () => app.quit(), true);

function window() {
    humanUnlocked = false;
    win = new BrowserWindow({
        width: 480,
        height: 740,
        minWidth: 380,
        minHeight: 500,
        title: "VaultOS Preview",
        backgroundColor: "#0d0d0d",
        show: false,
        ...process.platform === "darwin" ? {
            titleBarStyle: "hiddenInset",
            trafficLightPosition: {
                x: 14,
                y: 18
            }
        } : {},
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            devTools: !app.isPackaged
        }
    });
    win.webContents.setWindowOpenHandler(() => ({
        action: "deny"
    }));
    win.webContents.on("will-navigate", e => e.preventDefault());
    win.webContents.on("will-attach-webview", e => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.loadURL(URL_HOME);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
        win = null;
        lock({
            forget: false
        });
    });
}

if (!app.requestSingleInstanceLock()) app.quit(); else {
    app.on("second-instance", () => {
        if (!win) window(); else {
            win.show();
            win.focus();
        }
    });
    app.whenReady().then(async () => {
        protocol.handle("vaultos-preview", request => {
            const u = new URL(request.url);
            const relative = decodeURIComponent(u.pathname).slice(1);
            const root = path.join(__dirname, "renderer");
            const file = path.resolve(root, relative);
            if (u.host !== "app" || !file.startsWith(root + path.sep) || !/\.(html|js|css|woff2|png)$/.test(file)) return new Response(null, {
                status: 404
            });
            try {
                const types = {
                    ".html": "text/html",
                    ".js": "text/javascript",
                    ".css": "text/css",
                    ".woff2": "font/woff2",
                    ".png": "image/png"
                };
                return new Response(fs.readFileSync(file), {
                    headers: {
                        "content-type": types[path.extname(file)],
                        "content-security-policy": csp,
                        "cache-control": "no-store"
                    }
                });
            } catch {
                return new Response(null, {
                    status: 404
                });
            }
        });
        powerMonitor.on("lock-screen", () => autoLock("screen"));
        powerMonitor.on("suspend", () => autoLock("suspend"));
        if (backendOnly) {
            if (app.dock) app.dock.hide();
            await own();
            if (store.autoUnlock()) await serve(); else app.quit();
        } else window();
        app.on("activate", () => {
            if (!win) window();
        });
    }).catch(() => {
        process.stderr.write("VaultOS could not start. Close other preview instances and retry.\n");
        app.quit();
    });
}

app.on("before-quit", () => lock({
    forget: false
}));

app.on("window-all-closed", () => app.quit());

process.on("exit", () => {
    store.clearSession();
    if (release) release();
});

for (const sig of [ "SIGINT", "SIGTERM", "SIGHUP" ]) process.on(sig, () => app.quit());
