# Security policy and threat model

## Reporting

Please use [GitHub private vulnerability reporting](https://github.com/rohit3a/vaultos/security/advisories/new). Do not put live credentials, vault files, machine private keys, personal paths, or full audit logs in public issues. Send a minimal synthetic reproduction, affected version, expected behavior, and impact. There is no paid response SLA or bug bounty. Only the latest preview is maintained; fixes may require upgrading.

## What VaultOS protects

- A copied, locked `vault.enc` requires its passphrase to decrypt. Writes use authenticated AES-256-GCM with a fresh 16-byte salt and 12-byte nonce; the envelope includes a 16-byte authentication tag.
- Envelope v2 derives a 256-bit key with scrypt (`N=131072`, `r=8`, `p=1`, maximum memory 256 MiB). Older envelope v1 can be read with its original `N=32768`; a new write uses v2. Vault schema v3 rejects unsupported newer readers/writers. A strong unique passphrase remains essential against offline guessing.
- The Electron renderer has a sandbox, context isolation, no Node integration, a restrictive CSP, denied navigation/popups/permissions, and an IPC sender-and-unlock check. Packaged fuses disable RunAsNode, Node options and inspection arguments, and require the embedded application archive.
- The local HTTP service binds only to `127.0.0.1`. Private routes require a random session token and an enrolled agent token; browser-origin requests and unexpected Host headers are rejected. Project, folder, scope, and record ownership checks apply at the service boundary. Request sizes and timeouts are bounded.
- New agents have only `read` and `inject` scopes, no approved projects, and no approved folders until the human chooses them. Empty scopes mean no permissions. Raw reveal is separate. Agent-created records await human approval before injection.
- File exports use private permissions, bounded serialization and atomic replacement. Agent paths must stay within approved canonical folders and cannot traverse observed symlinks. Shell export quotes values as data; dotenv output must be parsed as dotenv, not sourced as shell.
- Passwords are not put in command-line arguments. Optional remembering calls a native Keychain helper over stdin and never falls back to a plaintext password file. The helper uses the preview's separate service namespace.
- Sync uses age and Ed25519 signatures, locally pinned public keys, approved recipients, ciphertext digests, and remembered manifest counters. Tampering, unknown peers, missing signed content, and observed replay cause refusal. Existing content conflicts require explicit acceptance before merging.

## Boundaries and limitations

**Trusted local account.** Malware, root, a compromised OS, debuggers, or other software running as your account can read memory, files, clipboard contents, session/agent tokens, and potentially Keychain items. VaultOS does not isolate a coding agent from your operating system. An agent with filesystem access can read injected credentials. An approved folder is an application permission, not a kernel sandbox.

**Unlocked state.** Plaintext exists in the main process and, on human reveal/edit, the renderer. Lock revokes APIs and clears references and UI state, but JavaScript garbage collection does not guarantee memory zeroization; OS swap and crash capture are outside this guarantee. Clipboard content is conditionally cleared after 30 seconds, but clipboard managers may keep copies. Manually exported files remain after lock.

**Remembering.** Background access is off by default. Turning it on lets a backend decrypt without a human typing a password. Manual lock writes a persistent block and attempts to remove the remembered item; a subsequent human unlock allows it again. Disk/Keychain failures can prevent persistence. The separate headless backend does not monitor screen-lock events; screen/sleep locking applies while the desktop is running. Application termination cannot revoke copies of secrets already obtained.

**Metadata.** Names, usernames, emails, URLs, notes, expiry dates, and project counts are visible through metadata scopes and may enter agent conversations. Do not place credentials in metadata. The private-permission local audit log contains names, actions, actors, and times, not secret values; it is plaintext and is not tamper-evident. Encrypted history retains previous values for up to 2,000 changes. Deletion is not secure erasure of backups/history.

**Sync is a separate encryption boundary.** Local `sync-age.key` and `sync-signing.key` files are stored with mode 0600, not encrypted with the vault passphrase. Someone who steals the age key and sync repository can decrypt synced records. Vault password rotation does not rotate these keys or protect old Git history. Every trusted peer is a full participant with all synced records, not a per-project collaborator. Signed manifests expose counts, opaque identifiers, hashes, labels and timing; low-entropy content can be susceptible to guessing via content fingerprints. Use a private repository. First contact needs independent identity verification; rollback detection depends on retained local state and is not a transparency log.

**Availability and durability.** Remote failures, local disk loss, interrupted writes and concurrent edits may prevent progress. Atomic writes and stale-writer checks reduce accidental overwrites but do not replace tested backups. Password rotation across multiple backup files is not transactional; verify its per-file results and retain both passwords until complete. No recovery service exists.

## Assurance

This is an unsigned, unnotarized preview, not an independently audited password manager. Automated tests cover encryption failures, stale writes, ownership/scopes, HTTP authentication, unsafe export paths and shell values, sync tampering/replay/conflicts, and the desktop lock flow. Tests and dependency advisories cannot establish that all vulnerabilities are absent. See release notes for exact validation and outstanding platform coverage.

The implementation follows the [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security). Contributions that weaken these boundaries require explicit design discussion and regression coverage.
