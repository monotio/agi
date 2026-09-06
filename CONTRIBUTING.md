# Contributing

Contributions can improve the interpreter, authoring tools, browser experience,
or original adventures. Read [AGENTS.md](AGENTS.md) for code conventions and
verification requirements.

## Development

Use Node.js 22.6 or newer.

```bash
npm ci
npm --prefix app ci
npm run dev
```

The app opens at `http://localhost:5199/`. If your development server is already
running, give browser tests their own port: `AGI_E2E_PORT=5299 npm run test:e2e`.

| Command               | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `npm run check`       | Typechecks, lint, formatting, unit tests and stored eval cases |
| `npm test`            | Framework-free engine tests                                    |
| `npm run test:app`    | Browser adapters, storage and provider transport tests         |
| `npm run test:e2e`    | Playwright scenarios against a dedicated test server           |
| `npm run build`       | Compile the engine and build the browser app                   |
| `npm run eval:replay` | Replay stored authoring failures without provider calls        |

Install the browser once with `npm --prefix app exec -- playwright install chromium`.
The Playwright server uses Vite's `test` mode, which exposes a deterministic test
provider. Browser tests mock paid providers; the normal app offers OpenAI and
Anthropic. See [evals](evals/README.md) for live model evaluations.

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
dependencies. Follow Peter Kelly's
[AGI behavioral specification](https://peterkelly.github.io/agi-re/spec/) when
implementing behavior; check the common contract and the selected profile's variants.

## Testing compatibility

Prefer small, original resources with hand-computed expectations. To test a game
locally, put its files in `games/<slug>/`. Development discovery recognizes AGI v2
split directories and v3 combined directories; play them from the same **Your games**
gallery as saved projects. This development folder discovery is not a publishing
mechanism and is excluded from production builds.
Installed game folders are gitignored and excluded from production builds.

The compatibility suite uses these local installations (other editions may differ):

| Folder       | Interpreter profile |
| ------------ | ------------------- |
| `games/kq1/` | 2.917               |
| `games/kq2/` | 2.411               |
| `games/kq3/` | 2.936               |

Copy the complete game installation, including its uppercase directory files,
`WORDS.TOK`, `OBJECT`, all `VOL.*` files and interpreter files. Missing fixtures
produce explicit skips with the folder and missing filenames in both engine and
browser test output. A fresh clone can run the suite without these games; its
passing synthetic tests do not establish fixture compatibility. See
[test/fixtures.ts](test/fixtures.ts) for the shared checks and
[test/game-fixture.ts](test/game-fixture.ts) for loading resources. Commercial game data
belongs in local fixtures, not contributions. AGI resource filenames and original
resources are welcome; provenance determines what can be included.

To compare rendered pictures with reference observations:

```bash
npm run conformance -- pictures GAME_DIR OUTPUT_JSON PROFILE SUITE_ID
npm run conformance -- compare REFERENCE_JSON OUTPUT_JSON
```

Use the reference bundle's profile and suite identifier. The comparison checks
case coverage, visual and priority hashes, and attached frame artifacts.

Scripted runtime comparisons also capture variables, flags, active objects, and
hashes of text and sound output:

```bash
npm run conformance -- runtime GAME_DIR SCENARIO_JSON OUTPUT_JSON
npm run conformance -- compare REFERENCE_JSON OUTPUT_JSON
```

A scenario supplies `suiteId`, `profile`, an optional random `seed`, and `steps`.
Each step contains one operation: `advance` (milliseconds), `key` (PC key word),
`input` (a parser line), `save` or `restore` (a named local slot), or `checkpoint`
(a unique observation name). For example:

```json
{
  "suiteId": "opening",
  "profile": "2.936",
  "steps": [
    { "advance": 1000 },
    { "checkpoint": "opening" },
    { "key": 13 },
    { "advance": 1000 },
    { "checkpoint": "playing" }
  ]
}
```

Use independently captured reference observations when assessing fidelity.
Repeating a seeded run checks reproducibility; it does not establish agreement
with an original interpreter. Reusable scenario code and regression assertions
belong in the test suite, gated by fixture availability. Keep captured saves,
game resources, disassemblies, screenshots and transcripts with local fixtures.

The KQ3 regressions recreate cat movement, teleport arrival and the timed
punishment from the installed game. Sound tests check all three games' resources.
Run them with `node --experimental-strip-types --test test/kq3-regressions.test.ts test/games-sound.test.ts`.
The manual HMR proof in `app/e2e/manual/hmr-resume.mjs` temporarily edits source;
run it in an isolated checkout as described in the script.

Input conformance covers the nineteen-event FIFO, raw/mapped/navigation event
handling, held-key release ordering and modal input. Save-selector tests cover
twelve slots, descriptions, cancellation, overwrite confirmation, signature
filtering and failure outcomes. The browser supplies per-game storage instead
of a DOS drive/path interface; these checks do not establish exact platform
dialog presentation or completion of every game/version.

Run `npm --prefix app run e2e -- phone-input.spec.ts movement-input.spec.ts game-controls.spec.ts`
for synthetic browser input coverage. `npm --prefix app run e2e:phone` runs the
phone suite in both Chromium and WebKit, including the isolation headers needed
for the worker bridge. With local KQ1–3 fixtures installed, it also checks each
game's opening room, touch walking and named save/restore slots. Both engines
are checked in CI; commercial fixture cases skip there. Touch emulation checks application behavior, including
input/composition events; it does not emulate Samsung Keyboard or the iOS
keyboard. Before claiming device compatibility, verify on physical Android and
iPhone browsers with the keyboard open, rotation, interruption and save/restore.
Full-game compatibility needs recorded completion runs using the specific game
edition and interpreter profile.

### KQ1 completion proof

With the local KQ1 2.917 installation present, run:

```bash
npm run prove:kq1
npm --prefix app exec -- playwright install chromium webkit
npm run prove:kq1:browser
```

The first command executes the walkthrough with a seeded random source and a
virtual 60 Hz host clock. It needs no model calls or real-time delays. It starts
at the title screen and uses walking keys, parser commands and prompt replies;
it does not teleport, write game variables, patch resources or load prepared saves.
Deaths, missed score milestones and an incomplete ending fail the run. The local
JSON report defaults to `/tmp/agi-kq1-speedrun.json`; pass another path after
`npm run prove:kq1 --` to keep a separate report. Reports contain input events,
resource hashes, checkpoints and the observed ending state, not game resources.

The browser command generates a fresh report, then replays it through actual
desktop keys and phone controls in Chromium and WebKit. Only the test-mode host
clock is accelerated; movement, collision, sounds, timers and script execution
retain their ordinary cycle order. Each replay verifies the exact local fixture
hashes and the game's terminal ending state independently of the report's success
label. A missing fixture produces an explicit skip. These runs establish the
tested edition's completion under browser emulation; physical Samsung/iPhone
keyboards and screen readers still require device testing.

WebKit's automated GPU screenshots can capture a stale ending dialog; each full
run also attaches the final engine frame. Completion assertions check the
interpreter's terminal state independently of screenshot timing.

## Testing authoring and persistence

Sound feedback is checked at three levels: compiled event timing and pitch/noise
interpretation, the aligned visual timeline, and bounded WAV playback through the
profile's existing sound scheduler. `read_sound` defaults to a neutral effects
view unless matching `write_music` metadata establishes musical intent. Explicit
music inspection estimates equal-tempered pitches; it does not recover an imported
score's original tempo or meter. Saved tempo is tied to the compiled resource
revision and survives project round trips; stale metadata is ignored.
`preview_sound` produces a local listening attachment. Provider adapters omit its
binary audio and state that the model has not heard it. These offline checks prove
the feedback path, not composition quality or a model's listening ability.

Define the expected behavior before implementing it. Observe a new regression
check fail against the bad case, then pass with the fix. Exact bytes, pixels and
schemas come first; use model judges for subjective quality.

The tutorial's canonical artwork is authored directly in
`games/adventure-department/sceneArt.ts`, `characterViews.ts` and `leverView.ts`.
`game.ts` couples the broad filled backgrounds and native EGA VIEW cels with
control and occlusion geometry. Review compiled room frames and cel sheets, then
play all rooms with the actual ego. Update collision and occlusion geometry when
a prop or doorway changes.

For agent-authored scenes, use PICTURE vectors for architecture, terrain,
backdrops and broad static fills. Anything the player manipulates, picks up or
sees animate—including a lever, pickup or operable door—must be a VIEW-backed
screen object. Give it cels for visible states, persist lasting state in logic,
and reconstruct the correct appearance on room re-entry. Commit persistent state
when the action logically takes effect, including before a lever sweep when
leaving mid-sweep must still leave the lever pulled; terminal feedback can wait
for the last cel. Initialize the object with `load.view`, `animate.obj`,
`set.view`, `position` and `draw`; select direct
states with `set.cel`, or finish animated changes with `end.of.loop` and retain
the terminal cel. Reserve `add.to.pic` for static baked details that never act,
animate, disappear or change independently. Build economical sprites from
meaningful contiguous colour clusters, limit decoration to readable details,
and keep character head silhouettes expressive at native resolution; choose
the colours the sprite needs instead of enforcing an arbitrary maximum.
Keep open floor at priority 4 and shape higher priorities to visible occluders.

Local fixture studies supply functional patterns without shipping their art or
text. KQ1 room 1 places a 42×10, five-cel VIEW 97 at `(5, 17)` with fixed
priority 15 and cycles it continuously. KQ2 room 1 uses shared logic 152 and a
28×24, nine-cel VIEW 1 at `(0, 50)`: it rests on cel 0 for a randomized 5–80
logic-cycle pause, plays once with `end.of.loop`, then resets. KQ3 room 39 keeps
most of its shop in the PICTURE while an 11×16–17 character VIEW 78 moves and
cycles independently; a separate four-cel VIEW 79 supplies a small intermittent
foreground action. These observations are timing and composition references;
do not copy their implementation or artwork. Original rooms can use the same
restraint: one short-loop pennant or one paused water-edge splash often adds
enough motion.

Use an evidence loop for each scene: inspect the PICTURE and priority overlay,
then a composed full-room frame with the real actor at scene scale. Inspect the
VIEW contact sheet and request intermediate `playtest_room` frames with
`captureTicks` so rest, mid-motion and terminal cels appear together. Replay
pickup, manipulation and room re-entry paths, including departure during a
state-changing animation. Revise a concrete defect found in those observations.
Structural checks and successful assertions do not guarantee visual quality.
This follows OpenAI's [current-model guidance](https://developers.openai.com/api/docs/guides/latest-model)
and [prompt-engineering guidance](https://developers.openai.com/api/docs/guides/prompt-engineering#prompting-current-models):
state the role and workflow clearly, use actual tool observations, give concrete
criteria and apply appropriate validation. It is practical process guidance,
not a model-specific recipe or an automatic beauty score.
Compare the aligned preview's clean visual, raw EGA priority/control and blended
semantic overlay panels alongside its numeric probes. ImageGen references and
proposed priority masks are drafting aids; compiled AGI output and real-ego
playtests decide whether the scene works. Check the entire actor baseline against
barriers and replay both sides of each depth transition. The authoring guidance
follows the specification's
[picture rules](https://peterkelly.github.io/agi-re/spec/picture_resources.html),
[view composition](https://peterkelly.github.io/agi-re/spec/view_resources.html),
and [object cadence and movement](https://peterkelly.github.io/agi-re/spec/object_behavior.html).
Supply explicit steps and expected puzzle outcomes to `playtest_room`; inspect
its movement, cel-change, timing and occlusion observations before another edit.
Its final screenshot, requested intermediate motion sheet and bounded route cover
only the exercised behavior.

For browser changes, exercise the real flow: create or import, remix, leave,
resume, download and reopen as appropriate. Use request and download assertions
for transport, and screenshots for visual changes.

**Download → Project** stores authoring context in a versioned `PROJECT.JSON` with
repeated images deduplicated into ZIP attachments. **Download → Game export** includes AGI
resources and version-1 `GAME.JSON`, whose nested public metadata allowlist is
`description`, `author`, `license` and parent game/revision.
Neither format changes resource IDs or the game's container format; public game
exports exclude conversations, source descriptions, local previews and opening
validation. Do not infer a license for imported resources when none is declared.

Project bodies live in IndexedDB; a small localStorage index supports discovery
and can be rebuilt from those bodies. Version-1 library metadata keeps the stable
game ID and local storage slug separate from the SHA-256 revision of normalized AGI
resource bytes.
Changing bytes invalidates only the cached opening preview; renames and
conversation saves retain it. Catalog resources are copied to a remix before an
edit, and imported project archives remain separate even when their game bytes
match. Persist resource changes and their matching conversation before advancing
the saved-state reference. Verify failure paths as well as successful saves, and
check exports in a fresh browser session.

Progress thumbnails belong to the autosave record, separately from a library
game's opening cover. Capture the composed picture, sprites and engine text at
the same safe cycle boundary as the save bytes. Old saves remain valid without
a thumbnail, and a thumbnail failure must never prevent saving progress. In the
menu, show each saved game once, with its own resume action and optional details.

Use the shared action styles in `app/src/ui.css`: primary for Play, Resume and
submission; secondary for Add game and supporting actions; danger for removal.
Keep Tutorial and Create on the same disclosure control. Routine validation
belongs in stored diagnostics; show players actionable failures, not test-scope
commentary. `app/e2e/ui-consistency.spec.ts` checks appearance, tap targets,
disclosures and concise game cards across the live flows.
Keep setup in **Settings → AI provider**. Creation and Remix show Connect AI only
until configured. Saved-game cards expose inline rename, Play/Resume, an actions
menu and one Download menu; Details contains metadata. `app/e2e/menu-flow.spec.ts`
checks these paths and section alignment at desktop and phone sizes.

## Pull requests

Describe the player-visible result or developer capability, then the relevant
validation. Include the interpreter profile for compatibility changes. Update the
public docs when behavior changes and credit any external specification or asset.
Contribute code and assets you have the right to distribute under the project's license.

## Hosting

Run `npm run build` and serve `app/dist` over HTTPS. Set these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For a subpath such as `/agi/`, build with:

```bash
npm --prefix app run build -- --base=/agi/
```

The worker bridge requires cross-origin isolation for `SharedArrayBuffer`.
Check the headers, worker loading, ZIP import and provider connections on the
actual host. Production calls providers directly; the development server proxies
those requests locally.

### Including games on your site

The bundled tutorial needs no setup. To offer additional games you have permission
to redistribute, put their public AGI resources under `app/public/games/<id>/`
and add an entry to `app/public/catalog.json` before building. You can also upload
these folders and the manifest directly beside a deployed `index.html`.

```json
{
  "format": "monotio.agi.catalog",
  "version": 1,
  "games": [
    {
      "id": "garden",
      "version": "1.0.0",
      "title": "The Garden",
      "description": "An afternoon in an unusual garden.",
      "author": "Your studio",
      "license": "MIT",
      "path": "games/garden/",
      "files": [
        "LOGDIR",
        "PICDIR",
        "VIEWDIR",
        "SNDDIR",
        "VOL.0",
        "WORDS.TOK",
        "OBJECT",
        "GAME.JSON"
      ]
    }
  ]
}
```

List the actual filenames, preserving their case; optional files such as
`GAME.JSON` should only be listed if present. Use the game's actual license and
keep its required attribution and license files alongside the published game.
The manifest fetches only declared public AGI files, never `PROJECT.JSON` or
authoring conversations. Paths are relative to the manifest on the same origin,
including when the app is hosted under a subpath.

Each entry appears in **Your games** with a checked opening screenshot and **Play**.
The opening check runs when its card comes into view and reports missing or broken
resources before play. Playing stores that release in the browser; subsequent
visits use its saved copy and checkpoint. Change the entry's version when publishing
changed resources so an existing player's saved release stays intact.

The root `games/kq1/`, `games/kq2/` and `games/kq3/` folders are private test
fixtures. The development server exposes them locally for testing; they are not
copied into `app/dist` or discovered by the production app. Publishing games is
an explicit choice through the public folder and manifest.

### Production releases

Production is served at `https://agi.monotio.com/` through Azure Front Door.
CI builds with `/` as the base, checks the built site with
`npm --prefix app run e2e:production`, and packages only `app/dist` plus the
static-host response configuration. Fixture games are never deployment inputs.

Only `@joakimriedel` may merge into protected `main`. Pull requests and the
required CI checks apply to administrators too; direct pushes, force pushes,
auto-merge and branch deletion are disabled. Self-authored PRs do not require a
second account's approval. CODEOWNERS identifies ownership; the branch push
restriction is what enforces exclusive merge permission. An organization owner
can still change GitHub's settings, so account security remains essential.

A successful push to `main` publishes the artifact from that same CI run after
both check jobs pass. PR jobs have read-only repository access and no production
identity. Outside contributors' workflows require approval. Production is a
main-only GitHub environment, uses OIDC bound to immutable GitHub owner/repository IDs, and has only these
environment secrets:
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_RESOURCE_GROUP`, `AZURE_STATIC_WEB_APP_NAME`, `FRONT_DOOR_ID`, and
`FRONT_DOOR_HOST`. These identify infrastructure; no long-lived Azure login
secret or provider API key is stored. The upload token is fetched at runtime
and masked. Public workflow logs are public: never print Azure deployment
objects, tokens or private parameters in this repository.

Front Door, DNS, production parameters and the publisher identity are
managed with Bicep in the private Monotio web infrastructure repository. The
publisher can read only the AGI site's deployment token, not change DNS, roles,
Front Door or the portfolio. The origin accepts traffic only from our gateway.
The app's HTML is not cached; hashed assets receive immutable caching.

Verify the actual edge with:

```bash
AGI_DEPLOY_URL=https://agi.monotio.com npm --prefix app run e2e:production
```

Release rollback is a revert PR through the same checks. Re-running CI also
rebuilds its commit; do not re-run an older release job to roll back production.
An urgent publishing stop is available by disabling the CI workflow or removing
the production identity's federation in Azure. Neither action purges already
served files. Front Door traffic is metered; rate limiting is not a spending cap.
