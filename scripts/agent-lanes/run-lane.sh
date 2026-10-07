#!/bin/sh
set -eu
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

wait_for_exit=0
if [ "${1:-}" = --wait ]; then
  wait_for_exit=1
  shift
fi
[ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail 'Usage: run-lane.sh [--wait] <name> <brief.md> [worktree]'
name=$1
case "$name" in
  '' | [!a-zA-Z0-9]* | *[!a-zA-Z0-9_-]*) fail 'Invalid lane name: use letters, digits, underscores or hyphens; start with a letter or digit.' ;;
esac
[ -n "${AGI_AGENT_CMD:-}" ] || fail 'Set AGI_AGENT_CMD to a shell command that reads the brief on stdin.'
[ -f "$2" ] && [ -r "$2" ] || fail "Cannot read brief: $2"
brief=$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")
root=$(git rev-parse --show-toplevel)
cd "$root"
lanes=${AGI_LANES_DIR:-../agi-lanes}
mkdir -p "$lanes/logs"
lanes=$(cd "$lanes" && pwd -P)
worktree=${3:-$lanes/$name}
[ -d "$worktree" ] || fail "Worktree directory missing: $worktree"
worktree=$(cd "$worktree" && pwd -P)
[ "$(git -C "$worktree" symbolic-ref --quiet --short HEAD)" = "lane/$name" ] || fail "Expected branch lane/$name in worktree: $worktree"
log=$lanes/logs/$name.log
pid_file=$lanes/logs/$name.pid
(
  set -C
  : > "$log"
) 2> /dev/null || fail "Lane log already exists: $log (archive it before another run)."

nohup sh -c '
  cd "$1" && sh -c "$2"
  status=$?
  printf "\nexit %s\n" "$status"
  exit "$status"
' lane-agent "$worktree" "$AGI_AGENT_CMD" < "$brief" >> "$log" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
printf 'PID %s; log %s\n' "$pid" "$log"
if [ "$wait_for_exit" -eq 1 ]; then
  while kill -0 "$pid" 2> /dev/null; do
    sleep 1
  done
  status=0
  wait "$pid" || status=$?
  exit "$status"
fi
