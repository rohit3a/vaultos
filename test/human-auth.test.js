"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const {HumanAuth: HumanAuth, GRACE_MS: GRACE_MS, touchIdUnlockStatus: touchIdUnlockStatus, weakensSecurity: weakensSecurity, checkTouchIdPatch: checkTouchIdPatch} = require("../human-auth");

const {Store: Store} = require("../store");

const PW = "synthetic-touch-id-password";

// A fake Touch ID sensor and clock. Tests never call Electron or the real Keychain.
function rig({platform: platform = "darwin", canPrompt: canPrompt = true, answer: answer = "ok"} = {}) {
    const r = {
        t: 1e6,
        prompts: [],
        answer: answer,
        canPrompt: canPrompt
    };
    r.auth = new HumanAuth({
        platform: platform,
        canPrompt: () => r.canPrompt,
        prompt: async reason => {
            r.prompts.push(reason);
            const a = typeof r.answer === "function" ? await r.answer() : r.answer;
            if (a !== "ok") throw new Error("User canceled");
        },
        verifyPassword: pw => pw === PW,
        now: () => r.t
    });
    return r;
}

test("Touch ID gating does nothing unless humanActions is on", async () => {
    const r = rig();
    await r.auth.require(false, "reveal a secret value");
    await r.auth.require(undefined, "reveal a secret value");
    assert.deepEqual(r.prompts, []);
});

test("one Touch ID success covers the 30 second grace window, then asks again", async () => {
    const r = rig();
    await r.auth.require(true, "reveal a secret value");
    r.t += GRACE_MS - 1;
    await r.auth.require(true, "copy a secret value");
    assert.deepEqual(r.prompts, [ "reveal a secret value" ]);
    r.t += 1;
    await r.auth.require(true, "copy a secret value");
    assert.equal(r.prompts.length, 2);
});

test("concurrent actions share one Touch ID prompt", async () => {
    const r = rig();
    let finish;
    r.answer = () => new Promise(resolve => finish = () => resolve("ok"));
    const both = Promise.all([ r.auth.require(true, "approve keys for .env"), r.auth.require(true, "approve keys for .env") ]);
    await new Promise(setImmediate);
    finish();
    await both;
    assert.equal(r.prompts.length, 1);
});

test("cancel or failure returns NEED_PASSWORD; the master password confirms without Touch ID", async () => {
    const r = rig({
        answer: "cancel"
    });
    await assert.rejects(r.auth.require(true, "export secret values"), /^Error: NEED_PASSWORD: Confirm with the master password to export secret values\.$/);
    assert.equal(r.prompts.length, 1);
    assert.deepEqual(r.auth.confirmPassword("wrong-password"), {
        ok: false,
        error: "Wrong password"
    });
    // Wrong guesses back off, even if the next guess is right.
    assert.match(r.auth.confirmPassword(PW).error, /Wait/);
    r.t += 3e4;
    assert.deepEqual(r.auth.confirmPassword(PW), {
        ok: true
    });
    await r.auth.require(true, "export secret values");
    assert.equal(r.prompts.length, 1);
    assert.equal(r.auth.confirmPassword(12345).ok, false);
});

test("an action carrying the master password is confirmed by it when Touch ID is not given", async () => {
    const r = rig({
        answer: "cancel"
    });
    await r.auth.require(true, "change the master password", {
        password: PW
    });
    assert(r.auth.fresh());
    r.auth.reset();
    r.t += 3e4;
    await assert.rejects(r.auth.require(true, "change the master password", {
        password: "wrong-password"
    }), /NEED_PASSWORD/);
});

test("locking resets the grace window and voids a prompt that was open", async () => {
    const r = rig();
    await r.auth.require(true, "reveal a secret value");
    r.auth.reset();
    await r.auth.require(true, "reveal a secret value");
    assert.equal(r.prompts.length, 2);
    r.auth.reset();
    let finish;
    r.answer = () => new Promise(resolve => finish = () => resolve("ok"));
    const pending = r.auth.require(true, "reveal a secret value");
    await new Promise(setImmediate);
    r.auth.reset();
    finish();
    await assert.rejects(pending, /Vault is locked/);
    assert.equal(r.auth.fresh(), false);
    // A password confirmation is reset by lock as well.
    assert.equal(r.auth.confirmPassword(PW).ok, true);
    r.auth.reset();
    assert.equal(r.auth.fresh(), false);
});

test("unsupported platforms and unavailable Touch ID never prompt and fall back to the password", async () => {
    for (const r of [ rig({
        platform: "linux"
    }), rig({
        canPrompt: false
    }) ]) {
        assert.equal(r.auth.available(), false);
        await r.auth.require(false, "reveal a secret value");
        await assert.rejects(r.auth.require(true, "reveal a secret value"), /NEED_PASSWORD/);
        await assert.rejects(r.auth.prompt("unlock VaultOS"), /not available/);
        assert.deepEqual(r.prompts, []);
        assert.equal(r.auth.confirmPassword(PW).ok, true);
        await r.auth.require(true, "reveal a secret value");
    }
    const throwing = new HumanAuth({
        platform: "darwin",
        canPrompt: () => {
            throw new Error("no sensor");
        }
    });
    assert.equal(throwing.available(), false);
});

test("Touch ID unlock is offered only when enabled, available and not after a manual Lock", () => {
    const base = {
        available: true,
        exists: true,
        blocked: false,
        unlocked: false,
        settings: null,
        hint: {
            unlock: true,
            autoPrompt: true
        }
    };
    assert.deepEqual(touchIdUnlockStatus(base), {
        enabled: true,
        autoPrompt: true,
        ready: true
    });
    assert.equal(touchIdUnlockStatus({
        ...base,
        hint: {}
    }).ready, false);
    assert.equal(touchIdUnlockStatus({
        ...base,
        available: false
    }).ready, false);
    assert.equal(touchIdUnlockStatus({
        ...base,
        exists: false
    }).ready, false);
    assert.match(touchIdUnlockStatus({
        ...base,
        blocked: true
    }).error, /After Lock/);
    // A window-only (soft) lock reads the decrypted settings instead of the hint.
    const soft = {
        ...base,
        unlocked: true,
        hint: null
    };
    assert.equal(touchIdUnlockStatus({
        ...soft,
        settings: {
            rememberPassword: true,
            touchId: {
                unlock: true
            }
        }
    }).ready, true);
    assert.equal(touchIdUnlockStatus({
        ...soft,
        settings: {
            rememberPassword: false,
            touchId: {
                unlock: true
            }
        }
    }).ready, false);
});

test("security-weakening settings changes are detected against current settings", () => {
    const current = {
        rememberPassword: false,
        lockPolicy: "hard",
        autoSync: {
            enabled: false,
            intervalSeconds: 300
        },
        touchId: {
            unlock: false,
            humanActions: true,
            autoPrompt: false
        }
    };
    const unchanged = {
        rememberPassword: false,
        lockPolicy: "hard",
        autoSync: {
            enabled: false,
            intervalSeconds: 600
        },
        touchId: {
            unlock: false,
            humanActions: true,
            autoPrompt: false
        }
    };
    assert.equal(weakensSecurity(unchanged, current), false);
    assert.equal(weakensSecurity({
        exportPassword: ""
    }, current), false);
    assert.equal(weakensSecurity({
        touchId: {
            humanActions: true
        }
    }, {
        ...current,
        touchId: {}
    }), false);
    for (const patch of [ {
        exportPassword: "synthetic-export-password"
    }, {
        rememberPassword: true
    }, {
        lockPolicy: "soft"
    }, {
        autoSync: {
            enabled: true
        }
    }, {
        touchId: {
            humanActions: false
        }
    }, {
        touchId: {
            unlock: true
        }
    }, {
        touchId: {
            autoPrompt: true
        }
    } ]) assert.equal(weakensSecurity(patch, current), true, JSON.stringify(patch));
});

test("Touch ID options turn on only where available with a remembered password", () => {
    const current = {
        rememberPassword: true,
        touchId: {
            unlock: false,
            humanActions: false,
            autoPrompt: false
        }
    };
    const on = {
        touchId: {
            unlock: true
        }
    };
    assert.throws(() => checkTouchIdPatch(on, current, false), /not available/);
    assert.throws(() => checkTouchIdPatch(on, {
        ...current,
        rememberPassword: false
    }, true), /background access/);
    assert.throws(() => checkTouchIdPatch({
        ...on,
        rememberPassword: false
    }, current, true), /background access/);
    assert.doesNotThrow(() => checkTouchIdPatch(on, current, true));
    assert.doesNotThrow(() => checkTouchIdPatch({
        touchId: {
            unlock: false,
            humanActions: false
        }
    }, {
        rememberPassword: false,
        touchId: {
            unlock: true,
            humanActions: true
        }
    }, false));
});

test("store: Touch ID settings default off, validate, follow remembering and keep a non-secret hint", t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-touchid-test-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const store = new Store(dir);
    let remembered = null;
    store.keyring = {
        get: () => remembered,
        set: pw => {
            remembered = pw;
            return store.keyring.describe();
        },
        clear: () => {
            remembered = null;
        },
        describe: () => ({
            store: "test",
            secure: true,
            detail: "synthetic"
        })
    };
    store.init(PW);
    const hintFile = path.join(dir, "touch-id");
    assert.deepEqual(store.getSettings().touchId, {
        unlock: false,
        humanActions: false,
        autoPrompt: false
    });
    assert.deepEqual(store.touchIdHint(), {
        unlock: false,
        autoPrompt: false
    });
    assert.throws(() => store.setSettings({
        touchId: {
            face: true
        }
    }), /Unknown Touch ID setting/);
    assert.throws(() => store.setSettings({
        touchId: {
            unlock: "yes"
        }
    }), /Invalid Touch ID setting/);
    assert.throws(() => store.setSettings({
        touchId: {
            unlock: true
        }
    }, "agent:x"), /human-only/);
    // autoPrompt means nothing without unlock.
    assert.deepEqual(store.setSettings({
        touchId: {
            autoPrompt: true,
            humanActions: true
        }
    }).touchId, {
        unlock: false,
        humanActions: true,
        autoPrompt: false
    });
    assert.equal(fs.existsSync(hintFile), false);
    store.setSettings({
        rememberPassword: true,
        touchId: {
            unlock: true,
            autoPrompt: true
        }
    });
    assert.deepEqual(store.touchIdHint(), {
        unlock: true,
        autoPrompt: true
    });
    assert.doesNotMatch(fs.readFileSync(hintFile, "utf8"), new RegExp(PW));
    // Unlock with Touch ID cannot outlive the remembered password; confirmations stay on.
    assert.deepEqual(store.setSettings({
        rememberPassword: false
    }).touchId, {
        unlock: false,
        humanActions: true,
        autoPrompt: false
    });
    assert.equal(fs.existsSync(hintFile), false);
    assert.equal(remembered, null);
    // The setting survives a lock and unlock.
    store.lock();
    store.unlock(PW);
    assert.equal(store.getSettings().touchId.humanActions, true);
    assert.equal(store.isAutoUnlockBlocked(), false);
    store.blockAutoUnlock();
    assert.equal(store.isAutoUnlockBlocked(), true);
});
