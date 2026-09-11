# AGENTS.md — working agreements

Read this before making changes. Explicit instructions in the current conversation
take precedence. When a rule conflicts with an authorized task, correct the rule and
its checks instead of inventing an approval step. Keep rules tied to a concrete risk.

## What this is

AGI IS HERE is an authentic Sierra AGI interpreter in TypeScript, wrapped by a
harness in which an agent authors and live-patches real AGI resources while you
play. Engine behavior is clean-room from Peter Kelly's CC0 agi-re specification
(https://peterkelly.github.io/agi-re/spec/): read the common contract and the
selected profile's variants before implementing an opcode. MIT, by Monotio.
README.md is the public front door; CONTRIBUTING.md covers development and
contributions, docs/testing.md fixtures and compatibility checks,
docs/hosting.md hosting and releases, and docs/fidelity.md interpreter behavior.

## Commands

Node 22.22+. Two package roots: the repo root (engine, tests, scripts) and `app/`
(Vue shell).

```bash
npm ci && npm --prefix app ci                 # install both roots
npm run dev                                   # Vite dev server on http://localhost:5199
npm run check                                 # the gate: typecheck (root + app), lint, ast-grep, prettier, engine + app tests, eval replay
npm test && npm run test:app                  # node:test under --experimental-strip-types
node --test --experimental-strip-types test/<file>.test.ts   # one engine test file
npm run test:e2e                              # Playwright on its own `vite --mode test` server
npm --prefix app run e2e -- e2e/<file>.spec.ts               # one spec
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

Version 1.0 is the first public archive baseline. Pre-release formats and
migrations may be dropped before it; after it, released saves and exports stay
readable. Readers reject unknown versions without rewriting bytes. Add migrations
only for released formats and keep their original fixtures.

## Authenticity

- Real formats and bytecode: v2 split and v3 combined directories, "Avis Durgan"
  message encryption, picture vector streams, view loops and cels. Authored games
  are plain AGI 2.936 bytecode with no custom opcodes. The engine's single escape
  hatch is the optional `prepareRoom` host hook, which lets the agent write a
  missing room during `new.room`; the worker installs it only for games created in
  the app, never for imported or fixture games.
- Container edits preserve resource IDs, record formats and interpreter behavior.
  Repack replaced resources transactionally so superseded data does not accumulate.
- Fidelity: every opcode exercised by a fixture needs the specified observable
  behavior, selected per interpreter profile (`src/runtime/profile.ts`). A no-op is
  valid only where the spec says so. `test/games.test.ts` checks dispatch coverage;
  semantics need their own assertions.
- Interpreter findings go in `docs/fidelity.md`; code comments cite the entry
  rather than repeating offsets and build lists.

## Architecture rules

- `src/` (engine and authoring tools) has zero runtime dependencies and runs in the
  browser, a Web Worker and Node. No `node:*` or browser globals there; platform
  access is injected, and ESLint enforces the boundary. `app/` imports `src/`,
  never the reverse.
- Browser-only, BYOK, no server. Playwright runs Vite in `test` mode with the
  deterministic stub provider; browser tests never call paid providers.
- The interpreter blocks on the SharedArrayBuffer + Atomics.wait bridge for
  everything the harness resolves (authoring, modal prompts). COOP/COEP isolation
  is what makes the buffer available; without it nothing boots.
- Game text is engine-owned: a 40×25 cell surface composited on the GPU. Never
  render it as DOM or CSS.

## Code conventions

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
  ESM with explicit `.ts` import specifiers.
- Tests and scripts run under Node strip-types, so nothing they import may use
  enums, namespaces or constructor parameter properties. `erasableSyntaxOnly`,
  ESLint and `.ast-grep/rules/` enforce this.
- Static string-keyed tables are `Record`; `Map` and `Set` only for dynamic or
  non-string keys. No one-expression wrapper functions unless the name is a public
  contract.
- Renderer and bytecode expectations are hand-computed, never snapshot-then-trust.

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
- A recurring defect becomes an eslint or ast-grep rule or a permanent test; then
  delete the reminder.
- Harness integrity is tested offline. Model and prompt changes are validated
  against stored bad cases within authorized spend, with paid-run limits reported.
  Correction rounds are a ceiling, not a target.
- Authority lives in code: tools are deny-by-default, the assembler and container
  are the validators of last resort, destructive actions are previewed.
- Run the affected tests and `npm run check` before integration. Doc-only changes
  need consistency and formatting checks only. Keep README.md and CONTRIBUTING.md
  consistent with shipped behavior; no gratuitous markdown files.

## Working with others

- Shared tree: never `git stash`, `git reset`, or `git checkout`/`restore` on
  paths. Re-read before editing, exact-string edits only, never rewrite a shared
  file wholesale. Agree file ownership before parallel edits.
- Delegation: explicit file scope per contributor, a fresh agent for unrelated
  work, review delegated output and run the relevant checks before integrating.
  Do not require a particular agent vendor or model.
