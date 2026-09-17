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

Inventory contributor-supplied fixtures without executing code or exporting binary data:

```bash
node --experimental-strip-types scripts/interpreter-inventory.ts games > /tmp/interpreter-inventory.json
```

The metadata-only report pins raw `AGI`, all candidate COM loaders, `AGIDATA.OVL`
and the corrected decoded image separately by SHA-256. `WORDS.TOK` content,
not the directory name, identifies known games. It records Node and tool
hashes, build-string sources, exact or documented-equivalent profile selection,
MZ header/load sizes and relative CS:IP/SS:SP. Unknown builds receive no profile
fallback. The report is **static inventory**, not disassembly or original
execution; BIOS, timer and device inputs are absent. Its `inventoried` status
means an image passed structural/banner checks, not that a game is compatible.

Loader candidates must produce the same structurally valid interpreter image
with the corrected decoder. This identifies a usable decoding key, not executed
loader behavior. The overlay is explicitly **co-located, unverified**: its hash
and build string do not prove that an installation's executable/overlay pair is
authentic. Existing hash-pinned probes provide stronger evidence only for the
pairs they execute. Missing interpreters, disk-image-only installations,
ambiguous file names/keys, conflicting builds and size discrepancies remain
explicit in the report. Tests use independently authored synthetic headers and
one-block XOR inputs; no private binaries are required.

Additional static image identities are LSL1
2.440 (`c70e2f327eaad8dbcb1d526e9fb3f933b342329b84c6a803f9062c245ccb7676`),
SQ1 2.917 (`97dbc528ff4588b424d8c4e43035d619588c0c6b4376cc1ddea1fb83cea67656`)
and MH2 3.002.149
(`3a2a02fd4effd2c045137d232441dd29adb3f8dc79088add2b5acefd43cf41d8`),
without claiming new behavioral evidence. Several shipped images are 1 or 14
bytes shorter than their MZ-declared length; others have trailing padding.
The inventory preserves actual and declared extents separately. It does not
infer DOS loading behavior or silently pad/trim the hashed image.

v3 `AGI` executables disassemble directly. Set `HEADER_BYTES` from that image's
`decoded.mz.headerBytes` in the inventory (512 in the inputs investigated below):

```bash
ndisasm -b 16 -e "$HEADER_BYTES" games/<folder>/AGI > /tmp/<folder>.asm
```

v2 `AGI` executables are scrambled by the loader; undo it first with `scripts/descramble-agi.ts`,
then disassemble the same way:

```bash
node --experimental-strip-types scripts/descramble-agi.ts games/<folder> /tmp/<folder>-agi.bin
ndisasm -b 16 -e "$HEADER_BYTES" /tmp/<folder>-agi.bin > /tmp/<folder>.asm
```

The v2 scrambling XORs each 128-byte block with the evolving 128-byte key at
loader file offset 0x41. Initial carry is zero. After each block, rotate each
key byte through carry, from byte 0 through byte 127; OR the final carry into
byte 0's high bit. The loader's saved flags also retain that final carry for
rotation of the next block. This is not a simple circular rotation.

**Descrambler correction:** the old tool incorrectly initialized
carry from byte 0 each block and omitted the final wrap. That produced corrupt
instructions in otherwise plausible images. Synthetic carry regressions failed
against that implementation and pass the repair. No original instruction was
patched or guessed. The independent
[loader probe](../scripts/probe-interpreter-loader.py) executes the original
COM routine and compares **every output byte** with the TypeScript CLI:

| Input            | COM routine offset (loaded at 0x100) | Bytes compared |
| ---------------- | ------------------------------------ | -------------- |
| KQ1 / KQ1.COM    | 0x9f4                                | 39,424         |
| KQ2 / SIERRA.COM | 0x969                                | 38,400         |
| KQ3 / SIERRA.COM | 0x9f4                                | 39,424         |
| BC / BC.COM      | 0x96d                                | 38,400         |
| SQ2 / SIERRA.COM | 0x9f4                                | 39,424         |

All five comparisons pass. Decoded SHA-256 identities appear below. Reproduce
with `python scripts/probe-interpreter-loader.py games/kq1 --loader KQ1.COM --entry 0x9f4`
using optional Unicorn 2.1.4; substitute the table's directory/loader/entry.
Already-MZ inputs are copied unchanged. Decoded binaries and disassemblies are
Sierra data: keep them with local fixtures or in scratch storage, never committed.

### Remaining original-behavior evidence

Static inventory does not close the following gaps. Keep static disassembly,
isolated routine execution, full-machine execution, hardware evidence and
inference distinct when extending the existing hash/address-backed findings.
Completed loader comparisons, exhaustive RNG and wander probes need not be
rerun as new discoveries.

| Investigation                          | Current evidence and remaining acceptance                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler and modal timing             | Existing engine cadence tests are not original timing evidence. Obtain independently timed v2/v3 traces across timer interrupts, modal waits, sound completion, v10 changes and long host stalls; derive engine and worker regressions from those observations.               |
| Startup and restore reconstruction     | [Save/restart cores](#original-save-and-restart-audit) are isolated routine evidence. Continue through resource replay and script resumption, independently probe startup seeding, and map every original 43-byte object-record flag before claiming `.SAV` interoperability. |
| Complete movement and collision passes | [Motion handlers](#original-motion-and-animation-audit) establish command and animation behavior. Execute whole passes over synthetic controls, blocks, water and object baselines; record position, flags, parameter bytes, cadence and arrival/border order.                |
| Follow retries and older profiles      | Existing handler thresholds do not establish every stationary retry path. Pin BIOS/RNG inputs and exact random-call counts at subtraction/threshold edges, then extend earlier decoded v2 builds. Add profile variants only for observed differences.                         |
| Chip and device semantics              | [Sound software traces](#original-sound-player-audit) do not establish silicon behavior. Obtain authoritative chip evidence or controlled device emulation for zero tone, latch, attenuation/noise writes and hold behavior before changing zero-tone suppression.            |

The shared object parameter bank at `0x27..0x2a` is already evidenced; it does
not prove the remaining flags or full save interoperability. Preserve existing
lifecycle and cadence assertions while widening each investigation. Store probe
commands, tool versions and controlled inputs alongside private outputs; publish
only concise findings and independently authored expected vectors.

## Compatibility notes

### Original RNG and wander countdown — binary investigation

These are new implementation requirements, not claims that the engine already
matches. Investigation used original interpreter machine code, NDISASM
3.02 and Unicorn 2.1.4 in 16-bit mode. No other interpreter implementation was
used. The executable's MZ header size is read from its paragraph count (0x200
for these inputs); addresses below are relative to the load module. DS addresses
are separately identified. Whole-file linear disassembly includes data and can
misalign instructions: routine entry points and actual execution established
these results, not a text search alone.

#### Verified inputs

| Game / executable form | Build from AGIDATA.OVL | RNG entry | State DS offset | Executed states |
| ---------------------- | ---------------------- | --------- | --------------- | --------------- |
| KQ1, decoded           | 2.917                  | 0x70f9    | 0x1707          | all 65,536      |
| KQ2, decoded           | 2.411                  | 0x6dfe    | 0x15e0          | all 65,536      |
| KQ3, decoded           | 2.936                  | 0x71c0    | 0x1711          | all 65,536      |
| BC, decoded            | 2.439                  | 0x6f1b    | 0x168d          | all 65,536      |
| SQ2, decoded           | 2.936                  | 0x71c0    | 0x1711          | all 65,536      |
| MUMG, already MZ       | 2.915                  | 0x70e5    | 0x1707          | all 65,536      |
| KQ4, already MZ        | 3.002.086              | 0x75ff    | 0x1781          | all 65,536      |
| DEMOPAC4, already MZ   | 3.002.102              | 0x7617    | 0x1793          | all 65,536      |
| MH1, already MZ        | 3.002.107              | 0x7617    | 0x1793          | all 65,536      |
| GR1, already MZ        | 3.002.149              | 0x753e    | 0x1548          | all 65,536      |

SHA-256 of each executed input (decoded executable where indicated):

```text
kq1 decoded  bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04
kq2 decoded  d99938d6622ef18556bea76ebe72214b18cecac7305b83885a1157ddcff539bf
kq3 decoded  4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400
bc decoded   e717bfe1059eff8c2d7ace9052e194b50ddec9257421b4e77356e91331142ade
sq2 decoded  11dce8acb65eda6b4a28e90f8c50019c96c445918d19763d57bd503ede549a79
sq2 shipped  2d4c5389e6665570f83f024cdbe9b369d048b864183d2921ca45e7f6758021cc
mumg         6ee9d44b87e11dd3dba847468902932ab53ed08e714e349dc3679de544fc4c2f
kq4          b9b27b403015bb18f6562ba1b8b04c2829e0c3b53c042196bee7924d1df7be65
demopac4     7cf6eac9d5bbfbd944a2b5d7189878ffe4b2d608646d91c87d5372399fa9d1d0
mh1          ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e
gr1          12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41
```

The repaired loader closes the earlier KQ1/KQ2/KQ3/BC evidence gap. All four
now execute correctly, including their wander routines. Verification remains
specific to these builds; it does not establish every interpreter profile.

#### RNG behavior established by executing the original routine

1. State is an unsigned **16-bit** word. If it is zero on entry, call BIOS
   interrupt 1Ah with AH=0 and replace state with **DX**, the low clock word.
2. Compute `state = (state * 31821 + 1) & 0xffff` (multiplier `0x7c4d`).
   The high product word is discarded.
3. Return `(state & 255) ^ (state >>> 8)`, an unsigned **byte**, not the high
   word of a 32-bit generator. Preserve the full 16-bit state for the next call.

In 3.002.149, the zero check is at 0x7546, BIOS read at 0x754f, multiplication
at 0x7558, state store at 0x755d and byte folding at 0x7560. The matching 2.936
locations are 0x71c8, 0x71d1, 0x71da, 0x71df and 0x71e2.

**Zero is not a one-time initialization flag.** State 58,235 advances to zero
and returns zero. The following call reads BIOS again. With supplied BIOS DX
0x1234 it advances to 43,429 and returns 12. With BIOS DX=0 it advances to 1
and returns 1. The probe injects the BIOS result; it does not emulate hardware
clock cadence. Recording only the first seed cannot reproduce later zero-state
clock reads. Replacing the branch with `state || 1` changes original behavior.

Exact sequence from state 1, before any BIOS read:

| Draw | Next state | Returned byte |
| ---- | ---------- | ------------- |
| 1    | 31822      | 50            |
| 2    | 11127      | 92            |
| 3    | 46796      | 122           |
| 4    | 52061      | 150           |
| 5    | 14074      | 204           |
| 6    | 41267      | 146           |
| 7    | 12376      | 104           |
| 8    | 10873      | 83            |
| 9    | 25190      | 4             |
| 10   | 175        | 175           |

#### Range mapping and consumers

The 3.002.149 `random(n,m,v)` handler at 0x523e reads unsigned byte operands,
forms a 16-bit `(m-n+1)`, calls RNG at 0x526d, uses unsigned remainder at
0x5272, adds n and stores the low byte. For valid n<=m this is
`n + (randomByte % (m - n + 1))`. It still consumes a draw when n=m.
Starting each case at state 1: `(0,255)` gives 50, `(10,20)` gives 16,
`(42,42)` gives 42. These were executed through the original handler.

Malformed reversed bounds are not normalized by Sierra: `(20,10)` gives 70
from state 1; `(1,0)` raises CPU divide error (interrupt 0), observed in the
isolated probe. Do not silently swap bounds. A controlled engine fault is an
appropriate host representation of the zero-divisor case; do not emulate a
machine crash. Do not advertise reversed bounds as an authoring feature.
Shipped code does lean on the behavior, though: kq2 logic 167 rolls
`random(30,0,v)` — span 65,527, so the byte is never reduced — for
`30 + byte` wrapped to a byte. The assembler must accept it for
disassemble→assemble round-trips.

Direction helper 0x4207 returns `randomByte % 9`, including zero. The blocked
follow path at 0x0e08 retries this helper until direction is nonzero. Its distance
retry at 0x0e59 also consumes the same RNG, with remainder and threshold retry.
Those call sites were disassembled; the complete follow routine was not executed
in this pass. Preserve its existing call-order logic while replacing the source.

#### Wander: decrement first, conditionally reroll the count

Executed entry points: 3.002.149 at 0x41be (ego pointer DS:0x07d0),
3.002.086 at 0x42f7 (DS:0x099d), and 3.002.102/.107 at 0x430d
(DS:0x09b0). Corrected v2 images also executed: KQ1 at 0x3f5a
(DS:0x0963), KQ2 at 0x3e58 (DS:0x0951), BC at 0x3e82 (DS:0x0951),
KQ3 and SQ2 at 0x3f5a (DS:0x096b). All nine produced the vectors below.

The routine reads the old byte count and decrements it modulo 256. If the old
count was zero **or** object flag 0x4000 (stationary) is set, choose a direction
using one draw modulo 9. Then, **while the already decremented count is below
6**, draw modulo 51 into the count and retry if still below 6. This is a `while`,
not a `do/while`: old zero wraps to 255 and is retained. A stationary object
whose decremented count is at least 6 also retains that count. Otherwise no
random draw is made. Ego direction is also written to v6.

Each row starts at RNG state 1 and object direction 0:

| Old count | Stationary | New direction | New count | Final RNG state |
| --------- | ---------- | ------------- | --------- | --------------- |
| 0         | false      | 5             | 255       | 31822           |
| 1         | false      | 0             | 0         | 1               |
| 1         | true       | 5             | 41        | 11127           |
| 8         | true       | 5             | 7         | 31822           |
| 255       | true       | 5             | 254       | 31822           |

The current engine's unconditional count reroll on direction change consumes
extra randomness and changes motion. Apply the evidenced count behavior to the
nine verified inputs, including the corrected v2 builds.

#### Reproduce without shipping original code or adding runtime dependencies

The independent harness [probe-interpreter-rng.py](../scripts/probe-interpreter-rng.py)
loads local bytes into an isolated 16-bit CPU, intercepts BIOS clock input and
checks returned values/state. It requires optional Unicorn, outside npm/runtime:

```bash
python3 -m venv /tmp/agi-binary-venv
/tmp/agi-binary-venv/bin/pip install unicorn==2.1.4
node --experimental-strip-types scripts/descramble-agi.ts games/sq2 /tmp/sq2-agi.bin
/tmp/agi-binary-venv/bin/python scripts/probe-interpreter-rng.py /tmp/sq2-agi.bin --entry 0x71c0 --state 0x1711 --sha256 11dce8acb65eda6b4a28e90f8c50019c96c445918d19763d57bd503ede549a79 --exhaustive
/tmp/agi-binary-venv/bin/python scripts/probe-interpreter-rng.py games/gr1/AGI --entry 0x753e --state 0x1548 --sha256 12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41 --range-entry 0x523e --wander-entry 0x41be --ego-pointer 0x7d0 --exhaustive
```

Use the table's entry/state/hash for the other inputs. The ten exhaustive runs
passed 655,360 state comparisons. A temporary probe with multiplier 31823 failed
against the original binary; the unchanged probe passed, including zero clock
input. Python syntax and documentation formatting checks passed. No runtime
implementation was changed by this investigation.

This RNG probe intercepts BIOS input; it does not establish hardware clock
cadence. The separate [save/restart audit](#original-save-and-restart-audit)
now executes those original routine cores in 2.936 and 3.002.149: authentic
save/restore and accepted restart preserve the current RNG stream. Harness
history deliberately restores RNG and external-input cursor as its stronger
checkpoint contract. Full startup and post-restore reconstruction remain
separate from these bounded routine results.

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

Implication for this engine: the worker suspends the interpreter pass during
get.string/get.num instead of blocking its event loop, so the sound clock keeps
advancing — matching the hardware. Replay records the separate clock lane so suspended logic does not imply
zero elapsed sound time. This harness clock contract remains distinct from
full DOS interrupt-cadence verification.

### SN76489 attenuation latching and rest notes

The current audio backend accepts continuation data bytes for tone registers
and ignores them for attenuation/noise latches. This is the current presentation
policy; the broad claim that every SN76489/NCR 8496 variant ignores those bytes
requires chip-specific evidence and is not established by interpreter execution.
See the [sound audit](#original-sound-player-audit) for the remaining hardware evidence gaps.

In multi-channel AGI sound resources (such as King's Quest II Sound 6, the two-voice church organ
hymn in Room 71), unused channels or rest notes are encoded with `tone = 0` and attenuation 15
(`0x0f`, silence).

Two failure modes arise if hardware latching semantics and rest notes are not modeled accurately:

1. If an audio presentation backend treats non-latch data bytes as attenuation updates, a stray
   `0x00` byte (e.g. from an unsuppressed tone update or stream data) written while an attenuation
   register is latched will be interpreted as attenuation `0` (0 dB / 100% volume), producing an
   unintended maximum-volume stuck note or drone.
2. `SoundPlayback` suppresses frequency writes when `tone = 0`, leaving inactive
   voice divisors untouched. Original KQ1/MH1/GR1 routines emit these writes.
   Suppression is a deliberate presentation divergence, not reproduced original
   command-stream behavior. Resolve chip/device semantics before changing it.

Specification: The AGI behavioral specification documents the 5-byte note structure and defines
tone divisor 0 as silence/rest, but does not detail the TI SN76489 chip latching state machine.

Tests: [audio.test.ts](../app/test/audio.test.ts) (rejection of data bytes on attenuation latches),
[sound-playback.test.ts](../test/sound-playback.test.ts) (rest note tone suppression).

### Parked host waits

A host service that cannot answer synchronously — the worker, whose reply lands on a
later event-loop pass — throws `HostWait` out of the host method; the engine parks the
live logic stack and returns to the event loop. While a pass is parked the application
stays live: inspection, autosave, export, recording, editing and patching are all
served normally, and the interpreter clock advances by wall time exactly as the
original interpreters' timer interrupt did. A poll that lands while a pass is parked
may deliver the parked answer, feed the suspended save/restore dialog, dismiss an
error window or record the observation — the suspended pass itself runs no cycle work
until its answer arrives.

The delivered answer resumes the parked stack at the identical instruction — nothing
runs in between — so a checkpoint taken while parked restores to that instruction. The
host autosave image carries the serialized continuation (the parked logic frames, the
open print/inventory/menu/show-object/show-priority windows and their saved text
rectangles, and a parked have.key wait with its condition replay and poll count) beside
the authentic save-game state; on restore the engine resumes there exactly once. Only a
live host request — a prompt, the save/restore selector, a confirmation or room
authoring — makes a pass a non-snapshot point, because the outstanding answer belongs
to the host, not the image.

If resources were patched after the checkpoint, the continuation's patch generation no
longer matches the live container: the restore peels the windows back to the saved
surface, drops the stale bytecode and lets a fresh pass begin rather than executing
instruction pointers into edited logic.

Tests: [host-wait.test.ts](../test/host-wait.test.ts) (suspension and delivery),
[parked-checkpoint.test.ts](../test/parked-checkpoint.test.ts) (checkpoint round-trips
and revision mismatch),
[autosave.test.ts](../test/autosave.test.ts) (host image versioning).

### Restore error window

A failed `restore.game` image does not abort the calling pass inline: the engine parks
the interaction behind an "Unable to restore saved game." window and the game ends only
after the window is acknowledged. The window drains on later host polls through the
ordinary modal path, never inside the failing pass — so the error surfaces to the
player exactly like a game message, and a host that never acknowledges leaves the game
parked rather than dead.

Tests: [save-dialog.test.ts](../test/save-dialog.test.ts) (parked restore errors).

### Host observation surfaces

Two engine APIs exist for the host's inspector and world map and change no
observable game behavior: `getPreviewMask()` returns the pixels the `show.obj`
preview cel wrote while that modal is open — composition metadata so a layered
renderer can keep the cel identifiable rather than treating it as an ordinary
screen object; and `setRoomTransitionListener()` reports `(from, to, edge,
restarted)` at the moment `completeNewRoom` runs, before `finishRoomChange`
clears the edge code — pure observation, so a journal can attribute the entry
without an opcode or flag side channel. Neither hooks the interpreter: no
opcode, flag, variable or pixel differs whether they are armed or not.

Tests: [worker-presentation.test.ts](../app/test/worker-presentation.test.ts)
(mask publish and dismissal),
[worker-journal.test.ts](../app/test/worker-journal.test.ts) (transition
attribution and replay silence).

### Original motion and animation audit

Executed original interpreter machine code using
[scripts/probe-interpreter-motion.py](../scripts/probe-interpreter-motion.py)
and optional Unicorn 2.1.4. This establishes handler and animation state
transitions, not graphics, collision scanning or whole-loop cadence: the final
cel-resource setter is intercepted to capture its requested cel. No original
instructions or game assets are bundled with the probe.

Inputs and SHA-256 (v2 inputs are decoded with the corrected loader procedure):

| Input/build        | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| KQ3 decoded, 2.936 | `4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400` |
| MH1, 3.002.107     | `ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e` |
| GR1, 3.002.149     | `12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41` |

All routine addresses below are load-module offsets; the final row is a DS offset.

| Routine                | KQ3 2.936 | MH1 3.002.107 | GR1 3.002.149 |
| ---------------------- | --------- | ------------- | ------------- |
| normal.cycle           | 0x6b82    | 0x6fd3        | 0x6efa        |
| reverse.cycle          | 0x6beb    | 0x703c        | 0x6f63        |
| end.of.loop            | 0x6bae    | 0x6fff        | 0x6f26        |
| reverse.loop           | 0x6c17    | 0x7068        | 0x6f8f        |
| follow.ego             | 0x6e02    | 0x7253        | 0x717a        |
| move.obj               | 0x6ce4    | 0x7135        | 0x705c        |
| follow update          | 0x0b36    | 0x0d8b        | 0x0d84        |
| animation update       | 0x48b3    | 0x4cf7        | 0x4b0e        |
| cycle.time             | 0x6c54    | 0x70a5        | 0x6fcc        |
| intercepted cel setter | 0x3ccb    | 0x407e        | 0x3f2f        |
| ego table pointer (DS) | 0x096b    | 0x09b0        | 0x07d0        |

Twelve scenario rows per executable passed, 36 total. A negative control using
the current engine's stopped normal.cycle behavior failed at that assertion.
Independent synthetic Engine execution confirmed these mismatches:

- `normal.cycle` and `reverse.cycle` set cycling bit 0x20 as well as mode. They
  do not set update bit 0x10 or reset cadence counters. After `stop.cycling`,
  either command resumes cycling; the current handlers change only mode.
- `follow.ego` sets update bit 0x10 and captures
  `max(requestedDistance, currentStepSize)` at opcode execution. Step size 4
  with requests `[0,1,4,5,255]` produces thresholds `[4,4,4,5,255]`; retry is 255. An ego three pixels away on the same baseline completes on the next
  motion update in all five cases. `move.obj` also sets update bit 0x10.
  Current target/follow helpers can retain the stopped update partition.
- Object bytes 0x27..0x2a are one shared parameter bank. `move.obj` writes
  `[targetX,targetY,savedStep,completionFlag]`; `follow.ego` writes
  `[effectiveThreshold,completionFlag,255,unchanged]`; `end.of.loop` and
  `reverse.loop` write their completion flag into the **first byte**. Animation
  completion reads that first byte even when later motion overwrote it.

For a non-ego actor at (10,80), step size 4 and three cels:

| Opcode sequence                                  | Final shared bank | Observable result                      |
| ------------------------------------------------ | ----------------- | -------------------------------------- |
| `move.obj(o1,90,80,2,f62); end.of.loop(o1,f61);` | `[61,80,4,62]`    | Target X becomes 61.                   |
| `end.of.loop(o1,f61); move.obj(o1,90,80,2,f62);` | `[90,80,4,62]`    | Completion at cel 2 sets f90, not f61. |

`reverse.loop` has the same overwrite and sets f90 on reaching cel 0 in the
second ordering. One initial animation call consumes the delay before an
eligible call advances from cel 1. Completion stops cycling, zeros direction
and returns cycle mode to normal. These final effects already match the engine.
`cycle.time(v=7)` writes both interval and remaining counter to 7, also a match.
Do not infer full scheduler tick counts from this isolated routine execution.

Implementation contract: fix cycling/update/threshold effects; replace
independently writable motion/cycle fields with one authoritative four-byte
bank and mode-dependent accessors; preserve bytes a handler does not write.
Flag index zero is valid. Use the same bank for 43-byte save object records and
rewind snapshots. Current follow-retry, cycle-flag and wander-count packing is
not the original layout; do not retain it as a compatibility layer. Test both
opcode orderings before and after restore, plus one record→seek→resume sequence.
Early profiles, full collision/footprint ordering and stochastic follow retries
remain open investigations, not verified claims.

Reproduce after decoding the private KQ3 executable:

```sh
python scripts/probe-interpreter-motion.py /tmp/agi-fixed-kq3.bin --profile 2.936
python scripts/probe-interpreter-motion.py games/mh1/AGI --profile 3.002.107
python scripts/probe-interpreter-motion.py games/gr1/AGI --profile 3.002.149
```

### Original sound player audit

Executed original interpreter machine code with
[scripts/probe-interpreter-sound.py](../scripts/probe-interpreter-sound.py),
Unicorn 2.1.4 and each binary's matching original AGIDATA.OVL. Only resource
lookup is substituted with a synthetic loaded-resource descriptor; opcode,
flag, player, envelope and stop code execute unchanged. Port writes are captured,
not sent to hardware. This does not establish interrupt cadence, audible PSG
behavior or modal-editor timing.

MH1 and GR1 executable hashes are listed in the motion audit above. KQ1 2.917
corrected decoded executable SHA-256 is
`bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04`.
The probe additionally requires these AGIDATA.OVL hashes:

| Build         | AGIDATA.OVL SHA-256                                                |
| ------------- | ------------------------------------------------------------------ |
| KQ1 2.917     | `f7ca256c1c0ab12509d695baabdd44a3c5e72a570b08118d3ead995a47f4c383` |
| MH1 3.002.107 | `bb22a87cd215ed52154d49754493e0eb2f6be5688411d8f3b7ac17c417ddae1f` |
| GR1 3.002.149 | `914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804` |

| Location              | KQ1 2.917 | MH1 3.002.107 | GR1 3.002.149 |
| --------------------- | --------- | ------------- | ------------- |
| sound opcode          | 0x510b    | 0x55ef        | 0x5406        |
| substituted lookup    | 0x5010    | 0x54f4        | 0x530b        |
| stop helper           | 0x516c    | 0x5650        | 0x5467        |
| player tick           | 0x7f55    | 0x8473        | 0x8330        |
| envelope (DS)         | 0x17ae    | 0x183a        | 0x15ef        |
| output selectors (DS) | 0x17f2    | 0x1888        | 0x163d        |

Confirmed matches in all three builds:

- Starting sound clears its completion flag. Replacing f40 with f41 sets f40
  and clears f41; replacing using f40 again leaves f40 clear.
- Stopping active sound sets its completion flag. Stopping idle sound does
  nothing, including when the old flag was manually cleared afterward.
- Starting with f9 clear still installs playback and clears completion; the
  **next sound tick** stops and sets completion. Clearing f9 during playback
  also terminates at the next tick, rather than merely muting a running tune.
- A duration-2 note completes on tick 3: note load, countdown, terminator.
  Duration zero wraps: note load stores 0, the next tick stores 65535. The
  engine's logical 65536 duration is behaviorally consistent with that wrap.

Two audited mismatches are independently verified. First, current
`DEFAULT_ENVELOPE_TABLE` matches KQ1's 68-entry envelope, but the measured v3
builds use 78 entries and decay more slowly. Exact `(delta, repetition count)`
contracts, followed by hold sentinel 128:

- KQ1: `(-2,1),(-3,1),(-2,1),(-1,1),(0,2),(1,4),(2,8),(3,7),(4,4),`
  `(5,4),(6,5),(7,4),(8,4),(9,4),(10,4),(11,6),(12,6),(13,1)`.
- MH1/GR1: `(-2,1),(-3,1),(-2,1),(-1,1),(0,5),(1,6),(2,10),(3,8),(4,5),`
  `(5,5),(6,5),(7,4),(8,4),(9,4),(10,4),(11,6),(12,6),(13,1)`.

Second, all three originals apply v23 attenuation only while advancing an
active envelope. At hold and afterward they reuse the last clamped envelope
value without v23. Noise has no active envelope and also skips v23. MH1 branches
at 0x85d9..0x85dc and 0x85e6..0x85f9 bypass the v23 addition at 0x8611;
execution confirms the effect. With duration 120, control 0x90, device 1, v23=3:

| Tick | KQ1 attenuation | MH1/GR1 attenuation | Current engine |
| ---- | --------------- | ------------------- | -------------- |
| 7    | 4               | 3                   | 4              |
| 11   | 5               | 4                   | 5              |
| 30   | 8               | 6                   | 8              |
| 67   | 15              | 14                  | 15             |
| 68   | 13              | 14                  | 15             |
| 77   | 13              | 15                  | 15             |
| 78   | 13              | 13                  | 15             |

Noise-only duration 2, tone 0xe001, control 0xf0 and v23=3 emits attenuation
0xf0 in every measured original, versus 0xf3 in the current engine.

Implementation: select the envelope through the interpreter profile and use
that selection for both playback and snapshot index bounds. Preserve KQ1's
shape; map the measured v3 families explicitly rather than replacing every
common-profile table. Apply v23 inside the active-envelope/non-hold branch;
keep the existing later Tandy adjustment branch. Test the table above and
snapshot restoration across ticks 67/68 and 77/78. Broader profile claims need
additional evidence. The v3 expectation was observed failing on KQ1, exposing
this real profile distinction; the final profile-specific probe passes all three.

Original tone-zero output is also established: the player emits two 0x00 port
bytes before attenuation on device 1. The current suppression is therefore a
command-stream divergence, not original-interpreter behavior. This does not
prove audible harm or resolve chip data-byte latching. Retain silence pending
hardware/reference investigation; do not restore stray audible notes just
to match port bytes.

```sh
python scripts/probe-interpreter-sound.py /tmp/agi-fixed-kq1.bin --data games/kq1/AGIDATA.OVL
python scripts/probe-interpreter-sound.py games/mh1/AGI
python scripts/probe-interpreter-sound.py games/gr1/AGI
```

### Original save and restart audit

[scripts/probe-interpreter-lifecycle.py](../scripts/probe-interpreter-lifecycle.py)
executes original save-writer/restore-reader cores and accepted restart reset
paths with optional Unicorn 2.1.4. Save/restore starts after successful file
selection and stops before resource reconstruction; DOS file reads/writes use
an in-memory file. Restart uses a synthetic OBJECT image and intercepts the
listed peripheral calls. This is bounded lifecycle evidence, not full DOS
startup or post-restore execution. Missing private inputs produce explicit skips.

GR1's executable hash is listed above. Corrected decoded SQ2 2.936 SHA-256 is
`11dce8acb65eda6b4a28e90f8c50019c96c445918d19763d57bd503ede549a79`.

| Routine/data             | SQ2 2.936     | GR1 3.002.149 |
| ------------------------ | ------------- | ------------- |
| save core, entry→stop    | 0x27fb→0x28a3 | 0x2a9f→0x2b47 |
| restore core, entry→stop | 0x25d6→0x2647 | 0x2856→0x28c7 |
| accepted restart         | 0x2472        | 0x26e0        |
| state initializer        | 0x0fa5        | 0x11b3        |
| RNG word (DS)            | 0x1711        | 0x1548        |

The original writer selects these blocks; the RNG word is not among them:

| Block       | SQ2 2.936                               | GR1 3.002.149                           |
| ----------- | --------------------------------------- | --------------------------------------- |
| description | DS0x1c6c, 31 bytes                      | DS0x1aaf, 31 bytes                      |
| 1           | DS0x0002, 0x5e1 bytes                   | DS0x0002, 0x404 bytes                   |
| 2           | pointer DS0x96b, length DS0x96f         | pointer DS0x7d0, length DS0x7d4         |
| 3           | pointer DS0x971, length DS0x975         | pointer DS0x7d6, length DS0x7da         |
| 4           | pointer DS0x1707, word(DS0x141)×2 bytes | pointer DS0x153e, word(DS0x141)×2 bytes |
| 5           | DS0x985, logic-frame serializer 0x1364  | DS0x7ea, logic-frame serializer 0x1579  |

In both builds, save leaves RNG unchanged and the restore I/O core preserves
the current RNG, not the value present when saving. Exact
`(saved RNG, current RNG before restore, RNG after restore)` vectors:
`(0,1,1)`, `(1,0,0)`, `(0xbeef,0x1234,0x1234)`, `(0xffff,0xbeef,0xbeef)`.
Main-state bytes actually restore; the synthetic files contain 1,633 bytes for
SQ2 and 1,156 for GR1, so this is not a no-op read/write probe.

Accepted restart was executed for RNG `[0,1,0xbeef,0xffff]` with f9 both clear
and set. It preserves RNG and f9, clears both DS timing words 0x129 and 0x12b
(initially 123 and 456), and sets f6. Original variable/flag clears and object
reset execute. No reseed occurs in this measured reset path, including when
RNG is zero. The two builds passed 24 combined save/restore and restart cases.

Restart peripheral intercepts are SQ2 `0x5234,0x382e,0x3726,0x30d6,0x930e,0x37f7`
and GR1 `0x5467,0x3b00,0x3ad9,0x3a29,0x341c,0x9648`; synthetic resource-loading
intercepts are SQ2 0x3113 and GR1 0x3459. Do not extend the conclusion to
unexecuted post-restore reconstruction, startup or other profiles.

Block 5's loaded-logic resume records are the restore's authoritative
loaded-logic set: the replay sequence's load-logic pairs cover only
game-issued `load.logics`, while `call`/`call.v` dispatch and `new.room` load
without pairs. Restore rebuilds the set in record order so every recorded
logic is resident at its saved scan-resume offset — a `call` back into a
scan-parked logic resumes there, not at the bytecode entry.

Acceptance contract: keep RNG and BIOS-reseed-input position out of
original `.SAV` blocks; preserve the current stream across authentic save,
restore and accepted restart. History anchors intentionally restore stronger
host state and must retain their explicit RNG/input position separately. Test
consume→save→consume→restore→consume against the current stream, and restart
at RNG zero followed by a random call: restart consumes no BIOS input; the
subsequent call consumes exactly one. Protect f9/f6 and timing-word behavior
through record→seek→resume. Original save block 2 copies raw object records;
replace the parameter bank using the proven offsets above. Complete
object-flag mapping and full `.SAV` interoperability remain unverified, alongside
startup and post-restore resource reconstruction. The inspected engine already
preserves host RNG on restart and excludes it from authentic saves.

```sh
python scripts/probe-interpreter-lifecycle.py /tmp/agi-fixed-sq2.bin
python scripts/probe-interpreter-lifecycle.py games/gr1/AGI
```

### Original parser unknown-word audit

The [input probe](../scripts/probe-interpreter-input.py) executes GR 3.002.149's
original `parse` wrapper at load-module offset 0x1be0 and `said` at 0x0baa.
Executable SHA-256 is `12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41`;
AGIDATA.OVL is `914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804`.
No parser helper is intercepted. A synthetic empty WORDS dictionary (52-byte
zero header) is installed at DS:0x6000 through pointer DS:0x0ab2. String 0 is
`xyzzy`. Original parsing sets word count DS:0x0ab0 to 1, first group at
DS:0x0a88 to zero, v9 to 1 and f2 true. Unknown text still occupies a parsed
word slot.

| Fresh parse, then said pattern | Original result | Current engine result |
| ------------------------------ | --------------- | --------------------- |
| [1] (anyword)                  | true            | false                 |
| [0]                            | true            | false                 |
| [9999] (rest of line)          | true            | true                  |
| [100]                          | false           | false                 |
| [1,1]                          | false           | false                 |

Success sets f4; another `said` then fails because input was consumed. Failure
leaves f4 clear. All five original cases passed; a deliberately incorrect
expectation for [100] failed. A separate current Engine execution reproduced
the differing rows. This proves the GR unknown-word boundary, not all profiles,
dictionary decompression cases or keyboard event timing.

Regression contract: preserve an explicit zero group for unknown
slots, or read implicit zero within the parser's authoritative word count.
`evalSaid` must test that count rather than only `parsedWords.length`; never
permit a wildcard beyond it. Preserve exact matching, f2/f4 and tail matching.
Include the consumed-input repeat and a parser snapshot roundtrip. Group zero
matching is observed behavior, not a recommendation for generated story code.

```bash
/tmp/agi-binary-venv/bin/python scripts/probe-interpreter-input.py games/gr1/AGI games/gr1/AGIDATA.OVL
```
