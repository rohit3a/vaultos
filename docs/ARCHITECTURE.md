# Architecture

```text
Human → sandboxed renderer → narrow preload IPC → main process / Store
                                                     ↑
Coding client → MCP stdio bridge → authenticated localhost API
                                                     ↓
             encrypted vault + optional Keychain helper / Secret Service
                                                     ↓
                         optional age ciphertext + signed Git sync
```

`store.js` owns encrypted persistence, record ownership, mutation history and audit events. `model.js` defines format versions and syncable fields. `crypto.js` implements the versioned AES-GCM/scrypt envelope and signing primitives using Node's crypto library. `fs-safe.js` and `env-file.js` centralize bounded path and serialization rules.

`main.js` is the desktop authority boundary: it gates all privileged IPC on the exact window/frame and human unlock state. `preload.js` exposes named operations only. The renderer receives metadata for lists and raw values only for explicit reveal/edit. Lock removes the API session, releases process ownership, drops the store state and replaces the rendered view.

`api.js` authorizes each agent request independently; `approvals.js` holds pending-key decisions and the optional approval-relay secret check. Session identity is distinct from agent identity. `agents.js` validates enrollment, scopes and canonical folder/project grants. `agent-client.js` discovers the agent token, finds or starts the owner and maps lock/availability errors; both `mcp/server.mjs` and the `agent-cli.cjs` shell client use it. `mcp/server.mjs` holds the integration token and forwards tool requests; injection does not return secret values. `set_secret` and `reveal_secret` necessarily carry values through the bridge when permitted.

`session.js` coordinates one owner process and validates runtime session discovery. `keyring.js` stores an explicitly remembered password through the native macOS Keychain helper or, on Linux, libsecret's `secret-tool`, both over stdin and in the preview's service namespace; it has no plaintext fallback. `backend.cjs` is an optional separate owner that can start only with that remembered password. With `--service` it is long-running: it waits while another process owns the vault (without holding `owner.lock`), retries unlock with backoff, takes over when the owner exits, returns to waiting after a `/shutdown` handover, restores a removed `session.json`, and reloads `vault.enc` when another writer replaced it. Nothing installs it automatically: `scripts/install-service-macos.sh` installs a per-user LaunchAgent (`org.vaultos.preview.backend`) and `scripts/install-linux.sh --enable-service` an opt-in systemd user unit. The CLI (`cli.cjs`, with human admin commands in `admin.js`) requires a hidden password prompt and claims ownership for decrypted operations, except `sync now`, which asks the running owner to sync.

`main.js` applies the vault's `lockPolicy`: screen lock, sleep and idle either fully lock (`hard`, default) or lock only the window while the process keeps owning and serving (`soft`). Manual Lock is always full.

`store.js` checks the disk hash before each write and refuses stale writes. Owners call `reloadIfChanged()` between operations (API requests, desktop IPC, the service guard, autosync rounds); it reloads under the write lock and refuses if unsaved in-memory changes exist. Mutations persist or roll back synchronously, so a reload never discards a completed local write.

`sync.js` separates local merging from remote transport. `autosync.js` runs pull-then-push rounds inside the owning process, debounced after local writes and on an interval, and halts on any conflict or verification failure. `git.js` uses argument arrays, disabled hooks, known staged paths and remote receipts. Trust pins live inside the encrypted vault; age/signing machine keys and the replay index live in the private data directory. The sync format is specific to this preview and is not a public interoperability standard.

See [SECURITY.md](../SECURITY.md) for trust boundaries and limitations. Test files map to persistence/export, HTTP authorization, MCP transport, desktop behavior and encrypted sync rather than trying to establish security through UI tests alone.
