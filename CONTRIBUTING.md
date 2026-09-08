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

### Recorded game tests

Recorded game tests store a host snapshot and a bounded operation tape in
`TESTS.JSON`: clocks, consumed input, random draws and prompt replies replay
against current resources. Divergent or unconsumed calls fail the replay.
`test/recording-replay.test.ts` and `app/e2e/game-test-recorder.spec.ts` verify
this contract, including project export/import. Successful authoring mutations
rerun affected tests conservatively; the verdict reports any tests not run.
Stored tests travel only in project archives, never public game exports.
`read_game_tests` lists compact summaries or pages of editable JSON definitions;
opaque snapshots and replay tapes stay out of model responses. Merge edits retain
existing recording setup when it is omitted or null. Full replacement uses only
the supplied setup; remove a single test before rewriting it to reset its setup.

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
gallery as saved projects. Installed game folders are gitignored and excluded
from production builds.

### Optional fixtures

To enable a game's compatibility tests, supply the edition below in its fixture
folder. The suites assert edition-specific resource counts and behavior; other
editions may need separate expectations.

Full resource-census tests require every volume referenced by the directories.
Tests for individual rooms can use `checkVolumes: false` in the fixture helpers;
resource readers still reject unavailable data if the scenario requests it.

| Game                 | Folder            | Interpreter build / profile | Tests                                                                                                                                |
| -------------------- | ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| King's Quest I       | `games/kq1/`      | 2.917                       | [Resources and movement](test/games.test.ts), [profiles](test/games-profile.test.ts), [save/restore](test/games-persistence.test.ts) |
| King's Quest II      | `games/kq2/`      | 2.411                       | [Resources and movement](test/games.test.ts), [profiles](test/games-profile.test.ts), [save/restore](test/games-persistence.test.ts) |
| King's Quest III     | `games/kq3/`      | 2.936                       | [Resources and movement](test/games.test.ts), [profiles](test/games-profile.test.ts), [save/restore](test/games-persistence.test.ts) |
| King's Quest IV      | `games/kq4/`      | 3.002.086                   | [Resources](test/kq4.test.ts), [regressions](test/kq4-regressions.test.ts)                                                           |
| Space Quest I        | `games/sq1/`      | 2.917                       | [Opening](test/opening-screens.test.ts)                                                                                              |
| Police Quest I       | `games/pq1/`      | 2.903 / 2.936 fallback      | [Opening](test/opening-screens.test.ts)                                                                                              |
| Leisure Suit Larry I | `games/lsl1/`     | 2.440                       | [Opening](test/opening-screens.test.ts)                                                                                              |
| Gold Rush            | `games/gr1/`      | 3.002.149                   | [Opening](test/opening-screens.test.ts), [binary profile](test/mh2-profile.test.ts)                                                  |
| Manhunter: New York  | `games/mh1/`      | 3.002.107 / 3.002.102       | [Resources and Day 1](test/mh1.test.ts)                                                                                              |
| Manhunter 2          | `games/mh2/`      | 3.002.149                   | [Profile and logic references](test/mh2-profile.test.ts)                                                                             |
| Sierra demo pack     | `games/demopac4/` | 3.002.102                   | [Resources and six demos](test/demopac4.test.ts)                                                                                     |

`test/demopac4.test.ts` runs all six demonstrations in the Sierra demo pack to
completion, exercising v3 containers and compressed logic. See
[Interpreter compatibility](docs/fidelity.md) for profile selection, behavior
notes, regression tests and instructions for inspecting original interpreters.

The handler comparison in `test/mh2-profile.test.ts` requires both 3.002.149
fixtures (`gr1` and `mh2`); its logic-reference test requires only `mh2`.

Copy the complete game installation, including its directory files,
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

After supplying the KQ1 2.917 fixture, run:

```bash
npm run prove:kq1
npm --prefix app exec -- playwright install chromium webkit
npm run prove:kq1:browser
```

The first command executes the walkthrough with a seeded random source and a
virtual 60 Hz host clock. It plays from the title screen using walking keys,
parser commands and prompt replies. Deaths, missed score milestones and an
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

### Opening walkthroughs

After supplying the KQ2 2.411 or SQ1 2.917 fixture described above, run:

```bash
node --test --experimental-strip-types --test-name-pattern="opening walkthrough" test/speedrun.test.ts
```

Each route uses normal player inputs and a virtual clock, asserts score and
inventory milestones, and repeats from a cold boot with seed 1. The KQ2 route
covers the basket, soup, earrings, cloak and ring, ending outside the cottage at
score 18. The SQ1 route retrieves the cartridge and keycard at score 6, entering
the archive console answer once. These tests cover those opening segments;
later puzzles and endings require additional routes.

### Manhunter Day 1 proof

After supplying the Manhunter: New York 3.002.107 fixture, run:

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
`/tmp/agi-mh1-speedrun.json`. Coverage ends at the start of Day 2; later days
need their own walkthroughs.

## Pull requests

Describe the player-visible result or developer capability, then the relevant
validation. Include the interpreter profile for compatibility changes. Update the
public docs when behavior changes and credit any external specification or asset.
Contribute code and assets you have the right to distribute under the project's license.
