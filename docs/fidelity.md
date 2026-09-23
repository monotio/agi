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

The engine lets ordinary modal time reach v11..v14, keeps explicit pause
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
execution produces the same boundary outputs. The engine preserves those
byte operations rather than applying an unsigned saturating sum.

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

#### Original stop-sound call sites

Static KQ3 2.936 evidence (decoded hash above). The shared stop helper at
0x5234 tests the playback word DS:0x1258 and, when nonzero, clears it, calls
the flag setter with the stored done-flag index DS:0x126a and silences the
driver through 0x80af — the same routine new.room calls first (0x1797). Its
call sites establish where a playing sound's done flag is written:

- `stop.sound` wrapper 0x5225 and the `sound` action 0x51d8 (before the new
  flag index replaces DS:0x126a).
- Pause 0x257 (after input drain, before the pause message box).
- `quit.game` 0x27f: the stop runs before the operand is read, so both the
  immediate form and a **declined** prompt complete the flag.
- `restart.game` 0x2472: the stop runs before the f16 bypass test and the
  confirmation box — a declined restart likewise completes the flag.
- The shared save/restore selector 0x85e8 at 0x85fc, before the file-list UI:
  opening the selector completes the flag.
- The error path 0x3fe8 and the restore/reset path 0x681c.

Engine: `selectSavedGame`, `restart.game`, pause and `quit.game` call
`stopSound` at the matching points, and the quit stop precedes the operand
branch so a declined prompt completes the flag. SQ2 2.936's restart intercept
list (above) contains the same 0x5234 helper, consistent with the shared 2.936
core.

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
aborting the old bytecode continuation. The engine applies these effects
to authentic restores; exact host history retains its saved retry and f12.
Public synthetic tests observe f12 in the first resumed script and its clearing
at the normal cycle tail.

The original main loops execute with controlled logic-call results `[0,1]`,
representing the separately proven restore/restart zero return followed by an
ordinary completed logic pass. Both execute one input phase and one pre-logic
motion phase, call logic twice without an intervening scheduler wait, then
execute one post-logic movement phase. The second logic observes f6 or f12;
the same cycle tail clears that flag. The engine resumes successful
restore/restart inside its current logic loop. Quit and refused authoring
retain their separate stop behavior. Direct host image restoration still
returns without running game logic. Synthetic regressions fail when
resumption is delayed to another tick.

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

`animate.obj` writes only the flag word (0x70: update|cycling|animated, wiping
the other tested bits) and zeroes record bytes 0x21..0x23; it touches no cadence
or dimension scalar (KQ3 2.936 handler at 0x4d9, body 0x4f5; the same narrow
write set in the SQ2/GR1 bodies above). Because the state initializer produces
zeroed records, an animated-but-unconfigured object keeps step interval,
countdown, step size, cycle interval/countdown, width and height all zero: a
zero movement countdown is due every pass but step size 0 moves no pixels, a
zero animation countdown never advances the cel, and the pre-logic direction
pass (countdown == 1) never runs. Games get usable cadence from step.size,
step.time and cycle.time, and `new.room` separately resets the cadence fields
to 1. Fresh engine records are zeroed the same way, so a synthetic test or an
authored intro that animates an object before its first `new.room` sets
`step.size` and `cycle.time` itself, as the shipped games do.

Across the two builds the probe checks 204 controlled vectors: preserved I/O
and restart cases, 56 reconstruction/return cases, 12 object lifecycle cases,
24 stationary cases, eight startup cases, 76 opcode flag mutations and four
main-loop continuation cases.

### Free memory in v8

Static disassembly of the Gold Rush 3.002.149 executable. The routine at 0x16b6
stores `(heap end − heap pointer) >> 8`, the free heap in 256-byte pages, into
v8; it runs on heap reset and after every resource allocation and release, and
KQ3 2.936 has the same store at 0x14a2. Fact: v8 is the low byte of the free
page count, so a machine with 256 or more free pages reports a small number.
Gold Rush logic 0 refuses the help menu below six pages and the bible and
psalm below eight. Engine decision: there is no heap ceiling here, so v8
reports 255 at boot, at restart and at the start of every cycle, which is the
ample-memory behavior of a well-configured original installation; the value a
particular original machine showed is not reproduced.

Tests: [opcodes.test.ts](../test/opcodes.test.ts).

### Original player.control handler

Static disassembly of the descrambled KQ3 2.936 image. The handler at 0x7041
stores 1 in the direction-coupling word at DS:0x0139 and clears object 0's
motion-type byte (record offset 0x22); `program.control` at 0x7034 stores 0 and
touches nothing else. Fact: `player.control` ends a running `move.obj`,
`wander` or `follow.ego` on object 0 without changing its direction byte. The
engine only switched the coupling, so a scripted ego walk continued after the
script had handed control back; Police Quest depends on the stop.

Tests: [ego-motion-control.test.ts](../test/ego-motion-control.test.ts).

### Original new.room sequence

Static disassembly of the descrambled KQ3 2.936 image (`new.room` wrapper
0x175c → core 0x1792); Gold Rush 3.002.149 is identical except it skips the
VOL-handle close and, when ego's motion-type byte is 4, also clears it and
zeroes v6 (0x1c62). The ordered effects: stop sound and set its done flag;
free heap and recompute v8; drain the BIOS buffer and event queues; journal
reset; an object loop writing `flags &= ~0x41; flags |= 0x10` and reloading
the cadence scalars to 1 for every record; truncate the resource lists;
direction coupling = 1, unblock, horizon = 36; v1 = v0, v0 = room, v4 = v5 = 0;
v16 = ego view; load the room logic; reposition ego from v2 and clear it;
set f5; clear the mapped controller array; redraw status and input line.

Consequences the engine models:

- The object loop **selects** the updating partition (0x10) while clearing
  drawn (0x01) and animated membership (0x40). A stopped-update actor
  rejoins the updating partition across a room change.
- The transition tail memsets the 50-byte mapped controller array (core
  0x189d, the same routine the loop top calls before the input phase). The
  handler then returns the zero continuation result, taking the main loop's
  shared re-entry path (0x1c7): v9, v4, v5 and f2 clear and logic 0
  re-invokes in the same pass without an input phase. Only v19 and f4 set
  by the old room's last pass remain visible to the new room's first logic
  pass; the next cycle's ordinary input phase clears them.
- Ego's motion-type byte is untouched by the transition, so a
  `move.obj`/`wander`/`follow.ego` in progress at a room boundary survives
  as latent state — but it can never steer again: the object loop cleared
  the animated-membership bit (0x40), only `animate.obj` sets it, and its
  write path clears the motion type (0x52d). The byte ends either on the
  new room's first `animate.obj(ego)` or on a direction event: the
  direction-event case (0x3616, reached only from the type-2 entry in the
  event jump table at 0x3648) writes v6, then forces ego's motion type to
  0 while coupling is 1.

Engine decision: v8 reports the ample-memory constant 255 (see "Free memory
in v8"), so the new.room recompute writes the same value the cycle start
already refreshes.

Tests: [object-cadence.test.ts](../test/object-cadence.test.ts).

### Original message formatter

Static disassembly of the unscrambled Gold Rush 3.002.149 executable. The
formatter at 0x2208 walks the source once. On `%` it reads one letter and
dispatches through the table at 0x23a4: `g` (a message of logic 0, formatted
by a recursive call), `m` (a message of the current logic, recursive), `o` (the
inventory item named by the variable, recursive), `s` (a string slot,
recursive), `v` (the variable as decimal, with `|` width zero-padded) and `w`
(a parsed word, recursive). Any other letter is skipped with its percent sign.
Output is appended, never rescanned. The comparison with nineteen at 0x2221
bounds the output line counter at DS:0x0b26, not recursion depth: 0x25bc
increments that counter at a line boundary. A recursion-depth limit does not
implement that contract and still permits exponential expansion.
Fact: a `%v` value cannot extend a code before it. Police Quest prints
`%m1%v…`, which the engine's earlier `%v`-first pass turned into a different
message number. `%g` and `%o` were missing altogether. v2 images were not
inspected; the engine applies the table to every profile by inference.

Independent execution of the same Gold Rush 3.002.149 load module
(`12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41`), with
AGIDATA.OVL
(`914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804`), confirms
three additional contracts. A synthetic call to 0x21c9 uses a shared stack
and data segment, width 40, and synthetic strings and logic message tables;
only the logic-resource lookup at 0x131d is intercepted to return the
synthetic logic 0 record. The formatter and message lookup execute unchanged.

- `%g1`, with global message 1 `%m2`, global message 2 `GLOBAL` and the
  caller's message 2 `LOCAL`, produces `GLOBAL`. The code at 0x22d7..0x2306
  temporarily selects logic 0 for the recursive expansion, then restores
  the caller's message context.
- `%s1|5`, with s1 `hello`, produces `hello|5`; only `%v` consumes the width
  suffix (0x2331..0x2352). `100%% done` produces `100 done`, and `%Q42`
  produces `42`, confirming dispatch consumes any next character, not just
  lowercase letters. A separate `tail%` probe produces `tail` and returns,
  confirming a final percent sign is discarded.
- `%s1`, with s1 `x%s1%s1%s1`, returns 820 bytes at width 40: twenty lines
  of forty `x` characters, each followed by a newline. This witnesses the
  shared output-line bound across recursive inserts. It does not establish
  safe behavior for a recursion cycle that never emits a character.

The engine uses an explicit insert stack that carries the message context,
without a depth cutoff. Shared limits of 800 emitted characters (twenty
40-column rows) and 16,384 scan steps terminate productive expansion and
non-emitting cycles within one opcode. Exhausting either returns the prefix
already emitted. These are host safeguards, not a claim of identical original
line layout: newlines count toward the character capacity, and window wrapping
remains a separate step at the requested width. The original's exact line-bound
geometry is not reproduced by this character-capacity guard. Only `%v` consumes
a width suffix; unknown codes consume `%` and its following character.

Tests: [message-format.test.ts](../test/message-format.test.ts),
[opcodes.test.ts](../test/opcodes.test.ts). The prompt-to-print regression runs
in a subprocess with a timeout so a monopolized formatter fails the test instead
of hanging the test runner.

### Original previous-position commit

Static disassembly of the descrambled KQ3 2.936 image. The collision routine at
0x4719 compares the mover's and the other actor's word at record offset 0x18
with their baselines at 0x05. That word has four writers: `position` and
`position.v` (0x7c1c, 0x7c5a), `draw` (0x0a5a) and the sprite-list commit at
0x048c..0x04d8. For each listed actor whose step countdown equals its step
time, the commit sets state bit 0x4000 when x and y equal the saved pair, and
otherwise copies x and y into 0x16/0x18 and clears the bit. Fact: the movement
routine does not write the saved pair. Inference from that placement: the pair
changes once per pass after every actor has moved, so a later actor in the pass
tests against an earlier actor's pre-move value, and on the next pass a mover's
saved baseline equals its current one. No routine was executed for this entry;
the executed movement vectors above used steps for which both readings agree.

The engine commits the pair the same way, after the whole pass has moved and
only for actors whose countdown reloaded, and derives the stationary bit from
that comparison. A pair written inside the move would sit one step stale: an
actor stepping one pixel per pass past a standing actor's corner would be
judged to have crossed its baseline a pass late and stop for good. Police
Quest logic 37 walks the bikers out past a scripted ego position this way.
Because `reposition` and cel clipping move x/y without touching the pair, an
actor they move reads as moved even when its own step lands back on its feet;
Space Quest II's swamp lurker, nudged by its room script while it follows
Roger, walks straight at him for that reason instead of sidestepping.

Tests: [original-movement.test.ts](../test/original-movement.test.ts).

### Original show.obj description formatting

Static disassembly of the unscrambled Gold Rush 3.002.149 executable
(`12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41`). The
preview routine ending at 0x63a5 draws the cel, takes the view resource pointer
`di`, pushes `di + word [di+3]` (the embedded description) and calls the message
box at 0x1f70. The `print` handler at 0x1e8e calls the same routine with a
looked-up message, and that routine's window builder at 0x201e runs its text
through the formatter at 0x21c9. Fact: a view description receives the same
`%` expansion as a printed message. Gold Rush's bank statement relies on it to
show the account number held in a variable. v2 images were not inspected; the
engine applies the formatting to every profile by inference.

Tests: [opcodes.test.ts](../test/opcodes.test.ts).

### Original obj.status.v modal

Static disassembly of the descrambled KQ3 2.936 image. The handler at 0x72b5
resolves the operand variable, indexes the object table, and sprintf-formats
seven values — the object number and record fields x (+0x3), width (+0x1a),
y (+0x5), height (+0x1c), priority (+0x24), step size (+0x1e) — through the
format string at DS:0x1713 (`Object %d:\nx: %d  xsize: %d\ny: %d  ysize:
%d\npri: %d\nstepsize: %d`, recovered from AGIDATA.OVL file offset 0x1713,
SHA-256 `b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9`).
It then calls the shared message box at 0x1ce8 — the same routine print uses,
with its f15 non-blocking path and v21-timed wait — and returns the following
stream pointer, so the pass suspends inside the call until a key or the
timeout closes the window. Fact: `obj.status.v` is a real modal diagnostic,
not a log. In the shipped games it sits only in debug-gated logic (KQ3 logic
99 behind controller 21/36 and debug `said` phrases), unreachable in normal
play.

Tests: [opcodes.test.ts](../test/opcodes.test.ts).

### Original position handlers

Static disassembly of the KQ4 3.002.086 executable
(`b9b27b403015bb18f6562ba1b8b04c2829e0c3b53c042196bee7924d1df7be65`) and the
descrambled KQ3 2.936 image. `position` (0x805a in 3.002.086, 0x7c1c in 2.936)
and `position.v` (0x8096, 0x7c5a) store the two operands into the record's x
and y and into the saved pair at 0x16/0x18, and nothing else. `reposition`
(0x7ce7 in 2.936) ORs state bit 0x400 into the record before applying its
deltas, then calls the placement spiral at 0x593a (horizon clamp, bounds,
collision and control checks, then a widening search), the routine the
movement pass also enters when it rejects a step; `reposition.to` (0x7d77)
and `reposition.to.v` end in the same call. Placement therefore runs inline
at script time, and the 0x400 flag still turns the object's next due step
into a zero-step re-check. Fact: only the reposition family and cel clipping
mark an object newly positioned (the five `or 0x400` sites in each image),
and the spec's `position` entry says the same. A placement pass after
`position` would suppress the first real step, and under 3.002.086 it would
report an exact zero left edge as border 4, so King's Quest IV's room 28,
which positions ego at x=0 and starts the unicorn ride, would bounce between
rooms 27 and 28 for good.

The engine follows the originals in every profile: `position` and
`position.v` store the coordinates and the saved pair only, and the
reposition family places inline and marks the object.

Tests: [original-movement.test.ts](../test/original-movement.test.ts).

### Original cel blit over control pixels

Static disassembly of the Gold Rush 3.002.149 executable. The cel blit at
0x5be3, which `add.to.pic` reaches through 0x5a1e, tests each opaque pixel's
destination priority nibble. A value of 0x20 or below (control 0..2) sends it
to 0x5c74, which scans down the column to the first pixel above 0x20; if that
priority is not above the cel's, it jumps to 0x5c5f, which ORs the colour into
the register still holding the destination's control nibble and stores that.
Ordinary pixels go through 0x5c5d, which loads the cel priority first. Fact: a
painted cel changes a control pixel's colour and keeps its control value.
Gold Rush's post office relies on it: logic 9 places the closed door panel
over the trigger column at x=53 that its door script needs to stay set until
ego is nearly through, and the door can be entered only while that column
survives. The engine had written the cel priority over control pixels, which
made the door impassable. The 2.440 and 2.936 blits live in their object
overlays and were not inspected; the engine applies the rule to every profile
by inference.

Tests: [view.test.ts](../test/view.test.ts), [opcodes.test.ts](../test/opcodes.test.ts).

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
python scripts/probe-interpreter-input.py games/gr1/AGI games/gr1/AGIDATA.OVL
```

### Amiga interpreter profiles

The six Amiga editions ship their own interpreter series as Amiga Hunk
executables (load-module magic `0x000003f3`); no PC-style `AGIDATA.OVL` or
`AGI` file exists. Each binary carries its own "Version" string, so the Amiga
builds are profiled on their own numbers rather than borrowed PC profiles.

| Fixture                 | Executable | Version | Size   | SHA-256 (first 16 hex) |
| ----------------------- | ---------- | ------- | ------ | ---------------------- |
| `games/sq1-amiga/`      | `Sierra`   | 2.082   | 86280  | `80c6b0c4912a4ca5`     |
| `games/kq2-amiga/`      | `KQ2`      | 2.176   | 128488 | `62b17ac8049a982e`     |
| `games/sq2-amiga/`      | `SQ2`      | 2.202   | 128708 | `557215fbbf431193`     |
| `games/pq1-amiga/`      | `PQ`       | 2.310   | 134160 | `72ddbb3ecda804b8`     |
| `games/goldrush-amiga/` | `GR`       | 2.316   | 134852 | `7bfa2f36616923a4`     |
| `games/mh2-amiga/`      | `MH2`      | 2.333   | 135016 | `5ce3b163bd32ee02`     |

Dispatch tables are six-byte records `{u32 handler_ptr, u16
operandCount<<8 | varOperandMask}` in a data hunk; the handler longwords are
relocation slots. The action dispatcher rejects structural bytes (`>= 0xfc`),
then compares the opcode against the record count with an inclusive branch;
the last real opcode is therefore one below the count, and the count itself
passes the bound and fetches its handler from past the table — SQ2's action
hunk h5 is exactly 1020 bytes (170 records), GR's 1100 (183 records and two
pad bytes). That opcode is a wild dispatch with no defined behavior; the
engine rejects it as an unavailable opcode. The condition dispatcher compares
with a strict below on 2.176 and later; 2.082's is inclusive (¹). Table sizes
and the bounds read off each binary:

| Build | Action compare                 | Slots | Ceiling             | Condition compare               | Slots | Ceiling |
| ----- | ------------------------------ | ----- | ------------------- | ------------------------------- | ----- | ------- |
| 2.082 | `cmpi.l #$a1, ble` h5 @0x00aee | 161   | 0xa0 `disable.item` | `cmpi.l #$13, bls` h17 @0x02218 | 19    | 0x13 ¹  |
| 2.176 | `cmpi.b #$aa, bls` h6 @0x00a16 | 170   | 0xa9 `close.window` | `cmpi.b #$13, bcs` h23 @0x01e06 | 19    | 0x12    |
| 2.202 | `cmpi.b #$aa, bls` h6 @0x00a16 | 170   | 0xa9                | `cmpi.b #$13, bcs` h23 @0x01e06 | 19    | 0x12    |
| 2.310 | `cmpi.b #$b7, bls` h6 @0x00a72 | 183   | 0xb6                | `cmpi.b #$14, bcs` h23 @0x02102 | 20    | 0x13    |
| 2.316 | `cmpi.b #$b7, bls` h6 @0x00a72 | 183   | 0xb6                | `cmpi.b #$14, bcs` h23 @0x02102 | 20    | 0x13    |
| 2.333 | `cmpi.b #$b7, bls` h6 @0x00a72 | 183   | 0xb6                | `cmpi.b #$14, bcs` h23 @0x020d6 | 20    | 0x13    |

The embedded opcode name table (index == opcode) matches the PC vocabulary
through 0xaf apart from spelling. The 2.31x tail is `set.simple` 0xaa,
`push.script` 0xab, `pop.script` 0xac, `hold.key` 0xad, `set.pri.base` 0xae,
`discard.sound` 0xaf, `hide.mouse` 0xb0, `allow.menu` 0xb1, `show.mouse` 0xb2,
`fence.mouse` 0xb3, `mouse.posn` 0xb4, `release.key` 0xb5 and
`adj.ego.move.to.x.y` 0xb6 (two immediate operands). Handler pointers group
the tail: `menu.input`, `open.dialogue`, `close.dialogue`, `hold.key`,
`hide.mouse`, `show.mouse` and `release.key` share one stub routine;
`set.pri.base`, `discard.sound` and `allow.menu` share a one-operand skip;
`fence.mouse` shares a four-operand skip. The same stub pattern holds on the
2.176/2.202 tables where the slots exist; on 2.082 the stubbed slots are
above the action bound. `mouse.posn` is a real handler that writes the
latched click X/2 and Y into its two variable operands, and
`adj.ego.move.to.x.y` zero-extends its two operand bytes into the click-move
nudge words ([Original click-to-walk](#original-click-to-walk)). Condition
0x13 (`click.move.pending`) tests ego's motion mode against the click-move
mode 4; Gold Rush's logics 1, 3, 5, 6, 137 and 192 gate on `not` of it.

¹ The 2.082 condition compare is inclusive (`bls`), so 0x13 dispatches, but
the handler table at h18+0x0 is 116 bytes — nineteen six-byte entries for
0x00..0x12 and two pad bytes. Slot 0x13 reads its handler longword from the
pad and the bytes past the hunk, a wild `jsr (a1)` (h17+0x6c..0x98), the same
table overrun as the IIgs evaluator's. `amiga-2.082` therefore bounds at 0x13
with `condition0x13: "wild-dispatch"`, and the assembler rejects the name.

The screen-object record is 72 bytes (stride `0x48`, PC 43), big-endian
throughout; `position` writes x/y and the saved pair with no flag, like PC.
`quit` (0x86) consumes one operand byte on every Amiga build, including
2.082. The record layout is read off the field-writing handlers (SQ2 2.202,
`set.step.time`, `position`, `set.view`, `set.loop`, `set.cel`, `set.dir`,
`move.obj`, `normal.cycle` and friends) and confirmed against the shipped
save images, whose block 2 is N × `0x48` records (SQ2: `0x5e8` = 21
records; SQ1: `0x510` = 18):

```text
+0x00 step time     +0x02 step count    +0x04 table index
+0x06 x             +0x08 y             +0x0a view
+0x0c..+0x27 five view-cache pointers (view, loop, cel, cel desc, header)
+0x10 loop          +0x12 loop count    +0x18 cel    +0x1a cel count
+0x28 previous x    +0x2a previous y
+0x2c width         +0x2e height        +0x30 step size
+0x32 cycle time    +0x34 cycle count   +0x36 direction
+0x38 motion mode   +0x3a cycle mode    +0x3c priority
+0x3e flag word     +0x40..+0x47 four motion parameters (word low bytes)
```

The motion numbering differs from the engine's portable order: the
handlers write `wander` = 1, `follow.ego` = 2, `move.obj` = 3 and the
click-move mode 4 (SQ2 h165+0x214, +0x18c, +0x24), so portable
`{normal, move, follow, wander, click}` translates to `{0,3,2,1,4}`. The
cycle numbering is the PC order: `normal.cycle` clears `+0x3a`,
`end.of.loop` writes 1, `reverse.loop` 2 and `reverse.cycle` 3 (SQ2 and
GR h162+0x24/+0x62/+0xfa/+0xba, dispatch slots 0x48/0x49/0x4b/0x4a;
Sierra 2.082 h119 at the same offsets), so portable `{forward, reverse,
end.of.loop, reverse.loop}` translates to `{0,3,1,2}`. The two loop-ending
modes are the ones that also set `0x1030` — delay, cycling and update.

The flag word is its own assignment, read off the handler that sets or
clears each bit on SQ2 2.202 (dispatch table data hunk 5, six-byte
records), with the same instructions on GR 2.316 and Sierra 2.082:

| Bit      | Writer (SQ2)                                                       | Portable state         |
| -------- | ------------------------------------------------------------------ | ---------------------- |
| `0x0001` | `draw` `ori` (h24+0xc4); erase clears                              | `active`               |
| `0x0002` | `ignore.blocks` `ori` / `observe.blocks` `andi` (h188)             | not `observeBlocks`    |
| `0x0004` | fixed priority                                                     | `fixedPriority`        |
| `0x0008` | `ignore.horizon` / `observe.horizon`                               | not `observeHorizon`   |
| `0x0010` | `start.update` sets, `stop.update` clears (h159+0x1d8/+0x1a6)      | not `earlierPartition` |
| `0x0020` | `start.cycling` / `stop.cycling`                                   | `cycling`              |
| `0x0040` | `animate.obj` `0x0070` if clear (h16+0x72); `unanimate.all` clears | `update` (animated)    |
| `0x0100` | `object.on.water` `ori` (h191+0x29c)                               | `waterGate` "on"       |
| `0x0200` | `ignore.objs` `ori` / `observe.objs` `andi` (h109)                 | not `observeObjects`   |
| `0x0400` | `reposition` (h191+0x132); `set.cel`'s helper (h88+0x528)          | `newlyPositioned`      |
| `0x0800` | `object.on.land` `ori` (h191+0x2d4); `on.anything` clears both     | `waterGate` "off"      |
| `0x1000` | loop-ending cycles set; `draw`/`set.cel`/cel advance clear         | `cycleDelay`           |
| `0x2000` | `fix.loop` / `release.loop`                                        | `loopFixed`            |
| `0x4000` | refresh pass: set when x,y equal the saved pair (h7+0x22e)         | `stationary`           |

The delay bit is set with `ori #$1030` by `end.of.loop`/`reverse.loop`
(h162+0x6c/+0x104) and cleared by `draw` (h24+0xea), `set.cel`
(h88+0x42e) and the cel advance (h112+0x16), which consumes it instead
of stepping. Both water bits set is the engine's "both". The update-list
predicate is `(flags & 0x11) == 0x11` and the stopped list `(flags & 0x11) == 1`
(h159+0x10/+0x36), so `0x0010` is the update-partition selector and the
drawn bit an independent field — shipped unused slots carry `0x0010`
alone. `0x0080` (the configured-rectangle crossing block) and `0x8000`
have no portable state; they round-trip only through the record's raw
image, so a save the engine writes without a decoded record leaves them
clear. A native mode word no handler writes (none occurs in the shipped
images) runs as mode 0 in the engine and is re-emitted unchanged until
the engine changes the mode.

The Amiga OBJECT file uses a four-byte header `{u16le tableBytes, u16le
field}` and four-byte entries `{u16le nameOffset, u8 room, u8 pad}`, verified
on the unencrypted SQ1 file and on the key-encrypted KQ2/SQ2/PQ1/GR/MH2 files
(SQ1's OBJECT is plain; the later files carry the repeating "Avis Durgan"
key). Amiga v2 editions use lowercase split files (`logdir`, `picdir`,
`viewdir`, `snddir`, `vol.n`, `object`, `words.tok`) with five-byte record
headers; the Amiga v3 editions use a lowercase `dirs` combined directory and
seven-byte record headers with dictionary/picture compression.

Profile derivation: `amiga-2.082` and `amiga-2.176` derive from the earliest
documented (early-v2) contract, `amiga-2.202` from 2.936, and the
`amiga-2.310`/`amiga-2.316`/`amiga-2.333` generation from 3.002.149.

Click-to-walk, `mouse.posn` and the nudge are covered in
[Original click-to-walk](#original-click-to-walk). Detection reads the
hunk executable — a known executable name plus the load-module magic — for
an exact build. A folder with only an Amiga `dirs` combined directory and
no executable or catalog match runs the 2.310/2.316/2.333 generation's
latest build, `amiga-2.333`, as a container default, and the app asks
which profile to use.

Tests: [profile.test.ts](../test/profile.test.ts),
[ports.test.ts](../test/ports.test.ts),
[inventory-file.test.ts](../test/inventory-file.test.ts).

```bash
python scripts/probe-interpreter-amiga.py info games/pq1-amiga/PQ
python scripts/probe-interpreter-amiga.py names games/mh2-amiga/MH2
python scripts/probe-interpreter-amiga.py dispatch games/sq1-amiga/Sierra
```

#### String slots and key map (fact)

The `parse` handler bounds its string operand with an immediate compare:
`cmpi.w #$6; bge` on 2.082 (Sierra h5+0x1492 region), `cmpi.w #$d; bge` on
2.176 and every later build — six string slots on 2.082, thirteen
afterwards. The bank stride is `0x28` on all builds, at state-hunk offset
`+0xcc` (2.082) or `+0xca` (later). `set.key` scans the key map by
address bound on 2.082 — `h206+0x2c` through `h206+0xcc`, forty `{u16be
rawKey, u16be status}` records — and by count on the later builds,
`cmpi.w #$27` = 39 entries at `h206+0x2a`. The shipped saves confirm both:
block 1 carries the F1 mapping `3b 00` at the expected offset.

#### Direction-based loop selection (fact)

The update pass picks a direction loop only when the object is not
loop-fixed (`btst #13` on the flag word, `0x2000`) and only for exactly
four loops: `loopCount` 2 or 3 selects through the two-direction table,
4 through the four-direction table, anything else falls through. On
2.082 the selection runs every update pass; on 2.176 and later it runs
only when the step countdown reads 1 — the cadence-due tick — matching
the PC late-build behavior. The direction tables live in the shared data
hunks (h14/h17) and read identically on all six builds.

#### Save image (fact)

Every fixture ships real `Save/` directories; the images decode exactly
to end-of-file under the PC envelope: a 31-byte description header, then
five blocks each `{u16le length, payload}`. The block partition differs
from PC — block 1 is the whole state-hunk image, block 2 the `0x48`-record
object table, block 3 the inventory region, block 4 the replay pairs
(state capacity word × 2 bytes) and block 5 the logic-resume records:

| Fixture   | b1 state | b2 objects   | b3 inventory | b4 replay        | b5 resume |
| --------- | -------- | ------------ | ------------ | ---------------- | --------- |
| SQ1 2.082 | `0x2f4`  | `0x510` (18) | `0x16d`      | `0x64` (cap 50)  | `0x1c`    |
| SQ2 2.202 | `0x40a`  | `0x5e8` (21) | `0x170`      | `0xc8` (cap 100) | `0x18`    |

Block-1 lengths on the remaining builds, read off their save routines and
state-hunk sizes: `0x40a` on 2.176, `0x414` on the 2.31x generation (the
2.176 partition plus ten trailing bytes).

Block 1 is big-endian — the state hunk is native 68k memory. The middle
fields are verified from the handlers that write them, not inferred from
the layout: the signature at `+0x00` (`set.game.id` copies seven bytes);
the timer `u32be +0x08` (`addq.l #1,$8.l` in the main loop — SQ2
`h194`+0xe6a8, Sierra `h136`+0xe50c); horizon `u16be +0x0e`
(`set.horizon`); the block rectangle `+0x12..+0x19` (`block` stores its
four operands in order); the player/program-control flag `u32be +0x1a`
(`program.control`/`stop.motion`-on-ego `clr.l` it, `player.control`/
`start.motion` set it — the shipped saves show 0 exactly where ego is
under script control); the drawn picture number `u16be +0x1e` (`draw.pic`
stores `var[operand]`, `new.room` clears it — it mirrors the last drawn
picture, not the current room); and the block-enable long — `block` does
`move.l #1`, `unblock` `clr.l` — at `+0x22` on 2.082 and `+0x20` on the
later builds, whose `+0x22` word is a different, unmapped field carried
by the raw block image. Sierra's `+0x20` word is the ego click-direction
mirror (written from the object's direction field when ego's motion is
the click-move mode). A `0x000f` word and the script capacity come from
the hunk's init image rather than runtime writes, followed by the active
replay-pair count: `+0x26`/`+0x28`/`+0x2a` on 2.082 (SQ1 capacity 50) and
`+0x24`/`+0x26`/`+0x28` on the later builds (SQ2 capacity 100), matching
the cap/active columns below. The state hunk's load image (Sierra h146,
KQ2/SQ2/PQ/GR/MH2 h206) is zero except that `0x000f` word, a capacity of
50 and the input/status rows 23/21 in the text tail, so an image the engine
writes without a decoded block starts from those words.
Then the key map, the string bank, `v0..v255`, the 32 packed flag bytes
and the 24-byte text tail (three `u16be` text attributes, `u32be` input
enable, `u16be` input row, prompt byte + pad, `u32be` status enable,
three `u16be` row bounds). The partition table, verified against the
shipped images:

| Build        | size    | keymap | entries | strings | slots | vars    | flags   | text    | cap/active    |
| ------------ | ------- | ------ | ------- | ------- | ----- | ------- | ------- | ------- | ------------- |
| 2.082        | `0x2f4` | `0x2c` | 40      | `0xcc`  | 6     | `0x1bc` | `0x2bc` | `0x2dc` | `0x28`/`0x2a` |
| 2.176, 2.202 | `0x40a` | `0x2a` | 39      | `0xca`  | 13    | `0x2d2` | `0x3d2` | `0x3f2` | `0x26`/`0x28` |
| 2.31x        | `0x414` | `0x2a` | 39      | `0xca`  | 13    | `0x2d2` | `0x3d2` | `0x3f2` | `0x26`/`0x28` |

Block 5 is the PC grammar in the hunk's byte order — a `{0,0}` cache-head
record, one `{u16be logic, u16be offset}` record per cached logic
(including logic 0) and a `{0xffff, 0}` terminator; the shipped SQ1 image
lists logics 0, 0x1e, 0x5f, 0x70, 0x6e with offset 0.

The sound player is verified separately in "Original Amiga sound player"
below. Each shipped `Save/` image of the SQ1 and SQ2 fixtures decodes
under its fixture profile and re-encodes byte-identically — the proof
for every field above, including the opaque bytes, which the reserved
block image carries (the 31-byte description header keeps its post-NUL
tail, and the string slots keep bytes after their terminators).

#### Amiga runtime details verified from the handlers (fact)

Beyond the save layout, these profile behaviors are verified on the
executables:

- `distance` on Sierra 2.082 stores the center-x delta sum with a bare
  `move.b d1,(a0)` — the value wraps mod 256 (h91+0x8c92). On 2.176,
  2.202 and GR 2.316 the same handler clamps `cmpi.w #$fe; bls` —
  saturation at 254 (SQ2 h109+0x14e, at 0x8962). The profile's
  `objectDistanceSaturates` splits the generations accordingly.
- `stop.motion`/`start.motion` clear both the direction and motion
  words (`+0x36`/`+0x38`) on every build checked — Sierra h120+0x24e
  (0xce80..0xce84), KQ2 h165+0x1d6, SQ2 h165+0x262, GR h165 — the
  `movementClear` "later" semantics on all Amiga profiles. For ego they
  also clear v6 and the `+0x1a` control flag (`clr.l $1a.l`), confirming
  that field's meaning.
- `show.pic` on 2.176, 2.202 and 2.31x calls the flag-clear routine
  (h175+0x4c, a `bclr` into the `+0x3d2` flag bank) with operand 15 —
  `showPictureClearsF15`. Sierra's `show.pic` touches no flag.
- The print worker on 2.176 and 2.202 tests flag 15 (h57+0x3ee0 calls
  the `btst` routine) then resets it (h57+0x3ef0) when the print opens
  a non-blocking window — `printConsumesF15`. Sierra's print worker
  holds no flag operation; its `moveq #$f` push feeds a text-tail
  routine (h128+0x144 writes `+0x2dc`/`+0x2de`), so 2.082 keeps the
  early value.

#### Amiga profile fields inherited without evidence

The remaining fields of each Amiga profile keep their derivation base's
contract without binary evidence — the handler that would decide them
either was not located in a bounded scan or does not exist on that
build. Fields the verified dispatch bounds, container kinds, stub slots
and sound findings above decide (`container`, `volumeHeaderBytes`,
`maxCondition`, `condition0x13`, `extraActions`, `mousePosnAction`, `clickMove`, `motionCounters`, the
2.082 `menuActions`, the 2.176, 2.202 and 2.31x `soundEnvelope`) are not in these lists:

- `amiga-2.082` (early-v2 base): `menuInteractionGate`,
  `releaseGateAction`, `releaseGateClearAction`, `inputWidthActions`,
  `closeWindowClearsInputWidth`, `priorityBaseAction`, `roomAliases`,
  `wordSequenceTailTerminator`, `positionActionOrder`,
  `earlierPartitionOrder`, `packedViewLoopHeader`, `targetMotionDeferred`,
  `inventorySelector`, `timedPrintClearsV21`,
  `clampExactZeroLeftBoundary`, `pictureMaxCommand`, `patternProfile`,
  `restartPromptBypassedByF16`, `heapDiagnosticExtraLine`,
  `soundEnvelope` (inert — the 2.082 driver has no envelope table).
- `amiga-2.176` (early-v2 base): `menuInteractionGate`,
  `releaseGateAction`, `releaseGateClearAction`,
  `closeWindowClearsInputWidth`, `priorityBaseAction`, `roomAliases`,
  `wordSequenceTailTerminator`, `positionActionOrder`,
  `earlierPartitionOrder`, `packedViewLoopHeader`, `targetMotionDeferred`,
  `inventorySelector`, `timedPrintClearsV21`,
  `clampExactZeroLeftBoundary`, `pictureMaxCommand`, `patternProfile`,
  `restartPromptBypassedByF16`, `heapDiagnosticExtraLine` — the 2.082
  list without `inputWidthActions` (a stub slot on 2.176) and
  `soundEnvelope` (KQ2's own table).
- `amiga-2.202` (2.936 base): `exitAlwaysImmediate`, `menuActions`,
  `menuInteractionGate`, `releaseGateAction`, `releaseGateClearAction`,
  `closeWindowClearsInputWidth`, `priorityBaseAction`, `roomAliases`,
  `wordSequenceTailTerminator`, `positionActionOrder`,
  `earlierPartitionOrder`, `packedViewLoopHeader`, `targetMotionDeferred`,
  `inventorySelector`, `timedPrintClearsV21`,
  `clampExactZeroLeftBoundary`, `pictureMaxCommand`, `patternProfile`,
  `restartPromptBypassedByF16`, `heapDiagnosticExtraLine`.
- `amiga-2.310`/`amiga-2.316`/`amiga-2.333` (3.002.149 base): `menuActions`, `menuInputAction`,
  `menuInteractionGate`, `releaseGateAction`, `releaseGateClearAction`,
  `inputWidthActions`, `closeWindowClearsInputWidth`,
  `priorityBaseAction`, `roomAliases`, `wordSequenceTailTerminator`,
  `directionLoopTiming`, `positionActionOrder`, `earlierPartitionOrder`,
  `packedViewLoopHeader`, `targetMotionDeferred`, `inventorySelector`,
  `timedPrintClearsV21`, `clampExactZeroLeftBoundary`,
  `pictureMaxCommand`, `patternProfile`, `restartPromptBypassedByF16`,
  `heapDiagnosticExtraLine`. PQ 2.310 and MH2 2.333 carry the GR 2.316
  verifications by shared code rather than by direct scan.

### Original click-to-walk

Every Amiga build and the Apple IIgs build start a click-move of ego on a
left-button-down; the PC interpreters take no pointer input. Static
disassembly of the executables in the tables above (GR 2.316 first, the
other builds by the same routines at the listed offsets), all **fact**
unless marked.

**Pointer input (Amiga).** The game window's IDCMP template (GR h131+0x4e,
flags `0x000c2568`) subscribes to button, gadget, menu, raw-key and
activation messages but not MOUSEMOVE or DELTAMOVE, so the pointer position
is only seen inside a button message. The message pump (GR h106+0x3c) copies
the message's MouseX/MouseY — screen pixels on the 320x200 screen — and
dispatches on the class. The left-button-down arm (`cmpi.w #$68`,
h106+0x258) does, in order:

1. skip the click if the menu/modal flag h180+0x0 is set;
2. **2.31x only:** set flag 19 (`moveq #$13` into the `bset` routine
   h175+0x16) and store MouseX/MouseY in h108+0xc/+0xe;
3. skip the walk if the text-window flag h59+0x8 is set (set by the
   windowed print path h57+0x446, cleared at h57+0x796 — the engine's
   non-blocking print window);
4. call the starter h45+0x14a(MouseX, MouseY).

`mouse.posn` (h191+0x3b2) reads only h108+0xc/+0xe: it reports the last
eligible click, X halved, Y unadjusted — never a live pointer. The earlier
builds (Sierra 2.082 h78+0x228, KQ2/SQ2 h106+0x262) have the same arm without
the flag or the stored position.

**Starter** (GR h45+0x14a; Sierra 2.082 h33+0x15c and SQ2 2.202 h45+0x14a are
the same instructions without the nudge adds). Nothing happens unless player
control (h206+0x1a) is on. Then, on ego's record:

```text
+0x38 = 4                                   ; click-move mode
+0x40 = (MouseX >> 1) - width / 2 + nudgeX  ; lsr.w, divs.w #2
+0x42 = MouseY - playTop + nudgeY           ; playTop = configure.screen row * 8
+0x44 = +0x30                               ; save the step size
```

All four are words and nothing clamps them: a click above the play area
stores a negative target. `playTop` is h181+0x20, written by
`configure.screen` as its first operand times eight (h179+0x218..0x246).
The starter neither changes player control nor steps ego; the next motion
pass does. `adj.ego.move.to.x.y` (0xb6, h45+0x1c2) masks each operand byte
with `andi.w #$ff` into h206+0x40a/+0x40c — the nudge is unsigned, applies
to every later click and is never cleared; the starter is its only reader.

**Motion.** The per-object dispatch (h16+0x250) sends modes 3 and 4 to the
same steering routine h45+0x0: direction from the 3x3 table h46
(`8 1 2 / 7 0 3 / 6 5 4`) indexed by each delta bucketed against the step
size (`<= -step`, between, `>= step`), written to +0x36 and, for ego, to v6.
Direction 0 — both deltas strictly within the step — calls the finish
h45+0x64: restore the step size from +0x44, set the completion flag +0x46
**unless the mode is 4**, clear the mode, and for ego set player control and
clear v6. The edge handler (h42+0x1ba) finishes only mode 3, so a click-move
into a screen edge keeps pushing while the room's logic sees v2. A direction
event under player control clears ego's mode (h85+0x94..0xa4), cancelling
the walk. `new.room`'s reset (h51+0xb6) clears ego's mode and v6 when the
mode is 4.

**Right button (not modelled).** Right-button-up (`0xe9`) runs Intuition's
`DoubleClick()` against the stored time; a double click with no text window
enqueues event `{1, 0x401}` (h103+0x40), which no shipped key map was traced
to consume. Sierra 2.082 also has a second left-button arm (h78+0x25c): with
the menu flag set, a click enqueues Enter.

**Apple IIgs 1.014.** The Event Manager loop's mouse-down arm (seg3+0x8eb)
sends clicks on rows 0-7 (`where.y - 8` negative, signed) to the menu bar
unless byte `$0090` is set or `$00b3` is 1. Other clicks go through a hit
test (`jsl $000e1f` with the position, seg3+0x9be); a zero result or part 2
of its four-way table (seg3+0xa3a) reaches the walk arm (seg3+0xa4b), which
starts the walk when `$1592` and `$00b3` are both zero or `$1590` is set,
and otherwise turns the click into Enter when `$00b3` is 1. The walk arm calls
`movetoseg+0xb4` with the click — the same starter: player control `$011d`, mode 4,
`+0x40 = x/2 - width/2`, `+0x42 = y - $b7` (the play-area top), `+0x44 =
+0x30`, and no nudge. The finish (`movetoseg+0x198`) skips the completion
flag for mode 4 and hands control back; the mover's edge case
(`moveobjsse+0x1ec`) finishes only mode 3; `newroomseg+0x115` clears a mode-4
ego and v6. The IIgs has no `mouse.posn`, flag-19 or nudge surface. The
meanings of `$0090`, `$00b3`, `$1590`, `$1592` and the hit test's parts are
not decoded (**not found**), so the engine applies the normal case: rows 0-7
never walk, and below them the player-control gate decides.

**Engine mapping.** The host reports left-button-downs through
`EngineHost.takePointerClicks` as screen pixels; the engine applies them in
the input phase after the queued keys, per `AgiProfile.clickMove`. The
parameter bank holds the target words and saved step, which Amiga and IIgs
save images carry whole at +0x40..+0x45.
Tests: [click-move.test.ts](../test/click-move.test.ts).

### Original motion counter width

The PC interpreters keep the wander countdown and the follow delay in bytes
(the [wander countdown](#wander-decrement-first-conditionally-reroll-the-count)
wraps an exhausted 0 to 255 and keeps it; the follow delay compares signed
bytes). Every Amiga build and the IIgs build keep both in the object record's
signed words, which changes what a player sees (**fact**, static
disassembly):

- **Wander step** (Sierra 2.082 h68+0x0, KQ2 2.176 and GR 2.316 h91+0x0, IIgs
  `seg2+0x590b`): `subq.w #1` / `dec` on the word at +0x40; an old count of 0
  or the stationary bit draws a direction (`random % 9`, which may be 0), then
  `while (count < 6) count = random % 51` with a signed word compare
  (`cmpi.w #6; bge` / `sbc #6; bvs; eor #$8000; bmi`). An exhausted count
  becomes -1 and rerolls at once, so an Amiga or IIgs wanderer turns every 7
  to 51 steps where the PC one walks 256 steps after its count wraps. A
  negative count that did not come from exhaustion only counts down.
- **`wander` action** (GR h165+0x1e2, IIgs `motionseg+0x4c2`): clears player
  control for ego, sets mode 1 and flag bit `0x0010`, and leaves +0x40 as it
  was — a `move.obj` target or click target left there becomes the first
  countdown. The PC handler zeroes it.
- **Follow delay** (Sierra h20+0x136, KQ2 and GR h27+0x136, IIgs
  `followseg+0x1af`): `delay -= step` as a word, then zero when negative
  (`bpl` / the signed-test idiom). A delay of 128 or more counts down instead
  of being dropped by the PC's signed-byte compare. The random delay draw is
  `random % distance` from the same byte generator (h10+0x0 computes
  `seed = seed * 0x7c4d + 1` and returns `(seed >> 8) ^ (seed & 0xff)`, the
  PC algorithm; its time reseed skips the multiply on that draw).

`AgiProfile.motionCounters` selects the width. Amiga and IIgs save images
carry the four parameter words whole. Tests:
[motion-counters.test.ts](../test/motion-counters.test.ts).

### Original Amiga sound player

The Amiga editions play the same SOUND resources as the PC releases (the
Gold Rush payloads are byte-identical, 44 of 44) through a dedicated Paula
driver instead of the PC chip writes. On the GR 2.316 executable (134,852
bytes, sha256 `7bfa2f36616923a4` — build table above) the driver is code
hunk 197 (`hunk` type, base `0xf0b8`, `0x6c4` bytes) and its data is hunk
198 (base `0xf77c`, `0x120` bytes), followed by bss hunk 199 (`0x9c`).

Cross-check: data hunk 198 is byte-identical in SQ2 2.202, PQ 2.310 and
MH2 2.333 (sha256 `aa58503273b9af41`). Code hunk 197 is byte-identical
between GR, SQ2 and PQ (sha256 `06c91c9320595f16`); MH2's copy differs only
in branch targets and the called shutdown slot (sha256 `8a739721db6a206c`),
and KQ2 2.176's copy (base `0xe760`, sha256 `13459f357a19d4c0`) differs
from GR's only in absolute addresses — with those masked, the two
disassemble to the same instruction sequence. SQ1 2.082 carries an earlier
driver, described in its own subsection below.

```bash
python scripts/probe-interpreter-amiga.py info games/goldrush-amiga/GR
python scripts/probe-interpreter-amiga.py hunk games/goldrush-amiga/GR 198
python scripts/probe-interpreter-amiga.py hunk games/kq2-amiga/KQ2 198
python scripts/probe-interpreter-amiga.py info games/sq1-amiga/Sierra
```

Code hunks were disassembled with capstone (m68k) after patching each
reloc32 slot with its target hunk's base, so the absolute operands quoted
below are image addresses.

Tests: [sound-playback.test.ts](../test/sound-playback.test.ts),
[ports.test.ts](../test/ports.test.ts),
[audio.test.ts](../app/test/audio.test.ts).

#### The 2.176+ driver (fact)

Init (`0xf0b8`): allocates an 8-byte tone buffer and copies h198 `+0xf8`
into it — the signed-PCM waveform `00 40 7f 40 00 c0 81 c0` (0, 64, 127,
64, 0, -64, -127, -64); allocates `0x1000` bytes and fills them with a
noise PCM: an LFSR seeded with 1, each step `state = (state & 1) ?
(state >> 1) ^ 0x0ca0 : state >> 1`, storing the low byte of every new
state. Two `0x44`-byte IOAudio request blocks are prepared, the reply port
is named `AGI-sound-port` (length-prefixed at h198 `+0x100`), and
`audio.device` (h198 `+0x110`) is opened.

Channel records (init at `0xf1ec`): four `0x20`-byte records at `0xf89c` —
`+0` stream pointer, `+4` channel number, `+6` countdown (starts at 1),
`+8` Paula period, `+a` base attenuation, `+c` volume, `+e` envelope
table start, `+12` envelope cursor (both set to h198 `+0` for every
channel), `+16` active flag, `+1a` DMACON bit `1 << channel`, `+1c` the
AUDx register block `0xdff0a0 + channel * 0x10`. Tone voices point at the
8-byte sample with AUDxLEN 4 (words); the noise voice points at the
4,096-byte PCM with AUDxLEN `0x800` (`0xf62c..0xf640`). Each voice's
buffer is fixed by its channel for the whole session.

Per-tick routine (`0xf282`): it first tests flag 9 (`jsr 0xe2b6` with 9)
and stops the sound when it is clear. Each active channel decrements its
countdown. While it is nonzero, the channel runs the envelope step and
writes only AUDxVOL (`0xf2d0..0xf2dc`: `move.w $c(a5),$8(a0)`). At zero
it consumes one 5-byte note record — u16le duration (`0xffff` terminates
the channel: the active count at `0xf934` drops and `0xf656` clears the
active flag and writes the DMACON bit without `0x8000`, disabling the
voice; the sound completes when the count reaches zero), two tone bytes
and a control byte — then programs the voice:

- Channel 3 (noise) skips the first tone byte and takes `type = byte1 &
3` through a jump table: type 0 → period `0x200`, 1 → `0x400`, 2 →
  `0x800`, 3 shares the `0x800` case (`0xf352..0xf362`). Its envelope
  cursor is not touched.
- Tone channels reset the cursor to the table start (`move.l $e(a5),
$12(a5)`) and compute the Paula period from the tone word
  `((b0 & 0x3f) << 9 | (b1 & 0xf) << 5) >> 3` — four times the PC 10-bit
  divisor. A rest's tone word 0 gives period 0.
- The control byte's low nibble is the base attenuation (`+a`); `+c` gets
  `((15 - attenuation) << 6) / 15` (`divu.w #$f`) on Paula's 0..64 scale.

The decode then calls `0xf42a`, which writes AUDxPER from `+8`, runs the
envelope step, writes AUDxVOL from `+c` and enables the voice's DMA
(`ori.w #$8000` into DMACON). AUDxPER is therefore written only when a
note decodes, including period 0 for a rest; AUDxVOL is written on every
tick.

Envelope step (`0xf462`), quoted from GR (KQ2 `0xeb0a` is the same
sequence):

```text
f46e  tst.l   $12(a5)          ; dead cursor: nothing changes
f478  cmpi.l  #$80,(a0)        ; sentinel: clr.l $12(a5), volume holds
f48a  addq.l  #4,$12(a5)
f48e  moveq   #0,d0
f490  move.w  $a(a5),d0        ; base attenuation
f494  add.l   (a0),d0          ; + signed table longword
f496  move.l  d0,d7
f498  bge.b   f49e
f49a  moveq   #0,d7            ; below 0 -> 0
f49e  cmpi.l  #$f,d7
f4a4  ble.b   f4a8
f4a6  moveq   #$f,d7           ; above 15 -> 15
f4a8  moveq   #$f,d0
f4aa  sub.l   d7,d0
f4ac  asl.l   #6,d0
f4ae  moveq   #$f,d1
f4b0  jsr     $154ec           ; divide
f4b6  move.w  d0,$c(a5)        ; volume
```

The effective attenuation is `clamp(base + delta, 0, 15)` — the delta
applies to the note's own base attenuation; the entries do not accumulate.
The tone voices reset the cursor on every note; the noise voice's cursor
is initialized once and never reset, so it runs the table to the sentinel
a single time. No instruction in hunk 197 reads a game variable: the
driver's only outside calls are the flag test, the completion/stop routine
`0x9c9e`, the division helper and `audio.device`/exec calls, and no code
hunk of GR addresses v23 (`0x1009d`, var table `0x10086`) absolutely. The
2.176+ driver ignores the volume-adjustment variable.

The envelope table is h198 `+0x0000..+0xf4`: 62 big-endian signed
longwords — 61 per-tick offsets then the `0x80` sentinel (the remaining
`0x28` bytes of the hunk are the tone sample and the two strings). Read
off `hunk` subcommand output:

```text
2, 1, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5,
6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9,
10, 10, 10, 10, 10, 11, 0x80
```

Unlike the PC tables the offsets start positive — the note dips below
full volume for two ticks, returns to it for four, then decays.

KQ2 2.176 carries its own table. Its data hunk 198 (base `0xee24`, `0x12c`
bytes, sha256 `0f50641a37644ec6`) holds 64 signed longwords at
`+0x00..+0xfc` and the `0x80` sentinel at `+0x100`, then the same tone
sample at `+0x104` and the two strings:

```text
-2, -3, -2, -1, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6,
7, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10,
11, 11, 11, 11, 11, 12, 12, 12, 12, 12, 13, 0x80
```

The negative attack clamps at attenuation 0, so a full-volume note stays
at AUDxVOL 64; on a rest (attenuation 15, period 0) it writes volumes 8,
12, 8, 4 before settling at 0. The profile field `soundEnvelope` is
therefore decided by these hunks: `amiga-2.176` for KQ2 2.176, the shared
h198 table for SQ2 2.202 and the 2.31x generation.

#### The older 2.082 driver (fact)

SQ1 2.082 (`Sierra`, sha256 `80c6b0c4912a4ca5`) carries an earlier
program: code hunk 138 (base `0xe5fc`, `0x64c` bytes) with a `0x20`-byte
data hunk 139 holding only the `AGI-sound-port` and `audio.device`
strings — no envelope table.

- Init (`0xe5fc`) allocates a 4-byte tone buffer and writes `00 80 00 80`
  into it (`0xe65c..0xe67c`), a two-sample square cycle played with
  AUDxLEN 2 words; the noise buffer is `0x400` bytes of the same LFSR PCM
  (`cmpi.w #$400` at `0xe684`), AUDxLEN `0x200` (`0xe976..0xe98e`).
- Channel records are `0x16` bytes at `0xec68` (the later driver uses
  `0x20`), initialized at `0xe72e`.
- The tick (`0xe7b6`) makes the same flag-9 test, then programs a voice
  only when a note decodes — held ticks write nothing. `0xe95e` writes
  AUDxPER, AUDxVOL and the DMACON enable in one go.
- The tone period is `((b0 & 0x3f) << 10 | (b1 & 0xf) << 6) >> 2` — 16
  times the divisor, four times the later scaling, which the 2-sample
  cycle brings back to the PC pitch. A rest writes period 0.
- The noise control's type bits select `move.w #6/#3/#1, $8(a5)`
  (`0xe872..0xe882`, type 3 shares type 2's case), and `0xe990` copies
  `+8` to AUDxPER: these are real register values, below Paula's DMA
  minimum.
- The volume (`0xe8c2..0xe8fc`) subtracts v23 (`move.b $f31f`, the var
  table at `0xf308` that the `equaln` handler indexes) from the
  attenuation, floored at 0 by `cmp.l d1,d0; bls` → `moveq #0,d7`, then
  scales `((15 - it) << 6) / 15`. v23 makes the note louder; a rest with
  v23 = 5 writes volume 21 at period 0.

The profile family `amiga-2.082` keeps these behaviors distinct;
`amiga` is the 2.176+ driver only.

#### Engine/app mapping

`SoundPlayback` emits `{kind: "paula", channel, period, volume, driver?}`
per voice on the same 60 Hz clock: the 2.176+ family every tick for every
live voice, the 2.082 family (`driver: "2.082"`) on decode ticks only.
`period` is the value written to AUDxPER (null when the voice's DMA is
off) and `volume` the value written to AUDxVOL, always 0..64
(`AMIGA_ENVELOPE_TABLE`, `AMIGA_2176_ENVELOPE_TABLE`,
`AMIGA_2082_NOISE_PERIODS`, `AMIGA_TONE_SAMPLE`,
`AMIGA_2082_TONE_SAMPLE`, `amigaNoisePcm` in `src/sound/sound.ts`).
`app/src/audio/AgiAudio.ts` renders the voices with looping buffer
sources whose buffers are fixed per voice as in the drivers — sample rate
`3546895 / period` against the PAL Paula clock — and per-voice gains; a
change of driver rebuilds the voices. Two render choices come from the
hardware, not the drivers: periods below 124 colour clocks render at 124,
because Paula's audio DMA cannot fetch samples faster (the Amiga Hardware
Reference Manual's minimum); and period 0 renders silent — an inference
that a zero period gives no audible pitch, not a measurement. The
`soundDevice` operand stays a PC-family selection and does not reach this
path.

### Apple IIgs interpreter (SQ2 1.014)

`games/sq2-iigs` ships the Apple IIgs port of Space Quest II 2.0A with its
own 65816 interpreter, `SQ2.SYS16` (107,882 bytes, sha256
`e1a2788f92cb76220e5ac228945bf2eaf7f3a97208f0c3af2ae81d947407717f`). The
resources are a plain v2 split container — the same `LOGDIR`/`PICDIR`/
`VIEWDIR`/`SNDDIR` + `VOL.n` + `OBJECT` + `WORDS.TOK` layout as the PC
edition, resolved by the same reader. Extra files: `SIERRASTANDARD`
(65,536 bytes, sha256 `9d43496535c3e5f22033096f1c539b51cc3d57dc9161c751b25c93f9cf4416e3`), `AGIFONT`
(sha256 `5978fce553c17b2903ab57e82745c3f00677abea4fef909b116275bf19953610`), and the `SQ2.1`/`SQ2.2`/
`SQ2.3` disk-name strings inside the binary.

#### OMF layout (fact)

`SQ2.SYS16` is a GS/OS load file: 43 sequential OMF segment records, not a
flat binary. Each header is the OMF v2 layout (version byte 2 at
`+0x0f`): `bytecnt/respc/length` u32s, then lablen/numlen/version bytes,
banksize u32, kind u16, org/align u32s, a numsex byte, a u16 segnum
(1–43) at `+0x22`, a 4-byte `entry` field, and dispname/dispdata words. Segment
bodies are record streams: `0xf2` LCONST (u32 count + data), `0xf1` DS
(u32 count, zero fill), `0xf5` cRELOC and `0xf7` SUPER compressed
relocation records, `0x00` END. The loaded image must be built from the
records; code bytes are not contiguous in the file.

Segments (all `org = 0`, all `entry = 0` — the IIgs loader assigns banks;
there is no fixed load address or recorded entry point):

`main` (0x592b, file 0x0), `~globals` (0x161e), `~arrays` (0x1fa4),
`Stack Size` (0x2000, BSS), `heap` (0xfde8, BSS), `screen` (0x6900, BSS),
`actionseg`, `debugseg`, `errorseg`, `etcseg`, `eventseg`, `collide`,
`seg3`, `getgameseg`, `initseg`, `initmachseg`, `initscrseg`, `miscseg`,
`seg2` (0x6d6c), `savegameseg`, `savenameseg`, `statusseg`, `memmgrseg`,
`logicseg`, `animateseg`, `advancelseg`, `followseg`, `objlistseg`,
`shakeseg`, `movetoseg`, `objactseg`, `newroomseg`, `moveobjsseg`,
`motionseg`, `logseg`, `flagseg`, `findposseg`, `encryptseg`, `drawseg`,
`cycleseg`, `controlseg`, `blockseg`, `anilistseg`.

The version string sits in `main` data at file offset 0x76a9:
`Adventure Game Interpreter\n      Version 1.014`. Resource paths are
relative strings in `main`/`~arrays`: `data/words.tok`, `data/object`,
`data/AgiFont`, `data/sierrastandard`, `data/logdir`, `data/viewdir`,
`data/picdir`, `data/snddir`, `data/vol.%d`. Tooling:
`scripts/probe-interpreter-iigs.py` (`info`, `strings`, `segment`,
`dispatch`, `snd`, `census`) parses the OMF and disassembles 65816 with a
purpose-built mode-tracking decoder (py65's ORG16 is a soft-core 6502
variant; capstone's 65816 modes cannot track REP/SEP mid-stream).

Cross-segment calls in the file are link addresses `segnum<<16 | offset`
patched at load by SUPER records (`jsl $013314` = main+0x3314, a
far-indirect-call helper; `jsl $070000` = actionseg entry; `jsl $090000`
= errorseg entry). Toolbox calls are `ldx #$FFTT; jsl $e10000` (or
`$e100a8` for GS/OS), X = function<<8 | toolset — so `$1902` is Memory
Manager function `$19`, not a Note Synthesizer call.

#### Dispatch bounds (fact)

The action dispatcher is `actionseg` (seg 7). It reads the opcode byte
through `[$fd]`, masks to 8 bits, `sbc #$00fc` (+0x13) sends opcodes
`>= 0xfc` to a return path, opcode `0x00` returns, then `sbc #$00b1`
(+0x33): `beq` and the signed-less-than idiom both reach the dispatch
path, so opcodes `0x01..0xb1` are valid actions. `0xb2..0xfb` push the
opcode + `0x10` and `jsl $090000` (errorseg). Dispatch multiplies the
opcode by four and far-calls through a 177×4-byte far-pointer table; the
table pointer is loaded as two `#$03fe` immediates at +0x78/+0x7d,
patched by SUPER records type 0x10 (low word, site 0x79) and 0x1c (bank,
site 0x7e). The file value `0x03fe` identifies ~arrays (seg 3) offset
0x03fe: the image there is a zeroed BSS run and `0x3fe + 177*4 = 0x6c2`
lands exactly on the end of the zeroed region, so the table is a
fully-relocated 177-entry far-pointer array in ~arrays+0x03fe.

The condition evaluator is `main`+0x1aaf: `cmp #$0013`, `beq`/`bcc` to
`jsr ($1b0c,X)` — a 4-byte-stride near-pointer table at main+0x1b0c
(all zeros in file, OMF-relocated). Conditions `0x00..0x13` dispatch;
`> 0x13` pushes the opcode + `0x0f` and calls errorseg. `0xfc`/`0xfd`/
`0xfe`/`0xff` are the usual or/not/goto/if control bytes handled by the
statement loop at main+0x191e. A `$15be` global gates trace calls to
seg2 (`jsl $1344b3` / `jsl $1345cc`) around each action and condition —
the interpreter's trace hook.

#### Tail handlers (fact, except where marked)

The 177-entry action table in ~arrays+0x03fe is zero in the file and
patched at load by `f6` cINTERSEG records (fixed 8-byte records:
`f6 numbytes shift | offset u16 | segnum u8 | offinseg u16`, each writing
one far pointer `segnum<<16 | offinseg`). Decoding them resolves every
slot `0x00..0xb0`; the tail entries are not the PC v3 mouse/menu actions:

- `0x86` (quit) → `main`+0x02d0 — calls the sound-completion routine
  (seg3+0x1c2b), reads a one-byte selector through `[$fd]`, optionally
  confirms via seg2+0x2239, then `jsl` main+0x33c, the shutdown path that
  ends in GS/OS call `$29` (Quit).
- `0xaf` → seg3+0x1d1b: reads one operand byte through `[$fd]` and calls
  the pacing subroutine seg3+0x1d87 with that immediate — `fade.sound`.
- `0xb0` → seg3+0x1d4d: reads one operand byte, indexes the interpreter's
  variable array at ~arrays+0x02de with it and calls the same subroutine
  with `vars[operand]` — `fade.sound.v`, an immediate/variable pair.
- `0xb1` has no entry: `0x03fe + 177*4 = 0x06c2` is the first byte of the
  structure that follows the table (the operand-count table the seg2
  trace hook consumes — see below). The slot's four bytes `00 01 01 02`
  resolve through the far-call helper to bank `$01` offset `$0100` — the
  middle of the routine at main+0xe8, whose tail reaches main+0x3222, a
  wrapper around GS/OS call `$29` (Quit). Executing action `0xb1` on
  hardware therefore terminates the interpreter rather than running any
  handler — a wild dispatch, not `allow.menu`.

The condition evaluator's `cmp #$0013` bound admits `0x13` (`beq` and
`bcc` both reach `jsr ($1b0c,X)`), but the near-pointer table holds 19
entries — `0x00..0x12` — ending at main+0x1b57. The `0x13` slot at
main+0x1b58 reads `0b 3b`, the first two bytes of the code that follows
the table, so the `jsr` lands at main+0x3b0b — mid-instruction, no
defined result. It is not the Amiga `click.move.pending`.

The structure at ~arrays+0x06c2 is a 177-entry operand-count table the
seg2 trace routine consumes (its address pair `0x06c2`/`0x0773` is pushed
to seg2+0x465b). It is trace metadata, not the interpreter's bytecode
arity table — its `print.at` count is stale — so handlers' `[$fd]` reads
are the authority on operand widths.

In-game usage (fact): under widths `0xaf=1`, `0xb0=1`, `0xb1=0` all 256
logics walk cleanly, while a zero-operand `0xb0` leaves logic 1 ending
mid-instruction — the logics confirm the handler widths. The fade pair
appears under the same guard each time — e.g. logic 1 ends
`if (v20 != 0) { v53 = 0x32; 0xb0(v53); }` (pace `0x32` = 50 heartbeats).
No logic emits action `0xb1`, and none tests condition `0x13`; the hits a
linear scanner reports are jump-offset bytes (`fe 13 00` / `ff 13 00`)
after desynchronization — the engine's own decoder finds none.

Host model: `0xaf`/`0xb0` arm the fade watchdog described under "Apple
IIgs sound fade" below; `0xb1` terminates the session through the normal
quit path; condition `0x13` raises an error rather than guessing a
result — the host cannot reproduce a mid-instruction wild jump.

#### Bounds, objects and the save image (fact)

`parse` bounds its string operand at `cmp #$000d` — thirteen 40-byte
slots at ~arrays+0xd6 (block offset `+0xa8`). The keypress reader scans
the key map as zero-terminated `{u16le rawKey, u16le status}` records;
`set.key` and the save writer bound the same table at forty entries,
~arrays+0x36..0xd6. Direction-based loop selection lives in `animateseg`
(seg 25): `loopCount` 2 or 3 selects through the two-direction table at
`$318fa`, 4 through the four-direction table at `$31903`, anything else
falls through; it applies only when the object's step-count field (+0x02)
reads 1 — the cadence-due tick — and only when fix.loop (`0x2000`) is
clear.

Object records are `0x48` bytes with little-endian fields. The IIgs
handlers in `animateseg`/`objactseg`/`motionseg`/`cycleseg`/`drawseg`/
`blockseg`/`anilistseg`/`movetoseg`/`moveobjsseg` write the same offsets
the Amiga record map documents — step time/count `+0x00/+0x02`, x/y
`+0x06/+0x08`, view `+0x0a`, loop `+0x10`, cel `+0x18`, previous
`+0x28/+0x2a`, width/height `+0x2c/+0x2e`, step size `+0x30`, cycle
time/count `+0x32/+0x34`, direction `+0x36`, motion `+0x38`, cycle
`+0x3a`, priority `+0x3c`, flag word `+0x3e`, the four motion-parameter
bytes in the low halves of `+0x40..+0x47` — so the record field map is
shared evidence, not inheritance. The mode and flag _values_ match the
Amiga builds too, verified from the IIgs handlers themselves (action
slots resolved through the ~arrays+0x03fe table's cINTERSEG records):

- Motion modes match the Amiga numbering (`normal.motion`/`wander`/
  `follow.ego`/`move.obj` write 0/1/2/3 in `motionseg`; `stop.motion`
  clears `+0x36`/`+0x38` and the `$011d` control flag like the Amiga).
  The input click-move writes mode 4 when `$011d` is set (`movetoseg`).
- Cycle modes use the PC order, as on the Amiga: `normal.cycle`
  writes 0, `end.of.loop` 1, `reverse.loop` 2, `reverse.cycle` 3 in
  `cycleseg` — the portable values translate `{0,3,1,2}` at the record
  boundary.
- The flag-word bits match the Amiga table bit-for-bit, with the same
  portable mapping: drawn `0x0001` (`draw` `ora` at drawseg+0x10b,
  `erase` clears), ignore.blocks `0x0002` (`blockseg`), fixed priority
  `0x0004`, ignore horizon `0x0008`, the update pass `0x0010`
  (`stop.update` → anilistseg+0x21 `and #$ffef`, `start.update` →
  anilistseg+0x165 `ora #$0010`; `draw` sets it at drawseg+0xbc),
  cycling `0x0020`, animated `0x0040` (`animate.obj` tests it at
  animateseg+0x2bd and writes `0x0070`; `unanimate.all`
  animateseg+0x230 `and #$ffbe`), blocked `0x0080` (set when a candidate
  position lands in the configured rectangle), on water `0x0100`
  (`object.on.water` seg2+0x61ef), on land `0x0800` (`object.on.land`
  seg2+0x6788; `object.on.anything` seg2+0x66dd `and #$f6ff`), ignore
  objects `0x0200`, reposition `0x0400` (`reposition` seg2+0x637d),
  cycle delay `0x1000` (`end.of.loop`/`reverse.loop` `ora #$1030` at
  cycleseg+0x2e1/+0x1ea; `draw` drawseg+0x12e, `set.cel` seg2+0x341e and
  the cel advance advancelse+0x70 clear it), fix.loop `0x2000`, and
  stationary `0x4000` (objlistseg+0xcd sets it when x/y equal the saved
  pair, +0xf0 clears it). Only `0x0080` and `0x8000` lack portable state
  and round-trip through the record's raw image.

`savegameseg` writes the 31-byte description header (`pea $001f`) then
six blocks, each prefixed by a big-endian u16 length (the writer
divmods the block size and emits high then low byte):

```text
block 1  0x38  ~globals image $010d..$0144 (u16le words; map below)
block 2  0x3d0 ~arrays+0x2e..0x3fd — signature @0x00, key map 40×4
               @0x08, strings 13×40 @0xa8, v0..v255 @0x2b0, packed flags
               @0x3b0
block 3  N×0x48 drawable-object records (little-endian fields)
block 4  the inventory region (raw OBJECT runtime payload)
block 5  replay pairs, capacity × 2 bytes
block 6  logic-resume {u16le logic, u16le offset} records + terminator
```

`restore.game` reads the same six blocks back through the matching
reader. No shipped IIgs save image exists in the fixture, so the
layout is proven by the writer's push sequences and region boundaries
rather than a file. The writer's far pointers resolve through the
segment's SUPER relocations: the lead block is ~globals (seg 2) +0x10d,
the state block ~arrays (seg 3) +0x2e, where `set.game.id` (seg2+0x4ca0)
copies its seven signature bytes. The lead block's words are the
globals the handlers write:

| Lead    | Global        | Writer                                                           |
| ------- | ------------- | ---------------------------------------------------------------- |
| `+0x00` | `$010d/$010f` | heartbeat timer u32 (main+0x186f, every third beat)              |
| `+0x04` | `$0111`       | `set.horizon`                                                    |
| `+0x08` | `$0115..011b` | `block` x1/y1/x2/y2, the Amiga order                             |
| `+0x10` | `$011d`       | control flag (`player.control`/`start.motion` set it)            |
| `+0x12` | `$011f`       | drawn picture number (`draw.pic` → seg2+0x54c0)                  |
| `+0x14` | `$0121`       | block enable                                                     |
| `+0x18` | `$0125`       | `0x000f` in the load image, no runtime writer found              |
| `+0x1a` | `$0127`       | replay capacity (`script.size`, seg2+0x3c2e)                     |
| `+0x1c` | `$0129`       | replay active count (append `inc` seg2+0x3da2)                   |
| `+0x1e` | `$012b`       | text foreground (`set.text.attribute` seg2+0x855)                |
| `+0x20` | `$012d`       | text background (seg2+0x85a)                                     |
| `+0x24` | `$0131`       | input enable (`accept.input` 1, `prevent.input` 0)               |
| `+0x28` | `$0135`       | cursor character byte (`set.cursor.char` seg2+0x19ba)            |
| `+0x2a` | `$0137`       | status-line enable (statusseg+0x87a / +0x89a)                    |
| `+0x2e` | `$013b..0141` | `configure.screen`: base row, base + 21, input row, status row   |
| `+0x36` | `$0143`       | `push.script` copy of the active count; `pop.script` restores it |

Unmapped and carried raw: `+0x06` (`$0113`), `+0x16` (`$0123`), `+0x22`
(`$012f`, a third word the text-attribute stack moves with foreground and
background), `+0x26` (`$0133`) and `+0x2c` (`$0139`), plus the state
block's eighth byte. The ~globals load image holds `0x000f` at `+0x18`,
capacity 50 and rows 23/21 at `+0x32`/`+0x34`; an image the engine
writes without a decoded lead block starts from the `0x000f` word, the
others being mapped fields.

#### Sound format (fact, except where marked)

All 72 SND resources differ from the PC edition — none begin with the PC
four-channel u16-offset header. Payload byte 0 is a type tag:

- **Type 0x01 (49 sounds)** — `[01][00][3 x u16le stream offsets]`, then
  a fixed-size setup block and the wave data. The u16le at offset 8 is
  the wave byte count; wave (8-bit PCM) data begins at offset 54. The
  setup block carries a wave record at offset 44: a `freqOffset` u16le,
  two zero fields, the tag `7f c0` at offset 0x30, then the same three
  fields again. E.g. snd 1 (7,791 B): offsets 0x33/0x5a/0x2c.
- **Type 0x02 (23 sounds)** — `[02][u16le][event stream]` of
  `delta + command + data` records with MIDI status bytes and running
  status: `0xCn` program changes (snd 60 opens with programs on channels
  1–8), `0xBn` control changes (controller 7 = channel volume), `0x9n`/
  `0x8n` note on/off with velocity. One delta byte precedes each command;
  `0xf8` in delta position is a 255-tick extended wait that stays in the
  delta phase, and `0xfc` (any `0xf0`-class byte in command position)
  terminates the stream. E.g. snd 2:
  `c0 28 02 90 45 40 05 80 45 40 00 90 48 3e ...`.

Under the PC decoder these bytes misparse as channel offsets: type-2
sounds produce out-of-range channel offsets (silent in recover mode),
type-1 sounds decode into thousands of bogus notes with computed
durations of ~1.4e7–5.2e7 ticks (≈66 hours to 10 days), so sound-done
flags never fire in reasonable time.

The interpreter drives sound entirely through the IIgs toolbox — no
`$C03x` Ensoniq DOC register writes appear anywhere in the binary. The
player is `seg3`: it makes Note Synthesizer (toolset `$19`) and Sound
Manager (toolset `$08`) calls, including `FFStartSound` (`$1408`).
`SIERRASTANDARD` is exactly 64 KiB — the Ensoniq DOC wavetable RAM size —
loaded from `data/sierrastandard` (path string in ~arrays+0x1613).
Instrument-index mapping into SIERRASTANDARD and envelope semantics were
not decoded; the app renders the events with plain triangle oscillators
and labels the chip "Apple IIgs (approximate)", so Ensoniq wavetable
fidelity is explicitly out of scope.

Timing: `initmachseg` installs a Misc Tools heart-beat task at
main+0xee0 (`SetHeartBeat` `$1203`, cleared via `$1303`; the pushed task
address is OMF-relocated). The IIgs heart beat fires at 60 Hz; every beat
calls the stream tick (`seg3`+0x1dcd via main+0xef3), and every third
beat runs main+0x186f, which advances the game clock in
20ths/60ths/hours — the usual 20 Hz AGI timer. The stream delta unit is
therefore 1/60 s, which also yields plausible durations across all 23
type-2 resources (~1.6–92 s).

Type-2 player (`seg3`): the sound descriptor keeps the raw resource
pointer; the init routine (seg3+0x235e) arms delta phase with running
status `0x90`, so parsing begins with the u16 header's high byte as the
first delta and the first real command lands at offset 3. Each tick is
one micro-step — a delta read, one unit of its countdown, or one command
execution (which consumes the command's data bytes). The note handlers
(0x1fb5 on, off) keep a per-channel note table: a note-off releases only
the named note and the channel sounds until its table is empty; the
control handler (0x20a3) treats controller 7 as channel volume. All 23
resources decode cleanly under this grammar and end on `0xfc`.

Type-1 player (`seg3`+0x1484): calls `FFStartSound` every heartbeat until
it returns `0xffff` (the toolbox's busy answer), so the resource plays to
completion at the DOC's own pace. The exact FFStartSound setup/PCM
semantics are a gap; `src/sound/sound.ts` computes a finite duration from
the wave byte count at offset 8 played at an assumed `freqOffset × 1645/32`
Hz (51.40625 Hz per unit of the rate word in the tagged wave record at
offset 44 — an inference, not read from the binary), emits silence, and
completes the sound-done flag on schedule. A zero or untagged rate word
falls back to `0x100` with a warning, keeping the duration finite.

#### Apple IIgs sound fade (fact + host limitation)

Actions `0xaf`/`0xb0` arm a volume-fade watchdog on the playing sound.
The shared pacing subroutine (seg3+0x1d87) gates on `$d3` (sound armed)
and `$df` (watchdog state, `0xffff` = disarmed): while disarmed it calls
`GetSoundVolume` (`$0c08`) and latches the system volume into global
`$e3`; it always stores the operand as the new pace in `$df` and the
countdown in `$e1` — re-arming updates the pace without re-latching the
volume.

The heartbeat tick (seg3+0x1dcd) checks `$df` before the per-stream work:
`$df` negative skips the watchdog, zero completes the sound through
seg3+0x1c2b, and otherwise `$e1` counts beats until each pace expiry
reloads it and calls the step routine (seg3+0x2120). The step compares
`$e3` to `$10`: below `0x10` it reports done — the tick then completes
the sound — otherwise it calls `SetSoundVolume` (`$0d08`) with
`$e3 - 0x10` and stores the remainder. The completion routine restores
the latched volume and disarms the watchdog. With a full `0xff` latch a
fade therefore completes on the sixteenth pace expiry.

Host limitation: there is no GS system volume, so the engine's
`SoundPlayback.armFade` latches a synthetic `0xff` budget and keeps only
the observable half — the countdown/expiry schedule and the sound
completion (with its done flag) — while the per-step `SetSoundVolume`
attenuation is modelled nowhere.

#### Boot behavior under the engine (fact)

`detectProfile` selects `iigs-1.014` for the fixture: the folder carries
no `AGIDATA.OVL`/`AGI`/`*.COM` version string, so detection reaches the
`*.SYS16` scan, which matches `SQ2.SYS16`'s embedded
`Adventure Game Interpreter` / `Version 1.014` banner. A `*.SYS16` file
without the banner — or the banner under any other name — does not
select the profile.

Cold boot with an ACK-answering QuietHost, 3,000 ticks: no exception, no
host-request stall — the engine sits in room 140 (the intro) executing
logic 140 + logic 0 every cycle. Logic 140 is an authentic wait: it skips
to `new.room(1)` on `have.key()`, and its story text crawl is paced by
f100, which logic 0 sets for one cycle whenever v12 (clock minutes)
changes — i.e. one story page per minute, looping `new.room(140)` when
done. With an injected keypress the trace runs room 140 → 1 → 98 → 2;
room 2 then runs 5,000 ticks cleanly and prints normally. A restarted
boot lands directly in room 2, calls `sound(1, fX)` within its first few
cycles, and the type-2 stream's `0xfc` terminator sets the done flag
after the decoded stream length — test/ports.test.ts bounds the wait.

#### Input and pacing (fact + inference)

Input comes through the desktop Event Manager (toolset `$06` calls) with
event mask `0x098c` stored in ~arrays+0x1529 region. Scanning every
`ldx #$xxxx; jsl $e10000` or `$e100a8` call site finds zero toolset `$09`
(ADB) calls — the `$0902` call words seen 14 times are Memory Manager
function `$09` (`NewHandle`), since the call word is
`function<<8 | toolset`. `eventseg` is a thin wrapper over seg3/main. The
binary carries joystick-calibration strings ("Please center your
joystick\nand press one of the buttons.", "If you have a joystick,
please center it and press ...", "Otherwise, press any key to
continue.") and "Game paused." Menu/Window/Control/Dialog manager
toolsets (`$0e`/`$0f`/`$10`/`$15`) are called — the IIgs port uses native
desktop UI for menus and dialogs (inference: `menu.input` and
`open.dialogue` semantics likely differ from PC). Clock variables follow
the same v11–v14 seconds/minutes/hours convention (f100 above). No
fixed-cycle vsync wait was identified; event/timer pacing is
toolbox-driven.

#### IIgs profile fields inherited without evidence

`iigs-1.014` derives from the 2.936 contract. Verified on the
executable: the dispatch bounds and tail semantics, the string/key-map
bounds, direction-based loop selection (exact-four, cadence-due), the
quit operand width (the 0x86 handler reads one byte), `stop.motion`/
`start.motion` clearing direction and motion (`movementClear` "later"),
the object-record field map and the PC-order cycle numbering above, and
the six-block save envelope. The following fields keep the base values
without binary evidence — no deciding handler was located in a bounded
scan: `volumeHeaderBytes`, `inventoryMetadataEncrypted`,
`inventoryEntryBytes`, `exitAlwaysImmediate`, `menuActions`,
`menuInputAction`, `menuInteractionGate`, `releaseGateAction`,
`releaseGateClearAction`, `inputWidthActions`,
`closeWindowClearsInputWidth`, `priorityBaseAction`, `mousePosnAction`,
`roomAliases`, `wordSequenceTailTerminator`, `positionActionOrder`,
`earlierPartitionOrder`, `packedViewLoopHeader`, `objectDistanceSaturates`,
`targetMotionDeferred`, `inventorySelector`, `showPictureClearsF15`,
`printConsumesF15`, `timedPrintClearsV21`, `clampExactZeroLeftBoundary`,
`pictureMaxCommand`, `patternProfile`, `restartPromptBypassedByF16`,
`heapDiagnosticExtraLine`, `saveBlock3Xor` (the save writer's block-3
path is verified; whether a transform applies is not — none is evident
in the writer), `soundEnvelope` (inert — the IIgs driver has no Paula
envelope).
