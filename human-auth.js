"use strict";

// Optional Touch ID confirmation for the desktop window. All of it is enforced in the main
// process; the renderer only shows buttons and the password fallback dialog.
//
// Human-only actions require a recent proof of presence when touchId.humanActions is on: a
// Touch ID success, a typed master password, or an unlock in the last GRACE_MS. When Touch ID
// cannot be shown or is cancelled, the action fails with NEED_PASSWORD and the renderer asks
// for the master password, which confirmPassword() verifies without changing vault state.
// Locking resets the proof. Electron is injected so this module stays testable without it.

const GRACE_MS = 3e4;

const NEED_PASSWORD = "NEED_PASSWORD";

const TOUCH_ID_KEYS = [ "unlock", "humanActions", "autoPrompt" ];

class HumanAuth {
    constructor({platform: platform = process.platform, canPrompt: canPrompt = () => false, prompt: prompt = () => Promise.reject(new Error("Touch ID is unavailable")), verifyPassword: verifyPassword = () => false, now: now = () => Date.now(), graceMs: graceMs = GRACE_MS} = {}) {
        Object.assign(this, {
            platform: platform,
            canPrompt: canPrompt,
            promptFn: prompt,
            verifyPassword: verifyPassword,
            now: now,
            graceMs: graceMs
        });
        this.lastProof = 0;
        this.epoch = 0;
        this.proving = null;
        this.failed = 0;
        this.retryAt = 0;
    }
    available() {
        if (this.platform !== "darwin") return false;
        try {
            return this.canPrompt() === true;
        } catch {
            return false;
        }
    }
    fresh() {
        return this.lastProof > 0 && this.now() - this.lastProof < this.graceMs;
    }
    markProven() {
        this.lastProof = this.now();
    }
    // Called on every lock, so a proof never outlives the unlocked window that earned it.
    reset() {
        this.lastProof = 0;
        this.epoch++;
        this.proving = null;
    }
    // Shows one Touch ID prompt at a time; concurrent callers share it. A lock while the
    // prompt is open voids its result.
    async prompt(reason) {
        if (!this.available()) throw new Error("Touch ID is not available");
        const epoch = this.epoch;
        if (!this.proving) {
            const p = Promise.resolve().then(() => this.promptFn(reason));
            this.proving = p;
            p.then(() => {}, () => {}).then(() => {
                if (this.proving === p) this.proving = null;
            });
        }
        await this.proving;
        if (epoch !== this.epoch) throw new Error("Vault is locked");
        this.markProven();
    }
    async require(enabled, reason, {password: password} = {}) {
        if (enabled !== true || this.fresh()) return;
        const epoch = this.epoch;
        if (this.available()) {
            try {
                await this.prompt(reason);
                return;
            } catch {
                if (epoch !== this.epoch) throw new Error("Vault is locked");
            }
        }
        // An action that already carries the master password (password rotation) is
        // confirmed by it instead of a second dialog.
        if (password !== undefined && this.confirmPassword(password).ok) return;
        throw new Error(`${NEED_PASSWORD}: Confirm with the master password to ${reason}.`);
    }
    confirmPassword(password) {
        if (this.now() < this.retryAt) return {
            ok: false,
            error: "Wait a moment before trying again"
        };
        let ok = false;
        try {
            ok = typeof password === "string" && password.length <= 1024 && this.verifyPassword(password) === true;
        } catch {}
        if (!ok) {
            this.retryAt = this.now() + Math.min(3e4, 500 * 2 ** Math.min(++this.failed, 6));
            return {
                ok: false,
                error: "Wrong password"
            };
        }
        this.failed = 0;
        this.markProven();
        return {
            ok: true
        };
    }
}

// Whether the lock screen can offer Touch ID. Before decryption the encrypted settings are
// unknown, so a plaintext hint (only "enabled", never secret) decides whether to offer it;
// the decrypted setting is checked again after unlocking. A manual Lock's block means the
// typed password is required (Lock also removes the remembered password).
function touchIdUnlockStatus({available: available, exists: exists, blocked: blocked, unlocked: unlocked, settings: settings, hint: hint}) {
    const t = unlocked ? settings?.touchId || {} : hint || {};
    const enabled = t.unlock === true && (!unlocked || settings?.rememberPassword === true);
    const base = {
        enabled: enabled,
        autoPrompt: enabled && t.autoPrompt === true
    };
    if (!available) return {
        ...base,
        ready: false,
        error: "Touch ID is not available right now. Enter the master password."
    };
    if (!exists || !enabled) return {
        ...base,
        ready: false,
        error: "Touch ID unlock is off. Enter the master password."
    };
    if (blocked) return {
        ...base,
        ready: false,
        error: "After Lock, enter the master password once."
    };
    return {
        ...base,
        ready: true
    };
}

// A settings patch that makes the vault easier to use without the human present.
function weakensSecurity(patch, current) {
    if (!patch || typeof patch !== "object") return false;
    const t = patch.touchId || {}, ct = current.touchId || {};
    return typeof patch.exportPassword === "string" && patch.exportPassword !== "" || patch.rememberPassword === true && current.rememberPassword !== true || patch.lockPolicy === "soft" && current.lockPolicy !== "soft" || patch.autoSync?.enabled === true && current.autoSync?.enabled !== true || t.humanActions === false && ct.humanActions === true || t.unlock === true && ct.unlock !== true || t.autoPrompt === true && ct.autoPrompt !== true;
}

// Turning a Touch ID option on is offered only where Touch ID can prompt and the password is
// remembered (Touch ID unlock reads it from the Keychain). Turning options off always works.
function checkTouchIdPatch(patch, current, available) {
    const t = patch?.touchId;
    if (!t || typeof t !== "object") return;
    const turningOn = TOUCH_ID_KEYS.some(k => t[k] === true && current.touchId?.[k] !== true);
    if (!turningOn) return;
    if (!available) throw new Error("Touch ID is not available on this device");
    const remember = patch.rememberPassword !== undefined ? patch.rememberPassword : current.rememberPassword;
    if (remember !== true) throw new Error("Touch ID needs background access (remembered password) to be on");
}

module.exports = {
    HumanAuth: HumanAuth,
    GRACE_MS: GRACE_MS,
    NEED_PASSWORD: NEED_PASSWORD,
    TOUCH_ID_KEYS: TOUCH_ID_KEYS,
    touchIdUnlockStatus: touchIdUnlockStatus,
    weakensSecurity: weakensSecurity,
    checkTouchIdPatch: checkTouchIdPatch
};
