# Contributing

Thanks for helping. Contributions are welcome across the project: interpreter
fidelity, the authoring tools, the browser app, original adventures and the
documentation.

[AGENTS.md](AGENTS.md) holds the working agreements for everyone who changes
the code, people and coding agents alike: code conventions, architecture
boundaries, the verification method and the provenance rules. Read it before
your first change. Hosting and production releases are covered in
[docs/hosting.md](docs/hosting.md).

## Development

Install Node.js 22.22 or newer, then:

```bash
npm ci
npm --prefix app ci
npm run dev
```

The app opens at `http://localhost:5199/`. The repository has two package
roots: the root holds the engine, tests and scripts, and `app/` the Vue shell.
After switching branches or pulling dependency updates, run `npm ci` in both;
`npm run check` verifies installed dependencies against both manifests before
it tests anything.

For browser tests, install Chromium once with
`npm --prefix app exec -- playwright install chromium`. If your development
server is already running, give the browser tests their own port:
`AGI_E2E_PORT=5299 npm run test:e2e`.

### Commands

| Command                                                      | Purpose                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `npm run check`                                              | The gate: dependency check, typechecks, lint, ast-grep rules, formatting, unit tests and stored eval cases |
| `npm test`                                                   | Engine tests                                                                                               |
| `node --test --experimental-strip-types test/<file>.test.ts` | One engine test file                                                                                       |
| `npm run test:app`                                           | Browser adapter, worker, storage and provider transport tests                                              |
| `npm run test:e2e`                                           | Playwright scenarios against a dedicated test server                                                       |
| `npm --prefix app run e2e -- e2e/<file>.spec.ts`             | One Playwright spec                                                                                        |
| `npm run lint:ast`                                           | ast-grep structural rules and suppression check                                                            |
| `npm run eval:replay`                                        | Replay stored authoring failures without provider calls                                                    |
| `npm run build`                                              | Compile the engine and build the browser app                                                               |

The full gate takes a few minutes. Playwright runs Vite in `test` mode with a
deterministic stub provider, so browser tests never call a paid provider. Live
model evaluations are described in [evals](evals/README.md).

### Editor setup

Both package roots use TypeScript 6.0. In VS Code, choose **TypeScript: Select
TypeScript Version → Use Workspace Version** so editor diagnostics match the
gate. The root project checks the engine, tests and Node scripts; the app
solution references separate DOM and worker projects, including the Playwright
scenarios and the Vite and Playwright configs. `evals/tsconfig.json` checks the
evaluation configs, providers, assertions, prompts and regression tests under
the same strict rules. `npm run check` runs every TypeScript project;
JavaScript tooling has editor project coverage and is checked by lint and
runtime checks.

## Where things live

| Directory                                                                 | Responsibility                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/runtime/`                                                            | Interpreter, profiles, input, objects, sound timing and saves |
| `src/container/`, `src/logic/`, `src/picture/`, `src/view/`, `src/sound/` | AGI binary formats, compilers, readers and rendering          |
| `src/agent/`                                                              | Authoring tools, prompts, command help and isolated playtests |
| `app/src/`                                                                | Vue shell, engine worker, browser storage and ZIP formats     |
| `app/src/agent/`                                                          | Provider sessions, conversation transport and worker bridge   |
| `app/src/three/`                                                          | GPU presentation and CRT effects                              |
| `games/`                                                                  | Original adventure briefs and the tutorial                    |
| `scripts/`                                                                | Walkthrough, audit, conformance and interpreter probe tools   |
| `test/`, `app/test/`, `app/e2e/`, `evals/`                                | Engine, adapter, browser and authoring verification           |

The engine in `src/` has no runtime dependencies and runs unchanged in the
browser, a Web Worker and Node; platform access is injected through adapters.

## Design system

The app styles itself from `app/src/styles/tokens.css`: colours, font sizes,
spacing and radii are tokens, and the base controls (buttons, dialogs, chips,
icon buttons) live in `app/src/ui/`. `npm run lint:tokens` is a ratchet that
fails on new raw colours, font sizes and radii outside the tokens file, so
new chrome should reach for a token or a `ui/` component first.
`app/ui-gallery.html` and `app/studio-harness.html` are dev/test-only pages —
run `npm run dev`, then open `/ui-gallery.html` or `/studio-harness.html`.

## Interpreter behavior

The engine implements Peter Kelly's
[AGI behavioral specification](https://peterkelly.github.io/agi-re/spec/).
Before implementing an opcode, read the common contract and the variants for the
selected interpreter profile.

When a game depends on behavior the specification leaves open, or builds
disagree, the original interpreter is the reference.
[Interpreter compatibility](docs/fidelity.md) collects what is known and how it
was established; its appendices describe the tooling for inventorying,
decoding, disassembling and probing an interpreter you supply locally. Record a
new finding there with its build, binary hash, addresses and conclusion, label
facts and inferences, and cite the entry's heading from code comments instead of
repeating offsets. Keep decoded binaries and disassembly with your local
fixtures; they are never committed.

## Tests

A behavior change comes with the cheapest test that proves it: exact bytes,
pixels or structure first. Watch a new test fail once before making it pass.
Documentation-only changes need consistency and formatting checks.

- Engine regressions use small, original resources with hand-computed
  expectations.
- Worker behavior gets a unit test under `app/test/` that drives the worker
  modules with fake ports and a real `Engine`; a Playwright spec covers only the
  user-visible behavior. Tests that mirror the implementation or duplicate
  another assertion are not kept.
- Compatibility suites also run against game files you supply in
  `games/<folder>/`. Those folders are ignored by git and excluded from
  production builds, and missing inputs produce explicit test skips.

[Testing](docs/testing.md) covers game fixtures, walkthrough proofs, browser
replay, reference comparisons and recorded game tests.
[Adding a walkthrough test](docs/testing.md#adding-a-walkthrough-test) explains
how to contribute a reproducible route with milestone assertions.

## Reporting bugs

Open an [issue](https://github.com/monotio/agi/issues) with the expected
behavior, what happened, and the smallest steps that reproduce it. Include the
application version or commit and your browser; for compatibility bugs, include
the game edition and interpreter profile. Prefer an original minimal resource
or input sequence that another contributor can run without commercial game
files.

## Pull requests

Describe the player-visible result or developer capability, then how you
validated it. Include the interpreter profile for compatibility changes. Update
the public docs when behavior changes, and credit any external specification or
asset. Contribute only code and assets you have the right to distribute under
the project's license; commercial game data belongs in local fixtures, never in
a contribution.
