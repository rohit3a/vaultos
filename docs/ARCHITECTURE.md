# Architecture

```text
Human → sandboxed renderer → narrow preload IPC → main process / Store
                                                     ↑
Coding client → MCP stdio bridge → authenticated localhost API
                                                     ↓
                             encrypted vault + optional Keychain helper
                                                     ↓
                         optional age ciphertext + signed Git sync
```

`store.js` owns encrypted persistence, record ownership, mutation history and audit events. `model.js` defines format versions and syncable fields. `crypto.js` implements the versioned AES-GCM/scrypt envelope and signing primitives using Node's crypto library. `fs-safe.js` and `env-file.js` centralize bounded path and serialization rules.

`main.js` is the desktop authority boundary: it gates all privileged IPC on the exact window/frame and human unlock state. `preload.js` exposes named operations only. The renderer receives metadata for lists and raw values only for explicit reveal/edit. Lock removes the API session, releases process ownership, drops the store state and replaces the rendered view.

`api.js` authorizes each agent request independently. Session identity is distinct from agent identity. `agents.js` validates enrollment, scopes and canonical folder/project grants. `mcp/server.mjs` holds the integration token and forwards tool requests; injection does not return secret values. `set_secret` and `reveal_secret` necessarily carry values through the bridge when permitted.

`session.js` coordinates one owner process and validates runtime session discovery. `backend.cjs` is an optional separate owner that can start only with explicitly remembered Keychain access. The CLI requires a hidden password prompt and claims ownership for decrypted operations. Neither a backend nor the desktop is installed as a system service.

`sync.js` separates local merging from remote transport. `git.js` uses argument arrays, disabled hooks, known staged paths and remote receipts. Trust pins live inside the encrypted vault; age/signing machine keys and the replay index live in the private data directory. The sync format is specific to this preview and is not a public interoperability standard.

See [SECURITY.md](../SECURITY.md) for trust boundaries and limitations. Test files map to persistence/export, HTTP authorization, MCP transport, desktop behavior and encrypted sync rather than trying to establish security through UI tests alone.
