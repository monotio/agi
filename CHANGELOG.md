# Changelog

Changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Released notes are also available on [GitHub Releases](https://github.com/monotio/agi/releases).

## [1.2.4] - 2026-10-15

### Added

- Game tests are project documents. You can record a test and keep it without
  an AI key, and tests travel with the project. The recorder says "8 game tests
  saved" when it stores them.
- Deleting a room offers "Also delete tests that use this room", checked by
  default. The dialog names the room and says how many tests use it.
- When the Agent finishes with failing tests, its reply names each failing or
  changed test with a reason. A test edit you ask for is proposed for review
  with the old and new values, and it needs your Apply.
- Loading notes appear while a part or the project is still opening.

### Changed

- Tests never block a game edit. A room that tests use can be deleted, and
  those tests fail when run.
- Create with the Agent open is more compact. Parts folds away beside the
  Agent and comes back when the Agent closes.
- Notices stay up while the pointer or focus rests on them.
- The recorder suggests clock checks unchecked.
- Browser test runs are leaner: each test runs at the widths and in the engines
  its rule depends on.

### Fixed

- Returning to Play checks changed art, and Show Room covers pictures and
  views.
- Deleting the room the game is in restarts the game from the beginning and
  says so, instead of offering a restart into the deleted room.
- Progress is kept while only chat, notes or tests are saving.
- Closing the Agent restores your Parts setting at any width.
- A dialog you reopen right away stays open.
- When the game does not answer while the Agent opens, the notice says so and
  suggests reopening the Agent.
- A page makes one GPU stage and reuses it, so loading games no longer leaks a
  WebGL context each time.
- After a lost GPU context, or with no GPU, Play and the message preview show
  the flat picture instead of black.
- AI settings and Connect AI work while the Agent opens.
- Notes you type while a catalog game opens are kept.
- The rename box takes focus, so typed keys rename the symbol.

## [1.2.3] - 2026-10-12

### Fixed

- A change applied in Create shows at once. When it touches what the current
  room uses, the room starts fresh so its entry code runs the new version. Since
  1.2.1 Agent changes waited until the hero left the room. A picture the room
  kept from the room before is not drawn again on entry, so a change to it asks
  for a restart.
- Returning to Play starts its room fresh when Create changed what that room
  uses, and says so. Play, Back, From my game, Restart, a project restart and
  Take control follow the pause the page shows. This also works when the room's
  picture can no longer be rebuilt, such as a VIEW stamped into it losing the
  frame it showed: Play keeps your progress instead of asking for a restart.
- Play saves its progress as soon as the edited game has drawn, and periodic
  saves continue when a busy browser runs the game's timer late.
- An Agent panel opened in Create and kept open into Play pauses the game, as
  opening it in Play does. Play no longer runs on while ignoring the keyboard,
  and returning to Create lets the game run beside the panel again. While the
  Agent holds Play, the play bar offers Resume, which closes the Agent and plays
  on; however the Agent closes, the game takes the keyboard back.
- A room that starts fresh for a change does so even while the game is paused,
  so the change shows and Play's progress is saved; then the game waits.
- In Create, the Agent sits beside the game and the editor instead of over
  their right side, so an applied change is in view. On a phone it still
  covers the screen.
- The "Saved as your own copy" and "started fresh" notices close by themselves
  after a few seconds, and stay up while the pointer rests on them.
- A test recording that sees an applied change restart the room is marked
  changed.
- An applied change to another room offers Show Room N, which takes the hero
  there.
- An Agent change to an imported game's LOGIC shows only the lines it changed,
  instead of the whole file as new. In a VIEW review a cel opens itself in the
  editor, and suggested commands, checkpoint names and figure rows use one
  named icon or the item itself instead of a text button repeated per item.
- A restart notice says in plain words why a picture change needs one.
- The Agent tells players to switch to Create to apply a change, the mode's name
  in the workspace.
- The SOUND and Launches editors no longer repeat their tab's name as a heading.
- An installed older release of a catalog game is named by its release, such as
  "Adventure Department 1.0", and keeps its own card beside the current one.

## [1.2.2] - 2026-10-10

### Added

- Claude Haiku 5.5 is available in AI settings. Spent amounts use its higher
  rate card for prompts over 100K tokens.

### Changed

- Development tools and CI actions are updated to their latest releases.
- MIDI export keeps a sound's own tuning: note names share one offset from A440
  and a pitch bend per note plays each divisor's exact frequency. Sounds with raw
  events export with those events silent and a notice, instead of being refused.

### Fixed

- Edits to games whose directories index unreadable records or whose logics call
  absent logics (King's Quest I and IV, Manhunter 1 and 2, Space Quest II and the
  Amiga Space Quest I) apply when the edit itself is valid. The defects carry
  forward unchanged, the Agent names them in plain words, and only damage an
  edit introduces is refused. A room exit to a missing room that a game already
  had no longer blocks unrelated changes.
- Authoring refusals name the cause and the next step instead of internal terms.
- Conversations in installed games keep their latest answer when the tab closes
  before saving finishes. Answers from a closed tab join the conversation the next
  time the game opens.
- Attaching reference art saves through the open project, so editing and the
  Agent stay available afterwards. The notice for edits another tab or window
  overtook says so in plain words, with Download edits and Discard edits.
- A naming request that fails partway leaves every name unreserved, and a refused
  disk image gives back its share of the import limit.
- The Agent reads a failed step before it can finish, so it repairs the change
  instead of ending the task without it. A task that stops without a change or a
  reply says so and suggests asking again, and a message whose usage the provider
  never reported says Usage not reported.

## [1.2.1] - 2026-10-10

### Changed

- Play and Create share one agent conversation, composer and task controls.
  Chats continue between modes and into editable copies of installed games.
- Native result previews remain available after Apply and reload, with older
  versions identified before opening the current resource. Phone previews return
  to the conversation with Back to chat.
- Agent settings and activity details are collapsed, with compact spending and
  shorter replies. Follow-up instructions join at the next completed tool batch.

### Fixed

- Ask inspects native resources without preparing or validating an edit candidate.
- An unreadable unused resource or dictionary does not stop other inspection tools.
- Each request captures its current interpreter profile, runtime and attached references.
- Switching to Create waits for the conversation transfer and preserves unfinished drafts.
- Opening Agent focuses its composer on every visit and preserves a newer control's focus.
- Closing Agent during startup resumes the game; delayed opening cannot reopen it.
- Live inspection continues after the task's own accepted edits.
- Captured native and draft resources retain their own vocabulary and rendering
  dependencies. Native inspections in Create use the shared result widgets.
- Help keeps the conversation and unfinished draft open when switching to Create.
- Failed game opening retains the saved project and offers Reload. Closing setup
  retires its pending opening; a blank agent's first room follows its current stage.
- The first conversation save preserves Create admission when it opens an editable copy.
- AI settings wait for conversation startup and retain the previous settings if
  browser storage rejects the update.
- Interrupted questions preserve pending edit reviews. Conversation save failures keep
  completed answers visible and offer Retry save without another provider request.
- Accepted resource changes keep saved source claims consistent with playable
  bytes. Opening and saving an affected sound project repairs verified stale
  claims so its Project download can succeed.
- Updated vulnerable shell-quote, source-map-js and DOMPurify dependencies, and the
  optional eval dependency tree. The app dependency audit is clear; the optional
  eval tree still reports high advisories in basic-ftp and node-forge.

## [1.2.0] - 2026-10-07

### Added

- Bundled Geist and Geist Mono fonts for consistent UI text and code.
- Create workspace with a parts list, editors beside the running game, and Focus.
- Autosaved editor drafts with Update and restart or Update and keep playing,
  shared Undo and Redo, and named History checkpoints.
- Room Launches with named hero, flag, variable and inventory starting setups.
- AI room-generation switch in Home and Create Details, on for Create with AI
  and off for imported games and local templates.
- LOGIC code intelligence, Problems, guided actions and a step debugger.
- Game state names and Rename across the game, with inline printed text.
- Answer a sentence and Teach beside missed sentences, with a game message preview.
- PICTURE image tracing and Add depth; VIEW cels from an image.
- WORDS meanings, sentence testing and missed-command collection.
- SOUND grid, tracker, presets, MIDI and VGM import, and MIDI export.
- Agent Review and Auto-approve across resource types, task chats and optional
  image generation with Sierra EGA style and a shared task budget.
- Starter, Boilerplate and Blank projects, plus Create with AI from a brief.
- LOGIC language server shared with the LOGIC editor: project-aware diagnostics,
  navigation and rename across the game, references for numbered operands,
  colouring, folding, quick fixes and an `agi-language-server` command for LSP
  editors. Project ZIPs and AGI game folders open directly.
- Documentation index, a first-game tutorial, editor setup, LOGIC reference and
  extension guides; issue forms, support and security policies.
- Room-first authoring: + on Rooms adds an empty named room (blank LOGIC and
  white PICTURE) with no form, the first room on a blank game brings a minimal
  readable Start-up, and room names edit in place. Add ▾ in the editor's action
  row places a hero, a door, a sentence answer or a sound in the room; rare
  actions such as Change number… and Format document sit in ⋯. SHARED LOGIC +
  offers ready parts: Menus and Save/Restore, game over and a score screen.
- Parts lists every PICTURE, VIEW, SOUND and LOGIC by type with Rename, Change
  number…, Find references and Delete…. Deleting is a draft change: code is never
  rewritten, and remaining references show in Problems until changed.
- Game state lists names in number order; Built-in holds the interpreter's
  reserved flags and variables with plain meanings and names such as
  `current_room` and `ego_in_water`, which LOGIC can use directly. Clicking a name
  reveals it with its live value and where it is Read and Changed.
- LOGIC completion offers what each parameter takes (SOUNDs for `sound(`,
  pictures for `load.pic(`); an unknown flag or variable offers to create it in
  Game state. Format document, indentation while typing, and an implicit final
  `return;`. Every problem is marked at its place in the code.
- One run control in Create follows the room being edited and applies the
  selected Launch; breakpoints are always armed, with Disable breakpoints. While
  paused, hovers show and change flag and variable values, and faint values sit
  beside the paused line.
- OBJECTS and Launch item locations name rooms, "Carried by the player" and
  "Nowhere" instead of raw numbers.

### Changed

- Create docks are replaced by the parts list, Map, debugger and agent panel.
- Image Generate starts drawing directly from your description. Agent requests
  and images share an actual-spend budget; a request that crosses it finishes
  before pausing for Continue or Stop.
- Upgrading from 1.1 loads existing browser progress automatically.
- New games start their random sequence like the original interpreter; seeded
  Launches, tests and recordings keep their exact sequence.
- One `npm ci` at the repository root installs everything (npm workspaces).
- Home, Play and Create load the engine, editor families and agent by activity.
- CRT rendering uses beams and phosphors in Play; editors show the crisp image.
- Adventure Department has refreshed animation and workspace lessons. Earlier
  tutorial progress stays available with its original release.
- Project archives retain version 1 with optional workspace, History and chat
  data. Playback recordings use version 2 for debugger and project events;
  released version-1 recordings remain readable. Recorded game tests write
  tests.v2 and preserve RNG-version-1 semantics when reading or editing tests.v1.
- Provider evaluations use the app clients and measure conversation caching.

### Fixed

- A sentence cut short by a debugger stop no longer appears in WORDS Players tried.
- Replacing the game run ends its Playtest recording, including History and replay changes.
- Projects with unsupported formats stay visible with recovery actions, including
  when opened through a game link. Download is available for records it can preserve.
- Saving… shows while a change is pending and Saved confirms the project reached
  browser storage. Keep the tab open until Saved; unsaved edits may be lost on close.
  Download unsaved edits keeps current buffers during save failures. Accepted
  captures retain recovery after interrupted acknowledgement. A failed save keeps Retry.
- Download game can produce a backup after a failed save or a change in another tab,
  with a report of its limitations. Stale and removed tabs are read-only with Download, Reload and Exit.
- Accepted or legacy recovery captures retain Download recovery data and Discard pending edits.
- Earlier play positions stay intact and offer Start the latest version.
- Name this version names what is on screen, including source with errors.
- Opening a menu while the game screen loads keeps the menu open.

## [1.1.0]

See the [1.1.0 release notes](https://github.com/monotio/agi/releases/tag/v1.1.0).

## [1.0.0]

See the [1.0.0 release notes](https://github.com/monotio/agi/releases/tag/v1.0.0).

[1.2.3]: https://github.com/monotio/agi/releases/tag/v1.2.3
[1.2.2]: https://github.com/monotio/agi/releases/tag/v1.2.2
[1.2.1]: https://github.com/monotio/agi/releases/tag/v1.2.1
[1.2.0]: https://github.com/monotio/agi/releases/tag/v1.2.0
[1.1.0]: https://github.com/monotio/agi/releases/tag/v1.1.0
[1.0.0]: https://github.com/monotio/agi/releases/tag/v1.0.0
