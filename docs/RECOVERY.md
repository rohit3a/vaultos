# Backups, recovery, migration, and removal

The preview uses `~/Library/Application Support/VaultOS-Preview` on macOS. It never searches or migrates older app data automatically. The directory is private (0700); sensitive files are 0600. Keep backups on encrypted storage with appropriate access controls.

## Back up

Quit the preview, then copy `vault.enc` to a new backup location. Or, from a source checkout:

```sh
node cli.cjs backup /absolute/new/backup-directory
```

This copies only the encrypted vault. The command overwrites `vault.enc` in the chosen directory, so choose a new dated directory for each snapshot. You must retain the corresponding passphrase. Do not send backups in bug reports or commit them to the public source repository.

Sync users additionally need the whole private preview data directory for their machine identity, signing key and replay state. This directory includes sensitive local keys and audit metadata; encrypt the backup itself. Avoid restoring the same machine identity on two simultaneously active devices. Enroll a new machine for a new installation.

## Test recovery without touching a working vault

Create a new private directory outside any existing installation. Copy your backed-up `vault.enc` there, set its mode to 0600, and use the source CLI with `VAULTOS_DATA_DIR=/absolute/new/recovery-directory node cli.cjs projects`. It prompts for a password without echo. Confirm the expected project names. The CLI does not print values; `inject` can deliberately export to a protected test folder when needed.

The preview can read older supported encrypted envelopes and migrate their schema. Always perform this on a copy in a new directory first. It does not migrate prior apps' Keychain services, token files, install paths, launch agents, or sync repositories. Existing agent grants and sync identities deserve review; a fresh vault with deliberately entered credentials is the safest preview evaluation path.

For actual replacement, quit all processes owning that **preview** directory, preserve the current files elsewhere, then place the verified backup there. Unlock and review agent access. A restored vault may restore previously revoked agent tokens; reissue or revoke them before restarting integrations. Never replace a file while the vault is open.

## Password rotation

Settings → Change master password verifies the current password and re-encrypts the live vault. It then attempts to update optional Keychain storage and each decryptable file in the local `backups` directory. Review the returned outcomes. Keep both old and new passwords until you have verified every file: failure partway through can leave files using different passwords. External backups and sync history do not change. Rotate leaked credentials at their issuing services as well.

There is no password reset, escrow key, or server recovery. Losing both your passphrase and accessible remembered Keychain item means losing access to that encrypted vault.

## Concurrent process or disk errors

A process ownership lock prevents desktop/backend/CLI overlap. A disk hash check prevents stale writers from overwriting a changed vault. Close the other **preview** process and unlock again. Dead-process locks recover automatically; an invalid or empty lock may require inspection and manual removal after confirming no preview process is running. Do not remove locks just to force a concurrent write. On I/O failure, preserve the directory and check disk space and permissions before retrying.

## Uninstall

Quit **VaultOS Preview**, remove its MCP client entry, and delete the preview app. Preserve an encrypted backup if needed. To forget background access, disable it in Settings or click Lock before quitting. Its Keychain service begins with `org.vaultos.preview.`; delete only the matching preview entry if manual cleanup is necessary. Then remove only the preview data directory and your preview agent token file. The app creates no login item, launch agent, automatic updater, or system service.
