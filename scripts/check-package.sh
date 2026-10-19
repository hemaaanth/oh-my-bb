#!/usr/bin/env bash
# Install, typecheck, test, and build one package from its own directory.
# Usage: scripts/check-package.sh <package-dir>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="${1:?usage: check-package.sh <package-dir>}"
dir="$root/$package"

has_script() {
  (cd "$dir" && node -e 'process.exit(require("./package.json").scripts?.[process.argv[1]] ? 0 : 1)' "$1")
}

echo "==> $package"
cd "$dir"
npm ci
npm run typecheck

# CI runners can't make a network namespace, so a package may define test:ci for them.
if [ -n "${CI:-}" ] && has_script test:ci; then
  npm run test:ci
else
  npm test
fi

if has_script build; then
  npm run build
fi
