@AGENTS.md

## Claude Code

AGENTS.md is the shared source of truth for every coding agent; edit it there and
keep this file to Claude-specific notes. The gates (`npm run check`, the
Playwright suites) take minutes: run them in the background and quote the failing
step in your report.

- Background commands stop after two hours: start delegated runs and long suites
  detached, then wait on the process (`while pgrep -f …`) or an exact completion
  marker, never on text in their output.
- zsh treats `$name:r` and similar as modifiers; write `${name}:refs/...`. Confirm each
  `git push` succeeded before deleting a ref. macOS has no `timeout`.
- Report status only when it changes and define a term the first time it appears. Let
  a subagent read long reports and return a short verdict.
- Screenshots for evidence come from headless Playwright; use the browser extension
  for interactive QA only.
