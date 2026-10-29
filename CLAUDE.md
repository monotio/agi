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
- Knowledge goes in the repo. Local memory holds only facts specific to one machine and private
  context the owner keeps out of the public repo.
- If the permission classifier denies an action, immediately ask the owner through
  `AskUserQuestion`, naming the action and what it touches. Explain the denial and request approval;
  retry only after approval. Never work around it or leave it for the final summary.
- "Ask expert" means use the `ask-expert` skill to build a consultation document of about 200 KB
  for the owner to send. Give it a fixed output path and pass `--max-size=200` to its
  `extract-code.js` calls. Include context, evidence, alternatives and numbered questions; report
  the output path and size. Wait for the owner to bring back the answer; never predict it.
- On macOS with zsh, `$name:r` and similar are modifiers, so write `${name}:refs/...`, and there
  is no `timeout`. Confirm each `git push` succeeded before deleting a ref.
- Write prose files with the file tool or a quoted heredoc (`<<'EOF'`); an unquoted heredoc runs
  backticked commands.
- The main session is the orchestrator that AGENTS.md describes. Every step it takes rereads its
  whole context, so follow the workflow targets in docs/agent-lanes.md and give detailed work to
  a subagent or lane matched to the task:
  - `fable` (Claude Fable 5.1): complex reasoning, deep design and cross-cutting fixes.
  - `opus` (Claude Opus 5.5): UI design, engine and worker changes, hard diagnosis.
  - `sonnet` (Claude Sonnet 5.5): well-specified fixes, tests and documentation.
  - `haiku` (Claude Haiku 5.5): exploration, sweeps, reading long logs, reports and transcripts.
- Lanes work in their own worktrees (`npm run lane:new -- <name>`) and run only the tests for what
  they touch; the orchestrator runs the full gate once per head, in the main checkout. A Claude
  model works its lane as a subagent (the Agent tool, with the model above). Use
  `npm run lane:run -- <name> <preset> <brief>` (presets `sol-*`, `astra-high`, `swe2-high`,
  `argon-high`, `kimi-high`) only for another vendor's agent. Private notes and memory hold briefs
  and reports, never a runner. A Codex lane needs the owner's approval to run unsandboxed
  (docs/agent-lanes.md says why).
- Use one session per phase: planning, each implementation wave, and the release. Before a phase
  ends, write a handoff note in `.local/` with the head, gate results, open items and the next
  step, and start the next phase from it instead of letting a long session compact.
- Post a short update when something changes: a gate result, a decision, a blocker. Define a term
  the first time it appears, and let a subagent read long reports and return a short verdict.
- During owner playtests, keep the owner's Chrome tab group open, including its starter tab. Never
  close tabs in it unless asked. Inspect read-only; interact with the game only when asked.
- Evidence screenshots come from headless Playwright; a headed browser or native GPU capture is
  allowed where docs/testing.md needs it (Linux WebKit canvas captures). Use the browser extension
  for interactive QA only. On a shared workstation a headed browser takes focus, so ask first or
  use a container.
- QA with paid keys runs on a dev server started with `AGI_DEV_KEYS=1` from a login shell
  (`zsh -ic '... npm run dev'`), so the owner's keys are in its environment. Before handing QA to
  an agent, confirm AI settings show a key and follow AGENTS.md's QA setup rule.
