#!/bin/sh
set -eu

# Asserts that a built sandbox image actually contains the toolchain the
# settings inventory advertises. Run it against a local build:
#
#   docker build -t bb-sandbox:test --build-arg BB_APP_VERSION=$(bb --version) docker
#   docker run --rm --privileged bb-sandbox:test bb-sandbox-smoke-test
#
# --privileged is what lets the Docker-in-Docker check pass locally; providers
# grant the equivalent through a real kernel or a documented DinD sandbox.

failures=0

check() {
  label=$1
  shift
  if output="$("$@" 2>&1)"; then
    printf 'ok    %-22s %s\n' "$label" "$(printf '%s' "$output" | head -1)"
  else
    printf 'FAIL  %-22s %s\n' "$label" "$(printf '%s' "$output" | head -1)"
    failures=$((failures + 1))
  fi
}

check node node --version
check npm npm --version
check pnpm pnpm --version
check corepack corepack --version
check bun bun --version
check deno deno --version
check python3 python3 --version
check uv uv --version
check go go version
check rustc rustc --version
check cargo cargo --version
check cargo-nextest cargo-nextest --version
check java java --version
check docker docker --version
check docker-compose docker compose version
check docker-buildx docker buildx version
check nix nix --version
check devbox devbox version
check direnv direnv --version
check process-compose process-compose version
check mise mise --version
check aws aws --version
check kubectl kubectl version --client=true
check helm helm version --short
check doppler doppler --version
check duckdb duckdb --version
check op op --version
check clickhouse clickhouse --version
check psql psql --version
check redis-cli redis-cli --version
check sqlite3 sqlite3 --version
check protoc protoc --version
check brave brave-browser --version
check agent-browser agent-browser --version
check tailscale tailscale version
check tailscaled command -v tailscaled
check bb-browser bb-browser state list
check freeze freeze --version
check vhs vhs --version
check ttyd ttyd --version
check ffmpeg ffmpeg -version
check imagemagick import -version
check xvfb Xvfb -help
check tigervnc Xtigervnc -version
check xdotool xdotool --version
check x11vnc x11vnc -version
# cua's server imports python-xlib at module load, so even --help needs a
# display; the functional check further down starts one and drives it.
check cua-server command -v cua-computer-server
check git git --version
check gh gh --version
check rg rg --version
check fd fd --version
check jq jq --version
check omp omp --version
check fx fx --version
check pi pi --version
check prime-agent prime-agent --version
check fx-acp command -v fx-acp
check nanocodex-acp command -v nanocodex-acp
check prime-agent-acp command -v prime-agent-acp
check bb-host-daemon command -v bb-host-daemon
check claude claude --version
check codex codex --version
check vercel command -v vercel
check railway command -v railway
check posthog-cli command -v posthog-cli
check ntn command -v ntn
check slack-cli command -v slack-cli
check hubspot command -v hubspot
check linear-cli command -v linear-cli
check bb-sandbox-preview command -v bb-sandbox-preview
check bb-sandbox-docker command -v bb-sandbox-docker
check bb-sandbox-display command -v bb-sandbox-display
check bb-sandbox-computer command -v bb-sandbox-computer
check bb-sandbox-capture command -v bb-sandbox-capture
check bb-sandbox-attach command -v bb-sandbox-attach

# An installed package proves nothing: the browser only runs once its shared
# libraries are present, so drive a real headless screenshot through the
# chromium alias every other tool resolves.
shot_dir="$(mktemp -d)"
if (cd "$shot_dir" && chromium --headless --no-sandbox --disable-gpu \
    --screenshot="$shot_dir/smoke.png" --window-size=800,600 about:blank >/dev/null 2>&1) \
    && [ -s "$shot_dir/smoke.png" ]; then
  printf 'ok    %-22s %s\n' brave-screenshot "$(readlink -f "$(command -v chromium)")"
else
  printf 'FAIL  %-22s %s\n' brave-screenshot "the chromium alias could not render a headless screenshot"
  failures=$((failures + 1))
fi
rm -rf "$shot_dir"

# bb-browser's direct mode needs no tailnet, so it can prove the exact user
# agent end to end; home egress needs a real exit node and is not smoke-tested.
smoke_ua="Mozilla/5.0 (X11; Linux x86_64) bb-sandbox-smoke/1.0"
browser_home="$(mktemp -d)"
if doctor_out="$(BB_BROWSER_HOME="$browser_home" BB_BROWSER_EGRESS=direct BB_BROWSER_USER_AGENT="$smoke_ua" \
    bb-browser doctor 2>&1)" && printf '%s' "$doctor_out" | grep -q 'navigator.userAgent matches exactly'; then
  printf 'ok    %-22s %s\n' bb-browser-identity "Brave reports the configured user agent"
else
  printf 'FAIL  %-22s %s\n' bb-browser-identity "$(printf '%s\n' "$doctor_out" | grep -m1 FAIL || printf '%s' "$doctor_out" | head -n1)"
  failures=$((failures + 1))
fi
rm -rf "$browser_home"

# Capturing is the whole point of the browser and terminal tooling, so exercise
# each renderer end to end rather than trusting a --version.
capture_dir="$(mktemp -d)"
captured() {
  label=$1
  artifact=$2
  if [ -n "$artifact" ] && [ -s "$artifact" ]; then
    printf 'ok    %-22s %s\n' "$label" "$(basename "$artifact") $(wc -c < "$artifact") bytes"
  else
    printf 'FAIL  %-22s %s\n' "$label" "produced no artifact"
    failures=$((failures + 1))
  fi
}

printf '<html><body><h1>bb sandbox</h1></body></html>' > "$capture_dir/page.html"
captured capture-url "$(BB_SANDBOX_CAPTURE_DIR="$capture_dir" bb-sandbox-capture url "file://$capture_dir/page.html" 2>/dev/null || true)"
captured capture-cmd "$(BB_SANDBOX_CAPTURE_DIR="$capture_dir" bb-sandbox-capture cmd -- uname -a 2>/dev/null || true)"
printf '%s\n' 'Output tape.gif' 'Set Width 800' 'Set Height 400' 'Type "echo bb"' 'Enter' 'Sleep 500ms' > "$capture_dir/t.tape"
captured capture-tape "$( (cd "$capture_dir" && bb-sandbox-capture tape t.tape >/dev/null 2>&1 && printf '%s' "$capture_dir/tape.gif") || true)"
captured capture-screen "$(BB_SANDBOX_CAPTURE_DIR="$capture_dir" bb-sandbox-capture screen 2>/dev/null || true)"

check window-manager pgrep -x openbox

if computer_start="$(bb-sandbox-computer start --port 8765 2>&1)"; then
  computer_shot="$(curl --fail --silent --max-time 20 -X POST http://127.0.0.1:8765/cmd \
    -H 'Content-Type: application/json' \
    -d '{"command":"screenshot","params":{}}' 2>/dev/null | head -c 200)"
  case "$computer_shot" in
    *'"success": true'*|*'"success":true'*)
      printf 'ok    %-22s %s\n' computer-use "screenshot over /cmd" ;;
    *)
      printf 'FAIL  %-22s %s\n' computer-use "screenshot command returned no image"
      failures=$((failures + 1)) ;;
  esac
  bb-sandbox-computer stop >/dev/null 2>&1 || true
else
  printf 'FAIL  %-22s %s\n' computer-use "cua computer-server did not start"
  printf '%s\n' "$computer_start"
  failures=$((failures + 1))
fi
rm -rf "$capture_dir"

if bb-sandbox-docker --wait --timeout 120 >/dev/null 2>&1; then
  check dockerd docker version --format '{{.Server.Version}}'
  check docker-run docker run --rm alpine:3.22 echo container-ok
  check compose-ls docker compose ls
else
  printf 'FAIL  %-22s %s\n' dockerd "bb-sandbox-docker could not start a daemon"
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf '\nevery check passed\n'
