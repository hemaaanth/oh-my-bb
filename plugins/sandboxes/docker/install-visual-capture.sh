#!/bin/sh
set -eu

. /usr/local/lib/bb-sandbox/image-tools.sh

# Visual capture and computer use. An agent working in a sandbox has no screen,
# so everything it wants to show a human — a rendered page, a CLI's output, a
# TUI's behaviour, a desktop app — has to be captured deliberately:
#
#   Brave + agent-browser      driving and screenshotting a real browser
#   bb-browser                 the same pair with a pinned identity and home
#                              egress through a Tailscale exit node
#   freeze                     one-shot PNG/SVG of a command's ANSI output
#   vhs + ttyd                 scripted GIF/MP4 of a terminal session or TUI
#   Xvfb + openbox + x11vnc    a virtual desktop for GUI apps
#   ffmpeg + ImageMagick       frame grabs and screen recording from that display
#   cua computer-server        keyboard/mouse/screen control over HTTP and MCP
#
# Brave is the only browser in the image. The chromium, chromium-browser, and
# google-chrome names are aliases for it, so nothing downloads a second one.

AGENT_BROWSER_VERSION="${AGENT_BROWSER_VERSION:-0.38.1}"
CUA_SERVER_VERSION="${CUA_SERVER_VERSION:-0.3.42}"
FREEZE_VERSION="${FREEZE_VERSION:-0.2.2}"
TTYD_VERSION="${TTYD_VERSION:-1.7.7}"
VHS_VERSION="${VHS_VERSION:-0.11.0}"
INSTALL_PREFIX="${BB_AGENT_CLI_PREFIX:-/usr/local}"

export DEBIAN_FRONTEND=noninteractive

# Brave and Tailscale come from their vendors' signed apt repositories; both
# publish amd64 and arm64 builds. Brave's package pulls in its own shared
# libraries, which is what Playwright's install-deps used to provide.
install -m 0755 -d /etc/apt/keyrings
curl --fail --location --retry 5 \
  https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
  --output /etc/apt/keyrings/brave-browser-archive-keyring.gpg
curl --fail --location --retry 5 \
  https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
  --output /etc/apt/keyrings/tailscale-archive-keyring.gpg
chmod a+r /etc/apt/keyrings/brave-browser-archive-keyring.gpg /etc/apt/keyrings/tailscale-archive-keyring.gpg
printf '%s\n' \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
  > /etc/apt/sources.list.d/brave-browser-release.list
printf '%s\n' \
  "deb [signed-by=/etc/apt/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" \
  > /etc/apt/sources.list.d/tailscale.list

apt-get update
apt-get install --yes --no-install-recommends \
  brave-browser \
  tailscale \
  dbus-x11 \
  ffmpeg \
  fonts-dejavu \
  fonts-liberation2 \
  fonts-noto-color-emoji \
  fonts-noto-cjk \
  imagemagick \
  openbox \
  scrot \
  wmctrl \
  x11-utils \
  x11-xserver-utils \
  x11vnc \
  tigervnc-standalone-server \
  xauth \
  xdotool \
  xvfb
apt-get clean
rm -rf /var/lib/apt/lists/*

architecture="$(dpkg --print-architecture)"
case "$architecture" in
  amd64)
    charm_arch=x86_64
    ttyd_arch=x86_64
    ;;
  arm64)
    charm_arch=arm64
    ttyd_arch=aarch64
    ;;
  *)
    echo "Unsupported architecture for the capture tools: $architecture" >&2
    exit 1
    ;;
esac

# vhs renders a terminal by screenshotting ttyd in a headless browser, and
# Debian ships no ttyd package.
if bb_image_has vhs; then
ttyd_release="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"
curl --fail --location --retry 5 "${ttyd_release}/ttyd.${ttyd_arch}" \
  --output /tmp/ttyd
curl --fail --location --retry 5 "${ttyd_release}/SHA256SUMS" \
  --output /tmp/ttyd-sha256sums.txt
ttyd_checksum="$(awk -v asset="ttyd.${ttyd_arch}" '$2 == asset { print $1 }' /tmp/ttyd-sha256sums.txt)"
if [ -z "$ttyd_checksum" ]; then
  echo "No official ttyd checksum found for ttyd.${ttyd_arch}" >&2
  exit 1
fi
printf '%s  %s\n' "$ttyd_checksum" /tmp/ttyd | sha256sum --check --status
install -m 755 /tmp/ttyd "$INSTALL_PREFIX/bin/ttyd"

fi
install_charm_tool() {
  tool=$1
  version=$2
  archive="${tool}_${version}_Linux_${charm_arch}.tar.gz"
  release="https://github.com/charmbracelet/${tool}/releases/download/v${version}"
  curl --fail --location --retry 5 "${release}/${archive}" \
    --output "/tmp/${archive}"
  curl --fail --location --retry 5 "${release}/checksums.txt" \
    --output "/tmp/${tool}-checksums.txt"
  checksum="$(awk -v asset="$archive" '$2 == asset { print $1 }' "/tmp/${tool}-checksums.txt")"
  if [ -z "$checksum" ]; then
    echo "No official ${tool} checksum found for ${archive}" >&2
    exit 1
  fi
  printf '%s  %s\n' "$checksum" "/tmp/${archive}" | sha256sum --check --status
  rm -rf "/tmp/${tool}-extract"
  mkdir -p "/tmp/${tool}-extract"
  tar -C "/tmp/${tool}-extract" --strip-components=1 -xzf "/tmp/${archive}"
  install -m 755 "/tmp/${tool}-extract/${tool}" "$INSTALL_PREFIX/bin/${tool}"
  rm -rf "/tmp/${tool}-extract" "/tmp/${archive}" "/tmp/${tool}-checksums.txt"
}

if bb_image_has freeze; then install_charm_tool freeze "$FREEZE_VERSION"; fi
if bb_image_has vhs; then install_charm_tool vhs "$VHS_VERSION"; fi

npm install --global --prefix "$INSTALL_PREFIX" \
  "agent-browser@${AGENT_BROWSER_VERSION}"

# cua's computer-server drives the display over HTTP and MCP. Its own extras
# (pywinctl, pymonctl) shell out to xset and xrandr, which the X packages above
# provide; without them the server exits during startup.
# CUA 0.3.42 passes FastAPI extra kwargs, removed in FastAPI 0.145.
if bb_image_has cua; then
UV_TOOL_BIN_DIR="$INSTALL_PREFIX/bin" \
  uv tool install --python 3.13 --with "fastapi<0.145" "cua-computer-server==${CUA_SERVER_VERSION}"

fi
# go-rod inside vhs, Puppeteer inside omp's browser tool, and anything else
# looking for a system browser all resolve these names.
if ! brave-browser --version | grep -q '^Brave Browser'; then
  echo "brave-browser did not report a Brave version" >&2
  exit 1
fi
for name in chromium chromium-browser google-chrome; do
  ln -sf /usr/bin/brave-browser "$INSTALL_PREFIX/bin/$name"
done

npm cache clean --force
rm -f /tmp/ttyd /tmp/ttyd-sha256sums.txt
rm -rf "${HOME:-/root}/.cache" "${HOME:-/root}/.npm"
