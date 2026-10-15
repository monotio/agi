@AGENTS.md

## Claude Code

AGENTS.md is the shared agreement for every coding agent. Change rules there, and keep this file
to notes about working in Claude Code.

- `npm run check` and the Playwright suites take minutes. Run them in the background and quote
  the failing step when you report. Wait for them and for CI with the Bash tool's background mode
  and its completion notice: a foreground sleep loop holds the session and costs a step each time
  it returns.
- Background commands stop after two hours. Start long suites and delegated runs detached, save
  the PID, and wait with `while kill -0 "$pid"` or on an exact completion marker. A
  `pgrep -f <pattern>` loop can match its own command line and never end.
- Knowledge another machine or agent needs (rules, traps, the owner's product decisions) goes in
  AGENTS.md or this file; local agent memory stays on one machine.
- On macOS with zsh, `$name:r` and similar are modifiers, so write `${name}:refs/...`, and there
  is no `timeout`. Confirm each `git push` succeeded before deleting a ref.
- Write prose files with the file tool or a quoted heredoc (`<<'EOF'`); an unquoted heredoc runs
  backticked commands.
- The main session is the orchestrator that AGENTS.md describes. Every step it takes rereads its
  whole context, so aim for a few hundred steps per release, and give everything else to a
  subagent or lane matched to the task:
  - `opus` (Claude Opus 5.5): UI design, engine and worker changes, hard diagnosis.
  - `sonnet` (Claude Sonnet 5.5): well-specified fixes, tests and documentation.
  - `haiku` (Claude Haiku 5.5): exploration, sweeps, reading long logs, reports and transcripts.
- Start lanes with `scripts/agent-lanes/new-lane.sh` and `run-lane.sh`, with `AGI_AGENT_CMD` set
  to the lane's agent CLI. Private notes and memory hold briefs and reports, never a runner. A
  Codex lane needs the owner's approval to run unsandboxed (docs/agent-lanes.md says why).
- Use one session per phase: planning, each implementation wave, and the release. Before a phase
  ends, write a handoff note in `.local/` with the head, gate results, open items and the next
  step, and start the next phase from it instead of letting a long session compact.
- Post a short update when something changes: a gate result, a decision, a blocker. Define a term
  the first time it appears, and let a subagent read long reports and return a short verdict.
- Evidence screenshots come from headless Playwright. Use the browser extension for interactive QA
  only, and not while the owner is typing on the same machine: a headed browser takes focus.
- QA with paid keys runs on a dev server started with `AGI_DEV_KEYS=1` from a login shell
  (`zsh -ic '... npm run dev'`), so the owner's keys are in its environment. Before handing QA to
  an agent, confirm AI settings show a key. A QA run that finds no key reports a setup fault to
  fix, not blocked items.
