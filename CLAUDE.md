@AGENTS.md

## Claude Code

AGENTS.md is the shared agreement for every coding agent. Change rules there, and keep this file
to notes about working in Claude Code.

- `npm run check` and the Playwright suites take minutes. Run them in the background and quote
  the failing step when you report.
- Background commands stop after two hours. Start long suites and delegated runs detached, save
  the PID, and wait with `while kill -0 "$pid"` or on an exact completion marker. A
  `pgrep -f <pattern>` loop can match its own command line and never end.
- Knowledge another machine or agent needs (rules, traps, the owner's product decisions) goes in
  AGENTS.md or this file; local agent memory stays on one machine.
- On macOS with zsh, `$name:r` and similar are modifiers, so write `${name}:refs/...`, and there
  is no `timeout`. Confirm each `git push` succeeded before deleting a ref.
- Write prose files with the file tool or a quoted heredoc (`<<'EOF'`); an unquoted heredoc runs
  backticked commands.
- Post a short update when something changes: a gate result, a decision, a blocker. Define a term
  the first time it appears, and let a subagent read long reports and return a short verdict.
- Evidence screenshots come from headless Playwright. Use the browser extension for interactive QA
  only, and not while the owner is typing on the same machine: a headed browser takes focus.
