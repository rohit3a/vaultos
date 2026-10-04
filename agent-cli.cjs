#!/usr/bin/env node
"use strict";

const path = require("node:path");

const {parseArgs: parseArgs} = require("node:util");

const {VaultClient: VaultClient} = require("./agent-client");

const HELP = `vaultos-agent — VaultOS for enrolled agents (values are never printed)

  vaultos-agent status                       is VaultOS running and unlocked?
  vaultos-agent whoami                       this agent's identity and grants
  vaultos-agent projects                     approved projects
  vaultos-agent keys PROJECT                 key names and metadata
  vaultos-agent search TEXT                  find keys across approved projects
  vaultos-agent inject PROJECT FILE [--keys A,B] [--format dotenv|json|shell] [--replace]
                                             write approved keys into FILE (merges by default)
  printf %s "$VALUE" | vaultos-agent add PROJECT KEY [--note N] [--provider P]
                                             store a key; the value is read from stdin only
  vaultos-agent import PROJECT ENV_FILE [--create-project]
                                             store every KEY=VALUE from an env file
  vaultos-agent sync                         explain how sync runs (owner-only)
  vaultos-agent pending                      agent-created keys awaiting human approval

Token: VAULTOS_AGENT_TOKEN, VAULTOS_AGENT_TOKEN_FILE (mode 0600), or VAULTOS_AGENT=NAME
for <data dir>/agents/NAME.token. VAULTOS_DATA_DIR selects a non-default data directory.`;

const EXIT = {
    usage: 2,
    not_running: 3,
    locked: 4,
    token: 5
};

class Usage extends Error {}

const print = o => process.stdout.write((typeof o === "string" ? o : JSON.stringify(o, null, 2)) + "\n");

async function readStdin() {
    if (process.stdin.isTTY) throw new Usage(`pipe the value on stdin, e.g. printf %s "$VALUE" | vaultos-agent add PROJECT KEY`);
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 65536) throw new Error("Value is too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function parse(argv) {
    return parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            keys: {
                type: "string"
            },
            format: {
                type: "string"
            },
            replace: {
                type: "boolean"
            },
            note: {
                type: "string"
            },
            provider: {
                type: "string"
            },
            "create-project": {
                type: "boolean"
            },
            help: {
                type: "boolean",
                short: "h"
            }
        }
    });
}

async function run(argv, client = new VaultClient) {
    const [command, ...rest] = argv;
    if (!command || [ "help", "--help", "-h" ].includes(command)) return print(HELP);
    let parsed;
    try {
        parsed = parse(rest);
    } catch (e) {
        throw new Usage(e.message);
    }
    const {values: v, positionals: args} = parsed;
    const need = (n, usage) => {
        if (args.length < n) throw new Usage(`usage: ${usage}`);
    };
    const enc = encodeURIComponent;
    switch (command) {
      case "status":
        return print(await client.status());

      case "whoami":
        return print(await client.request("GET", "/whoami"));

      case "projects":
        return print(await client.request("GET", "/projects"));

      case "keys":
        need(1, "vaultos-agent keys PROJECT");
        return print(await client.request("GET", `/projects/${enc(args[0])}/secrets`));

      case "search":
        need(1, "vaultos-agent search TEXT");
        return print(await client.request("GET", `/search?q=${enc(args.join(" "))}`));

      case "pending":
        return print(await client.request("GET", "/pending"));

      case "inject":
        {
            need(2, "vaultos-agent inject PROJECT FILE [--keys A,B] [--format dotenv|json|shell] [--replace]");
            const format = v.format || "dotenv";
            if (![ "dotenv", "json", "shell" ].includes(format)) throw new Usage("--format must be dotenv, json or shell");
            const keys = v.keys === undefined ? null : v.keys.split(",").map(k => k.trim()).filter(Boolean);
            const r = await client.request("POST", "/inject", {
                project: args[0],
                target_path: path.resolve(args[1]),
                format: format,
                merge: !v.replace,
                keys: keys
            });
            return print({
                project: r.project,
                file: r.target,
                format: r.format,
                wrote: r.count,
                ...r.heldForApproval && r.heldForApproval.length ? {
                    heldForApproval: r.heldForApproval
                } : {}
            });
        }

      case "add":
        {
            need(2, `printf %s "$VALUE" | vaultos-agent add PROJECT KEY [--note N] [--provider P]`);
            if (args.length > 2) throw new Usage("The value is read from stdin only; never pass it as an argument");
            const value = await readStdin();
            if (!value) throw new Usage("No value was received on stdin");
            const r = await client.request("POST", `/projects/${enc(args[0])}/secrets`, {
                key: args[1],
                value: value,
                ...v.note !== undefined ? {
                    note: v.note
                } : {},
                ...v.provider !== undefined ? {
                    provider: v.provider
                } : {}
            });
            return print({
                project: args[0],
                stored: r.key,
                owner: r.owner,
                injectApproved: r.injectApproved
            });
        }

      case "import":
        need(2, "vaultos-agent import PROJECT ENV_FILE [--create-project]");
        return print(await client.request("POST", "/import", {
            project: args[0],
            env_path: path.resolve(args[1]),
            ...v["create-project"] ? {
                createProject: true
            } : {}
        }));

      case "sync":
        try {
            return print(await client.request("POST", "/sync"));
        } catch (e) {
            if (e.status === 404) throw new Error("This VaultOS owner has no sync route. Ask the human to run sync from the desktop or `node cli.cjs sync push|pull`.");
            if (e.status === 403) throw new Error("Sync is an owner action, not an agent permission. Autosync runs in the owner when enabled; a human can run `node cli.cjs sync now`.");
            throw e;
        }

      default:
        throw new Usage(`unknown command '${command}'\n\n${HELP}`);
    }
}

if (require.main === module) {
    run(process.argv.slice(2)).catch(e => {
        process.stderr.write(`vaultos-agent: ${e.message}\n`);
        process.exitCode = e instanceof Usage ? EXIT.usage : EXIT[e.code] || 1;
    });
}

module.exports = {
    run: run
};
