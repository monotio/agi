# Parallel agent lanes

Use parallel lanes when independent tasks have clear file ownership and can be
reviewed separately. Each contributor gets a worktree, a branch and a brief.
This keeps changes isolated while the orchestrator combines and verifies them.
Tasks that depend on the same files usually belong in one lane or in sequence.
Any coding agent with a command that reads instructions on stdin can participate.

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
mkdir -p .local/agent-lanes/briefs .local/agent-lanes/reports
scripts/agent-lanes/new-lane.sh parser-fix
# Or choose the base explicitly:
scripts/agent-lanes/new-lane.sh editor-fix <base-ref>
```

`new-lane.sh <name> [base]` creates branch `lane/<name>` and installs the root
package and app workspace with one `npm ci`. It prints the absolute
worktree path after the installs succeed. The default base is the current
branch; with a detached HEAD, supply a base explicitly. If installation fails,
the worktree and branch remain available for inspection and completing the
installs. Existing branches and directories produce an error.

Worktrees live under `${AGI_LANES_DIR:-../agi-lanes}`. Relative lane directories
are resolved from the repository root where the script is invoked. Export an
absolute `AGI_LANES_DIR` to share one location across checkouts. Names start with
a letter or digit and contain letters, digits, underscores or hyphens.

## Write the brief

Write one brief per lane. Explain the problem, who the change serves, its origin,
and the expected cost and benefit before asking for a scope decision or mockup.
List the owned files and concrete acceptance checks. Keep agent vendors and
models optional; choose tools according to the task and contributor's setup.

Copy this template into the private briefs folder:

```markdown
# Lane <name>

Problem and audience: <what happens today, who needs the change and why>
Origin: <issue, reproducible observation or approved request>
Outcome: <observable result and its benefit>
Cost and constraints: <implementation tradeoffs and authorized paid-run limits>

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
Start with at most 150 words: verdict, commits, gates, open questions.
Then describe changes, fail-first evidence, deleted tests and replacements,
screenshots inspected, failures and uncertainties.
```

## Run and wait

Set `AGI_AGENT_CMD` to a trusted shell command that reads the brief on stdin.
It executes through `sh -c` inside the lane's worktree. Configure permissions and
any paid usage limits in your chosen tool before launching it.

```sh
export AGI_AGENT_CMD='<your-agent-cli> exec -'
scripts/agent-lanes/run-lane.sh parser-fix .local/agent-lanes/briefs/parser-fix.md
# Block until this lane completes and return its exit status:
scripts/agent-lanes/run-lane.sh --wait editor-fix .local/agent-lanes/briefs/editor-fix.md
```

`run-lane.sh [--wait] <name> <brief.md> [worktree]` requires branch `lane/<name>`
in the selected worktree. An explicit relative worktree is resolved from the
invoking repository root. The brief path is resolved from the invoking directory.
The default worktree is `<lanes-dir>/<name>`.

The runner prints the PID and log path, and writes `<lanes-dir>/logs/<name>.log`
and `<lanes-dir>/logs/<name>.pid`. The PID belongs to the wrapper that waits for
the command and appends a final `exit N` line. Standard output and error go to
the log. Without `--wait`, the command continues in the background under
`nohup`. With `--wait`, the runner polls that PID with `kill -0`, reaps its child
with `wait`, and returns the command's status. An existing log is preserved;
archive it after inspecting the completed run before launching the same name
again. Abruptly killing the wrapper can leave a log without a final exit line;
treat that run as incomplete.

To observe a previously launched lane from another shell:

```sh
pid=$(cat "${AGI_LANES_DIR:-../agi-lanes}/logs/parser-fix.pid")
while kill -0 "$pid" 2>/dev/null; do sleep 1; done
tail -n 1 "${AGI_LANES_DIR:-../agi-lanes}/logs/parser-fix.log"
```

Wait by the recorded PID, never by a `pgrep` command pattern. Another shell
cannot reap the child or retrieve its status with `wait`; inspect the final
exit line as well. On systems where an orphan remains a zombie until reaped,
`kill -0` still succeeds; inspect the completed log rather than assuming the
agent is still working. The exit line records command completion. The report
and verification evidence determine whether the task succeeded.

## Lane rules

- Work in your assigned worktree and branch. Commit there; never push. Coordinate
  any scope changes with the orchestrator. Preserve other contributors' work;
  never use `git stash`, `git reset`, path checkout or path restore in a shared
  tree. Commit coherent changes with plain messages explaining what and why.
- Write the cheapest meaningful regression test and observe it fail before
  implementing the behavior. Prefer exact structure, bytes or pixels, then
  content. In browser tests, assert visibility before reading text. Name the
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
- Begin the report with a summary of at most 150 words: verdict, commits,
  observed gates, and open questions. Follow with file changes,
  fail-first evidence, test replacements, screenshot evidence, failures and
  uncertainties. Keep private reports out of git.

- Run browsers headless. A headed browser on a shared workstation takes
  keyboard focus from whoever is working there; use a container or ask first.

## Orchestrate

The orchestrator chooses task boundaries, assigns ownership, tracks dependencies
and keeps briefs consistent. It reads each report and the actual diff, examines
test assertions and gate evidence, and resolves conflicts and cross-lane effects.
A green report requires review before integration.

Merge a lane's reviewed local branch into the shared
integration branch, resolve conflicts, and run the affected checks and the full
gate (`npm run check`, build and bundle, the full browser suite) against the
combined result; this is the only place the full gate runs locally. Run no more
lanes at once than the machine can test without slowing them down; on a laptop
that is about four. After merging several lanes, also run the
complete browser suite, including Linux WebKit through the container, on the
combined head before pushing; CI on that push is the final Linux verdict: lanes that pass on
their own can collide, and the specs each lane touched will not show it. Review the whole change for failure paths,
a second page sharing storage, and closing before a write commits where those
behaviors apply. Verify browser changes in the real app and inspect screenshots.
The orchestrator owns merge, review and final verification even when individual
lanes pass. Remove completed worktrees and branches after integration and any
required owner acceptance.
