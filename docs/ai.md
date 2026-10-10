# Building with AI

AGI IS HERE can connect to an OpenAI or Anthropic model as a co-author. The agent plans a world,
builds rooms while you play, answers questions and edits any part of a game with you. Everything it
writes is a standard AGI resource.

## Connect a provider

Add an OpenAI or Anthropic API key in AI settings. The app talks to your provider directly from the
browser. The key is saved in browser storage and sent only to the provider you choose, along with
the game content each request needs. [Security](../SECURITY.md) covers storage and data flow.

Requests are billed to your account. Each task starts with a $5 budget that you can change, and one
budget covers agent requests and generated images. The app shows actual spending as your provider
reports it, for example **$0.14 / $5 spent**.

The request in flight finishes before the agent pauses at the budget, so spending can pass it.
**Continue** adds another task budget; **Stop** ends the task and keeps your work in this tab. For
models whose prices the app does not list, check your provider's usage page.

## Create with AI

**Make a new game → Create with AI** offers themed briefs or your own hero, setting and trouble. The
agent builds the opening from editable Boilerplate.

| Template                                                   | Your predicament                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [Knight's Trial](../games/knights-trial/SKILL.md)          | Find three impossible treasures before the kingdom runs out of time. |
| [Badge of Millhaven](../games/badge-of-millhaven/SKILL.md) | A rookie cop discovers that procedure is easier to follow on paper.  |
| [Mop Jockey](../games/mop-jockey/SKILL.md)                 | The station needs a hero. It has sent the cleaner.                   |
| [Polyester Nights](../games/polyester-nights/SKILL.md)     | A middle-aged lounge lizard tries his luck for one more night.       |

[Adventure briefs](../games/README.md) explains how to write your own.

## Rooms that appear as you walk

The agent plans the world and builds the opening room: artwork, characters and game logic. When you
walk into a room that is still unbuilt, play pauses while the agent writes it.

![Typing EAST pauses Play while the agent writes the next room, then the hero walks in](media/clip-room-generation.gif)

_The agent's reply in this clip is recorded; it writes the tutorial's own Sprite Lab picture.
Checking, compiling and entering the room are the app's own._

The setting **AI makes new rooms when the hero walks into one** controls this. It starts on for
Create with AI and off for imported games and local templates. Change it in **Details…**, from
Home's Game actions or Create's game menu.

**World map** renames rooms, edits their briefs and pins notes the agent reads when it builds that
part of the world.

## Working with the agent

The same conversation follows you between Play and Create.

- In **Play**, **Agent** gives hints and answers questions. It reads the game and leaves it
  untouched.
- In **Create**, open **Agent** (⌘I) over any editor to ask questions or change resources together.
- Previews of pictures, animation frames, sounds and source appear beside the conversation. A
  coordinated change applies as one History commit, or turn on **Auto-approve** for the current game
  session.
- Start task chats, or resume earlier ones. The game's **Notes** give every chat its style and
  rules. Private project backups keep the chats.
- Attach reference images for rooms and actors. The agent gets a thumbnail of each and looks closer
  at the parts it needs.
- Preview the game's sounds as WAV clips.

![Agent review with code differences, PICTURE previews and Approve and Reject controls](media/agent-review-1.2.png)

Play conversations save alongside the game without editing its resources. If a save fails, the
answer stays visible and **Retry save** retries storage without another AI request. Result previews
stay available in earlier messages, and older results show the version they captured.

Long conversations compact their request context and keep the full transcript. The provider's prompt
cache reuses earlier context at its lower cache-read price.

## What the agent makes

The agent writes logic, vector pictures, animated actors, vocabulary, inventory and sound. The
heroes below walk because the agent drew each frame of each direction, then compiled them into the
same kind of view file Sierra's artists made.

![The heroes of the Knight's Trial openings walking right and towards the viewer](media/genesis-heroes.png)

An AGI room is more than its picture. Behind it the game keeps a second, invisible layer: how far
away each part of the scene is, and where the hero may walk. The agent paints that layer too, so the
knight walks around the notice board and the chest, stops at the water's edge and crosses by the
drawbridge.

![A castle gate as the player sees it, beside the walkable ground, barriers and horizon the agent painted into it](media/genesis-depth.png)

The agent checks its work with rendered previews, compiler messages and its own playtests. It can
still get art, puzzles or writing wrong, so play the result and ask for revisions. What it writes
comes from your provider's model: review the story, puzzles and artwork before sharing a game,
especially with children.

The [Genesis benchmark](../evals/benchmarks/genesis/1.0.0/README.md) gives five models the same
briefs and publishes every run, its cost and the game it made.
