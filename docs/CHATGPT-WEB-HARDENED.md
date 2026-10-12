# ChatGPT Web: local hardened Desktop Commander

This fork is for connecting the local MCP server to ChatGPT Web through
OpenAI's Secure MCP Tunnel. It does not use Desktop Commander's hosted
`remote` command.

## Security profile

The tunnel launches `scripts/run-chatgpt-web-docker.sh`, which:

- mounts only `CHATGPT_WORKSPACE` at `/workspace`;
- runs with `--network=none`, read-only image filesystem, dropped Linux
  capabilities, no-new-privileges, and resource limits;
- does not mount the host home directory, SSH keys, cloud credentials, or
  Docker socket;
- disables Desktop Commander telemetry, feature-flag fetches, usage tracking,
  tool-call history, and the feedback prompt;
- redacts common API keys, bearer tokens, JWTs, private-key blocks, passwords,
  and database connection strings in MCP text results and any retained records;
- locks `allowedDirectories`, `blockedCommands`, and `telemetryEnabled` against
  changes through `set_config_value` while hardened mode is enabled.

The container intentionally provides Linux tools, not macOS-native commands.
The bind-mounted workspace remains writable; all other container files are
read-only or ephemeral.

## Build and local smoke test

From this repository:

```sh
npm ci --include=dev --no-audit --no-fund
npm run build
./scripts/build-chatgpt-web-image.sh
CHATGPT_WORKSPACE=/Users/descent/Projects ./scripts/run-chatgpt-web-docker.sh
```

The last command is an MCP stdio server, so it waits for an MCP client and
does not print a normal shell prompt. Stop it with Ctrl-C.

## Secure MCP Tunnel

Create or select a tunnel in the OpenAI workspace and create a runtime API key.
Keep the key in the shell environment or a tunnel-client secret reference; do
not put it in this repository. For a standalone setup, run:

```sh
export CONTROL_PLANE_API_KEY='your-runtime-key'
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CHATGPT_WORKSPACE=/Users/descent/Projects/my-project
./scripts/run-chatgpt-web-tunnel.sh
```

If this machine already has a tunnel-client profile, use its tunnel ID but do
not run two different MCP commands against that tunnel at the same time.
The script above is intentionally explicit so it cannot silently replace an
existing profile's command.

The tunnel profile should execute:

```text
/Users/descent/Projects/DesktopCommanderMCP/scripts/run-chatgpt-web-docker.sh
```

Keep the tunnel client running. In ChatGPT Web, open Settings → Apps (or
Plugins → Add custom MCP server), choose the Tunnel option, select the same
tunnel, scan/create the tools, install the app, and select it in a new chat.

### Recommended ChatGPT app name

Use this user-facing name when creating or editing the custom app:

```text
Desktop Commander Local (Hardened)
```

Suggested description:

```text
Local hardened Desktop Commander via Secure MCP Tunnel; workspace-limited,
network-isolated, telemetry/history disabled, and secret redaction enabled.
```

This app name is separate from the tunnel's metadata. If the existing tunnel
still appears as `local-commander`, that is expected when reusing the old
tunnel; it does not change which local MCP command is connected. Rename the
ChatGPT app in its details page if the UI allows it, or create a new custom
app using the same tunnel and the name above.

Set `CHATGPT_WORKSPACE` in the environment used by the tunnel client to the
specific project directory you want to expose. The default is
`/Users/descent/Projects`.
