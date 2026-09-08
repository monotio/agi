# Testing

Start with [Contributing](../CONTRIBUTING.md#development) to install dependencies
and run the standard checks. This guide covers optional game fixtures,
compatibility scenarios and recorded game tests. Run all commands from the
repository root unless stated otherwise.

You can run the engine and app test suites without commercial game files.
Synthetic cases use original test resources; fixture-dependent cases report
explicit skips when their inputs are missing. Authoring model evaluations have a separate
[eval guide](../evals/README.md).

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

| Game                     | Folder            | Interpreter build / profile | Tests                                                                                                                                         |
| ------------------------ | ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| King's Quest I           | `games/kq1/`      | 2.917                       | [Resources and movement](../test/games.test.ts), [profiles](../test/games-profile.test.ts), [save/restore](../test/games-persistence.test.ts) |
| King's Quest II          | `games/kq2/`      | 2.411                       | [Resources and movement](../test/games.test.ts), [profiles](../test/games-profile.test.ts), [save/restore](../test/games-persistence.test.ts) |
| King's Quest III         | `games/kq3/`      | 2.936                       | [Resources and movement](../test/games.test.ts), [profiles](../test/games-profile.test.ts), [save/restore](../test/games-persistence.test.ts) |
| King's Quest IV          | `games/kq4/`      | 3.002.086                   | [Resources](../test/kq4.test.ts), [regressions](../test/kq4-regressions.test.ts)                                                              |
| The Black Cauldron       | `games/bc/`       | 2.439 / 2.440               | [Opening and movement](../test/openings.test.ts)                                                                                              |
| Mixed-Up Mother Goose    | `games/mumg/`     | 2.917                       | [Introduction and movement](../test/openings.test.ts)                                                                                         |
| Donald Duck's Playground | `games/ddp/`      | DOS 1.50; 2.272 / 2.440     | [Difficulty selection and movement](../test/openings.test.ts), replayed in the browser                                                        |
| Space Quest II           | `games/sq2/`      | 2.936                       | [Opening and movement](../test/openings.test.ts)                                                                                              |
| Space Quest I            | `games/sq1/`      | 2.917                       | [Opening](../test/openings.test.ts)                                                                                                           |
| Police Quest I           | `games/pq1/`      | 2.903 / 2.936 fallback      | [Opening](../test/openings.test.ts)                                                                                                           |
| Leisure Suit Larry I     | `games/lsl1/`     | 2.440                       | [Opening](../test/openings.test.ts)                                                                                                           |
| Gold Rush                | `games/gr1/`      | 3.002.149                   | [Opening](../test/openings.test.ts), [binary profile](../test/mh2-profile.test.ts)                                                            |
| Manhunter: New York      | `games/mh1/`      | 3.002.107 / 3.002.102       | [Resources and Day 1](../test/mh1.test.ts)                                                                                                    |
| Manhunter 2              | `games/mh2/`      | 3.002.149                   | [Profile and logic references](../test/mh2-profile.test.ts)                                                                                   |
| Sierra demo pack         | `games/demopac4/` | 3.002.102                   | [Resources and six demos](../test/demopac4.test.ts)                                                                                           |

`test/demopac4.test.ts` runs all six demonstrations in the Sierra demo pack to
completion, exercising v3 containers and compressed logic. See
[Interpreter compatibility](fidelity.md) for profile selection, behavior
notes, regression tests and instructions for inspecting original interpreters.

For Donald Duck's Playground, supply DOS 1.50 resources and an interpreter.
The opening test accepts the 2.272 and 2.440 profiles selected from the
interpreter binary; it does not infer a profile from the game title. This
checks difficulty selection and movement, not whole-game conformance.
[ScummVM's release catalog](https://github.com/scummvm/scummvm/blob/master/engines/agi/detection_tables.h)
identifies a 1.0C download containing Amiga resources packaged with a DOS
interpreter. A title screen loading from that mixture does not establish DOS
compatibility; the static audit reports its format and opcode inconsistencies.

The handler comparison in `test/mh2-profile.test.ts` requires both 3.002.149
fixtures (`gr1` and `mh2`); its logic-reference test requires only `mh2`.

Copy the complete game installation, including its directory files,
`WORDS.TOK`, `OBJECT`, every volume file (`VOL.*`, or a v3 game's prefixed
`<PREFIX>VOL.*`) and the interpreter files. Missing fixtures produce explicit
skips with the folder and missing filenames in both engine and browser test
output; a fresh clone's passing synthetic tests do not establish fixture
compatibility. See [test/fixtures.ts](../test/fixtures.ts) for the shared checks
and [test/game-fixture.ts](../test/game-fixture.ts) for loading resources.
Commercial game data belongs in local fixtures, not contributions. AGI resource
filenames and original resources are welcome; provenance determines what can be
included.

### Auditing a fixture library

```bash
npm run fixtures:audit -- games .captures/fixture-audit.json
node --test --experimental-strip-types test/openings.test.ts
npm --prefix app run e2e -- fixture-openings.spec.ts
```

The audit discovers immediate game folders containing AGI directory files and
checks every indexed logic, picture, view and sound, plus vocabulary and inventory
metadata. Filenames are case-insensitive. The JSON report records resource counts,
selected profiles and individual findings; any finding produces a nonzero exit.
Image-only folders (`.img` or `.ima`) are reported as unsupported; the engine
requires resource files and a supported interpreter profile. Extraction alone
does not establish compatibility with an older interpreter.
It distinguishes decoding failures from unsupported contracts, including unknown
interpreter versions and logic that cannot be reconstructed reliably. A resource
may be misindexed or unreferenced; an audit finding alone does not prove that a
normal playthrough requests it. Compare matching original directories and volumes
before changing game data. The audit never repairs its inputs.

The browser suite opens each documented fixture from the gallery and checks its
profile, opening room and presented frame. Black Cauldron, Mother Goose and SQ2
also replay their introductions through a player-controlled movement checkpoint;
the corresponding engine routes run twice from a cold boot. Mother Goose must
finish its arrival animation before movement counts. These checks establish their
stated opening segments, not whole-game completion or a clean resource audit.
Keep reports and captured game screenshots in the ignored `.captures/` directory.

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

### Adding a walkthrough test

Put reusable route code in [test/speedrun/](../test/speedrun/) and register it in
a fixture-gated test. [Speedrun](../test/speedrun/runner.ts) provides player input,
clock advancement and milestone assertions; the
[KQ2 opening route](../test/speedrun/kq2-opening.ts) is a compact example.

1. Specify the game edition, interpreter profile and segment being tested. Use
   [fixtureSkip](../test/fixtures.ts) to report the required inputs when absent.
2. Start from a cold boot with an explicit random seed. Progress through normal
   keys, commands and prompt replies, with bounded waits. Inspect state for
   assertions; do not change flags, inventory or coordinates to advance the route.
3. Derive expected milestones from the game logic and behavioral specification.
   Assert the relevant score, inventory, room or ending condition. A process
   exiting without an error does not establish completion.
4. Replay each new segment twice from a cold boot. Verify the assertion can fail
   by omitting a required action, then restore it. When a route exposes an engine
   bug, add a small synthetic regression where possible and observe it fail
   before fixing the engine.
5. Document the exact command and covered segment. Add browser replay when the
   claim concerns browser input or presentation. A partial route establishes
   coverage only through its asserted milestone.

Reusable route code and original regression tests can be contributed. Supply
external game files locally as described under [Optional fixtures](#optional-fixtures);
link to reference material rather than copying third-party walkthrough text or
game resources into a test. See [Pull requests](../CONTRIBUTING.md#pull-requests)
for contribution requirements.

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

## Recorded game tests

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

## Walkthrough tools

Prepare a searchable reference once, then inspect the logic relevant to the next
milestone. No provider or commercial fixture is required to use the tools; supply
the game directory you want to investigate.

```bash
node --experimental-strip-types scripts/walkthrough-reference.ts prepare GAME_DIR .captures/reference
node --experimental-strip-types scripts/walkthrough-reference.ts query .captures/reference commands door
node --experimental-strip-types scripts/walkthrough-reference.ts render .captures/reference 1
```

The reference includes per-logic disassembly, command and transition indexes,
item-operation references, inventory names, view dimensions and picture control
maps. Disassembly uses one representative word per synonym group; query the
`dictionary` category to find alternate spellings before searching commands.
A logic or picture ID is not necessarily a room ID. Dynamic operands and
conditional branches need their surrounding logic; an indexed transition does not
prove that it can be reached. The output's `manifest.json` names the active
`reference-*` generation; its `problems.json` lists resources that could not be
decoded. The CLI follows this manifest automatically. Matching input and tool
fingerprints reuse the cache; changed inputs create a new generation and retain
the previous one. Generated reference data stays in the selected output directory.

[`scripts/walkthrough-navigation.ts`](../scripts/walkthrough-navigation.ts)
provides `planWalk`, `walkPlanned`, `describePosition` and `renderLive`. It accepts
a runner exposing an engine, a room/position state reader, and a `walkTo` input
driver, such as [Speedrun](../test/speedrun/runner.ts). Read-only planning and
rendering need only the engine and state reader.

`planWalk(run, { x0, y0, x1, y1 })` searches the current control surface with the
player's whole baseline footprint. It returns candidate waypoints or the nearest
reachable position. `walkPlanned` sends those waypoints through the runner's
normal movement inputs and stops on errors or an unexpected room transition.
`renderLive(run, target, "map.png")` writes the scene, control map, object bounds
and path, with a JSON sidecar describing the current geometry.

This is an advisory static planner. Moving objects, animation, changing sprite
width, script-triggered geometry and room transitions can invalidate a candidate.
Use small goals, replan after state changes and assert the observed outcome. A
missing static path is a routing question, not evidence of an interpreter defect.
These are contributor tools; they do not add path planning to the in-app agent.

## Documentation captures

The [media gallery](media/README.md) includes images returned by the actual agent
tools and screenshots from browser tests, with source scenarios and reproduction
commands. `scripts/capture-feedback.ts` generates tutorial feedback without a
provider call. `app/playwright.capture.config.ts` records selected browser tests
with original resources and mocked provider replies; generated recordings stay
under `.captures/` until reviewed and edited.
