#!/usr/bin/env node
"use strict";

const fs = require("node:fs"), path = require("node:path");

const {Store: Store} = require("./store"), {passwordPrompt: passwordPrompt} = require("./prompt"), {claim: claim} = require("./session");

const {atomicWrite: atomicWrite, privateDir: privateDir, regularFile: regularFile} = require("./fs-safe");

async function main() {
    const args = process.argv.slice(2).filter(x => x !== "--password-stdin");
    const [command, ...rest] = args;
    if (!command || command === "help") {
        console.log(`VaultOS Preview — local recovery and optional encrypted sync\n  node cli.cjs projects\n  node cli.cjs keys <project>\n  node cli.cjs inject <project> <absolute-file> [dotenv|json|shell]\n  node cli.cjs backup <absolute-directory>\n  node cli.cjs sync init <machine-label>\n  node cli.cjs sync identity\n  node cli.cjs sync trust <peer-identity.json>\n  node cli.cjs sync status|push|pull|plan|accept-conflicts\nSet VAULTOS_DATA_DIR / VAULTOS_SYNC_REPO to use non-default preview directories.\nPassword input is hidden. --password-stdin is available for controlled automation.\nQuit the preview app before CLI mutations. This tool never prints secret values.`);
        return;
    }
    const store = new Store;
    if (command === "backup") {
        const target = rest[0];
        if (!target || !path.isAbsolute(target)) throw new Error("Specify an absolute backup directory");
        privateDir(target);
        regularFile(store.vaultPath);
        atomicWrite(path.join(target, "vault.enc"), fs.readFileSync(store.vaultPath));
        console.log("Encrypted vault backed up. Passwords and machine credentials were not copied.");
        return;
    }
    const release = claim(store.dataDir);
    process.on("exit", release);
    try {
        store.unlock(await passwordPrompt());
        if (command === "projects") console.log(JSON.stringify(store.listProjects(), null, 2)); else if (command === "keys") console.log(JSON.stringify(store.listSecrets(rest[0]), null, 2)); else if (command === "inject") console.log(JSON.stringify(store.inject(rest[0], rest[1], rest[2] || "dotenv", {
            merge: false
        }))); else if (command === "sync") {
            const sync = new (require("./sync").Sync)(store, process.env.VAULTOS_SYNC_REPO || path.join(store.dataDir, "sync-repository"));
            let result;
            switch (rest[0]) {
              case "init":
                result = sync.init(rest[1]);
                break;

              case "identity":
                result = sync.identity();
                break;

              case "trust":
                regularFile(rest[1], {
                    maxBytes: 16384
                });
                result = sync.trustMachine(JSON.parse(fs.readFileSync(rest[1])));
                break;

              case "status":
                result = sync.statusRemote();
                if (result.state !== "IN_SYNC") process.exitCode = 2;
                break;

              case "push":
                result = sync.pushRemote();
                if (!result.delivered) process.exitCode = 2;
                break;

              case "plan":
                {
                    const p = sync.pull({
                        apply: false
                    });
                    result = {
                        added: p.added.map(x => ({
                            project: x.projectName,
                            key: x.record.key
                        })),
                        updated: p.updated.map(x => ({
                            project: x.projectName,
                            key: x.record.key
                        })),
                        deleted: p.deleted,
                        conflicts: p.conflicts
                    };
                    break;
                }

              case "pull":
              case "accept-conflicts":
                {
                    const p = sync.pullRemote({
                        acceptConflicts: rest[0] === "accept-conflicts"
                    });
                    result = {
                        added: p.added.length,
                        updated: p.updated.length,
                        deleted: p.deleted.length,
                        conflicts: p.conflicts
                    };
                    break;
                }

              default:
                throw new Error("Unknown sync command");
            }
            console.log(JSON.stringify(result, null, 2));
        } else throw new Error("Unknown command. Run: node cli.cjs help");
    } finally {
        store.lock();
        release();
    }
}

main().catch(e => {
    console.error(e instanceof SyntaxError ? "Invalid file format" : e.code ? "File operation failed; check permissions and paths" : e.message);
    process.exitCode = 1;
});
