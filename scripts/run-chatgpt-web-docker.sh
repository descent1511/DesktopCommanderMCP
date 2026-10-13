#!/bin/sh
set -eu

# This launcher is the command given to Secure MCP Tunnel.  It intentionally
# emits no normal output of its own: stdout belongs to the MCP stdio stream.

DOCKER_BIN="${DOCKER_BIN:-/opt/homebrew/bin/docker}"
IMAGE="${CHATGPT_DESKTOP_COMMANDER_IMAGE:-desktop-commander-chatgpt:local}"
WORKSPACE="${CHATGPT_WORKSPACE:-/Users/descent/Projects}"
AIRR_WORKSPACE="${CHATGPT_AIRR_WORKSPACE:-/Users/descent/Documents/AIRR}"
PIM_WORKSPACE="${CHATGPT_PIM_WORKSPACE:-/Users/descent/Documents/AIRR/pim}"
PIM_UI_WORKSPACE="${CHATGPT_PIM_UI_WORKSPACE:-/Users/descent/Documents/AIRR/pim-ui}"
GO_MODULE_CACHE="${CHATGPT_GO_MODULE_CACHE:-/Users/descent/go/pkg/mod}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
NODE_BIN="${CHATGPT_NODE_BIN:-$(command -v node || true)}"
BRIDGE_DIR=""
BRIDGE_PID=""
GIT_BRIDGE_DIR=""
GIT_BRIDGE_PID=""

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

if [ ! -d "$AIRR_WORKSPACE" ]; then
  echo "AIRR workspace does not exist: $AIRR_WORKSPACE" >&2
  exit 1
fi

AIRR_WORKSPACE="$(cd "$AIRR_WORKSPACE" && pwd -P)"
case "$AIRR_WORKSPACE" in
  /|/Users|/Users/|/Users/descent|/Users/descent/)
    echo "Refusing an overly broad AIRR workspace: $AIRR_WORKSPACE" >&2
    exit 1
    ;;
esac

if [ ! -d "$PIM_WORKSPACE" ]; then
  echo "PIM workspace does not exist: $PIM_WORKSPACE" >&2
  exit 1
fi

PIM_WORKSPACE="$(cd "$PIM_WORKSPACE" && pwd -P)"
case "$PIM_WORKSPACE" in
  /|/Users|/Users/|/Users/descent|/Users/descent/)
    echo "Refusing an overly broad PIM workspace: $PIM_WORKSPACE" >&2
    exit 1
    ;;
esac

if [ ! -d "$PIM_UI_WORKSPACE" ]; then
  echo "PIM UI workspace does not exist: $PIM_UI_WORKSPACE" >&2
  exit 1
fi

PIM_UI_WORKSPACE="$(cd "$PIM_UI_WORKSPACE" && pwd -P)"
case "$PIM_UI_WORKSPACE" in
  /|/Users|/Users/|/Users/descent|/Users/descent/)
    echo "Refusing an overly broad PIM UI workspace: $PIM_UI_WORKSPACE" >&2
    exit 1
    ;;
esac

GO_MODULE_CACHE_MOUNT=""
if [ -d "$GO_MODULE_CACHE" ]; then
  GO_MODULE_CACHE="$(cd "$GO_MODULE_CACHE" && pwd -P)"
  GO_MODULE_CACHE_MOUNT="--mount type=bind,src=$GO_MODULE_CACHE,dst=/go/pkg/mod,readonly"
else
  echo "Go module cache not found; uncached Go dependencies cannot be downloaded while the container is offline: $GO_MODULE_CACHE" >&2
fi

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
  if [ -n "$GIT_BRIDGE_PID" ] && kill -0 "$GIT_BRIDGE_PID" 2>/dev/null; then
    kill "$GIT_BRIDGE_PID" 2>/dev/null || true
    wait "$GIT_BRIDGE_PID" 2>/dev/null || true
  fi
  if [ -n "$BRIDGE_DIR" ]; then
    rm -rf "$BRIDGE_DIR"
  fi
  if [ -n "$GIT_BRIDGE_DIR" ]; then
    rm -rf "$GIT_BRIDGE_DIR"
  fi
}
trap cleanup_bridge EXIT INT TERM

"$NODE_BIN" "$SCRIPT_DIR/kubernetes-bridge.mjs" --dir "$BRIDGE_DIR" >/dev/null 2>"$BRIDGE_DIR/bridge.log" &
BRIDGE_PID=$!

bridge_attempt=0
while ! kill -0 "$BRIDGE_PID" 2>/dev/null; do
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

# Git uses a separate queue and a separate host process. The container never
# receives the host repository paths directly; these environment variables let
# the bridge map /workspace, /airr, /pim, and /pim-ui safely back to the Mac.
GIT_BRIDGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/desktop-commander-git.XXXXXX")"
DESKTOP_COMMANDER_GIT_ALLOWED_ROOTS="$WORKSPACE:$AIRR_WORKSPACE" \
DESKTOP_COMMANDER_GIT_HOST_WORKSPACE="$WORKSPACE" \
DESKTOP_COMMANDER_GIT_HOST_AIRR="$AIRR_WORKSPACE" \
DESKTOP_COMMANDER_GIT_HOST_PIM="$PIM_WORKSPACE" \
DESKTOP_COMMANDER_GIT_HOST_PIM_UI="$PIM_UI_WORKSPACE" \
  "$NODE_BIN" "$SCRIPT_DIR/git-bridge.mjs" --dir "$GIT_BRIDGE_DIR" >/dev/null 2>"$GIT_BRIDGE_DIR/bridge.log" &
GIT_BRIDGE_PID=$!

git_bridge_attempt=0
while ! kill -0 "$GIT_BRIDGE_PID" 2>/dev/null; do
  if ! kill -0 "$GIT_BRIDGE_PID" 2>/dev/null; then
    echo "Git bridge failed to start:" >&2
    sed -n '1,80p' "$GIT_BRIDGE_DIR/bridge.log" >&2 || true
    exit 1
  fi
  git_bridge_attempt=$((git_bridge_attempt + 1))
  if [ "$git_bridge_attempt" -gt 100 ]; then
    echo "Timed out waiting for the Git bridge" >&2
    sed -n '1,80p' "$GIT_BRIDGE_DIR/bridge.log" >&2 || true
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
  --tmpfs /go-tmp:rw,exec,nosuid,nodev,size=8g \
  --mount "type=bind,src=$WORKSPACE,dst=/workspace" \
  --mount "type=bind,src=$AIRR_WORKSPACE,dst=/airr" \
  --mount "type=bind,src=$PIM_WORKSPACE,dst=/pim" \
  --mount "type=bind,src=$PIM_UI_WORKSPACE,dst=/pim-ui" \
  $GO_MODULE_CACHE_MOUNT \
  --mount "type=bind,src=$BRIDGE_DIR,dst=/run/desktop-commander-kubernetes" \
  --mount "type=bind,src=$GIT_BRIDGE_DIR,dst=/run/desktop-commander-git" \
  --workdir /workspace \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/desktop-commander-home \
  -e DESKTOP_COMMANDER_CONFIG_DIR=/tmp/desktop-commander-config \
  -e DESKTOP_COMMANDER_ALLOWED_DIRECTORIES=/workspace:/airr:/pim:/pim-ui \
  -e GOPATH=/go \
  -e GOTOOLCHAIN=local \
  -e GOPROXY=off \
  -e GOSUMDB=off \
  -e "GOFLAGS=-mod=readonly -p=2" \
  -e GOTMPDIR=/go-tmp \
  -e GOCACHE=/go-tmp/cache \
  -e GOMODCACHE=/go/pkg/mod \
  -e DESKTOP_COMMANDER_DEFAULT_SHELL=/bin/sh \
  -e DESKTOP_COMMANDER_DISABLE_TELEMETRY=1 \
  -e DESKTOP_COMMANDER_DISABLE_NETWORK=1 \
  -e DESKTOP_COMMANDER_DISABLE_HISTORY=1 \
  -e DESKTOP_COMMANDER_DISABLE_USAGE_TRACKING=1 \
  -e DESKTOP_COMMANDER_REDACT_SECRETS=1 \
  -e DESKTOP_COMMANDER_HARDENED=1 \
  -e DESKTOP_COMMANDER_KUBERNETES_BRIDGE_DIR=/run/desktop-commander-kubernetes \
  -e DESKTOP_COMMANDER_GIT_BRIDGE_DIR=/run/desktop-commander-git \
  -e DC_FLAG_URL=file:///dev/null \
  "$IMAGE"

docker_status=$?
exit "$docker_status"
