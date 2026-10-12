#!/bin/sh
set -eu

# This launcher is the command given to Secure MCP Tunnel.  It intentionally
# emits no normal output of its own: stdout belongs to the MCP stdio stream.

DOCKER_BIN="${DOCKER_BIN:-/opt/homebrew/bin/docker}"
IMAGE="${CHATGPT_DESKTOP_COMMANDER_IMAGE:-desktop-commander-chatgpt:local}"
WORKSPACE="${CHATGPT_WORKSPACE:-/Users/descent/Projects}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
NODE_BIN="${CHATGPT_NODE_BIN:-$(command -v node || true)}"
BRIDGE_DIR=""
BRIDGE_PID=""

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

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Node.js executable not found; the Kubernetes host bridge cannot start" >&2
  exit 1
fi

# The container receives only this short-lived file-queue directory. kubeconfig,
# kubectl, AWS credentials, and cluster networking remain on the Mac.
BRIDGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/desktop-commander-k8s.XXXXXX")"

cleanup_bridge() {
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
  if [ -n "$BRIDGE_DIR" ]; then
    rm -rf "$BRIDGE_DIR"
  fi
}
trap cleanup_bridge EXIT INT TERM

"$NODE_BIN" "$SCRIPT_DIR/kubernetes-bridge.mjs" --dir "$BRIDGE_DIR" >/dev/null 2>"$BRIDGE_DIR/bridge.log" &
BRIDGE_PID=$!

bridge_attempt=0
while [ ! -f "$BRIDGE_DIR/bridge.log" ] || ! kill -0 "$BRIDGE_PID" 2>/dev/null; do
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "Kubernetes bridge failed to start:" >&2
    sed -n '1,80p' "$BRIDGE_DIR/bridge.log" >&2 || true
    exit 1
  fi
  bridge_attempt=$((bridge_attempt + 1))
  if [ "$bridge_attempt" -gt 100 ]; then
    echo "Timed out waiting for the Kubernetes bridge socket" >&2
    sed -n '1,80p' "$BRIDGE_DIR/bridge.log" >&2 || true
    exit 1
  fi
  sleep 0.05
done

"$DOCKER_BIN" run --rm -i --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --cpus="${CHATGPT_CONTAINER_CPUS:-2}" \
  --memory="${CHATGPT_CONTAINER_MEMORY:-2g}" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
  --mount "type=bind,src=$WORKSPACE,dst=/workspace" \
  --mount "type=bind,src=$BRIDGE_DIR,dst=/run/desktop-commander-kubernetes" \
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
  -e DESKTOP_COMMANDER_KUBERNETES_BRIDGE_DIR=/run/desktop-commander-kubernetes \
  -e DC_FLAG_URL=file:///dev/null \
  "$IMAGE"

docker_status=$?
exit "$docker_status"
