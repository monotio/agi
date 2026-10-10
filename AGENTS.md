# AGENTS.md — working agreements

This is the shared agreement for everyone who changes this repository, people and coding agents
alike. Instructions in the current conversation take precedence. Each rule guards a concrete risk;
when a rule gets in the way of an authorized task, fix the rule and the check that enforces it.

## The project

AGI IS HERE is an independent TypeScript implementation of Sierra's AGI interpreter, wrapped in a
browser workspace where people and an in-app agent author and live-patch real AGI resources while
the game runs. Engine behavior comes from Peter Kelly's CC0
[agi-re specification](https://peterkelly.github.io/agi-re/spec/) and from evidence gathered from
original Sierra interpreter binaries. MIT, by Monotio.

Read further when the task needs it:

- [CONTRIBUTING.md](CONTRIBUTING.md): code layout, architecture and every check.
- [docs/testing.md](docs/testing.md): game fixtures, walkthroughs and browser suites, including the
  Linux WebKit container.
- [docs/fidelity.md](docs/fidelity.md): interpreter findings and how to probe an original
  interpreter.
- [docs/hosting.md](docs/hosting.md): deployment, release branches and hotfixes.
- [docs/agent-lanes.md](docs/agent-lanes.md): parallel agent work in worktrees.

## Commands

Node 22.22 or newer. The root package (engine, tests, scripts) and the `app/` workspace (Vue shell)
share one install. `evals/` has its own optional install for live model comparisons.

```bash
npm ci                                        # install root and app workspace
npm run dev                                   # dev server on http://localhost:5199
npm run check                                 # the gate: types, lint, structure, engine + app tests, eval replay
node --test --experimental-strip-types test/<file>.test.ts   # one engine test file
npm run test:app                              # app unit tests
npm run test:e2e                              # Playwright on its own `vite --mode test` server
npm --prefix app run e2e -- e2e/<file>.spec.ts               # one browser spec
npm --prefix app run e2e:webkit-desktop                      # desktop scenarios tagged @webkit-desktop
npm --prefix app run e2e:perf                 # timing budgets, alone on one worker
npm --prefix app run build && npm run check:bundle           # build and bundle boundaries
```

## Done

A change is done when its affected tests and `npm run check` pass. Run them, fix failures your
change caused and rerun without asking. Also build and run `npm run check:bundle` when runtime
imports move, and run the affected Playwright specs when browser behavior changes.
Documentation-only changes need formatting and the link check in `test/docs.test.ts`. CI-only
follow-ups to a green gate need the CI helper tests, workflow validation and formatting.
Browser-test-only edits need the affected browser runs, app typecheck, lint and formatting; earlier
green results for unchanged unit suites still count.

Debug on your own machine: CI runs cost money. Reproduce Linux WebKit and fonts with the container
in docs/testing.md. Push only a fully gated head, and read CI failures with
`gh run view <id> --log-failed`. A failure on unchanged code is a finding to fix or report, not a
reason to rerun until green. Browser suites run once with zero retries; repeat a run only as an
explicit diagnostic.

Ask before pushing, opening or merging pull requests, tagging, deleting shared branches, spending on
paid model or image APIs, or acting outside the repository.

Before a release candidate is accepted, answer every automated review thread against the code. Then
review the whole change once for failure paths, a second tab, and closing before a write commits;
reviews of one push at a time miss properties of the whole system.

## Authenticity

- Games use real AGI formats and bytecode: v2 split and v3 combined directories, "Avis Durgan"
  message encryption, picture vector streams, view loops and cels. Authored games are plain AGI
  2.936 bytecode with no custom opcodes.
- The engine's one escape hatch is the optional `prepareRoom` host hook. It lets the agent write a
  missing room during `new.room` when the project's room-generation setting is on. The setting
  defaults on for Create with AI and off for imported, fixture and template games.
- Each interpreter profile (`src/runtime/profile.ts`) selects observable behavior. Before
  implementing an opcode, read the specification's common contract and the selected profile's
  variants. A no-op is valid only where the specification says so. `test/games.test.ts` checks
  dispatch coverage; each opcode's semantics needs its own assertions.
- Where the specification is silent or builds disagree, the original interpreter in a contributor's
  local `games/*` fixtures is the reference. Record each finding in `docs/fidelity.md` with build,
  binary hash, addresses and conclusion, and keep facts apart from inference. Code comments cite the
  entry rather than repeating offsets. Another interpreter's implementation, or agreement with our
  own replay, is not evidence of original behavior.
- Authoring may change any room or shared resource to evolve a story. Validate and commit the
  complete change transactionally against the intended resource revision, including references and
  vocabulary and inventory bindings. Keep IDs that are still referenced, and apply changes at a safe
  continuation boundary.
- The base template is ordinary editable boilerplate. The agent may use, extend or replace its boot,
  menus, death handling, sounds and state conventions.

## Release contract

Version 1.0 is the first public archive baseline. Released saves and exports stay readable, and
readers reject unknown versions without rewriting bytes.

- `app/test/archive-formats.test.ts` must keep reading the released archives in `app/test/formats/`;
  never regenerate them.
- Extend a released format with new optional fields at the same version, so older files still parse.
  Bump the version only when older files cannot express the change by omission: a changed meaning, a
  removed or restructured field, or a change to the engine replay state that tapes and recorded
  tests carry. Add one migration from the released version and keep its original fixture.
- Stored identities stay fixed: the resource revision (pinned in `app/test/game-library.test.ts`)
  and profile ids (pinned in `test/profile.test.ts`). Hashes and canonical serializations order by
  code point, never by locale.

Release candidates, hotfixes and tagging follow
[Release branches](docs/hosting.md#release-branches). Local release plans stay uncommitted, and
committed files never refer to them.

## Architecture rules

- `src/` (engine and authoring tools) has zero runtime dependencies and runs in the browser, a Web
  Worker and Node, so it uses no `node:*` modules or browser globals; platform access is injected.
  `app/` imports `src/`, never the reverse. ESLint and dependency-cruiser enforce both.
- No new runtime import cycles in `src/` or `app/src/`; `npm run lint:deps` fails on one.
- The app uses the interfaces it ships. The LOGIC editor runs on the same language-server core as
  `agi-language-server`, and a new protocol, format or engine API carries the app's own feature
  rather than a private twin.
- Studio editor code (`src/studio/`, `app/src/studio/`) stays off the Play boot path through dynamic
  `import()`; `npm run check:bundle` fails a build that pulls it in.
- The browser app is bring-your-own-key and needs no server. Node and protocol SDK dependencies stay
  in `scripts/`. Playwright uses the deterministic stub provider and never calls a paid one.
- Host interactions that cannot answer synchronously (authoring, prompts, key waits, save and
  restore) park the interpreter as a resumable continuation. The worker posts `hostRequest`, keeps
  serving application commands, and resumes on the matching `hostAnswer`. Pause is a message too;
  there is no shared memory.
- Code that replaces the worker's engine moves every per-engine piece with it: edit admission,
  debugger session and recorder, on every replacement path.
- Game text is engine-owned: a 40×25 cell surface composited on the GPU, never DOM or CSS.

## Code conventions

TypeScript is strict ESM with explicit `.ts` import specifiers. Tests and scripts run under Node
strip-types, so nothing they import uses enums, namespaces or constructor parameter properties.
ESLint and `.ast-grep/rules/` enforce these and the current Vue idioms; their messages explain each
rule.

Use `Record` for static string-keyed tables, and `Map` or `Set` only for dynamic or non-string keys.
A one-expression wrapper function needs a public contract to justify its name. Name editor features
with vendor-neutral terms: code intelligence, completion, signature help, hover documentation.

## UI copy

The audience includes children building their first game, so copy is plain and calm.

- Headings and labels name a thing in one or two words. Body text says what a thing is or does,
  briefly and positively. The `plain-copy-*` ast-grep rules flag definitions by negation and dash
  asides.
- Error notices name the cause and the next action. State real constraints and irreversible
  consequences; leave out reassurance and tips that repeat what the screen shows.
- Dismiss-only overlays and panels close with a top-right × labelled "Close" and with Esc; popovers
  also close on an outside click. Editor tabs close with ×. Modes end with Done; choices offer
  Cancel plus the named action. No button reads a bare "Close".
- Never estimate what an AI request will cost before it runs. Show the budget with Stop, pause near
  it, and label provider-reported usage as spent.

## Tests and evals

- A check nobody has seen fail is only a comment: watch each new test or eval fail once, then pass.
- Assert the cheapest exact thing first: structure, bytes or pixels, then content, then an LLM judge
  whose failures get read. Renderer and bytecode expectations are hand-computed, never
  snapshot-then-trust.
- Worker behavior gets an `app/test/worker-*.test.ts` unit test driving the module with fake ports
  and a real `Engine`, and a Playwright spec only for the user-visible part. Skip tests that mirror
  the implementation or repeat another assertion.
- Save, sync and recovery guarantees need tests on their failure paths: a rejected write, a second
  page on the same storage, and closing before the write commits. A test that waits for Saved proves
  success only, so state the narrower guarantee when a failure path is untested.
- Browser behavior needs a scripted run against the real app: screenshots for visual changes,
  request and download assertions for transport changes. A stub-provider pass says nothing about
  model quality, cost or player enjoyment.
- A recurring model failure becomes a stored bad case in `evals/fixtures/bad-cases/`, replayed by
  `npm run eval:replay`. A recurring code defect becomes a lint or ast-grep rule or a permanent
  test.
- Budgets are a heads-up: a bundle over budget warns and fails only 10% beyond it, and timing
  budgets keep about three times the worst measured run. Raise a budget when its warning recurs, not
  by the size of one change.
- In-app agent authority lives in code: tools are deny-by-default, the assembler and container
  validate last, and destructive actions are previewed. Validate model and prompt changes against
  the stored bad cases within the authorized spend, and report paid-run limits. Limits on agents
  (rounds, reads, tokens) follow evidence about the task.

## Game fixtures and provenance

Contributors enable compatibility tests by placing their own game files in any folder under
`games/`; fixtures resolve by the SHA-256 of `WORDS.TOK`, not by folder name, and `test/fixtures.ts`
turns missing inputs into explicit skips. Fixture folders stay out of git and production builds.

The public repository holds only original code and assets plus dependencies under their own
licenses: no commercial game assets, no code copied from other interpreters, and no implication that
exported third-party assets are MIT. AGI opcode names are fine. Original interpreter binaries and
bulk disassembly stay local.

Publish identities, hashes, addresses, controlled inputs and behavioral findings. Keep personal
computer details, personal paths, collection inventories, investigation dates and private plans out
of tracked files, commit messages, issues and pull requests, and use portable fixture placeholders
in examples. Public attribution, historical release dates and synthetic test data stay.

## Working together

- The working tree may be shared, so preserve other people's changes: no `git stash`, `git reset`,
  or path-level `checkout` or `restore`. Re-read a file before editing it, make exact-string edits,
  and agree file ownership before parallel work.
- A delegated task gets an explicit file scope, its own worktree and branch, and commits without
  pushing. Its report opens with at most 150 words: verdict, commits, gates and open questions. The
  integrator reviews the diff, runs the full gate on the combined head and removes the worktree and
  branch. Any agent vendor or model may take a lane.
  [docs/agent-lanes.md](docs/agent-lanes.md) has the full lane procedure.
- Before showing a mockup or asking for a scope decision, explain the proposal in plain words: the
  problem, who it serves, where it came from, its cost and its benefit.
- Keep README.md and CONTRIBUTING.md consistent with shipped behavior. Add a Markdown file only for
  a reader the existing documents do not serve.
