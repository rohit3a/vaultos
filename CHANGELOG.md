# Changelog

## Unreleased

- Optional always-on backend: `backend.cjs --service` waits while the desktop owns the vault, takes over when it closes, retries Keychain unlock, restores a removed session file and reloads a vault replaced on disk. `scripts/install-service-macos.sh` installs it as a LaunchAgent on request. It requires background access and exits when that is off.
- Optional autosync (off by default) in whichever process owns the vault, with `POST /sync` / `node cli.cjs sync now` for owner-requested rounds and sync health in `vault_status`. It halts on conflicts and verification errors instead of resolving them.
- Optional soft lock policy (default remains hard): screen lock, sleep and idle lock only the window while agents keep working; the Lock button stays a full lock.

- Linux (source-built preview): optional password remembering through the Secret Service (`secret-tool`) with no plaintext fallback, `npm run dist:linux` packaging, a per-user installer with run-time Chromium sandbox detection, and an opt-in systemd user unit for the headless backend.
- Agents: optional, default-off all-access grants (`allProjects`, `anyRoot`), set only by a human in Settings → Agents or the admin CLI.
- `vaultos-agent` shell client (`agent-cli.cjs`) for enrolled agents, with the bridge's grants and token discovery (`VAULTOS_AGENT_TOKEN`, a private `VAULTOS_AGENT_TOKEN_FILE`, or `VAULTOS_AGENT` with `<data dir>/agents/NAME.token`).
- Admin CLI commands for agents, pending approvals, the approval relay and headless password rotation, all authorized by the master password.
- Optional approval relay route (`POST /pending/decide`) authenticated by a separately configured secret; an **Approve all** button in the pending banner.
- MCP bridge: distinct locked/not-running errors, deduplicated backend start through a service manager or `backend.cjs --service`, sync health and bridge hash in `vault_status`, and `import_env` `createProject`.

- Sync: a pull no longer marks unpushed local records as already published. A local edit kept by `sync accept-conflicts` stayed on that device: the next push skipped it and `sync status` reported nothing outgoing. The push index now matches what the sync repository holds, and an index affected by the old behavior is repaired by the next pull.
- Sync: conflicting versions with the same revision and timestamp now resolve by content hash, so every device keeps the same version instead of each keeping its own.

## 0.1.0-preview.1

First standalone public macOS preview.

- Local encrypted project vault, desktop editor, expiry metadata, guarded history undo, encrypted PDF export and recovery CLI.
- MCP bridge with separate agent identities, project/folder grants, ownership rules, injection quarantine and explicit reveal scope.
- Real desktop/API lock, sleep and idle lock, optional native Keychain storage without plaintext fallback, restricted renderer and hardened packaging fuses.
- Atomic persistence with stale-writer protection; bounded, safely quoted file exports and symlink checks.
- Optional age/Git sync with pinned peer trust, approved recipients, signed ciphertext verification, replay checks, backups and explicit conflict acceptance.
- Standalone history, synthetic test fixtures, dependency lockfile, contributor/security documentation, and unsigned macOS release automation.

This is an evaluation prerelease, without Developer ID signing, notarization or an independent security audit. See release notes for executed platform verification.
