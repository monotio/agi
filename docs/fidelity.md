# Interpreter compatibility

The engine implements Peter Kelly's
[AGI behavioral specification](https://peterkelly.github.io/agi-re/spec/). These notes describe
behavior clarified by original interpreter binaries or game resources, with regression tests and
evidence for maintaining compatibility. Code comments refer to the section identifiers below.

## Profile selection

`detectProfile` selects a profile from the interpreter version string and the explicit
equivalent-build table in [profile.ts](../src/runtime/profile.ts). When the version is missing or
unrecognized, container detection selects the default v2 or v3 profile. Callers can supply a profile
ID or a complete `AgiProfile` override.

Build-specific room mappings use the override's `roomAliases` field. The
[3.002.149 specification](https://peterkelly.github.io/agi-re/spec/version_profiles.html) describes
an immediate-room mapping from 126–128 to 73 in one build. Automatic profile selection preserves
room numbers; the explicit mapping is covered by [profile.test.ts](../test/profile.test.ts).

## Inspecting an interpreter

Offsets in the compatibility notes are load-module offsets.

v3 `AGI` executables disassemble directly:

```bash
ndisasm -b 16 -e 0x200 games/<slug>/AGI > /tmp/<slug>.asm
```

v2 `AGI` executables are scrambled by the loader; undo it first with `scripts/descramble-agi.ts`,
then disassemble the same way:

```bash
node --experimental-strip-types scripts/descramble-agi.ts games/<slug> /tmp/<slug>-agi.bin
ndisasm -b 16 -e 0x200 /tmp/<slug>-agi.bin > /tmp/<slug>.asm
```

The v2 scrambling XORs the image per 128-byte block with the 128-byte key at the loader's offset
0x41; between blocks each key byte rotates right, the low bit chaining forward from byte 0 into the
next byte's high bit (byte 0's own low bit folds back into its high bit; byte 127's low bit falls
off). The loader is `SIERRA.COM` on most installations, or a game-specific `*.COM`. Decoded binaries
and disassemblies are Sierra data: keep them with the local fixtures, never committed.

## Compatibility notes

### Completion animation updates

`end.of.loop` and `reverse.loop` select the updating object partition as well as
starting cel cycling. Calling either after `stop.update` resumes the animation;
the completion flag must be set when the terminal cel is reached. The normal
startup delay and cycle cadence still apply. Without this update selection, a
script waiting on a previously stopped object can stall indefinitely.

The [cel-cycling specification](https://peterkelly.github.io/agi-re/spec/object_behavior.html#cel-cycling)
defines the delay and completion behavior. Original interpreter handlers also
restore update selection; this is distinct from invoking all refresh effects of
`start.update`.

Tests: [object-cadence.test.ts](../test/object-cadence.test.ts) covers both directions
with original synthetic resources. The Mother Goose introduction in
[openings.test.ts](../test/openings.test.ts) verifies that the
waiting script reaches player control; [fixture-openings.spec.ts](../app/e2e/fixture-openings.spec.ts)
replays the same inputs through the browser.

### Footprint class flags

The footprint scan's trigger flag (f3) latches when any scanned baseline cell is control 2 and is
never cleared by a later cell; the water flag (f0) is set only when every cell is control 3.
Priority 15 skips the scan, accepts the footprint, and clears both flags for ego.

A 3.002.102 demo (Gold Rush demonstration) repositions ego along a control-2 line and waits for
exactly (67,128), which a final-cell trigger never reaches; KQ1's beanstalk flanks the stalk with
trigger lines on both sides.

Specification: "Footprint control acceptance" states a final-cell rule for both classes.

Evidence: 3.002.102 and 3.002.107, scan at 0x5ae2: starts with the water state set, clears it on any
non-water cell, latches trigger on control 2, feeds both to f3/f0 for object 0 and applies the
on-water/on-land gates to the all-water state.

Tests: [object-cadence.test.ts](../test/object-cadence.test.ts).

### Ego direction coupling

Targeted motion on ego (move.obj, move.obj.v, wander) takes program control; arrival or a border
stop restores player control and clears v6.

A zero-distance move.obj on ego is the idiom that hands control back after a scripted placement.

Specification: The movement chapter is silent on the direction coupling.

Evidence: The shipped 2.936 and 3.002.x move.obj, move.obj.v and wander handlers write 0 to the
coupling selector for object 0; their motion-stop routine writes 1 and zeroes v6 for object 0. (No
load-module offsets recorded.)

Tests: [ego-motion-control.test.ts](../test/ego-motion-control.test.ts).

### Border variables cleared

The movement pass zeroes the border variables v2, v4 and v5 every cycle, so a border contact is
visible to logic for exactly one cycle.

Manhunter's v3 city map polls v2 for page turns.

Specification: The spec clears v4 and v5 at the cycle start and v2 only on room entry.

Evidence: The shipped 2.936 and 3.002.x interpreters zero all three in the movement pass, which
opens with stores to variables 5, 4 and 2. (No load-module offsets recorded.)

Tests: [object-cadence.test.ts](../test/object-cadence.test.ts), [mh1.test.ts](../test/mh1.test.ts).

### View loop index retention

set.view keeps the current loop when the new view has that many loops, else loop 0; set.loop (and
the direction-driven loop change) keeps the current cel when the new loop has that many cels, else
cel 0. Only an out-of-range index falls back to 0.

Manhunter's knife game (logic 118) re-selects loop 0 every cycle while it waits for the barker's cel
to come round; a reset-to-0 would freeze it forever.

Specification: "set.view" reads "select its default loop and cel".

Evidence: SetView: 3.002.102 offset 0x3e9a; 2.917 and 2.936 match. SetLoop: 3.002.102 offset 0x3f6a
with its core at 0x3fce; 2.917 and 2.936 at 0x3c1x. The binaries only fall back to the defaults when
the kept indices are out of range.

Tests: [object-cadence.test.ts](../test/object-cadence.test.ts), [mh1.test.ts](../test/mh1.test.ts).

### Display line layout

display treats CR and LF as a line break to the next row, capped at row 24, and wraps the character
after column 39 the same way; both continue at the routine's start column, which only a message
window sets, so a display call resumes at column 0.

A Leisure Suit Larry demonstration and the Space Quest intro display two-line captions with embedded
newlines.

Specification: The spec leaves the layout of display text unspecified.

Evidence: Character output: 3.002.102 offset 0x2d48; 2.411, 2.917 and 2.936 match.

Tests: [text-surface.test.ts](../test/text-surface.test.ts).

### Text under later graphics

Text and graphics share one bitmap: a cel drawn by add.to.pic, a sprite drawn or erased, and every
updating sprite's per-cycle redraw repaint the text under them. show.pic clears the picture band's
text. The engine stamps text cells with their write and drops the stamped cells a later drawing
covers.

The demo pack paints its menu rows black and add.to.pic's the game cards over them; a Mother Goose
demo redraws its speech bubble over stale words.

Specification: The interpreters have a single screen; the spec has no separate text layer to
describe this against.

Evidence: Follows from the interpreters' single bitmap: erasing or redrawing a cel restores the
pixels saved when it was drawn, so text written over it since then is gone. (No load-module offsets
recorded.)

Tests: [release-interpreter-regressions.test.ts](../test/release-interpreter-regressions.test.ts),
[object-cadence.test.ts](../test/object-cadence.test.ts),
[text-surface.test.ts](../test/text-surface.test.ts).

### Have key polling

A have.key poll issued once per cycle never blocks, in text mode either; only a busy loop inside one
logic invocation (proven by repeated polls) waits for a key.

The Space Quest intro polls once per cycle to let a key skip its text-screen captions.

Specification: The spec describes have.key as a simple key-pressed predicate.

Evidence: Follows the shipped games' usage: a per-cycle poll must return immediately for the cycle's
logic to keep running. (No load-module offsets recorded.)

Tests: [parser-input.test.ts](../test/parser-input.test.ts),
[input-contract.test.ts](../test/input-contract.test.ts).

### Compressed logic plain text

A dictionary-compressed v3 logic record stores its message text plain; only directly stored records
carry the "Avis Durgan"-encrypted text. The container normalizes compressed records to the encrypted
layout so every decoder sees one encoding.

The demo pack exercises compressed logic; Manhunter exercises both compressed and directly stored
records.

Specification: The "Logic payload" section specifies encrypted message text for logic records.

Evidence: Observed v3 game data, not interpreter code: a Sierra 3.002.102 demo installation where
every logic record is dictionary-compressed stores the text plain.

Tests: [demopac4.test.ts](../test/demopac4.test.ts), [mh1.test.ts](../test/mh1.test.ts).

### 3-002-107-is-3-002-102

Interpreter build 3.002.107 behaves as 3.002.102; profile detection maps the 3.002.107 version
string to the 3.002.102 profile. Similarly 2.915 selects 2.917 and 2.439 selects 2.440.

Manhunter (3.002.107) runs its full first day on the 3.002.102 profile.

Specification: version_profiles.md, per-profile paragraphs.

Evidence: The builds behave identically on every verified behavior in this file (the
3.002.102/3.002.107 offsets above are the same routine in both).

Tests: [profile.test.ts](../test/profile.test.ts), [mh1.test.ts](../test/mh1.test.ts).

### Print handler output modes

A print that opens a non-blocking window (f15 set) consumes f15 as it returns, so the next print
blocks again (profile flag `printConsumesF15`). A timed print (v21 half-seconds) zeroes v21 when its
window closes, by timeout or key (profile flag `timedPrintClearsV21`).

KQ4's keyless intro re-arms f15 for every window and reaches interactive play without a keypress.

Specification: The spec's modal-text chapter does not describe either side effect.

Evidence: The print-handler offsets below identify the f15 reset and v21 clear:

| Interpreter build     | f15 reset | v21 clear |
| --------------------- | --------- | --------- |
| 2.411                 | 0x1cb9    | 0x1d2d    |
| 2.440                 | 0x1ccf    | 0x1d43    |
| 2.917 / 2.936         | 0x1d0c    | 0x1d80    |
| 3.002.086             | 0x1fc5    | 0x2039    |
| 3.002.102 / 3.002.107 | 0x1fdb    | 0x204f    |
| 3.002.149             | 0x1f94    | 0x2008    |

The 3.002.149 fixture versions and shared handler ranges are compared in
[mh2-profile.test.ts](../test/mh2-profile.test.ts). At 0x1f94, the call through 0x7804/0x7828 clears
f15. Both timeout and key acknowledgement reach the v21 clear at 0x2008. Profiles 2.089, 2.230 and
2.272 retain f15 and v21; their print handlers have not been verified for these side effects.

Tests: [mh2-profile.test.ts](../test/mh2-profile.test.ts),
[message-modes.test.ts](../test/message-modes.test.ts),
[kq4-regressions.test.ts](../test/kq4-regressions.test.ts).

### Window update gate

An open text window does not suspend the per-cycle object update: a cycling cel whose rect overlaps
a window paints over it. The engine's text-cell masking models that overlap.

KQ4's closing intro window shows the cycling wave through its top border.

Specification: The spec's modal-text chapter does not address whether object updates continue under
an open window.

Evidence: The shipped main loops gate the object-update call on a state byte set only around the
full-screen selector UI, never by the window-open routine: the gate byte is `[0x17c7]` in 3.002.086
and `[0x1757]` in 2.936, set around the selector UI (0x3569 in 3.002.086); the window-open routine
(0x204F in 3.002.086) sets `[0xd53]`, which no draw or update path reads.

Tests: [kq4-regressions.test.ts](../test/kq4-regressions.test.ts).
