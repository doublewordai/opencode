#!/bin/sh
# Two-service entrypoint: dispatches to either the opencode server or the pr-review-shim
# based on the first argument. Defaults to opencode-server.
set -e

case "${1:-opencode-server}" in
  opencode-server)
    shift || true
    exec opencode serve --hostname "${OPENCODE_HOST:-0.0.0.0}" --port "${OPENCODE_PORT:-14123}" "$@"
    ;;
  shim|pr-review-shim)
    shift || true
    exec pr-review-shim "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
