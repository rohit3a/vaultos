"use strict";

const crypto = require("node:crypto");

const SCRYPT = {
    N: 1 << 17,
    r: 8,
    p: 1,
    keylen: 32
};

function deriveKey(password, salt, legacy = false) {
    return crypto.scryptSync(password, salt, SCRYPT.keylen, {
        N: legacy ? 1 << 15 : SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        maxmem: 256 * 1024 * 1024
    });
}

function encryptVault(obj, password) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(password, salt);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
    const ciphertext = Buffer.concat([ cipher.update(plaintext), cipher.final() ]);
    const tag = cipher.getAuthTag();
    return {
        v: 2,
        kdf: "scrypt",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: ciphertext.toString("base64")
    };
}

function decryptVault(envelope, password) {
    if (!envelope || ![ 1, 2 ].includes(envelope.v) || envelope.kdf !== "scrypt") throw new Error("Unsupported vault encryption format");
    const fields = {
        salt: 16,
        iv: 12,
        tag: 16,
        data: null
    };
    for (const [field, size] of Object.entries(fields)) {
        const value = envelope[field];
        if (typeof value !== "string" || value.length > 48 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid encrypted vault");
        const decoded = Buffer.from(value, "base64");
        if (decoded.toString("base64") !== value || size && decoded.length !== size) throw new Error("Invalid encrypted vault");
    }
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const data = Buffer.from(envelope.data, "base64");
    const key = deriveKey(password, salt, envelope.v === 1);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([ decipher.update(data), decipher.final() ]);
    return JSON.parse(plaintext.toString("utf8"));
}

function canonicalize(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value === "object") {
        const out = Object.create(null);
        for (const k of Object.keys(value).sort()) {
            const v = canonicalize(value[k]);
            if (v === "" || Array.isArray(v) && v.length === 0) continue;
            out[k] = v;
        }
        return out;
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function contentHash(value) {
    return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function newSigningKey() {
    const {publicKey: publicKey, privateKey: privateKey} = crypto.generateKeyPairSync("ed25519");
    return {
        privateKey: privateKey.export({
            type: "pkcs8",
            format: "pem"
        }),
        publicKey: publicKey.export({
            type: "spki",
            format: "pem"
        })
    };
}

function publicKeyOf(privateKeyPem) {
    const key = crypto.createPrivateKey(privateKeyPem);
    return crypto.createPublicKey(key).export({
        type: "spki",
        format: "pem"
    });
}

function sign(privateKeyPem, payload) {
    const data = Buffer.from(typeof payload === "string" ? payload : canonicalJson(payload), "utf8");
    return crypto.sign(null, data, crypto.createPrivateKey(privateKeyPem)).toString("base64");
}

function verify(publicKeyPem, payload, signatureB64) {
    const data = Buffer.from(typeof payload === "string" ? payload : canonicalJson(payload), "utf8");
    try {
        return crypto.verify(null, data, crypto.createPublicKey(publicKeyPem), Buffer.from(signatureB64, "base64"));
    } catch {
        return false;
    }
}

function safeEqual(a, b) {
    const A = Buffer.from(String(a || ""), "utf8");
    const B = Buffer.from(String(b || ""), "utf8");
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
}

const randomId = () => crypto.randomBytes(8).toString("hex");

const randomToken = () => crypto.randomBytes(32).toString("hex");

const sha256 = s => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

module.exports = {
    encryptVault: encryptVault,
    decryptVault: decryptVault,
    canonicalize: canonicalize,
    canonicalJson: canonicalJson,
    contentHash: contentHash,
    newSigningKey: newSigningKey,
    publicKeyOf: publicKeyOf,
    sign: sign,
    verify: verify,
    safeEqual: safeEqual,
    randomId: randomId,
    randomToken: randomToken,
    sha256: sha256
};
