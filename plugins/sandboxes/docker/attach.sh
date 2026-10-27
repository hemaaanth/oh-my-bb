#!/bin/sh
set -eu

# Uploads a file as a GitHub issue/PR attachment and prints markdown that
# renders inline — including on private repositories.
#
# GitHub has no documented attachment API. The web UI's old
# github.com/upload/policies/assets flow needs a browser session cookie, and
# committed raw URLs do not render for other viewers of a private repo because
# GitHub's Camo proxy cannot authenticate to the origin. What does work with a
# plain token is uploads.github.com: it returns a github.com/user-attachments
# URL, which GitHub's markdown renderer rewrites per view into a short-lived
# signed private-user-images URL, exactly as it does for a human's drag-and-drop.
#
# That endpoint is undocumented, so this script fails loudly rather than
# silently producing a broken image, and names the fallback.

usage() {
  cat <<'EOF'
Usage: bb-sandbox-attach <file> [options]

  --repo <owner/name>   target repository (default: the current checkout's)
  --alt <text>          image alt text (default: the file's base name)
  --url-only            print the attachment URL instead of markdown

Example:
  shot=$(bb-sandbox-capture url http://localhost:3000)
  gh pr comment --body "$(bb-sandbox-attach "$shot" --alt 'home page')"
EOF
}

file="${1:-}"
case "$file" in
  ""|--help|-h) usage; [ -n "$file" ] && exit 0 || exit 2 ;;
esac
shift

repo=""
alt=""
url_only=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) shift; repo="${1:?--repo needs a value}" ;;
    --alt) shift; alt="${1:?--alt needs a value}" ;;
    --url-only) url_only=true ;;
    --help|-h) usage; exit 0 ;;
    *) echo "bb-sandbox-attach: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -f "$file" ] || { echo "bb-sandbox-attach: no such file: $file" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "bb-sandbox-attach: the gh CLI is required" >&2; exit 1; }

name="$(basename "$file")"
[ -n "$alt" ] || alt="${name%.*}"

case "$name" in
  *.png) content_type=image/png ;;
  *.jpg|*.jpeg) content_type=image/jpeg ;;
  *.gif) content_type=image/gif ;;
  *.webp) content_type=image/webp ;;
  *.svg) content_type=image/svg+xml ;;
  *.mp4) content_type=video/mp4 ;;
  *.webm) content_type=video/webm ;;
  *.pdf) content_type=application/pdf ;;
  *.log|*.txt) content_type=text/plain ;;
  *) content_type=application/octet-stream ;;
esac

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
repository_id="$(gh api "repos/${repo}" --jq .id)"
token="$(gh auth token)"

# The file name travels as a query parameter, so it has to be percent-encoded.
encoded_name="$(printf '%s' "$name" | jq -sRr @uri)"

response="$(mktemp)"
status="$(curl --silent --show-error --output "$response" --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: Bearer ${token}" \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/octet-stream' \
  --data-binary "@${file}" \
  "https://uploads.github.com/user-attachments/assets?name=${encoded_name}&content_type=${content_type}&repository_id=${repository_id}")"

if [ "$status" != "201" ]; then
  detail="$(head -c 400 "$response")"
  rm -f "$response"
  cat >&2 <<EOF
bb-sandbox-attach: upload returned HTTP ${status}: ${detail}

GitHub does not document this endpoint, so it can change without notice. Until
it is fixed, commit the file to the pull request branch and link it, which every
viewer with repository access can open even though it will not render inline.
EOF
  exit 1
fi

url="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$response")"
rm -f "$response"
if [ -z "$url" ]; then
  echo "bb-sandbox-attach: upload succeeded but returned no URL" >&2
  exit 1
fi

if [ "$url_only" = true ]; then
  printf '%s\n' "$url"
else
  printf '![%s](%s)\n' "$alt" "$url"
fi
