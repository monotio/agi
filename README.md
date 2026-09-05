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

With Node.js 22.6 or newer, run:

```bash
npm ci
npm --prefix app ci
npm run dev
```

Open `http://localhost:5199/` and pick a starting point:

| Adventure                                               | Your predicament                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [Knight's Trial](games/knights-trial/SKILL.md)          | Find three impossible treasures before the kingdom runs out of time. |
| [Badge of Millhaven](games/badge-of-millhaven/SKILL.md) | A rookie cop discovers that procedure is easier to follow on paper.  |
| [Mop Jockey](games/mop-jockey/SKILL.md)                 | The station needs a hero. It has sent the cleaner.                   |
| [Polyester Nights](games/polyester-nights/SKILL.md)     | A middle-aged lounge lizard tries his luck for one more night.       |

Each template opens a Markdown brief you can edit. Or choose **Your own
adventure** and describe the hero, setting and trouble. Plain language and
structured [cartridge briefs](games/README.md) both work. Connect your provider
and click **Create adventure**.

The agent builds the opening room, including its artwork, characters and game
logic. When you enter an unwritten room, play pauses while the agent creates it;
you can follow its progress in the activity panel. Rooms you return to run from
their saved resources.

Click the game to type, press **Enter** to submit, and use the arrow keys to walk.
**Game controls** shows shortcuts registered by the running game.
**✦** opens **Ask** for hints and investigation, or **Remix** to change the game.
Ask leaves the game untouched; Remix applies the finished changes and resumes
play. You can also open an existing AGI game ZIP and remix it.

GPT-6 Astra is the default; you can choose another OpenAI or Anthropic model.
Responses stream live: Ask shows text as it arrives, and authoring shows model
activity and which tool it is preparing. Tools run only after the complete
response has been received and validated.
Tasks start with a $5 estimated budget. **Stop** and **Continue** keep work in
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

**Your games** holds your saved adventures and lets you rename, download or
open them. Completed remixes save in your browser. **Menu** saves before leaving,
and **Resume game** restores your game and position.

| Download         | What travels with it                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| **Export game**  | Playable resources and public game metadata.                                           |
| **Save project** | The game plus its authoring conversation, images, source descriptions and world notes. |

Both downloads are ZIPs you can reopen with **Open ZIP**. A game export starts a
fresh authoring conversation; a project carries its saved context. Downloaded
games start from the beginning. Your saved position stays in the browser.

## How it works

The agent authors executable logic, vector pictures, animated sprites,
vocabulary, inventory and sound. These resources run locally in the interpreter.
When drawing pictures or sprites, the model receives rendered previews. It can
inspect game state, look up commands for the active interpreter profile and test
candidate logic, using compiler diagnostics and tool feedback to revise its work.

The engine is framework-free TypeScript with zero runtime dependencies. It reads
AGI v2 and v3 containers and selects interpreter behavior by profile; generated
adventures target AGI 2.936 with standard bytecode. The browser shell adds a GPU
CRT display and an in-game command line. The game resources and engine are open
to inspection.

See [Contributing](CONTRIBUTING.md) for architecture, tests, local game fixtures
and hosting, and [evals](evals/README.md) for authoring evaluations.

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
