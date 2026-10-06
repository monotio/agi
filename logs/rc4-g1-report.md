# rc4-g1 — RoomStudio debris and window fit

Verdict: green — full Linux CI run
https://github.com/monotio/agi/actions/runs/37479513513 passed all jobs
(static checks, unit tests, build, 10 chromium shards, 3 webkit-desktop
shards, webkit phone, timing budgets, storage benchmark) on the head
commit. Three commits on `lane/rc4-g1` off `rc/1.2-rc.4` (7ef1e74): Room Studio
is now workspace-native only — the standalone top bar, Keep/exit chain,
local assist panel, focus mode and every `embedded` branch are gone, and
the editor grid scrolls instead of clipping its controls. Deleted
`StudioTopBar.vue` and `StudioLockChip.vue`; the shared assist modules
stay for Sprite Studio. Gates: app+root typecheck, eslint, prettier,
knip, lint:ast, lint:deps, lint:tokens, build+check:bundle, over 100
affected e2e tests on one worker, e2e:perf — all pass under Node
22.23.3.

## A — Standalone-only branches removed

- `RoomStudio.vue` dropped `embedded`, `subtitle`, `baseAuthoring`, `keep`
  and the `close`/`reopen` emits. The embedded layout is unconditional:
  meta bar, options bar, palette+scrubber row, side panel (Items/Inspector),
  status bar. Deleted the standalone `StudioTopBar`, the second
  standalone scrubber, the `#assist` slot, the standalone status spans and
  the duplicate AGI span, `StudioKeepDialog`, `StudioSmallScreen`, the
  standalone `playHere` confirmation branch and `--picture-zoom`.
- `StudioTopBar.vue` and `StudioLockChip.vue` deleted (Room Studio's only
  consumers). `StudioKeepDialog`, `StudioSmallScreen`, `useStudioKeep`,
  `useStudioExit`, `useStudioCalm`, `StudioAssistPanel`,
  `StudioAssistCompare`, `useStudioAssist` remain: Sprite Studio uses them.
- `useStudioViewport` gets `fluidPicture = true` unconditionally.
- `changedCells` keeps driving the draft mask (`running-bytes` vs shown),
  now unconditional — the workspace shows the diff mask too.
- Exports orphaned by the deletions removed so knip stays clean:
  `labelList`, `subtitleExtra`, `byteMeter`/`ByteMeter`/`BYTES_APPROACH`,
  `HOLD_TEXT`; `MAX_PAYLOAD_BYTES` in `src/agent/pictureTools.ts` made
  module-private (one word in a G5 file — the export only fed the deleted
  top bar's meter).

## B — Dead save chain

- `keeper`, `useStudioKeep`, `useStudioExit`, `commitPicture`/`commitRoom`,
  `subject`/`notesOnly`/`changeTotal`, the close/reopen/recover path and
  the keep dialog wiring are gone. `frozen()` is now just "view only when
  there is no revision to write to" (`readOnly || kept.revision ===
undefined`, where `kept` is the draft baseline, not the dialog).
- Edits still emit `edit`/`room-edit`; the workspace writes back as before.
  `harness.ts` now models that contract: each `edit` emission becomes the
  picture's authored source (recorded in `studioHarness.edits`) and
  `closes`/`reopens`/`kept` plumbing is gone, so G6's harness work starts
  from the workspace contract.

## C — One Focus, one agent, one key sheet

- "Hide side panel" (⌘\\) and `useStudioCalm.focus` removed; the workspace
  Focus button is the only hider. `studioKeys.ts` has no `focusMode`
  action; the key sheet's focus row is gone from `studioHelp.ts`.
  `useStudioCalm` stays for Sprite Studio.
- The side panel keeps its own Items/Inspector segmented control (and the
  Walk lens's existing auto-switch to Inspector).
- The selection bar's Agent action is gone (owner decision #26); the agent
  stays reachable by `/` and the canvas menu's "Tell the agent about the
  selection", both emitting `agent-ask` → `openAgent()` (workspace agent).
  `agent-context` still follows the selection.
- `StudioSelectionBar` lost `askable`/`ask`; with no disablable action
  left, its `disabled` field was removed (ast-grep `disabled-needs-reason`
  flagged the leftover binding — fail-first evidence for the cleanup).
- `StudioStatusNotice.banner` is optional (Room Studio passes notice only);
  recovery events remain for Sprite Studio.

## K/#20 — The editor always fits the window

Measured defect (before): the status row was a fixed `28px` while its
controls are 40px (44px touch), clipping them every size; at short editor
heights the fixed rows overflowed `.studio` and the palette row and rail
tools were pushed off the bottom (the reported "panel ending past the
window" symptom).

Fix, in `RoomStudio.vue` CSS:

- Status row `28px` → `minmax(28px, auto)`; it grows to fit its controls.
- `.studio` gets `overflow-y: auto`; the status bar is `position: sticky;
bottom: 0` so it stays visible while the studio scrolls.
- The canvas row is `minmax(160px, 1fr)`: the picture shrinks first, then
  the studio scrolls. The floor matters because the side panel rides the
  canvas row — a `0` floor let a 308px-tall studio squeeze the Scene
  list's tree to 14px (CI shard 5/10: `picture storyboard 1063` expected
  ≥30px). With the floor the tree keeps ≥1 row and the studio scrolls
  ~17px, exactly like the phone layout's `minmax(180px, 1fr)` already did.
- The ≤600px phone layout keeps flexible rows
  (`minmax(180px,1fr)` canvas, `minmax(240px,0.8fr)` side panel,
  `minmax(28px,auto)` status) with the side panel below the palette.

Verified at 1440×900, 1063×815 side-by-side, 1063×815 stacked and
390×844: zero controls outside the studio box (`clipped: []` sweep over
every button/radio/input/scrubber); the studio scrolls ~17px stacked and
at phone size, with the sticky status bar always in view. Screenshots:
`logs/rc4-g1-shots/g1-before-*.png` (earlier session) vs
`g1-after-{1440x900,1063x815,390x844}.png` and
`g1-after-stacked-1063x815.png`.

Follow-on fix found by fail-first: at 900×480 in the Walk lens the rail
needed 13 chevron clicks but the spec's budget is 12 —
`StudioToolRail.page()` hardcoded a 48px tool while short windows render
32px tools. The step now measures the real tool height ("a column's height
less one tool"): 6/7/9 clicks per lens. Shared component; Sprite Studio
gets the same correction.

## Tests

- `studio-readonly.spec.ts` ported to the write-back contract: Escape
  leaves Studio open (the tab's × closes it), the rebuilt-source test
  asserts draft write-back instead of standalone Keep, and the lens test
  switches the side panel back to Items after the Walk lens docks
  Inspector (pre-existing workspace behavior the old standalone ignored).
- `studio-calm.spec.ts` asserts workspace Focus (hides the game, grows the
  canvas area) and the agent path via the canvas menu instead of the
  removed toolbar button.
- `workspace-parity.spec.ts` Focus assertion compares canvas area, not
  width, since 1063px can stack.
- `studio-keys.test.ts` pins `⌘\`/Ctrl+`\` as "not studio shortcuts".
- Affected specs run: studio-readonly(10), studio-probe(5), studio-calm,
  workspace-parity(33), studio-edit, studio-group, picture-palette,
  studio-narrow(4), studio-bars, workspace(13), studio-key-focus-review,
  studio-access, studio-truncation, studio-select-move, workspace-stage,
  studio-explain, studio-overlays, studio-spill, studio-tools,
  studio-rail, studio-frame-keyboard-review,
  studio-sibling-retention-review — over 100 browser tests, all green,
  plus e2e:perf (10) and unit studio-keys + studio-assist (29).

## Notes for the integrator

- `src/agent/pictureTools.ts`: `export` dropped from `MAX_PAYLOAD_BYTES`
  (G5 file; one word, same move rc4-g2 made for the VIEW editor's helpers).
- Bundle budget heads-up unchanged: startup JS/workers sit slightly over
  their warn budgets (within the 10% ceiling) — pre-existing on base.
- The deleted `StudioLockChip.vue` doc reference in `studioAssistText.ts`
  is a stale comment mention only.
