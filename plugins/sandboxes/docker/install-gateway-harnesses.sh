#!/bin/sh
set -eu
PI_VERSION="${PI_VERSION:-1.2.0}"
PRIME_AGENT_VERSION="${PRIME_AGENT_VERSION:-0.10.0}"
# Release owner supplies the commit containing all three adapters before rollout.
ADAPTERS_REF="${ADAPTERS_REF:-767333e2c1f8f87154e1c64c8928bdf87d8d0d95}"
P="${BB_HARNESS_PREFIX:-/usr/local}"
export PATH="$P/bin:$PATH"
install -d -m 755 "$P/bin"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ "$(pi --version 2>/dev/null || true)" != "$PI_VERSION" ]; then
  # An interrupted install leaves these behind, and npm then fails with ENOTEMPTY.
  rm -rf "$P/lib/node_modules/@earendil-works/pi-coding-agent"
  find "$P/lib/node_modules/@earendil-works" -maxdepth 1 -type d -name ".pi-coding-agent-*" -exec rm -rf {} + 2>/dev/null || true
  npm install --global --prefix "$P" --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
fi
if [ "$(prime-agent --version 2>/dev/null | awk '{print $NF; exit}')" != "$PRIME_AGENT_VERSION" ]; then
  glibc="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
  [ "$(printf '%s\n' 2.35 "$glibc" | sort -V | head -n1)" = 2.35 ] || {
    echo 'Prime Agent requires glibc >= 2.35' >&2; exit 1;
  }
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo 'Unsupported Prime Agent architecture' >&2; exit 1 ;;
  esac
  asset="prime-agent-$PRIME_AGENT_VERSION-linux-$arch.tar.gz"
  base="https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v$PRIME_AGENT_VERSION"
  curl -fsSL --retry 5 "$base/$asset" -o "$work/$asset"
  curl -fsSL --retry 5 "$base/SHA256SUMS" -o "$work/sums"
  sum="$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset {print $1}' "$work/sums")"
  [ -n "$sum" ] || { echo "No Prime Agent checksum for $asset" >&2; exit 1; }
  printf '%s  %s\n' "$sum" "$work/$asset" | sha256sum --check --status
  mkdir "$work/prime"
  tar -xzf "$work/$asset" -C "$work/prime"
  PRIME_AGENT_RUST_PREFIX="$P" PRIME_AGENT_VERSION="$PRIME_AGENT_VERSION" \
    sh "$work/prime/install.sh" --archive "$work/$asset"
fi

# Hash the executable bytes, not a package version shared by different commits.
need_adapters=
for name in fx-acp nanocodex-acp prime-agent-acp; do
  case "$name" in
    fx-acp) expected="${FX_ACP_SHA256:-}" ;;
    nanocodex-acp) expected="${NANOCODEX_ACP_SHA256:-}" ;;
    prime-agent-acp) expected="${PRIME_AGENT_ACP_SHA256:-}" ;;
  esac
  binary="$(command -v "$name" || true)"
  current=
  [ -z "$binary" ] || current="$(sha256sum "$binary" | cut -d' ' -f1)"
  [ -n "$expected" ] && [ "$current" = "$expected" ] || need_adapters=1
done
if [ -n "$need_adapters" ]; then
  printf '%s' "$ADAPTERS_REF" | grep -Eq '^[0-9a-f]{40}$' || {
    echo 'ADAPTERS_REF must be the immutable oh-my-bb commit containing all adapters' >&2; exit 1;
  }
  curl -fsSL --retry 5 "https://codeload.github.com/hemaaanth/oh-my-bb/tar.gz/$ADAPTERS_REF" -o "$work/adapters.tar.gz"
  tar -xzf "$work/adapters.tar.gz" -C "$work"
  for name in fx-acp nanocodex-acp prime-agent-acp; do
    package="$work/oh-my-bb-$ADAPTERS_REF/agents/$name"
    npm pack "$package" --pack-destination "$work" --ignore-scripts >/dev/null
    archive="$(node -e 'const p=require(process.argv[1]);console.log(p.name.replace("@", "").replace("/", "-")+"-"+p.version+".tgz")' "$package/package.json")"
    # An interrupted install leaves these behind, and npm then fails with ENOTEMPTY.
    rm -rf "$P/lib/node_modules/$name"
    find "$P/lib/node_modules" -maxdepth 1 -type d -name ".$name-*" -exec rm -rf {} + 2>/dev/null || true
    npm install --global --prefix "$P" --ignore-scripts "$work/$archive"
  done
fi
for name in fx-acp nanocodex-acp prime-agent-acp; do
  case "$name" in
    fx-acp) expected="${FX_ACP_SHA256:-}" ;;
    nanocodex-acp) expected="${NANOCODEX_ACP_SHA256:-}" ;;
    prime-agent-acp) expected="${PRIME_AGENT_ACP_SHA256:-}" ;;
  esac
  [ -z "$expected" ] || printf '%s  %s\n' "$expected" "$(command -v "$name")" | sha256sum --check --status
done
