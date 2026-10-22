#!/bin/sh
# Keep the machine reachable when an agent exhausts memory.
#
# Losing a worker agent costs one turn; losing the host daemon costs the whole
# session, because bb can no longer reach the sandbox and every follow-up fails
# with "No active ACP session" on a machine that is otherwise healthy. The
# kernel picks its OOM victim by RSS, so the daemon is a plausible target even
# though it is the one process that must survive.
#
# Three layers, applied best-effort, in ascending order of how much they can be
# relied on:
#   1. oom_score_adj -1000 on the daemon, which removes it from victim
#      selection entirely. Measured on Daytona: DENIED even as uid 0, because
#      lowering the score needs CAP_SYS_RESOURCE and the container is not
#      granted it. Kept because providers that do grant it get the strongest
#      guarantee for free.
#   2. Worker agents raise their OWN score to a positive value in
#      bb-sandbox-agent-shim. Raising is always permitted, so this half works
#      everywhere and is what actually makes a worker the preferred victim
#      ahead of a daemon sitting at 0.
#   3. A memory-capped cgroup for worker agents with memory.oom.group set, so a
#      fan-out can only exhaust its own share and the kill lands inside that
#      subtree. Verified working on Daytona; needs a writable cgroup
#      filesystem, which not every provider offers.
#
# Any failure here is non-fatal: a sandbox that cannot be hardened must still
# enroll and run.
set -u

cgroup_root="/sys/fs/cgroup"
agents_cgroup="$cgroup_root/bb-agents"
supervisor_cgroup="$cgroup_root/bb-supervisor"
# Leave the rest for the daemon, the provider's own agent, and page cache.
agents_max_percent=70
agents_high_percent=60

log() {
  echo "[bb-sandbox-agent-guard] $1" >&2
}

# Both settings have to land on the ENTRYPOINT's pid, not this script's. The
# entrypoint execs the host daemon, so its pid is the daemon's pid, while this
# guard is a short-lived child whose settings die with it. Verified the hard
# way: a first cut wrote to /proc/self and left the daemon at oom_score_adj 0.
target_pid=${PPID:-0}

protect_daemon() {
  if [ "$target_pid" -le 0 ] 2>/dev/null; then
    log "no parent pid to protect; host daemon stays eligible for OOM kill"
    return
  fi
  if echo -1000 > "/proc/$target_pid/oom_score_adj" 2>/dev/null; then
    log "host daemon (pid $target_pid) exempted from OOM victim selection"
  else
    log "could not lower oom_score_adj; needs root or CAP_SYS_RESOURCE"
  fi
}

# The kernel enforces this limit, so it is the only honest basis for the split.
box_memory_bytes() {
  limit=$(cat "$cgroup_root/memory.max" 2>/dev/null || echo "")
  case "$limit" in
    ''|max)
      awk '/^MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo 2>/dev/null
      ;;
    *) echo "$limit" ;;
  esac
}

configure_agent_cgroup() {
  if [ ! -d "$cgroup_root/cgroup.controllers" ] && [ ! -f "$cgroup_root/cgroup.controllers" ]; then
    log "no cgroup v2 filesystem; skipping the worker memory cap"
    return
  fi
  case "$(cat "$cgroup_root/cgroup.subtree_control" 2>/dev/null || echo "")" in
    *memory*) ;;
    *)
      # Enabling it ourselves is what a delegated subtree normally requires.
      # The redirect itself fails on a read-only cgroupfs, so the whole
      # statement runs in a subshell that swallows the shell's own message.
      if ! (exec 2>/dev/null; echo "+memory" > "$cgroup_root/cgroup.subtree_control"); then
        log "memory controller is not delegated; skipping the worker memory cap"
        return
      fi
      ;;
  esac

  mkdir -p "$agents_cgroup" "$supervisor_cgroup" 2>/dev/null || {
    log "cannot create child cgroups; skipping the worker memory cap"
    return
  }

  total=$(box_memory_bytes)
  case "$total" in
    ''|*[!0-9]*)
      log "could not read a memory limit; leaving the worker cgroup uncapped"
      ;;
    *)
      # memory.high throttles and reclaims first, so pressure shows up as PSI
      # and slow progress instead of a hard kill at the ceiling.
      echo $((total * agents_high_percent / 100)) > "$agents_cgroup/memory.high" 2>/dev/null || true
      echo $((total * agents_max_percent / 100)) > "$agents_cgroup/memory.max" 2>/dev/null || true
      log "worker cgroup capped at ${agents_max_percent}% of ${total} bytes"
      ;;
  esac
  # Kill a runaway agent tree whole rather than leaving orphaned children
  # attached to a supervisor that thinks the turn is still running.
  echo 1 > "$agents_cgroup/memory.oom.group" 2>/dev/null || true

  if echo "$target_pid" > "$supervisor_cgroup/cgroup.procs" 2>/dev/null; then
    log "host daemon (pid $target_pid) moved into $supervisor_cgroup"
  else
    log "could not move the host daemon into its own cgroup"
  fi
}

protect_daemon
configure_agent_cgroup
exit 0
