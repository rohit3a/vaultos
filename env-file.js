"use strict";

const fs = require("node:fs");

const path = require("node:path");

const dotenv = require("dotenv");

const {regularFile: regularFile, atomicWrite: atomicWrite} = require("./fs-safe");

function writeEnv(target, pairs, format, merge) {
    if (!path.isAbsolute(target)) throw new Error("Target must be absolute");
    if (![ "dotenv", "shell", "json" ].includes(format)) throw new Error("Unsupported export format");
    regularFile(target, {
        optional: true,
        maxBytes: 1024 * 1024
    });
    let previous = "";
    if (merge && fs.existsSync(target)) previous = fs.readFileSync(target, "utf8");
    let result;
    if (format === "json") {
        const base = previous ? JSON.parse(previous) : {};
        if (!base || Array.isArray(base) || typeof base !== "object") throw new Error("Existing JSON must be an object");
        for (const [k, v] of pairs) Object.defineProperty(base, k, {
            value: v,
            writable: true,
            configurable: true,
            enumerable: true
        });
        result = JSON.stringify(base, null, 2) + "\n";
    } else {
        for (const [k] of pairs) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error("Use JSON for keys that are not environment variable names");
        if (format === "shell" && previous) throw new Error("Shell exports require merge=false");
        const values = {
            ...previous ? dotenv.parse(previous) : {},
            ...Object.fromEntries(pairs)
        };
        result = Object.entries(values).map(([k, v]) => {
            if (format === "shell") return `export ${k}='${String(v).replace(/'/g, "'\\''")}'`;
            const quote = [ "'", '"', "`" ].find(q => !v.includes(q) && (q !== '"' || !/[\\\r\n]/.test(v)));
            if (!quote) throw new Error("Value cannot be represented losslessly as dotenv; use JSON");
            return `${k}=${quote}${v}${quote}`;
        }).join("\n") + "\n";
        if (format === "dotenv") {
            const parsed = dotenv.parse(result);
            for (const [k, v] of Object.entries(values)) if (parsed[k] !== v) throw new Error("Value cannot be represented losslessly as dotenv; use JSON");
        }
    }
    fs.mkdirSync(path.dirname(target), {
        recursive: true,
        mode: 448
    });
    atomicWrite(target, result);
}

module.exports = {
    writeEnv: writeEnv
};
