#!/bin/sh
set -eu

# Computer use inside the sandbox: cua's computer-server exposes keyboard,
# mouse, screen, and PTY control over HTTP and MCP against the virtual display.
# It binds loopback by default because anything that reaches it can drive the
# whole desktop.

usage() {
  cat <<'EOF'
Usage: bb-sandbox-computer [start|stop|status] [options]

  --port <N>        listen port (default 8765)
  --host <addr>     bind address (default 127.0.0.1)
  --display <:N>    X display to control (default: the running one, else :99)

Start prints the command and MCP endpoints:
  POST http://<host>:<port>/cmd   {"command":"screenshot","params":{}}
  MCP  http://<host>:<port>/mcp
EOF
}

action=start
case "${1:-}" in
  start|stop|status) action=$1; shift ;;
  --help|-h) usage; exit 0 ;;
esac

port=8765
host=127.0.0.1
display=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) shift; port="${1:?--port needs a value}" ;;
    --host) shift; host="${1:?--host needs a value}" ;;
    --display) shift; display="${1:?--display needs a value}" ;;
    --help|-h) usage; exit 0 ;;
    *) echo "bb-sandbox-computer: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

state_dir="${BB_DATA_DIR:-${HOME:-/root}/.bb}"
install -d -m 700 "$state_dir"
log_file="$state_dir/computer-server.log"

server_ready() {
  curl --fail --silent --max-time 3 "http://${host}:${port}/status" >/dev/null 2>&1
}

case "$action" in
  status)
    if server_ready; then
      curl --silent --max-time 3 "http://${host}:${port}/status"
      printf '\n'
      exit 0
    fi
    echo "computer-server: not running on ${host}:${port}"
    exit 1
    ;;
  stop)
    pkill -f "cua-computer-server .*--port $port" 2>/dev/null || true
    echo "computer-server: stopped"
    exit 0
    ;;
esac

if server_ready; then
  printf 'computer-server already listening on http://%s:%s\n' "$host" "$port"
  exit 0
fi

if [ -z "$display" ]; then
  display="$(cat "$state_dir/display" 2>/dev/null || printf ':99')"
fi
DISPLAY="$display" xdpyinfo >/dev/null 2>&1 \
  || bb-sandbox-display start --display "$display" >/dev/null
export DISPLAY="$display"

setsid env \
  CUA_DRIVER_RS_TELEMETRY_ENABLED=false \
  CUA_DRIVER_RS_UPDATE_CHECK=false \
  cua-computer-server --host "$host" --port "$port" \
  >> "$log_file" 2>&1 < /dev/null &
server_pid=$!

elapsed=0
while [ "$elapsed" -lt 60 ]; do
  if server_ready; then
    printf 'computer-server on display %s\n' "$display"
    printf '  commands: POST http://%s:%s/cmd\n' "$host" "$port"
    printf '  mcp:      http://%s:%s/mcp\n' "$host" "$port"
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    status=0
    wait "$server_pid" || status=$?
    echo "bb-sandbox-computer: server exited with status $status" >&2
    tail -n 30 "$log_file" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "bb-sandbox-computer: server did not become ready; see $log_file" >&2
tail -n 30 "$log_file" >&2
exit 1
