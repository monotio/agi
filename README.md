# AGI IS HERE

Describe an adventure, then play it as an agent builds the rooms around you.
You can ask for changes while you play: give the guard a different personality,
add a puzzle, or turn the courtyard into a swamp.

AGI IS HERE runs in your browser, using an authentic **Adventure Game
Interpreter**, the engine behind Sierra's early adventures. The agent writes
real AGI game files, which you can inspect, download and play again. Creating
and remixing use your own OpenAI or Anthropic API key; playing existing content
needs no key.

## Play

Play at [agi.monotio.com](https://agi.monotio.com/), or run it locally.

With Node.js 22.22 or newer, run:

```bash
npm ci
npm --prefix app ci
npm run dev
```

Open `http://localhost:5199/` and click **Play now** for **Adventure Department**,
an original MIT-licensed tutorial with three rooms. Repair a picture, wake a
sprite and fix a clerk's priority to learn how AGI adventures work. It runs
locally without a provider key or original Sierra game files. **Make a copy**
keeps the catalog original intact; **Game actions → Project** includes the tutorial's
editable logic, picture, view and sound sources. The exported AGI game can also run
offline in a compatible interpreter. Loading this website itself still needs
a connection; it is not yet an installable offline app.
The built-in catalog includes Adventure Department 1.0.0. To include more games
on your own site, put their resources in public folders and list them in
`catalog.json`; visitors play them directly from the gallery without importing
files. See [hosting included games](CONTRIBUTING.md#including-games-on-your-site).

The first visit leads with the tutorial and an expanded **Create a new adventure**
section. The browser remembers whether you leave Create expanded or collapsed.
The tutorial can also be collapsed; once you create or import your own games, it
starts collapsed unless you explicitly chose to keep it open.
**Add game** accepts a ZIP or folder below these sections.
Once a game is in your library,
**Your games** appears as a gallery with a direct **Resume** or **Play** action
on each card. Games supplied by the site, imports, creations and local development
fixtures share this gallery. Progress screenshots show the scene captured with the latest safe
autosave. Rename with the pencil beside its name. The three-dot **Game actions** menu beside
**Resume** or **Play** holds Start over (once a checkpoint exists), Check opening (for
unverified imports), Make a copy, Game export, Project and Remove game; **Details**
contains game metadata.

To create an adventure with an AI provider, pick a starting point under
**Create a new adventure**:

| Adventure                                               | Your predicament                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [Knight's Trial](games/knights-trial/SKILL.md)          | Find three impossible treasures before the kingdom runs out of time. |
| [Badge of Millhaven](games/badge-of-millhaven/SKILL.md) | A rookie cop discovers that procedure is easier to follow on paper.  |
| [Mop Jockey](games/mop-jockey/SKILL.md)                 | The station needs a hero. It has sent the cleaner.                   |
| [Polyester Nights](games/polyester-nights/SKILL.md)     | A middle-aged lounge lizard tries his luck for one more night.       |

Each template opens a Markdown brief you can edit. Or choose **Your own
adventure** and describe the hero, setting and trouble. Plain language and
structured [cartridge briefs](games/README.md) both work. Connect your provider in
**Connect AI**, then click **Create adventure**.

The agent builds the opening room, including its artwork, characters and game
logic. When you enter an unwritten room, play pauses while the agent creates it;
you can follow its progress in the activity panel. Rooms you return to run from
their saved resources.

Click the game to type, press **Enter** to submit, and use the arrow keys to walk.
**Home**, **Page Up**, **End** and **Page Down** walk diagonally.
The numeric keypad also walks in all eight directions: **7/9/1/3** diagonally
and **8/4/6/2** straight, regardless of Num Lock. Top-row digits still type numbers;
numeric and text prompts also accept keypad digits normally.
**Controls** shows shortcuts registered by the running game.
On a touchscreen, use the eight-direction pad and **Type** to open your phone's
keyboard. **Enter**, **Esc**, **Space** and **Keys** provide dialog controls,
F1–F10 and Ctrl/Alt letter combinations. The pad follows the game's movement
mode: tap the same direction again to stop, or release in games using held-key
movement. **Settings → Touch controls** also enables the pad on a desktop.
With assistive activation in held-key games, activate an arrow once to walk
and again to stop; leaving the control also releases it.
Menus, inventory and save dialogs use these same keys; game text stays on the
original 40×25 character screen. Native text entry handles commands, answers
and save descriptions.
**✦** opens **Ask** for hints and investigation, or **Remix** to change the game.
Ask leaves the game untouched; Remix applies the finished changes and resumes
play. You can also open an existing AGI game ZIP and remix it.

Sound inspection gives the agent timed events and a visual timeline. Known music
gets a piano roll; effects and unclassified sounds show frequency and noise activity.
Ask for a sound preview to get a local WAV player and download. These clips use
the game's sound timing with approximate synthesis; the current authoring
connections receive the data and image, not the audio.

**Settings → AI provider** is shared by Create, Ask and Remix. Each provider keeps its own
key, model and reasoning effort in this browser, so switching providers preserves
your settings. Saving settings starts no model request.
GPT-6 Astra is the default; choose another OpenAI or Anthropic model and effort
in the same dialog. Selecting a model applies its default effort, which the app
pins explicitly: Sol starts at low based on Genesis cost evaluations, Claude
models at high and other OpenAI models at medium. Every request carries the
chosen effort.
Responses stream live: Ask shows text as it arrives, and authoring shows model
activity and which tool it is preparing. Tools run only after the complete
response has been received and validated.
Tasks start with a $5 estimated budget, adjustable in the same settings dialog.
**Stop** and **Continue** keep work in
progress in the current tab; a budget pause lets you add another allowance.
Stopping an active response discards its unfinished draft; Continue retries
that request with the completed work retained.
Estimates use reported tokens and standard API rates. A response can cross the
threshold, and interrupted requests may still be billed.

Your choice of model and brief affects the artwork, puzzles and continuity.
Expect to playtest and revise. Provider calls are billed to your account; your
key stays in browser storage and relevant game content goes to your chosen
provider during authoring. See [Security](SECURITY.md) for storage and data flow.

## Save and share

**Your games** holds authored adventures, the included tutorial and games opened
from a ZIP or local folder. An opening check identifies the interpreter profile,
captures a local thumbnail and catches invalid boot resources before an import is
stored. It checks the opening only; it does not prove that every room or puzzle is
playable. Importing the same game resources again reuses the library entry, while
project archives and remix copies keep independent authoring histories and save
slots. Renaming a game does not change that identity.
Playing the included tutorial or an imported game needs no provider key.

Choose **Add game → ZIP file** or **Game folder**, or drop one ZIP or game
folder into the opening area. Folder drops work in browsers that expose directory
entries; the folder picker is the fallback. Files are read locally into your
library, so playing does not require keeping the source folder connected.

Completed remixes save in your browser. While playing, the header offers
**Settings**, a three-dot **Game actions** menu (Start over, Game export, Project)
and **Menu**. **Menu** saves before leaving, and **Resume** restores your game and
position.

The game's own Save/Restore actions open an engine-rendered selector with twelve
numbered slots per game. Choose a slot with Up/Down and Enter, name a new save,
then confirm; Esc cancels. Occupied slots require overwrite confirmation.
These saves preserve the AGI binary format and are separate from autosave.
Browser storage supplies the save directory; DOS drive and path dialogs are not
emulated. Clearing browser data removes these local saves.

| Export                         | What travels with it                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Game actions → Game export** | Playable resources and public game metadata.                                                                                                   |
| **Game actions → Project**     | The game plus its authoring conversation, images, source descriptions, world notes, stored game tests, and your saved games and last autosave. |

Both downloads are ZIPs you can reopen with **Add game → ZIP file**. Public game
exports can include a description, author, license and remix provenance in
`GAME.JSON`. They exclude local thumbnails, validation results and conversations. A missing license remains unknown rather than inheriting this
repository's MIT license. A game export starts a fresh authoring conversation; a
project carries its saved context. A game export starts from the beginning; a
project archive also carries your twelve save slots and latest autosave, so your
position moves with it between browsers and computers.

## How it works

The agent authors executable logic, vector pictures, animated sprites,
vocabulary, inventory and sound. These resources run locally in the interpreter.
When drawing pictures or sprites, the model receives rendered previews. It can
inspect game state, look up commands for the active interpreter profile and test
candidate logic, using compiler diagnostics and tool feedback to revise its work.
Picture previews preserve AGI's double-width pixels. Scene probes report actor
scale, control footprints and depth overlap; isolated playtests replay commands
and movement and report wall contacts and observed animation timing. Requested
checkpoints show intermediate composed frames with actor positions, cels and
priorities, so the agent can inspect motion as well as the final scene. These checks
support a repair-and-replay loop, but do not automatically solve arbitrary games
or establish that their art and writing are good.

The tutorial uses original native AGI vector backgrounds with broad color areas
and sparse detail. Its characters use carefully resolved native EGA pixel clusters
and aligned VIEW cels. The lever animates as a separate VIEW and keeps its pulled
position when you return to the room.
Collision and scenery depth are authored separately and tested in the interpreter;
no image service is needed to play.

The engine is framework-free TypeScript with zero runtime dependencies. It reads
AGI v2 and v3 containers and selects interpreter behavior by profile; generated
adventures target AGI 2.936 with standard bytecode. The browser shell adds a GPU
CRT display and an in-game command line. The game resources and engine are open
to inspection.

See [Contributing](CONTRIBUTING.md) for architecture, tests, local game fixtures
and hosting, and [evals](evals/README.md) for authoring evaluations.
The [KQ1 completion proof](CONTRIBUTING.md#kq1-completion-proof) runs a local
walkthrough on a virtual clock and replays it through desktop and phone controls.

## Back to AGI, thirty years later

Around 1996, **Lance Ewing, Peter Kelly, Martin Tillenius** and I worked on
**MEKA**, an early fan-made AGI interpreter. I was **Joakim Möller** then.
We shared discoveries about how Sierra's adventures worked.

Roughly thirty years later, I returned to AGI with OpenAI's
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) in Codex.
On 3 September 2026, Greg Brockman closed an OpenAI briefing with
[“Welcome to the AGI era.”](https://www.axios.com/2026/09/03/openai-astra-gpt-6-agi-brockman)

I wanted to recreate the engine and let an agent change the game while I was
playing it. Now I can ask for an alligator in the moat and the agent changes the
game's binary instructions to put it there. That is still a very cool thing to
be able to do.

**Peter Kelly's [agi-re behavioral specification](https://peterkelly.github.io/agi-re/spec/)
is the foundation of this independent implementation.** It documents the formats,
observable behavior and interpreter versions, and is published under
[CC0](https://github.com/peterkelly/agi-re/blob/main/LICENSE). Thank you, Peter.

Created by Joakim Riedel and published by [Monotio](https://monotio.com).
The engine, authoring tools, browser shell and original project assets use the
[MIT license](LICENSE). Dependencies and imported games retain their own licenses.
The pencil, menu and chevron icons are from [Lucide](https://lucide.dev), with
[ISC and Feather MIT notices](app/public/licenses/lucide.txt) included in the build.
