"use strict";

const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");

function privateDir(dir) {
    fs.mkdirSync(dir, {
        recursive: true,
        mode: 448
    });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Symbolic link directories are not allowed");
    fs.chmodSync(dir, 448);
}

function regularFile(file, {optional: optional = false, maxBytes: maxBytes = 32 * 1024 * 1024} = {}) {
    let st;
    try {
        st = fs.lstatSync(file);
    } catch (e) {
        if (optional && e.code === "ENOENT") return null;
        throw e;
    }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("Expected a regular, unlinked file");
    if (st.size > maxBytes) throw new Error("File exceeds the allowed size");
    return st;
}

function atomicWrite(file, content) {
    regularFile(file, {
        optional: true
    });
    const tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + crypto.randomBytes(12).toString("hex"));
    let fd;
    try {
        fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 384);
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        regularFile(file, {
            optional: true
        });
        fs.renameSync(tmp, file);
        const dir = fs.openSync(path.dirname(file), "r");
        try {
            fs.fsyncSync(dir);
        } finally {
            fs.closeSync(dir);
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try {
            fs.unlinkSync(tmp);
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
        }
    }
}

function checkedPath(file, roots) {
    if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw new Error("An absolute file path is required");
    const target = path.resolve(file);
    const root = roots.find(r => target.startsWith(r + path.sep));
    if (!root) throw new Error("This path is outside the folders approved for this agent");
    let p = root;
    if (fs.realpathSync(root) !== root) throw new Error("Approved folder changed; approve it again");
    for (const part of path.relative(root, target).split(path.sep)) {
        p = path.join(p, part);
        try {
            if (fs.lstatSync(p).isSymbolicLink()) throw new Error("Symbolic links are not allowed in file paths");
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
        }
    }
    return target;
}

module.exports = {
    privateDir: privateDir,
    regularFile: regularFile,
    atomicWrite: atomicWrite,
    checkedPath: checkedPath
};
