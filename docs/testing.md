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
locally, place its files in any subfolder under `games/` (e.g. `games/kq1/` or
`games/kings-quest-1/`). Fixture discovery indexes games dynamically by content hash
(SHA-256 of `WORDS.TOK`), making folder names arbitrary. Fan-made and self-authored
games with `WORDS.TOK` (or `METADATA.JSON`) are recognized and playable in tests and
the app out of the box. Development discovery recognizes AGI v2 split directories and
v3 combined directories; play them from the same **Your games** gallery as saved projects.
Installed game folders are gitignored and excluded from production builds.

Editions of the same game on different platforms (DOS, Amiga, IIgs) share the
`WORDS.TOK` vocabulary hash but ship their own `OBJECT`. The game catalog
fingerprints a release by the pair, so a bare hash or alias query resolves to
the single catalogued edition — the release the tests and walkthroughs were
verified against — while ports stay reachable by folder name and appear as
separate gallery entries under their folder title, without the catalogued
edition's profile. Two installations of the same edition, or several
non-catalogued ports, still report an ambiguous query that asks for the
fixture folder.

### Optional fixtures

To enable a game's compatibility tests, supply the edition below in its fixture
folder. The suites assert edition-specific resource counts and behavior; other
editions may need separate expectations.

Full resource-census tests require every volume referenced by the directories.
Tests for individual rooms can use `checkVolumes: false` in the fixture helpers;
resource readers still reject unavailable data if the scenario requests it.

| Game                     | Folder            | Interpreter build / profile | Tests                                                                                                                                                                                                                                    |
| ------------------------ | ----------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| King's Quest I           | `games/kq1/`      | 2.917                       | [Full-game completion proof](#kq1-completion-proof) (159 points; Node and browser), [resources](../test/games.test.ts), [profiles](../test/games-profile.test.ts), [save/restore](../test/games-persistence.test.ts)                     |
| King's Quest II          | `games/kq2/`      | 2.411                       | [Full-game completion proof](#walkthrough-tests) (185 points; wedding and ending credits), [resources and movement](../test/games.test.ts), [profiles](../test/games-profile.test.ts), [save/restore](../test/games-persistence.test.ts) |
| King's Quest III         | `games/kq3/`      | 2.936                       | [Full-game completion proof](#walkthrough-tests) (210 points; royal reunion), [resources and movement](../test/games.test.ts), [profiles](../test/games-profile.test.ts), [save/restore](../test/games-persistence.test.ts)              |
| King's Quest IV          | `games/kq4/`      | 3.002.086                   | [Full-game completion proof](#walkthrough-tests) (230 points; King Graham healed), [resources](../test/kq4.test.ts), [regressions](../test/kq4-regressions.test.ts)                                                                      |
| The Black Cauldron       | `games/bc/`       | 2.439 / 2.440               | [Full-game completion proof](#walkthrough-tests) (230 points; cauldron destroyed), [opening and movement](../test/openings.test.ts)                                                                                                      |
| Mixed-Up Mother Goose    | `games/mumg/`     | 2.917                       | [Full-game completion proof](#walkthrough-tests) (18 rhymes; wake-up ending), [introduction and movement](../test/openings.test.ts)                                                                                                      |
| Donald Duck's Playground | `games/ddp/`      | DOS 1.50; 2.272 / 2.440     | [Chapter proof](#walkthrough-tests) (beginner shift, purchase and playground placement), [difficulty selection and movement](../test/openings.test.ts), replayed in the browser                                                          |
| Space Quest II           | `games/sq2/`      | 2.936                       | [Full-game completion proof](#walkthrough-tests) (250 points; Vohaul defeated), [opening and movement](../test/openings.test.ts)                                                                                                         |
| Space Quest I            | `games/sq1/`      | 2.917                       | [Full-game completion proof](#walkthrough-tests) (202 points; ceremony and ending credits), [opening](../test/openings.test.ts)                                                                                                          |
| Police Quest I           | `games/pq1/`      | 2.903 / 2.936 fallback      | [Full-game completion proof](#walkthrough-tests) (254 points; key to the city), [opening](../test/openings.test.ts)                                                                                                                      |
| Leisure Suit Larry I     | `games/lsl1/`     | 2.440                       | [Full-game completion proof](#walkthrough-tests) (222 points; penthouse ending), [opening](../test/openings.test.ts)                                                                                                                     |
| Gold Rush                | `games/gr1/`      | 3.002.149                   | [Full-game completion proof](#walkthrough-tests) (255 points; Panama route), [opening](../test/openings.test.ts), [binary profile](../test/mh2-profile.test.ts)                                                                          |
| Manhunter: New York      | `games/mh1/`      | 3.002.107 / 3.002.102       | [Full-game completion proof](#walkthrough-tests) (all four days), [resources and Day 1](../test/mh1.test.ts)                                                                                                                             |
| Manhunter 2              | `games/mh2/`      | 3.002.149                   | [Full-game completion proof](#walkthrough-tests) (closing card), [profile and logic references](../test/mh2-profile.test.ts)                                                                                                             |
| Sierra demo pack         | `games/demopac4/` | 3.002.102                   | [Resources and six demos](../test/demopac4.test.ts)                                                                                                                                                                                      |

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

The local KQ4, MH2 and Gold Rush directory files match the
[ScummVM detection fingerprints](https://github.com/scummvm/scummvm/blob/master/engines/agi/detection_tables.h)
(MD5 of the first 5,000 bytes of the combined directory) for KQ4 2.0 1988-07-27
3.5", Manhunter 2 3.02 1989-07-26 3.5" and Gold Rush 2.01 1988-12-22 3.5". The
KQ4 directory indexes pictures 150–151 in a `KQ4VOL.6` and views 198–199 in a
`KQ4VOL.7`; the MH2 directory indexes sounds 215–216 in an `MH2VOL.6`. Those
volumes are absent from these releases' volume sets, so the entries are a
property of the matched directories rather than evidence of a damaged copy. The
strict volume check still reports them. Walkthrough tooling uses
`checkVolumes: "shipped"`, which exempts exactly those volumes for exactly those
directory hashes ([test/fixtures.ts](../test/fixtures.ts)); a route that requests
one of the six resources still fails at the load. A fingerprint identifies the
directory, not every volume byte, and does not show which resources a
playthrough requests.

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

Put reusable route code in [test/speedrun/](../test/speedrun/) and register its
coverage and endpoint in the [walkthrough catalog](../test/speedrun/walkthroughs.ts).
The shared Node and browser suites handle fixture gating and verification.
[Speedrun](../test/speedrun/runner.ts) provides player input,
clock advancement and milestone assertions; the
[KQ2 opening route](../test/speedrun/kq2.ts) is a compact example.

1. Specify the game edition, interpreter profile and segment being tested. Use
   [fixtureSkip](../test/fixtures.ts) to report the required inputs when absent.
2. Start from a cold boot with an explicit random seed. Progress through normal
   keys, commands and prompt replies, with bounded waits. Inspect state for
   assertions; do not change flags, inventory or coordinates to advance the route.
3. Derive expected milestones from the game logic and behavioral specification.
   Assert the relevant score, inventory, room or ending condition. A process
   exiting without an error does not establish completion. `run.checkpoint`
   records a story highlight for the tape's timeline and `run.verify` asserts
   the same state without one; keep highlights a few percent of the tape apart
   so the transport can land on each of them.
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
npm run prove:walkthrough -- kq1
npm --prefix app exec -- playwright install chromium webkit
AGI_SPEEDRUN_FILE=/tmp/agi-kq1-speedrun.json npm --prefix app run e2e -- --config playwright.speedrun.config.ts
```

The first command executes the walkthrough with a seeded random source and a
virtual 60 Hz host clock. It plays from the title screen using walking keys,
parser commands and prompt replies. Deaths, missed score milestones and an
incomplete ending fail the run. Completion requires all three royal treasures,
159 points and the finished throne-room ending sequence. The JSON report defaults to
`/tmp/agi-kq1-speedrun.json` (pass another path after `npm run prove:walkthrough -- kq1`);
reports contain input events, resource hashes, checkpoints and the observed
ending state, not game resources.

The browser command replays that report through actual
desktop keys and phone controls in Chromium and WebKit with only the test-mode
host clock accelerated. Each replay verifies the exact local fixture hashes and
the game's terminal ending state independently of the report's success label; a
missing fixture produces an explicit skip. Physical Samsung/iPhone keyboards
and screen readers still require device testing.

### Walkthrough milestones

After supplying any of the fixtures below, run:

```bash
node --test --experimental-strip-types test/walkthroughs.test.ts
npm --prefix app run e2e -- e2e/walkthroughs.spec.ts
```

Each route uses normal player inputs and a virtual clock, asserts score and
inventory milestones, and repeats from a cold boot with its catalog's fixed seed.
Every game module under `test/speedrun/` owns its catalog entry; the catalog in
`test/speedrun/walkthroughs.ts` only lists them, and `scripts/generate-walkthroughs.ts`
ships one tape per entry. The KQ2 route completes the entire game to the maximum
score of 185, solving all door riddles, navigating the enchantress island and clouds,
defeating the lion, rescuing Valanice, and reaching the wedding and ending credits.
The KQ3 route earns all 210 points, completes all seven spells, escapes Manannan
and the pirate ship, rescues Rosella, and reaches the royal reunion. King's Quest IV returns Genesta's talisman
and heals King Graham with all 230 points; its copy-protection question is
answered through the parser line, and its fixture's directory indexes four
resources in volumes the release never shipped, none of which the route loads.
The SQ1 route
completes the entire game to the maximum score of 202, from the Arcada evacuation
through Kerona, Ulence Flats and the Deltaur to the Xenon ceremony. SQ2 defeats
Vohaul with all 250 points; its timed hazards are waited out or countered from
observed state. Leisure Suit Larry reaches the penthouse with all 222 points,
answering the seeded age quiz from the logic's tables and playing the casino from
the dealt state. Police Quest arrests Jessie Bains and receives the key to the city
with 254 points: the status line promises 245, the logic awards more on this path,
and the claim is the observed ending state. The Black Cauldron destroys the cauldron
with all 230 points from function keys alone. Mixed-Up Mother Goose fixes all
eighteen rhymes with keys only and selects the game's own fastest speed. Gold Rush takes the Panama route to the mother lode with the
maximum 255 points, its clock-bound Brooklyn opening answered from observed
state. Both
Manhunter games play to their closing cards through the cursor interface: New
York across all four days, San Francisco to the digger's surfacing. Donald Duck's
Playground, which has no story ending, ships a chapter: the beginner arch, a
produce-market shift, a purchase and the item placed in the playground. Browser
tests replay the committed `app/public/walkthroughs/*.json` tapes through the app's
controls, checking their exact fixture hashes, interpreter profile, ending state
and duration. They do not regenerate routes: the Node cold-boot tests cover route
generation separately, so a stale or broken shipped tape fails the browser gate.
`AGI_SPEEDRUN_FILE` selects a separately generated tape when validating a route
before replacing its committed artifact. The same catalog includes
KQ1's completion proof. Each entry defines its coverage, route and observable
endpoint once for Node, CLI and browser checks. `scripts/walkthrough.ts` writes
a replay for any catalog entry; for example, `npm run prove:walkthrough -- sq1`.
Game-specific route modules contain player actions and intermediate milestones;
`test/speedrun.test.ts` checks the driver.

Routes carry continuous motion through verified waypoint chains and use observed
game events in place of unnecessary fixed waits. Published checkpoints name story
highlights; finer room, score and inventory assertions remain in the route even
when they do not need a timeline marker. The narrated tapes have these costs:

| Route                | Host polls | Logic cycles | Highlights |
| -------------------- | ---------: | -----------: | ---------: |
| KQ1                  |    109,408 |       15,811 |         24 |
| KQ2                  |    126,171 |       17,921 |         23 |
| KQ3                  |    259,462 |       34,074 |         26 |
| SQ1                  |    142,268 |       18,999 |         31 |
| SQ2                  |    143,943 |       18,801 |         31 |
| PQ1                  |    400,160 |       38,642 |         25 |
| LSL1                 |    145,011 |       15,882 |         21 |
| Black Cauldron       |    105,204 |       12,266 |         24 |
| Mother Goose         |     58,852 |       21,680 |         23 |
| Donald Duck          |     10,269 |        2,319 |         15 |
| MH1                  |    141,960 |       29,847 |         30 |
| MH2                  |    148,362 |       27,590 |         27 |
| Gold Rush            |    106,125 |       42,082 |         29 |
| KQ4                  |    151,260 |       70,672 |         23 |
| Adventure Department |      1,367 |           82 |          4 |

The inexpensive [artifact quality check](../app/test/walkthrough-quality.test.ts)
guards poll, cycle and action ceilings, duplicate/debug markers, and long gaps
between highlights. It supplements cold replay and browser seek checks; it does
not establish completion by counting inputs. KQ1 preserves its verified 159-point
ending, while the game declares a display maximum of 158; no new maximum-score
claim is inferred from that discrepancy.

### Manhunter proofs

After supplying the Manhunter: New York 3.002.107 fixture, run:

```bash
npm run prove:walkthrough -- mh1
```

The route in `test/speedrun/mh1.ts` plays all four days from the title screen
to the closing card, using only the game's own inputs: arrow keys steer the
cursor onto hotspots, Enter performs them, F3, C and Tab open the map, the MAD
and the inventory, and name prompts are typed. The maze machine, the sewer
network and the later arcade sequences are driven by fixed move lists recorded
from the engine's own runs, so a changed engine behavior fails the replay
instead of being routed around. `test/speedrun/mh2.ts` does the same for
Manhunter 2's four days; its fixture's directory indexes two sounds in a volume
the release never shipped, and no logic on the route loads them.

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

[`src/agent/navigation.ts`](../src/agent/navigation.ts)
provides `planWalk`, `walkPlanned`, `describePosition` and `renderNavigationSnapshot`. It accepts
a runner exposing an engine, a room/position state reader, and a `walkTo` input
driver, such as [Speedrun](../test/speedrun/runner.ts). Read-only planning and
rendering need only the engine and state reader.

`planWalk(run, { x0, y0, x1, y1 })` uses deterministic A* over legal player
baseline anchors. A cardinal or diagonal full step costs one movement update;
clearance is Chebyshev distance in picture cells to an illegal anchor. The soft
clearance penalty prefers room in corridors while retaining one-position
passages. Heading is included in search state when turn cost is requested.
Smoothing follows the actual full-step steering trace and preserves clearance
and weighted cost without adding movement updates. Region goals prefer a reachable
interior endpoint; an actor already inside the region has arrived. The executor
finishes at the selected endpoint, rather than stopping at the first region edge.
An off-lattice target is unreachable under this static model;
the planner never assumes normal input can shorten a final step.

The default `geometry: "widest"` mode accounts for every cel in the current view;
`geometry: "current"` is an explicit less conservative option. `maxSearchNodes`
bounds search work; `maxSteps` bounds movement during search, including the final
clipped border crossing. `searchStatus` distinguishes search-work exhaustion,
movement-allowance exhaustion and no static route. Returned `steps` and clearance
statistics describe the smoothed approach; `terminalSteps` counts the remaining
exit updates. `avoidRegions` excludes declared baseline-anchor rectangles from
search, smoothing and live trace validation. These regions need game-specific
evidence; they do not infer hazards from a picture.
`renderNavigationSnapshot` returns a PNG and JSON sidecar with controls, object
bounds, target and candidate route.

[`NavigationController`](../src/agent/navigationController.ts) is the shared
incremental executor used by detached playtests and `Speedrun.navigate`. It
accepts position/region, explicit-waypoint and expected-room exit goals, emits
ordinary player input and observes the real engine after each host poll. The
host advances time and records inputs; frozen walkthrough playback never invokes
the planner. Movement control is reported separately from parser availability.
A terminal result and its counters describe the observed position. When ordinary
movement input is available, the stop key is consumed by the next input phase,
not a direct direction-variable write. The synchronous `Speedrun` movement
helpers also wait for that stop input phase within their remaining action and
scenario poll budgets; incremental `navigate` returns before that phase.

Outcomes distinguish `reached`, `blocked`, `unreachable_under_current_model`,
`needs_input`, `movement_control_unavailable`, `unexpected_transition`,
`hazard_detected`, `budget_exhausted`, `cancelled` and `satisfied` (an `until`
condition the caller observes, such as a door opening, ended the walk early). Modals and suspended
interactions require explicit input. Eligible movement updates drive stall and
oscillation checks, so slow step cadence does not look like a blocked path.
Host polls, logic cycles, movement updates, replans and injected wall time have
separate budgets. Callers of the incremental API can yield or cancel between
polls. Replacement searches use the remaining movement allowance. Detached
`playtest_room` runs remain synchronous and retain their existing
five-second overall deadline.

`playtest_room` supports `walkTo`, `walkPath` and `walkWaypoints`; their `ticks`
are logic-cycle ceilings (default 600), capped by the remaining `cycleBudget`
(default 600 including setup). `steps[].navigation` reports the typed outcome
and counters; `details.navigation` keeps the last navigation verdict compact
when full step diagnostics move behind `read_diagnostic`. `Speedrun` instead polls
at 60 Hz and applies `CycleClock` before logic execution; its poll counts are not
interchangeable with playtest cycles.
`expect.reachable` also executes normal inputs through the shared controller.

`Speedrun.traverse` uses [`NavigationTraversal`](../src/agent/navigationTraversal.ts)
for a declared approach, activation input, observed state change, passage and
verified landing. An approach can finish on an explicit state predicate when a
script takes over before the coordinate target. Each phase declares its geometry
and trigger policy, while movement, polls, cycles, searches and replans share one
allowance. Unknown prompts return `needs_input`; they are never acknowledged by
the traversal. The optional [readiness tests](../test/navigation-readiness.test.ts)
exercise KQ1's tree branch, KQ2's ladder and KQ3's staircase from ordinary inputs.
Setup routes are separate from the single goal used for each tested crossing.

`Speedrun.fork()` retains an in-process checkpoint for exploration. It copies the
resource bytes, engine image and replay state, RNG, pending input and answers,
scheduler state and recorded prefix. It rejects unsupported or inexact boundaries.
`run.probe([{ label, run: branch => ... }], options)` tries synchronous candidates
from that checkpoint under per-candidate and aggregate simulation-poll ceilings.
It reports polls, cycles, movement updates, elapsed time and omitted candidates;
the returned branch can be retained without replaying the prefix. Callback code
must terminate: poll ceilings do not interrupt arbitrary synchronous code.
The retained input tape still needs independent cold-boot replay before publication.
These checkpoints are process memory, not a durable session format.

A route runs under two hosts: the walkthrough test dismisses message windows at
once, while `scripts/walkthrough.ts` dwells on them at reading pace to make the
published tape. Second-based timers then interleave differently with cycle-based
random draws, so the two runs sit at different positions in the random stream. A
route tuned to fixed tick counts or to one seed's luck can pass one host and fail
the other. Drive chance from observed state instead: read the dealt cards or the
wheel, scout alternatives with `fork()` or `probe()`, and wait on game state
rather than on ticks. `type()` backspaces and retypes when a timed window
swallows a letter mid-word.

Static candidates do not predict arbitrary script hazards or prove a game can
be completed. A lake can be geometrically passable while room logic makes entry
fatal; its route needs an explicit safe approach. Keep trigger policy and geometry
assumptions explicit, use bounded goals, and assert milestones. The tested
traversals establish their declared game-specific conditions; broader interaction
understanding and library-wide proofs require additional evidence. A missing
static path is not evidence of an interpreter defect.

## World map

The world map (Help → Map) merges three provenances that must
stay distinct: **observed** transitions the live worker reported, **planned**
rooms and exits from the authoring world, and **static** literal `new.room`
targets found in logic resources. Restore, restart, re-entry and debug jumps
are recorded in the journal but never drawn as exits; a variable target is an
unknown exit, not a guess.

Coverage vocabulary is factual: a room is "visited" only when the journal saw
it, "playtested" when a walkthrough checkpoint names it, and "validated by
tests" when a stored `TESTS.JSON` test names it; an edge is "tested" only when
a stored run exercised that pair. There is no "dead end" or "unreachable"
label — in-degree is not reachability.

`test/room-map.test.ts` covers the merge model (call-context, branch and
variable-write conservatism, discovery surviving journal eviction);
`app/test/use-room-map.test.ts` covers the composable (pause ownership,
current-room tracking, stored-test coverage);
`app/e2e/world-map.spec.ts` covers the browser contract — pause ownership,
imported static graphs, Watch from here, no provider request, phone layout,
and measured open/select timings on a 256-room synthetic map. The sidecar
(`MAP.JSON` in project archives, `monotio_agi.map.<key>` in storage) is
validated by `app/src/roomMapStore.ts`; unknown versions read as empty.

## History and reference recovery

`app/e2e/history-recovery.spec.ts` injects browser-storage failures and inspects
downloaded ZIP bytes, current checkpoints and completeness notices.
`app/test/history-storage.test.ts` covers concurrent writer leases, retention
and exact deduplication of committed batches after eviction. The history
transport browser spec checks seeking, Watch and Undo layouts on phones;
it runs in both the desktop and phone configurations.

`app/e2e/reference-art.spec.ts` checks reference uploads through actual provider
request bodies using local stubs, including JPEG/WebP MIME types, pending
composer attachments and explicit editing intent. It never calls paid providers.

The `app/e2e/history-bench.spec.ts` benchmark uses Chromium's Moto G4 emulation
with 4× CPU throttling. Representative measurements:

| Tape / layout                       | Commit p50 | Commit p95 | Bytes per commit | Reassembly |
| ----------------------------------- | ---------: | ---------: | ---------------: | ---------: |
| Small / append                      |     1.2 ms |     2.5 ms |         19.3 KiB |    13.6 ms |
| Small / whole record                |     5.6 ms |     9.6 ms |        703.9 KiB |     2.9 ms |
| Large / append                      |     4.4 ms |     7.9 ms |         48.5 KiB |    76.7 ms |
| Large / whole record                |    25.2 ms |    35.9 ms |       2047.4 KiB |    11.4 ms |
| Near retention limit / append       |     0.9 ms |     1.3 ms |         12.6 KiB |   214.1 ms |
| Near retention limit / whole record |   262.8 ms |   262.8 ms |      64405.5 KiB |          — |

This is an emulation proxy, not physical-phone evidence. Reassembly measures
`loadGameHistory`, not replay seeking. The near-limit whole-record comparison
contains one representative commit; the append case contains 150. Heap delta
was reported as zero and does not establish peak memory usage. All declared
commit, write-size and reassembly budgets passed; seek latency and peak memory
remain separate measurements.

## Documentation captures

The [media gallery](media/README.md) includes images returned by the actual agent
tools and screenshots from browser tests, with source scenarios and reproduction
commands. `scripts/capture-feedback.ts` generates tutorial feedback without a
provider call. `app/playwright.capture.config.ts` records selected browser tests
with original resources and mocked provider replies; generated recordings stay
under `.captures/` until reviewed and edited.
