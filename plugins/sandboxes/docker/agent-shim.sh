#!/bin/sh
# Make worker agents the OOM victim instead of the host daemon.
#
# Installed as /opt/bb-agent-shims/<name> for each agent CLI and dispatched on
# the invoked name, so the daemon launches a worker exactly as before. Two
# things happen before handing over:
#
#   1. Raise our own oom_score_adj. bb-sandbox-agent-guard exempts the daemon
#      from OOM selection, and oom_score_adj is inherited, so without this a
#      worker would inherit that immunity and the kernel would be left choosing
#      between equally protected processes.
#   2. Join the memory-capped worker cgroup when one exists, which also captures
#      every subagent this process spawns, since cgroup membership is inherited.
#
# Both are best-effort. A worker that cannot be contained still has to run.
set -u

name=${0##*/}
real="/usr/local/bin/$name"

if [ -w /proc/self/oom_score_adj ]; then
  echo 500 > /proc/self/oom_score_adj 2>/dev/null || true
fi

if [ -w /sys/fs/cgroup/bb-agents/cgroup.procs ]; then
  echo $$ > /sys/fs/cgroup/bb-agents/cgroup.procs 2>/dev/null || true
fi

if [ ! -x "$real" ]; then
  echo "bb-sandbox-agent-shim: $real is missing" >&2
  exit 127
fi

exec "$real" "$@"
