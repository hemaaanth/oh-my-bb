#!/bin/sh
set -eu

. /usr/local/lib/bb-sandbox/image-tools.sh

BB_APP_VERSION="${BB_APP_VERSION:-latest}"
OMP_VERSION="${OMP_VERSION:-18.10.3}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.296}"
CODEX_VERSION="${CODEX_VERSION:-0.162.1}"
FX_VERSION="${FX_VERSION:-0.0.13}"
BB_HARNESS_PREFIX="${BB_HARNESS_PREFIX:-/usr/local}"

install -d -m 755 "$BB_HARNESS_PREFIX/bin"
# Old durable sandboxes can be nearly full, and npm's cache is safe to
# reconstruct. Reclaim it before staging OMP's comparatively large binary.
npm cache clean --force >/dev/null 2>&1 || true

architecture="$(uname -m)"
case "$architecture" in
  x86_64)
    omp_arch=x64
    fx_arch=x86_64
    ;;
  aarch64|arm64)
    omp_arch=arm64
    fx_arch=aarch64
    ;;
  *)
    echo "Unsupported harness architecture: $architecture" >&2
    exit 1
    ;;
esac

omp_asset="omp-linux-${omp_arch}"
fx_asset="fx-linux-${fx_arch}.tar.gz"
cleanup() {
  rm -f /tmp/omp /tmp/omp-sha256sums.txt /tmp/fx \
    "/tmp/${fx_asset}" "/tmp/${fx_asset}.sha256"
}
trap cleanup EXIT
cleanup

if bb_image_has omp && [ "$("$BB_HARNESS_PREFIX/bin/omp" --version 2>/dev/null || true)" != "omp/${OMP_VERSION}" ]; then
  curl --fail --silent --show-error --location --retry 5 \
    "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/${omp_asset}" \
    --output /tmp/omp
  curl --fail --silent --show-error --location --retry 5 \
    "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/SHA256SUMS.txt" \
    --output /tmp/omp-sha256sums.txt
  omp_checksum="$(awk -v asset="$omp_asset" '$2 == asset { print $1 }' /tmp/omp-sha256sums.txt)"
  if [ -z "$omp_checksum" ]; then
    echo "No official OMP checksum found for ${omp_asset}" >&2
    exit 1
  fi
  printf '%s  %s\n' "$omp_checksum" /tmp/omp | sha256sum --check --status
  chmod 755 /tmp/omp
  mv -f /tmp/omp "$BB_HARNESS_PREFIX/bin/omp"
  rm -f /tmp/omp-sha256sums.txt
fi

if bb_image_has fx && [ "$("$BB_HARNESS_PREFIX/bin/fx" --version 2>/dev/null || true)" != "$FX_VERSION" ]; then
  curl --fail --silent --show-error --location --retry 5 \
    "https://github.com/vercel-labs/fx/releases/download/v${FX_VERSION}/${fx_asset}" \
    --output "/tmp/${fx_asset}"
  curl --fail --silent --show-error --location --retry 5 \
    "https://github.com/vercel-labs/fx/releases/download/v${FX_VERSION}/${fx_asset}.sha256" \
    --output "/tmp/${fx_asset}.sha256"
  fx_checksum="$(awk '{ print $1; exit }' "/tmp/${fx_asset}.sha256")"
  printf '%s  %s\n' "$fx_checksum" "/tmp/${fx_asset}" | sha256sum --check --status
  tar -C /tmp -xzf "/tmp/${fx_asset}"
  chmod 755 /tmp/fx
  mv -f /tmp/fx "$BB_HARNESS_PREFIX/bin/fx"
  rm -f "/tmp/${fx_asset}" "/tmp/${fx_asset}.sha256"
fi

packages="bb-app@${BB_APP_VERSION}"
if bb_image_has claude-code; then packages="$packages @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; fi
if bb_image_has codex; then packages="$packages @openai/codex@${CODEX_VERSION}"; fi
npm install --global --prefix "$BB_HARNESS_PREFIX" \
  --allow-scripts=@anthropic-ai/claude-code,@parcel/watcher,better-sqlite3,node-pty,@google/genai,protobufjs $packages
npm cache clean --force
