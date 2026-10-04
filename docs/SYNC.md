# Optional encrypted Git sync

Sync is for your own trusted devices. Each enrolled peer can decrypt all records in this sync group. Start with disposable vaults, install Git and [age](https://github.com/FiloSottile/age), and use a **new private Git repository**, separate from source code and other vaults. Sync is off until you configure it.

The default checkout is `sync-repository` inside preview data. `VAULTOS_SYNC_REPO` can select another absolute path for source/CLI usage. GUI sync uses its process environment. The preview refuses a nonempty checkout without its own format marker. Configure transport through your shell; no Git credentials are stored in the vault or published by the source project.

## First device

With the app quit, initialize a dedicated empty local checkout with `git init -b main /absolute/new/sync-repository`, set a repository-local Git author name/email you want recorded, and add the private remote with `git remote add origin <your-private-remote>`. Do not use a URL containing an embedded access token. Set `VAULTOS_SYNC_REPO` to that directory when invoking the CLI.

Run `node cli.cjs sync init 'Device A'`. Enter the vault password at the hidden prompt. Save the returned **public identity JSON** for verification on your other device. Labels are public to anyone who can access the sync repository; choose a generic label. Run `node cli.cjs sync push`; require `delivered:true` and matching source/remote commits. A receipt proves remote Git acceptance, not that another device has pulled.

## Add another device

1. Clone that private sync repository into a new directory on device B. Create a separate preview vault on B; do not copy a live machine identity.
2. Initialize B with `sync init 'Device B'` and obtain B's public identity using `sync identity`.
3. Independently verify A's and B's age and signing public keys (or the displayed fingerprint) through a trusted channel. Trusting JSON fetched only from the same Git remote does not authenticate it.
4. On each device, save the verified peer JSON to a file and run `node cli.cjs sync trust /absolute/peer-identity.json`. Both need to trust each other **before encrypting to the expanded recipient list**.
5. Transfer B's public enrollment metadata (`machines/<id>.json` and its added public recipient) through the dedicated repository using Git. Review the staged paths. Never add `sync-age.key`, `sync-signing.key`, or any other file from a vault's private data directory.
6. A must fetch this recipient change and run `sync push` to encrypt current records for B. B can then `sync pull`. The push reports `reencryptedForNewRecipients:true` when the recipient set changes. Do not report an unreadable pull as success.

An approved change to `recipients.txt` triggers re-encryption on the next push, including existing records and tombstones held by that device. First make sure the publishing device holds the complete current vault. Unapproved recipients cause encryption to fail. The regression suite checks onboarding a third peer after records already exist.

## Routine use

`sync status` fetches and reports transport and record drift. `sync push` encrypts changed records, signs ciphertext digests, commits only known sync paths, pushes, and checks the remote ref. `sync pull` fetches before verification/merge. Status exits 2 unless fully in sync; failed deliveries also exit 2 for automation.

If content differs, inspect `sync plan` (local checkout only; fetch separately first) or the desktop's status/conflict output. The preview conservatively treats differing content as a conflict. Back up both devices, review the proposed winner (the higher revision, then the later timestamp; an exact tie goes to the same version on every device), and use `sync accept-conflicts` only if you accept that choice. A local version that wins is published by your next `sync push`. The app stores an encrypted local backup before merging. Conflicting project/key names refuse merging instead of silently overwriting.

## Automatic sync

Autosync is off by default. After a device can push and pull manually, enable **Sync automatically** in desktop Settings (stored as `autoSync: { enabled, intervalSeconds }`, interval 30–86400 seconds, default 120). The process that currently owns the unlocked vault (the desktop, a one-shot backend, or the `--service` backend) then pulls and pushes on that interval and about 5 seconds after each local change. It is paused while the vault is locked. It uses the same checkout, environment and verification as manual sync.

Autosync never accepts conflicts. If a pull would need acceptance, or verification fails, or Git history diverges, it stops and reports the state (`CONFLICTS_PENDING`, for example) until you act: review the plan and pull with acceptance in the desktop, or let the service hand over to the desktop and resolve there. Only network failures (`REMOTE_UNREACHABLE`, rejected or unverified pushes) are retried on the next round.

`node cli.cjs sync now` asks the running owner to perform one round instead of stopping it; it needs no password and exits 2 unless the round delivered. It uses the owner's session token, so it works only for your account, and agents cannot request it. The MCP `vault_status` tool reports sync health: autosync state, last successful sync, the last error, and whether a peer's signed heartbeat is older than 48 hours or reports uncommitted files (`peerStalled`). The desktop's sync status includes the same `autoSync` object.

## Stop conditions

A signature, recipient, replay, or unreadable-record error is a stop condition. Restore trusted copies or investigate the cause; do not bypass validation. Repository hooks are disabled for application Git operations. Configure credentials using your normal Git tools outside VaultOS.

## Keys and deletion

Sync uses separate private age and Ed25519 keys, stored locally with private permissions. The vault passphrase does not encrypt them. Remote Git history retains old ciphertext; deleting a record or changing the vault password does not erase that history or revoke another peer's access. Peer removal and key rotation require a new sync group with new keys and deliberate migration. See [SECURITY.md](../SECURITY.md).
