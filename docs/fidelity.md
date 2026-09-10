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
ndisasm -b 16 -e 0x200 games/<gameId>/AGI > /tmp/<gameId>.asm
```

v2 `AGI` executables are scrambled by the loader; undo it first with `scripts/descramble-agi.ts`,
then disassemble the same way:

```bash
node --experimental-strip-types scripts/descramble-agi.ts games/<gameId> /tmp/<gameId>-agi.bin
ndisasm -b 16 -e 0x200 /tmp/<gameId>-agi.bin > /tmp/<gameId>.asm
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

### PC booter 2.001 profile

The PC booter disk layout stores the same resource families as the v2 split container: a master
directory of three-byte records at 0x200 (sector 1) points at five-byte-header records (`0x12 0x34 vol lenLow lenHigh`)
holding OBJECT, WORDS.TOK, the four family directories and AGIDATA.OVL, and a volume area (`VOL.0`) whose
records the family directories index with the ordinary three-byte entries. The decoder
([booter.ts](../src/container/booter.ts)) copies those bytes unmodified; the interpreter bytes are
returned separately and imported as AGIDATA.OVL so the native "Version 2.001" string selects the
2.001 profile on every load. Nothing is normalized to a later edition.

The encrypted executable at slot 2 (`0x3600..0xb200`) is scrambled using the Sierra v2 128-byte block
XOR + bitwise rotate-right carry-chaining algorithm (identical to `scripts/descramble-agi.ts`). The 128-byte
key resides at Track 31, Sector 1, offset 1 (`keyofs` = 1 in the loader). When decrypted, the binary is a
standard DOS MZ executable starting with `0x4D 0x5A` ("MZ").

The promoted specification catalog starts at 2.089, so profile 2.001 pins only evidence-backed
differences and otherwise inherits the earliest documented contracts:

- Evidence-backed: v2-split container with five-byte record headers (every extracted resource
  validated against the records); plain OBJECT storage with a two-byte header (below);
  zero-terminated SN76489 row sounds (below); action 0x8f as `max.drawn.objects` (below);
  the game's logic bytecode decodes completely within the earliest operand grammar.
- Inherited unverified: every other profile field takes the earliest documented (2.089-family)
  value, including exit operand count, string slots, key-map capacity, save block layout and block
  count. No 2.001 save image has been observed; the save format is unverified.

Evidence: the authorized booter disk image; all 204 indexed resources extract byte-identically to
an independent probe of the same image.

Tests: [booter.test.ts](../test/booter.test.ts).

### PC booter inventory file

The observed 2.001 OBJECT file is u16le item-table size followed immediately by three-byte
(nameOffset u16le, location u8) entries and the name pool: 179 bytes = 2 + 59 × 3. There is no
maximum-drawable-object-index byte in the header.

Disassembly evidence: load-module offset 0x10aa..0x10b3 loads the OBJECT resource:

```asm
000010AA  8B3E5D04          mov di,[0x45d]     ; pointer to OBJECT resource
000010AE  A15D04            mov ax,[0x45d]
000010B1  0305              add ax,[di]        ; adds u16le at start of OBJECT directly
000010B3  A35F04            mov [0x45f],ax     ; [0x45f] = pointer to name pool
```

And test 8 (`has(i)`) at load-module offset 0x0ab8..0x0ad0 verifies three-byte item entries:

```asm
00000AB8  AC                lodsb              ; item number
00000AB9  32E4              xor ah,ah
00000ABB  BB0300            mov bx,0x3         ; 3 bytes per entry
00000ABE  F7E3              mul bx             ; ax = item * 3
00000AC0  8BD8              mov bx,ax
00000AC2  32C0              xor al,al
00000AC4  8B3E5D04          mov di,[0x45d]
00000AC8  807902FF          cmp byte [bx+di+0x2],0xff ; room location 255 = in inventory
```

There is no third header byte for max animated objects; the engine uses the same fallback record
count as absent metadata (21). Name offsets in the observed file point past the end (no usable name
pool); the status screen renders those names as empty.

Tests: [inventory-file.test.ts](../test/inventory-file.test.ts).

### PC booter action 0x8f (max.drawn.objects)

In AGI 2.001, action dispatch is bounded at 0x90 (144 actions, load-module offset 0x025e: `cmp al, 0x90`).
Action 0x8f is NOT `set.game.id` (which was introduced in later AGI 2.089+); in 2.001 it is `max.drawn.objects`.

Disassembly evidence: action dispatch table at DGROUP offset 0x2e5 (stored in `AGIDATA.OVL` offset 0x2e5)
maps action 0x8f to handler at load-module offset 0x0284:

```asm
00000284  56                push si
00000285  57                push di
00000286  55                push bp
00000287  8BEC              mov bp,sp
00000289  8B7608            mov si,[bp+0x8]    ; logic instruction pointer
0000028C  8BDE              mov bx,si
0000028E  46                inc si             ; advance past operand
0000028F  8A07              mov al,[bx]        ; read single byte operand
00000291  2AE4              sub ah,ah
00000293  8BF8              mov di,ax
00000295  833E070400        cmp word [0x407],0x0
0000029A  7504              jnz 0x2a0
0000029C  893E4901          mov [0x149],di     ; store numeric count to [0x149]
000002A0  8BC6              mov ax,si          ; return advanced script pointer
000002A2  5D                pop bp
000002A3  5F                pop di
000002A4  5E                pop si
000002A5  C3                ret
```

At load-module offset 0x02b2, `[0x149]` is read, doubled (`shl ax, 1`), and allocated via `malloc(0x1347)`
to create the drawn/animated object table stored at `[0x407]`.

The shipped 2.001 boot logic (Logic 28) executes `0x8f 0x19` to allocate 25 animated objects. Modern
interpreters and specifications that assume the 2.936 opcode mapping misidentified 0x8f as `set.game.id`
and attempted to look up message 25 in a logic defining only 6 messages. The native handler never accesses
messages and never aborts. Under the 2.001 profile, opcode 0x8f does not look up a message.

Tests: [booter.test.ts](../test/booter.test.ts).

### PC booter sound rows

A 2.001 sound payload (sounds 1..26) is a stream of rows: raw SN76489 register writes terminated by a
zero byte, one row per timer tick; an empty row (two adjacent terminators) writes nothing that tick.
Playback completes at payload exhaustion and silences the chip.

Disassembly evidence: load-module offset 0x7473..0x75B3:

- Playback check at 0x7473 compares the current row pointer `[0x122a]` against payload end `[0x122c]`.
  On exhaustion (`jc 0x7482` not taken), calls 0x4b96 which silences all channels (`0x9f`, `0xbf`, `0xdf`, `0xff`
  sent to port 0xc0) and sets the completion flag.
- Row byte decoding loop at 0x74a1 compares `byte [di]` against 0. Non-zero bytes are written via 0x75b3
  to port 0xc0 (or converted to 8253 timer 2 frequency divisor at ports 0x43/0x42 for PC speaker), advancing
  `[0x122a]`. A zero byte branches to 0x7556, terminating the row for the current tick.
- Routine 0x75b3 checks sound enabled flag f9 at 0x75bb (`call 0x6ad5`) before writing to the chip; if f9 is
  cleared, chip writes are bypassed.
- Sound playback is driven by the timer interrupt hook on INT 0x1C (installed at load-module offset 0x4bba
  pointing to 0x76d7, which calls 0x73c5 on every timer tick).

Tests: [sound-playback.test.ts](../test/sound-playback.test.ts).

### Timer-interrupt sound during blocking input

Sound is never pumped by the main interpreter loop. The v2 (KQ1, descrambled AGI) and v3 (MH1,
AGI 3.002.107) executables both service the sound player from a hardware timer interrupt handler,
so music keeps playing while the interpreter is blocked inside the get.string/get.num keyboard
editor: the game world (cycles, timers, movers) freezes, the tune does not.

Disassembly evidence (load-module offsets):

- MH1: handler at 0x8978 (`iret`, EOI via port 0x20) tests the sound-active flag `[0x12db]` and
  calls the player at 0x8473 every tick, chaining to the previous vector (`call far [0x18b9]`)
  every third tick. The player loops channels at 0x8483, decrements duration counters
  `[bx+0x1812]`, loads notes via `[bx+0x180a]` and writes the chip through 0x854a.
- KQ1: identical code — handler at 0x845a calls the player at 0x7f55 (same structure; both even
  share the `E8DCF4` call to the f9 flag check), chaining every third tick via
  `call far [0xdf35]`.

Implication for this engine: the SAB bridge parks the worker thread during get.string/get.num, so
the sound clock freezes for the prompt's duration (normal play then catches up in a burst; replay
advances no virtual ticks while parked). This is a deliberate record/replay determinism trade-off
— the walkthrough tape treats a blocking prompt as zero elapsed ticks — not a claim about
hardware.

### SN76489 attenuation latching and rest notes

On the Texas Instruments SN76489 (and NCR 8496) Digital Complex Sound Generator (PSG) used in the
IBM PCjr and Tandy 1000, only the 10-bit tone frequency registers (registers 0, 2, and 4) accept a
second data byte (`bit 7 = 0`) to complete the 10-bit divisor. The 4-bit attenuation registers
(registers 1, 3, 5, and 7) and the noise control register (register 6) are latch-only (`bit 7 = 1`).
Any data bytes (`bit 7 = 0`) sent while an attenuation or noise register is latched are ignored by
the silicon.

In multi-channel AGI sound resources (such as King's Quest II Sound 6, the two-voice church organ
hymn in Room 71), unused channels or rest notes are encoded with `tone = 0` and attenuation 15
(`0x0f`, silence).

Two failure modes arise if hardware latching semantics and rest notes are not modeled accurately:

1. If an audio presentation backend treats non-latch data bytes as attenuation updates, a stray
   `0x00` byte (e.g. from an unsuppressed tone update or stream data) written while an attenuation
   register is latched will be interpreted as attenuation `0` (0 dB / 100% volume), producing an
   unintended maximum-volume stuck note or drone.
2. In `SoundPlayback`, notes with `tone = 0` represent rests; emitting tone divisor command bytes
   for these notes sends redundant frequency commands (`[high, 0x00]`) to unvoiced or silent
   channels. Suppressing frequency writes when `tone = 0` keeps inactive voice divisors untouched.

Specification: The AGI behavioral specification documents the 5-byte note structure and defines
tone divisor 0 as silence/rest, but does not detail the TI SN76489 chip latching state machine.

Tests: [audio.test.ts](../app/test/audio.test.ts) (rejection of data bytes on attenuation latches),
[sound-playback.test.ts](../test/sound-playback.test.ts) (rest note tone suppression).
