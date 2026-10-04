"use strict";

const fs = require("node:fs");

const path = require("node:path");

const {parseArgs: parseArgs} = require("node:util");

const {Store: Store} = require("./store");

const {Agents: Agents} = require("./agents");

const {claim: claim, requestShutdown: requestShutdown} = require("./session");

const {passwordPrompt: passwordPrompt} = require("./prompt");

const {atomicWrite: atomicWrite} = require("./fs-safe");

const {DEFAULT_SCOPES: DEFAULT_SCOPES} = require("./model");

const approvals = require("./approvals");

const COMMANDS = [ "agents", "pending", "approver", "rotate-password" ];

const HELP = `Admin commands (human only; each asks for the master password):
  node cli.cjs agents list
  node cli.cjs agents enroll NAME --token-file PATH [--scopes a,b] [--projects A,B | --all-projects] [--roots DIR,DIR | --any-root]
  node cli.cjs agents grant NAME [--scopes a,b] [--projects A,B | --all-projects | --no-projects] [--roots DIR | --any-root | --no-roots]
  node cli.cjs agents revoke NAME
  node cli.cjs pending list
  node cli.cjs pending approve PROJECT KEY | --all [--project P]
  node cli.cjs pending deny PROJECT KEY
  node cli.cjs approver set --token-file PATH | clear | status
  node cli.cjs rotate-password
Add --stop-backend to stop a running headless backend first (quit the desktop app yourself).
With --password-stdin, stdin holds the master password; rotate-password reads the new one from the next line.`;

const OPTIONS = {
    "token-file": {
        type: "string"
    },
    scopes: {
        type: "string"
    },
    projects: {
        type: "string",
        multiple: true
    },
    roots: {
        type: "string",
        multiple: true
    },
    project: {
        type: "string"
    },
    "all-projects": {
        type: "boolean"
    },
    "any-root": {
        type: "boolean"
    },
    "no-projects": {
        type: "boolean"
    },
    "no-roots": {
        type: "boolean"
    },
    all: {
        type: "boolean"
    },
    "stop-backend": {
        type: "boolean"
    }
};

const list = values => (values || []).flatMap(x => x.split(",")).map(x => x.trim()).filter(Boolean);

async function readStdinLines() {
    let input = "";
    for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 8192) throw new Error("Password input too long");
    }
    return input.split(/\r?\n/);
}

async function passwords(count) {
    if (process.argv.includes("--password-stdin")) {
        const lines = await readStdinLines();
        if (lines.length < count || lines.slice(0, count).some(x => !x)) throw new Error(`Expected ${count} password line(s) on stdin`);
        return lines.slice(0, count);
    }
    const out = [ await passwordPrompt("Master password: ") ];
    if (count > 1) {
        const next = await passwordPrompt("New master password: ");
        if (await passwordPrompt("Confirm new password: ") !== next) throw new Error("The new passwords do not match");
        out.push(next);
    }
    return out;
}

async function own(store, stopBackend) {
    try {
        return claim(store.dataDir);
    } catch (e) {
        if (!/owns this vault/.test(e.message)) throw e;
        if (!stopBackend) throw new Error("VaultOS is running. Quit the desktop app, or pass --stop-backend to stop a headless backend, then retry");
        if (!await requestShutdown(store.sessionPath)) throw new Error("The running VaultOS owner did not stop; quit the desktop app and retry");
        return claim(store.dataDir);
    }
}

function prepareTokenFile(file) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("--token-file must be an absolute path");
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {
        recursive: true,
        mode: 448
    });
    if (!fs.statSync(dir).isDirectory()) throw new Error("The token file's parent must be a directory");
    fs.accessSync(dir, fs.constants.W_OK);
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error("The token file path must be a regular file");
}

function writeToken(file, token) {
    atomicWrite(file, token + "\n");
    fs.chmodSync(file, 384);
}

function agentFor(registry, name) {
    const agent = name && (registry.byName(name) || registry.find(name));
    if (!agent) throw new Error("Agent not found");
    return agent;
}

function accessChange(v, current = null) {
    if (v["all-projects"] && (v.projects || v["no-projects"])) throw new Error("Use either --all-projects or --projects/--no-projects");
    if (v["any-root"] && (v.roots || v["no-roots"])) throw new Error("Use either --any-root or --roots/--no-roots");
    const projectsGiven = !!(v["all-projects"] || v.projects || v["no-projects"]);
    const rootsGiven = !!(v["any-root"] || v.roots || v["no-roots"]);
    return {
        changed: projectsGiven || rootsGiven,
        projects: projectsGiven ? list(v.projects) : current ? current.projects || [] : [],
        roots: rootsGiven ? list(v.roots) : current ? current.roots || [] : [],
        wildcards: {
            allProjects: projectsGiven ? !!v["all-projects"] : !!(current && current.allProjects === true),
            anyRoot: rootsGiven ? !!v["any-root"] : !!(current && current.anyRoot === true)
        }
    };
}

function summary(registry, id) {
    return registry.list().find(a => a.id === id);
}

async function runAdmin(argv) {
    const [command, sub, ...rest] = argv;
    const {values: v, positionals: args} = parseArgs({
        args: command === "rotate-password" ? [ sub, ...rest ].filter(x => x !== undefined) : rest,
        options: OPTIONS,
        allowPositionals: true,
        strict: true
    });
    const store = new Store;
    if (!store.exists()) throw new Error("No vault exists in this data directory");
    const release = await own(store, v["stop-backend"]);
    process.on("exit", release);
    try {
        if (command === "rotate-password") {
            const [current, next] = await passwords(2);
            if (current === next) throw new Error("The new password must differ from the current one");
            const result = store.changePassword(current, next);
            return {
                ...result,
                note: "Restart any VaultOS backend so it uses the new password."
            };
        }
        store.unlock((await passwords(1))[0]);
        const registry = new Agents(store);
        const key = `${command} ${sub}`;
        switch (key) {
          case "agents list":
            return registry.list();

          case "agents enroll":
          case "agents enrol":
            {
                const name = args[0];
                if (!name) throw new Error("usage: node cli.cjs agents enroll NAME --token-file PATH");
                if (!v["token-file"]) throw new Error("--token-file PATH is required; the token is never printed");
                prepareTokenFile(v["token-file"]);
                const scopes = v.scopes === undefined ? undefined : list([ v.scopes ]);
                const existing = registry.byName(name);
                let id, reissued = false, token;
                if (existing) {
                    const access = accessChange(v, existing);
                    if (access.changed) registry.setAccess(existing.id, access.projects, access.roots, access.wildcards);
                    if (scopes !== undefined) registry.setScopes(existing.id, scopes);
                    ({token: token, id: id} = registry.reissue(existing.id));
                    reissued = true;
                } else {
                    const access = accessChange(v);
                    ({token: token, id: id} = registry.enrol(name, scopes === undefined ? [ ...DEFAULT_SCOPES ] : scopes, access.projects, access.roots, access.wildcards));
                }
                writeToken(v["token-file"], token);
                store.audit(reissued ? "reissue_agent" : "enrol_agent", `${name} via admin CLI`);
                return {
                    ...summary(registry, id),
                    tokenFile: v["token-file"],
                    reissued: reissued
                };
            }

          case "agents grant":
            {
                const agent = agentFor(registry, args[0]);
                const access = accessChange(v, agent);
                if (!access.changed && v.scopes === undefined) throw new Error("Specify --scopes, --projects/--all-projects/--no-projects or --roots/--any-root/--no-roots");
                if (access.changed) registry.setAccess(agent.id, access.projects, access.roots, access.wildcards);
                if (v.scopes !== undefined) registry.setScopes(agent.id, list([ v.scopes ]));
                store.audit("grant_agent", `${agent.name} via admin CLI`);
                return summary(registry, agent.id);
            }

          case "agents revoke":
            {
                const agent = agentFor(registry, args[0]);
                registry.revoke(agent.id);
                store.audit("revoke_agent", `${agent.name} via admin CLI`);
                return summary(registry, agent.id);
            }

          case "pending list":
            return store.pendingApprovals();

          case "pending approve":
            if (v.all) return approvals.approveAll(store, "admin CLI", v.project || null);
            if (args.length < 2) throw new Error("usage: node cli.cjs pending approve PROJECT KEY | --all [--project P]");
            return approvals.approve(store, args[0], args[1], "admin CLI");

          case "pending deny":
            if (args.length < 2) throw new Error("usage: node cli.cjs pending deny PROJECT KEY");
            return approvals.deny(store, args[0], args[1], "admin CLI");

          case "approver set":
            if (!v["token-file"]) throw new Error("--token-file PATH is required; the approver secret is never printed");
            prepareTokenFile(v["token-file"]);
            {
                const token = approvals.issueApproverToken(store);
                writeToken(v["token-file"], token);
                return {
                    approverConfigured: true,
                    tokenFile: v["token-file"]
                };
            }

          case "approver clear":
            return approvals.setApproverHash(store, null);

          case "approver status":
            return {
                approverConfigured: approvals.approverConfigured(store)
            };

          default:
            throw new Error(`Unknown admin command.\n${HELP}`);
        }
    } finally {
        store.lock();
        release();
    }
}

module.exports = {
    COMMANDS: COMMANDS,
    HELP: HELP,
    runAdmin: runAdmin
};
