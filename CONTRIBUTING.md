# Contributing

Contributions can improve the interpreter, authoring tools, browser experience,
or original adventures. Read [AGENTS.md](AGENTS.md) for code conventions, the
verification method and working agreements. Hosting and production releases are in
[docs/hosting.md](docs/hosting.md).

## Development

Use Node.js 22.22 or newer.

```bash
npm ci
npm --prefix app ci
npm run dev
```

The app opens at `http://localhost:5199/`. If your development server is already
running, give browser tests their own port: `AGI_E2E_PORT=5299 npm run test:e2e`.

| Command               | Purpose                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `npm run check`       | Typechecks, lint, ast-grep structural rules, formatting, unit tests and stored eval cases |
| `npm test`            | Framework-free engine tests                                                               |
| `npm run test:app`    | Browser adapters, storage and provider transport tests                                    |
| `npm run test:e2e`    | Playwright scenarios against a dedicated test server                                      |
| `npm run build`       | Compile the engine and build the browser app                                              |
| `npm run eval:replay` | Replay stored authoring failures without provider calls                                   |

Install the browser once with `npm --prefix app exec -- playwright install chromium`.
The Playwright server uses Vite's `test` mode with a deterministic test provider;
browser tests mock paid providers. See [evals](evals/README.md) for live model
evaluations.

The gate checks installed dependencies against both manifests before testing.
After switching branches or pulling dependency updates, run `npm ci` in both
package roots to keep local verification aligned with CI.

Both package roots use TypeScript 6.0. In VS Code, select **TypeScript: Select
TypeScript Version → Use Workspace Version** so editor diagnostics match the gate.
The root project checks the engine, tests and Node scripts; the app solution
references separate DOM and worker projects, including Playwright scenarios and
Vite/Playwright configs. `evals/tsconfig.json` checks the evaluation configs,
providers, assertions, prompts and regression tests under the same strict rules.
`npm run check` runs every TypeScript project. JavaScript tooling has editor
project coverage and is checked by lint and runtime checks.

## Where things live

| Directory                                                                 | Responsibility                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/runtime/`                                                            | Interpreter, input, objects, sound timing and persistence     |
| `src/container/`, `src/logic/`, `src/picture/`, `src/view/`, `src/sound/` | AGI binary formats, compilers, readers and rendering          |
| `src/agent/`                                                              | Authoring tools, prompts, command help and isolated playtests |
| `app/src/agent/`                                                          | Provider sessions, conversation transport and worker bridge   |
| `app/src/three/`                                                          | GPU presentation and CRT effects                              |
| `app/src/`                                                                | Vue shell, worker, browser storage and ZIP formats            |
| `games/`                                                                  | Original adventure briefs                                     |
| `test/`, `app/test/`, `app/e2e/`, `evals/`                                | Engine, adapter, browser and authoring verification           |

Core engine modules use injected adapters for platform access and have no runtime
dependencies. Follow Peter Kelly's [AGI behavioral specification](https://peterkelly.github.io/agi-re/spec/)
when implementing behavior; check the common contract and the selected profile's variants.

## Testing compatibility

Use small, original resources for engine regressions. Optional compatibility
suites also run against game files supplied by the contributor in
`games/<gameId>/`; those fixture folders are gitignored and excluded from production
builds. Missing inputs produce explicit test skips.

See [Testing](docs/testing.md) for fixture editions and setup, walkthrough
commands, browser replay, reference comparisons and recorded game tests.
[Adding a walkthrough test](docs/testing.md#adding-a-walkthrough-test) explains
how to contribute a reproducible route and its milestone assertions.

## Reporting bugs

Open an [issue](https://github.com/monotio/agi/issues) with the expected behavior,
what happened, and the smallest steps that reproduce it. Include the application
version or commit and browser; for compatibility bugs, include the game edition
and interpreter profile. Prefer an original minimal resource or input sequence
that another contributor can run without commercial game files.

## Pull requests

Describe the player-visible result or developer capability, then the relevant
validation. Include the interpreter profile for compatibility changes. Update the
public docs when behavior changes and credit any external specification or asset.
Contribute code and assets you have the right to distribute under the project's license.
