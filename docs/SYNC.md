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

If content differs, inspect `sync plan` (local checkout only; fetch separately first) or the desktop's status/conflict output. The preview conservatively treats differing content as a conflict. Back up both devices, review the proposed winner based on revision/timestamp, and use `sync accept-conflicts` only if you accept that choice. The app stores an encrypted local backup before merging. Conflicting project/key names refuse merging instead of silently overwriting.

A signature, recipient, replay, or unreadable-record error is a stop condition. Restore trusted copies or investigate the cause; do not bypass validation. Repository hooks are disabled for application Git operations. Configure credentials using your normal Git tools outside VaultOS.

## Keys and deletion

Sync uses separate private age and Ed25519 keys, stored locally with private permissions. The vault passphrase does not encrypt them. Remote Git history retains old ciphertext; deleting a record or changing the vault password does not erase that history or revoke another peer's access. Peer removal and key rotation require a new sync group with new keys and deliberate migration. See [SECURITY.md](../SECURITY.md).
