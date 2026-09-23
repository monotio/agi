# AGI IS HERE

Remember typing LOOK AT CASTLE? AGI IS HERE brings back Sierra's adventure
engine the way it ran in the eighties, and lets an AI co-author new rooms while
you play.

Play the AGI classics in your browser from your own copies, or describe a new
adventure and play it while an agent builds the rooms around you. Ask for
changes mid-game: give the guard a different personality, add a puzzle, or turn
the courtyard into a swamp. Everything the agent makes is a real
[Adventure Game Interpreter](https://en.wikipedia.org/wiki/Adventure_Game_Interpreter)
game that you can inspect, download and play again.

![Adventure Department: paint a mural while playing in the browser](docs/media/tutorial-gallery.png)

## Play

Open [agi.monotio.com](https://agi.monotio.com/) and click **Play now** on
**Adventure Department**, an original three-room tutorial that teaches how AGI
adventures work: repair a picture, wake a sprite and fix a clerk's priority. No
account, API key or original Sierra files needed.

- **Your own Sierra games.** **Add game** takes a ZIP or a game folder. The files
  are read into your browser's storage; nothing is uploaded. The app identifies
  the edition, picks the matching interpreter profile and checks that the game
  opens.
- **Watch a playthrough.** Verified releases come with a recorded completion
  that replays on the real interpreter, keystroke by keystroke, on the game's own
  clock. Pause it, scrub the timeline, or **Take control** at any moment.
- **Rewind.** Every session records itself. Scrub back to any earlier moment
  and resume from there.
- **Help** in the app covers controls (keyboard, keypad and an on-screen pad for
  phones), the world map, hints and walkthroughs.

### Supported games

These editions are verified in this interpreter. PC editions are checked with
full recorded walkthroughs; the Amiga and Apple IIgs editions boot into their
first room under their own interpreters.

| Game                       | PC (DOS) | Amiga | Apple IIgs | Recorded walkthrough |
| -------------------------- | :------: | :---: | :--------: | -------------------- |
| King's Quest I             |   Yes    |       |            | Full game            |
| King's Quest II            |   Yes    |  Yes  |            | Full game            |
| King's Quest III           |   Yes    |       |            | Full game            |
| King's Quest IV            |   Yes    |       |            | Full game            |
| Space Quest I              |   Yes    |  Yes  |            | Full game            |
| Space Quest II             |   Yes    |  Yes  |    Yes     | Full game            |
| Police Quest I             |   Yes    |  Yes  |            | Full game            |
| Leisure Suit Larry I       |   Yes    |       |            | Full game            |
| The Black Cauldron         |   Yes    |       |            | Full game            |
| Mixed-Up Mother Goose      |   Yes    |       |            | Full game            |
| Donald Duck's Playground   |   Yes    |       |            | One chapter          |
| Gold Rush!                 |   Yes    |  Yes  |            | Full game            |
| Manhunter: New York        |   Yes    |       |            | Full game            |
| Manhunter 2: San Francisco |   Yes    |  Yes  |            | Full game            |
| Sierra AGI demo pack 4     |   Yes    |       |            |                      |

Walkthroughs are recorded on the PC editions and bound to the exact release
they were captured on; the
[KQ1 completion proof](docs/testing.md#kq1-completion-proof) shows how one is
made and checked. The Amiga and IIgs editions play their music through emulated
Amiga Paula and approximate Apple IIgs sound, and the engine reproduces their
mouse click-to-walk. PC editions choose between the Tandy sound chip and the PC
speaker under **Settings → Advanced… → Sound chip**.
Fan-made AGI games run too; if the app cannot identify the interpreter, it asks
which profile to use. [Testing](docs/testing.md#testing-compatibility) lists
the exact editions and builds.

Commercial games are not included. Bring your own copies; they stay in your
browser.

## Create

Pick one of the adventure templates or describe your own hero, setting and
trouble, connect an OpenAI or Anthropic API key, and click **Create
adventure**.

| Template                                                | Your predicament                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [Knight's Trial](games/knights-trial/SKILL.md)          | Find three impossible treasures before the kingdom runs out of time. |
| [Badge of Millhaven](games/badge-of-millhaven/SKILL.md) | A rookie cop discovers that procedure is easier to follow on paper.  |
| [Mop Jockey](games/mop-jockey/SKILL.md)                 | The station needs a hero. It has sent the cleaner.                   |
| [Polyester Nights](games/polyester-nights/SKILL.md)     | A middle-aged lounge lizard tries his luck for one more night.       |

The agent plans the world and builds the opening room: artwork, characters and
game logic. When you walk into a room that does not exist yet, play pauses while
the agent writes it. Along the way you can:

- plan on the world map: rename rooms, edit their briefs and pin notes the agent
  reads when it builds that part of the world;
- use **Ask** for hints and questions that leave the game untouched, or
  **Remix** to change it, including any game you imported;
- attach reference images for rooms and character sprites;
- preview the game's sounds as WAV clips.

The agent writes logic, vector pictures, animated views, vocabulary, inventory
and sound as standard AGI resources. It checks its own work with rendered
previews, compiler diagnostics and isolated playtests. It can still get art,
puzzles or writing wrong, so expect to playtest and ask for revisions.

**Bring your own key, no server.** The app talks to your provider directly from
the browser. Your key stays in browser storage, and relevant game content goes
to the provider you choose, billed to your account. Each task starts with a $5
estimated budget that you can change. See [Security](SECURITY.md) for storage
and data flow, and [adventure briefs](games/README.md) for writing your own.

## Save and share

Games, saves and history live in your browser. The game's own Save and Restore
use the authentic AGI save format, with twelve named slots per game, and the
app autosaves so **Resume** picks up where you left off.

| Game menu          | What you get                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Export game…**   | A ZIP of the playable resources and public metadata: description, author, license and remix provenance.                                                    |
| **Download game…** | A ZIP of the game plus its authoring conversation, images, source descriptions, world notes, stored tests, map, session history, saved games and autosave. |

Either ZIP opens again with **Add game**, in any browser. A game without a
declared license keeps an unknown license: exports never inherit this
repository's MIT license.

## How it works

The engine is a framework-free TypeScript AGI interpreter with zero runtime
dependencies. It reads AGI v2 and v3 game files (including the Amiga and Apple
IIgs layouts) and selects build-specific behavior through interpreter profiles.
Games created in the app are standard AGI 2.936 bytecode with no custom opcodes.
The engine runs in a Web Worker; the Vue shell adds a GPU-rendered CRT display
and an in-game command line, while game text stays on the original 40×25
character screen.

The engine is an independent implementation of Peter Kelly's CC0
[agi-re behavioral specification](https://peterkelly.github.io/agi-re/spec/).
Where games need more than the specification says, the original Sierra
interpreters are the reference. [Interpreter compatibility](docs/fidelity.md)
walks through what they do, from the random-number generator to the Amiga sound
driver, with the evidence and regression tests behind each finding.

## Documentation

| Document                                                | For                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| [Interpreter compatibility](docs/fidelity.md)           | How the original interpreters behave and how the engine matches |
| [Contributing](CONTRIBUTING.md)                         | Development setup, checks and pull requests                     |
| [Testing](docs/testing.md)                              | Game fixtures, walkthrough proofs and compatibility checks      |
| [Hosting](docs/hosting.md#including-games-on-your-site) | Running your own copy and adding games to its catalog           |
| [Evals](evals/README.md)                                | Measuring authoring quality                                     |
| [Media gallery](docs/media/README.md)                   | Screenshots of the agent's tools and the tutorial               |
| [Security](SECURITY.md)                                 | Keys, storage and data flow                                     |

To run it locally, install Node.js 22.22 or newer and run:

```bash
npm ci
npm --prefix app ci
npm run dev
```

Then open `http://localhost:5199/`. The website needs a connection to load; it
is not yet an installable offline app. Exported games play offline in any
compatible interpreter.

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

## License

Created by Joakim Riedel and published by [Monotio](https://monotio.com). The
engine, authoring tools, browser shell and original project assets, including
the Adventure Department tutorial, use the [MIT license](LICENSE).
Dependencies and imported games keep their own licenses; no commercial game
assets are part of this repository. The pencil, menu and chevron icons are from
[Lucide](https://lucide.dev), with
[ISC and Feather MIT notices](app/public/licenses/lucide.txt) included in the
build.
