# Connect a coding agent

For an agent-readable installation and management playbook, start at
[the portable VaultOS skill](../skills/vaultos/SKILL.md). Copy its whole folder
when installing it in a skill-aware client; this page is the shorter manual setup guide.

The desktop manages authorization. The MCP bridge forwards calls to its localhost API. You need Node.js 22+ and a source checkout with `npm ci --omit=dev --ignore-scripts` for the bridge; the desktop ZIP alone does not install a global MCP command.

1. Open and unlock VaultOS Preview. Create a project and a disposable test key.
2. In Settings → Agents, enroll the tool. Select `read` and `inject`, that project's checkbox, and its output folder. Additional scopes grant additional authority; leave `reveal` off unless you deliberately want raw secrets in model context.
3. Copy the one-time agent token into a private file outside the project repository. Create its parent folder with mode 0700 and the file with mode 0600. Use an editor; do not paste it into shell history or commit it. If lost, reissue it in the desktop; the old token stops working.
4. Add an MCP stdio server to your client's configuration. Replace paths with your actual absolute paths. The example contains no live token:

```json
{
  "mcpServers": {
    "vaultos": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/vaultos/mcp/server.mjs"],
      "env": {
        "VAULTOS_AGENT_TOKEN_FILE": "/absolute/private/folder/agent-token"
      }
    }
  }
}
```

Client configuration locations vary. Use your client's documented MCP settings. If you selected a custom `VAULTOS_DATA_DIR`, set the same absolute path in the bridge environment. Never point the preview at an existing production vault directory. Tokens are credentials: the environment token override is supported for controlled automation, but a private token file avoids embedding one in client settings.

5. Restart the MCP connection. Ask the agent to call `whoami`, `list_projects`, and `list_secrets`. Then request `inject_secrets` for the approved project and an absolute `.env` path in the approved folder. Keep `.env` ignored by Git. Do not ask the agent to print or read the file if your aim is avoiding transcript disclosure.

## Scope reference

| Scope | Permits |
| --- | --- |
| `read` | List/search metadata for approved projects |
| `inject` | Write approved record values into approved folders |
| `add` | Create records and projects; new records require injection approval |
| `edit:own` | Update that agent's records |
| `edit:delegated` | Update records explicitly delegated to it |
| `delete:own` | Delete that agent's records |
| `reveal` | Return raw secret values and content fingerprints |

Agents cannot enroll, widen scopes or folders, approve their own records, adopt human-owned records, change settings, or undo human history via HTTP/MCP. Revoke a token in the desktop to stop future API calls. Revocation does not erase files or values already disclosed.

`inject_secrets` supports dotenv, JSON, and shell formats. JSON merge preserves unrelated object keys. Dotenv merge preserves unrelated variables but rewrites formatting/comments. Shell output requires `merge:false` and must be sourced deliberately by the target program. An explicitly empty key list exports no keys; omitted keys requests all permitted, approved records.

## Optional background helper

The bridge works with the downloaded desktop while the app is open and unlocked. To let the source bridge start its headless backend after the desktop closes, also run `npm run build:native` in that source checkout on macOS (requires command-line developer tools). This builds the same preview-namespaced Keychain helper locally. Without it, keep the desktop open; the bridge never falls back to a plaintext password file. Background access must still be enabled deliberately in desktop Settings.

## Locked or unavailable

Unlock the desktop. The bridge can start the backend only when background Keychain access was explicitly enabled and a human lock has not blocked it. A connection interruption after a write is ambiguous: inspect the result before retrying. The bridge does not blindly replay writes.
