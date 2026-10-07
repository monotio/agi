#!/bin/sh
set -eu

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail 'Usage: new-lane.sh <name> [base]'
name=$1
case "$name" in
  '' | [!a-zA-Z0-9]* | *[!a-zA-Z0-9_-]*) fail 'Invalid lane name: use letters, digits, underscores or hyphens; start with a letter or digit.' ;;
esac

root=$(git rev-parse --show-toplevel)
cd "$root"
if [ "$#" -eq 2 ]; then
  base=$2
else
  base=$(git symbolic-ref --quiet --short HEAD) || fail 'Detached HEAD: supply an explicit base.'
fi
branch=lane/$name
git show-ref --verify --quiet "refs/heads/$branch" && fail "Lane branch already exists: $branch"
lanes=${AGI_LANES_DIR:-../agi-lanes}
mkdir -p "$lanes"
lanes=$(cd "$lanes" && pwd -P)
worktree=$lanes/$name
[ ! -e "$worktree" ] && [ ! -L "$worktree" ] || fail "Lane directory already exists: $worktree"
git worktree add -q -b "$branch" "$worktree" "$base"
cd "$worktree"
npm ci >&2
printf '%s\n' "$worktree"
