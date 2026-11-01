#!/bin/sh
# Starts a detached lane agent from a fixed preset. The usage text is the contract;
# docs/agent-lanes.md explains the presets. No free-form command input exists.
set -eu
umask 077

presets='sol-low sol-medium sol-high astra-high swe2-high argon-high kimi-high'
usage="Usage: npm run lane:run -- [--wait] [--rerun] <name> <preset> <brief.md> [worktree]
  Presets: $presets
  <brief.md> must be a readable file under <primary>/.local/ (AGI_LANE_NOTES_DIR overrides the notes root, default <primary>/.local/agent-lanes).
  <worktree> defaults to <lanes>/<name> (AGI_LANES_DIR, default ~/repos/agi-wt), which must be on branch lane/<name>.
  An explicit <worktree> may be any directory on any branch. One live run per lane name.
  Log: <notes>/reports/<name>.log (refused if it exists; --rerun archives stopped runs). Pid: <notes>/pids/<name>.pid.
  --wait blocks until the agent exits and returns its status."

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

wait_for_exit=0
rerun=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --wait) wait_for_exit=1 ;;
    --rerun) rerun=1 ;;
    *) break ;;
  esac
  shift
done
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  printf '%s\n' "$usage" >&2
  exit 2
fi
name=$1
preset=$2
case "$name" in
  '' | [!a-zA-Z0-9]* | *[!a-zA-Z0-9_-]*) fail 'Invalid lane name: use letters, digits, underscores or hyphens; start with a letter or digit.' ;;
esac
case " $presets " in
  *" $preset "*) ;;
  *) fail "Unknown preset: $preset. Presets: $presets" ;;
esac

common=$(git rev-parse --path-format=absolute --git-common-dir) || fail 'Run inside the repository.'
primary=$(dirname "$common")
mkdir -p "$primary/.local"
local_dir=$(cd "$primary/.local" && pwd -P)
notes=${AGI_LANE_NOTES_DIR:-$local_dir/agent-lanes}
mkdir -p "$notes"
notes=$(cd "$notes" && pwd -P)
reports=$notes/reports
pids=$notes/pids

[ -f "$3" ] && [ -r "$3" ] || fail "Cannot read brief: $3"
brief=$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")
case "$brief" in
  "$local_dir"/*) ;;
  *) fail "Brief must be under $local_dir: $brief" ;;
esac

if [ "$#" -eq 4 ]; then
  worktree=$4
  [ -d "$worktree" ] || fail "Worktree directory missing: $worktree"
  worktree=$(cd "$worktree" && pwd -P)
else
  lanes=${AGI_LANES_DIR:-$HOME/repos/agi-wt}
  [ -d "$lanes" ] || fail "Lanes directory missing: $lanes (pass the worktree explicitly to use the main checkout)"
  worktree=$(cd "$lanes" && pwd -P)/$name
  [ -d "$worktree" ] || fail "Worktree directory missing: $worktree"
  [ "$(git -C "$worktree" symbolic-ref --quiet --short HEAD || true)" = "lane/$name" ] || fail "Expected branch lane/$name in worktree: $worktree"
fi

mkdir -p "$reports" "$pids"
log=$reports/$name.log
pid_file=$pids/$name.pid
identity_file=$pids/$name.identity
exit_file=$pids/$name.exit
worktree_file=$pids/$name.worktree

# A lane is live while its pid exists, it has no exit file and its recorded identity
# (start time and executable) still matches, so a reused pid does not count.
live() {
  pid=$(cat "$pids/$1.pid" 2> /dev/null || true)
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  [ ! -e "$pids/$1.exit" ] || return 1
  kill -0 "$pid" 2> /dev/null || return 1
  if [ -s "$pids/$1.identity" ]; then
    now=$(LC_ALL=C ps -p "$pid" -o lstart= -o comm= 2> /dev/null || true)
    [ "$now" = "$(cat "$pids/$1.identity")" ] || return 1
  fi
  return 0
}

# mkdir claims the lane before any check/archive/write. A killed launcher may
# leave a claim: refuse it explicitly rather than risk reclaiming a new owner.
lock=$pids/$name.launch
if ! mkdir "$lock" 2> /dev/null; then
  owner=$(cat "$lock/owner" 2> /dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2> /dev/null; then
    fail "Stale lane launch claim: $lock (verify no launcher is running, then remove this directory)."
  fi
  fail "Lane launch already claimed: $name ($lock)."
fi
release_claim() {
  rm -f "$lock/owner"
  rmdir "$lock"
}
trap release_claim 0
trap 'exit 1' HUP INT TERM
printf '%s\n' "$$" > "$lock/owner"

if [ -e "$log" ] && [ "$rerun" -ne 1 ]; then
  fail "Lane log already exists: $log (archive it or pass --rerun)."
fi
if live "$name"; then
  fail "Lane pid still exists; do not move its log: $(cat "$pid_file")"
fi
if [ -e "$log" ]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  [ ! -e "$reports/$name.$stamp.log" ] || fail 'Archive timestamp already exists; retry later.'
  mv "$log" "$reports/$name.$stamp.log"
  for file in "$pid_file" "$identity_file" "$exit_file" "$worktree_file"; do
    [ ! -e "$file" ] || mv "$file" "${file%.*}.$stamp.${file##*.}"
  done
fi

# `npm run` puts node_modules/.bin first on PATH, where a package may install its own agent
# CLI. The lane must run the operator's installed CLI, so those entries are dropped.
PATH=$(printf '%s\n' "$PATH" | tr ':' '\n' | grep -v '/node_modules/\.bin$' | paste -sd: -)
export PATH

prompt="Read and follow the brief at $brief exactly."
case "$preset" in
  sol-* | astra-*)
    effort=${preset#*-}
    model=gpt-6.1-sol
    [ "${preset%%-*}" != astra ] || model=gpt-6-astra
    set -- codex exec -m "$model" -c "model_reasoning_effort=\"$effort\"" \
      --dangerously-bypass-approvals-and-sandbox -C "$worktree" "$prompt"
    ;;
  swe2-high)
    # Devin runs only its included SWE-2 model; every other Devin model bills API spend.
    set -- devin -p "$prompt" --model swe-2-high --permission-mode dangerous \
      --respect-workspace-trust false
    ;;
  argon-high)
    set -- agy -p "$prompt" --model gemini-4-argon-high \
      --dangerously-skip-permissions --output-format json \
      --add-dir "$local_dir" --add-dir "$worktree"
    ;;
  kimi-high)
    set -- omp -p --model kimi-code/k3.1-pro --thinking high --no-session \
      --cwd "$worktree" --add-dir "$local_dir" "$prompt"
    ;;
esac

rm -f "$identity_file" "$exit_file"
(set -C; : > "$log") || fail "Lane log already exists: $log"
printf '%s\n' "$worktree" > "$worktree_file"
nohup sh -c '
  identity_file=$1
  exit_file=$2
  LC_ALL=C ps -p $$ -o lstart= -o comm= > "$identity_file"
  cd "$3" || exit 1
  shift 3
  "$@"
  status=$?
  printf "%s\n" "$status" > "$exit_file"
  printf "\nexit %s\n" "$status"
  exit "$status"
' lane-agent "$identity_file" "$exit_file" "$worktree" "$@" < /dev/null >> "$log" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
release_claim
trap - 0 HUP INT TERM
printf 'PID %s; log %s\n' "$pid" "$log"
if [ "$wait_for_exit" -eq 1 ]; then
  status=0
  wait "$pid" || status=$?
  exit "$status"
fi
