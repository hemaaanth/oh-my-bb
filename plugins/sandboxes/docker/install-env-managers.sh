#!/bin/sh
set -eu

. /usr/local/lib/bb-sandbox/image-tools.sh

# Nix, devbox, direnv, and process-compose. Repositories that pin their whole
# toolchain in devbox.json or flake.nix are unusable without these, and a
# sandbox has no init system, so the Determinate installer's --init none mode
# is the only supported way to land a working /nix in an image layer.

DEVBOX_VERSION="${DEVBOX_VERSION:-0.18.0}"
PROCESS_COMPOSE_VERSION="${PROCESS_COMPOSE_VERSION:-1.122.0}"

if bb_image_has direnv; then
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends direnv
apt-get clean
rm -rf /var/lib/apt/lists/*

fi
architecture="$(dpkg --print-architecture)"
case "$architecture" in
  amd64) process_compose_arch=amd64 ;;
  arm64) process_compose_arch=arm64 ;;
  *) echo "Unsupported architecture for process-compose: $architecture" >&2; exit 1 ;;
esac

if bb_image_has process-compose; then
process_compose_asset="process-compose_linux_${process_compose_arch}.tar.gz"
process_compose_release="https://github.com/F1bonacc1/process-compose/releases/download/v${PROCESS_COMPOSE_VERSION}"
curl --fail --location --retry 5 \
  "${process_compose_release}/${process_compose_asset}" \
  --output "/tmp/${process_compose_asset}"
curl --fail --location --retry 5 \
  "${process_compose_release}/process-compose_checksums.txt" \
  --output /tmp/process-compose-checksums.txt
process_compose_checksum="$(awk -v asset="$process_compose_asset" '$2 == asset || $2 == "*" asset { print $1 }' /tmp/process-compose-checksums.txt)"
if [ -z "$process_compose_checksum" ]; then
  echo "No official process-compose checksum found for ${process_compose_asset}" >&2
  exit 1
fi
printf '%s  %s\n' "$process_compose_checksum" "/tmp/${process_compose_asset}" \
  | sha256sum --check --status
tar -C /usr/local/bin -xzf "/tmp/${process_compose_asset}" process-compose
chmod 755 /usr/local/bin/process-compose

fi
if bb_image_has nix; then
# The upstream nixos.org script refuses to install as root and its multi-user
# mode requires systemd. --init none is the container recipe; the Nix build
# sandbox itself needs user namespaces the provider may not grant, so builds
# run unsandboxed.
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 5 \
  https://install.determinate.systems/nix --output /tmp/install-nix.sh
sh /tmp/install-nix.sh install linux \
  --extra-conf "sandbox = false" \
  --extra-conf "experimental-features = nix-command flakes" \
  --init none \
  --no-confirm
for executable in nix nix-build nix-env nix-shell nix-store; do
  ln -sf "/nix/var/nix/profiles/default/bin/$executable" "/usr/local/bin/$executable"
done

fi
if bb_image_has devbox; then
# devbox defaults to a multi-user Nix install when it runs as root and Nix is
# missing; Nix is already present above, so the installer only lands its
# launcher script. -f skips the interactive confirmation.
export DEVBOX_USE_VERSION="$DEVBOX_VERSION"
curl --fail --silent --show-error --location --retry 5 \
  https://get.jetify.com/devbox --output /tmp/install-devbox.sh
bash /tmp/install-devbox.sh -f

# The launcher downloads the real binary into a versioned directory under
# $HOME/.cache/devbox/bin on first use, which would be a network round trip
# inside every fresh sandbox. Materialize it here and replace the launcher.
devbox version
devbox_binary="$(find "${HOME:-/root}/.cache/devbox/bin" -type f -name devbox | head -1)"
if [ -z "$devbox_binary" ]; then
  echo "The devbox launcher did not materialize a binary to install" >&2
  exit 1
fi
install -m 755 "$devbox_binary" /usr/local/bin/devbox
devbox version

fi
rm -f /tmp/install-devbox.sh /tmp/install-nix.sh \
  /tmp/process-compose-checksums.txt "/tmp/${process_compose_asset:-unused}"
rm -rf "${HOME:-/root}/.cache"
