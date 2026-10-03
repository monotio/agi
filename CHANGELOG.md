# Changelog

Changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Released notes are also available on [GitHub Releases](https://github.com/monotio/agi/releases).

## [1.2.0] - Unreleased

### Added

- Bundled Geist and Geist Mono fonts for consistent UI text and code.
- Create workspace with a parts list, editors beside the running game, and Focus.
- Live edits, autosave, shared Undo and Redo, and named History checkpoints.
- LOGIC code intelligence, Problems, guided actions and a step debugger.
- PICTURE image tracing and Add depth; VIEW cels from an image.
- WORDS meanings, sentence testing and missed-command collection.
- SOUND grid, tracker, presets, MIDI and VGM import, and MIDI export.
- Agent Review and Auto-approve across resource types, task chats and optional
  image generation with a cost preview.
- Starter, Boilerplate and Blank projects, plus Create with AI from a brief.
- LOGIC language server shared with the LOGIC editor: project-aware diagnostics,
  navigation and rename across the game, references for numbered operands,
  colouring, folding, quick fixes and an `agi-language-server` command for LSP
  editors. Project ZIPs and AGI game folders open directly.
- Documentation index, a first-game tutorial, editor setup, LOGIC reference and
  extension guides; issue forms, support and security policies.

### Changed

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
  browser storage. Pending editor changes can recover after closing when browser
  recovery storage is available. A failed save keeps the workspace open with Retry.
- Download game can produce a backup after a failed save or a change in another tab,
  with a report of its limitations. Stale and removed tabs can leave without saving.
- Pending edits from an earlier project version stay available as a recovery download.
- Name this version names what is on screen, including source with errors.
- Opening a menu while the game screen loads keeps the menu open.

## [1.1.0]

See the [1.1.0 release notes](https://github.com/monotio/agi/releases/tag/v1.1.0).

## [1.0.0]

See the [1.0.0 release notes](https://github.com/monotio/agi/releases/tag/v1.0.0).

[1.2.0]: https://github.com/monotio/agi/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/monotio/agi/releases/tag/v1.1.0
[1.0.0]: https://github.com/monotio/agi/releases/tag/v1.0.0
