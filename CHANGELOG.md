# Changelog

Changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Released notes are also available on [GitHub Releases](https://github.com/monotio/agi/releases).

## [1.2.0] - Unreleased

### Added

- Bundled Geist and Geist Mono fonts for consistent UI text and code.
- Create workspace with a parts list, editors beside the running game, and Focus.
- Live edits, autosave, shared Undo and Redo, and named History checkpoints.
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

### Changed

- Create docks are replaced by the parts list, Map, debugger and agent panel.
- Image Generate starts drawing directly from your description.
- Home, Play and Create load the engine, editor families and agent by activity.
- CRT rendering uses beams and phosphors in Play; editors show the crisp image.
- Adventure Department has refreshed animation and workspace lessons. Earlier
  tutorial progress stays available with its original release.
- Project archives retain version 1 with optional workspace, History and chat
  data. Playback recordings use version 2 for debugger and project events;
  released version-1 recordings remain readable.
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

[1.2.0]: https://github.com/monotio/agi/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/monotio/agi/releases/tag/v1.1.0
[1.0.0]: https://github.com/monotio/agi/releases/tag/v1.0.0
