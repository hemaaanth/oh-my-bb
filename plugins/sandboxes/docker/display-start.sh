#!/bin/sh
set -eu

# A virtual X display for GUI apps, desktop screenshots, and computer use.
# Sandboxes have no screen and no init system, so this script owns the Xvfb,
# window manager, and optional VNC processes, idempotently.

usage() {
  cat <<'EOF'
Usage: bb-sandbox-display [start|stop|status] [options]

  --size <WxH>      screen geometry (default 1920x1080)
  --display <:N>    X display to use (default :99)
  --vnc [port]      private loopback VNC with an RFB password (default port 5900)

Start prints the DISPLAY value to export. The display number is also recorded
in $BB_DATA_DIR/display so later commands can find it.
EOF
}

action=start
case "${1:-}" in
  start|stop|status) action=$1; shift ;;
  --help|-h) usage; exit 0 ;;
esac

size=1920x1080
display=":99"
vnc=false
vnc_port=5900
while [ "$#" -gt 0 ]; do
  case "$1" in
    --size) shift; size="${1:?--size needs a value}" ;;
    --display) shift; display="${1:?--display needs a value}" ;;
    --vnc)
      vnc=true
      case "${2:-}" in [0-9]*) shift; vnc_port=$1 ;; esac
      ;;
    --help|-h) usage; exit 0 ;;
    *) echo "bb-sandbox-display: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

state_dir="${BB_DATA_DIR:-${HOME:-/root}/.bb}"
install -d -m 700 "$state_dir"
log_file="$state_dir/display.log"
wm_pid_file="$state_dir/openbox-${display#:}.pid"

display_ready() {
  DISPLAY="$display" xdpyinfo >/dev/null 2>&1
}

case "$action" in
  status)
    if display_ready; then
      echo "display $display: ready ($(DISPLAY="$display" xdpyinfo | awk '/dimensions:/ { print $2 }'))"
      exit 0
    fi
    echo "display $display: not running"
    exit 1
    ;;
  stop)
    pkill -f "x11vnc .*-display $display" 2>/dev/null || true
    wm_pid="$(cat "$wm_pid_file" 2>/dev/null || true)"
    if [ -n "$wm_pid" ]; then kill "$wm_pid" 2>/dev/null || true; fi
    rm -f "$wm_pid_file"
    pkill -f "Xvfb $display" 2>/dev/null || true
    rm -f "$state_dir/display"
    echo "display $display: stopped"
    exit 0
    ;;
esac

if ! display_ready; then
  rm -f "/tmp/.X${display#:}-lock"
  setsid Xvfb "$display" -screen 0 "${size}x24" -nolisten tcp \
    >> "$log_file" 2>&1 < /dev/null &
  elapsed=0
  while [ "$elapsed" -lt 20 ]; do
    display_ready && break
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if ! display_ready; then
    echo "bb-sandbox-display: Xvfb did not start; see $log_file" >&2
    exit 1
  fi
fi

# Without a window manager, toolkits draw unmanaged, unpositioned windows that
# screenshot badly and cannot be raised by name.
wm_pid="$(cat "$wm_pid_file" 2>/dev/null || true)"
if [ -z "$wm_pid" ] || ! kill -0 "$wm_pid" 2>/dev/null; then
  DISPLAY="$display" setsid openbox --sm-disable >> "$log_file" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$wm_pid_file"
fi

if [ "$vnc" = true ] && ! pgrep -f "x11vnc .*-display $display" >/dev/null 2>&1; then
  password_file="$state_dir/vnc-password"
  if [ ! -s "$password_file" ]; then
    umask 077
    node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))' > "$password_file"
  fi
  setsid x11vnc -display "$display" -rfbport "$vnc_port" -localhost -forever -shared \
    -passwdfile "$password_file" -quiet >> "$log_file" 2>&1 < /dev/null &
  printf 'Private VNC on loopback port %s. Use the authenticated Browser handoff viewer; do not expose raw VNC.\n' "$vnc_port"
fi

printf '%s\n' "$display" > "$state_dir/display"
printf 'export DISPLAY=%s\n' "$display"
