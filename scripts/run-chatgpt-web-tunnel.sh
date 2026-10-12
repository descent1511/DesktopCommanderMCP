#!/bin/sh
set -eu

# Start the OpenAI Secure MCP Tunnel without storing a runtime key in this repo.
# The key is read by tunnel-client from CONTROL_PLANE_API_KEY in the caller's
# environment.  The tunnel ID is likewise supplied explicitly so this script
# cannot silently repoint an unrelated profile.

TUNNEL_CLIENT="${TUNNEL_CLIENT:-/opt/homebrew/bin/tunnel-client}"
TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
MCP_COMMAND="command=$REPO_DIR/scripts/run-chatgpt-web-docker.sh,channel=main"

if [ ! -x "$TUNNEL_CLIENT" ]; then
  echo "tunnel-client not found: $TUNNEL_CLIENT" >&2
  exit 1
fi

if [ -z "${CONTROL_PLANE_API_KEY:-}" ]; then
  echo "CONTROL_PLANE_API_KEY is not set; export a runtime key in this shell." >&2
  exit 1
fi

if [ -z "$TUNNEL_ID" ]; then
  echo "CONTROL_PLANE_TUNNEL_ID is not set; use the tunnel ID attached to your ChatGPT workspace." >&2
  exit 1
fi

exec "$TUNNEL_CLIENT" run \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --control-plane.tunnel-id "$TUNNEL_ID" \
  --mcp.command "$MCP_COMMAND" \
  --health.listen-addr 127.0.0.1:0 \
  --log.level info \
  --log.format json
