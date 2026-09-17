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

| Investigation                          | Current evidence and remaining acceptance                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler and modal timing             | [Coupled original IRQ, pacing and modal execution](#original-scheduler-and-modal-timing) covers representative v2/v3 builds, delay changes, backlogs and wait classes. Full-machine interrupt arrival, physical clock accuracy and successful disk-transfer latency remain outside this evidence.                                                 |
| Startup and restore reconstruction     | [Startup, reconstruction and main-loop control execution](#startup-and-reconstruction-execution) establishes cold defaults, lazy RNG seeding, resource replay, follower reset and same-cycle re-entry in two builds. Actual resource bodies, full DOS startup and object bit 0x8000 remain unverified; full `.SAV` interoperability is unclaimed. |
| Complete movement and collision passes | [Original dispatcher and movement execution](#original-complete-movement-and-follow-audit) covers seven builds and synthetic terrain/object/cadence vectors. Dispatcher cases intercept graphics and cel binding; separate cases execute the actual cel setter. This does not prove rendered-pixel or full-machine gameplay fidelity.             |
| Follow retries and older profiles      | The movement audit executes signed retry edges and stationary RNG rejection/call counts across the listed v2/v3 builds. Earlier profiles absent from that matrix remain unverified; no new profile distinction was inferred.                                                                                                                      |
| Chip and device semantics              | [Original sound execution](#signed-adjustment-and-device-2-edges) covers byte arithmetic and device-2 edges in four builds. TI documentation establishes programming formats, but zero-divisor and undocumented continuation behavior across chip variants still require independent hardware evidence.                                           |

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

Each executed movement pass zeroes the border variables v2, v4 and v5. When
no actor belongs to the updating list, the original dispatcher skips that
pass and leaves v2 intact; the top-level tail still clears v4/v5 separately.
See the [complete movement audit](#original-complete-movement-and-follow-audit).

Manhunter's v3 city map polls v2 for page turns.

Specification: The spec clears v4 and v5 at the cycle start and v2 only on room entry.

Evidence: the hash-pinned dispatcher and movement executions in that audit
cover both the eligible-actor and empty-list branches, with entry offsets.

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

### Original scheduler and modal timing

The [scheduler probe](../scripts/probe-interpreter-scheduler.py) executes
original machine code with Unicorn 2.1.4. It applies the MZ relocation table,
loads the matching data overlay and supplies controlled timer interrupts,
keyboard events, synthetic resource descriptors and graphics/device boundaries.
No original code bytes are included. This is **coupled routine and interrupt
handler execution**, not a booted DOS machine, wall-clock benchmark or
cycle-accurate PIT/BIOS/device model.

| Build              | Executable SHA-256                                                 | Data overlay SHA-256                                               | IRQ8 / INT1Ch       | Timer / pacing      | Print / editor / menu          |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------- | ------------------- | ------------------------------ |
| KQ3 2.936, decoded | `4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400` | `b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9` | `0x8521` / `0x854c` | `0x7efc` / `0x7f78` | `0x1ce8` / `0x0da9` / `0x93d1` |
| MH1 3.002.107      | `ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e` | `bb22a87cd215ed52154d49754493e0eb2f6be5688411d8f3b7ac17c417ddae1f` | `0x8978` / `0x89a3` | `0x8353` / `0x83cf` | `0x1fb7` / `0x0ffe` / `0x988d` |

Both builds produce these independently specified vectors:

- Sixty IRQ8 invocations, with a controlled BIOS callback adapter, execute
  twenty original INT1Ch timer services. The per-interrupt timer trace starts
  `0,0,1,1,1,2`; twenty services advance v11 once. A synthetic two-duration
  sound completes on the third hardware-handler invocation (`f40=false,false,true`).
  This measures ordering and counts; it does not prove real PC wall-clock timing.
- Pacing accepts v10 values 0, 1, 4 and 255 at the corresponding available
  counter values, clears the counter after one admission, and consumes a
  1,000-service backlog with one admission rather than a burst. Changing v10
  from 4 to 2 after two accumulated services immediately admits a pass.
- Ordinary print, text editor, menu, interactive inventory, show-object and
  show-priority waits retain timer services while their calling script is
  suspended. Twenty services advance v11 and pacing by one second and twenty
  increments. Timed print with v21=1 expires after ten services. Sound completion
  becomes visible before the ordinary wait is acknowledged.
- Explicit pause and save/restore selector wrappers suppress script-clock and
  pacing increments while the global timer continues. Cancelling either selector
  clears the pause word. The save/restore probe substitutes the selector boundary
  and exercises cancellation; it does not establish successful disk I/O timing.
- Each elapsed script second independently normalizes seconds `>=60`, minutes
  `>=60` and hours `>=24` after byte arithmetic. Initial `[80,80,30,7]` becomes
  `[0,0,0,8]`; `[255,90,30,255]` becomes `[0,0,0,0]`; `[0,60,0,0]` becomes
  `[1,0,1,0]`. Minute/hour checks are not conditional on a seconds carry.

The pause word is DS `0x615` / `0x618`; pacing counters are DS `0x1784` /
`0x1806`. Inventory waits execute at `0x3203` / `0x35b0`, show-object at
`0x5edb` / `0x6323`, show-priority at `0x731b` / `0x7772`, restore selector
wrappers at `0x2512` / `0x27f3` and save selector wrappers at `0x2753` /
`0x2a46`. Show-object uses a synthetic loaded description with preview allocation
unavailable; it establishes wait timing, not cel rendering. Graphics routines,
keyboard devices and resource lookup boundaries are intercepted explicitly.

The engine now lets ordinary modal time reach v11..v14, keeps explicit pause
and save selectors frozen, and normalizes script-written clock fields as above.
A mandatory host-checkpoint print field distinguishes pause from ordinary print;
no authentic save layout changes. Worker and walkthrough pacing retain the
pre-pause fraction/counter, including increments collected during a preceding
ordinary modal, without accumulating suspended time. Host harness
pause remains its separate reset policy. The host normalizes twenty pacing
increments to 1,000ms and sixty sound increments to 1,000ms; this is not an
assertion that every historical device had exact nominal frequency.

Tests: [original-scheduler.test.ts](../test/original-scheduler.test.ts),
[worker-original-scheduler.test.ts](../app/test/worker-original-scheduler.test.ts),
[cycle-clock.test.ts](../test/cycle-clock.test.ts),
[game-clock.test.ts](../test/game-clock.test.ts),
[message-modes.test.ts](../test/message-modes.test.ts).
The modal-clock, pause-pacing, selector-clock and out-of-range rollover
regressions failed against the prior implementation and pass the correction.
Full-machine boot, asynchronous interrupt arrival inside arbitrary instructions,
BIOS/PIT wall-time accuracy and successful disk-transfer latency remain outside
this probe's evidence.

### Timer-interrupt sound during blocking input

Sound is never pumped by the main interpreter loop. The v2 (KQ1, descrambled AGI) and v3 (MH1,
AGI 3.002.107) executables both service the sound player from a hardware timer interrupt handler,
so music keeps playing while the interpreter is blocked inside the get.string/get.num keyboard
editor: script execution and movers wait, while sound and the script clock continue.
The coupled execution evidence above verifies that distinction.

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
served normally, and the host services the interpreter clock using normalized
timer increments. The [original scheduler audit](#original-scheduler-and-modal-timing)
distinguishes waits that retain script time from explicit pause and save selectors. A poll that lands while a pass is parked
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

### Original complete movement and follow audit

`probe-interpreter-movement.py` executes original prelogic direction/rectangle
and postlogic object dispatchers, movement, collision, footprint, placement,
target and follow routines over independently supplied object records, cel
dimensions, direction/priority tables and control pixels. Graphics refresh and
the final cel-resource setter are intercepted; the latter records the selected
cel and supplies the independently specified dimensions for that cel. Ten
additional cases execute the original cel setter and dimension routine directly
with synthetic valid loop/cel descriptors. This is **routine execution**, not
full-machine execution or hardware measurement. No original instructions or game resources are published.

Each of seven hash-pinned builds passed 66 independently specified scenarios
(462 build/scenario results). Input hashes are the corresponding decoded or
already-MZ hashes in the verified-input table above. Load-module entry offsets:

| Build     | Prelogic objects | Postlogic objects | Movement | Collision | Footprint | Follow | Target | Cel setter |
| --------- | ---------------- | ----------------- | -------- | --------- | --------- | ------ | ------ | ---------- |
| 2.411     | 0x0611           | 0x0530            | 0x14b9   | 0x45e3    | 0x549f    | 0x0b03 | 0x1621 | 0x3bc9     |
| 2.439     | 0x0611           | 0x0530            | 0x14c7   | 0x460d    | 0x54c9    | 0x0b03 | 0x162f | 0x3bf3     |
| 2.917     | 0x0644           | 0x0563            | 0x150a   | 0x4719    | 0x55f0    | 0x0b36 | 0x1672 | 0x3ccb     |
| 2.936     | 0x0644           | 0x0563            | 0x150a   | 0x4719    | 0x56b8    | 0x0b36 | 0x1672 | 0x3ccb     |
| 3.002.086 | 0x0644           | 0x0563            | 0x1751   | 0x4b47    | 0x5ad3    | 0x0d75 | 0x18b9 | 0x4068     |
| 3.002.107 | 0x065b           | 0x0563            | 0x1767   | 0x4b5d    | 0x5ae2    | 0x0d8b | 0x18cf | 0x407e     |
| 3.002.149 | 0x0654           | 0x055c            | 0x1720   | 0x4974    | 0x58e5    | 0x0d84 | 0x1888 | 0x3f2f     |

The executed matrix includes ordinary and corner movement, the preserved
3.002.086 exact-zero-left variant, strict object-baseline crossing, collision
membership/exemption, controls 0–4, water/land gates, priority-15 bypass, target
arrival and boundary completion, movement and animation countdowns, configured
rectangle timing, and stationary follow RNG rejection paths.

Corrections established by these vectors:

- Horizontal screen bounds are resolved before vertical bounds. Simultaneous
  top/left or top/right reports border 1; bottom/left or bottom/right reports 3.
- A non-ego target actor completing at a border restores its saved step, sets its
  completion flag and clears target mode while preserving direction. Object 0
  also retains its direction byte at that instant but clears v6 and hands back
  player control; the following direction-coupling phase applies the zero.
- Follow retry subtraction is byte `SUB` followed by signed `JGE`; the overflow
  flag matters. Inputs `(retry,step)` `(128,1)`, `(127,255)` and `(1,128)` produce
  `0`, `128` and `129`, respectively, without consuming random draws. Testing
  only the wrapped result's sign is incorrect.
- Rectangle transition enforcement shares the prelogic countdown-equals-1
  condition with autonomous motion. Countdown 0 or 2 does not run that check.
- Animation countdown zero disables advancement. Movement countdown zero is due.
- Cel selection clips right overflow to `160-width` and top overflow to
  `height-1`, applying the horizon only when that top correction occurs. It
  preserves equal-edge, left and bottom coordinates, and suppresses the next
  due movement after a correction.
- Every eligible actor changes cel before any actor moves. A later actor growing
  or shrinking can therefore change the first actor’s collision result in the
  same pass.
- Water and land restrictions are independent bits. Setting both rejects ordinary
  footprints on water and land; priority 15 still bypasses the footprint test.
  `obj.on.anything` clears both. Save packing and navigation retain the combined
  constraint.
- After an executed postlogic updating-object pass, ego's water/land restriction
  bits are cleared. Non-ego restrictions persist. If no actor is eligible, the
  dispatcher skips movement and preserves ego's restrictions and v2. The broader
  top-level tail still separately clears v4/v5.

Matching cases were preserved: stopped-update actors remain collision candidates
(the original collision mask is drawn plus animated, 0x41; engine `update`
represents animated membership and `earlierPartition` encodes stopped update),
strict target bands, inclusive horizontal contact, strict baseline crossing,
control-2 trigger latching, all-cells-water classification, priority-15 bypass,
and movement countdown reload behavior.

For stationary follow with center separation 60, equal baselines and step 4,
seed 1 consumes two RNG draws and produces direction 5/delay 30/state 11127.
Seed 2 rejects direction zero and consumes three draws, producing 5/6/16929.
Seed 3 rejects two too-small distance remainders and consumes four draws,
producing 3/15/62591. Starting at RNG zero with supplied BIOS DX 0x1234 consumes
one BIOS read and two draws, producing 3/18/62114. This validates consumer call
counts rather than repeating exhaustive generator arithmetic checks.

Public synthetic regressions in `original-movement.test.ts` were observed
failing before the corresponding corrections, then passing. The preserved
stopped-update collision case was also checked against a deliberately incorrect
partition-exclusion mutation. Object-cadence and ego-control regressions remain
green. These probes do not establish real interrupt cadence, original rendered
pixels, arbitrary malformed object records, or full-machine gameplay behavior.

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

#### Signed adjustment and device-2 edges

The expanded sound probe executes all 8,192 combinations of base attenuation
0..15, v23 0..255 and device 1/2 in each of the three hash-pinned builds above
and KQ3 2.936. Its corrected decoded executable hash is
`4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400`,
with overlay hash
`b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9`.
The KQ3 probe enters sound at 0x51d3, substitutes lookup at 0x50d8,
ticks at 0x801c and stops at 0x5234; it also passes the prior lifecycle,
noise and 68-step envelope expectations.
These are isolated player-routine executions with captured port writes, not
audible chip measurements. KQ1's adjustment sequence at 0x80f3..0x8108 adds
into an 8-bit register and uses signed comparisons; the corresponding v3
execution produces the same boundary outputs. The engine now preserves those
byte operations instead of applying an unsigned saturating sum.

Representative first-tick `(device, base, v23) → port byte` vectors:
`(1,0,128) → 0x90`, `(1,0,255) → 0xff`, `(1,7,127) → 0x94`,
`(2,0,255) → 0x91`, `(2,14,128) → 0x9e`, `(2,8,250) → 0x92`.
High adjustments can affect register-selector bits. Base 15 bypasses the
adjustment; hold/noise cases retain the already-established bypass behavior.
The synthetic [sound tests](../test/sound-playback.test.ts) failed against the
unsigned clamp and pass with the byte-accurate calculation.

#### Chip evidence boundary

The [TI SN76489AN datasheet](https://ftp.whtech.com/datasheets%20and%20manuals/Datasheets%20-%20TI/SN76489.pdf),
sections 4–6, documents two-byte tone programming, continued tone updates while
the same register remains selected, and single-byte attenuation/noise writes.
Those documented formats do not establish what every chip variant does with
a continuation byte after an attenuation/noise latch, nor resolve divisor-zero
behavior for PCjr/Tandy devices. No independent silicon measurement was made.
The browser's analog/noise synthesis remains an approximation; software port
traces establish command bytes and completion behavior only.

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
intercepts are SQ2 0x3113 and GR1 0x3459. The reconstruction and startup investigation below extends this boundary in
these two builds; it does not establish other profiles or full-machine startup.

Block 5 supplies resume offsets for loaded logic; the reconstruction execution
below establishes which resources actually load. Exact host history separately
restores the complete captured cache boundary.

Acceptance contract: keep RNG and BIOS-reseed-input position out of
original `.SAV` blocks; preserve the current stream across authentic save,
restore and accepted restart. History anchors intentionally restore stronger
host state and must retain their explicit RNG/input position separately. Test
consume→save→consume→restore→consume against the current stream, and restart
at RNG zero followed by a random call: restart consumes no BIOS input; the
subsequent call consumes exactly one. Protect f9/f6 and timing-word behavior
through record→seek→resume. Original save block 2 copies raw object records;
replace the parameter bank using the proven offsets above. Full `.SAV` interoperability remains unverified: the original flag mapping
below is distinct from the engine’s private packing, and bit 0x8000 has no
established operational meaning. The engine preserves host RNG on restart
and excludes it from authentic saves.

```sh
python scripts/probe-interpreter-lifecycle.py /tmp/agi-fixed-sq2.bin
python scripts/probe-interpreter-lifecycle.py games/gr1/AGI
```

#### Startup and reconstruction execution

The lifecycle probe now executes game-state startup, restore reconstruction
control flow, opcode return and object flag transitions in corrected decoded
SQ2 2.936 and GR1 3.002.149. The executable hashes above remain authoritative.
Matching AGIDATA.OVL hashes are
`b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9`
(SQ2) and
`914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804`
(GR1). This is routine execution with controlled resource returns, not full
DOS-machine execution. Hardware initialization, disk/resource bodies, drawing
and presentation are explicitly intercepted; exact addresses are in the probe's
profile tables and reports. Main-loop control is separately executed with
controlled logic return values; game LOGIC bodies remain outside that probe.

| Executed boundary                   | SQ2 2.936      | GR1 3.002.149  |
| ----------------------------------- | -------------- | -------------- |
| Game-state startup                  | 0x0f4e         | 0x115c         |
| Main-loop control                   | 0x0150         | 0x0149         |
| Reconstruction                      | 0x681c         | 0x6b94         |
| Successful restore tail through RET | 0x2647..0x26af | 0x28c7..0x2941 |
| Logic cache reset                   | 0x10f7         | 0x1305         |
| Resume lookup                       | 0x13a5         | 0x15ba         |
| animate.obj body                    | 0x04f5         | 0x04ee         |
| draw body                           | 0x0a06         | 0x0c54         |
| erase body                          | 0x0aab         | 0x0cf9         |
| unanimate.all                       | 0x053d         | 0x0536         |
| Stationary/previous-position update | 0x0488         | 0x0481         |

Both hash-pinned overlays initialize the RNG word to zero. The executed
startup core does not write that word or request BIOS time. After startup,
the first random call consumes exactly one controlled BIOS DX input. Inputs
`0, 1, 0x1234, 0xffff` produce RNG words `1, 0x7c4e, 0xa9a5, 0x83b4`.
The authored encrypted OBJECT fixture produces two zeroed 43-byte records
with table indices 0 and 1; startup sets f5 and f9 and assigns v24=41.
This does not establish
full executable-entry or hardware initialization behavior; those boundaries
remain explicit gaps.

Reconstruction executes all nine replay kinds, including the three additional
pairs consumed by kind 5, with recording disabled, then re-enables recording.
Resource loading and rendering are intercepted; actual cache reset, allocator
reset, resume lookup, object bookkeeping and flag writes execute. It retains
the existing global-logic cache head and truncates later cached nodes. With
saved resume records for logic 21 at offset 0x33 and an unreplayed logic 99,
only the kind-0 pair for 21 requests a load and receives offset 0x33; record
99 issues no load. Block 5 is a resume lookup, **not an authoritative load
list**. This corrects the previous stronger claim. Host history intentionally
retains the stronger complete loaded-logic boundary separately.

For drawn, animated followers, reconstruction resets record byte 0x29 (the
follow retry byte) to 255. It preserves the other three parameter bytes,
position and saved flags. Undrawn followers and other motion modes retain the
saved retry byte. The matrix covers seven flag words and all four motion
modes in each build. The successful restore tail sets f12 and returns zero,
aborting the old bytecode continuation. The engine now applies these effects
to authentic restores; exact host history retains its saved retry and f12.
Public synthetic tests observe f12 in the first resumed script and its clearing
at the normal cycle tail.

The original main loops execute with controlled logic-call results `[0,1]`,
representing the separately proven restore/restart zero return followed by an
ordinary completed logic pass. Both execute one input phase and one pre-logic
motion phase, call logic twice without an intervening scheduler wait, then
execute one post-logic movement phase. The second logic observes f6 or f12;
the same cycle tail clears that flag. The engine now resumes successful
restore/restart inside its current logic loop. Quit and refused authoring
retain their separate stop behavior. Direct host image restoration still
returns without running game logic. New synthetic regressions fail when
resumption is delayed to another tick and pass after this correction.

Startup now initializes f9=1 and v24=41; accepted restart restores v24=41
while preserving the pre-restart sound preference. Hosts can still apply a
player-selected sound preference after construction.

The opcode dispatch tables (SQ2 DS0x061d; GR1 DS0x0440) select the original
handler addresses used by the flag probes. Each setter/clearer executes from
both zero and all-set flag words. Draw, erase and animate transitions plus
stationary updates supply additional flag evidence. The current mapping is:

| Original bit | Meaning                                            | Evidence                                        |
| ------------ | -------------------------------------------------- | ----------------------------------------------- |
| 0x0001       | Drawn                                              | Draw sets; erase clears                         |
| 0x0002       | Ignore configured block rectangle                  | ignore.blocks / observe.blocks                  |
| 0x0004       | Fixed priority                                     | set.priority / release.priority                 |
| 0x0008       | Ignore horizon                                     | ignore.horizon / observe.horizon                |
| 0x0010       | Updating partition                                 | start.update / stop.update; draw sets           |
| 0x0020       | Cycling                                            | start.cycling / stop.cycling                    |
| 0x0040       | Animated membership                                | animate.obj; unanimate.all clears               |
| 0x0080       | Configured-rectangle crossing blocked              | Complete movement probe                         |
| 0x0100       | Water requirement                                  | obj.on.water; obj.on.anything clears            |
| 0x0200       | Ignore other objects                               | ignore.objs / observe.objs                      |
| 0x0400       | Pending reposition/cel-change movement suppression | Complete movement probe                         |
| 0x0800       | Land requirement                                   | obj.on.land; obj.on.anything clears             |
| 0x1000       | Initial animation delay                            | end.of.loop / reverse.loop set; draw clears     |
| 0x2000       | Fixed loop                                         | fix.loop / release.loop                         |
| 0x4000       | Stationary on the due movement cadence             | Original refresh-list pass                      |
| 0x8000       | No operational meaning established                 | Preserved by tested handlers; not proven unused |

Repeated animate.obj preserves already animated records even when their update
partition is stopped. Erase preserves animation membership; unanimate.all clears
only drawn/animated bits. The engine's `active` means drawn, `update` means
animated membership, and `earlierPartition` is inverse update-partition selection.
These names and the engine's packed save bits are distinct from the original
bit assignments. Original raw save-bit interoperability remains unclaimed,
particularly for 0x8000 and combinations not established by execution.

Across the two builds the probe checks 204 controlled vectors: preserved I/O
and restart cases, 56 reconstruction/return cases, 12 object lifecycle cases,
24 stationary cases, eight startup cases, 76 opcode flag mutations and four
main-loop continuation cases.

### Original add.to.pic control box

Static disassembly of the descrambled LSL1 2.440 and KQ3 2.936 images (hashes
under [Original string slot addressing](#original-string-slot-addressing)).
The `add.to.pic` handlers at 0x2c7a/0x2cca (2.936) pack the margin operand into
the high nibble of the priority byte and call the shared core at 0x2d52, which
stamps the cel through the routine at 0x57cf (2.936) / 0x55f0 (2.440). The two
routines are instruction-for-instruction identical apart from data addresses.

Fact: after the cel is drawn, the routine returns if the packed byte exceeds
0x3f, which is a margin of four or more. Otherwise it counts rows upward from
the baseline while the y-to-priority table gives the baseline's band, caps that
count at the cel height, and writes the margin into the priority nibble of: the
whole baseline row across the cel width; the first and last column of each
higher row; and the columns strictly between them on the top row. A box one row
tall is the baseline row alone. Fact: a priority operand whose low nibble is
zero takes the baseline's band. Not modelled: the top-row loop counts
`width - 2` in an eight-bit register without a zero test, so a cel narrower
than three pixels overruns in the original. No routine was executed; 2.903 and
the v3 builds were not inspected, and the engine applies the same box to every
profile by inference.

Behavioral witness: Police Quest logic 26 places Dooley's car with margin 0 and
then positions an officer beside it; with a baseline-only line the placement
search accepts a spot from which his scripted walk jams on that line. Space
Quest logic 3 places the dead crewman with margin 0; the box x126..149,
y63..71 makes the body solid, and the keycard remains reachable because the
room's `posn` test covers the doorway.

Tests: [opcodes.test.ts](../test/opcodes.test.ts); the SQ1 walkthrough crosses
room 3.

### Original string slot addressing

Static disassembly of two descrambled v2 images: LSL1 2.440
(`c70e2f327eaad8dbcb1d526e9fb3f933b342329b84c6a803f9062c245ccb7676`) and KQ3
2.936 (`4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400`).
Both address a string operand as `DS:0x020d + slot × 40`, the multiplier read
from a code-segment word holding 40.

| Build | Unchecked sites (load-module offsets)               | Checked site                  |
| ----- | --------------------------------------------------- | ----------------------------- |
| 2.440 | 0x0c35, 0x0d18, 0x0d51, 0x0ed8 (comparison), 0x1ff6 | 0x1944 `cmp ax,0xc` (`parse`) |
| 2.936 | 0x0c68, 0x0d4b, 0x0d84, 0x0f0b, 0x2033, 0x273e      | 0x1981 `cmp ax,0xc` (`parse`) |

Fact: only `parse` compares its slot with twelve; prompted input, `set.string`,
`word.to.string`, the string comparison and `%s` formatting use the computed
address unchecked. Fact: LSL1 logic 22 stores an alternative telephone spelling
with `set.string(s12, …)` and tests `compare.strings(s1, s12)`; logic 0 does
the same with s11 and s12. Inference: the twelve reserved 40-byte records the
save layout places directly after the table are what s12..s23 address, so such
a write is readable and is saved. Inference: the six-slot profiles behave the
same way over their six reserved records, and 3.002.149, whose layout has no
reserved bank, has nothing safe behind s11. No routine was executed and no
early or v3 image was inspected for this entry.

The engine keeps the table and its reserved records as one bank: every string
operand except `parse` reaches it, `parse` stops at the profile's slot count,
slots past the bank are ignored on write and read empty, and the save image
carries the reserved records.

Tests: [string-bank.test.ts](../test/string-bank.test.ts),
[profile.test.ts](../test/profile.test.ts).

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
