#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_IMAGE=${NODE_IMAGE:-node:24-slim}

if [ "${1:-}" = "--no-sync" ]; then
	docker run --rm \
		-v "$SCRIPT_DIR":/workspace \
		-w /workspace \
		"$NODE_IMAGE" \
		node build-professor-schedule.js
else
	docker run --rm \
		-v "$SCRIPT_DIR":/workspace \
		-w /workspace \
		"$NODE_IMAGE" \
		sh -c 'node sync-professors.js "$@" && node build-professor-schedule.js' -- "$@"
fi
