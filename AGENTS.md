# Working with VaultOS

For installing, connecting to, or operating VaultOS, read
[skills/vaultos/SKILL.md](skills/vaultos/SKILL.md). It routes to setup and
management instructions, including the human enrollment steps and MCP examples.
The complete `skills/vaultos/` directory is portable; copying only `SKILL.md`
loses its references. Loading the skill does not install the app or grant access.

## Repository development

Read [CONTRIBUTING.md](CONTRIBUTING.md) for build and release commands and
[SECURITY.md](SECURITY.md) before changing authorization, persistence, encryption,
or sync. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component boundaries.

- Use Node.js 22+. Install locked dependencies with `npm ci`.
- Run `npm run check` for code changes. Sync tests require `age`. On macOS,
  compile the isolated test helper with
  `VAULTOS_BUILD_TEST_HELPER=1 npm run build:native` before native tests.
- Manual app tests must use a new absolute `VAULTOS_DATA_DIR` and synthetic
  credentials. Never test against an existing user's vault, tokens, or Keychain
  items. UI tests require an interactive macOS desktop; Linux core tests do not
  establish macOS packaging or runtime compatibility.
- Preserve the `VaultOS-Preview` data directory and `org.vaultos.preview`
  namespaces. Do not add automatic migration or enable background access by
  default. Enforce agent permissions in the API/main process.
- Keep secret values, live vault files, tokens, private machine paths, and
  personal configuration out of commits, test fixtures, logs, and screenshots.
- When changing tools or setup, update the portable skill references and
  [docs/AGENTS.md](docs/AGENTS.md) alongside the implementation. For documentation
  changes, validate links and examples; do not add tests that merely assert prose.

Only publish or perform releases within the user's requested scope. Release
artifacts remain unsigned previews unless signing and notarization actually pass.
