#!/bin/sh
set -eu

# This launcher is the command given to Secure MCP Tunnel.  It intentionally
# emits no normal output of its own: stdout belongs to the MCP stdio stream.

DOCKER_BIN="${DOCKER_BIN:-/opt/homebrew/bin/docker}"
IMAGE="${CHATGPT_DESKTOP_COMMANDER_IMAGE:-desktop-commander-chatgpt:local}"
WORKSPACE="${CHATGPT_WORKSPACE:-/Users/descent/Projects}"

if [ ! -x "$DOCKER_BIN" ]; then
  echo "Docker executable not found: $DOCKER_BIN" >&2
  exit 1
fi

if [ ! -d "$WORKSPACE" ]; then
  echo "ChatGPT workspace does not exist: $WORKSPACE" >&2
  exit 1
fi

WORKSPACE="$(cd "$WORKSPACE" && pwd -P)"
case "$WORKSPACE" in
  /|/Users|/Users/|/Users/descent|/Users/descent/)
    echo "Refusing an overly broad ChatGPT workspace: $WORKSPACE" >&2
    exit 1
    ;;
esac

if ! "$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Docker image not found: $IMAGE" >&2
  echo "Build it with: docker build -f Dockerfile.chatgpt -t $IMAGE ." >&2
  exit 1
fi

exec "$DOCKER_BIN" run --rm -i --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --cpus="${CHATGPT_CONTAINER_CPUS:-2}" \
  --memory="${CHATGPT_CONTAINER_MEMORY:-2g}" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
  --mount "type=bind,src=$WORKSPACE,dst=/workspace" \
  --workdir /workspace \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/desktop-commander-home \
  -e DESKTOP_COMMANDER_CONFIG_DIR=/tmp/desktop-commander-config \
  -e DESKTOP_COMMANDER_ALLOWED_DIRECTORIES=/workspace \
  -e DESKTOP_COMMANDER_DEFAULT_SHELL=/bin/sh \
  -e DESKTOP_COMMANDER_DISABLE_TELEMETRY=1 \
  -e DESKTOP_COMMANDER_DISABLE_NETWORK=1 \
  -e DESKTOP_COMMANDER_DISABLE_HISTORY=1 \
  -e DESKTOP_COMMANDER_DISABLE_USAGE_TRACKING=1 \
  -e DESKTOP_COMMANDER_REDACT_SECRETS=1 \
  -e DESKTOP_COMMANDER_HARDENED=1 \
  -e DC_FLAG_URL=file:///dev/null \
  "$IMAGE"
