#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_IMAGE=${NODE_IMAGE:-node:24-slim}

docker run --rm \
	-v "$SCRIPT_DIR":/workspace \
	-w /workspace \
	"$NODE_IMAGE" \
	node build-professor-schedule.js "$@"
