# ChatGPT Web: local hardened Desktop Commander

This fork is for connecting the local MCP server to ChatGPT Web through
OpenAI's Secure MCP Tunnel. It does not use Desktop Commander's hosted
`remote` command.

## Security profile

The tunnel launches `scripts/run-chatgpt-web-docker.sh`, which:

- mounts the configured project directory at `/workspace`;
- mounts `CHATGPT_AIRR_WORKSPACE` at `/airr` (default:
  `/Users/descent/Documents/AIRR`);
- mounts `CHATGPT_PIM_WORKSPACE` at `/pim` (default:
  `/Users/descent/Documents/AIRR/pim`);
- mounts `CHATGPT_PIM_UI_WORKSPACE` at `/pim-ui` (default:
  `/Users/descent/Documents/AIRR/pim-ui`);
- includes the Go 1.24 toolchain and mounts `CHATGPT_GO_MODULE_CACHE`
  read-only at `/go/pkg/mod` when the host cache exists;
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
- starts a separate host-side Git bridge. `git_read` exposes status, log, diff,
  branch, and confirmed fetch; `git_mutate` exposes add, commit, push,
  checkout/switch, and merge. The bridge maps `/workspace`, `/airr`, `/pim`,
  and `/pim-ui` to the matching Mac directories and allows repositories only
  below the Projects/AIRR roots. Force-push, remote deletion, forced branch
  changes, interactive commit editors, and Git configuration overrides are
  blocked; all mutations require confirmation.

The container intentionally provides Linux tools, not macOS-native commands.
The bind-mounted workspace remains writable; all other container files are
read-only or ephemeral.

## Build and local smoke test

From this repository:

```sh
npm ci --include=dev --no-audit --no-fund
npm run build
./scripts/build-chatgpt-web-image.sh
CHATGPT_WORKSPACE=/Users/descent/Projects \
CHATGPT_AIRR_WORKSPACE=/Users/descent/Documents/AIRR \
CHATGPT_PIM_WORKSPACE=/Users/descent/Documents/AIRR/pim \
CHATGPT_PIM_UI_WORKSPACE=/Users/descent/Documents/AIRR/pim-ui \
  ./scripts/run-chatgpt-web-docker.sh
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
`/Users/descent/Projects`. Set `CHATGPT_PIM_WORKSPACE` if the PIM directory is
in a different location; it is mounted separately at `/pim` and is included in
the hardened allowed-directory list. `CHATGPT_PIM_UI_WORKSPACE` is mounted at
`/pim-ui` using the same restriction. The parent AIRR directory is also
available at `/airr`. Go tests use the offline host module cache and an
ephemeral executable build directory at `/go-tmp`.
