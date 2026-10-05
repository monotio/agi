@AGENTS.md

## Claude Code

AGENTS.md is the shared source of truth for every coding agent; edit it there and
keep this file to Claude-specific notes. The gates (`npm run check`, the
Playwright suites) take minutes: run them in the background and quote the failing
step in your report.

- Background commands stop after two hours: start delegated runs and long suites
  detached, save the PID, then wait with `while kill -0 "$pid"` or on an exact
  completion marker, never on text in their output. Do not wait with
  `while pgrep -f <pattern>`: the waiting shell's own command line contains the
  pattern, so the loop can match itself and never end.
- Working knowledge that another machine or agent needs (rules, traps, owner
  decisions about the product) goes in AGENTS.md or this file, not in local agent
  memory, which stays on one machine.
- zsh treats `$name:r` and similar as modifiers; write `${name}:refs/...`. Confirm each
  `git push` succeeded before deleting a ref. macOS has no `timeout`.
- Report status only when it changes and define a term the first time it appears. Let
  a subagent read long reports and return a short verdict.
- Screenshots for evidence come from headless Playwright; use the browser extension
  for interactive QA only, and not while the owner is typing on the same machine. Never
  run test browsers headed on a shared workstation; they take focus.
