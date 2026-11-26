# Feature list

A from-scratch TypeScript rebuild of Sierra's Adventure Game Interpreter, with a game-making
workspace and an AI co-author, running in the browser.

**Play:** [agi.monotio.com](https://agi.monotio.com/) · **Source:** [README](../README.md) ([MIT](../LICENSE))

## Play

- **Your own games.** Add a game folder, a ZIP or disk images (`.img`, `.ima`, `.dsk`, `.td0`, `.adf`, `.po`, `.2mg`). Files stay in your browser.
- **Sierra's AGI games and fan games.** AGI v2 and v3, including the Amiga and Apple IIgs layouts. See the [verified game table](../README.md#the-games-it-plays).
- **Thirteen games finished start to end.** Recorded walkthroughs replay King's Quest I–IV, Space Quest I–II, Police Quest I, Leisure Suit Larry I, The Black Cauldron, Mixed-Up Mother Goose, Gold Rush!, Manhunter: New York and Manhunter 2: San Francisco keystroke by keystroke, plus one chapter of Donald Duck's Playground.
- **Watch a walkthrough, then take over.** Pause, scrub the timeline, and choose **Take control** at any point.
- **Rewind.** Every session records itself. Return to any earlier moment and carry on from there.
- **Resume.** Autosave picks up where you left off, beside the game's own Save and Restore.
- **Adventure Department.** A three-room playable tutorial about how these games are made: repair a picture, wake an actor and sort out a clerk's Priority.
- **CRT display, gamepads and phone play.** Optional scanlines and curved glass, joystick controls, and an on-screen pad with function and modified keys.

## Built against the original interpreters

- **22 original builds read, running as 18 profiles.** PC 2.001 to 3.002.149, Amiga and Apple IIgs. The app picks the profile that matches the edition.
- **Machine code as the reference.** Where the [agi-re specification](https://peterkelly.github.io/agi-re/spec/) is silent or builds disagree, the original routines were decoded and often run with controlled inputs.
- **Differences that change play are kept.** A wandering guard whose countdown runs out walks 256 more steps on a PC and turns every 7 to 51 steps on an Amiga.
- **Published findings.** [Interpreter compatibility](fidelity.md) records build, binary hash, addresses and conclusions across over 8,000 lines, with a [coverage table](fidelity.md#coverage) per aspect and platform.
- **Paula, Ensoniq, Tandy and PC speaker.** Sound follows the machine, modelled from the original drivers and cross-checked against the originals under MAME.
- **Each platform's own presentation.** Palette (including EGA and CGA RGB on PC), font, status line, dissolves and display proportions: 4:3 for PC, IIgs and NTSC Amiga, wider for PAL Amiga, with square pixels as an option.
- **Amiga and IIgs click-to-walk.** Mouse clicks walk the hero as they do on the originals.
- **Recreated bitmap fonts.** Pixel-for-pixel recreations of the Tandy 1000 SX BIOS typeface on PC and Topaz 8 on the Amiga. A game's own `AGIFONT` is used when your copy has one.
- **Original save files.** The engine reads and writes `.SAV` files for every build except the 2.001 booter.

## Make games

- **Edit beside the running game.** Pictures, characters, code, words and sounds open next to the stage. See [The Create workspace](create.md).
- **Update while you play.** **Update and keep playing** changes the game without losing your moment; **Update and restart** re-enters the room. A source error leaves the last working build running.
- **Open an existing game.** LOGIC and PICTURE resources disassemble into editable source. LOGIC re-assembles to the same bytecode.
- **Four ways to start.** **Starter**, **Boilerplate**, **Blank** or **Create with AI**. The template is ordinary code you can change or replace.
- **Plain AGI output.** Authored games are standard AGI 2.936 bytecode with no custom opcodes.
- **Undo across every part.** Drafts autosave, and named **History** checkpoints restore the whole game.
- **Launches.** Save a room start with chosen flags, variables, item locations and fixed random numbers to replay a scene or puzzle repeatedly.
- **Debugger.** Breakpoints in LOGIC, step over, into and out, watches, call stack and variables.
- **Game tests.** Store checks as project documents. Write one before the room exists and it reports what is missing.
- **World map and game state.** Rename rooms, pin notes the agent reads, and name flags and variables.

## Editors

- **PICTURE:** Visual and Priority planes as an editable list of vector commands. Lines, fills, brushes, groups and draw order, with a stand-in that shows who stands in front of what. Trace an uploaded or AI-generated reference image behind the art.
- **VIEW:** Pixel tools, loops and cels, mirrored loops and live previews. Cut cels from a sprite sheet and preview them on the running hero.
- **LOGIC:** Completion, hover documentation, go to definition, a Problems panel, and guided actions for rooms, doors, sentences and sounds.
- **SOUND:** Three voices and noise in a grid or tracker, with native ticks, divisors and attenuation in view. Import MIDI and SN76489 VGM; export MIDI with per-note pitch bends that play each chip divisor's exact frequency.
- **WORDS and OBJECT:** Test sentences with the game's parser, see commands that missed during playtests, and edit the inventory.

## AI co-author

- **Rooms that appear as you walk.** Walk into an unbuilt room and play pauses while the agent writes it, then the hero walks in. The setting is per game.
- **Change the game while you stand in it.** Ask for an alligator in the moat and the agent rewrites the game's bytecode to put it there.
- **Real AGI resources.** The agent writes logic, vector pictures with priority and control lines, animated views, vocabulary, inventory and sound.
- **Reference art generation.** Generate reference images and sprite sheets directly in the workspace with OpenAI or Google Gemini image models, then trace or cut cels from them.
- **Review before it lands.** Previews of pictures, frames, sounds and source differences apply as one History step. Auto-approve is available per session.
- **Self-checking handover.** Compiler messages, rendered previews, playtests and stored game tests run before handover. A failing test needs a stated reason before the agent can finish.
- **Bring your own key.** OpenAI, Anthropic or Google Gemini, called straight from the browser with no backend server. Each task has a budget you set and shows what the provider reports as spent. See [Building with AI](ai.md) and [Security](../SECURITY.md).
- **Hints in Play.** Ask for help or a clue. In Play the agent reads the game and leaves it untouched.
- **A public benchmark.** [Genesis](../evals/benchmarks/genesis/1.0.0/README.md) gives five models the same briefs and publishes every run, its cost and the game, from three cents to two dollars a game.

## Open and hackable

- **Zero-dependency engine.** Runs in a browser Web Worker or Node, with host access injected.
- **LOGIC language server.** `agi-language-server` gives any LSP editor the same code intelligence as the app, including project-wide rename. See [Editor setup](editor-setup.md).
- **Exports.** Download a private **Project file** backup or a **Playable game** ZIP. Either opens again in any browser, and exported games play in any compatible interpreter.
- **Self-hosting.** Host the static app and publish your own game catalog. See [Hosting](hosting.md).
- **Probe tools in the repo.** Scripts to inspect original interpreter routines and compare frames and audio under MAME, using game files you supply locally.
- **Test suite.** Over 700 unit test files, over 260 browser specs in Chromium and WebKit, and 41 stored AI failure cases that replay offline.
- **MIT, with no commercial game assets.** Bring your own copies of commercial games.

## Not built yet

- Native Apple IIgs menus and the Standard File dialog.
- Hercules and CGA composite displays.
- Importing original `.SAV` files through the app UI.
- Full playthroughs on Amiga and Apple IIgs (six Amiga games and Space Quest II on IIgs are verified to boot into their first room).
- Measurements on real hardware (evidence so far is decoded original binaries and MAME cross-checks).

## Thanks

Built on Peter Kelly's CC0 [agi-re specification](https://peterkelly.github.io/agi-re/spec/). Not affiliated with Sierra or its rights holders.
