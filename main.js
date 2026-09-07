"use strict";

const {app: app, BrowserWindow: BrowserWindow, ipcMain: ipcMain, dialog: dialog, protocol: protocol, powerMonitor: powerMonitor, clipboard: clipboard} = require("electron");

const fs = require("node:fs");

const path = require("node:path");

const {Store: Store} = require("./store");

const {Agents: Agents} = require("./agents");

const {startApi: startApi} = require("./api");

const {requestShutdown: requestShutdown, claim: claim} = require("./session");

const {safeEqual: safeEqual} = require("./crypto");

const {defaultDataDir: defaultDataDir} = require("./paths");

const {PROVIDERS: PROVIDERS} = require("./providers");

const M = require("./model");

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

let win, api, release, humanUnlocked = false, timer, failed = 0, retryAt = 0;

const URL_HOME = "vaultos-preview://app/index.html";

const backendOnly = process.argv.includes("--backend");

const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

function lock({forget: forget = true} = {}) {
    humanUnlocked = false;
    clearTimeout(timer);
    if (forget) {
        try {
            store.blockAutoUnlock();
        } catch {}
        try {
            store.keyring.clear();
        } catch {}
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

function touch() {
    clearTimeout(timer);
    if (humanUnlocked) timer = setTimeout(() => lock(), 15 * 60 * 1e3);
}

async function own() {
    if (release) return;
    if (!await requestShutdown(store.sessionPath)) throw new Error("Close the other VaultOS Preview instance before unlocking");
    release = claim(store.dataDir);
}

async function serve() {
    if (!api) {
        api = await startApi(store);
        store.writeSession(api.port, api.token);
    }
}

function handle(channel, fn, publicCall = false) {
    ipcMain.handle("vault:" + channel, async (event, ...args) => {
        if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== URL_HOME) throw new Error("Untrusted IPC sender");
        if (!publicCall && (!humanUnlocked || !store.isUnlocked())) throw new Error("Vault is locked");
        if (!publicCall) touch();
        try {
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
    dataDir: store.dataDir
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
        humanUnlocked = true;
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

handle("reveal", (project, key) => store.revealSecret(project, key));

handle("copy", (project, key) => {
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

handle("setSettings", patch => store.setSettings(patch));

handle("changePassword", (oldPw, newPw) => store.changePassword(oldPw, newPw));

handle("export", async project => {
    const password = store.vault.settings.exportPassword;
    if (!password) return {
        ok: false,
        error: "Set an export password in Settings first"
    };
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

handle("enrolAgent", (name, scopes, projects, roots) => agents().enrol(name, scopes, projects, roots));

handle("reissueAgent", id => agents().reissue(id));

handle("revokeAgent", id => agents().revoke(id));

handle("setAgentScopes", (id, scopes) => agents().setScopes(id, scopes));

handle("setAgentAccess", (id, projects, roots) => agents().setAccess(id, projects, roots));

handle("chooseFolder", async () => {
    const r = await dialog.showOpenDialog(win, {
        properties: [ "openDirectory" ]
    });
    return r.canceled ? null : fs.realpathSync(r.filePaths[0]);
});

handle("allScopes", () => M.ALL_SCOPES);

handle("delegate", (...args) => store.delegate(...args));

handle("adopt", (...args) => store.adopt(...args));

handle("approveInject", (...args) => store.approveInject(...args));

handle("pending", () => store.pendingApprovals());

handle("history", limit => store.listHistory(limit));

handle("revert", id => store.revert(id));

handle("audit", limit => store.readAudit(limit));

const sync = () => new (require("./sync").Sync)(store, process.env.VAULTOS_SYNC_REPO || path.join(store.dataDir, "sync-repository"));

handle("syncStatus", () => sync().statusRemote());

handle("syncPush", () => sync().pushRemote());

handle("syncPull", accept => {
    const r = sync().pullRemote({
        acceptConflicts: accept === true
    });
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

handle("syncTrust", identity => sync().trustMachine(identity));

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
        powerMonitor.on("lock-screen", () => lock());
        powerMonitor.on("suspend", () => lock());
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
