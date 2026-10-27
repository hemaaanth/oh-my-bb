#!/bin/sh
set -eu
. /usr/local/lib/bb-sandbox/image-tools.sh

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
if bb_image_has pnpm; then check pnpm pnpm --version; fi
check corepack corepack --version
if bb_image_has bun; then check bun bun --version; fi
if bb_image_has deno; then check deno deno --version; fi
if bb_image_has python; then check python3 python3 --version; fi
if bb_image_has python; then check uv uv --version; fi
if bb_image_has go; then check go go version; fi
if bb_image_has rust; then check rustc rustc --version; fi
if bb_image_has rust; then check cargo cargo --version; fi
if bb_image_has rust; then check cargo-nextest cargo-nextest --version; fi
if bb_image_has java; then check java java --version; fi
if bb_image_has docker; then check docker docker --version; fi
if bb_image_has docker; then check docker-compose docker compose version; fi
if bb_image_has docker; then check docker-buildx docker buildx version; fi
if bb_image_has nix; then check nix nix --version; fi
if bb_image_has devbox; then check devbox devbox version; fi
if bb_image_has direnv; then check direnv direnv --version; fi
if bb_image_has process-compose; then check process-compose process-compose version; fi
if bb_image_has mise; then check mise mise --version; fi
if bb_image_has aws; then check aws aws --version; fi
if bb_image_has kubectl; then check kubectl kubectl version --client=true; fi
if bb_image_has helm; then check helm helm version --short; fi
if bb_image_has doppler; then check doppler doppler --version; fi
if bb_image_has duckdb; then check duckdb duckdb --version; fi
if bb_image_has op; then check op op --version; fi
if bb_image_has clickhouse; then check clickhouse clickhouse --version; fi
if bb_image_has postgresql; then check psql psql --version; fi
if bb_image_has redis; then check redis-cli redis-cli --version; fi
if bb_image_has sqlite; then check sqlite3 sqlite3 --version; fi
if bb_image_has protobuf; then check protoc protoc --version; fi
check brave brave-browser --version
check agent-browser agent-browser --version
check tailscale tailscale version
check tailscaled command -v tailscaled
check bb-browser bb-browser state list
if bb_image_has freeze; then check freeze freeze --version; fi
if bb_image_has vhs; then check vhs vhs --version; fi
if bb_image_has vhs; then check ttyd ttyd --version; fi
check ffmpeg ffmpeg -version
check imagemagick import -version
check xvfb Xvfb -help
check tigervnc Xtigervnc -version
check xdotool xdotool --version
check x11vnc x11vnc -version
# cua's server imports python-xlib at module load, so even --help needs a
# display; the functional check further down starts one and drives it.
if bb_image_has cua; then check cua-server command -v cua-computer-server; fi
check git git --version
check gh gh --version
check rg rg --version
check fd fd --version
check jq jq --version
if bb_image_has omp; then check omp omp --version; fi
if bb_image_has fx; then check fx fx --version; fi
if bb_image_has pi; then check pi pi --version; fi
if bb_image_has prime-agent; then check prime-agent prime-agent --version; fi
if bb_image_has fx-acp; then check fx-acp command -v fx-acp; fi
if bb_image_has nanocodex-acp; then check nanocodex-acp command -v nanocodex-acp; fi
if bb_image_has prime-agent-acp; then check prime-agent-acp command -v prime-agent-acp; fi
check bb-host-daemon command -v bb-host-daemon
if bb_image_has claude-code; then check claude claude --version; fi
if bb_image_has codex; then check codex codex --version; fi
if bb_image_has goldsky; then check goldsky command -v goldsky; fi
if bb_image_has hubspot; then check hubspot command -v hubspot; fi
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
if bb_image_has freeze; then captured capture-cmd "$(BB_SANDBOX_CAPTURE_DIR="$capture_dir" bb-sandbox-capture cmd -- uname -a 2>/dev/null || true)"; fi
printf '%s\n' 'Output tape.gif' 'Set Width 800' 'Set Height 400' 'Type "echo bb"' 'Enter' 'Sleep 500ms' > "$capture_dir/t.tape"
if bb_image_has vhs; then captured capture-tape "$( (cd "$capture_dir" && bb-sandbox-capture tape t.tape >/dev/null 2>&1 && printf '%s' "$capture_dir/tape.gif") || true)"; fi
captured capture-screen "$(BB_SANDBOX_CAPTURE_DIR="$capture_dir" bb-sandbox-capture screen 2>/dev/null || true)"

check window-manager pgrep -x openbox

if bb_image_has cua; then
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
fi
rm -rf "$capture_dir"

if bb_image_has docker; then
if bb-sandbox-docker --wait --timeout 120 >/dev/null 2>&1; then
  check dockerd docker version --format '{{.Server.Version}}'
  check docker-run docker run --rm alpine:3.22 echo container-ok
  check compose-ls docker compose ls
else
  printf 'FAIL  %-22s %s\n' dockerd "bb-sandbox-docker could not start a daemon"
  failures=$((failures + 1))
fi

fi

if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf '\nevery check passed\n'
