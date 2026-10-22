#!/bin/sh
set -eu

# Starts a Docker daemon inside the sandbox, idempotently. There is no init
# system here, so dockerd is supervised by nothing: this script is the only
# thing that starts it, from the sandbox entrypoint at boot and from agents
# that need Docker later. Providers that forbid a daemon (Modal's default
# gVisor runtime) fail here, which is expected and must never be fatal for
# the caller's boot sequence.

usage() {
  cat <<'EOF'
Usage: bb-sandbox-docker [--wait] [--timeout <seconds>] [--status]

  --wait      block until the daemon answers, then exit
  --timeout   seconds to wait for readiness (default 90)
  --status    report daemon state without starting anything
EOF
}

wait_requested=false
status_only=false
timeout_seconds=90
while [ "$#" -gt 0 ]; do
  case "$1" in
    --wait) wait_requested=true ;;
    --status) status_only=true ;;
    --timeout) shift; timeout_seconds="${1:?--timeout needs a value}" ;;
    --help|-h) usage; exit 0 ;;
    *) echo "bb-sandbox-docker: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log_dir="${BB_DATA_DIR:-${HOME:-/root}/.bb}"
log_file="$log_dir/dockerd.log"

daemon_ready() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "bb-sandbox-docker: the docker CLI is not installed" >&2
  exit 1
fi

if daemon_ready; then
  [ "$status_only" = true ] && echo "docker: ready"
  exit 0
fi

if [ "$status_only" = true ]; then
  echo "docker: not running"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "bb-sandbox-docker: dockerd needs root in a sandbox without an init system" >&2
  exit 1
fi

if ! command -v dockerd >/dev/null 2>&1; then
  echo "bb-sandbox-docker: dockerd is not installed" >&2
  exit 1
fi

install -d -m 700 "$log_dir"

# overlay2 is unavailable when the sandbox root is already an overlay mount,
# which is the normal case for container-backed providers. fuse-overlayfs is
# the documented fallback and vfs is the last resort.
storage_driver="${BB_SANDBOX_DOCKER_STORAGE_DRIVER:-}"
if [ -z "$storage_driver" ]; then
  root_fstype="$(stat --file-system --format=%T /var/lib/docker 2>/dev/null || stat --file-system --format=%T / 2>/dev/null || echo unknown)"
  case "$root_fstype" in
    overlayfs|overlay)
      if command -v fuse-overlayfs >/dev/null 2>&1 && [ -e /dev/fuse ]; then
        storage_driver=fuse-overlayfs
      else
        storage_driver=vfs
      fi
      ;;
    *) storage_driver=overlay2 ;;
  esac
fi

printf '%s bb-sandbox-docker: starting dockerd with the %s storage driver\n' \
  "$(date -Is)" "$storage_driver" >> "$log_file"
setsid dockerd --storage-driver "$storage_driver" >> "$log_file" 2>&1 </dev/null &

if [ "$wait_requested" != true ]; then
  exit 0
fi

elapsed=0
while [ "$elapsed" -lt "$timeout_seconds" ]; do
  if daemon_ready; then
    exit 0
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "bb-sandbox-docker: dockerd did not become ready within ${timeout_seconds}s; see $log_file" >&2
exit 1
