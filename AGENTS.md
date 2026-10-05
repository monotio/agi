# AGENTS.md — working agreements

Read this before making changes. Explicit instructions in the current conversation
take precedence. When a rule conflicts with an authorized task, correct the rule and
its checks instead of inventing an approval step. Keep rules tied to a concrete risk.

## What this is

AGI IS HERE is an authentic Sierra AGI interpreter in TypeScript, wrapped by a
harness in which an agent authors and live-patches real AGI resources while you
play. Engine behavior is independently implemented using Peter Kelly's CC0
agi-re specification (https://peterkelly.github.io/agi-re/spec/) and behavioral
evidence from original Sierra interpreter binaries. Read the common contract
and selected profile's variants before implementing an opcode. For exact or
uncertain authenticity behavior, inspect/disassemble the original interpreter
in contributor-supplied `games/*` fixtures; record build, binary hash, addresses and conclusions
in `docs/fidelity.md`. Distinguish interpreter machine code from game LOGIC
bytecode and facts from inference. Do not substitute another interpreter's
implementation or self-replay agreement for original-behavior evidence.
MIT, by Monotio.
README.md is the public front door; CONTRIBUTING.md covers development and
contributions, docs/testing.md fixtures and compatibility checks,
docs/hosting.md hosting and releases, and docs/fidelity.md interpreter behavior.

## Commands

Node 22.22+. Two package roots: the repo root (engine, tests, scripts) and `app/`
(Vue shell). `evals/` holds the evaluation runners and stored bad cases; its own
package adds only promptfoo for live comparisons.

```bash
npm ci && npm --prefix app ci                 # install both roots
npm run dev                                   # Vite dev server on http://localhost:5199
npm run check                                 # the gate: dep check, typecheck (root + app), lint, ast-grep, knip, dep-cruiser, token ratchet, prettier, engine + app tests, eval replay
npm test && npm run test:app                  # node:test under --experimental-strip-types
node --test --experimental-strip-types test/<file>.test.ts   # one engine test file
npm run test:e2e                              # Playwright on its own `vite --mode test` server
npm --prefix app run e2e:perf                 # timing budgets, alone on one worker
npm --prefix app run e2e -- e2e/<file>.spec.ts               # one spec
npm --prefix app run e2e:webkit-desktop                      # desktop Studio scenarios tagged @webkit-desktop, in WebKit
npm run lint:ast                              # ast-grep structural rules and suppression check (part of check)
npm run eval:replay                           # stored bad cases, offline
```

## Optional game fixtures

- Contributors can enable compatibility tests by placing their own game files
  in any subfolder under `games/` (e.g. `games/kq1/`, `games/kings-quest-1/`, or
  fan-made games); see docs/testing.md. Fixtures are resolved strictly by content
  hash (`WORDS.TOK` SHA-256), not folder names. Fixture folders are excluded from
  version control and production builds.
- Fixture-dependent tests use `test/fixtures.ts` to report missing inputs and
  setup instructions as explicit skips.
- The public repo and build hold only original project code and assets plus
  dependencies under their own licenses. No commercial game assets; never imply
  exported third-party assets are MIT. Do not copy implementation code from other
  interpreters. AGI opcode names are functional vocabulary and fine to use.

## Release contract

Version 1.0 is the first public archive baseline. After it, released saves and
exports stay readable. Readers reject unknown versions without rewriting bytes. Add migrations
only for released formats and keep their original fixtures.

- The released archives in `app/test/formats/` are never regenerated;
  `app/test/archive-formats.test.ts` must keep reading them.
- Extend a released format in place: new optional fields keep its version, and
  readers accept files without them. Bump the version only when older files
  cannot express the change by omission (a changed meaning, a removed or
  restructured field, or a change to the engine replay state that tapes and
  recorded tests carry), with one migration from the released version.
- Stored identities stay fixed: the resource revision (pinned in
  `app/test/game-library.test.ts`) and profile ids (pinned in
  `test/profile.test.ts`). Hashes and canonical serializations order by code
  point, never by locale.

Release candidates use `rc/X.Y-rc.N` pull requests into `release/X.Y`, with both
package versions set to `X.Y.0-rc.N`. Each candidate branches from `release/X.Y`, and
fixes found after one merges go into the next. Squash-merge a candidate only after CI
passes and the owner accepts it. After the final candidate's release QA, bump both
versions to `X.Y.0` and open `release/X.Y` into `main`, which deploys. Tag and publish
the release only after deployment verification (docs/hosting.md, "Release branches").

Local release plans stay uncommitted and must not be referenced by committed
code, comments or documentation.

## Authenticity

- Real formats and bytecode: v2 split and v3 combined directories, "Avis Durgan"
  message encryption, picture vector streams, view loops and cels. Authored games
  are plain AGI 2.936 bytecode with no custom opcodes. The engine's single escape
  hatch is the optional `prepareRoom` host hook, which lets the agent write a
  missing room during `new.room`; the worker installs it only for games created in
  the app, never for imported or fixture games.
- Authoring may change existing rooms and shared logics/resources to evolve a
  story; the triggering room is not an edit-scope boundary. Validate and commit
  the complete change transactionally, including affected references and
  vocabulary/inventory bindings, against the intended resource revision. Keep
  existing IDs while referenced; coordinated rewrites must update all affected
  references. Apply changes at a safe continuation boundary. Preserve real AGI
  formats and interpreter behavior; repack superseded resources transactionally.
- The supplied base template is editable boilerplate, not a protected runtime
  layer. The agent may use, extend or replace its boot, menus, death handling,
  sounds and state conventions. Validate coordinated changes and their behavior;
  do not reserve template ownership in tools or schemas.
- Keep local original interpreter binaries and bulk disassembly outside public
  builds and archives. Publish behavioral findings and independently authored
  tests, with explicit skips for tests requiring privately held binaries.
- Fidelity: every opcode exercised by a fixture needs the specified observable
  behavior, selected per interpreter profile (`src/runtime/profile.ts`). A no-op is
  valid only where the spec says so. `test/games.test.ts` checks dispatch coverage;
  semantics need their own assertions.
- Interpreter findings go in `docs/fidelity.md`; code comments cite the entry
  rather than repeating offsets and build lists.

## Public provenance

- Publish game/build identities, hashes, addresses, controlled inputs and behavioral
  findings. Keep personal computer details, personal paths, collection inventories,
  investigation dates and private planning material out of tracked files, commit
  messages, issues and pull requests. Use portable fixture placeholders in examples.
- Preserve public attribution, historical software release dates and synthetic test
  data; these are distinct from an investigator's personal provenance.

## Architecture rules

- `src/` (engine and authoring tools) has zero runtime dependencies and runs in the
  browser, a Web Worker and Node. No `node:*` or browser globals there; platform
  access is injected, and ESLint enforces the boundary. `app/` imports `src/`,
  never the reverse.
- No runtime import cycles in `src/` or `app/src/`; `.dependency-cruiser.mjs` pins
  the few older ones as warnings, and a new cycle fails `npm run lint:deps`.
- The app uses the interfaces it ships: the LOGIC editor runs on the same
  language-server core as `agi-language-server`. A new integration surface (protocol,
  format or engine API) carries the app's own feature rather than a private twin.
- Studio editor code (`src/studio/`, `app/src/studio/`) stays off the Play boot path: the
  shell loads it through dynamic `import()`, and `npm run check:bundle` fails a
  build that pulls it in.
- The browser app is BYOK and requires no server. Optional local developer tools
  may expose stdio protocols; Node and protocol SDK dependencies stay in
  `scripts/`, outside `src/` and the browser graph. Playwright runs Vite in `test`
  mode with the deterministic stub provider; browser tests never call paid providers.
- Host interactions that cannot answer synchronously (authoring, prompts, key
  waits, save/restore) suspend the interpreter as a resumable continuation: the
  worker posts a `hostRequest` message and resumes the parked interaction when
  the matching `hostAnswer` arrives, so application commands keep being served
  while the game waits. Pause is a message too — there is no shared memory and
  no cross-origin-isolation requirement.
- Game text is engine-owned: a 40×25 cell surface composited on the GPU. Never
  render it as DOM or CSS.

## Code conventions

- Vue uses current idioms: reactive props destructure, `useTemplateRef`,
  `onWatcherCleanup` and same-name `v-bind`; the `vue-*` ast-grep rules enforce them.
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
  ESM with explicit `.ts` import specifiers.
- Tests and scripts run under Node strip-types, so nothing they import may use
  enums, namespaces or constructor parameter properties. `erasableSyntaxOnly`,
  ESLint and `.ast-grep/rules/` enforce this.
- Static string-keyed tables are `Record`; `Map` and `Set` only for dynamic or
  non-string keys. No one-expression wrapper functions unless the name is a public
  contract.
- Renderer and bytecode expectations are hand-computed, never snapshot-then-trust.
- Name editor features with vendor-neutral terms: code intelligence, completion,
  signature help and hover documentation. Avoid branded feature names in our
  code, UI and documentation.
- UI copy says plainly what a thing is or does. Headings and labels name it in one
  or two calm words; body text is brief and positive. The `plain-copy-*` ast-grep
  rules flag definitions by negation and dash asides.
  Describe capabilities directly; omit unnecessary reassurance about engines,
  keys or excluded alternatives. Error notices name the cause and next action.
  Keep actual constraints and irreversible consequences explicit.
- Dismiss-only overlays and panels use a top-right × with aria-label "Close" and Esc;
  popovers also close on outside click. Editor tabs use ×. Modes end with Done;
  choices offer Cancel plus the named action. Buttons never display bare "Close".
- Never guess or promise what an AI request will cost before it runs: no price on a
  button, no estimate before sending. Show the budget with Stop and pause near it.
  Actual spend may be shown after the fact, from provider-reported usage or
  measured benchmarks, labelled as spent.

## Method

- Evals before features: a recurring failure becomes a stored bad case in
  `evals/fixtures/bad-cases/`, replayed by `npm run eval:replay`, not a note.
- A check nobody has seen fail is a comment: watch every new test or eval fail
  once, then pass.
- Assert cheapest first: exact structure, bytes or pixels, then content, then an
  LLM judge whose failures get read.
- Green tests prove only their declared contract. Browser behavior needs a scripted
  run against the real app: screenshots for visual changes, request and download
  assertions for transport changes. Stub-provider success says nothing about model
  quality, cost or player enjoyment.
- Worker behavior gets the cheapest meaningful regression test: a
  `app/test/worker-*.test.ts` unit test driving the module with fake ports and a
  real `Engine`, plus a Playwright spec only for the user-visible behavior. Do not
  write a test that mirrors the implementation or duplicates another assertion.
- A recurring defect becomes an eslint or ast-grep rule or a permanent test; then
  delete the reminder.
- Harness integrity is tested offline. Model and prompt changes are validated
  against stored bad cases within authorized spend, with paid-run limits reported.
  Correction rounds are a ceiling, not a target.
- Authority lives in code: tools are deny-by-default, the assembler and container
  are the validators of last resort, destructive actions are previewed.
- Save, sync and recovery guarantees need tests on their failure paths: a rejected
  write, a second page on the same storage, and closing before the write commits. A
  test that waits for Saved proves only success; state the narrower guarantee when a
  path is untested.
- Code that replaces the worker's engine moves every per-engine piece with it (edit
  admission, debugger session, recorder) on every replacement path.
- Explain a proposal in plain words (problem, who it serves, origin, cost and benefit)
  before showing a mockup or asking for a scope decision. Limits on agents (rounds,
  reads, tokens) follow evidence about the task, never round numbers.
- Run the affected tests and `npm run check` before integration, plus
  `npm --prefix app run build && npm run check:bundle` when imports move. CI is the
  browser verdict: push the branch and read failures with
  `gh run view <id> --log-failed` instead of replaying the matrix locally, since macOS
  fonts, WebKit and CPU differ from the Linux runners. A failure on unchanged code
  is a finding to fix or report, never a reason to rerun until green. Doc-only
  changes need consistency and formatting checks only. Keep README.md and
  CONTRIBUTING.md consistent with shipped behavior; no gratuitous markdown files.
- Before a candidate is accepted, answer every automated review thread against the
  code, then review the whole change once for failure paths, a second tab and closing
  before commit; reviews of one push at a time miss properties of the whole system.

## Working with others

- Parallel agent lanes: see [docs/agent-lanes.md](docs/agent-lanes.md).
- Shared tree: never `git stash`, `git reset`, or `git checkout`/`restore` on
  paths. Re-read before editing, exact-string edits only, never rewrite a shared
  file wholesale. Agree file ownership before parallel edits.
- Delegation: explicit file scope per contributor, a fresh agent for unrelated
  work, review delegated output and run the relevant checks before integrating.
  Do not require a particular agent vendor or model.
- A delegated task works in its own worktree and branch, pushes only that branch for
  CI, and opens its report with at most 150 words: verdict, commits, gates with the CI
  run link, open questions. Integrate only on green CI for that branch; then delete
  its worktree and branches.
