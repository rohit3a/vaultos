VaultOS is a local vault for project credentials with scoped coding-agent access through MCP. Injection writes an approved environment file without returning values in the tool response. This preview runs on **macOS and Linux**.

This is an **unsigned evaluation preview**. The macOS app has an ad-hoc integrity signature, but no Developer ID identity or Apple notarization. Start with synthetic credentials and keep independent backups. It has not received an independent security audit.

## Downloads

- macOS `arm64` (Apple Silicon) and `x64` (Intel) ZIPs with **VaultOS Preview.app**. Deployment target: macOS 13+.
- Linux `x64` tarball. Install it per user with `scripts/install-linux.sh --from <tarball>` from a source checkout; see the README.
- Verify the matching `.sha256` before opening. A CycloneDX JSON dependency inventory is attached for each build.
- Builds use a separate preview data, Keychain and Secret Service namespace. Nothing installs a login service or imports another vault on its own.

## New in 0.2

- **Linux:** remembered passwords through the Secret Service (`secret-tool`) with no plaintext fallback, packaging, a per-user installer with a run-time Chromium sandbox check, and an opt-in systemd user unit.
- **Always-on backend, opt-in:** `backend.cjs --service` serves agents while no window is open, hands the vault to the desktop when you open it and takes it back when you close it. Optional installers for a macOS LaunchAgent and a systemd user unit are included.
- **Autosync, opt-in:** pulls and pushes on an interval through the same verified sync engine. It stops on conflicts and verification errors instead of resolving them.
- **Soft lock policy, opt-in:** screen lock, sleep and idle can lock only the window while agents keep working. The Lock button is always a full lock.
- **Touch ID, opt-in:** unlock the window and confirm human-only actions, falling back to the master password.
- **Agent tooling:** the `vaultos-agent` CLI, admin commands authorized by the master password, an approval relay with its own secret, **Approve all**, and opt-in all-projects or any-folder grants set only by a human.
- **MCP bridge:** distinct locked and not-running errors, a single coordinated backend start, waiting for a busy owner, and sync health plus the bridge hash in `vault_status`.
- **`cli.cjs import-legacy`:** an explicit one-time import from the earlier vault-os fork, with a dry-run plan.
- **Desktop:** a quieter cream and black theme.

All new behaviour that weakens the default security posture is off until you turn it on.

## Before real credentials

Read SECURITY.md, docs/AGENTS.md, docs/SYNC.md and docs/RECOVERY.md. Agents with filesystem or shell access can read injected files. Optional sync trusts whole devices and stores separate local private keys; it is not a multi-user access-control system.

## Testing

Release automation runs the core suite, native helper test, desktop UI flow and the packaged app on **macOS 14 Apple Silicon** and **macOS 15 Intel**, and the core suite plus Linux packaging on **Ubuntu**. This release was also run day to day on macOS 26 Apple Silicon and an Ubuntu workstation, with a Mac–Linux sync group. macOS 13 is the deployment target and has not been separately exercised.
