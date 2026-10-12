#!/bin/sh
set -eu

DOCKER_BIN="${DOCKER_BIN:-/opt/homebrew/bin/docker}"
IMAGE="${CHATGPT_DESKTOP_COMMANDER_IMAGE:-desktop-commander-chatgpt:local}"

exec "$DOCKER_BIN" build \
  --file Dockerfile.chatgpt \
  --tag "$IMAGE" \
  .
