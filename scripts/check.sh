#!/usr/bin/env bash
# Check every package in scripts/packages.txt, or only the packages named as arguments.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

packages="$("$root/scripts/list-packages.sh")"
if [ "$#" -gt 0 ]; then
  packages="$(printf '%s\n' "$@")"
fi

while IFS= read -r package; do
  "$root/scripts/check-package.sh" "$package"
done <<< "$packages"
