# Parallel agent lanes

Use parallel lanes when independent tasks have clear file ownership and can be
reviewed separately. Each lane works in its own worktree on its own branch from a
brief and runs only the tests for what it touches. The orchestrator runs the full
gate once per head, in the main checkout, so lanes never compete for the machine.
Tasks that depend on the same files usually belong in one lane or in sequence.

## Model roster

Record what a model did in this repository here; a vendor benchmark is a lead, not
evidence. `run-lane.sh` starts only the presets below. Claude models run as native
Agent-tool subagents and never go through it.

| Model (how it runs)                                      | Use it for                                              | Watch for                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GPT-6.1 Sol (`sol-low`, `sol-medium`, `sol-high`, Codex) | Engine, worker, integration and red-first fixes (high)  | Long final reports: read its diff, not its summary                                                                                                                                                     |
| GPT-6 Astra (`astra-high`, Codex)                        | Reviews, design and diagnosis; it can also fix          |                                                                                                                                                                                                        |
| Devin SWE-2 (`swe2-high`)                                | Mechanical lanes such as dependency bumps and renames   | Only `swe-2-high`: every other Devin model bills API spend. It stalled for 6 hours on UI work. `run-lane.sh` can return while `devin acp` keeps running, so check `pgrep -fl devin` before relaunching |
| Gemini 4 Argon (`argon-high`, agy)                       | Reviews                                                 | Slow and token-heavy as an implementer; prints only when the run ends, so an empty log is not a hang                                                                                                   |
| Kimi K3.1 Pro (`kimi-high`, omp)                         | Bounded implementation with a clear acceptance test     | Read its diff line by line; brief it to run every spec that mounts the touched component                                                                                                               |
| Claude Opus, Sonnet, Haiku, Fable                        | Native Agent-tool subagents (CLAUDE.md lists the roles) | Never through `run-lane.sh`                                                                                                                                                                            |

### Escalation ladder

When a lane fails review or the gate, consider giving the fix to a stronger
model: Devin → Sol high → Astra high. Sol low or medium goes to Sol high. The fix
lane's report names the root cause (for example, only new tests were run) so the
brief or the checks change too; a stronger model is never the diagnosis.

### Review rule

A different vendor reviews where quota allows; otherwise a different model of the
same vendor, and the review says which.

## Prepare

Read [the working agreements](../AGENTS.md). Choose a shared base commit and
assign explicit files to each lane, including its tests. Agree ownership before
starting. A contributor who needs another lane's file must ask the orchestrator
to coordinate ownership first. Use a fresh agent for unrelated work.

Keep private briefs, reports and screenshots in `.local/agent-lanes/`, which is
covered by the repository's `.local/` gitignore rule. Keep personal paths,
private planning material and investigation dates out of tracked files, commit
messages, issues and pull requests. Public reports use portable paths and
publish only the evidence needed to review the change.

From the repository root:

```sh
mkdir -p .local/agent-lanes/briefs
npm run lane:new -- parser-fix
# Or choose the base explicitly:
npm run lane:new -- editor-fix <base-ref>
```

`lane:new` runs `scripts/agent-lanes/new-lane.sh <name> [base]`. It creates branch
`lane/<name>`, links your local game fixtures (the entries git ignores in `games/`)
into the lane, and installs the root package and app workspace with one `npm ci`.
It prints the absolute worktree path after the installs succeed. The default base
is the current branch; with a detached HEAD, supply a base explicitly. If
installation fails, the worktree and branch remain available for inspection and
completing the installs. Existing branches and directories produce an error.

Worktrees live under `${AGI_LANES_DIR:-$HOME/repos/agi-wt}`. Relative lane
directories are resolved from the repository root where the script is invoked.
Names start with a letter or digit and contain letters, digits, underscores or
hyphens.

## Write the brief

Write one brief per lane under `.local/` (the runner refuses any other location).
Explain the problem, who the change serves, its origin, and the expected cost and
benefit before asking for a scope decision or mockup. List the owned files and
concrete acceptance checks. Start with "Read docs/agent-lanes.md, section
Standard brief, then ...", followed by the task. Choose the model from the roster
above.

Copy this template into the private briefs folder:

```markdown
# Lane <name>

Read docs/agent-lanes.md, section "Standard brief", and the files it names, then:

Problem and audience: <what happens today, who needs the change and why>
Origin: <issue, reproducible observation or approved request>
Outcome: <observable result and its benefit>
Cost and constraints: <implementation tradeoffs and authorized paid-run limits>

Checkout: <absolute worktree path>
Base: <commit or branch>
Branch: lane/<name>
Owned files: <explicit files, including tests and documentation>
Dependencies: <other lane outputs needed, with agreed ordering>

Acceptance:

- <behavior or artifact to verify>
- <failure paths and boundary cases>

Verification:

- <affected tests; observe new tests fail first>
- typecheck, lint and format for the touched files
- <build and bundle checks if imports move>
- <browser checks and screenshot sizes for UI changes>
- Commit on lane/<name>; do not push.

Report: .local/agent-lanes/reports/<name>.md
```

## Standard brief

Every brief points here. A lane:

1. Reads [AGENTS.md](../AGENTS.md) in full and follows it as doctrine.
2. Checks the brief's base with `git rev-parse HEAD` before any work and stops on a
   mismatch.
3. Writes the cheapest meaningful test first and watches it fail before the fix.
4. Commits locally with plain messages and never pushes.
5. Writes its report to the path in the brief, opening as
   [Working together](../AGENTS.md#working-together) specifies. Then file changes,
   fail-first evidence, deleted tests and replacements, screenshots inspected,
   failures and uncertainties.
6. Backs every claim in the report with a tool result from its own session, and
   reports unverified work as unverified.

Steps 3 and 4 apply to implementation lanes.

## Every lane

- Every wait loop has a deadline.
- A lane stops its own background processes and servers before it finishes, by
  PID, never by name.
- Each lane writes in its own worktree. `run-lane.sh` refuses to relaunch a lane
  while its previous run is still alive, because a detached agent can outlive its
  runner.
- Run browsers headless by default; a headed browser or native GPU capture is
  allowed where docs/testing.md needs it (Linux WebKit canvas captures). A headed
  browser on a shared workstation takes keyboard focus, so ask first or use a
  container.

## Run and wait

Use these scripts for every lane rather than a runner of your own; they hold the
lane contract that the logs, PID files and checks rely on. There is no free-form
command: a new preset is a reviewed edit to `run-lane.sh`.

```sh
npm run lane:run -- [--wait] [--rerun] <name> <preset> <brief.md> [worktree]
npm run lane:run -- parser-fix sol-high .local/agent-lanes/briefs/parser-fix.md
# Block until this lane completes and return its exit status:
npm run lane:run -- --wait editor-fix astra-high .local/agent-lanes/briefs/editor-fix.md
npm run lane:status
```

Presets: `sol-low`, `sol-medium`, `sol-high` and `astra-high` run `codex exec -m
gpt-6.1-sol|gpt-6-astra -c model_reasoning_effort="..."`; `swe2-high` runs `devin -p
--model swe-2-high`; `argon-high` runs `agy`; `kimi-high` runs `omp`. Each receives
the prompt "Read and follow the brief at <absolute path> exactly." Configure
paid usage limits in your chosen tool before launching it.

An implementation lane must commit in its worktree, and a lane running browser
checks must launch Playwright browsers. Codex's workspace sandbox blocks both
(it keeps `.git` read-only, and Chromium cannot start inside it), so Codex
presets pass `--dangerously-bypass-approvals-and-sandbox`.
Only the person who owns the machine can approve running them.

The worktree defaults to `<lanes-dir>/<name>` and must be on branch `lane/<name>`.
An explicit worktree (relative paths resolve from the invoking directory) may be
any directory on any branch. The runner drops `node_modules/.bin` from `PATH` so a
package cannot shadow the operator's installed agent CLI.

Logs and PID files go to `.local/agent-lanes/{reports,pids}` of the primary
checkout (`AGI_LANE_NOTES_DIR` overrides the root). For each lane `<name>`:

- `reports/<name>.log` holds standard output and error and a final `exit N` line;
- `pids/<name>.pid` is the wrapper that waits for the command; `.identity` records
  its start time and executable so a reused PID is not mistaken for the lane;
  `.exit` records the status; `.worktree` records the checkout.

Without `--wait` the command continues in the background under `nohup`. An
existing log is refused; after inspecting a stopped run, `--rerun` archives its
files with a UTC timestamp and starts again. A live lane is never archived.
`lane:status` shows each lane's PID, state (running, exited N, stale) and last log
line. Wait by the recorded PID, never by a `pgrep` command pattern; the exit file
and line record command completion, and the report and verification evidence
determine whether the task succeeded.

## Lane rules

- Work in your assigned worktree and branch. Commit there; never push. Coordinate
  any scope changes with the orchestrator. Preserve other contributors' work;
  never use `git stash`, `git reset`, path checkout or path restore in a shared
  tree. Commit coherent changes with plain messages explaining what and why.
- An implementation lane writes the cheapest meaningful regression test and
  observes it fail before implementing the behavior. Prefer exact structure,
  bytes or pixels, then content. In browser tests, assert visibility before reading text. Name the
  replacement test or behavior whenever deleting or rewriting a test, and
  explain why the old assertion was dropped.
- Keep timeouts, retries and skips unchanged in a lane. The orchestrator may
  revise a recurring aggregate timeout after reproducing it on unchanged code
  and measuring successful complete runs. Budget about three times the worst
  measured run; keep per-action waits and assertions intact. Avoid sleeps in
  browser tests; wait for observable conditions. Read each failure, fix its cause with fail-first
  evidence, or report the failing test and first failing line. A failure on
  unchanged code is a finding.
- Run selective gates only: the affected unit and browser tests, and typecheck,
  lint and format for the touched files. When imports move, also run
  `npm --prefix app run build` and `npm run check:bundle`. Follow the repository's
  additional gates for rendering, transport, save, sync and recovery changes.
  For browser changes, also run the affected specs in Linux WebKit through the
  container in docs/testing.md. Leave `npm run check` and the full browser suite to
  the orchestrator:
  parallel full runs on one machine compete for it, and the load they create makes
  every lane's timing evidence unreliable.
  Search existing tests for changed selectors and copy before committing.
- Never push: CI runs cost money and only the integration head goes to CI. Report
  only results you observed. Local success and a stub provider prove their
  declared contracts; model quality and player experience need their own evidence.
- For visual changes, capture and inspect real app screenshots at desktop
  sizes (1063×815 and 1440×900) and phone size (390×844), including WebKit phone
  coverage. Inspect them before claiming the result. Tests write screenshots
  through `test.info().outputPath(...)`; copy report evidence separately into
  the private folder. Use before and after pairs when comparing a change.
- A review or read-only lane may write its own assigned report file under
  `.local/`, and nothing else.
- Open the report as [Working together](../AGENTS.md#working-together) specifies,
  followed by file changes, fail-first evidence, test replacements, screenshot
  evidence, failures and uncertainties. Keep private reports out of git.

## Orchestrate

The orchestrator chooses task boundaries, assigns ownership, tracks dependencies
and keeps briefs consistent, and leaves implementation to the lanes, as
[Working together](../AGENTS.md#working-together) describes. For deep or
cross-cutting changes, the independent plan review happens before any lane
starts: a design problem costs far less to fix in a plan than in a pushed
branch. It reads each report and the actual diff, examines
test assertions and gate evidence, and resolves conflicts and cross-lane effects.
A green report requires review before integration.

Merge a lane's reviewed local branch into the shared
integration branch, in the main checkout, resolve conflicts, and run the affected checks and the full
gate (`npm run check`, build and bundle, the full browser suite) against the
combined result; this is the only place the full gate runs locally, once per head. Run no more
lanes at once than the machine can test without slowing them down; on a laptop
that is about four. Spend the gate once per combined head, as
[Done](../AGENTS.md#done) describes, including the ten repeats of each lane's
new or changed browser specs. After merging several lanes, also run the
complete browser suite, including Linux WebKit through the container, on the
combined head before pushing; CI on that push is the final Linux verdict: lanes that pass on
their own can collide, and the specs each lane touched will not show it. Review the whole change for failure paths,
a second page sharing storage, and closing before a write commits where those
behaviors apply. Verify browser changes in the real app and inspect screenshots.
The orchestrator owns merge, review and final verification even when individual
lanes pass. Remove completed worktrees and branches after integration and any
required owner acceptance.
