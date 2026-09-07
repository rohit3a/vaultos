#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { readFileSync } from "node:fs";

import { createHash } from "node:crypto";

import { fileURLToPath } from "node:url";

import { join } from "node:path";

import { homedir, platform } from "node:os";

import { spawn } from "node:child_process";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {defaultDataDir: dataDir} = require("../paths.js");

const {readSession: readSession, probeSession: probeSession} = require("../session.js");

const {regularFile: regularFile} = require("../fs-safe.js");

const SESSION_PATH = join(dataDir(), "session.json");

const AGENT_TOKEN = process.env.VAULTOS_AGENT_TOKEN || readAgentToken();

function readAgentToken() {
    const file = process.env.VAULTOS_AGENT_TOKEN_FILE;
    if (!file) return "";
    try {
        const stat = regularFile(file, {
            maxBytes: 4096
        });
        if ((stat.mode & 63) !== 0) throw new Error("Token file must be private");
        return readFileSync(file, "utf8").trim();
    } catch {
        return "";
    }
}

const SETUP_MSG = "Open VaultOS Preview and unlock it. Background unlocking is available only when you explicitly enable Keychain access in Settings.";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function session() {
    return readSession(SESSION_PATH);
}

function ok(o) {
    return {
        content: [ {
            type: "text",
            text: typeof o === "string" ? o : JSON.stringify(o, null, 2)
        } ]
    };
}

function err(message) {
    return {
        content: [ {
            type: "text",
            text: "Error: " + message
        } ],
        isError: true
    };
}

let launch;

async function ensureUp() {
    if (await probeSession(SESSION_PATH)) return true;
    if (!launch) launch = (async () => {
        const child = spawn(process.execPath, [ fileURLToPath(new URL("../backend.cjs", import.meta.url)) ], {
            detached: true,
            stdio: "ignore"
        });
        let failed = false;
        child.on("error", () => {
            failed = true;
        });
        child.unref();
        for (let i = 0; i < 10 && !failed; i++) {
            await sleep(300);
            if (await probeSession(SESSION_PATH, 200)) return true;
        }
        return false;
    })().finally(() => {
        launch = null;
    });
    return launch;
}

async function call(method, path, body) {
    if (!AGENT_TOKEN) throw new Error("Enroll this agent in VaultOS Preview and configure its private token file");
    if (!await ensureUp()) throw new Error(SETUP_MSG);
    const s = session();
    if (!s) throw new Error(SETUP_MSG);
    let response;
    try {
        response = await fetch(`http://127.0.0.1:${s.port}${path}`, {
            method: method,
            headers: {
                authorization: `Bearer ${s.token}`,
                "x-vault-agent-token": AGENT_TOKEN,
                "content-type": "application/json"
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15e3),
            redirect: "error"
        });
    } catch {
        throw new Error("Connection interrupted. Check the operation result before retrying a write");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Vault operation refused");
    return result;
}

const BRIDGE_VERSION = {
    version: "0.1.0-preview.1"
};

const server = new Server({
    name: "vault-os",
    version: "0.1.0-preview.1"
}, {
    capabilities: {
        tools: {}
    }
});

const TOOLS = [ {
    name: "vault_status",
    description: "Check that the vault backend is reachable, and report what is actually deployed: vault format version, the commit the CLI was installed from, and hashes of the running modules. Use this to tell a stale deployment from a current one.",
    inputSchema: {
        type: "object",
        properties: {}
    }
}, {
    name: "list_projects",
    description: "List all projects in the vault with how many keys each has and which providers (Supabase, Vercel, etc.) are present. Returns names and counts only, never secret values.",
    inputSchema: {
        type: "object",
        properties: {}
    }
}, {
    name: "list_secrets",
    description: "List the key names + metadata for a project: provider, note, permission level, and expiry (expiresAt, expiryStatus = active|expiring|expired, daysLeft). Returns NO values. Use this to see what is available before injecting, and to warn about tokens that are expired or about to expire.",
    inputSchema: {
        type: "object",
        properties: {
            project: {
                type: "string",
                description: "Project name or id"
            }
        },
        required: [ "project" ]
    }
}, {
    name: "create_project",
    description: "Create a new project in the vault.",
    inputSchema: {
        type: "object",
        properties: {
            name: {
                type: "string"
            }
        },
        required: [ "name" ]
    }
}, {
    name: "set_secret",
    description: "Add or update a secret in a project. You may ADD a new key to ANY project — put it where it belongs, next to related keys. You may NOT modify or delete a key owned by the user unless they delegated it to you; that is refused with an explanation. Keys you add are visible immediately but are held back from inject until the user approves them once. Provider is auto-detected from the key name if omitted.",
    inputSchema: {
        type: "object",
        properties: {
            project: {
                type: "string"
            },
            key: {
                type: "string",
                description: "Env var name, e.g. SUPABASE_SERVICE_ROLE_KEY"
            },
            value: {
                type: "string"
            },
            provider: {
                type: "string",
                description: "Provider id (vercel, supabase, anthropic, password, custom, ...). Optional; auto-detected from the key name."
            },
            note: {
                type: "string"
            },
            username: {
                type: "string",
                description: "Account login username (optional)."
            },
            email: {
                type: "string",
                description: "Account login email (optional)."
            },
            password: {
                type: "string",
                description: "Account password stored alongside the key (optional)."
            },
            url: {
                type: "string",
                description: "Account/site URL (optional)."
            },
            permission: {
                type: "string",
                description: "Permission/scope level of the token (optional), e.g. read-only, service_role."
            },
            expires_at: {
                type: "string",
                description: "ISO date when the token expires (optional). list_secrets reports expiryStatus/daysLeft so you can warn before expiry."
            }
        },
        required: [ "project", "key", "value" ]
    }
}, {
    name: "delete_secret",
    description: "Delete a secret from a project by key name.",
    inputSchema: {
        type: "object",
        properties: {
            project: {
                type: "string"
            },
            key: {
                type: "string"
            }
        },
        required: [ "project", "key" ]
    }
}, {
    name: "inject_secrets",
    description: "PREFERRED way to use secrets. The Vault OS app writes a project's secrets into a file on disk itself — the raw values never enter this conversation. Use this to wire up a project's .env. target_path must be absolute. format: dotenv (KEY=value), shell (export KEY=value), or json. By default merges into an existing file, preserving unrelated keys.",
    inputSchema: {
        type: "object",
        properties: {
            project: {
                type: "string"
            },
            target_path: {
                type: "string",
                description: "Absolute path to write, e.g. /absolute/project/.env.local"
            },
            format: {
                type: "string",
                enum: [ "dotenv", "shell", "json" ],
                description: "Default dotenv"
            },
            keys: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "Optional subset of key names to write. Omit to write all."
            },
            merge: {
                type: "boolean",
                description: "Merge into existing file (default true)"
            }
        },
        required: [ "project", "target_path" ]
    }
}, {
    name: "reveal_secret",
    description: "Return one raw secret VALUE into this conversation. Requires the `reveal` scope, which agents do NOT hold by default — expect this to be refused, and prefer inject_secrets, which writes a working file without any value entering the conversation. Ask the user to grant `reveal` in the Vault OS app only when a value genuinely must be seen.",
    inputSchema: {
        type: "object",
        properties: {
            project: {
                type: "string"
            },
            key: {
                type: "string"
            }
        },
        required: [ "project", "key" ]
    }
}, {
    name: "whoami",
    description: "Report which identity this bridge is authenticated as and which scopes it holds. Use this when a write is refused, to see whether this agent is enrolled at all.",
    inputSchema: {
        type: "object",
        properties: {}
    }
}, {
    name: "compare",
    description: "Return hashes for approved projects only. Requires reveal scope because secret-derived hashes can assist guessing attacks; use the desktop sync status for routine checks.",
    inputSchema: {
        type: "object",
        properties: {}
    }
}, {
    name: "list_pending",
    description: "List agent-added keys that are waiting for human approval before they will be written into any .env by inject_secrets. A key you added appears here until the user approves it in the Vault OS app.",
    inputSchema: {
        type: "object",
        properties: {}
    }
}, {
    name: "search",
    description: "Search across projects and key names (and providers). Returns matches without values.",
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string"
            }
        },
        required: [ "query" ]
    }
}, {
    name: "import_env",
    description: "Import all KEY=VALUE pairs from a .env file on disk into a project. The app reads the file itself, so the secret values never enter this conversation. Auto-creates the project and auto-detects the provider per key. Use this to populate the vault from an existing project's .env / .env.local.",
    inputSchema: {
        type: "object",
        properties: {
            project: {
                type: "string",
                description: "Project name to import into (created if missing)."
            },
            env_path: {
                type: "string",
                description: "Absolute path to the .env file, e.g. /absolute/project/.env.local"
            }
        },
        required: [ "project", "env_path" ]
    }
} ];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
    const {name: name, arguments: a = {}} = req.params;
    try {
        switch (name) {
          case "vault_status":
            {
                if (!await probeSession(SESSION_PATH)) await ensureUp();
                const s = session();
                if (!s) return ok({
                    unlocked: false,
                    message: SETUP_MSG
                });
                const st = await fetch(`http://127.0.0.1:${s.port}/status`, {
                    signal: AbortSignal.timeout(2e3),
                    redirect: "error"
                }).then(r => r.json()).catch(() => null);
                if (!st || st.locked) return ok({
                    unlocked: false,
                    message: SETUP_MSG
                });
                return ok({
                    unlocked: true,
                    formatVersion: st.formatVersion,
                    deployment: st.deployment,
                    bridge: BRIDGE_VERSION
                });
            }

          case "list_projects":
            return ok(await call("GET", "/projects"));

          case "list_secrets":
            return ok(await call("GET", `/projects/${encodeURIComponent(a.project)}/secrets`));

          case "create_project":
            return ok(await call("POST", "/projects", {
                name: a.name
            }));

          case "set_secret":
            return ok(await call("POST", `/projects/${encodeURIComponent(a.project)}/secrets`, {
                key: a.key,
                value: a.value,
                provider: a.provider,
                note: a.note,
                username: a.username,
                email: a.email,
                password: a.password,
                url: a.url,
                permission: a.permission,
                expiresAt: a.expires_at
            }));

          case "delete_secret":
            return ok(await call("DELETE", `/projects/${encodeURIComponent(a.project)}/secrets/${encodeURIComponent(a.key)}`));

          case "inject_secrets":
            return ok(await call("POST", "/inject", {
                project: a.project,
                target_path: a.target_path,
                format: a.format || "dotenv",
                keys: a.keys || null,
                merge: a.merge
            }));

          case "reveal_secret":
            return ok(await call("POST", "/reveal", {
                project: a.project,
                key: a.key
            }));

          case "whoami":
            return ok(await call("GET", "/whoami"));

          case "compare":
            return ok(await call("GET", "/compare"));

          case "list_pending":
            return ok(await call("GET", "/pending"));

          case "search":
            return ok(await call("GET", `/search?q=${encodeURIComponent(a.query)}`));

          case "import_env":
            return ok(await call("POST", "/import", {
                project: a.project,
                env_path: a.env_path
            }));

          default:
            return err(`unknown tool: ${name}`);
        }
    } catch (e) {
        return err(e.message);
    }
});

const transport = new StdioServerTransport;

await server.connect(transport);

console.error("vault-os-mcp: ready");
