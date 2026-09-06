# AGENTS.md — working agreements for this repo

Read this before making changes. These agreements support the project owner's
intent; explicit instructions in the current conversation take precedence.
When a rule conflicts with an authorized task, correct the rule and its affected
checks instead of inventing an approval step. Keep rules tied to a concrete risk
or runtime requirement.

## What this is

AGI IS HERE is an authentic Sierra AGI (Adventure Game Interpreter) engine in TypeScript,
wrapped by a harness in which an agent authors and live-patches real AGI
resources while you play. Authoring is a harness service: generated games
use standard AGI bytecode, including ordinary `new.room` transitions.
Clean-room from Peter Kelly's CC0-licensed agi-re behavioral specification
(https://peterkelly.github.io/agi-re/spec/). Our implementation is MIT licensed and maintained by Monotio.

Public setup and compatibility information live in README.md.

## Public repository and local game data

- `games/kq1/`, `games/kq2/`, `games/kq3/` contain original Sierra game data. They are LOCAL
  development fixtures ONLY: gitignored, never committed, never bundled,
  never referenced by shipped code paths, never served publicly.
- The fixture rule protects repository and public-build contents. It does not
  restrict local loading, patching, saving, ZIP export or ZIP import. Downloads
  and browser storage are local user actions, not publication.
- Fixture-dependent tests must report a skip with the `games/<slug>/` setup
  instruction when files are absent. Use `test/fixtures.ts` in engine tests,
  browser tests and manual checks; never silently return a passing result.
- The public repository and build contain original project code and assets,
  plus dependencies under their own licenses. AGI resource filenames and
  formats are allowed; original project resources are welcome. Do not add
  commercial game assets or imply that exported third-party assets use MIT.
- Engine semantics/behavior are clean-room from the public specification.
  Do not copy implementation code from other interpreters.
- AGI mechanic names (opcode names like `new.room`, `said`) are fine — they
  are functional vocabulary, not creative expression.

## Branding in committed files

- App name: **AGI IS HERE**. Package names use `agi-is-here`.
- Internal identifiers use `monotio_agi` (`monotio-agi` in hyphenated names).
  Storage keys and provider cache keys start with `monotio_agi.`.
- The public address is `https://agi.monotio.com`. Version 1.0 is the first public
  archive baseline: pre-release formats and migrations may be removed for this
  release. Preserve compatibility with actual released saves and exports after it.
  Readers reject unknown versions without rewriting their bytes. Add migrations
  only for released formats; retain their original fixtures and add cases for new formats.
- Project branding: Monotio / monotio.com (publisher), Joakim Riedel (author).
- Credit third-party specifications, dependencies and tools where relevant.

## Authenticity stance

- Real binary formats and real bytecode: v2 split directories and v3 combined
  directories with their volume records and resource expansion, logic resources with
  "Avis Durgan" message encryption, picture vector command streams,
  view loops/cels.
- Generated-game target: AGI 2.936 semantics. No custom authoring opcodes.
  The optional host room-preparation hook is enabled only for authored games.
- Container edits preserve resource IDs, record formats and interpreter behavior.
  Repack current indexed records transactionally when replacing resources so
  superseded data does not accumulate. Physical volume offsets are storage details;
  preserve compressed records and aliases correctly when relocating them.
- The authoritative reference is Peter Kelly's agi-re behavioral specification.
  Use https://peterkelly.github.io/agi-re/spec/. Read the common contract and
  selected profile's variants before implementing behavior.
  Preserve the specification attribution in README.md.

## Architecture

- Browser-only, BYOK (API key in localStorage, direct provider calls), solo
  play. No server.
- Engine (`src/`): framework-free TypeScript, ZERO runtime dependencies,
  must run in browser, Web Worker, and Node (tests). NEVER import node:*
  or browser APIs in `src/` core modules; platform access goes through
  injected adapters.
- App shell (`app/`): Vue 3 + Vite, three.js
  WebGPURenderer with WebGL2 fallback.
- The interpreter blocks on the SharedArrayBuffer + Atomics.wait bridge for
  anything the harness must resolve (agent authoring, modal prompts), the
  same mechanism as classic blocking input.
- Text is engine-owned: a 40x25 character-cell surface composited with the
  visual buffer on the GPU. Never render game text as DOM/CSS overlays.
- Fidelity rule: every opcode that an installed fixture game uses needs the
  specified observable behavior. `test/games.test.ts` checks dispatch coverage;
  semantic conformance requires separate assertions. A no-op is valid only when
  the specification defines it as such. When the spec has profile variants,
  select them per game version; do not assume 2.936 or infer support merely
  from a profile definition.

## Code conventions

- TypeScript strict; `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- ESM with explicit `.ts` import specifiers (allowImportingTsExtensions).
- Tests run under Node strip-only mode: NO TypeScript-only runtime syntax —
  no constructor parameter properties, no enums, no namespaces. Declare
  fields and assign in the constructor body.
- Static string-keyed lookup tables: `Record<K, V>`. `Map`/`Set` only for
  dynamic or non-string keys.
- No one-expression wrapper functions unless the name is a durable public
  contract; inline trivial expressions at the call site.
- Engine tests: `node:test` + `node:assert`, run with
  `node --test --experimental-strip-types 'test/*.test.ts'`. No test
  framework dependency for the engine.
- Hand-computed expectations for renderer/bytecode tests (pixel grids,
  byte sequences) — never snapshot-then-trust.

## Testing & fixtures

- Playwright e2e against real KQ fixtures runs locally only (fixtures
  gitignored); guard with existence checks. Engine fixture tests cover all
  three installed games (KQ1, KQ2, KQ3), parametrized over a slug table.
- For code changes, run the affected tests and typechecks. Run `npm run check`
  before integration. Documentation-only changes need consistency and formatting
  checks; they do not require unrelated engine or browser suites.

## Development method

Use checks that establish the changed behavior:

- **Evals before features.** Define "good" before expanding capability. A
  failure mode that recurs becomes a stored bad case in the eval suite, not a
  memory. `evals/` holds them: troublesome input + exact acceptable outcome.
- **A check nobody has seen fail is a comment.** Every new test/eval MUST be
  watched failing once (break the code or feed the bad case), then seen pass.
- **Three-layer assertions, cheapest first:** structure (schema/exact bytes/
  pixels) → keywords/content → LLM rubric judge. Exact checks wherever
  possible; model judges only for ambiguity, and their failures get read.
- **Green tests prove only their declared contract.** Browser behavior needs
  a scripted run against the real app. Use screenshots for visual changes and
  request/download assertions for transport changes. Do not equate mock-provider
  success with model quality, affordable gameplay or player enjoyment.
- **Every failure becomes a rule.** Recurring defect → promote to
  eslint/ast-grep rule or a permanent test, then delete the reminder.
- **Harness integrity is gated separately from model rollouts.** Test the
  harness offline. Validate model or prompt changes against stored bad cases
  within the owner's authorized spend; report paid-run limits explicitly.
  Available correction rounds are a ceiling, not a requirement to spend them.
- **Authority lives in code, not the model.** The authoring agent's tools are
  deny-by-default; the assembler/container are the validators of last resort;
  destructive actions are previewed.

## Documentation

- Keep README.md and contributor guidance consistent with shipped behavior.
- No gratuitous markdown files.

## Shared working tree (parallel agents)

- When work is shared, NEVER run `git stash`, `git reset`,
  `git checkout`/`git restore` on paths, or any command that rewrites the
  working tree.
- Re-read a file before editing it; exact-string edits only; never rewrite a
  shared file wholesale.
- In parallel work, agree file ownership before editing. With one contributor,
  make the related changes needed to complete the task.

## Delegated work

- Give each contributor an explicit file scope.
- Start a fresh agent for an unrelated task. Reuse an agent only for follow-up
  work within its existing scope; unrelated context reduces precision.
- Review delegated output and run the relevant checks before integrating it.
- Do not require a particular agent vendor or model. Use available capabilities
  within the session's delegation policy.
