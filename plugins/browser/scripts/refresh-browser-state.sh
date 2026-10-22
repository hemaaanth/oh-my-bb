#!/usr/bin/env bash
set -euo pipefail

: "${BB_COOKIE_SYNC_STATE_FILE:?BB_COOKIE_SYNC_STATE_FILE is required}"
# Brave's extension owns live export. This compatibility entry point only
# imports its latest snapshot; it never closes browsers or personal windows.
jq -e '.bbCookieSync == true and (.cookies | type == "array")' "$BB_COOKIE_SYNC_STATE_FILE" >/dev/null || {
  echo 'Pair your browser in Settings → Sandboxes → Browser cookie sync first.' >&2
  exit 1
}
bb-browser state sync default "$BB_COOKIE_SYNC_STATE_FILE"
