# Contributing

Contributions can improve the interpreter, authoring tools, browser experience,
or original adventures. Read [AGENTS.md](AGENTS.md) for code conventions, the
verification method and the working agreements; this file covers only what a
contributor needs to act. Hosting and production releases are in
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
package roots; a green run against stale dependencies does not verify CI's build.

Both package roots use TypeScript 6.0. In VS Code, select **TypeScript: Select
TypeScript Version → Use Workspace Version** so editor diagnostics match the gate.
The root project checks the engine, tests and Node scripts; the app solution
references separate DOM and worker projects, including Playwright scenarios and
Vite/Playwright configs. `evals/tsconfig.json` checks the evaluation configs,
providers, assertions, prompts and regression tests under the same strict rules.
`npm run check` runs every TypeScript project. The remaining JavaScript tooling
(ESLint config, suppression scanner and manual HMR proof) has explicit editor
project coverage; it uses lint and runtime checks rather than TypeScript checking.

Recorded game tests store a host snapshot and a bounded operation tape in
`TESTS.JSON`: clocks, consumed input, random draws and prompt replies replay
against current resources. Divergent or unconsumed calls fail the replay.
`test/recording-replay.test.ts` and `app/e2e/game-test-recorder.spec.ts` verify
this contract, including project export/import. Successful authoring mutations
rerun affected tests conservatively; the verdict reports any tests not run.
Stored tests travel only in project archives, never public game exports.

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

Prefer small, original resources with hand-computed expectations. To test a game
locally, put its files in `games/<slug>/`. Development discovery recognizes AGI v2
split directories and v3 combined directories; play them from the same **Your games**
gallery as saved projects. This development folder discovery is not a publishing
mechanism; installed game folders are gitignored and excluded from production builds.

The compatibility suite uses these local installations (other editions may differ):

| Folder            | Interpreter profile           | Container                            |
| ----------------- | ----------------------------- | ------------------------------------ |
| `games/kq1/`      | 2.917                         | v2 split                             |
| `games/kq2/`      | 2.411                         | v2 split                             |
| `games/kq3/`      | 2.936                         | v2 split                             |
| `games/demopac4/` | 3.002.102                     | v3 combined (`DMDIR`, `DMVOL.0-1`)   |
| `games/mh1/`      | 3.002.107 (3.002.102 profile) | v3 combined (`MHDIR`, `MHVOL.0-12`)  |
| `games/mh2/`      | 3.002.149                     | v3 combined (`MH2DIR`, `MH2VOL.*`)   |
| `games/gr1/`      | 3.002.149 (`AGIDATA.OVL`)     | v3 combined (`GRDIR`, `GRVOL.0-2`)   |
| `games/kq4/`      | 3.002.086                     | v3 combined (`KQ4DIR`, `KQ4VOL.0-3`) |

The demo-pack row is a Sierra demonstration pack: six self-running game demos
whose every logic record is dictionary-compressed. `test/demopac4.test.ts` runs
all six to completion, which is what proves the combined container, the plain
message text of compressed logic records and the 3.002.102 profile end to end;
Manhunter's one directly stored logic beside 65 compressed ones is the
independent check of that text rule.

Where installed game data or the shipped interpreter binaries contradict the
specification text, the engine follows them. Each such behavior is recorded in
[docs/fidelity.md](docs/fidelity.md) with its evidence and pinning tests, and the
code comment cites the entry; that file also holds the disassembly recipe for
reading the interpreters yourself.

Copy the complete game installation, including its uppercase directory files,
`WORDS.TOK`, `OBJECT`, every volume file (`VOL.*`, or a v3 game's prefixed
`<PREFIX>VOL.*`) and the interpreter files. Missing fixtures produce explicit
skips with the folder and missing filenames in both engine and browser test
output; a fresh clone's passing synthetic tests do not establish fixture
compatibility. See [test/fixtures.ts](test/fixtures.ts) for the shared checks
and [test/game-fixture.ts](test/game-fixture.ts) for loading resources.
Commercial game data belongs in local fixtures, not contributions. AGI resource
filenames and original resources are welcome; provenance determines what can be
included.

To compare rendered pictures or scripted runtime state with reference observations:

```bash
npm run conformance -- pictures GAME_DIR OUTPUT_JSON PROFILE SUITE_ID
npm run conformance -- runtime GAME_DIR SCENARIO_JSON OUTPUT_JSON
npm run conformance -- compare REFERENCE_JSON OUTPUT_JSON
```

Use the reference bundle's profile and suite identifier. The comparison checks
case coverage, visual and priority hashes, and attached frame artifacts; the
runtime form also captures variables, flags, active objects and output hashes.

A scenario supplies `suiteId`, `profile`, an optional random `seed`, and `steps`;
each step is one operation: `advance` (milliseconds), `key` (PC key word), `input`
(a parser line), `save`/`restore` (a named local slot) or `checkpoint` (a unique
observation name), e.g. `{ "suiteId": "opening", "profile": "2.936", "steps":
[{ "advance": 1000 }, { "checkpoint": "opening" }] }`.

Use independently captured reference observations when assessing fidelity;
repeating a seeded run checks reproducibility, not agreement with an original
interpreter. Reusable scenario code and regression assertions belong in the
test suite, gated by fixture availability. Keep captured saves, game resources,
disassemblies, screenshots and transcripts with local fixtures.

The KQ3 regressions recreate cat movement, teleport arrival and the timed
punishment from the installed game; the sound tests check all three games'
resources. Run both with `node --experimental-strip-types --test test/kq3-regressions.test.ts test/games-sound.test.ts`.
The manual HMR proof in `app/e2e/manual/hmr-resume.mjs` temporarily edits
source; run it in an isolated checkout as described in the script.

Input conformance covers the nineteen-event FIFO, raw/mapped/navigation event
handling, held-key release ordering and modal input; save-selector tests cover
twelve slots, descriptions, cancellation, overwrite confirmation, signature
filtering and failure outcomes. The browser supplies per-game storage instead
of a DOS drive/path interface; exact platform dialog presentation and the
completion of every game/version are not established by these checks.

Run `npm --prefix app run e2e -- phone-input.spec.ts movement-input.spec.ts game-controls.spec.ts`
for synthetic browser input coverage. `npm --prefix app run e2e:phone` runs the
phone suite in Chromium and WebKit; with local KQ1–3 fixtures it also checks
each game's opening room, touch walking and named save/restore slots. Touch
emulation does not emulate Samsung Keyboard or the iOS keyboard: verify device
compatibility on physical Android and iPhone browsers with the keyboard open,
rotation, interruption and save/restore. Full-game compatibility needs recorded
completion runs on the specific game edition and interpreter profile.

### KQ1 completion proof

With the local KQ1 2.917 installation present, run:

```bash
npm run prove:kq1
npm --prefix app exec -- playwright install chromium webkit
npm run prove:kq1:browser
```

The first command executes the walkthrough with a seeded random source and a
virtual 60 Hz host clock, from the title screen, using walking keys, parser
commands and prompt replies; it does not teleport, write game variables, patch
resources or load prepared saves. Deaths, missed score milestones and an
incomplete ending fail the run. The JSON report defaults to
`/tmp/agi-kq1-speedrun.json` (pass another path after `npm run prove:kq1 --`);
reports contain input events, resource hashes, checkpoints and the observed
ending state, not game resources.

The browser command generates a fresh report, then replays it through actual
desktop keys and phone controls in Chromium and WebKit with only the test-mode
host clock accelerated. Each replay verifies the exact local fixture hashes and
the game's terminal ending state independently of the report's success label; a
missing fixture produces an explicit skip. Physical Samsung/iPhone keyboards
and screen readers still require device testing.

### Manhunter Day 1 proof

With the local Manhunter: New York 3.002.107 installation present, run:

```bash
npm run prove:mh1
```

The route in `test/speedrun/mh1-day1.ts` plays the first day from the title
screen to the return home that starts Day 2, using only the game's own inputs:
arrow keys steer the cursor onto hotspots, Enter performs them, F3, C and Tab
open the map, the MAD and the inventory, and the Orbs' name prompt is typed.
The maze machine and the sewer network are driven by fixed move lists recorded
from the engine's own runs, so a changed engine behavior fails the replay
instead of being routed around. The same route runs as a fixture-gated test in
`test/mh1.test.ts`, and the JSON report defaults to
`/tmp/agi-mh1-speedrun.json`. Two engine fixes came out of it: the movement
pass clearing v2 every cycle (the city map's page turns) and loop selection
keeping an in-range cel (the knife game's ending re-selects a loop every cycle
while it waits for the cel to come round). WebKit's automated GPU screenshots
can capture a stale ending dialog, so each run also attaches the final engine
frame and completion asserts the interpreter's terminal state instead.

## Pull requests

Describe the player-visible result or developer capability, then the relevant
validation. Include the interpreter profile for compatibility changes. Update the
public docs when behavior changes and credit any external specification or asset.
Contribute code and assets you have the right to distribute under the project's license.
