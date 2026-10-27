#!/bin/sh
set -eu

CLICKHOUSE_VERSION="${CLICKHOUSE_VERSION:-latest}"
GOLDSKY_CLI_VERSION="${GOLDSKY_CLI_VERSION:-latest}"
INSTALL_PREFIX="${BB_AGENT_CLI_PREFIX:-/usr/local}"
MISE_DATA_DIR="${BB_AGENT_CLI_MISE_DATA_DIR:-/opt/mise}"

case "$MISE_DATA_DIR" in
  *"'"*) echo "The mise data directory may not contain a single quote" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_PREFIX/bin" "$MISE_DATA_DIR"

npm install --global --prefix "$INSTALL_PREFIX" \
  --allow-scripts=esbuild \
  "@goldskycom/cli@${GOLDSKY_CLI_VERSION}"


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
rm -rf "$HOME/.cache" "$HOME/.npm"
