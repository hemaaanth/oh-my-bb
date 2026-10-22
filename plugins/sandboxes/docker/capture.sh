#!/bin/sh
set -eu

# One entry point for everything an agent might need to show a human: a web
# page, a command's output, a terminal session, a GUI window, or a recording.
# Each subcommand prints the artifact path on stdout and nothing else, so it
# composes into a PR body or a comment.

usage() {
  cat <<'EOF'
Usage: bb-sandbox-capture <what> [args] [--out <file>]

  url <url> [--full-page] [--width N] [--height N]
        Render a page in Brave and write a PNG.
  cmd -- <command> [args...]
        Run a command and write a PNG of its terminal output.
  tape <file.tape>
        Run a VHS tape and write its GIF/MP4. Paths inside a tape are
        relative to the tape's directory.
  screen [--display :N]
        Grab the whole virtual display as a PNG, starting it if needed.
  window <title> [--display :N]
        Raise the window whose title matches and grab just that window.
  video <seconds> [--display :N]
        Record the virtual display to an MP4.

Defaults write into $BB_SANDBOX_CAPTURE_DIR, or ./bb-captures when unset.
EOF
}

what="${1:-}"
[ -n "$what" ] || { usage >&2; exit 2; }
shift
case "$what" in --help|-h) usage; exit 0 ;; esac

capture_dir="${BB_SANDBOX_CAPTURE_DIR:-$PWD/bb-captures}"
out=""
display=""
full_page=false
width=1280
height=800
seconds=5
title=""
command_argv=""

stamp="$(date +%Y%m%d-%H%M%S)"

resolve_out() {
  extension=$1
  if [ -n "$out" ]; then
    install -d "$(dirname "$out")"
    printf '%s' "$out"
    return
  fi
  install -d "$capture_dir"
  printf '%s/%s-%s.%s' "$capture_dir" "$what" "$stamp" "$extension"
}

ensure_display() {
  if [ -z "$display" ]; then
    state_dir="${BB_DATA_DIR:-${HOME:-/root}/.bb}"
    display="$(cat "$state_dir/display" 2>/dev/null || printf ':99')"
  fi
  DISPLAY="$display" xdpyinfo >/dev/null 2>&1 \
    || bb-sandbox-display start --display "$display" >/dev/null
  export DISPLAY="$display"
}

case "$what" in
  url)
    url="${1:?a URL is required}"
    shift
    ;;
  tape)
    tape="${1:?a tape file is required}"
    shift
    ;;
  window)
    title="${1:?a window title is required}"
    shift
    ;;
  video)
    seconds="${1:?a duration in seconds is required}"
    shift
    ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) shift; out="${1:?--out needs a value}" ;;
    --display) shift; display="${1:?--display needs a value}" ;;
    --full-page) full_page=true ;;
    --width) shift; width="${1:?--width needs a value}" ;;
    --height) shift; height="${1:?--height needs a value}" ;;
    --) shift; command_argv="$*"; break ;;
    *)
      if [ "$what" = cmd ] && [ -z "$command_argv" ]; then
        command_argv="$*"
        break
      fi
      echo "bb-sandbox-capture: unexpected argument $1" >&2
      exit 2
      ;;
  esac
  shift
done

case "$what" in
  url)
    target="$(resolve_out png)"
    set -- open "$url" --viewport "${width}x${height}"
    agent-browser "$@" >/dev/null
    if [ "$full_page" = true ]; then
      agent-browser screenshot "$target" --full-page >/dev/null
    else
      agent-browser screenshot "$target" >/dev/null
    fi
    printf '%s\n' "$target"
    ;;
  cmd)
    [ -n "$command_argv" ] || { echo "bb-sandbox-capture: a command is required" >&2; exit 2; }
    target="$(resolve_out png)"
    freeze --execute "$command_argv" --output "$target" >/dev/null
    printf '%s\n' "$target"
    ;;
  tape)
    # VHS drives ttyd through a headless browser; as root that browser needs
    # its sandbox disabled, and it must find the system Chromium alias.
    VHS_NO_SANDBOX=true vhs "$tape" >/dev/null
    printf '%s\n' "$(awk '/^Output/ { print $2; exit }' "$tape")"
    ;;
  screen)
    ensure_display
    target="$(resolve_out png)"
    import -window root "$target"
    printf '%s\n' "$target"
    ;;
  window)
    ensure_display
    target="$(resolve_out png)"
    wmctrl -a "$title" 2>/dev/null || true
    window_id="$(xdotool search --name "$title" | head -1)"
    [ -n "$window_id" ] || { echo "bb-sandbox-capture: no window titled $title" >&2; exit 1; }
    import -window "$window_id" "$target"
    printf '%s\n' "$target"
    ;;
  video)
    ensure_display
    target="$(resolve_out mp4)"
    geometry="$(xdpyinfo | awk '/dimensions:/ { print $2 }')"
    ffmpeg -loglevel error -y -f x11grab -framerate 25 -video_size "$geometry" \
      -i "${display}.0" -t "$seconds" -c:v libx264 -pix_fmt yuv420p "$target"
    printf '%s\n' "$target"
    ;;
  *)
    echo "bb-sandbox-capture: unknown capture $what" >&2
    usage >&2
    exit 2
    ;;
esac
