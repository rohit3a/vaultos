VaultOS is a local macOS vault for project credentials and scoped coding-agent access through MCP. Injection writes an approved environment file without returning values in the tool response.

This is an **unsigned evaluation preview**. The application has an ad-hoc integrity signature, but no Developer ID identity or Apple notarization. Start with synthetic credentials and retain independent backups. It has not received an independent security audit.

- `arm64`: Apple Silicon; `x64`: Intel. Deployment target: macOS 13+.
- ZIPs include **VaultOS Preview.app** and use a separate preview data/Keychain namespace. They create no login service and do not import other vault applications.
- Verify the matching `.sha256` before opening. See the README for Apple's per-app Gatekeeper procedure.
- Dependency inventory is provided as CycloneDX JSON. The source tag and npm lockfile identify build inputs.

Regression coverage includes authenticated encryption, legacy decoding, scope and ownership checks, file/path serialization, stale writes, manual-lock persistence, MCP-to-HTTP injection, sync recipient changes/tampering/replay/conflicts, Git remote receipts and desktop IPC locking. macOS builds validate the native helper and package signatures. An architecture cross-build is not evidence of runtime compatibility on that hardware.

Read SECURITY.md, docs/AGENTS.md and docs/RECOVERY.md before adding real credentials. Agents with filesystem/shell access can read injected files. Background unlocking is explicitly opt-in. Optional sync trusts whole devices and stores separate local private keys; it is not a multi-user access-control system.

Release automation runs the core suite, native helper test, desktop UI flow and actual packaged app on **macOS 14 Apple Silicon** and **macOS 15 Intel** before publishing. Additional local validation used macOS 26.5 Apple Silicon and Linux. Encrypted PDF output was independently checked with Poppler. macOS 13 is the deployment target and has not been separately exercised in this release.
