#!/bin/sh
set -eu

POSTHOG_CLI_VERSION="${POSTHOG_CLI_VERSION:-0.18.9}"
VERCEL_VERSION="${VERCEL_VERSION:-62.2.0}"
RAILWAY_VERSION="${RAILWAY_VERSION:-5.63.1}"
LINEAR_CLI_VERSION="${LINEAR_CLI_VERSION:-0.2.2}"
SLACK_CLI_VERSION="${SLACK_CLI_VERSION:-0.3.5}"
CLICKHOUSE_VERSION="${CLICKHOUSE_VERSION:-latest}"
INSTALL_PREFIX="${BB_AGENT_CLI_PREFIX:-/usr/local}"
MISE_DATA_DIR="${BB_AGENT_CLI_MISE_DATA_DIR:-/opt/mise}"

case "$MISE_DATA_DIR" in
  *"'"*) echo "The mise data directory may not contain a single quote" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_PREFIX/bin" "$MISE_DATA_DIR"

npm install --global --prefix "$INSTALL_PREFIX" \
  --allow-scripts=@posthog/cli,@railway/cli,esbuild \
  "@posthog/cli@${POSTHOG_CLI_VERSION}" \
  "vercel@${VERCEL_VERSION}" \
  "@railway/cli@${RAILWAY_VERSION}" \
  "@ruminaider/linear-cli@${LINEAR_CLI_VERSION}"

architecture="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "$architecture" in
  amd64|x86_64) slack_arch=x86_64 ;;
  arm64|aarch64) slack_arch=arm64 ;;
  *) echo "Unsupported architecture for slack-cli: $architecture" >&2; exit 1 ;;
esac
slack_asset="slack-cli_${SLACK_CLI_VERSION}_linux_${slack_arch}.tar.gz"
curl --fail --location --retry 5 \
  "https://github.com/paymog/slack-cli/releases/download/v${SLACK_CLI_VERSION}/${slack_asset}" \
  --output "/tmp/${slack_asset}"
curl --fail --location --retry 5 \
  "https://github.com/paymog/slack-cli/releases/download/v${SLACK_CLI_VERSION}/checksums.txt" \
  --output /tmp/slack-cli-checksums.txt
slack_checksum="$(awk -v asset="$slack_asset" '$2 == asset { print $1 }' /tmp/slack-cli-checksums.txt)"
test -n "$slack_checksum"
printf '%s  %s\n' "$slack_checksum" "/tmp/${slack_asset}" | sha256sum --check --status
tar -xzf "/tmp/${slack_asset}" -C /tmp
install -m 755 /tmp/slack-cli "$INSTALL_PREFIX/bin/slack-cli"

if ! command -v ntn >/dev/null 2>&1; then
  curl --fail --silent --show-error --location --retry 5 https://ntn.dev | bash
fi
ntn_path="$(command -v ntn)"
if [ "$ntn_path" != "$INSTALL_PREFIX/bin/ntn" ]; then
  install -m 755 "$ntn_path" "$INSTALL_PREFIX/bin/ntn"
fi

if ! command -v hubspot >/dev/null 2>&1 && [ ! -x "$HOME/.hubspot/bin/hubspot" ]; then
  curl --fail --silent --show-error --location --retry 5 \
    https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | bash
fi
hubspot_path="$(command -v hubspot 2>/dev/null || printf '%s' "$HOME/.hubspot/bin/hubspot")"
if [ "$hubspot_path" != "$INSTALL_PREFIX/bin/hubspot" ]; then
  install -m 755 "$hubspot_path" "$INSTALL_PREFIX/bin/hubspot"
fi


MISE_DATA_DIR="$MISE_DATA_DIR" mise install "clickhouse@${CLICKHOUSE_VERSION}"
printf '%s\n' \
  '#!/bin/sh' \
  "export MISE_DATA_DIR='$MISE_DATA_DIR'" \
  "exec mise x clickhouse@${CLICKHOUSE_VERSION} -- clickhouse \"\$@\"" \
  > "$INSTALL_PREFIX/bin/clickhouse"
chmod 755 "$INSTALL_PREFIX/bin/clickhouse"

npm cache clean --force
rm -rf "/tmp/${slack_asset}" /tmp/slack-cli /tmp/slack-cli-checksums.txt \
  "$HOME/.cache" "$HOME/.npm"
