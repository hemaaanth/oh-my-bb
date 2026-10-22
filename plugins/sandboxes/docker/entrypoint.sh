#!/bin/sh
set -eu

export JAVA_HOME=/opt/java
export CARGO_HOME=/opt/rust/cargo
export RUSTUP_HOME=/opt/rust/rustup
export BUN_INSTALL=/opt/bun
export DENO_INSTALL=/opt/deno
export IS_SANDBOX=1
export PATH="/usr/local/go/bin:/opt/rust/cargo/bin:/opt/java/bin:/opt/bun/bin:/opt/deno/bin:/nix/var/nix/profiles/default/bin:${PATH}"

# Daytona restarts and Modal filesystem restores do not replay the creation
# environment. Persist only the bootstrap values needed by an already-enrolled
# daemon, in a root-only, non-executable format.
sandbox_home=${BB_SANDBOX_HOME:-${HOME:-/root}}
export HOME="$sandbox_home"
export PATH="$sandbox_home/.local/bin:/usr/local/bin:$PATH"
export BB_DATA_DIR=${BB_DATA_DIR:-$sandbox_home/.bb}
export BB_SANDBOX_PREVIEW_DIR=${BB_SANDBOX_PREVIEW_DIR:-$BB_DATA_DIR/sandbox-previews}
runtime_env_file=$BB_DATA_DIR/sandbox-runtime-env
install -d -m 700 "$BB_DATA_DIR"

write_runtime_value() {
  runtime_key=$1
  runtime_value=$2
  [ -n "$runtime_value" ] || return 0
  runtime_encoded=$(printf '%s' "$runtime_value" | base64 | tr -d '\n')
  printf '%s=%s\n' "$runtime_key" "$runtime_encoded" >> "$runtime_env_file"
}

if [ -n "${BB_SERVER_URL:-}" ] && [ -n "${BB_CONNECT_MACHINE_CREDENTIAL:-}" ]; then
  : > "$runtime_env_file"
  chmod 600 "$runtime_env_file"
  write_runtime_value BB_SERVER_URL "$BB_SERVER_URL"
  write_runtime_value BB_CONNECT_MACHINE_CREDENTIAL "$BB_CONNECT_MACHINE_CREDENTIAL"
  write_runtime_value BB_CONNECT_MACHINE_ID "${BB_CONNECT_MACHINE_ID:-}"
  write_runtime_value BB_HOST_ID "${BB_HOST_ID:-}"
  write_runtime_value BB_HOST_NAME "${BB_HOST_NAME:-}"
  write_runtime_value BB_DATA_DIR "${BB_DATA_DIR:-}"
elif [ -f "$runtime_env_file" ]; then
  while IFS='=' read -r runtime_key runtime_encoded; do
    case "$runtime_key" in
      BB_SERVER_URL|BB_CONNECT_MACHINE_CREDENTIAL|BB_CONNECT_MACHINE_ID|BB_HOST_ID|BB_HOST_NAME|BB_DATA_DIR)
        runtime_value=$(printf '%s' "$runtime_encoded" | base64 -d)
        export "$runtime_key=$runtime_value"
        ;;
    esac
  done < "$runtime_env_file"
fi

git_askpass="$BB_DATA_DIR/sandbox-auth/git-askpass"
if [ -n "${BB_SANDBOX_GIT_TOKEN:-}" ]; then
  install -d -m 700 "$BB_DATA_DIR/sandbox-auth"
  printf '%s' "$BB_SANDBOX_GIT_TOKEN" > "$BB_DATA_DIR/sandbox-auth/git-token"
  printf '%s' "${BB_SANDBOX_GIT_USERNAME:-x-access-token}" > "$BB_DATA_DIR/sandbox-auth/git-username"
  chmod 600 "$BB_DATA_DIR/sandbox-auth/git-token"
  chmod 600 "$BB_DATA_DIR/sandbox-auth/git-username"
  cat > "$git_askpass" <<'SCRIPT'
#!/bin/sh
case "$1" in
  *sername*) cat "${BB_DATA_DIR:-$HOME/.bb}/sandbox-auth/git-username" ;;
  *) cat "${BB_DATA_DIR:-$HOME/.bb}/sandbox-auth/git-token" ;;
esac
SCRIPT
  chmod 700 "$git_askpass"
  unset BB_SANDBOX_GIT_TOKEN BB_SANDBOX_GIT_USERNAME
fi
# Keyed off the durable file rather than the creation environment: a provider
# restart replays neither, and git would otherwise lose its credential.
if [ -x "$git_askpass" ]; then
  export GIT_ASKPASS="$git_askpass"
  export GIT_TERMINAL_PROMPT=0
fi

# Authentication permits GitHub access; these values separately preserve the
# source machine's commit attribution in the sandbox's durable global config.
if [ -n "${BB_SANDBOX_GIT_USER_NAME:-}" ]; then
  git config --global user.name "$BB_SANDBOX_GIT_USER_NAME"
  unset BB_SANDBOX_GIT_USER_NAME
fi
if [ -n "${BB_SANDBOX_GIT_USER_EMAIL:-}" ]; then
  git config --global user.email "$BB_SANDBOX_GIT_USER_EMAIL"
  unset BB_SANDBOX_GIT_USER_EMAIL
fi

# Sign gh in from the creation environment, writing what `gh auth login` would
# write so the login survives restarts too.
if [ -n "${BB_SANDBOX_GH_TOKEN:-}" ]; then
  gh_host=${BB_SANDBOX_GH_HOST:-github.com}
  install -d -m 700 "$sandbox_home/.config/gh"
  cat > "$sandbox_home/.config/gh/hosts.yml" <<EOF
$gh_host:
    oauth_token: $BB_SANDBOX_GH_TOKEN
    user: ${BB_SANDBOX_GH_USER:-x-access-token}
    git_protocol: https
EOF
  chmod 600 "$sandbox_home/.config/gh/hosts.yml"
  # An explicit Git token stays in charge of git over HTTPS: git consults
  # credential helpers before GIT_ASKPASS, so installing gh's helper would
  # otherwise silently override it.
  if [ ! -x "$git_askpass" ]; then
    git config --global --replace-all \
      "credential.https://$gh_host.helper" '!gh auth git-credential'
    git config --global --replace-all \
      "credential.https://gist.$gh_host.helper" '!gh auth git-credential'
  fi
  unset BB_SANDBOX_GH_TOKEN BB_SANDBOX_GH_USER BB_SANDBOX_GH_HOST
fi

if [ -n "${BB_SANDBOX_GIT_SSH_PRIVATE_KEY:-}" ]; then
  install -d -m 700 "$sandbox_home/.ssh"
  printf '%s\n' "$BB_SANDBOX_GIT_SSH_PRIVATE_KEY" > "$sandbox_home/.ssh/bb-sandbox-key"
  chmod 600 "$sandbox_home/.ssh/bb-sandbox-key"
  if [ -n "${BB_SANDBOX_GIT_KNOWN_HOSTS:-}" ]; then
    printf '%s\n' "$BB_SANDBOX_GIT_KNOWN_HOSTS" > "$sandbox_home/.ssh/known_hosts"
    chmod 600 "$sandbox_home/.ssh/known_hosts"
  fi
  unset BB_SANDBOX_GIT_SSH_PRIVATE_KEY BB_SANDBOX_GIT_KNOWN_HOSTS
fi
if [ -f "$sandbox_home/.ssh/bb-sandbox-key" ]; then
  export GIT_SSH_COMMAND="ssh -i $sandbox_home/.ssh/bb-sandbox-key -o IdentitiesOnly=yes"
fi

# Keep Astra context management enabled without replacing other Codex settings.
# Use the [features] table form because bb may add other feature flags later.
codex_config_dir="$sandbox_home/.codex"
codex_config="$codex_config_dir/config.toml"
install -d -m 700 "$codex_config_dir"
touch "$codex_config"
chmod 600 "$codex_config"
if ! grep -Eq '^[[:space:]]*(features\.)?context_management\.experimental_mode[[:space:]]*=[[:space:]]*true' "$codex_config" \
  && ! awk '
    /^[[:space:]]*\[features\.context_management\][[:space:]]*$/ { in_context = 1; next }
    /^[[:space:]]*\[/ { in_context = 0 }
    in_context && /^[[:space:]]*experimental_mode[[:space:]]*=[[:space:]]*true/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$codex_config"; then
  awk '
    /^[[:space:]]*\[features\][[:space:]]*$/ && !inserted {
      print
      print "context_management.experimental_mode = true"
      inserted = 1
      next
    }
    { print }
    END {
      if (!inserted) {
        print ""
        print "[features]"
        print "context_management.experimental_mode = true"
      }
    }
  ' "$codex_config" > "$codex_config.tmp"
  mv "$codex_config.tmp" "$codex_config"
fi
chmod 600 "$codex_config"

# Registered preview commands live on the provider's durable filesystem. The
# supervisor restores them after Daytona stop/start and keeps them alive after
# ordinary process crashes. E2B and Modal use the same command for consistency.
if command -v bb-sandbox-preview >/dev/null 2>&1; then
  install -d -m 700 "$BB_SANDBOX_PREVIEW_DIR"
  bb-sandbox-preview supervise >> "$BB_SANDBOX_PREVIEW_DIR/supervisor.log" 2>&1 &
fi

# Docker is best-effort: Daytona documents Docker-in-Docker, E2B and Freestyle
# expose a real kernel, and Modal only allows a daemon under its VM runtime.
# A provider that forbids one must not delay or fail enrollment.
if command -v bb-sandbox-docker >/dev/null 2>&1; then
  bb-sandbox-docker || true
fi

# Last thing before the daemon takes over this PID: the guard's oom_score_adj
# change survives the exec, and the cgroup move applies to the daemon itself.
if command -v bb-sandbox-agent-guard >/dev/null 2>&1; then
  bb-sandbox-agent-guard || true
fi

exec bb-host-daemon
