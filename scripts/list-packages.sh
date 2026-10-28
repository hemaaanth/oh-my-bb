#!/usr/bin/env bash
# Print the packages listed in scripts/packages.txt, one per line.
# Fails when a listed package is missing or a committed package is not listed.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
list="$root/scripts/packages.txt"

listed="$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$list")"
status=0

while IFS= read -r package; do
  if [ ! -f "$root/$package/package.json" ]; then
    echo "scripts/packages.txt lists $package, which has no package.json" >&2
    status=1
  fi
done <<< "$listed"

# Only committed packages count, so a package still being built does not fail the check.
tracked="$(git -C "$root" ls-files 'plugins/*/package.json' 'agents/*/package.json' | grep -E '^(plugins|agents)/[^/]+/package.json$' | sed 's|/package.json$||')"
while IFS= read -r package; do
  [ -n "$package" ] || continue
  if ! grep -qxF "$package" <<< "$listed"; then
    echo "$package has a package.json but is missing from scripts/packages.txt" >&2
    status=1
  fi
done <<< "$tracked"

[ "$status" -eq 0 ] || exit 1
printf '%s\n' "$listed"
