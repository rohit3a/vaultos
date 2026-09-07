"use strict";

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function text(value, name, max = 256, empty = false) {
    if (typeof value !== "string" || value.length > max || !empty && !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("Invalid " + name);
    return value;
}

function password(value) {
    text(value, "master password", 1024);
    if (value.length < 12) throw new Error("Use at least 12 characters for the master password");
}

function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    for (const k of [ "__proto__", "constructor", "prototype" ]) if (own(value, k)) throw new Error("Reserved object key");
}

function secret(fields) {
    object(fields);
    text(fields.key, "key name");
    if ([ "__proto__", "constructor", "prototype" ].includes(fields.key) || /[\r\n\t]/.test(fields.key)) throw new Error("Invalid key name");
    for (const k of [ "value", "password", "note", "username", "email", "url", "provider", "permission", "expiresAt" ]) {
        if (fields[k] !== undefined) text(fields[k], k, [ "value", "password", "note" ].includes(k) ? 65536 : 2048, true);
    }
    if (fields.expiresAt && !Number.isFinite(Date.parse(fields.expiresAt))) throw new Error("Invalid expiry date");
}

module.exports = {
    text: text,
    password: password,
    object: object,
    secret: secret
};
