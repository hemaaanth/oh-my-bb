#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for package in \
  plugins/model-gateway \
  plugins/pages \
  agents/fx-acp \
  agents/nanocodex-acp
do
  echo "==> $package"
  npm --prefix "$root/$package" ci
  npm --prefix "$root/$package" run typecheck
  npm --prefix "$root/$package" test
done

npm --prefix "$root/plugins/model-gateway" run build
npm --prefix "$root/plugins/pages" run build
