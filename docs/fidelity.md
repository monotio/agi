# Interpreter compatibility

Every Sierra AGI game shipped with its own build of the interpreter, and the
builds do not quite agree. On a PC, a wandering guard whose countdown runs out
walks 256 more steps before he turns; on an Amiga he turns every 7 to 51. Gold
Rush's post-office door stays passable only if a painted door panel leaves the
control line beneath it alone. This document records what the original
interpreters actually do, and how the engine reproduces it, so that a game from
1987 plays the way it did then.

The engine starts from Peter Kelly's
[AGI behavioral specification](https://peterkelly.github.io/agi-re/spec/),
published under CC0. Where a game depends on something the specification leaves
open, or where builds disagree, the original interpreter's machine code is read,
and often executed in isolation, and the result is written down here with its
evidence and the tests that hold the engine to it.

## How to read this document

The first half is a **guide**, organized by platform and topic. Each topic says
in plain words what the original interpreter does and how the engine models it,
then links to its evidence. The second half is a set of **appendices**: build
hashes, load-module addresses, instruction excerpts, probe vectors and the tests
for each finding.

- **Fact, inference, not found.** A _fact_ is read directly off original machine
  code or shipped data, or observed by executing an original routine. An
  _inference_ is a conclusion drawn from facts without direct observation;
  entries say when the engine applies a rule to other builds by inference. _Not
  found_ means the question was investigated and left open. Labels in headings,
  such as "(fact)", apply to the whole entry.
- **Kinds of evidence.** Entries name the method: static disassembly, isolated
  routine execution (original code run in a 16-bit CPU emulator with controlled
  inputs), coupled routine and interrupt-handler execution, or observed game
  data. None of it is full-machine execution or hardware measurement unless an
  entry says so, and each entry states what its evidence does not establish.
- **PC addresses** are load-module offsets, counted after the MZ header, such as
  `0x71c0`. Data-segment offsets are marked `DS:0x1711` or "DS".
- **Amiga addresses** such as `h152+0x6e` are offsets into hunk 152 of the Amiga
  hunk executable. The sound-driver listings quote image addresses after
  relocation, as noted there.
- **Apple IIgs addresses** such as `seg3+0x1c73` are offsets into a named OMF
  segment of `SQ2.SYS16`; `$xxxx` values are direct-page or global addresses and
  toolbox call words.
- **Hashes** are SHA-256. The Amiga build tables shorten them to the first 16
  hex digits.
- **Citations.** Source comments and tests cite entries by heading, so headings
  do not change once published.

No original interpreter code or game data is part of this repository. Probes run
against game files that contributors supply locally in `games/<folder>/`;
decoded binaries and disassembly stay with those local fixtures.
[Appendix D](#appendix-d-tooling-and-open-questions) explains the tooling and
lists what remains unverified.

## Contents

- [Coverage](#coverage)
- [Profile selection](#profile-selection)
- [PC interpreters](#pc-interpreters): [randomness](#randomness),
  [wandering and following](#wandering-and-following),
  [clocks, pacing and waiting](#clocks-pacing-and-waiting),
  [objects in motion](#objects-in-motion),
  [animation and cycling](#animation-and-cycling),
  [changing rooms](#changing-rooms),
  [pictures, priority and control lines](#pictures-priority-and-control-lines),
  [text on screen](#text-on-screen),
  [messages and strings](#messages-and-strings), [the parser](#the-parser),
  [PC sound](#pc-sound),
  [saving, restoring and restarting](#saving-restoring-and-restarting),
  [the memory report](#the-memory-report),
  [equivalent builds and the PC booter](#equivalent-builds-and-the-pc-booter)
- [Amiga editions](#amiga-editions): [builds and opcodes](#builds-and-opcodes),
  [object records and save games](#object-records-and-save-games),
  [click-to-walk](#click-to-walk), [motion counters](#motion-counters),
  [pattern brushes](#pattern-brushes), [Paula sound](#paula-sound),
  [Amiga timing](#amiga-timing), [screen, font and pointer](#screen-font-and-pointer)
- [Apple IIgs edition](#apple-iigs-edition):
  [the SQ2.SYS16 interpreter](#the-sq2sys16-interpreter),
  [actions and conditions](#actions-and-conditions),
  [objects and save games on the IIgs](#objects-and-save-games-on-the-iigs),
  [IIgs sound](#iigs-sound), [input and pacing](#input-and-pacing)
- [Engine and host contracts](#engine-and-host-contracts)
- [Appendix A: PC evidence](#appendix-a-pc-evidence)
- [Appendix B: Amiga evidence](#appendix-b-amiga-evidence)
- [Appendix C: Apple IIgs evidence](#appendix-c-apple-iigs-evidence)
- [Appendix D: Tooling and open questions](#appendix-d-tooling-and-open-questions)

## Coverage

Each aspect of play rests on evidence of a different strength, and the
strength differs by platform. A cell names the strongest evidence behind the
engine's behavior and links the entry that holds it:

- **binary-decoded** — read from the original interpreter's machine code,
  often with the routine itself executed in isolation under controlled
  inputs.
- **MAME cross-checked** — also compared with the original interpreter
  running under MAME. MAME emulates the chips as well, so its output is a
  cross-check, not ground truth.
- **hardware** — measured on a real machine. No aspect has reached it yet;
  only real hardware settles chip output.

A note in a cell says what the evidence does not yet cover, or what the
engine does not yet reproduce; those gaps appear again in the planned list
below.

| Aspect                        | PC                                                                                                                                                                                                            | Amiga                                                                                                                           | Apple IIgs                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Logic and opcodes             | [binary-decoded](#original-input-menu-and-modal-handling)                                                                                                                                                     | [binary-decoded](#amiga-interpreter-profiles)                                                                                   | [binary-decoded](#dispatch-bounds-fact)                                                                                                                            |
| Pictures and priority         | [binary-decoded](#original-picture-drawing-and-fill)                                                                                                                                                          | [binary-decoded](#original-picture-drawing-and-fill)                                                                            | [binary-decoded](#original-amiga-and-iigs-pattern-brushes)                                                                                                         |
| Screen objects and cels       | [binary-decoded](#original-cel-handling-and-priority-table)                                                                                                                                                   | [binary-decoded](#original-cel-handling-and-priority-table)                                                                     | [binary-decoded](#original-cel-handling-and-priority-table)                                                                                                        |
| Text, windows and fonts       | [binary-decoded](#original-window-and-status-line-text); the font [recreates the Tandy 1000 SX BIOS design pixel for pixel](#text-beyond-ascii); IBM-BIOS machines draw a different design, not yet recreated | [binary-decoded](#original-window-and-status-line-text); Topaz 8 is [recreated pixel for pixel](#amiga-screen-font-and-pointer) | [binary-decoded](#original-window-and-status-line-text), [MAME cross-checked](#apple-iigs-presentation); the player's `AGIFONT`, or the project font as a fallback |
| Palette and display adapters  | [binary-decoded](#pc-fonts-and-display-adapters) (the DOS overlays' dispatch verified; the 2.001 booter's adapter census is open; not every adapter offered)                                                  | [binary-decoded](#amiga-screen-font-and-pointer)                                                                                | binary-decoded, [MAME cross-checked](#apple-iigs-presentation)                                                                                                     |
| Screen geometry               | [binary-decoded](#original-window-and-status-line-text)                                                                                                                                                       | binary-decoded, [MAME cross-checked](#amiga-screen-font-and-pointer)                                                            | binary-decoded, [MAME cross-checked](#apple-iigs-presentation)                                                                                                     |
| Menus                         | [binary-decoded](#original-input-menu-and-modal-handling) (interaction; layout from the specification); [kept across restart and restore](#original-menu-across-restart-and-restore)                          | binary-decoded, [MAME cross-checked](#original-amiga-menu-strip-and-pull-downs)                                                 | binary-decoded, [MAME cross-checked](#apple-iigs-presentation); native menus not yet reproduced                                                                    |
| Save and restore dialogs      | [binary-decoded](#original-save-and-restart-audit) (files, timing and keys; selector from the specification)                                                                                                  | binary-decoded, [MAME cross-checked](#original-amiga-save-and-restore-dialogs)                                                  | binary-decoded, [MAME cross-checked](#original-save-file-interoperability); the Standard File window not yet reproduced                                            |
| Keyboard                      | [binary-decoded](#original-input-menu-and-modal-handling)                                                                                                                                                     | [binary-decoded](#original-input-menu-and-modal-handling)                                                                       | [binary-decoded](#original-input-menu-and-modal-handling)                                                                                                          |
| Mouse and touch               | [binary-decoded](#original-click-to-walk) (no pointer input)                                                                                                                                                  | [binary-decoded](#original-click-to-walk), [MAME cross-checked](#original-amiga-menu-strip-and-pull-downs)                      | [binary-decoded](#original-click-to-walk), [MAME cross-checked](#apple-iigs-presentation); the original pointer stays divergent                                    |
| Joystick                      | [binary-decoded](#original-input-menu-and-modal-handling) (the 9-tick poll interval is open)                                                                                                                  | [binary-decoded](#original-input-menu-and-modal-handling)                                                                       | [binary-decoded](#original-input-menu-and-modal-handling)                                                                                                          |
| Sound                         | [binary-decoded](#original-sound-player-audit), [MAME cross-checked](#original-games-through-mame-audio)                                                                                                      | [binary-decoded](#original-amiga-sound-player), [MAME cross-checked](#paula-onset-and-a500-output)                              | [binary-decoded](#sound-format-fact-except-where-marked), [MAME cross-checked](#iigs-doc-pitch-volume-and-headroom)                                                |
| Timing and cadence            | [binary-decoded](#original-scheduler-and-modal-timing)                                                                                                                                                        | [binary-decoded](#amiga-timer-and-pacing), [MAME cross-checked](#paula-onset-and-a500-output)                                   | binary-decoded, [MAME cross-checked](#input-and-pacing-fact--inference)                                                                                            |
| Picture transitions and shake | [binary-decoded](#original-shakescreen-and-picture-reveal)                                                                                                                                                    | binary-decoded, [MAME cross-checked](#original-picture-dissolve)                                                                | binary-decoded, [MAME cross-checked](#original-picture-dissolve)                                                                                                   |

Touch has no column: the originals never saw it. The phone pad, the touch
menu button and long-press gestures are the app's own additions, marked as
host access in the entries that offer them.

Planned for a later release:

- Hercules and CGA composite displays (their
  [adapter routines](#original-shakescreen-and-picture-reveal) are decoded;
  the app offers EGA and CGA RGB)
- under CGA RGB, `shake.screen` moves the frame as under EGA; the original's
  [CRTC sync-register nudge](#original-shakescreen-and-picture-reveal) is not
  reproduced
- the IBM PC BIOS 8 × 8 design for EGA and CGA (the recreated font is the
  [Tandy 1000 SX design](#pc-fonts-and-display-adapters))
- the Apple IIgs
  [native menus and the Standard File window](#apple-iigs-presentation), and
  the buttons of its [restart dialog](#persistence-verdicts)
- resumable checkpoints taken while a native menu is open
- the `.SAV` panel
- a disk-prompt setting (the originals'
  [insert-disk prompts](#original-directory-and-resource-loading))
- the PC `2.001`–`2.272` direction shadow word
  ([F-IN-01](#original-input-menu-and-modal-handling))
- PC joystick 9-tick polling
  ([F-IN-17](#original-input-menu-and-modal-handling))
- rare behavior on unusual input — memory overreads and stack exhaustion that
  [no shipped game is known to reach](#remaining-original-behavior-evidence)

## Profile selection

An interpreter profile is the set of build-specific behaviors the engine runs a
game under. The engine has these profiles:

| Family      | Profiles                                                                                 | Identified by                                |
| ----------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| PC booter   | `2.001`                                                                                  | the booter disk's interpreter string         |
| PC (DOS) v2 | `2.089`, `2.230`, `2.272`, `2.411`, `2.440`, `2.917`, `2.936`                            | the version string in `AGIDATA.OVL` or `AGI` |
| PC (DOS) v3 | `3.002.086`, `3.002.102`, `3.002.149`                                                    | the version string in `AGIDATA.OVL` or `AGI` |
| Amiga       | `amiga-2.082`, `amiga-2.176`, `amiga-2.202`, `amiga-2.310`, `amiga-2.316`, `amiga-2.333` | the Amiga hunk executable's version string   |
| Apple IIgs  | `iigs-1.014`                                                                             | the `*.SYS16` interpreter banner             |

`detectProfile` selects a profile from the interpreter version string and the
explicit equivalent-build table in [profile.ts](../src/runtime/profile.ts). When
the version is missing or unrecognized, container detection selects the default
v2 or v3 profile. Callers can supply a profile ID or a complete `AgiProfile`
override.

Build-specific room mappings use the override's `roomAliases` field. The
[3.002.149 specification](https://peterkelly.github.io/agi-re/spec/version_profiles.html)
describes an immediate-room mapping from 126–128 to 73 in one build. Automatic
profile selection preserves room numbers; the explicit mapping is covered by
[profile.test.ts](../test/profile.test.ts).

Games without interpreter files can still be recognized from the catalog of
known releases, and the app lets players pick a profile by hand; see
[Interpreter profile detection and override](testing.md#interpreter-profile-detection-and-override).

## PC interpreters

Most AGI games were played on DOS PCs, and most of this document is about their
interpreters: v2 builds from 2.089 to 2.936, and v3 builds 3.002.086 to
3.002.149. Most of the evidence comes from the hash-pinned executables listed
under [Verified inputs](#verified-inputs), from King's Quest I to Gold Rush.

### Randomness

All randomness in an AGI game comes from one tiny generator. It keeps an
unsigned 16-bit state, advances it as `state * 31821 + 1` (keeping 16 bits), and
returns one byte: the state's low byte XORed with its high byte. When the state
is zero, the interpreter reads the BIOS clock and uses that as the new state.
This is not a one-time seed: a state that later lands on zero reads the clock
again.

`random(n, m, v)` returns `n + byte % (m - n + 1)` and consumes a draw even when
`n = m`. Reversed bounds are not swapped: `random(20, 10)` still produces a
value, King's Quest II's logic 167 relies on `random(30, 0, v)`, and
`random(1, 0)` divides by zero. The engine reproduces the generator and the
range arithmetic exactly, raises a controlled fault for the divide-by-zero case,
and records every zero-state clock reseed so a replay draws the same numbers.
Authentic save, restore and restart leave the random stream alone.

**Evidence:**
[Original RNG and wander countdown — binary investigation](#original-rng-and-wander-countdown--binary-investigation)
and [Original save and restart audit](#original-save-and-restart-audit).

### Wandering and following

A wandering object counts down a byte before choosing a new direction. When the
old count was zero, or the object did not move on its last due step, it draws a
direction (possibly "stop") and then, while the count is below 6, rerolls it.
The countdown wraps at zero: an exhausted count becomes 255 and is kept, so the
wanderer walks another 256 steps before it turns again.

`follow.ego` captures the larger of the requested distance and the object's step
size when the command runs. A follower that stops making progress draws a random
direction and delay; the delay arithmetic is a signed byte comparison, so the
overflow flag matters. The engine follows the executed vectors for both,
including how many random draws each path consumes.

The Amiga and Apple IIgs interpreters keep these counters in 16-bit words and
behave differently; see [motion counters](#motion-counters).

**Evidence:**
[Wander: decrement first, conditionally reroll the count](#wander-decrement-first-conditionally-reroll-the-count),
[Original complete movement and follow audit](#original-complete-movement-and-follow-audit)
and [Original motion and animation audit](#original-motion-and-animation-audit).

### Clocks, pacing and waiting

The PC interpreter keeps time from a hardware timer interrupt. Twenty timer
services advance the seconds variable v11, and a pacing counter admits one logic
pass once it reaches the delay in v10. A backlog does not cause a burst of
catch-up passes: even a 1,000-service backlog admits a single pass.

What happens to time while the game waits depends on the wait:

- Ordinary modal waits (a message window, the text editor, a menu, the inventory
  screen, `show.obj` and `show.pri`) keep the script clock, pacing and sound
  running while the script is suspended. A timed message closes on schedule.
- An explicit pause and the save and restore selectors freeze the script clock
  and pacing, while the global timer keeps running.
- Sound runs from the timer interrupt, not the main loop, so music keeps playing
  while the player types an answer to `get.string` or `get.num`.

`have.key` polled once per cycle never blocks; only a busy loop inside one logic
pass waits for a key. Each elapsed second normalizes the clock variables,
checking seconds, minutes and hours independently, so out-of-range values a
script wrote roll over.

Keys enter the event queue raw. A script's `set.key` mappings apply only when
the cycle's input phase consumes a key; `have.key` reads the queue itself and
never maps. So a mapped key satisfies `have.key` when it arrives during the
logic pass, as it always does for a busy loop, and becomes a controller when the
next input phase takes it first. The engine delivers host keys at the cycle
boundary, so a once-per-cycle poll sees a mapped key as its controller: the
Demo Pack title, which maps Enter, waits for another key.

The engine models these as host waits: the worker suspends the logic pass
instead of blocking, and the host clock keeps advancing. It normalizes twenty
pacing increments and sixty sound increments to one second of host time.

The PC booter release keeps the BIOS timer rate of 18.2 ticks a second for
sound, pacing and the clock, and rewrites the clock variables from its tick
count every 18 ticks, so a script cannot set them. Only its pause stops time.

**Evidence:**
[Original scheduler and modal timing](#original-scheduler-and-modal-timing),
[PC booter clock](#pc-booter-clock),
[Timer-interrupt sound during blocking input](#timer-interrupt-sound-during-blocking-input),
[Have key polling](#have-key-polling) and
[Script key mappings and have.key](#script-key-mappings-and-havekey). The host
side is described under [Parked host waits](#parked-host-waits).

### Objects in motion

Each cycle, the interpreter updates every eligible object in two sweeps: every
object changes its cel first, and only then does any object move. A later object
growing or shrinking can therefore change an earlier object's collision in the
same pass. Other details that games depend on:

- **Screen edges.** Horizontal bounds are checked before vertical ones, so a
  corner reports the top or bottom edge. Each executed movement pass clears the
  border variables v2, v4 and v5.
- **Control lines.** Stepping onto any control-2 pixel sets the trigger flag
  (f3), even if later pixels of the footprint are not control 2. The water flag
  (f0) needs every pixel to be water. Priority 15 skips the test entirely. Water
  and land restrictions are independent bits and can both be set.
- **Previous position.** Collision compares objects against a saved position
  that the movement routine never writes. The original commits it in a later
  pass over the object list, so the engine commits it once per pass, after every
  object has moved (an inference from where that code sits). `position` and
  `position.v` store the coordinates and the saved position only; the
  `reposition` family places the object at once and marks it, which turns its
  next due step into a zero-step re-check.
- **Ego and the player.** `move.obj`, `move.obj.v` and `wander` on ego take
  control away from the player; arrival or a border stop gives it back and
  clears v6. `player.control` ends any scripted motion of ego outright (on the
  later Amiga builds, only when the call follows program control).
- **Loops and cels.** `set.view` keeps the current loop, and `set.loop` the
  current cel, whenever the new view or loop has enough of them; only an
  out-of-range index falls back to 0.

**Evidence:**
[Original complete movement and follow audit](#original-complete-movement-and-follow-audit),
[Footprint class flags](#footprint-class-flags),
[Border variables cleared](#border-variables-cleared),
[Original previous-position commit](#original-previous-position-commit),
[Original position handlers](#original-position-handlers),
[Ego direction coupling](#ego-direction-coupling),
[Original player.control handler](#original-playercontrol-handler) and
[View loop index retention](#view-loop-index-retention).

### Animation and cycling

`end.of.loop` and `reverse.loop` put a stopped object back into the updating set
as well as starting its animation, so a script waiting on a previously stopped
object still finishes. `normal.cycle` and `reverse.cycle` also turn cycling back
on.

Motion and animation share storage in a way scripts can observe. Four bytes of
each object record hold the parameters of whichever command ran last: a
`move.obj` target, a `follow.ego` distance, or an `end.of.loop` completion flag.
Run `end.of.loop(o1, f61)` and then `move.obj(o1, 90, 80, 2, f62)`, and the
loop's completion sets f90: the target x that `move.obj` wrote over the
completion flag. The engine keeps the same single four-byte bank, in memory, in
save images and in rewind snapshots.

Object records start zeroed and `animate.obj` sets no cadence, so an animated
but unconfigured object neither moves nor cycles until the script sets
`step.size`, `step.time` or `cycle.time`; `new.room` resets those fields to 1.

**Evidence:** [Completion animation updates](#completion-animation-updates),
[Original motion and animation audit](#original-motion-and-animation-audit) and
[Startup and reconstruction execution](#startup-and-reconstruction-execution).

### Changing rooms

`new.room` is an ordered sequence: stop the sound (setting its done flag), free
memory, drain pending input, reset every object record, restore the horizon to
36, update the room variables, load the new room's logic, and place ego from the
border it left by. The reset puts every object back into the updating set while
clearing its drawn and animated state. The interpreter then re-runs logic 0 in
the same cycle without a new input phase; of the old room's input state, only
v19 and f4 remain visible to the new room's first pass.

Ego's motion mode survives the change as latent state but can never steer again:
only `animate.obj` restores ego's animated membership, and it clears the mode.
The mode ends there or at the next direction event.

**Evidence:** [Original new.room sequence](#original-newroom-sequence).

### Pictures, priority and control lines

Pictures, screen objects and text share a single bitmap on the original machines, and
games rely on the consequences:

- A cel added with `add.to.pic` over a control line changes the pixels' colour
  but keeps their control value. Gold Rush's post-office door depends on it.
- `add.to.pic` with a margin below four also writes the margin as a control
  value around the lower part of the cel: its baseline row, its sides up to the
  height of its priority band, and a top row. With margin 0 the box is a wall;
  Police Quest and Space Quest place obstacles this way.
- Screen objects drawn or erased over text repaint it: text written under a later
  graphic is gone, and `show.pic` clears the picture area's text.
- An open message window does not pause object updates, so an animated object
  that overlaps the window paints over it.

The engine applies the cel-over-control and control-box rules to every profile;
the evidence comes from specific builds, and the entries say which.

`shake.screen` holds the game still while it shakes; sound and the clock keep
running and keys wait for the next pass. On PC the whole screen alternates with
a copy 4 pixels right and 4 rows down, eight times per count (half a second).
The Amiga moves the whole screen 5 pixels and 10 rows in four diagonal
directions and back, five ticks per count. The IIgs moves nothing: it flashes
sixteen random colours each tick for five ticks per count, drawing them from
the game's random numbers. On the Amiga (except MH2's 2.333) and the IIgs,
`show.pic` after `draw.pic`, and every `restore.game`, dissolve the picture in
two pixels at a time in a fixed scrambled order, holding the game for about
0.8 s on the Amiga and 0.45 s on the IIgs while sound and the clock run; PC
pictures, and pictures shown after `overlay.pic`, appear at once.

**Evidence:**
[Original shake.screen and picture reveal](#original-shakescreen-and-picture-reveal),
[Original picture dissolve](#original-picture-dissolve),
[Original cel blit over control pixels](#original-cel-blit-over-control-pixels),
[Original add.to.pic control box](#original-addtopic-control-box),
[Text under later graphics](#text-under-later-graphics) and
[Window update gate](#window-update-gate).

### Text on screen

`display` breaks lines at CR or LF and wraps after column 39, continuing at the
start column that only a message window sets. On the verified builds, a message
printed while flag 15 is set opens without waiting for a key and clears f15, so
the next message waits again, and a timed message (v21, in half-seconds) clears
v21 when it closes. `obj.status.v` is a real modal window, not a log line.

**Evidence:** [Display line layout](#display-line-layout),
[Print handler output modes](#print-handler-output-modes) and
[Original obj.status.v modal](#original-objstatusv-modal).

### Text beyond ASCII

The originals drew text with each machine's own font. The PC's project table
recreates the BIOS graphics bitmap typeface pixel for pixel, credited as a
recreation, in the same 40 × 25 character grid (see
[PC fonts and display adapters](#pc-fonts-and-display-adapters)).
`app/src/render/font8x8.ts` serves the PC; `app/src/render/fontIigs.ts` supplies the IIgs coverage and metrics
(see [Apple IIgs presentation](#apple-iigs-presentation)). A player's IIgs `AGIFONT`, when included with their game, overrides the project
font at runtime. No ROM or font file ships with the project; a missing or
invalid game font uses the project drawings.

A scan of every logic message in the catalogued releases found these
characters outside printable ASCII, apart from line breaks:

| Byte                                                             | PC code page                      | Games                                               | Occurrences                                                            |
| ---------------------------------------------------------------- | --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| 0xb3, 0xb7, 0xba, 0xbd, 0xc1, 0xc2, 0xc4, 0xd0, 0xd2, 0xd3, 0xd6 | box drawing │ ╖ ║ ╜ ┴ ┬ ─ ╨ ╥ ╙ ╓ | Gold Rush! (PC and Amiga)                           | 1,911, all in logic 26: the Bible pages the copy protection asks about |
| 0xff                                                             | non-breaking space                | King's Quest II (PC and Amiga)                      | 15 on the PC, 16 on the Amiga                                          |
| 0x09                                                             | tab                               | Manhunter 1, Space Quest II (PC, Amiga, Apple IIgs) | one each                                                               |

The PC font recreates the code-page box characters with their two-pixel
strokes and draws 0xff as a blank. There is no evidence yet of how the originals drew a tab, so it
shows blank. The Amiga Gold Rush! ships the same bytes; whether its own font
drew them as PC box drawing is unverified. Any other character a game prints
shows blank and is reported once in the browser console.
`app/test/font-coverage.test.ts` checks every catalogued release against the
font.

Game text keeps its bytes: the text surface stores 0x80..0xff unchanged. The
engine's own window borders and cursor use control codes 0x01..0x07, which
no catalogued message prints.

### Messages and strings

The message formatter walks the text once. `%v` inserts a variable (with an
optional `|` width), `%m` and `%g` insert messages from the current logic and
logic 0, `%o` an object, `%s` a string and `%w` a parsed word. Inserted
messages and strings are formatted recursively, but output is only appended,
never rescanned, so a variable's digits cannot extend a code before it. The
original bounds its output by counting lines; the engine uses an insert stack
with a character and step budget so that a self-referencing string cannot run
away. View descriptions shown by `show.obj` get the same formatting.

String operands address a bank of 40-byte slots. Only `parse` checks the slot
number; every other string command uses the computed address unchecked, and
Leisure Suit Larry stores a telephone spelling in s12. The engine treats the
records reserved after the table as part of the bank (an inference from the save
layout) and keeps them in save images.

Dictionary-compressed v3 logic stores its message text unencrypted.

**Evidence:** [Original message formatter](#original-message-formatter),
[Original show.obj description formatting](#original-showobj-description-formatting),
[Original string slot addressing](#original-string-slot-addressing) and
[Compressed logic plain text](#compressed-logic-plain-text).

### The parser

An unknown word still occupies a slot in the parsed input, with word group 0. So
`said(anyword)` and `said(0)` both match a single unknown word, while a two-word
pattern does not. The engine counts parsed words the same way.

**Evidence:**
[Original parser unknown-word audit](#original-parser-unknown-word-audit).

### PC sound

PC AGI sound drives a TI SN76489-family chip (the PCjr and Tandy sound chip) or
the PC speaker. The app lets PC editions choose either under **Settings →
Advanced… → Sound chip**.

- Starting a sound clears its done flag; stopping a playing sound sets it.
  `new.room`, pause, `quit.game`, `restart.game` (even when the player declines)
  and opening the save or restore selector all stop the sound first.
- Clearing flag 9 (sound on) stops the tune at the next tick rather than muting
  it.
- Notes fade through an attenuation envelope. KQ1 2.917 uses a 68-step envelope;
  the measured v3 builds use a slower 78-step one. The volume adjustment in v23
  applies only while the envelope is still moving, and its arithmetic is signed
  byte arithmetic, including overflow into neighbouring register bits.
- A rest note (tone 0) makes the original emit zero bytes to the chip. The
  engine suppresses those writes as a deliberate presentation choice, so rests
  stay silent on every chip.

**Evidence:** [Original sound player audit](#original-sound-player-audit),
[Original stop-sound call sites](#original-stop-sound-call-sites) and
[SN76489 attenuation latching and rest notes](#sn76489-attenuation-latching-and-rest-notes).

### Saving, restoring and restarting

A PC save file holds a description and five blocks of interpreter memory; the
random-number state is not among them. Restoring reads the blocks back, replays
the resource-loading history, and resumes loaded logic at saved offsets. A
successful restore or restart sets f12 or f6 and restarts logic 0 in the same
cycle, abandoning the old script position. Restart keeps the random stream and
the sound preference. Restart and restore both keep the game's menu, which is
not part of a save, and both leave every menu item enabled; the game disables
items again itself. Restart clears variables, flags, controllers and objects
but leaves the screen, the status line, text mode, the script buffer size, key
mappings and strings, and the last command for echo as they were; the old room
stays on screen until the restarted game draws. The game signature that `set.game.id` sets names the save
files and is part of the first block, so a restore brings it back; the save
selector lists only files carrying the running game's signature.

The engine writes authentic save images for authentic save and restore, and
keeps its stronger host checkpoints (which also capture randomness and input)
separate. A save that cannot be restored shows "Unable to restore saved game."
as an ordinary message window.

**Evidence:**
[Original save and restart audit](#original-save-and-restart-audit),
[Startup and reconstruction execution](#startup-and-reconstruction-execution),
[Original menu across restart and restore](#original-menu-across-restart-and-restore),
[Original restart state boundary](#original-restart-state-boundary),
[Game signature across restore](#game-signature-across-restore)
and [Restore error window](#restore-error-window).

### The memory report

The interpreter stores the free heap, in 256-byte pages, in v8, and some games
refuse features when it is low. The engine has no such ceiling and reports 255,
as a well-configured original machine would.

**Evidence:** [Free memory in v8](#free-memory-in-v8).

### Equivalent builds and the PC booter

Some builds behave identically on everything verified: 3.002.107 runs as
3.002.102, 2.903 and 2.915 run as 2.917, and 2.439 runs as 2.440. The PC booter
release, whose interpreter is 2.001, stores the usual resource families in its
own disk layout, with a smaller inventory file header, an action 0x8f that sizes
the object table (`max.drawn.objects`) and sound stored as raw chip register
rows.

**Evidence:** [3-002-107-is-3-002-102](#3-002-107-is-3-002-102),
[PC booter 2.001 profile](#pc-booter-2001-profile),
[PC booter inventory file](#pc-booter-inventory-file),
[PC booter action 0x8f (max.drawn.objects)](#pc-booter-action-0x8f-maxdrawnobjects)
and [PC booter sound rows](#pc-booter-sound-rows).

## Amiga editions

Sierra ported its AGI games to the Amiga with interpreters of its own: 68k
programs in the Amiga's hunk executable format, with their own version numbers
from 2.082 to 2.333. Six editions are profiled from their executables:

| Edition         | Interpreter | Profile       | Derived from      |
| --------------- | ----------- | ------------- | ----------------- |
| Space Quest I   | 2.082       | `amiga-2.082` | early-v2 contract |
| King's Quest II | 2.176       | `amiga-2.176` | early-v2 contract |
| Space Quest II  | 2.202       | `amiga-2.202` | 2.936             |
| Police Quest    | 2.310       | `amiga-2.310` | 3.002.149         |
| Gold Rush!      | 2.316       | `amiga-2.316` | 3.002.149         |
| Manhunter 2     | 2.333       | `amiga-2.333` | 3.002.149         |

"Derived from" names the PC contract a profile starts from; every difference
listed below overrides it.

### Builds and opcodes

The game files are the PC formats under lowercase names: v2 editions use split
directories (`logdir`, `vol.n` and friends), and v3 editions a combined `dirs`
directory with compressed resources. The Amiga `OBJECT` file has its own
four-byte header and four-byte entries. The engine canonicalizes the names and
reads the rest with the same container code as the PC.

Every Amiga action dispatcher bounds its table with an inclusive compare, so the
action equal to the table size fetches a handler from past the end of the table;
2.082's condition dispatcher does the same for condition 0x13. That is a wild
jump with no defined behavior, and the engine rejects it as an unavailable
opcode. The later builds add a tail of mouse and menu actions; most are stubs,
but `mouse.posn` reports the last click and `adj.ego.move.to.x.y` nudges click
targets. Condition 0x13 on the 2.31x builds tests whether ego is walking to a
click.

Smaller build differences include six string slots on 2.082 and thirteen
afterwards, `distance` wrapping at 256 on 2.082 but saturating at 254 on the
later builds, and loop selection by direction on every pass on 2.082 but only on
cadence-due passes afterwards.

A folder with only a `dirs` directory and no executable or catalog match runs
under `amiga-2.333`, and the app asks which profile to use.

**Evidence:** [Amiga interpreter profiles](#amiga-interpreter-profiles),
[Amiga runtime details verified from the handlers (fact)](#amiga-runtime-details-verified-from-the-handlers-fact)
and
[Amiga profile fields verified from the handlers](#amiga-profile-fields-verified-from-the-handlers).

### Object records and save games

An Amiga object record is 72 bytes of big-endian fields instead of the PC's 43
bytes. Motion modes are numbered differently (`wander` is 1, `move.obj` 3), and
click-to-walk adds a mode 4. The flag word, verified handler by handler, uses
the PC's bits. Save games use the PC envelope (a 31-byte description and
length-prefixed blocks) with a different block partition. Every shipped save
image in the Space Quest I and II fixtures decodes under its profile and
re-encodes byte-identically.

**Evidence:** [Amiga interpreter profiles](#amiga-interpreter-profiles),
[String slots and key map (fact)](#string-slots-and-key-map-fact),
[Direction-based loop selection (fact)](#direction-based-loop-selection-fact)
and [Save image (fact)](#save-image-fact).

### Click-to-walk

The Amiga and Apple IIgs interpreters let the player walk by clicking: a left
click sends ego walking toward the spot, as long as the player has control and
no menu or message window is in the way. The PC interpreters take no pointer
input.

The click becomes a target position: x halved to AGI's 160-pixel width and
centred on ego's width, y measured from the top of the play area. Ego walks
there in a dedicated motion mode. Unlike `move.obj`, arriving sets no flag, and
walking into a screen edge keeps pushing while the room's logic sees the border.
A direction key cancels the walk, and `new.room` clears it. The 2.31x builds
also remember the click for `mouse.posn`, set flag 19, and add the nudge from
`adj.ego.move.to.x.y`. On the IIgs, clicks on the top eight rows go to the menu
bar instead.

The engine takes left-button presses from the host as screen pixels and applies
them in the input phase, after queued keys, according to the profile.

**Evidence:** [Original click-to-walk](#original-click-to-walk).

### Motion counters

The Amiga and IIgs interpreters keep the wander countdown and the follow delay
in signed 16-bit words, not bytes. An exhausted wander count becomes -1 and
rerolls at once, so an Amiga or IIgs wanderer turns every 7 to 51 steps where a
PC wanderer walks 256. The `wander` command keeps whatever number was left in
the record, so a leftover `move.obj` or click target becomes the first
countdown. A follow delay of 128 or more counts down instead of being dropped.

**Evidence:** [Original motion counter width](#original-motion-counter-width).

### Pattern brushes

Picture commands 0xf9 and 0xfa paint with shaped, stippled brushes (on the IIgs
and on Amiga builds from 2.176). The Amiga and IIgs plotters clamp the brush to
the v2 right edge on every such build, and the radius-1 brush has a different
shape on 2.176 and 2.202, whose table runs one row into the next radius. The
stipple generator is the PC one.

**Evidence:**
[Original Amiga and IIgs pattern brushes](#original-amiga-and-iigs-pattern-brushes).

### Paula sound

The Amiga editions play the same SOUND resources as the PC releases through a
driver for Paula, the Amiga's sample-playing sound chip. Tone voices loop a tiny
waveform, the noise voice loops a buffer of pseudo-random samples, and each
note's pitch becomes a Paula period. Notes fade through an envelope table in the
driver: King's Quest II 2.176 has its own, and the later builds share another
that dips briefly before the decay. The 2.176 and later drivers ignore the v23
volume variable; the older 2.082 driver has no envelope, uses a square wave, and
lets v23 make notes louder.

The engine emits the values each driver writes to Paula's period and volume
registers, and the app plays them as looping samples at the selected Paula clock
(NTSC by default, with PAL in Settings > Advanced). Two
rendering choices come from the hardware rather than the drivers: very short
periods play at Paula's DMA limit, and period 0 counts 65,536 clocks at the
programmed volume.

**Evidence:** [Original Amiga sound player](#original-amiga-sound-player).

### Amiga timing

Sound runs every frame and the game timer every third frame, so pacing and the
clock run at 20 ticks a second on NTSC machines and 16.7 on PAL ones; the
builds do not detect the region. Holding a menu open, or switching to another
window, freezes the clock and pacing. The engine follows the frame rate but
not those two pauses: its menus and the browser window are not the Amiga's.

**Evidence:** [Amiga timer and pacing](#amiga-timer-and-pacing).

### Screen, font and pointer

Each Amiga interpreter opens its own 320×200 sixteen-colour Intuition screen
and loads a colour table of its own: King's Quest II and Space Quest II share
one, Space Quest I's differs in colour 13 (orange instead of purple), and the
three 2.31x games use an EGA-like table. The profile's `palette` names the
table and the app draws the picture, text and windows through it.

Text is the system font `topaz.font` at 8 px, which the interpreter asks
Intuition to open from the Kickstart ROM; no game disk carries a font. The app
draws it with its own table, a pixel-for-pixel recreation of the Amiga Topaz 8
bitmap design (a bitmap typeface design carries no ROM data; no ROM or font
file ships and none is read at run time), and a test against a contributor's
ROM keeps the table exact. The status line is the screen title: Kickstart draws it in an 11 px
title bar with the screen depth gadgets at the right, which hides the top
three picture rows while the status line is on. The configured status row plays no
part, and a picture starting at row 0 never shows the bar. The input row
shows string 0, the typed text and then the cursor character, and the cursor
leaves the row while a restart or quit prompt is open. Confirmation gadgets carry
their labels four pixels in and two down from the fill's corner. The
interpreter also installs its own 16×16 arrow pointer from the game's
`Pointer` file; the app shows a redrawn arrow in the same colours and hot
spot as the browser cursor over the screen.

**Evidence:**
[Amiga screen, font and pointer](#amiga-screen-font-and-pointer).

## Apple IIgs edition

The Apple IIgs port of Space Quest II carries the most unusual AGI interpreter
in the fixtures examined: a 65816 program for GS/OS that hands menus, dialogs and
sound to the IIgs toolbox. Its version banner reads 1.014, and it runs under the
`iigs-1.014` profile.

### The SQ2.SYS16 interpreter

`SQ2.SYS16` is a GS/OS load file built from relocatable OMF segments. The game
resources beside it are a plain v2 split container, read by the same code as the
PC edition. Detection selects the profile from the interpreter's
`Adventure Game Interpreter` / `Version 1.014` banner in a `*.SYS16` file.

**Evidence:**
[Apple IIgs interpreter (SQ2 1.014)](#apple-iigs-interpreter-sq2-1014),
[OMF layout (fact)](#omf-layout-fact) and
[Boot behavior under the engine (fact)](#boot-behavior-under-the-engine-fact).

### Actions and conditions

The IIgs accepts actions up to 0xb1, but its handler table ends at 0xb0. The
tail differs from both the PC and the Amiga:

| Action or condition | On the IIgs                                                       | In the engine                          |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| action 0xae         | `discard.sound`: releases a sound and every sound loaded after it | same, replayed on restore              |
| actions 0xaf, 0xb0  | `fade.sound` with an immediate or variable pace                   | runs the fade schedule, then completes |
| action 0xb1         | wild jump into code that ends in the GS/OS Quit call              | ends the session through `quit`        |
| condition 0x13      | wild jump into the middle of an instruction                       | raises an error                        |

No shipped logic uses action 0xb1 or condition 0x13.

**Evidence:** [Dispatch bounds (fact)](#dispatch-bounds-fact),
[Tail handlers (fact, except where marked)](#tail-handlers-fact-except-where-marked),
[Apple IIgs sound discard](#apple-iigs-sound-discard) and
[IIgs profile fields verified from the handlers](#iigs-profile-fields-verified-from-the-handlers).

### Objects and save games on the IIgs

Object records use the same 72-byte layout, mode numbers and flag bits as the
Amiga, with little-endian fields. A save holds the description and six blocks.
No IIgs save image ships with the game, so the layout is established from the
save writer's code rather than from a file.

**Evidence:**
[Bounds, objects and the save image (fact)](#bounds-objects-and-the-save-image-fact).

### IIgs sound

The IIgs edition replaces every SOUND resource with one of two formats: a
MIDI-like event stream, and a single sampled note. Both play through the IIgs
Note Synthesizer on the Ensoniq DOC sound chip. At startup the interpreter
uploads the 64 KiB `SIERRASTANDARD` wavetable into the chip's wave RAM, and its
own data segment carries 28 instruments — envelopes, key splits and waves in that
RAM — that the streams select by program number.

The engine replays the streams on the interpreter's 60 Hz heartbeat, tick for
tick: an event runs exactly its timing byte's value in ticks after the previous
one. A sampled note completes when the chip reaches the zero byte that ends its
sample. In the browser the app rebuilds the wave RAM and the instrument bank from
the player's own `SIERRASTANDARD` and `SQ2.SYS16`, and renders each note from its
instrument's waves and envelope. The fade actions run their watchdog schedule and
complete the sound, without the volume steps, because the browser has no GS
system volume.

**Evidence:**
[Sound format (fact, except where marked)](#sound-format-fact-except-where-marked)
and
[Apple IIgs sound fade (fact + host limitation)](#apple-iigs-sound-fade-fact--host-limitation).

### Input and pacing

Keyboard and mouse input arrive through the Event Manager; there are no direct
ADB calls. Menus and dialogs are native desktop UI. The game clock follows the
usual v11 to v14 convention, driven by the heartbeat. The pacing wait lets a
logic pass run only after v10 + 1 timer ticks, one tick later than on PC, so a
game set to v10 = 2 runs at 6.7 passes a second instead of 10.

**Evidence:**
[Input and pacing (fact + inference)](#input-and-pacing-fact--inference).

## Engine and host contracts

These entries describe the engine's own contracts with its host: how it waits
for answers the browser cannot give synchronously, how it reports errors, and
what it exposes for inspection. They are the engine's own design rather than
findings about the original interpreters.

### Host RNG policy

Ordinary cold boots without restored RNG metadata and unseeded From the
beginning Launches start at word zero. Their first random draw reads the
injected host clock/entropy port; subsequent draws read it only when the word
is zero again. This follows the lazy startup boundary established in the
[original startup audit](#startup-and-reconstruction-execution).
The browser supplies cryptographic entropy as a modern stand-in for the BIOS
clock word; hosts without an entropy port use their injected clock.

Explicit boot seeds remain controlled inputs. Seeded Launches also own an
advancing deterministic entropy sequence: Play releases that policy at the
next room change, while Create retains it across rooms. Unseeded room Launches
carry the current word and policy. Native restart and restore retain the stream;
exact host checkpoints restore both the word and entropy cursor.

Game-test RNG policy v1 retains its constant reseed word; v2 advances the
entropy sequence. Walkthrough v1 keeps its tick-derived reseed fallback and
v2 uses the deterministic sequence. History replays consume recorded reseeds
in draw order and reject an exhausted lane. Tapes retain recorded random-byte
answers. These replay policies and released format versions are unchanged by
the fresh-start default.

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

**Tests:** [host-wait.test.ts](../test/host-wait.test.ts) (suspension and delivery),
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

**Tests:** [save-dialog.test.ts](../test/save-dialog.test.ts) (parked restore errors).

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

**Tests:** [worker-presentation.test.ts](../app/test/worker-presentation.test.ts)
(mask publish and dismissal),
[worker-journal.test.ts](../app/test/worker-journal.test.ts) (transition
attribution and replay silence).

### Authored script buffer on live edits

This is a host addition for authored projects. The original sets the script
buffer when the game executes `script.size`
([F-timing-02](#original-script-capacity-and-version-handlers)). Originals keep
the authentic 50-pair default; legacy authored projects preserve their released
200-pair starting allocation through the engine option `legacyRoomMemory`.
Cold boot, restart and a save with no recorded capacity start at 200. An
executed `script.size`, including a smaller value in a later room, retains its
native meaning. A recorded capacity stays authoritative on restore.

The optional project field `authoringConventions` travels in stored bodies,
library indexes, copies, PROJECT.JSON and GAME.JSON. Its integer `version` is
1 for the conventions examined by 1.2.5; 0 identifies an unexamined legacy
project. A stored game without conventions is legacy unless it is a recognized
original release. PROJECT.JSON and GAME.JSON imports without conventions also
count as legacy. New external imports and new projects record version 1 without
`legacyRoomMemory`; changing their code never turns them into legacy projects.
Recognized originals keep their native allocation.

Only exact released LOGIC 0 blocks from versions 1.0 through 1.2.4 are upgraded:
the once-only boot gains `script.size(200)` and the unknown-word fallback gains
zero-based word operands. Resolved syntax compares numeric and named operands
and inline and numbered messages equally. Comments cannot establish a guard;
other writes to its flag prevent the automatic resize. Customized blocks stay
editable and unchanged. Valid mirrored VIEW source with older builder bytes
joins the same **Updated for 1.2.5** History entry and atomic conventions stamp.
The stored native VIEW bytes seed the pre-update state, so Undo restores them
exactly. Existing History keeps its immutable commits and gains a **Before
update** baseline only when needed to preserve those bytes.

No metadata-only examination write is scheduled. Copies and exports carry the
stored conventions, or pending version 0 for an unstamped legacy project; the
session's next commit stamps version 1. Undo, pruning and clearing History retain
that provenance, so automatic upgrades never recur. A refused write leaves both
the old resources and conventions intact for another open to retry.

Customized one-based word feedback shows a sentence above LOGIC 0 reminding the
author to start counting words at 0. The exact released fallback is repaired
automatically; corrected or unrelated code needs no hint.

The separate `adoptDeclaredScriptSize` host option raises capacity to LOGIC 0's
largest declaration on live admission and host resume, without clearing replay
or lowering a larger allocation. Live legacy edits also preserve at least 200,
so Undo cannot shrink a running session. Every worker replacement carries both
options. New History boots record optional `legacyRoomMemory` and
`adoptDeclaredScriptSize` facts, entering the fingerprint only when present.
Pre-version-3 segments with authored project documents explicitly replay with
`legacyRoomMemory`, independently of the current project's stamp or boot flag.

**Tests:** [released-project-upgrades.test.ts](../test/released-project-upgrades.test.ts),
[legacy-room-memory.test.ts](../test/legacy-room-memory.test.ts),
[project-conventions.test.ts](../test/project-conventions.test.ts),
[word-feedback-hint.test.ts](../test/word-feedback-hint.test.ts),
[view-migration-session.test.ts](../app/test/view-migration-session.test.ts),
[script-size-migration.test.ts](../test/script-size-migration.test.ts),
[worker-script-size-migration.test.ts](../app/test/worker-script-size-migration.test.ts),
[script-size-migration-session.test.ts](../app/test/script-size-migration-session.test.ts).

## Appendix A: PC evidence

Evidence for the PC (DOS) interpreters, grouped as in the guide. Each entry
names its builds, method and addresses, then the engine mapping and tests.

- **Randomness and timing:**
  [RNG and wander countdown](#original-rng-and-wander-countdown--binary-investigation),
  [scheduler and modal timing](#original-scheduler-and-modal-timing),
  [timer-interrupt sound](#timer-interrupt-sound-during-blocking-input),
  [have.key polling](#have-key-polling),
  [script key mappings and have.key](#script-key-mappings-and-havekey),
  [free memory in v8](#free-memory-in-v8)
- **Motion and animation:**
  [complete movement and follow audit](#original-complete-movement-and-follow-audit),
  [motion and animation audit](#original-motion-and-animation-audit),
  [completion animation updates](#completion-animation-updates),
  [footprint class flags](#footprint-class-flags),
  [ego direction coupling](#ego-direction-coupling),
  [player.control](#original-playercontrol-handler),
  [border variables](#border-variables-cleared),
  [view loop index retention](#view-loop-index-retention),
  [previous-position commit](#original-previous-position-commit),
  [position handlers](#original-position-handlers),
  [new.room sequence](#original-newroom-sequence)
- **Pictures and text:**
  [cel blit over control pixels](#original-cel-blit-over-control-pixels),
  [add.to.pic control box](#original-addtopic-control-box),
  [text under later graphics](#text-under-later-graphics),
  [window update gate](#window-update-gate),
  [display line layout](#display-line-layout),
  [print handler output modes](#print-handler-output-modes),
  [obj.status.v](#original-objstatusv-modal)
- **Messages, strings and parser:**
  [message formatter](#original-message-formatter),
  [show.obj descriptions](#original-showobj-description-formatting),
  [string slots](#original-string-slot-addressing),
  [compressed logic text](#compressed-logic-plain-text),
  [parser unknown words](#original-parser-unknown-word-audit)
- **Sound:** [sound player audit](#original-sound-player-audit),
  [SN76489 latching and rest notes](#sn76489-attenuation-latching-and-rest-notes)
- **Saving and startup:** [save and restart audit](#original-save-and-restart-audit),
  [startup and reconstruction](#startup-and-reconstruction-execution)
- **Builds:** [3.002.107 is 3.002.102](#3-002-107-is-3-002-102),
  [PC booter 2.001 profile](#pc-booter-2001-profile),
  [booter inventory file](#pc-booter-inventory-file),
  [booter action 0x8f](#pc-booter-action-0x8f-maxdrawnobjects),
  [booter sound rows](#pc-booter-sound-rows),
  [early PC family (2.089/2.230/2.272)](#early-pc-family-208922302272),
  [script capacity and version handlers](#original-script-capacity-and-version-handlers)
- **Screen, input and resource audits:**
  [directory and resource loading](#original-directory-and-resource-loading),
  [input, menu and modal handling](#original-input-menu-and-modal-handling),
  [window and status-line text](#original-window-and-status-line-text),
  [picture drawing and fill](#original-picture-drawing-and-fill),
  [cel handling and priority table](#original-cel-handling-and-priority-table)

### Original RNG and wander countdown — binary investigation

This investigation used original interpreter machine code, NDISASM
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

Static-disassembly inputs for the screen, input and resource audits
(disassembled, not RNG-executed; shipped
files and decoded images hashed in full; Amiga and IIgs executable hashes are
in their own sections below):

```text
ddp-booter disk1.img         254c1406aeb25868fd5a188a534faa2855f468c5e02e76f4b628df8fbd8560c2
ddp-booter decoded (2.001)   424da51a6c161cca8c7dfb9fd78e94b89a1d5301640c845999b54128d1bcd2dd
ddp-booter AGIDATA.OVL       0be2e060f0db7924684d355afb2ea092cbbe55d9da66e5aa2459298222d07b19
sq1-dos-2.089 AGI shipped    4a1cca1097544dc4da97ba6ecfd2b3dfe935fbcb892e0dd1460e3e572478dc5e
sq1-dos-2.089 AGI decoded    e31e5e8611c81d58ba2a8fcc63ecdf7ded767814324c66dfd73b6452f7199cb4
sq1-dos-2.089 AGIDATA.OVL    47b34a71bf394302f2826f5e43788b8b5ac0c3eaa1b853ef6bfb4713d0b48bde
xmas-dos-2.230 AGI.EXE       875547deb3d83b7ed2dd7578d357f43b6a5843a9ac8de1332245df9f60ff4570
xmas-dos-2.230 AGIDATA.OVL   33a327736deb611df48d0d3232c1958b00af1b1cae5fba45ed3aadf88871af8a
xmas-dos-2.272 AGI.EXE       a0c26b5dee86b6761d0996f463d9bed2b93ff356aa4fbb56a55d369501fb588a
xmas-dos-2.272 AGIDATA.OVL   2e2a695a4da7d545c52ea0c01556d198b6d0c3f7eba19e6cbc2b65642616ec40
kq2-dos-2.411 AGIDATA.OVL    1201f66b68f7f6e4ec24abadee5e6fe2d4390315cc56605d8b0b1e7828c96631
lsl1-dos-2.440 AGI decoded   c70e2f327eaad8dbcb1d526e9fb3f933b342329b84c6a803f9062c245ccb7676
lsl1-dos-2.440 AGIDATA.OVL   5b696520d68d6b843711184a63c85cc313818e08cd0afc0452225a97939483a4
pq1 START.EXE (MZ, 2.903, 39424B)  db97accc32e48bac0c759a6364f48790830c90f14a1486be53d1f0b7899730a7
pq1 AGIDATA.OVL              df46a3f13c360045b2d355e97bfad6cb6e1df77ee614fed7b4b1f89778425db3
kq1-dos-2.917 AGIDATA.OVL    f7ca256c1c0ab12509d695baabdd44a3c5e72a570b08118d3ead995a47f4c383
kq3-dos-2.936 AGIDATA.OVL    b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9
kq4-dos-3.002.086 AGIDATA    9738d643dd284d622cee7ee9897a4578ab27d376487ef38ed835c14dcf88d733
demopac4-3.002.102 AGIDATA   1251a5365d5c74232bfb8b01819f85c31ff25c9cd358e942e349a055bc588ea1
mh1-dos-3.002.107 AGIDATA    bb22a87cd215ed52154d49754493e0eb2f6be5688411d8f3b7ac17c417ddae1f
gr1-dos-3.002.149 AGIDATA    914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804
```

With the carry-correct loader decoding, the KQ1, KQ2, KQ3 and BC images all
execute correctly, including their wander routines. Every behavior change in
these audits that modifies shipped profile behavior is verified across all twenty
shipped interpreter profiles from their own binaries; observational `F-*` notes
that confirm existing engine behavior or record single-build diagnostics name
the specific builds inspected.

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
in this pass; the [complete movement audit](#original-complete-movement-and-follow-audit)
executes it. The engine keeps its call order and draws from this RNG.

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

An unconditional count reroll on every direction change would consume extra
randomness and change motion. The engine applies the evidenced count behavior
to the nine verified inputs, including the corrected v2 builds.

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
input.

This RNG probe intercepts BIOS input; it does not establish hardware clock
cadence. The separate [save/restart audit](#original-save-and-restart-audit)
executes those original routine cores in 2.936 and 3.002.149: authentic
save/restore and accepted restart preserve the current RNG stream. Harness
history deliberately restores RNG and external-input cursor as its stronger
checkpoint contract. Full startup and post-restore reconstruction remain
separate from these bounded routine results.

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

**Tests:** [original-scheduler.test.ts](../test/original-scheduler.test.ts),
[worker-original-scheduler.test.ts](../app/test/worker-original-scheduler.test.ts),
[cycle-clock.test.ts](../test/cycle-clock.test.ts),
[game-clock.test.ts](../test/game-clock.test.ts),
[message-modes.test.ts](../test/message-modes.test.ts).
The modal-clock, pause-pacing, selector-clock and out-of-range rollover
regressions were each observed failing before the engine matched these vectors.
Full-machine boot, asynchronous interrupt arrival inside arbitrary instructions,
BIOS/PIT wall-time accuracy and successful disk-transfer latency remain outside
this probe's evidence.

#### Timer verdict

- **F-timing-03 (fact; engine matches on 2.089..3.002.149).** PC timer cadence:
  every build from 2.089 programs PIT channel 0 with the bytes
  `B0 36 E6 43 B8 AE 4D E6 40 86 E0 E6 40` (divisor `0x4dae`, 60.0011 Hz; an
  earlier revision quoted `86 C4`). The IRQ8 handler services sound every tick,
  gated only by the sound-active word, and chains the BIOS vector every third
  tick, so INT 1Ch TimerInt runs at 20 Hz. TimerInt adds 1 to the 32-bit
  `sysTimer` and drains the keyboard outside the pause gate, then, unless
  paused, adds 1 to the pacing counter and to a sub-counter that steps v11 once
  per 20 ticks (`== 20` reset on 2.089..2.411, `while >= 20 subtract` from 2.439;
  nothing else writes it, so the two agree). The pacing wait admits a pass once
  the counter reaches v10 and then clears it. Exactly three code paths write
  the pause word: the pause action `0x88`, which also stops the sound, and the
  save and restore wrappers.

  | Build     | PIT program | IRQ8     | INT 1Ch  | TimerInt | Pause word | Pacing / sub DS     | Pacing wait |
  | --------- | ----------- | -------- | -------- | -------- | ---------- | ------------------- | ----------- |
  | 2.089     | `0x7890`    | `0x7925` | `0x794f` | `0x7459` | `0x3df`    | `0x132a` / `0x132c` | `0x74db`    |
  | 2.230     | `0x7819`    | `0x78ae` | `0x78d8` | `0x73dc` | `0x3df`    | `0x131e` / `0x1320` | `0x745e`    |
  | 2.272     | `0x78bf`    | `0x7954` | `0x797e` | `0x7478` | `0x40f`    | `0x13ee` / `0x13f0` | `0x74fa`    |
  | 2.411     | `0x7fb8`    | `0x8092` | `0x80bd` | `0x7b2d` | `0x613`    | `0x1653` / `0x1655` | `0x7baf`    |
  | 2.439     | `0x80d9`    | `0x81b3` | `0x81de` | `0x7c4a` | `0x613`    | `0x1700` / `0x1702` | `0x7cc9`    |
  | 2.440     | `0x80e1`    | `0x81bb` | `0x81e6` | `0x7c52` | `0x613`    | `0x1700` / `0x1702` | `0x7cd1`    |
  | 2.903     | `0x836d`    | `0x8447` | `0x8472` | `0x7e22` | `0x615`    | `0x1758` / `0x175a` | `0x7ea1`    |
  | 2.915     | `0x836c`    | `0x8446` | `0x8471` | `0x7e21` | `0x615`    | `0x177a` / `0x177c` | `0x7ea0`    |
  | 2.917     | `0x8380`    | `0x845a` | `0x8485` | `0x7e35` | `0x615`    | `0x177a` / `0x177c` | `0x7eb4`    |
  | 2.936     | `0x8447`    | `0x8521` | `0x854c` | `0x7efc` | `0x615`    | `0x1784` / `0x1786` | `0x7f7b`    |
  | 3.002.086 | `0x8886`    | `0x8960` | `0x898b` | `0x833b` | `0x615`    | `0x17f4` / `0x17f6` | `0x83ba`    |
  | 3.002.102 | `0x889e`    | `0x8978` | `0x89a3` | `0x8353` | `0x618`    | `0x1806` / `0x1808` | `0x83d2`    |
  | 3.002.107 | `0x889e`    | `0x8978` | `0x89a3` | `0x8353` | `0x618`    | `0x1806` / `0x1808` | `0x83d2`    |
  | 3.002.149 | `0x874d`    | `0x8827` | `0x8852` | `0x8210` | `0x438`    | `0x15bb` / `0x15bd` | `0x828f`    |

  Hashes are under [Original string slot addressing](#original-string-slot-addressing) and
  [Original save-file interoperability](#original-save-file-interoperability). The booter 2.001
  keeps the BIOS rate instead: [PC booter clock](#pc-booter-clock).

### Timer-interrupt sound during blocking input

Sound is never pumped by the main interpreter loop. The v2 (KQ1, descrambled AGI) and v3 (MH1,
AGI 3.002.107) executables both service the sound player from a hardware timer interrupt handler,
so music keeps playing while the interpreter is blocked inside the get.string/get.num keyboard
editor: script execution and movers wait, while sound and the script clock continue.
The [coupled scheduler execution](#original-scheduler-and-modal-timing) verifies that distinction.

Disassembly evidence (load-module offsets):

- MH1: handler at 0x8978 (`iret`, EOI via port 0x20) tests the sound-active flag `[0x12db]` and
  calls the player at 0x8473 every tick, chaining to the previous vector (`call far [0x18b9]`)
  every third tick. The player loops channels at 0x8483, decrements duration counters
  `[bx+0x1812]`, loads notes via `[bx+0x180a]` and writes the chip through 0x854a.
- KQ1: identical code — handler at 0x845a calls the player at 0x7f55 (same structure; both even
  share the `E8DCF4` call to the f9 flag check), chaining every third tick via
  `call far [0xdf35]`.

**Engine mapping:** the worker suspends the interpreter pass during
get.string/get.num instead of blocking its event loop, so the sound clock keeps
advancing — matching the hardware. Replay records the separate clock lane so suspended logic does not imply
zero elapsed sound time. This harness clock contract remains distinct from
full DOS interrupt-cadence verification.

### Have key polling

A have.key poll issued once per cycle never blocks, in text mode either; only a busy loop inside one
logic invocation (proven by repeated polls) waits for a key.

The Space Quest intro polls once per cycle to let a key skip its text-screen captions.

**Specification:** The spec describes have.key as a simple key-pressed predicate.

**Evidence:** Follows the shipped games' usage: a per-cycle poll must return immediately for the cycle's
logic to keep running. (No load-module offsets recorded.)

**Tests:** [parser-input.test.ts](../test/parser-input.test.ts),
[input-contract.test.ts](../test/input-contract.test.ts).

### Script key mappings and have.key

Static disassembly of seven PC builds (hashes under
[Verified inputs](#verified-inputs); KQ1, KQ2 and KQ3 decoded with
`scripts/descramble-agi.ts`). Load-module offsets for DEMOPAC4 3.002.102:

- The INT1Ch timer service (0x8353, the same routine as MH1's in
  [Original scheduler and modal timing](#original-scheduler-and-modal-timing))
  calls 0x48ce, whose loop 0x4ac3 drains the BIOS keyboard (0x5eb3, INT 16h) and
  enqueues each key through 0x48dd: navigation words as type 2, every other key
  as type 1 with its ASCII byte. Nothing on this path reads the key map.
- `set.key` (0x5080 region) fills the key map at DS 0x145 (raw word) and 0x147
  (status), 39 four-byte entries.
- The key-map lookup 0x499a turns a type-1 event whose word matches an entry
  into type 3 with the status number. Its only caller is the input phase
  (0x3931), which clears v19 and v9, then dequeues (0x492d) and maps each event
  before dispatching it: type 1 stores v19 and reaches the line editor, type 3
  raises the controller.
- The `have.key` condition (0x0c13) returns true when v19 is nonzero; otherwise
  it loops on 0x49d2, which dequeues without the key-map lookup, normalizes
  keypad words through 0x4a78 and returns the type-1 value (other types are
  discarded).

Every build has one key-map lookup, called only from its input phase, and a
`have.key` dequeue helper that calls no lookup:

| Build              | have.key | dequeue helper | key-map lookup | input-phase call |
| ------------------ | -------- | -------------- | -------------- | ---------------- |
| KQ2 2.411          | 0x098b   | 0x4468         | 0x4430         | 0x3497           |
| KQ1 2.917          | 0x09be   | 0x459e         | 0x4566         | 0x3599           |
| KQ3 2.936          | 0x09be   | 0x459e         | 0x4566         | 0x3599           |
| KQ4 3.002.086      | 0x0bfd   | 0x49bc         | 0x4984         | 0x3936           |
| DEMOPAC4 3.002.102 | 0x0c13   | 0x49d2         | 0x499a         | 0x394c           |
| MH1 3.002.107      | 0x0c13   | 0x49d2         | 0x499a         | 0x394c           |
| GR1 3.002.149      | 0x0c0c   | 0x47e9         | 0x47b1         | 0x38eb           |

**Facts:** mappings apply in the input phase only; `have.key` reads raw type-1
keys, mapped or not; keys are queued by the timer interrupt, asynchronously to
the logic pass.

**Inference:** whether a once-per-cycle `have.key` sees a mapped key depends on
when it arrives: during the logic pass, before the poll, it is raw; otherwise
the next input phase maps it. A busy loop spins inside the logic pass, so it
always sees the key raw. The Demo Pack title (logic 1) polls `have.key` once
per cycle while logic 0 maps Enter to controller 14, at speed v10 = 0.

**Engine mapping:** the queue holds raw keys; the input phase maps them;
`have.key` never does. The host delivers keys at the cycle boundary, before the
input phase (the spec's cycle-boundary input contract), so a once-per-cycle poll
sees a mapped key as its controller, while a key that reaches a busy loop, or a
poll after the input phase, is raw. The Play screen's key hint names only
unmapped keys for such a title.

**Tests:** [input-fidelity.test.ts](../test/input-fidelity.test.ts),
[demopac4.test.ts](../test/demopac4.test.ts) (fixture-gated). Each was observed
failing while the engine mapped keys as they were queued.

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

**Tests:** [opcodes.test.ts](../test/opcodes.test.ts).

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
already-MZ hashes in the [verified-input table](#verified-inputs). Load-module entry offsets:

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

Behaviors established by these vectors, all followed by the engine:

- Horizontal screen bounds are resolved before vertical bounds. Simultaneous
  top/left or top/right reports border 1; bottom/left or bottom/right reports 3.
- A non-ego target screen object completing at a border restores its saved step, sets its
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
- Every eligible screen object changes cel before any screen object moves. A later screen object growing
  or shrinking can therefore change the first screen object’s collision result in the
  same pass.
- Water and land restrictions are independent bits. Setting both rejects ordinary
  footprints on water and land; priority 15 still bypasses the footprint test.
  `obj.on.anything` clears both. Save packing and navigation retain the combined
  constraint.
- After an executed postlogic updating-object pass, ego's water/land restriction
  bits are cleared. Non-ego restrictions persist. If no screen object is eligible, the
  dispatcher skips movement and preserves ego's restrictions and v2. The broader
  top-level tail still separately clears v4/v5.

The vectors also confirm behavior the engine already modelled: stopped-update screen objects remain collision candidates
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
a mode-only `normal.cycle` on a stopped object failed at that assertion.
Independent synthetic Engine execution confirmed these contracts:

- `normal.cycle` and `reverse.cycle` set cycling bit 0x20 as well as mode. They
  do not set update bit 0x10 or reset cadence counters. After `stop.cycling`,
  either command resumes cycling; changing only the mode is not enough.
- `follow.ego` sets update bit 0x10 and captures
  `max(requestedDistance, currentStepSize)` at opcode execution. Step size 4
  with requests `[0,1,4,5,255]` produces thresholds `[4,4,4,5,255]`; retry is 255. An ego three pixels away on the same baseline completes on the next
  motion update in all five cases. `move.obj` also sets update bit 0x10, so
  target and follow motion never stay in the stopped update partition.
- Object bytes 0x27..0x2a are one shared parameter bank. `move.obj` writes
  `[targetX,targetY,savedStep,completionFlag]`; `follow.ego` writes
  `[effectiveThreshold,completionFlag,255,unchanged]`; `end.of.loop` and
  `reverse.loop` write their completion flag into the **first byte**. Animation
  completion reads that first byte even when later motion overwrote it.

For a non-ego screen object at (10,80), step size 4 and three cels:

| Opcode sequence                                  | Final shared bank | Observable result                      |
| ------------------------------------------------ | ----------------- | -------------------------------------- |
| `move.obj(o1,90,80,2,f62); end.of.loop(o1,f61);` | `[61,80,4,62]`    | Target X becomes 61.                   |
| `end.of.loop(o1,f61); move.obj(o1,90,80,2,f62);` | `[90,80,4,62]`    | Completion at cel 2 sets f90, not f61. |

`reverse.loop` has the same overwrite and sets f90 on reaching cel 0 in the
second ordering. One initial animation call consumes the delay before an
eligible call advances from cel 1. Completion stops cycling, zeros direction
and returns cycle mode to normal; the engine matches these final effects.
`cycle.time(v=7)` writes both interval and remaining counter to 7, as the engine does.
Do not infer full scheduler tick counts from this isolated routine execution.

**Engine mapping:** the engine applies the cycling, update and threshold effects
and keeps one authoritative four-byte bank with mode-dependent accessors,
preserving bytes a handler does not write. Flag index zero is valid. The same
bank rides the 43-byte save object records and rewind snapshots; separate
follow-retry, cycle-flag and wander-count packing is not the original layout
and is not kept as a compatibility layer. Tests cover both opcode orderings
before and after restore ([object-cadence.test.ts](../test/object-cadence.test.ts))
and a record→seek→resume sequence
([worker-history-view.test.ts](../app/test/worker-history-view.test.ts)).
Early profiles, full collision/footprint ordering and stochastic follow retries
remain open investigations, not verified claims.

Reproduce after decoding the private KQ3 executable:

```sh
python scripts/probe-interpreter-motion.py /tmp/agi-fixed-kq3.bin --profile 2.936
python scripts/probe-interpreter-motion.py games/mh1/AGI --profile 3.002.107
python scripts/probe-interpreter-motion.py games/gr1/AGI --profile 3.002.149
```

#### Motion verdicts

Static disassembly of the decoded KQ3 2.936 image (`4b50c681…`, runtime
offsets) and the KQ4 3.002.086 code body (`f05abff4…`, body offsets); quoted
data-table bytes come from the hash-pinned overlays. Facts below are read
directly off the machine code; each entry names the finding it settles.

- **F-motion-02 (fact; engine matches).** Pre-logic
  order (PC main cycle: 2.001 0x013c..0x0159, 2.089 0x00e6..0x0103, 2.230
  0x00e6..0x0103, 2.272 0x00e6..0x0103, 2.411/2.440 0x0181..0x019e,
  2.903/2.917/2.936/3.002.086 0x0150..0x0198, 3.002.102/3.002.107
  0x0167..0x01af, 3.002.149 0x0160..0x01a8; Amiga main cycle: 2.082
  h5+0x01f0..0x022e, 2.176/2.202 h6+0x0206..0x024c, 2.310/2.316/2.333
  h6+0x0246..0x02a0; IIgs 1.014 main+0x0386..0x03c4): on PC 2.001..2.272 and
  `amiga-2.082`, the autonomous-direction/block dispatcher (`GetObjDirs`: PC
  2.001 0x598e, 2.089 0x57ad, 2.230 0x5731, 2.272 0x57cd; Amiga 2.082 h16+0x0)
  runs BEFORE `PollInput` and the ego↔v6 direction mirror
  (`preLogicDirectionMirror: false`). From PC 2.411..3.002.149, Amiga
  2.176..2.333, and IIgs 1.014, the ego↔v6 direction mirror — under program
  control `v6 := ego.dir` (e.g. kq3 0x186-0x189), else `ego.dir := v6`
  (0x18E-0x195) — runs BEFORE `GetObjDirs` (`preLogicDirectionMirror: true`,
  PC 2.411/2.440 0x0611, 2.903..3.002.086 0x0644, 3.002.102/3.002.107 0x065b,
  3.002.149 0x0654; Amiga 2.176+ h22+0x0; IIgs animateseg+0x0); a second
  post-logic `ego.dir := v6` store sits after logic 0 (e.g. kq3 0x1EA) before
  `Animate`/`MoveObjs`. Engine: matches the pre-logic vs post-block mirror order
  and the post-logic `Animate`/`MoveObjs` phase across all twenty profiles
  (field `preLogicDirectionMirror`).
- **F-motion-03 (fact; engine matches).** Zero-step reposition pass (2.936 kq3
  0x150A / 3.002.086 kq4 body 0x1751): the REPOS test (0x0400) skips only the
  direction-delta computation; border clamps+reporting, Collide, CanBHere and
  FindPosn all run, REPOS cleared at pass end. Left-edge compare is `jnl`
  (x<0) in 2.936 but `jg` (x<=0) in 3.002.086 — a repositioned-to-x=0 ego
  reports v2=4 each due pass under 3.002.086 (kq4 body 0x17E2).
- **F-motion-05 (fact; engine matches).** Border completion (2.936 kq3
  0x1657): the EndMoveObj call (restore stepsize, Set(completion flag),
  motion:=0, ego: userCtrl:=1 / v6:=0) is gated on motion==MOVETO;
  wander/follow border stops report v2/v4/v5 only and never restore player
  control.
- **F-motion-06 (fact; engine matches).** normal.motion (2.936 kq3, handler
  0x6EA1) is a single `mov byte [rec+0x22],0` after the record index; it
  never touches userCtrl/v6, so ego stays under program control until
  player.control.
- **F-motion-07 (fact; engine matches on valid directions `0..8`; documented divergence on unusual input `direction > 8`).**
  Direction deltas (`2.936` kq3): `xs`/`ys` 9-word tables at `DS:0x0a61`/`DS:0x0a73`
  are indexed `imul word [bx+0x0a61]` with the raw direction byte — no bounds
  check, so `direction > 8` in `MoveObjs` (`0x1542`) reads the following words
  in `AGIDATA.OVL` (the `move.obj` direction table at `DS:0x0a85`), and
  `Animate` (`0x0563`) likewise indexes the `twoLoop`/`fourLoop` tables at
  `DS:0x08dd`/`DS:0x08e7` unchecked, whereas `ChkBlock` (`0x06d9`) uses an
  8-case switch (`1..8`) and leaves `direction > 8` stationary. Runtime
  reachability in shipped games is not established: no literal `set.dir` or
  `v6` constant outside `0..8` appears in the 2,425 decoded `LOGIC` resources
  across the 25 unpacked AGI fixtures, but `set.dir(oA, vB)` reads a runtime
  variable whose dynamic range across all play paths is not settled by static
  scan. (Across the fixture set, unreadable `LOGIC` directory entries are `sq2`
  `2.936`, `sq2-amiga` `amiga-2.202`, and `sq2-iigs` `iigs-1.014` `LOGIC.141`
  where `LOGDIR[141]` points to `VOL.0:131071` past EOF; `xmas-dos-2.230`
  `2.230` with 83 `LOGDIR` entries and `xmas-dos-2.272` `2.272` with 72 `LOGDIR`
  entries pointing to unshipped `VOL.1`/`VOL.2`; plus `ddp-booter` `2.001`,
  stored as a raw booter floppy image `disk1.img`. Disassembler `// !!` decoding
  warnings occur in 3 of the 2,425 decoded `LOGIC` resources: `mh1` `3.002.102`
  `LOGIC.159` at offset 443, `xmas-dos-2.272` `2.272` `LOGIC.99` at offsets
  265/274, and `sq1-amiga` `amiga-2.082` `LOGIC.99` with 18 warnings at offsets
  0/10 and 22..125.) Engine: `directionDelta` returns `[0, 0]` and `selectLoop`
  preserves `obj.loop` for `direction > 8` so an out-of-range direction leaves
  the object stationary with its current loop rather than reading build-specific
  adjacent `AGIDATA.OVL` bytes; emulating the unchecked overread is deferred.
- **F-motion-08 (fact; engine matches).** Footprint flag timing (2.936 kq3):
  MoveObjs calls Collide (0x4719) before CanBHere (0x56B8) with
  short-circuit; the f3/f0 Set/Reset calls live at CanBHere 0x572B-0x574C
  (ego only), so they are written per scan attempt, including FindPosn's
  per-candidate re-calls (0x598D-0x59A7).
- **F-motion-09 (fact; engine matches).** set.horizon (2.936 kq3, handler
  0x7E7C) is operand-fetch + store to the horizon global DS:0x12D and
  returns; no object relocation — enforcement is lazy via the MoveObjs clamp
  and GoodPos.
- **F-motion-10 (fact on the 15 PC and 6 Amiga builds; engine matches).** new.room object loop.
  PC (record stride `0x2b`; function start / first `and word [si+0x25],0xffbe` of the loop):

  | Build         | NewRoom  | Reset loop |
  | ------------- | -------- | ---------- |
  | 2.001         | `0x170b` | `0x1735`   |
  | 2.089         | `0x164b` | `0x1678`   |
  | 2.230         | `0x1595` | `0x15b9`   |
  | 2.272         | `0x1633` | `0x1657`   |
  | 2.411         | `0x1741` | `0x1765`   |
  | 2.439         | `0x174f` | `0x1773`   |
  | 2.440         | `0x1757` | `0x177b`   |
  | 2.903         | `0x178d` | `0x17b1`   |
  | 2.915 / 2.917 | `0x1792` | `0x17b6`   |
  | 2.936         | `0x1792` | `0x17b6`   |
  | 3.002.086     | `0x1a3b` | `0x1a5f`   |
  | 3.002.102/107 | `0x1a51` | `0x1a75`   |
  | 3.002.149     | `0x1a0a` | `0x1a2e`   |

  Amiga (record stride `0x48`, control word at `$3e(a5)`): `2.082` `h36+0x0066..0x00a8`,
  `2.176..2.333` `h51+0x006c..0x00ae`. PC: `and word [si+0x25],0xffbe / or word [si+0x25],0x10`;
  Amiga: `andi.w #$ffbe,d0 / ori.w #$10,d0` stored back to `$3e(a5)`. Drawn (`0x01`) and animated
  membership (`0x40`) clear, the update-partition bit (`0x10`) is set on every record, and every
  other control bit survives, including pending-reposition (`0x0400`) and the initial animation
  delay (`0x1000`) (contrast `unanimate.all`, action `0x22`, whose loop clears `0x41` only and
  does not set `0x10`; on Amiga that loop is `h13+0x00ae` on `2.082` and `h16+0x00ae` on
  `2.176..2.333`). Null stores clear `viewptr`, `celptr` and `save` (PC `[si+0x8]`, `[si+0x10]`,
  `[si+0x14]`); unit stores write `movefreq`, `moveclk`, `stepsize`, `cyclefreq` and `cycleclk`
  (five byte stores on PC, five word stores on Amiga); `x`, `y` and `dir` are preserved. IIgs
  `1.014` (`seg2+0x0046..0x009a`, record stride `0x30`) is from the earlier pass and was not
  re-verified. Engine: `profile.newRoomPreservesReposAndCycleDelay` is `true` for every profile.

- **F-motion-12 (fact; engine matches on valid placement; documented divergence on unusual input when no legal position exists).**
  `FindPosn` (`2.936` kq3 `0x593a`): if `y <= horizon` and `!IGNRHRZ`, sets
  `y = horizon + 1` before testing; spiral legs `x--`/`y++`/`x++`/`y--` with leg
  length incremented after the down and up legs; the only exits are
  `GoodPos ∧ ¬Collide ∧ CanBHere` acceptance. No bound or iteration cap — when
  no acceptable candidate exists on the 160×168 surface, the original loops
  indefinitely. Runtime reachability of spiral exhaustion in shipped games is
  not established: whether any dynamic combination of object footprint width,
  horizon, priority/water/control-line restrictions, and other solid objects'
  coordinates can leave zero legal positions across all reachable play states
  cannot be proved by static `PICTURE`/`LOGIC` inspection (and the `LOGIC` scan
  has the unreadable entries and decoding warnings listed in `F-motion-07`).
  Engine: applies the initial `y = horizon + 1` adjustment and searches the
  exact spiral covering the 160×168 surface; if no acceptable position exists
  anywhere on the surface, `placeObject` throws
  `new Error("no acceptable position for object")` rather than hanging the
  worker thread in an infinite loop or latching an unserialized mid-instruction
  stall; emulating the unbounded hang is deferred.
- **F-motion-13 (fact; engine matches).** Movement clamps (2.936 kq3 0x159B):
  X then Y, each an else-if chain; Y order top (y-ysize<-1) → bottom (>167) →
  horizon (!IGNRHRZ ∧ y≤horizon → horizon+1, border 1). Top clamp pre-empts
  the horizon clamp.
- **F-motion-18 (fact; engine matches).** Pre-logic block check (2.936 kq3,
  ChkBlock 0x6D9): next point = x/y ± record stepsize (+0x1E) via an 8-case
  dir switch; gated only on moveclk==1 and dir≠0 — the REPOS suppressed-step
  case still uses full stepsize.
- **F-motion-19 (fact; engine matches).** Animate first sweep (2.936 kq3
  0x563): per updating record, direction-based loop selection
  (twoLoop/fourLoop, moveclk==1, !FIXEDLOOP, SetLoop 0x3BB7) precedes the
  CYCLE countdown and AdvanceCel (0x48B3) in the same iteration.
- **F-motion-20 (fact; engine matches).** Redraw cadence (2.936 kq3 0x610):
  the per-frame path restores/moves/rebuilds/draws only the update list
  DS:0x16FF (predicate (ctl&0x51)==0x51); stopped objects (predicate ==0x41)
  live in list DS:0x1703, touched only by whole-screen routines — no
  per-frame redraw of stopped-update objects.

#### Motion verdicts, second pass

Static disassembly of the decoded KQ3 2.936 image (`4b50c681…`, runtime
offsets), the Amiga hunk executables (`2.082..2.333`), and IIgs `SQ2.SYS16`
1.014 (`e1a2788f…`).

- **F-motion-04 (fact; engine matches; correction).** `start.motion` (`0x4e`)
  retains direction (`2.936` kq3 `0x6F05`; PC `2.272` `0x6912`, `2.411`
  `0x6B42`, `2.440` `0x6C3D`, `2.903` `0x6E2E`, `2.917` `0x6E3D`, `3.002.086`
  `0x733B`, `3.002.102`/`3.002.107` `0x7353`, `3.002.149` `0x727A`; Amiga
  `2.082` Sierra `h120+0x29a`, `2.176` KQ2 `h165+0x222`, `2.202` SQ2 and
  `2.310..2.333` PQ1/GR/MH2 `h165+0x2ae`; IIgs `1.014` `motionseg+0x01d9`):
  `start.motion` clears only the motion field (PC `+0x22`, Amiga/IIgs `+0x38`)
  — the direction byte/word is retained — and for ego sets `v6 = 0` and
  `userCtrl = 1` (on PC `2.001` `0x65FA`, `2.089` `0x68CC`, `2.230` `0x6876`,
  `start.motion` leaves both direction and motion untouched, matching
  `movementClear: "early"`). `stop.motion` (`0x4d`: kq3 `0x6EC8`, Sierra
  `h120+0x24e`, KQ2 `h165+0x1d6`, SQ2/PQ1/GR/MH2 `h165+0x262`, IIgs
  `motionseg+0x019f`) clears both the direction (PC `+0x21`, Amiga/IIgs
  `+0x36`) and motion fields and sets ego `userCtrl = 0` (and `v6 = 0` on
  Amiga/IIgs; PC `2.001..2.230` `0x65CF`/`0x68A1`/`0x684B` clear only
  direction `+0x21`). **Correction:** the Amiga profile bullet under
  [Amiga runtime details verified from the handlers](#amiga-runtime-details-verified-from-the-handlers-fact)
  previously claimed `stop.motion`/`start.motion` both clear direction and
  motion on every build; every address it cited was a `stop.motion` handler.
  The corrected bullet stands there.
- **F-motion-16 (fact; engine matches on valid indices; documented divergence on unusual input for `Error(errNum, errVal)` recovery and out-of-bounds `set.loop`/`set.cel`).**
  `set.loop`/`set.cel` bounds (`2.936` kq3): `SetLoop` `0x3BB7` — `viewptr` NULL
  → `Error(6)`; `loop > loopcnt` → `Error(5)` (`jnc`, so `loop == loopcnt`
  passes and `_SetLoop` `0x3C1B` reads one word past the loop-offset table).
  `SetCel` `0x3CCB` — `viewptr` NULL → `Error(10)`; `cel >= celcnt` → `Error(8)`
  (strict `ja`). `_SetLoop` clamps `cel` to `0` when `cel >=` the new `celcnt`.
  `draw` `0x0A06`: unanimated record → `Error(19)`, `celptr` NULL → `Error(20)`.
  `Error` `0x3FE8` stores `var[17] = errNum`, `var[18] = errVal` and `longjmp`s
  (`0x7EEF`) back to the main cycle before Logic 0. Runtime reachability of
  Errors `5`, `6`, `8`, `10`, `19`, and `20` in shipped games is not
  established: while static inspection of the 2,425 decoded `LOGIC` resources
  finds `mh2` (`3.002.149`) / `mh2-amiga` (`amiga-2.333`) `LOGIC.192` (room 192,
  `"the fall into Hell"`), which executes `set.loop(o3, 2)` (`loop == loopcnt`)
  on 2-loop `view 69` while `o3` is undrawn and then sets `set.loop(o3, 0)` or
  `set.loop(o3, 1)` before `draw(o3)`, dynamic reachability through `set.loop.v`,
  `set.cel.v`, `set.view.v`, and conditional `draw` paths across all play states
  is not settled by static scan (and is subject to the unreadable `LOGIC`
  entries and decoding warnings listed in `F-motion-07`). Engine: `setLoop`
  (`set.loop`/`set.loop.v`) stores the requested loop index and clamps
  `obj.cel` to `0` when `obj.cel >= celCount`. `setCel`
  (`set.cel`/`set.cel.v`) retains the requested cel index, including an invalid
  index. Both update cel dimensions (`xsize`/`ysize`) when a valid cel exists,
  without entering `Error(errNum, errVal)` recovery or latching `v17`/`v18`;
  `draw` throws if a drawn object still lacks an assigned
  view or valid cel rather than silently skipping the draw or corrupting the
  frame via a mid-script `longjmp`. `Error(errNum, errVal)` `longjmp` recovery
  and the `loop == loopcnt` header overread are deferred.
- **F-motion-17 (fact; engine matches).** Amiga click-move update (`MH2`
  `2.333`, shared across `2.082..2.333`): the direction dispatcher (`h16+0x24c`
  in `2.333`, `h13+0x246` in `2.082`) jumps motion types 3 (`move.obj`) and 4
  (click-move) to the same direction-to-target routine (`h45+0x0` in
  `2.176..2.333`, `h32+0x0` in `2.082`). Arrival (computed direction 0) runs
  `EndMove` (`h45+0x64` / `h32+0x64`): restore `stepsize` from `+0x44`, clear
  the motion word, ego `userCtrl := 1` / `v6 := 0` — with the completion-flag
  `SetFlag` skipped for type 4 (`subq.w #4; beq` at `h45+0x76` / `h32+0x76`).
  The `MoveObjs` border tail (`h16+0x35e` / `h13+0x358`) gates its `EndMove`
  call on `type == 3`, so a click-move border stop does not double-complete.
  Condition `0x13` in `2.310..2.333` is `motion == 4` (`h23+0x2b2`).

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

**Tests:** [object-cadence.test.ts](../test/object-cadence.test.ts) covers both directions
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

**Specification:** "Footprint control acceptance" states a final-cell rule for both classes.

**Evidence:** 3.002.102 and 3.002.107, scan at 0x5ae2: starts with the water state set, clears it on any
non-water cell, latches trigger on control 2, feeds both to f3/f0 for object 0 and applies the
on-water/on-land gates to the all-water state.

**Tests:** [object-cadence.test.ts](../test/object-cadence.test.ts).

### Ego direction coupling

Targeted motion on ego (move.obj, move.obj.v, wander) takes program control; arrival or a border
stop restores player control and clears v6.

A zero-distance move.obj on ego is the idiom that hands control back after a scripted placement.

**Specification:** The movement chapter is silent on the direction coupling.

**Evidence:** The shipped 2.936 and 3.002.x move.obj, move.obj.v and wander handlers write 0 to the
coupling selector for object 0; their motion-stop routine writes 1 and zeroes v6 for object 0. (No
load-module offsets recorded.)

**Tests:** [ego-motion-control.test.ts](../test/ego-motion-control.test.ts).

### Original player.control handler

Static disassembly of the descrambled KQ3 2.936 image. The handler at 0x7041
stores 1 in the direction-coupling word at DS:0x0139 and clears object 0's
motion-type byte (record offset 0x22); `program.control` at 0x7034 stores 0 and
touches nothing else. Fact: `player.control` ends a running `move.obj`,
`wander` or `follow.ego` on object 0 without changing its direction byte.
Switching only the coupling would let a scripted ego walk continue after the
script hands control back; Police Quest depends on the stop.

The Amiga builds split on the prior control state (hunk-relative offsets
resolved through each executable's relocation table; the six-byte dispatch
record for opcode 0x84 names each entry). SQ1 2.082's handler at h120+0x412
(hunk `a9b73f7f501b21aa`) matches the DOS form: store 1 in the player-control
field (state hunk `+0x1a`), clear ego's motion word, done. The five later
builds — KQ2 2.176, SQ2 2.202, PQ1 2.310, GR 2.316 and MH2 2.333 — share one
handler at h165+0x41e (hunk `b16f88c2b26e6c01`): it tests the prior control
field at h206+0x1a and returns without touching ego when player control is
already selected, so the motion word clears only on a program→player
transition. Executing each relocated handler against both prior states and
autonomous modes 1–4 confirms the branch reads the control field, not the
motion: the later builds preserve modes 1–4 under prior player control and
clear them under prior program control, 2.082 clears in both, and the
direction byte is untouched either way. PQ1's logic 0 issues `player.control`
on every ordinary cycle while its program-control flag is clear, so the
unconditional form strands its click-walks mid-path with the first heading
kept. `AgiProfile.playerControlMotionClear` selects between the two forms.

The IIgs handler (`SQ2.SYS16` 1.014, `e1a2788f…`, `motionseg+0x02b2`;
action-table entry 132 resolved from the `~arrays` `cINTERSEG` stream) is the
later-Amiga form: `lda $011d; bne ret` skips ego entirely under prior player
control, else stores `1` and clears ego's motion word (record `+0x38`).
`program.control` (`motionseg+0x022c`) is `stz $011d` only. `iigs-1.014`
therefore selects `playerControlMotionClear: "on-control-transition"` (fact;
engine matches). On PC `2.001..3.002.149` (e.g. `2.001` `0x6732`, `2.089`
`0x6a05`, `2.936` `0x7041`, `3.002.149` `0x73bf`) the handler is the DOS
`"always"` form verbatim — no read of the prior control word — so all PC
profiles match (fact).

**Tests:** [ego-motion-control.test.ts](../test/ego-motion-control.test.ts),
[amiga-player-control.test.ts](../test/amiga-player-control.test.ts).

### Border variables cleared

Each executed movement pass zeroes the border variables v2, v4 and v5. When
no screen object belongs to the updating list, the original dispatcher skips that
pass and leaves v2 intact; the top-level tail still clears v4/v5 separately.
See the [complete movement audit](#original-complete-movement-and-follow-audit).

Manhunter's v3 city map polls v2 for page turns.

**Specification:** The spec clears v4 and v5 at the cycle start and v2 only on room entry.

**Evidence:** the hash-pinned dispatcher and movement executions in that audit
cover both the eligible-screen object and empty-list branches, with entry offsets.

**Tests:** [object-cadence.test.ts](../test/object-cadence.test.ts), [mh1.test.ts](../test/mh1.test.ts).

### View loop index retention

set.view keeps the current loop when the new view has that many loops, else loop 0; set.loop (and
the direction-driven loop change) keeps the current cel when the new loop has that many cels, else
cel 0. Only an out-of-range index falls back to 0.

Manhunter's knife game (logic 118) re-selects loop 0 every cycle while it waits for the barker's cel
to come round; a reset-to-0 would freeze it forever.

**Specification:** "set.view" reads "select its default loop and cel".

**Evidence:** SetView: 3.002.102 offset 0x3e9a; 2.917 and 2.936 match. SetLoop: 3.002.102 offset 0x3f6a
with its core at 0x3fce; 2.917 and 2.936 at 0x3c1x. The binaries only fall back to the defaults when
the kept indices are out of range.

**Tests:** [object-cadence.test.ts](../test/object-cadence.test.ts), [mh1.test.ts](../test/mh1.test.ts).

### Original previous-position commit

Static disassembly of the descrambled KQ3 2.936 image. The collision routine at
0x4719 compares the mover's and the other screen object's word at record offset 0x18
with their baselines at 0x05. That word has four writers: `position` and
`position.v` (0x7c1c, 0x7c5a), `draw` (0x0a5a) and the screen object-list commit at
0x048c..0x04d8. For each listed screen object whose step countdown equals its step
time, the commit sets state bit 0x4000 when x and y equal the saved pair, and
otherwise copies x and y into 0x16/0x18 and clears the bit. Fact: the movement
routine does not write the saved pair. Inference from that placement: the pair
changes once per pass after every screen object has moved, so a later screen object in the pass
tests against an earlier screen object's pre-move value, and on the next pass a mover's
saved baseline equals its current one. No routine was executed for this entry;
the executed [movement vectors](#original-complete-movement-and-follow-audit) used steps for which both readings agree.

The engine commits the pair the same way, after the whole pass has moved and
only for screen objects whose countdown reloaded, and derives the stationary bit from
that comparison. A pair written inside the move would sit one step stale: an
screen object stepping one pixel per pass past a standing screen object's corner would be
judged to have crossed its baseline a pass late and stop for good. Police
Quest logic 37 walks the bikers out past a scripted ego position this way.
Because `reposition` and cel clipping move x/y without touching the pair, an
screen object they move reads as moved even when its own step lands back on its feet;
Space Quest II's swamp lurker, nudged by its room script while it follows
Roger, walks straight at him for that reason instead of sidestepping.

**Tests:** [original-movement.test.ts](../test/original-movement.test.ts).

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

**Tests:** [original-movement.test.ts](../test/original-movement.test.ts).

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

Consequences the engine models, and one it does not:

- The object loop **selects** the updating partition (0x10) while clearing
  drawn (0x01) and animated membership (0x40). A stopped-update screen object
  rejoins the updating partition across a room change; the engine's reset
  reproduces this. What the engine adds is two extra clears the original's
  0xFFBE mask preserves: pending-reposition (0x0400) and the initial
  animation delay (0x1000) are cleared for every object across new.room in
  the engine only (F-motion-10).
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

**Engine decision:** v8 reports the ample-memory constant 255 (see
[Free memory in v8](#free-memory-in-v8)), so the new.room recompute writes the
same value the cycle start already refreshes.

**Tests:** [object-cadence.test.ts](../test/object-cadence.test.ts).

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
survives. Writing the cel priority over control pixels makes the door
impassable. The 2.440 and 2.936 blits live in their object
overlays and were not inspected; the engine applies the rule to every profile
by inference.

**Tests:** [view.test.ts](../test/view.test.ts), [opcodes.test.ts](../test/opcodes.test.ts).

### Original add.to.pic control box

Static disassembly of the descrambled LSL1 2.440 and KQ3 2.936 images (hashes
under [Original string slot addressing](#original-string-slot-addressing)).
The `add.to.pic` handlers at `0x2baa`/`0x2bfa` (`2.440`) and `0x2c7a`/`0x2cca`
(`2.936`) pack the margin operand into the high nibble of the priority byte and
call the shared core at `0x2c82` (`2.440`) / `0x2d52` (`2.936`). Both cores call
`FindPosn` (`2.440` at `0x2d25`, `2.936` at `0x2df5`) and then stamp the cel
through `ObjInPic` at `0x55e8` (`2.440`) / `0x57cf` (`2.936`). The two
`ObjInPic` routines are instruction-for-instruction identical apart from data
addresses. An earlier revision of this entry said `2.440` skips `FindPosn`; the
disassembly shows the call (per-build table in `F-VIEWS-03` below).

Fact: after the cel is drawn, the routine returns if the packed byte exceeds
0x3f, which is a margin of four or more. Otherwise it counts rows upward from
the baseline while the y-to-priority table gives the baseline's band, caps that
count at the cel height, and writes the margin into the priority nibble of: the
whole baseline row across the cel width; the first and last column of each
higher row; and the columns strictly between them on the top row. A box one row
tall is the baseline row alone. Fact: a priority operand whose low nibble is
zero takes the baseline's band. Fact: the top-row loop counts `width - 2` in an
eight-bit register (`CL`) without a zero test before `loop` (`CX`), so on every
PC build (`F-VIEWS-12`) a 1-pixel-wide cel stamps 255 cells and a 2-pixel-wide
cel stamps 65536 cells across the 160×168 priority surface.

**Behavioral witness:** Police Quest logic 26 places Dooley's car with margin 0 and
then positions an officer beside it; with a baseline-only line the placement
search accepts a spot from which his scripted walk jams on that line. Space
Quest logic 3 places the dead crewman with margin 0; the box x126..149,
y63..71 makes the body solid, and the keycard remains reachable because the
room's `posn` test covers the doorway.

**Tests:** [opcodes.test.ts](../test/opcodes.test.ts); the SQ1 walkthrough crosses
room 3.

#### add.to.pic verdicts

Static disassembly of the 15 PC executables (MZ body offsets; inputs: `ddp-booter` decoded
`424da51a…` for 2.001, `sq1-dos-2.089` 2.089, `xmas-dos-2.230` 2.230, `xmas-dos-2.272` 2.272,
KQ2 2.411, BC 2.439, LSL1 2.440, PQ1 2.903, MUMG 2.915, KQ1 2.917, KQ3 2.936, KQ4 3.002.086,
DEMOPAC4 3.002.102, MH1 3.002.107, GR1 3.002.149) and the six Amiga hunk executables
(`sq1-amiga` 2.082, `kq2-amiga` 2.176, `sq2-amiga` 2.202, `pq1-amiga` 2.310, `goldrush-amiga`
2.316, `mh2-amiga` 2.333). Apple IIgs `1.014` was not re-verified in this pass; its addresses
below come from the earlier pass. Every PC address in the table is an instruction start that
was read in the listing.

| Build         | `add.to.pic` / `.v` | AddToPic core | FindPosn | ObjInPic | Box gate | Top-row loop |
| ------------- | ------------------- | ------------- | -------- | -------- | -------- | ------------ |
| 2.001         | `0x284b` / `0x289b` | `0x2923`      | `0x53e2` | `0x532a` | `0x5339` | `0x53b9`     |
| 2.089         | `0x292b` / `0x297b` | `0x2a03`      | `0x515c` | `0x5092` | `0x50bd` | `0x5133`     |
| 2.230         | `0x2871` / `0x28c1` | `0x2949`      | `0x515d` | `0x4fff` | `0x502a` | `0x5099`     |
| 2.272         | `0x2935` / `0x2985` | `0x2a0d`      | `0x51c6` | `0x5061` | `0x508c` | `0x50fb`     |
| 2.411         | `0x2b84` / `0x2bd4` | `0x2c5c`      | `0x5721` | `0x55b6` | `0x55e1` | `0x564e`     |
| 2.439         | `0x2ba2` / `0x2bf2` | `0x2c7a`      | `0x574b` | `0x55e0` | `0x560b` | `0x5678`     |
| 2.440         | `0x2baa` / `0x2bfa` | `0x2c82`      | `0x5753` | `0x55e8` | `0x5613` | `0x5680`     |
| 2.903         | `0x2c73` / `0x2cc3` | `0x2d4b`      | `0x585f` | `0x56f4` | `0x571f` | `0x578c`     |
| 2.915         | `0x2c78` / `0x2cc8` | `0x2d50`      | `0x585e` | `0x56f3` | `0x571e` | `0x578b`     |
| 2.917         | `0x2c7a` / `0x2cca` | `0x2d52`      | `0x5872` | `0x5707` | `0x5732` | `0x579f`     |
| 2.936         | `0x2c7a` / `0x2cca` | `0x2d52`      | `0x593a` | `0x57cf` | `0x57fa` | `0x5867`     |
| 3.002.086     | `0x2f3f` / `0x2f8f` | `0x3017`      | `0x5d55` | `0x5bea` | `0x5c15` | `0x5c82`     |
| 3.002.102/107 | `0x2f55` / `0x2fa5` | `0x302d`      | `0x5d64` | `0x5bf9` | `0x5c24` | `0x5c91`     |
| 3.002.149     | `0x2ef4` / `0x2f44` | `0x2fcc`      | `0x5cb3` | `0x59fc` | `0x5a27` | `0x5a94`     |

The handler addresses are the action `0x7a`/`0x7b` entries of each build's `AGIDATA.OVL` action
table. Amiga (identical code in all six builds): handlers `h55+0x0000`/`+0x0064` on `2.082` and
`h76+0x0000`/`+0x0064` on `2.176..2.333`, core at `+0x011a` of the same hunk; FindPosn
`h92+0x0000` (`2.082`) / `h127+0x0000`; ObjInPic `h112+0x0302` (`2.082`) / `h149+0x0302`, gate at
`+0x0342`, top-row loop at `+0x03d4`. The ObjInPic/InsertObj/MirrorCell hunk is byte-identical
across `2.176..2.333` apart from the MirrorCell mask bytes (`F-VIEWS-01`), and `2.082` `h112`
differs from it only in relocated data operands.

- **F-VIEWS-03 (fact on PC and Amiga; engine matches).** add.to.pic anchor. Every PC and Amiga
  build fills a scratch object entry from the operands (PC: then runs SetView, SetLoop and
  SetCel on it, with SetCel's clamps, `F-VIEWS-05`), sets `control = 0x020c` (
  `IGNROBJS | IGNRHRZ | FIXEDPRI`) and `pri = 15`, and calls FindPosn (PC `mov word [..],0x20c` /
  `mov byte [..],0xf`
  then `call FindPosn`; Amiga `move.w #$20c` / `move.w #$f` then `jsr` to FindPosn). It then
  stores the packed byte into `pri`, replaces `control` with `0x0008` when the packed low nibble is
  zero, and calls ObjInPic, which blits through InsertObj and draws the box from the relocated
  coordinates. `2.001` keeps the entry on the stack (`[bp-0x2b]`) and stores the packed byte
  before the low-nibble test; the other builds use a global entry. Correction: the earlier text
  of "Original add.to.pic control box" said `2.440` calls ObjInPic without FindPosn; `2.440`
  calls FindPosn at `0x2d25` before ObjInPic at `0x2d4b`. Engine: `profile.addToPicRelocation`
  is `true` for every profile.
- **F-VIEWS-04 (fact on PC and Amiga; engine matches).** add.to.pic packing. Both handlers of
  every PC build pack `margin` with `mov cl,0x4 / shl ax,cl / or [pri],al`, a byte store, so
  `pri = (pri & 0xff) | ((margin & 0x0f) << 4)`; Amiga does the same with
  `asl.l #4,d1 / or.l d1,d2 / move.b d2,…` (`h76+0x0044` and `+0x00fc`). ObjInPic on
  `2.089..3.002.149` and on all
  six Amiga builds substitutes `pri_tbl[y]` into the low nibble when it is zero (PC
  `and ah,0x0f / jnz / or [bp+0x24],al` at ObjInPic`+0x19`; Amiga
  `andi.w #$f,d0 / bne / or.w d1,$3c(a0)` at
  `+0x031c`) before calling InsertObj. `2.001` ObjInPic (`0x532a`) calls InsertObj (`0x524f`)
  first and has no substitution, so priority `0` draws at priority `0`. Engine:
  `profile.addToPicPacking` is `true` for every profile, and `2.001` skips the substitution.
- **F-VIEWS-09 (fact on PC and Amiga; engine matches).** Box gate: the only skip condition is
  the packed value `> 0x3f` (PC `cmp byte [bp+0x24],0x3f` then an unsigned branch to the exit,
  `ja` on 2.936 and `jna` over the return on 2.001 and 2.089; Amiga `cmpi.w #$3f,$3c(a0); bhi`), so
  margins with `(margin & 0x0f) <= 3` and a priority nibble
  draw a `(margin & 0x0f)` control box. The IIgs gate (`main+0x129a`) was not re-verified.
- **F-VIEWS-12 (fact on PC and Amiga; engine matches).** Narrow-cel box. The PC top-row loop is
  `mov cl,al / sub cl,0x2 / inc di / … / loop` with no zero test, and `CH` is `0` after the side
  loop, so a 1-pixel-wide cel stamps 255 cells from `(x + 1, topY)` and a 2-pixel-wide cel runs
  65,536 iterations. Amiga `subq.w #$1,d2` (`+0x038c`) and `subq.w #$2,d2 / bmi.w` (`+0x03d4`)
  skip the interior top span when `width <= 2`. The IIgs signed skip (`main+0x1327`) was not
  re-verified. Engine: the 8086 `LOOP` wrap runs when
  `profile.addToPicPacking && profile.presentation === "pc"`; Amiga and IIgs skip the interior top
  span when `width <= 2`.
- **F-picture-06 (fact on PC and Amiga; engine matches).** Box geometry: the blit runs first,
  then the gate. Height: a counter starts at 1 and walks up from row `y - 1` while
  `pri_tbl[row] == pri_tbl[y]`, stopping at row 0; box height is `min(cel.height, count)`. Each
  painted cell
  keeps its visual nibble and takes the margin nibble (PC `and es:[di],0x0f / or es:[di],dl`;
  Amiga `andi.b #$f,(a1) / or.b d1,(a1)+`). The bottom row paints all `width` cells; each of the
  `height - 1` rows above paints the two edge columns; when `height > 1` the top row then paints
  its `width - 2` interior cells (with the PC wrap of `F-VIEWS-12`).

### Text under later graphics

Text and graphics share one bitmap: a cel drawn by add.to.pic, a screen object drawn or erased, and every
updating screen object's per-cycle redraw repaint the text under them. show.pic clears the picture band's
text. The engine stamps text cells with their write and drops the stamped cells a later drawing
covers.

The demo pack paints its menu rows black and add.to.pic's the game cards over them; a Mother Goose
demo redraws its speech bubble over stale words.

**Specification:** The interpreters have a single screen; the spec has no separate text layer to
describe this against.

**Evidence:** Follows from the interpreters' single bitmap: erasing or redrawing a cel restores the
pixels saved when it was drawn, so text written over it since then is gone. (No load-module offsets
recorded.)

**Tests:** [release-interpreter-regressions.test.ts](../test/release-interpreter-regressions.test.ts),
[object-cadence.test.ts](../test/object-cadence.test.ts),
[text-surface.test.ts](../test/text-surface.test.ts).

### Window update gate

An open text window does not suspend the per-cycle object update: a cycling cel whose rect overlaps
a window paints over it. The engine's text-cell masking models that overlap.

KQ4's closing intro window shows the cycling wave through its top border.

**Specification:** The spec's modal-text chapter does not address whether object updates continue under
an open window.

**Evidence:** The shipped main loops gate the object-update call on the text-screen mode byte, which
the window-open routine never sets. In KQ4 3.002.086 (static disassembly) the main loop tests
`[0x17c7]` at 0x241. Action 0x6a `text.screen` (handler 0x7b09, dispatch entry `AGIDATA.OVL`
0x7c5) sets it at 0x7b14, and action 0x6b `graphics` (handler 0x7b41) clears it through 0x7d0a at
0x7d0f. A search of the image finds no other direct write. 2.936 gates on `[0x1757]`, which the
agi-re evidence book attributes to the same pair (0x6a handler 0x76ca). The window-open routine
(0x204F in 3.002.086) sets `[0xd53]`, which no draw or update path reads.

**Tests:** [kq4-regressions.test.ts](../test/kq4-regressions.test.ts).

### Display line layout

display treats CR and LF as a line break to the next row, capped at row 24, and wraps the character
after column 39 the same way; both continue at the routine's start column, which only a message
window sets, so a display call resumes at column 0.

A Leisure Suit Larry demonstration and the Space Quest intro display two-line captions with embedded
newlines.

**Specification:** The spec leaves the layout of display text unspecified.

**Evidence:** Character output: 3.002.102 offset 0x2d48; 2.411, 2.917 and 2.936 match.

**Tests:** [text-surface.test.ts](../test/text-surface.test.ts).

### Print handler output modes

A print that opens a non-blocking window (f15 set) consumes f15 as it returns, so the next print
blocks again (profile flag `printConsumesF15`). A timed print (v21 half-seconds) zeroes v21 when its
window closes, by timeout or key (profile flag `timedPrintClearsV21`).

KQ4's keyless intro re-arms f15 for every window and reaches interactive play without a keypress.

**Specification:** The spec's modal-text chapter does not describe either side effect.

**Evidence:** The print-handler offsets below identify the f15 reset and v21 clear:

| Interpreter build     | f15 reset | v21 clear |
| --------------------- | --------- | --------- |
| 2.089                 | —         | 0x1c24    |
| 2.230                 | —         | 0x1b66    |
| 2.272                 | —         | 0x1c02    |
| 2.411                 | 0x1cb9    | 0x1d2d    |
| 2.440                 | 0x1ccf    | 0x1d43    |
| 2.917 / 2.936         | 0x1d0c    | 0x1d80    |
| 3.002.086             | 0x1fc5    | 0x2039    |
| 3.002.102 / 3.002.107 | 0x1fdb    | 0x204f    |
| 3.002.149             | 0x1f94    | 0x2008    |

The 3.002.149 fixture versions and shared handler ranges are compared in
[mh2-profile.test.ts](../test/mh2-profile.test.ts). At 0x1f94, the call through 0x7804/0x7828 clears
f15. Both timeout and key acknowledgement reach the v21 clear at 0x2008. `print` on 2.089
(`0x1ade` → `0x1ba9`), 2.230 (`0x1a20` → `0x1aeb`) and 2.272 (`0x1abc` → `0x1b87`) calls the same
shared routine, which zeroes v21 on its timed exit (fact, static; the decoded images in
[Original restart state boundary](#original-restart-state-boundary)).

**Early f15 behavior (fact; engine diverges).** The shared routines at `0x1ba9` (2.089),
`0x1aeb` (2.230) and `0x1b87` (2.272) have no f15 test, so f15 never makes a print
non-blocking on those builds. The engine still leaves their print windows non-blocking
while retaining f15; [message-modes.test.ts](../test/message-modes.test.ts) pins that
current behavior. Matching these originals remains outstanding. Print f15 behavior on
2.001 is not established.

**Tests:** [mh2-profile.test.ts](../test/mh2-profile.test.ts),
[message-modes.test.ts](../test/message-modes.test.ts),
[kq4-regressions.test.ts](../test/kq4-regressions.test.ts).

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

**Tests:** [opcodes.test.ts](../test/opcodes.test.ts).

### Original message formatter

Static disassembly of the unscrambled Gold Rush 3.002.149 executable. The
formatter at 0x2208 walks the source once. On `%` it reads one letter and
dispatches through the table at 0x23a4: `g` (a message of logic 0, formatted
by a recursive call), `m` (a message of the current logic, recursive), `o` (the
object named by the variable, recursive), `s` (a string slot,
recursive), `v` (the variable as decimal, with `|` width zero-padded) and `w`
(a parsed word, recursive). Any other letter is skipped with its percent sign.
Output is appended, never rescanned. The comparison with nineteen at 0x2221
bounds the output line counter at DS:0x0b26, not recursion depth: 0x25bc
increments that counter at a line boundary. A recursion-depth limit does not
implement that contract and still permits exponential expansion.
Fact: a `%v` value cannot extend a code before it. Police Quest prints
`%m1%v…`, which a `%v`-first pass would turn into a different message number.
v2 images were not inspected; the engine applies the table to every profile by
inference.

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

**Tests:** [message-format.test.ts](../test/message-format.test.ts),
[opcodes.test.ts](../test/opcodes.test.ts). The prompt-to-print regression runs
in a subprocess with a timeout so a monopolized formatter fails the test instead
of hanging the test runner.

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

**Tests:** [opcodes.test.ts](../test/opcodes.test.ts).

#### show.obj verdict

- **F-VIEWS-10 (fact; engine matches).** show.obj geometry and draw order (PC
  ShowObj core: 2.001 0x542c, 2.089 0x57aa, 2.230 0x56f7, 2.272 0x5793, 2.411
  0x5cf7, 2.440 0x5df2, 2.903 0x5e13, 2.917 0x5e14, 2.936 0x5edb, 3.002.086
  0x630d, 3.002.102/3.002.107 0x6323, 3.002.149 0x6127; Amiga: 2.082
  h103+0x7c, 2.176/2.202/2.310/2.316/2.333 h138+0x7c; IIgs 1.014
  seg2+0x3e62): every binary sets loop 0 / cel 0 (`SetCel`), computes
  `left = (159 − width) / 2` by signed integer division toward zero (`idiv` on
  PC, `divs.w #2` on Amiga, `(159 − width) >> 1` on IIgs — even-width cels sit
  one pixel left of `(160 − w) >> 1`), sets baseline `y = 167` and fixed
  priority `15` (on PC `machType == 2` only, `left` is rounded up to an even
  column), then calls `InsertObj` and `DrawObj` BEFORE `WindowPrint` opens the
  description window, and calls `EraseObj` after `WindowPrint` closes. Thus an
  oversized cel and the description window overlap with the window painted on
  top of the cel, and dismissal restores the window area before `EraseObj`
  restores the cel background. Engine: `showObject` uses `Math.trunc((159 -
cel.width) / 2)` at baseline 167 with priority 15 and blits the cel onto the
  picture surface before opening the modal description window, restoring the
  saved picture region when the modal is dismissed.

#### View verdicts, second pass

Static disassembly of the 15 PC executables and six Amiga executables listed under
[add.to.pic verdicts](#addtopic-verdicts), plus the `IBM_OBJS.OVL` overlays of
KQ2, BC, LSL1, PQ1, MUMG, KQ1, KQ3, KQ4, DEMOPAC4 and MH1. Apple IIgs `1.014` was not
re-verified in this pass.

InsertObj (the object blit) lives in the executable on `2.001` (`0x524f..0x5329`), `2.089`
(`0x4fb7..0x5091`), `2.230` (`0x4f24..0x4ffe`), `2.272` (`0x4f90..0x5060`) and `3.002.149`
(`0x5be3..0x5cb2`), and in `IBM_OBJS.OVL` on `2.411..3.002.107`: the overlay starts with a
three-entry jump table and InsertObj is `+0x0085..+0x0154` in all ten overlays (the executable
calls it through the third jump-table entry, for example `call 0x9db6` at `0x57f1` on `2.936`).
Amiga InsertObj is `h112+0x0000` (`2.082`) / `h149+0x0000` (`2.176..2.333`).

- **F-VIEWS-07 (fact; engine matches; divergence on unusual input for a row-167 pixel on
  `2.001`, `2.089` and `2.230`).** InsertObj takes the compared and stamped priority from the low
  nibble of the object's priority byte (PC `mov bh,[bp+0x24]` then `shl bh,1` four times; Amiga
  `move.w $3c(a0),d5 / andi.w #$f,d5 / lsl.w #4,d5`), so a stored `17` blits as `1`. When the
  destination priority nibble is a control value (`<= 0x20`), it scans down the same column
  (`+0xa0` per row) for the first value above `0x20`:
  - PC, two variants. `2.272`, `3.002.149` and every overlay:
    `push di / xor ch,ch / cmp di,0x6860 / jnc / add di,0xa0 / mov ch,[es:di] / and ch,0xf0 / cmp ch,0x20 / jna`
    (overlay `+0x0116..+0x012c`; `2.272` `0x5023`, `3.002.149` `0x5c75`). `2.001`, `2.089` and
    `2.230` read the next row first (`mov ch,[es:di+0xa0]` at `0x52d3`, `0x503b`, `0x4fa8`) and
    then run the same loop without the `xor ch,ch`. When no row up to 167 qualifies, `ch` keeps the
    control nibble of row 167 in that column (`0x00`, `0x10` or `0x20`); it is `0` only when the
    pixel itself is on row 167 in the `xor ch,ch` variant, and the read-ahead variant reads one
    byte past the 168-row buffer for a pixel on row 167. The pixel draws when `ch <= bh`. There is
    no `mov bl,0`: earlier text citing `IBM_OBJS.OVL+0x014d` was wrong (`+0x014d` is not an
    instruction start; `+0x014b`/`+0x014e` are the tail of the routine).
  - Amiga: `cmpa.l a2,a1 / bcs` then `move.w #$40,d4` at `h112+0x0104` / `h149+0x0104` when the
    scan passes the end of the buffer, so the fallback is priority 4; the pixel draws when
    `d5 >= d4`.
  - IIgs `1.014` (`lda #$0004` at `main+0x10d6`, fallback 4) is from the earlier pass.

  Engine: on PC, `drawCel` ends a fruitless scan on row 167's control value, or `0` for a pixel
  on row 167 itself; on Amiga and IIgs it uses `controlScanFallbackPriority: 4`. The engine
  differed for fixed priorities 0 and 1 until the scan was corrected; the regression in
  [view.test.ts](../test/view.test.ts) failed before the fix. Divergence (unusual input): the
  read-ahead variant's one-byte overread for a pixel on row 167 is modeled as `0`.

- **F-VIEWS-04-detail (fact on PC and Amiga; engine matches).** The nibble truncation applies to
  both the blit and the box: ObjInPic's zero test uses the low nibble only (`F-VIEWS-04`),
  InsertObj compares and stamps the low nibble, and the box gate (`> 0x3f`) and box nibble
  (`packed & 0xf0`) use the whole packed byte.
- **F-VIEWS-09-adjacent (fact on PC and Amiga; engine matches).** In every ObjInPic, InsertObj
  runs before the box gate (`2.936` `call 0x9db6` at `0x57f1`, gate at `0x57fa`; `2.001`
  `call 0x524f` at `0x5335`, gate at `0x5339`): the cel is always blitted and only the box is
  conditional. ObjInPic has no
  y-range compare. A margin operand of `16..31` truncates in the byte-wide packing and draws a
  `(margin & 0x0f)` box.
- **F-VIEWS-11 (fact on PC; engine matches for `vdesc == 0`; out-of-bounds `vdesc` is
  malformed input only).** `show.obj` (action `0x81`) formats the view description with
  `mov di,[si+0x3] / mov ax,[di+0x3] / add ax,di / push ax / call WindowPrint` and no test for
  zero. ShowObj routine / the `mov ax,[di+0x3]` instruction:

  | Build         | ShowObj  | `vdesc` load |
  | ------------- | -------- | ------------ |
  | 2.001         | `0x56e8` | `0x57ec`     |
  | 2.089         | `0x56bd` | `0x57bf`     |
  | 2.230         | `0x56be` | `0x57b4`     |
  | 2.272         | `0x5727` | `0x5820`     |
  | 2.411         | `0x5cc2` | `0x5dce`     |
  | 2.439         | `0x5cec` | `0x5df8`     |
  | 2.440         | `0x5cf4` | `0x5e00`     |
  | 2.903         | `0x5e00` | `0x5f0c`     |
  | 2.915         | `0x5dff` | `0x5f0b`     |
  | 2.917         | `0x5e13` | `0x5f1f`     |
  | 2.936         | `0x5edb` | `0x5fe7`     |
  | 3.002.086     | `0x6314` | `0x6420`     |
  | 3.002.102/107 | `0x6323` | `0x642f`     |
  | 3.002.149     | `0x6272` | `0x6360`     |

  On `2.089`, `2.230` and `2.272` the action handler is ShowObj itself; on `2.411` and later the
  handler (for example `0x5ebf` on `2.936`) calls it. `2.001` was located by the instruction
  pattern only. With `vdesc == 0` ShowObj prints the
  NUL-terminated bytes at offset 0 of the view header. The Amiga and IIgs ShowObj addresses of the
  earlier pass did not survive re-checking (`h138` is a BSS hunk on `2.176`) and are removed; the
  Amiga and IIgs behavior was not re-verified. Engine: `profile.showObjUncheckedDescOffset` is
  `true` for every profile.

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

**Tests:** [string-bank.test.ts](../test/string-bank.test.ts),
[profile.test.ts](../test/profile.test.ts).

### Compressed logic plain text

A dictionary-compressed v3 logic record stores its message text plain; only directly stored records
carry the "Avis Durgan"-encrypted text. The container normalizes compressed records to the encrypted
layout so every decoder sees one encoding.

The demo pack exercises compressed logic; Manhunter exercises both compressed and directly stored
records.

**Specification:** The "Logic payload" section specifies encrypted message text for logic records.

**Evidence:** Observed v3 game data, not interpreter code: a Sierra 3.002.102 demo installation where
every logic record is dictionary-compressed stores the text plain.

**Tests:** [demopac4.test.ts](../test/demopac4.test.ts), [mh1.test.ts](../test/mh1.test.ts).

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

| Fresh parse, then said pattern | Original result | Pre-audit engine result |
| ------------------------------ | --------------- | ----------------------- |
| [1] (anyword)                  | true            | false                   |
| [0]                            | true            | false                   |
| [9999] (rest of line)          | true            | true                    |
| [100]                          | false           | false                   |
| [1,1]                          | false           | false                   |

Success sets f4; another `said` then fails because input was consumed. Failure
leaves f4 clear. All five original cases passed; a deliberately incorrect
expectation for [100] failed. A separate execution of the pre-audit Engine
reproduced the differing rows. This proves the GR unknown-word boundary, not all profiles,
dictionary decompression cases or keyboard event timing.

**Engine contract:** an unknown slot holds an explicit zero group, or reads as
implicit zero within the parser's authoritative word count. `evalSaid` tests
that count rather than only `parsedWords.length` and never permits a wildcard
beyond it. Exact matching, f2/f4 and tail matching are preserved. Regressions
include the consumed-input repeat and a parser snapshot roundtrip. Group zero
matching is observed behavior, not a recommendation for generated story code.

```bash
python scripts/probe-interpreter-input.py games/gr1/AGI games/gr1/AGIDATA.OVL
```

#### Parser verdicts

Static disassembly of KQ1 2.917, KQ4 3.002.086 (body offsets) and GR1
3.002.149; WORDS.TOK handling cross-checked against the shipped files.

- **F-Parser-01 (fact; engine matches).** Dictionary matching (2.917 kq1 Match
  0x1A6B / 3.002.086 kq4 0x1D24 / 3.002.149 gr1 0x1CF3): one linear
  left-to-right scan of the initial-letter section; input pointer and match
  depth never reset between entries; each entry's prefix-copy-count byte must
  equal the current match depth to be compared (smaller → scan ends); every
  complete match overwrites the result, so the LAST match in section order
  wins — greedy-longest for sorted WORDS.TOK. Phrase spaces are matched
  verbatim (0x20^0x7F); ignored words inside phrases are consumed as ordinary
  characters; a failed longer phrase leaves the earlier shorter match in
  effect.
- **F-Parser-02 (fact; engine matches).** Unknown-word position (2.917 kq1
  Parse 0x18AC / 3.002.086 kq4 0x1B65 / 3.002.149 gr1 0x1B34): on Match == -1
  the parser stores i+1 (retained nonzero-id count + 1) to BOTH var[9] and
  the parser count byte (gr1 DS:0xAB0), keeps the token text pointer in
  wordPtr[i], sets f2 and stops. Ignored (group-0) words advance the line
  pointer only — they never move v9. Clean parses leave v9 untouched; the
  input phase zeroes v9/v19 before event polling (gr1 0x38D3), so v9==0 after
  a fully-known line.
- **F-Parser-04 (fact; engine matches).** Ten-word retention (PC `Parse` entry /
  `cmp di,0xa`: `2.001` `0x1817` / `0x1862`, `2.089` `0x176b` / `0x17b3`, `2.230`
  `0x16ad` / `0x16f5`, `2.272` `0x174b` / `0x1793`, `2.411` `0x1859` / `0x18a1`,
  `2.439` `0x1867` / `0x18af`, `2.440` `0x186f` / `0x18b7`, `2.903` `0x18a5` /
  `0x18ed`, `2.915` `0x18aa` / `0x18f2`, `2.917`/`2.936` `0x18ac` / `0x18f4`,
  `3.002.086` `0x1b65` / `0x1bad`, `3.002.102`/`3.002.107` `0x1b7b` / `0x1bc3`,
  `3.002.149` `0x1b34` / `0x1b7c`; Amiga `Parse` entry / `cmpi.w #10,d7`:
  `2.082` `h37+0x000` / `h37+0x060`, `2.176..2.333` `h54+0x000` / `h54+0x060`;
  IIgs `1.014` `seg2+0x1a5f` / `seg2+0x1ac8` `sbc #$000a`): in every binary, the
  word loop tests `i >= 10` BEFORE each `FindWord` call and exits silently —
  tokens past the tenth retained word are never examined, so an unknown word at
  position 11+ is not reported and no eleventh text is kept. The cap path (e.g.
  `kq1` `0x1940`) stores `count := 10`, then falls through to the `count > 0`
  check (`0x194c`), which sets `f2`; `v9` is written only on the unknown-word
  path (`kq1` `0x1901`: `wordPtr[i] := text pointer`, `v9 := i+1`, `count := i+1`,
  `SetFlag(2)`), so an over-long line of known words leaves `v9` clear but still
  sets `f2`. `WORDS`/`WORDPTR` are 10-slot arrays zeroed at `Parse` entry
  (`FillMem` `0x14` bytes each). Engine: the parser stops at ten retained words
  and sets `f2` whenever the retained count is nonzero across all twenty profiles
  (field `parserStopsAtTenthWord`).
- **F-Parser-05 (fact; engine matches).** Input-line capacity (PC EditLine:
  2.001 0x3376, 2.089 0x3340, 2.230 0x329f, 2.272 0x332d, 2.411 0x353b, 2.440
  0x3549, 2.903 0x364b, 2.917/2.936 0x3652, 3.002.086 0x39ef, 3.002.102/3.002.107
  0x3a05, 3.002.149 0x3961; Amiga: 2.082 h63+0x136, 2.176..2.333 h85+0x13c; IIgs
  1.014 seg2+0x16f8..0x1726): in every binary, a character is
  accepted only while `editLen < maxLen` and excess keys are silently rejected. Four
  `inputLineEditCap` formulas exist across the twenty shipped binaries:
  - `"early-35"` on PC 2.001, 2.089, and 2.230 (fixed literal `0x23 = 35` —
    `EditLine` compares `editLen` directly against `0x23`, independent of
    `var[24]` which `ResetAll` leaves at `0`, `strlen(s0)` and the cursor byte).
  - `"dialogue-36"` on PC 2.411..3.002.107 (`min(var[24], (dialogueOpen ? 36 : 40) − strlen(s0) − (promptByte≠0))`,
    where actions 163/164 set/clear the dialogue flag at `DS:0x0ce9` in
    2.411/2.440, `DS:0x0d07` in 2.903..2.936, `DS:0x0d45` in 3.002.086,
    `DS:0x0d57` in 3.002.102/3.002.107; `inputWidthActions: "effect"`).
  - `"prompt-40"` on PC 2.272 and 3.002.149 and all six Amiga builds
    (`min(var[24], 40 − strlen(s0) − (promptByte≠0))`, with actions 163/164
    either above the dispatch bound or pure no-op stubs).
  - `"iigs-39"` on IIgs 1.014 (`min(var[24], 39 − strlen(s0) − (cursor≠0))` at
    `seg2+0x16f8..0x1726`; see the corrected disassembly in
    [Apple IIgs presentation](#apple-iigs-presentation)).
    The edit buffer INLINE and the accepted-line buffer PREVLINE are separate
    42-byte buffers: Enter copies INLINE→PREVLINE then Parses INLINE; echo.line
    appends `PREVLINE[editLen..]` onto INLINE; cancel.line emits physical backspaces until
    editLen==0. Engine: the editor applies each profile's exact capacity formula
    across all twenty profiles (fields `originalInputCapacity`, `inputLineEditCap`,
    and `inputWidthActions`).
- **F-Parser-07 (fact; engine matches).** Dictionary lookup (PC `FindWord`:
  `2.001` `0x1961`, `2.089` `0x192a`, `2.230` `0x186c`, `2.272` `0x190a`,
  `2.411` `0x1a18`, `2.439` `0x1a26`, `2.440` `0x1a2e`, `2.903` `0x1a64`,
  `2.915` `0x1a69`, `2.917`/`2.936` `0x1a6b`, `3.002.086` `0x1d24`,
  `3.002.102`/`3.002.107` `0x1d3a`, `3.002.149` `0x1cf3`; Amiga `FindWord`:
  `2.082` `h37+0x24e`, `2.176..2.333` `h54+0x24e`; IIgs `FindWord`: `1.014`
  `seg2+0x1c0a`): first char (ASCII `a–z` after `FindWord`'s own ASCII-only
  `tolower` call on `*line` — `0x1a86` in `2.936`, `0x197c` in `2.001` — else
  unknown word) indexes a 26-entry big-endian offset table; the section is
  scanned LINEARLY via `NextToken` (calling `tolower` on each input character,
  e.g. `0x1b50` in `2.936`, `0x1a11` in `2.001`), requires the byte after a
  matched dictionary word to be NUL (`0x00`) or `' '` (`0x20`) (`0x1b6d..0x1b75`
  in `2.936`, `0x1a31..0x1a39` in `2.001`), and every complete match overwrites
  the result, so duplicate entries resolve last-in-file-order. Words under the
  wrong letter section are unreachable. On all nineteen profiles from `2.089`
  onward (plus all Amiga and IIgs profiles; `parserDefaultsLoneAAndI: true`),
  `FindWord` initializes `retVal = 0` when the remaining input begins with a
  lone `'a'` or `'i'` token (`word[1] == 0` or `word[1] == ' '`) before scanning
  the letter section, while an explicit dictionary entry in `WORDS.TOK` still
  overwrites `retVal` when matched; only `2.001` (`0x1961`,
  `parserDefaultsLoneAAndI: false`) has no pre-check and requires `'a'`/`'i'` to
  appear in `WORDS.TOK`.

#### Parser verdicts, second pass

Static disassembly of DDP 2.001 (`424da51a…`), SQ1-dos 2.089 (`e31e5e86…`),
XMAS 2.230 (`875547de…`), XMAS 2.272 (`a0c26b5d…`), KQ2 2.411 (`d99938d6…`),
LSL1 2.440 (`c70e2f32…`), KQ1 2.917 (`bf53a4f9…`), KQ3 2.936 (`4b50c681…`),
KQ4 3.002.086 (`b9b27b40…`),DM 3.002.102 (`7cf6eac9…`), GR 3.002.149
(`12a52b72…`), Amiga `2.082..2.333` and IIgs 1.014 (`e1a2788f…`); runtime
offsets.

- **F-Parser-08 (fact; engine matches).** `parse()` (`0x75`) slot bound (PC:
  `2.001` `0x18c6` / `cmp ax,6` at `0x18e5`, `2.089` `0x1817` / `0x1840`,
  `2.230` `0x1759` / `0x1782`, `2.272` `0x17f7` / `0x1820` with `cmp ax,6`;
  `2.411` `0x1905` / `0x192e`, `2.439` `0x1913` / `0x193c`, `2.440` `0x191b` /
  `0x1944`, `2.903` `0x1951` / `0x197a`, `2.915` `0x1956` / `0x197f`,
  `2.917`/`2.936` `0x1958` / `0x1981`, `3.002.086` `0x1c11` / `0x1c3a`,
  `3.002.102`/`3.002.107` `0x1c27` / `0x1c50`, `3.002.149` `0x1be0` / `0x1c09`
  with `cmp ax,0xc`; Amiga: `2.082` `h37+0x112` with `cmpi.w #6`,
  `2.176..2.333` `h54+0x112` with `cmpi.w #13`; IIgs `1.014`: `seg2+0x1ba1` /
  `seg2+0x1bd2` with `sbc #$000d`): slots `>= stringSlots` are silently skipped.
  The engine's per-profile `stringSlots` (`6` on `2.001..2.272` and
  `amiga-2.082`, `12` on `2.411..3.002.149`, `13` on `amiga-2.176..2.333` and
  `iigs-1.014`) matches every binary.
- **F-Parser-09 (fact; engine matches on valid word indices `0..9`; documented divergence on unusual input `wordIndex >= 10`).**
  `word.to.string` (`0x74`, PC `WordToString`: `2.001` `0x0f17..0x0f4f`, `2.089`
  `0x0d41`, `2.230` `0x0c23`, `2.272` `0x0c4f`, `2.411` `0x0d3d`,
  `2.439`/`2.440` `0x0d3d`, `2.903` `0x0d6b`, `2.915`/`2.917`/`2.936`
  `0x0d70..0x0da8`, `3.002.086` `0x0faf`, `3.002.102`/`3.002.107` `0x0fc5`,
  `3.002.149` `0x0f7e`; Amiga: `2.082` `h21+0x13a`, `2.176..2.333` `h30+0x13a`;
  IIgs `1.014` `seg2+0x4c17`): in every shipped binary across all twenty
  profiles, `WordToString` fetches `s = *code++` and `w = *code++`, computes
  `string[s]` (`s * 40 + DS:0x020d` in `2.936`), indexes `wordPtr[w]` 0-based
  directly with **no `w > 10` bounds check** (`lodsb; xor ah,ah; mov bx,ax;
shl bx,1; push word [bx+0x0c8f]` in `2.936`, `asl.l #2,d0` on Amiga,
  `asl a; asl a` on IIgs — the `w > 10` test exists only in `Print`'s 1-based
  `%wN` formatter, not in `WordToString`), and calls
  `strncpy(string[s], wordPtr[w], 40)` (`0x4de8` in `2.936`, `0x47d5` in
  `2.001`). A NULL slot (`w < 10` with `w >= parserCount`, since `wordPtr[0..9]`
  is zeroed at `Parse` entry) reads `DS:0x0000` (`""`), whereas `w >= 10` reads
  past `wordPtr[9]` into adjacent `DS` state (`DS:0x0ca3` `numWords`/`prevLine`
  for `w == 10` and `prevLine`/`linebuf` bytes at `DS:0x0ca5+` for `w > 10` in
  `2.936`) and dereferences that 16-bit word as a `DS` pointer. Across all
  2,425 decoded `LOGIC` resources in the 25 unpacked AGI fixtures (subject to
  the unreadable `LOGIC` entries and `// !!` decoding warnings listed in
  `F-motion-07`), opcode `0x74` (`word.to.string`) is absent (occurring only as
  the debug string literal `#message 116 "word.to.string"`). Engine: action
  `0x74` (`word.to.string`) writes `this.parsedWordTexts[wordIndex] ?? ""`
  (0-based) into `string[s]` while `%wN` remains 1-based; for `wordIndex >= 10`
  it safely writes `""` rather than dereferencing adjacent `DS` bytes as a
  pointer, and emulating the `wordPtr` overread is deferred.
- **F-Parser-10 (fact; engine matches).** Parse normalization (`MakeLine`: PC
  `2.001` `0x1901..0x1960`, `2.089` `0x185c`, `2.230` `0x179e`, `2.272`
  `0x183c`, `2.411` `0x194a`, `2.439` `0x1958`, `2.440` `0x1960`, `2.903`
  `0x1996`, `2.915` `0x199b`, `2.917`/`2.936` `0x199d..0x1a6a`, `3.002.086`
  `0x1c56`, `3.002.102`/`3.002.107` `0x1c6c`, `3.002.149` `0x1c25`; Amiga
  `MakeLine`: `2.082` `h37+0x164`, `2.176..2.333` `h54+0x164`; IIgs `MakeLine`:
  `1.014` `seg2+0x1f0f`): `MakeLine` never calls `tolower`; it copies retained
  bytes with their original case into `linebuf` (`DS:0x0ba3` in `2.001`,
  `DS:0x0ca7` in `2.936`). On `2.001` (`0x1901..0x1960`), `MakeLine` collapses
  runs of `' '` (`0x20`, `0x1914..0x191f`), copies every non-space byte
  (including punctuation such as `,`, `.`, `?`, `!`, `'`, and `-`) verbatim
  into `linebuf` (`0x1921..0x1941`), emits a single `' '` (`0x1946`), and trims
  a trailing `' '` (`0x194b..0x1957`); because `FindWord` (`0x1961..0x1a87`)
  requires `*di == 0x00 || *di == 0x20` (`0x1a31..0x1a39`) after a dictionary
  match, attached punctuation on `2.001` prevents a match unless the
  punctuation is in `WORDS.TOK`. On the other nineteen profiles
  (`2.089..3.002.149`, Amiga `2.082..2.333`, and IIgs `1.014`), `MakeLine`
  classifies each input byte by calling `strchr` (PC `2.089` `0x47fc`, `2.230`
  `0x4762`, `2.272` `0x47ce`, `2.411` `0x4e60`, `2.439` `0x4e8a`, `2.440`
  `0x4e92`, `2.903` `0x4f95`, `2.915` `0x4f94`, `2.917` `0x4f96`, `2.936`
  `0x505d`, `3.002.086` `0x5473`, `3.002.102`/`3.002.107` `0x547b`, `3.002.149`
  `0x5292`; Amiga `2.082` `h87+0x39c`, `2.176` `h121+0x39c`, `2.202`
  `h121+0x3e2`, `2.310..2.333` `h121+0x3d6`; IIgs `1.014` `etcseg+0x05de`)
  against two NUL-terminated literal strings in data: the 13-byte separator
  string `" ,.?!();:[]{}"` (PC `2.089` `DS:0x09f7`, `2.230` `DS:0x09fb`,
  `2.272` `DS:0x0acf`, `2.411..2.440` `DS:0x0c3f`, `2.903..2.917` `DS:0x0c5f`,
  `2.936` `DS:0x0c67`, `3.002.086` `DS:0x0c9d`, `3.002.102`/`3.002.107`
  `DS:0x0cb0`, `3.002.149` `DS:0x0a74`; Amiga `2.082` `h38+0x00`,
  `2.176..2.333` `h55+0x00`; IIgs `~arrays+0x17ce`) and the 4-byte
  ignored-punctuation string `"'`-\""` (`DS+0x0e`after the separator string;
Amiga`h38+0x0e`/`h55+0x0e`; IIgs `~arrays+0x17dc`). `FindWord`(not`MakeLine`) then calls `tolower`(PC`2.001` `0x49b7`, `2.089` `0x4767`,
`2.230` `0x46ef`, `2.272` `0x475b`, `2.411` `0x4ded`, `2.439` `0x4e17`,
`2.440` `0x4e1f`, `2.903` `0x4f22`, `2.915` `0x4f21`, `2.917` `0x4f23`,
`2.936` `0x4fea`at`0x1a86`and`0x1b50`, `3.002.086` `0x5400`,
`3.002.102`/`3.002.107` `0x5408`, `3.002.149` `0x521f`; Amiga `2.082`
`h87+0x2ee`, `2.176` `h121+0x2ee`, `2.202..2.333` `h121+0x334`; IIgs `1.014`
`etcseg+0x04bf`), which folds only ASCII `'A'..'Z'` (`0x41..0x5a`→`0x61..0x7a`), and requires the first character of a token to lie in
`'a'..'z'` (`0x61..0x7a`) or treats the token as an unknown word. Bytes
`>= 0x80`in a`parse(sA)`or player input string survive verbatim without
Unicode/locale folding and become unknown words. Engine:`profile.parserStripsPunctuation` (`false`on`2.001`, `true`on the other 19
profiles) selects space-only vs separator/ignored-punctuation`MakeLine`normalization in`parseSentence`, and `asciiLower`folds only ASCII`0x41..0x5a` across all twenty profiles.
- **F-Parser-12 (fact; engine matches on printable and editing keys; inserting
  unmapped control and scan words into `INLINE` is a host boundary).**
  Input-line editor keys (PC `EditLine`: `2.001` `0x3258`, `2.936` `0x3652`,
  `3.002.149` `0x3961`; Amiga: `2.082` `h63+0x114`, `2.176..2.333` `h85+0x118`;
  IIgs `1.014` `seg2+0x1727`): key `13` on an empty line is silently consumed
  (no parse; `v19 = 13` was already stored by the caller, so the observable
  state matches the engine). Backspace at empty is a silent no-op with `v19 = 8`
  visible to scripts (matching `keyByteStoredBeforeEdit: true`). Key `10` is
  dropped. No PC `EditLine` tests the key word's high byte; no image contains a
  `test byte [bp+5],0xff` guard. The default case
  (`cmp di,[count]; jna; or si,si; jz; inc count; mov [buf+bx],al`: `2.001`
  `0x32b3..0x32c8`, `2.936` `0x36e8..0x36fc`, `3.002.149` `0x39eb..0x39ff`)
  appends the low byte of any nonzero unmapped word: F1 (`0x3b00`) appends
  `0x00`, and an unmapped `0x0101` appends `0x01`. IIgs `EditLine` tests
  `lda $08,s; and #$ff00; bne ret` (`seg2+0x1729`), and Amiga `EditLine` gates
  insertion on `0x20 <= ch < 0x7f` (`2.082` `h63+0x1b6`, `2.176..2.333`
  `h85+0x1be`). Engine: on every profile the `0x20..0x7e` filter keeps control
  and scan words out of the edit buffer while delivering their low byte to
  `v19`. No shipped game depends on inserting NUL or control bytes into
  `INLINE`.
- **F-Parser-13 (fact; engine matches).** `echo.line` / `cancel.line` (PC
  `EchoLine`/`CancelLine`: `2.001` `0x3477`/`0x344a`, `2.089` `0x3441`/`0x3414`,
  `2.230` `0x33a0`/`0x3373`, `2.272` `0x342e`/`0x3401`, `2.411`
  `0x3651`/`0x3624`, `2.440` `0x365f`/`0x3632`, `2.903` `0x374c`/`0x371f`,
  `2.917`/`2.936` `0x3753`/`0x3726`, `3.002.086` `0x3af0`/`0x3ac3`,
  `3.002.102`/`3.002.107` `0x3b06`/`0x3ad9`, `3.002.149` `0x3a62`/`0x3a35`;
  Amiga: `2.082` `h63+0x1f8`/`+0x1ca`, `2.176..2.333` `h85+0x1fe`/`+0x1d0`; IIgs
  `1.014` `seg3+0x1018`/`+0x0ff1`): `echo.line` returns immediately when input
  is disabled; when enabled and `editLine.length < prevLine.length`, it appends
  the remaining suffix `prevLine.slice(editLine.length)` onto `editLine` up to
  `inputCapacity()` (so typing `"xy"` after `"look"` and running `echo.line`
  yields `"xyok"`, and if `editLine` is already at least as long as `prevLine`
  it leaves `editLine` unchanged). `cancel.line` clears `editLine` to `""`, and
  `prevent.input`/`accept.input` update input acceptance and redraw the input
  row.

### Original sound player audit

Executed original interpreter machine code with
[scripts/probe-interpreter-sound.py](../scripts/probe-interpreter-sound.py),
Unicorn 2.1.4 and each binary's matching original AGIDATA.OVL. Only resource
lookup is substituted with a synthetic loaded-resource descriptor; opcode,
flag, player, envelope and stop code execute unchanged. Port writes are captured,
not sent to hardware. This does not establish interrupt cadence, audible PSG
behavior or modal-editor timing.

MH1 and GR1 executable hashes are listed in the
[motion audit](#original-motion-and-animation-audit). KQ1 2.917
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

Two profile differences are independently verified. First,
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

| Tick | KQ1 attenuation | MH1/GR1 attenuation | Pre-audit engine |
| ---- | --------------- | ------------------- | ---------------- |
| 7    | 4               | 3                   | 4                |
| 11   | 5               | 4                   | 5                |
| 30   | 8               | 6                   | 8                |
| 67   | 15              | 14                  | 15               |
| 68   | 13              | 14                  | 15               |
| 77   | 13              | 15                  | 15               |
| 78   | 13              | 13                  | 15               |

Noise-only duration 2, tone 0xe001, control 0xf0 and v23=3 emits attenuation
0xf0 in every measured original, versus 0xf3 in the pre-audit engine.

**Engine mapping:** the interpreter profile selects the envelope, and that
selection sets both playback and snapshot index bounds. KQ1's shape is
preserved; the measured v3 families are mapped explicitly rather than replacing
every common-profile table. v23 applies inside the active-envelope/non-hold
branch; the later Tandy adjustment branch is unchanged. Tests cover the table
above and snapshot restoration across ticks 67/68 and 77/78. Broader profile
claims need additional evidence. The v3 expectation was observed failing on KQ1,
exposing this real profile distinction; the final profile-specific probe passes
all three.

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
Software port traces establish command bytes and completion behavior. The
[PCjr and Tandy noise](#pcjr-and-tandy-noise) generator models chip feedback;
analogue speaker response remains approximate.

Original tone-zero output is established: the player emits two 0x00 port
bytes before attenuation on device 1. Playback now preserves those bytes;
[PC and IIgs sound streams](#pc-and-iigs-sound-streams) records the per-build
execution checks. Play and offline preview share the existing latch-only
attenuation/noise continuation policy. That policy still needs independent
silicon evidence; restoring interpreter writes does not settle chip behavior.

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
list (in the [save and restart audit](#original-save-and-restart-audit)) contains
the same 0x5234 helper, consistent with the shared 2.936 core.

#### Sound verdicts

Static disassembly of KQ2 2.411, LSL1 2.440 and XMAS 2.272 (`a0c26b5d…`).

- **F-SOUND-02 (fact; engine matches).**
  Early sound attenuation (2.272 xmas 0x764D / 2.411 kq2 0x7D02 / 2.440 lsl1
  0x7E2B): 2.272 adds var[23] (DS+0x20) to the whole control byte with a
  signed `jng` clamp to 0x0F; 2.411/2.440 mask the nibble first then clamp
  with a signed `jng` (`add cl,[v23]; cmp cl,0x0f; jng`, so a nibble+var[23]
  sum that wraps past 0x7F tests negative under signed `jng`, skips the `0x0f`
  clamp, and bleeds into the selector nibble on `or dl,cl`). On machType==2
  (Tandy) all three builds first apply +3 to any attenuation latch byte
  ((b&0x90)==0x90 — the 0x90/0xB0/0xD0/0xF0 family, every tone channel and the
  noise channel) whose low nibble < 8 (ConvertTDVolume kq2 0x7D3C / lsl1
  0x7E65 / xmas 0x7680). 2.440 alone suppresses the second tone byte when its
  top three bits are set (lsl1 0x7E21 `and al,0xe0 / cmp al,0xe0 / jz`), which
  the engine models under its early-2.440 family. Terminator emits
  (saved&0xEF, 0x00, selector|0x0F), the saved bytes initialized from the
  shipped word array {0x9F,0xBF,0xDF,0xFF} (kq2 AGIDATA.OVL DS+0x166F).
  Engine: matches the 2.272 whole-byte signed rule, the Tandy +3 lift across
  all four attenuation latches on all early sound families (`2.089`, `2.230`,
  `2.272`, `2.411`, `2.440`), and the 2.411/2.440 signed 8-bit `jng` clamp
  (`((sum << 24) >> 24) > 0x0f ? 0x0f : sum`) including wrapped selector-bleed
  bytes.
- **F-SOUND-03 (fact; engine matches).** sound() ordering (PC Sound handler:
  2.001 0x4b42, 2.089 0x48eb, 2.230 0x48a7, 2.272 0x4943, 2.411 0x4FD5, 2.440
  0x5007, 2.903/2.917 0x510b, 2.936 0x51d3, 3.002.086 0x55d9,
  3.002.102/3.002.107 0x55ef, 3.002.149 0x5406; Amiga: 2.082 h97+0x3e,
  2.176..2.333 h135+0x54; IIgs 1.014 seg3+0x1b60): in every shipped binary,
  StopSnd runs first (sets the OLD done flag, silences the chip), then
  operands are read, the new done flag is Reset, and FindSnd failure calls
  Error(9, n) — the previous sound is already stopped and the new done flag is
  already cleared when the fault fires. Engine: the sound() handler stops the
  interrupted sound and clears the new done flag before the resource lookup
  can fault across all twenty profiles (field `soundStopsBeforeFault`).
- **F-SOUND-05 (fact; engine matches).** PC-speaker path (2.411 kq2
  0x7D19/0x7D59, 2.440 lsl1 0x7E42, 2.272 xmas 0x765D): divisor =
  12×(((b2&0x3F)<<4)+(b1&0xF)) built as ×4+×8; rest is cl==0x9F → port 0x61
  &= 0xFC; otherwise out 0x43,0xB6 then divisor low+high to 0x42 with no zero
  guard, port 0x61 |= 3. On machType 0 the player iterates exactly one
  channel ([bound]=2, word step). Booter 2.001 gates a zero divisor to
  speaker-off (0x7607) instead.

### SN76489 attenuation latching and rest notes

The audio backend accepts continuation data bytes for tone registers
and ignores them for attenuation/noise latches. This is a presentation
policy; the broad claim that every SN76489/NCR 8496 variant ignores those bytes
requires chip-specific evidence and is not established by interpreter execution.
See the [sound audit](#original-sound-player-audit) for the remaining hardware evidence gaps.

In multi-channel AGI sound resources (such as King's Quest II Sound 6, the two-voice church organ
hymn in Room 71), unused channels or rest notes are encoded with `tone = 0` and attenuation 15
(`0x0f`, silence).

The command stream and backend latching have separate responsibilities:

1. If an audio presentation backend treats non-latch data bytes as attenuation updates, a stray
   `0x00` byte (e.g. from an unsuppressed tone update or stream data) written while an attenuation
   register is latched will be interpreted as attenuation `0` (0 dB / 100% volume), producing an
   unintended maximum-volume stuck note or drone.
2. `SoundPlayback` emits both `0x00` tone bytes before a zero-tone rest's attenuation,
   matching the original KQ1/MH1/GR1 command streams. `AgiAudio` and
   `renderSoundPreview` ignore non-latch continuation bytes while an attenuation
   or noise register is latched, preventing those bytes from raising its volume.

**Specification:** The AGI behavioral specification documents the 5-byte note structure and treats
control attenuation `0x0f` as silence. It gives tone 0 no rest meaning of its own and does not detail
the TI SN76489 chip latching state machine.

**Tests:** [audio.test.ts](../app/test/audio.test.ts) (rejection of data bytes on attenuation latches),
[sound-playback.test.ts](../test/sound-playback.test.ts) (both zero tone bytes before rest attenuation).

### Original save and restart audit

[scripts/probe-interpreter-lifecycle.py](../scripts/probe-interpreter-lifecycle.py)
executes original save-writer/restore-reader cores and accepted restart reset
paths with optional Unicorn 2.1.4. Save/restore starts after successful file
selection and stops before resource reconstruction; DOS file reads/writes use
an in-memory file. Restart uses a synthetic OBJECT image and intercepts the
listed peripheral calls. This is bounded lifecycle evidence, not full DOS
startup or post-restore execution. Missing private inputs produce explicit skips.

GR1's executable hash is listed under [Verified inputs](#verified-inputs).
Corrected decoded SQ2 2.936 SHA-256 is
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
(initially 123 and 456), and sets f6. (See the correction in
[Persistence verdicts](#persistence-verdicts): ResetAll also
sets f5 on the accepted restart path.) Original variable/flag clears and object
reset execute. No reseed occurs in this measured reset path, including when
RNG is zero. The two builds passed 24 combined save/restore and restart cases.

Restart peripheral intercepts are SQ2 `0x5234,0x382e,0x3726,0x30d6,0x930e,0x37f7`
and GR1 `0x5467,0x3b00,0x3ad9,0x3a29,0x341c,0x9648`: StopSnd, CursorState (GR1
only), EraseCur, CancelLine, CloseHandles, EnableAllItems and WriteCur (SQ2
only); synthetic resource-loading intercepts are SQ2 0x3113 and GR1 0x3459.
EnableAllItems is game-visible state, not presentation: because the probe
stubbed it, its restart cases never observed the menu
([Original menu across restart and restore](#original-menu-across-restart-and-restore)). The
[reconstruction and startup execution](#startup-and-reconstruction-execution)
extends this boundary in these two builds; it does not establish other profiles
or full-machine startup.

Block 5 supplies resume offsets for loaded logic; the reconstruction execution
establishes which resources actually load. Exact host history separately
restores the complete captured cache boundary.

**Engine contract:** RNG and BIOS-reseed-input position stay out of
original `.SAV` blocks, and the current stream survives authentic save,
restore and accepted restart. History anchors intentionally restore stronger
host state and retain their explicit RNG/input position separately. Tests run
consume→save→consume→restore→consume against the current stream, and restart
at RNG zero followed by a random call: restart consumes no BIOS input; the
subsequent call consumes exactly one. f9/f6 and timing-word behavior are
protected through record→seek→resume. Original save block 2 copies raw object
records, so the engine writes each object's last computed band priority, fixed
or not, and the loop and cel counts its view and loop binding stored, which
stay after the view is discarded (`ScreenObject.loopCount`/`celCount`), in
`save.game` images and exported `.SAV` files alike. Host images (History,
autosave, recordings) keep their released record convention, priority only
when fixed and counts from the loaded view, so recorded images and their
fingerprints keep their bytes; the live priority rides in the host envelope.
The parameter bank uses the offsets proven in the
[motion audit](#original-motion-and-animation-audit). The released image codec retains private flag packing; the separate
[original-file API](#original-save-file-interoperability) converts it and verifies
controlled writer/reader interoperability. Bit 0x8000 still has no established
operational meaning. The engine preserves host RNG on restart
and excludes it from authentic saves.

```sh
python scripts/probe-interpreter-lifecycle.py /tmp/agi-fixed-sq2.bin
python scripts/probe-interpreter-lifecycle.py games/gr1/AGI
```

### Original menu across restart and restore

**Evidence class:** routine execution (Unicorn 2.1.4) of the complete
accepted `restart.game` branch in all fifteen PC builds and all six Amiga
builds, and of the successful restore tail in the eleven PC builds with
menus, each with the build's own data segment and a write hook on the whole
address space; the Amiga menu routine executed on a synthetic strip;
static disassembly of the menu constructors in every build and of the IIgs
`1.014` paths (`SQ2.SYS16` `e1a2788f92cb7622…`, no Toolbox code executed).
Executables: KQ2 2.411 `d99938d6622ef185…`, BC 2.439 `e717bfe1059eff8c…`,
LSL1 2.440 `c70e2f327eaad8db…`, PQ1 2.903 `db97accc32e48bac…`, MUMG 2.915
`6ee9d44b87e11dd3…`, KQ1 2.917 `bf53a4f98e32a7fe…`, KQ3 2.936
`4b50c681c224326e…`, KQ4 3.002.086 `b9b27b403015bb18…`, DEMOPAC4 3.002.102
`7cf6eac9d5bbfbd9…`, MH1 3.002.107 `ed8b58d354e10b06…`, GR1 3.002.149
`12a52b728b1b1f8d…` (decoded load modules); Amiga 2.082 `80c6b0c4912a4ca5…`,
2.176 `62b17ac8049a982e…`, 2.202 `557215fbbf431193…`, 2.310
`72ddbb3ecda804b8…`, 2.316 `7bfa2f36616923a4…`, 2.333 `5ce3b163bd32ee02…`.

**Facts.** The accepted restart branch and the successful restore tail
each call one routine that enables every item of every heading that has
items. On PC it walks the heading ring from the strip head and, for each
heading whose `+0xa` word is nonzero, writes 1 to the `+0xa` word of each of
its items (GR1 `0x9648`). The heading word marks a heading with items:
`set.menu` writes 1 and `set.menu`/`submit.menu` write 0 to a heading left
without items (GR1 `0x94a0..0x94a6`, `0x95fd..0x9603`); PC AGI has no
heading enable, and the routine writes no heading word. Neither path writes
the strip head, the submitted flag, the current heading and item, or the
menu-request latch: each of the strip head and the submitted flag has one
writer in the whole executable, in `set.menu` and `submit.menu`. The menu
lives in heap below the mark that `submit.menu` sets (MarkHeap, GR1
`0x168c`), and the restart's heap reset (GR1 `0x169b`) returns to that mark.
`set.menu` and `set.menu.item` return at once while the submitted flag is 1
(GR1 `0x9473`, `0x952d`), so a game that runs its menu code again adds
nothing. `submit.menu` has no such guard: running it again puts the current
heading and item back to the first (GR1 `0x960b..0x9618`, static). The
routine runs only on acceptance and after all save blocks were read; a
declined prompt, an open failure and a short read jump past it.

| Build                     | Enable all items | Restart call  | Restore call  | Strip head  | Submitted   |
| ------------------------- | ---------------- | ------------- | ------------- | ----------- | ----------- |
| 2.411                     | `0x8d63`         | `0x2495`      | `0x2600`      | DS `0x1ac1` | DS `0x1abf` |
| 2.439                     | `0x8e84`         | `0x24b3`      | `0x261e`      | DS `0x1b6e` | DS `0x1b6c` |
| 2.440                     | `0x8e8c`         | `0x24bb`      | `0x2626`      | DS `0x1b6e` | DS `0x1b6c` |
| 2.903                     | `0x9234`         | `0x24f1`      | `0x268c`      | DS `0x1d00` | DS `0x1cfe` |
| 2.915                     | `0x9233`         | `0x24f6`      | `0x2691`      | DS `0x1d22` | DS `0x1d20` |
| 2.917                     | `0x9247`         | `0x24f8`      | `0x2693`      | DS `0x1d22` | DS `0x1d20` |
| 2.936                     | `0x930e`         | `0x24f8`      | `0x2693`      | DS `0x1d2c` | DS `0x1d2a` |
| 3.002.086                 | `0x974f`         | `0x27b7`      | `0x2970`      | DS `0x1daa` | DS `0x1da8` |
| 3.002.102                 | `0x9775`         | `0x27cd`      | `0x2986`      | DS `0x1dba` | DS `0x1db8` |
| 3.002.107                 | `0x97b1`         | `0x27cd`      | `0x2986`      | DS `0x1dbc` | DS `0x1dba` |
| 3.002.149                 | `0x9648`         | `0x276c`      | `0x2925`      | DS `0x1b71` | DS `0x1b6f` |
| Amiga 2.082               | `h159+0x300`     | `h45+0x9e`    | `h47+0x1a6`   | `h160+0`    | `h160+0x16` |
| Amiga 2.176               | `h221+0x2ba`     | `h63+0xb2`    | `h66+0x1b0`   | `h222+0`    | `h223+0x16` |
| Amiga 2.202               | `h221+0x2e8`     | `h63+0xb2`    | `h66+0x1b0`   | `h223+0`    | `h223+0x16` |
| Amiga 2.310, 2.316, 2.333 | `h221+0x2e8`     | `h63+0xbc`    | `h66+0x1de`   | `h223+0`    | `h223+0x16` |
| IIgs 1.014                | `seg3+0x1319`    | `seg2+0x03a2` | `seg2+0x0215` | `$00a4`     | `$00a2`     |

With a planted three-heading menu (one heading without items, two items
disabled) every PC build ends both paths with all items enabled and the
heading words, strip head and submitted flag unchanged. The Amiga routine
calls Intuition `OnMenu` (LVO −192) once per item with `menu & 0x1f |
item << 5` and subitem 0, the number `enable.item` passes; on the synthetic
strip each build made exactly one call per item and none for the headings.
The Amiga menu records come from `AllocRemember`, outside the AGI heap the
restart rewinds. The IIgs routine calls Toolbox `$300F` (EnableMItem) with
`id | 0x100` per item and makes no EnableMenu or DrawMenuBar call; its menu
records come from the C allocator (main+0x2dad), outside the interpreter
heap. PC 2.001, 2.089 and 2.230 have no menu, and 2.272's menu actions
build none; their restart branches have no menu call. No save image holds
item states on any platform.

**Inference.** Intuition's `OnMenu` with subitem 0 on an item without
subitems enables the item; either way the effect equals `enable.item` on
every item.

**Engine contract.** On an accepted restart the engine keeps the menu, its
submitted state, its current heading and item and the menu request, and
enables every item (`menuActions: "full"`). The game's own `restore.game`
enables every item after the blocks are read. Host restores (History,
autosave) restore the recorded menu exactly. Running `submit.menu` again
puts the current heading and every heading's current item back to the
first. Test: [menu.test.ts](../test/menu.test.ts),
[native-menu.test.ts](../test/native-menu.test.ts) and
[lifecycle-equivalence.test.ts](../test/lifecycle-equivalence.test.ts).

**Not established.** Full-machine execution; the menu's on-screen redraw
after the enable (the strip is drawn only when the menu opens).

### Original restart state boundary

**Evidence class:** routine execution (Unicorn 2.1.4) of the complete
accepted `restart.game` branch, from the handler entry read off each
build's action table (slot `0x80`) to its `ret`, in all fifteen PC builds
with each build's own `AGIDATA.OVL` as the data segment (2.001: the
booter's data record) and a write hook over the whole address space; only
the confirmation, the OBJECT loader and the cursor glyph writer were
intercepted. All six Amiga builds executed the same way under the 68000
model (the prompt, the OBJECT loader and decrypt, the input-row character
drawer and the 2.31x title-bar redraw stubbed). IIgs `1.014` static.
Executables as in [Original menu across restart and
restore](#original-menu-across-restart-and-restore), plus 2.001 DDP
`424da51a6c161cca…`, 2.089 SQ1 `e31e5e8611c81d58…`, 2.230 `875547deb3d83b7e…`
and 2.272 `a0c26b5dee86b676…` (decoded).

**Facts.** Every build's accepted restart returns 0 (the bytecode
continuation is abandoned) and writes only: vars, flags, the timer dword,
player control := 1, last picture := 0 and block enabled := 0 in the state
block, the object table and inventory pointers, the controllers, the cache
heads (the logic list truncated after its head node), the heap pointer and
v8, f6, f9 by the saved preference, and the cursor word. No write lands
outside the data segment on PC: no video memory and no picture buffer. It
writes none of: horizon, block rectangle coordinates, script capacity and
active count, the script checkpoint, key map, strings, text colours and
attribute, input enable and row, prompt character, status enable and row,
picture base and bottom rows, menu gate and key gate (3.002.102+),
text-mode byte, priority base and table, `open.dialogue` state, echo
buffer, event queue, window state, trace-active state, and the logic-0
cache node, whose scan-start word (`+6`, written by `set.scan.start`, GR1
`0x154a`) therefore survives. 2.001 has no CancelLine call
(`0x2176..0x21e7`), so a partly typed line survives its restart. Amiga
2.310, 2.316 and 2.333 save v7 before ResetAll and put it back after
(`h63+0x50`, `+0xc2`; executed: v7 = 77 before and after), then redraw the
title-bar status (`h63+0xcc` → `h82+0x42c`); 2.082, 2.176, 2.202 and the
IIgs zero v7 with the other variables. The Amiga `configure.screen` row
words (2.202 `+0x404..+0x409`) are not written. The prompt is the shared message routine, so
f15 and v21 apply to it ([F-persistence-prompt-modes](#persistence-verdicts)).

| Build                | Restart entry | ResetAll       | Prompt routine |
| -------------------- | ------------- | -------------- | -------------- |
| 2.001                | `0x2176`      | `0x106d`       | `0x1b15`       |
| 2.089                | `0x22ab`      | `0x0ed6`       | `0x1ba9`       |
| 2.230                | `0x21ed`      | `0x0e50`       | `0x1aeb`       |
| 2.272                | `0x2289`      | `0x0e7c`       | `0x1b87`       |
| 2.411                | `0x241f`      | `0x0f6a`       | `0x1c95`       |
| 2.439                | `0x242d`      | `0x0f6a`       | `0x1ca3`       |
| 2.440                | `0x2435`      | `0x0f72`       | `0x1cab`       |
| 2.903                | `0x246b`      | `0x0fa0`       | `0x1ce1`       |
| 2.915                | `0x2470`      | `0x0fa5`       | `0x1ce6`       |
| 2.917, 2.936         | `0x2472`      | `0x0fa5`       | `0x1ce8`       |
| 3.002.086            | `0x272b`      | `0x11e4`       | `0x1fa1`       |
| 3.002.102, 3.002.107 | `0x2741`      | `0x11fa`       | `0x1fb7`       |
| 3.002.149            | `0x26e0`      | `0x11b3`       | `0x1f70`       |
| Amiga 2.082          | `h45+0x000`   | `h23+0x74`     | `h40+0x150`    |
| Amiga 2.176, 2.202   | `h63+0x000`   | `h33+0x7a`     | `h57+0x150`    |
| Amiga 2.310, 2.316   | `h63+0x000`   | `h33+0x7a`     | `h57+0x150`    |
| Amiga 2.333          | `h63+0x000`   | `h33+0x8e`     | `h57+0x150`    |
| IIgs 1.014           | `seg2+0x0311` | `initseg+0x69` | `seg2+0x2239`  |

**Engine contract.** `restart()` writes the same set: it keeps the script
capacity, text mode, the status line, the echo line, horizon, priority base
and table, the key-release gate, the input width and the Amiga picture top,
keeps logic 0 and its scan start across the cache reset, and sets player
control. Profile fields:

| Field                  | Value                                                                                             | Evidence                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `restartCancelsLine`   | false on `2.001`, true on every other build                                                       | the 2.001 restart branch has no CancelLine          |
| `confirmPromptModes`   | `none` on `2.001`; `timed` on `2.089`, `2.230`, `2.272`, `amiga-2.082`; `timed-and-f15` elsewhere | [F-persistence-prompt-modes](#persistence-verdicts) |
| `restartKeepsMaxScore` | true on `amiga-2.310`, `amiga-2.316`, `amiga-2.333`                                               | v7 saved at `h63+0x50`, restored at `+0xc2`         |

No write lands on the screen, so the engine keeps the shown frame: the cels
on screen become part of the picture surface, counted as stamps like
`add.to.pic`'s (CGA cel colours included), the text and window pixels a cel
was drawn over go with it, and text written later stays on top. The status
line redraws with the reset score, the input row shows the cancelled line,
and a persistent window stays open. The first picture after the restart
dissolves from the kept screen on Amiga and IIgs. The priority plane is not
rewritten (the restarted game draws a picture before any depth test needs it),
and the engine takes no History checkpoint until the restarted game draws.
The engine still empties the script's active pairs and checkpoint, the
event queue and the block rectangle, and stops tracing; the original keeps
the first two until the restarted game's `new.room` resets them and leaves
the others to `new.room` or the save image, so a player sees no difference.

**Not established.** Full-machine execution; the trace-active state; the
2.001 `max.drawn.objects` storage address.

### Original save-file interoperability

**Evidence class:** execution of original save writers and block readers with controlled,
original synthetic memory; Unicorn 2.1.4 on x86/68000, headless MAME 0.289 on the IIgs.
Disk selection, file opening and OS I/O are intercepted. The original code chooses the block
addresses, sizes, order, length bytes and resume serialization. The captured payloads contain
no game assets. The byte assertions are in [savFile.test.ts](../test/savFile.test.ts) and
[savFile-captures.json](../test/savFile-captures.json).

There are two independent cases per single-file build: a patterned memory image tests opaque
byte preservation; a hand-initialized game state tests fresh export without decoding an expected
file, followed by importing the original writer’s file into a real Engine. The latter carries
signature `TEST`, v100=37, f100/f200 set, s0=`Hello`, a drawn animated ego at (40,80) using
view 3, one carried object and three active replay pairs: load picture 1, draw picture 1,
load view 3. Capacity is four; the fourth pair is inactive. Reference tokens and reserved fields
are zero, except the documented reserved word 15. Resume contains the empty cache head and
terminator. The patterned case additionally carries nonzero tokens, string/description tails,
inactive pairs and object bits 0x0080/0x8000.
Field placement inside the state block comes from the earlier layout findings and the executed
Set routine, and the seed script places fields at those documented offsets, so the fresh-export
byte match proves the writer’s block choice, order, sizes, endianness, XOR, description and flag
bit order, but not field placement.

**Scope:** complete file bytes and the mapped saved state, with engine reconstruction exercised
using original synthetic resources. The original block readers independently restore all captured
blocks byte for byte. The PC/Amiga reader runs use the patterned case; IIgs uses the game-state
case. This does not establish every game’s later LOGIC behavior or unknown object bit 0x8000.
Original restore effects (f12, machine variables, follower retry and view rebinding) still apply,
rather than treating a native file as an exact host checkpoint. Native pointer tokens are rebuilt
during restore; fresh exports with zero tokens match the original writer given zero-token memory,
not arbitrary addresses in a separately running game.

#### Writer and reader boundaries

PC addresses below are load-module offsets; the hash covers the decoded executable, including
its MZ header. Amiga addresses are hunk-relative; hashes cover the original hunk executable.
The IIgs hash covers the OMF load file; segment names/offsets identify its relocated routines.
Entry→stop ends before close/reconstruction. Every single-file row passed exact export and
mapped-state import assertions.

| Build       | SHA-256                                                            | Writer entry→stop        | Reader entry→stop  | State bytes    |
| ----------- | ------------------------------------------------------------------ | ------------------------ | ------------------ | -------------- |
| 2.089       | `e31e5e8611c81d58ba2a8fcc63ecdf7ded767814324c66dfd73b6452f7199cb4` | `0x25a2→0x2634`          | `0x23f2→0x2451`    | `0x3db`        |
| 2.230       | `875547deb3d83b7ed2dd7578d357f43b6a5843a9ac8de1332245df9f60ff4570` | `0x24e8→0x257a`          | `0x2336→0x2395`    | `0x3db`        |
| 2.272       | `a0c26b5dee86b6761d0996f463d9bed2b93ff356aa4fbb56a55d369501fb588a` | `0x2596→0x263e`          | `0x23d2→0x2443`    | `0x3db`        |
| 2.411       | `d99938d6622ef18556bea76ebe72214b18cecac7305b83885a1157ddcff539bf` | `0x2734→0x27dc`          | `0x256c→0x25dd`    | `0x5df`        |
| 2.440       | `c70e2f327eaad8dbcb1d526e9fb3f933b342329b84c6a803f9062c245ccb7676` | `0x275a→0x2802`          | `0x2592→0x2603`    | `0x5df`        |
| 2.903       | `db97accc32e48bac0c759a6364f48790830c90f14a1486be53d1f0b7899730a7` | `0x27f4→0x289c`          | `0x25cf→0x2640`    | `0x5e1`        |
| 2.917       | `bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04` | `0x27fb→0x28a3`          | `0x25d6→0x2647`    | `0x5e1`        |
| 2.936       | `4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400` | `0x27fb→0x28a3`          | `0x25d6→0x2647`    | `0x5e1`        |
| 3.002.086   | `b9b27b403015bb18f6562ba1b8b04c2829e0c3b53c042196bee7924d1df7be65` | `0x2aea→0x2b92`          | `0x28a1→0x2912`    | `0x5e1`        |
| 3.002.102   | `7cf6eac9d5bbfbd944a2b5d7189878ffe4b2d608646d91c87d5372399fa9d1d0` | `0x2b00→0x2ba8`          | `0x28b7→0x2928`    | `0x5e4`        |
| 3.002.107   | `ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e` | `0x2b00→0x2ba8`          | `0x28b7→0x2928`    | `0x5e4`        |
| 3.002.149   | `12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41` | `0x2a9f→0x2b47`          | `0x2856→0x28c7`    | `0x404`        |
| amiga-2.082 | `80c6b0c4912a4ca5b44ad94c1c1b66a42e2b490f8a4ace90fb8b05f1fb39ea0f` | `h49+0xd6→0x1f6`         | `h47+0xec→0x178`   | `0x2f4`        |
| amiga-2.176 | `62b17ac8049a982e08b1830463f067e102960feb2abb78e992e28bbe15a1cf42` | `h69+0xe0→0x200`         | `h66+0xf6→0x182`   | `0x40a`        |
| amiga-2.202 | `557215fbbf431193e99578be53372496bd4bf1cfad7c4ba93a61968e5c760dec` | `h69+0xe0→0x200`         | `h66+0xf6→0x182`   | `0x40a`        |
| amiga-2.310 | `72ddbb3ecda804b8dac2f65ed115099af0241d475ac8d432de48428b28cd5cca` | `h69+0x146→0x266`        | `h66+0x104→0x190`  | `0x414`        |
| amiga-2.316 | `7bfa2f36616923a41ecb5aa9e3595e7225cdd48ea453e1c1b8310ace0fcdb7db` | `h69+0x146→0x266`        | `h66+0x104→0x190`  | `0x414`        |
| amiga-2.333 | `5ce3b163bd32ee025f6ba8ca8c946b03a06ff2960da8cc723c1d6184a3cc346a` | `h69+0x164→0x284`        | `h66+0x104→0x190`  | `0x414`        |
| iigs-1.014  | `e1a2788f92cb76220e5ac228945bf2eaf7f3a97208f0c3af2ae81d947407717f` | `savegamese+0x16e→0x281` | `seg2+0x11a→0x1ba` | `0x38 + 0x3d0` |

IIgs execution places the original arithmetic helpers in bank 1 and resolves the reached OMF
far-pointer/internal-call relocations to synthetic RAM. The writer runs its original length
division helper (`main+0x34cc`); the reader runs its original byte-combining helper. The Write
and Read wrappers at segment 13 +0x10f/+0xb5 transfer requested bytes to an in-memory
file. Segment `logicseg+0x363` serializes the cache head and terminator. No GS/OS disk dialog
or game startup is part of this routine probe.

#### Envelope and blocks

All three platforms write a 31-byte description followed by `{u16le length, payload}` blocks.
The description is a byte string ending at its first NUL; bytes after it can retain earlier text.
There is no magic, version or profile identifier. The caller must select the interpreter profile;
structurally identical builds cannot be distinguished by their file bytes.

| Builds                                  | Blocks in order                                    | Inventory transform         |
| --------------------------------------- | -------------------------------------------------- | --------------------------- |
| PC 2.089, 2.230                         | state, objects, inventory, script                  | none                        |
| PC 2.272 through 2.936, including 2.903 | state, objects, inventory, script, resume          | none                        |
| PC 3.002.086/.102/.107/.149             | state, objects, inventory, script, resume          | repeating `Avis Durgan` XOR |
| Amiga 2.082/.176/.202                   | state, objects, inventory, script, resume          | none                        |
| Amiga 2.310/.316/.333                   | state, objects, inventory, script, resume          | repeating `Avis Durgan` XOR |
| IIgs 1.014                              | globals, state, objects, inventory, script, resume | none                        |

The inventory block is the runtime OBJECT payload after its metadata header: live room byte
at entry +2, three-byte entries on PC/IIgs and four-byte entries on Amiga, followed by the name
pool. XOR covers the whole payload from key index zero. PC v3 transforms before selection
(for example 3.002.149 `0x2a00..0x2a12`, transform `0x07bc`) and reverses it after saving.
Amiga 2.31x does the same at h69+0x5a..0x7a, calling h19+0; the execution captures include
that call. Earlier claims that these Amiga save blocks are raw were incorrect.

Script storage is capacity × two bytes, including inactive slots. Each pair is two bytes
`{kind, value}` with no endian conversion. The active count is distinct from capacity. Kind 5
consumes three additional pairs for add.to.pic. Resume storage consists of four-byte records
`{u16 logic, u16 offset}`: cache head, cached logic records, `0xffff` terminator. Resume words
are little-endian on PC/IIgs and big-endian on Amiga. The raw head/terminator words survive
document re-export. Resume records supply scan offsets to replay loads; they are not a load list.

#### PC state and objects

Every PC state block begins with signature[7], v0..v255 at +0x007, 32 flag bytes at +0x107,
a u32le timer at +0x127 and the middle section at +0x12b. Saved numeric fields are little-endian.
Original PC flags use `0x80 >> (flag & 7)`; executing Set for f100/f200 produced 0x08/0x80
in their respective bytes on every captured PC build. Set entry addresses, in table order, are
`0x6a04, 0x69bd, 0x6a59, 0x70c2, 0x71e7, 0x73aa, 0x73bd, 0x7484, 0x78c3,
0x78db, 0x78db, 0x77b8`. The host codec’s opposite bit order stays confined to host images.

| PC layout                  | Middle   | Key map      | String bank   | Text             | Tail                                                   |
| -------------------------- | -------- | ------------ | ------------- | ---------------- | ------------------------------------------------------ |
| 2.089/.230/.272            | 28 bytes | +0x147, 39×4 | +0x1e7, 12×40 | +0x3c7, 20 bytes | none                                                   |
| 2.411/.440                 | 24 bytes | +0x143, 49×4 | +0x20b, 24×40 | +0x5cb, 20 bytes | none                                                   |
| 2.903/.917/.936, 3.002.086 | 24 bytes | +0x143, 49×4 | +0x20b, 24×40 | +0x5cb, 20 bytes | checkpoint u16 at +0x5df                               |
| 3.002.102/.107             | same     | same         | same          | same             | checkpoint +0x5df, menu u16 +0x5e1, key gate u8 +0x5e3 |
| 3.002.149                  | 24 bytes | +0x143, 49×4 | +0x20b, 12×40 | +0x3eb, 20 bytes | checkpoint +0x3ff, menu +0x401, key gate +0x403        |

The 49 serialized key records are 39 active plus ten reserved until 3.002.149; early layouts
serialize 39. Four alignment bytes precede strings. Parse addresses six early string slots or
twelve later ones; the additional serialized slots remain accessible to other string actions.
Key records contain u16 raw key and u16 status. String slots contain 40 bytes each.

Early middle u16 fields, in order: display mode, horizon, previous navigation, rectangle left/
top/right/bottom, direction coupling, last picture, navigation direction, block enabled, startup
count, script capacity, active count. Common middle: horizon, reserved zero, rectangle left/
top/right/bottom, direction coupling, last picture, block enabled, reserved 15, capacity, active.
The text group has u16 foreground/background/attribute/input-enabled/input-row, prompt byte
and padding byte, then u16 status-enabled/status-row/base-row/bottom-row.

PC object records have stride 0x2b: step-time/count/index bytes +0..2; x/y u16 +3/+5;
view byte +7; reference word +8; loop/count bytes +0xa/+0xb; reference +0xc; cel/count
bytes +0xe/+0xf; reference words +0x10/+0x12/+0x14; previous x/y +0x16/+0x18;
width/height +0x1a/+0x1c; step-size/cycle-time/cycle-count/direction/motion/cycle/priority
bytes +0x1e..0x24; flag word +0x25; four parameter bytes +0x27..0x2a.
A game's restore reads the menu-gate and key-gate words back only on the layouts that carry them
(3.002.102 and later); on every other layout the live gates survive, as they do in the
original, whose block 1 does not reach them (`block1CarriesGates`). KQ4 3.002.086's menu
therefore keeps its live menu setting after the game's restore. Host restores (History,
autosave and Play from Create) carry both gates in optional replay-state fields `menuGate`
and `releaseGate`, including on layouts without gate words. Older recordings omit them
and keep the values left by image restoration; their stored fingerprints remain unchanged.
Native motion numbers normal/wander/follow/move are 0/1/2/3; cycle numbers forward/
end-of-loop/reverse-loop/reverse-cycle are 0/1/2/3. Object flag meanings are in the
[original flag table](#startup-and-reconstruction-execution); the new boundary converts
both mode enums and flags to the engine’s portable representation.

#### Amiga and IIgs state

The [Amiga save-image map](#save-image-fact) and [IIgs globals/object map](#bounds-objects-and-the-save-image-fact)
give the full platform field offsets. The captured Amiga state sizes are 0x2f4, 0x40a, 0x40a,
0x414, 0x414, 0x414 in build order; their fields and 0x48-byte object records are big-endian.
IIgs writes the 0x38-byte globals image, then 0x3d0 bytes of arrays; its fields and 0x48-byte
objects are little-endian. Amiga and IIgs flag banks use `1 << (flag & 7)`, unlike PC:
Amiga h126+0x2a..0x34 (2.082) and h175 (later builds) shift 1 left; IIgs flagseg+0x28a
uses main+0x3280 to shift 1 left before OR at +0x2cc. The object flag words have the
shared native assignment already documented for these platforms.

Earlier IIgs notes inferred big-endian length words from division without following which
result remained in A versus on the stack. Execution of savegamese+0x2e2..0x3b4 establishes
low byte first: +0x2f8 pops the remainder, whereas +0x33e discards it and retains the quotient.
The original reader at seg2+0x273 combines low + 256×high. A 0x38-byte lead starts `38 00`,
and a 0x3d0-byte state starts `d0 03` in both controlled captures.

#### Booter 2.001

The decoded booter executable SHA-256 is
`424da51a6c161cca8c7dfb9fd78e94b89a1d5301640c845999b54128d1bcd2dd`.
Its save routine at 0x2541..0x2609 is a different storage protocol: it reads a 512-byte
directory buffer, clears DS+6, sends DS+6..0x2de (0x2d9 bytes), the object table at
DS pointer 0x457/length 0x45b and inventory at 0x45d/length 0x461 through 0x2bba,
then updates the directory through 0x2f37. The block writer emits 0x12/0x34 and its
device/length fields in sector buffers. Routine 0x2cbf derives cylinder/head/sector values;
0x5685 performs BIOS INT 13h I/O. There is no 31-byte description plus length-block file.
The standalone file API rejects 2.001. Booter disk-image import/export is outside this API.

#### API and archive boundary

Dynamically import `src/runtime/savFile.ts` only when needed. `decodeOriginalSav(bytes, profile)`
returns portable SaveState; `encodeOriginalSav(state, profile)` writes an original file.
The same decoded state retains opaque bytes for unchanged document re-export.
`importOriginalSav(engine, bytes)` checks the selected profile layout, signature, object allocation
and inventory metadata before the engine’s disposable restore validation. `exportOriginalSav(engine, description?)` requires a complete room with no open interaction or parked continuation.
No native platform dialog is added.

The released `encodeSave`/`decodeSave`, host envelopes, checkpoint versions, profile IDs and archive
fixtures keep their bytes and behavior. Native conversion alone handles PC flags/object modes,
the four-block 2.230 file, Amiga 2.31x XOR and the IIgs length order. Import failures, including
unknown replay kinds, missing view resources and truncated transient-cel packets, leave the
live game state unchanged. File I/O/storage concurrency is the caller’s concern; this in-memory
API neither writes storage nor claims tab/close durability.

#### Startup and reconstruction execution

The lifecycle probe also executes game-state startup, restore reconstruction
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
list**. Host history intentionally
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

Engine startup and accepted restart apply the per-profile `ResetAll` tuple
(`[v8, v20, v22, v24, v26, f5, f11]`; see `F-OPCORE-04-adjacent` below), with
startup setting `f9 = 1` and accepted restart preserving the pre-restart `f9`
sound preference while setting `f6 = 1`. Hosts can still apply a
player-selected sound preference after construction.

The opcode dispatch tables (SQ2 DS0x061d; GR1 DS0x0440) select the original
handler addresses used by the flag probes. Each setter/clearer executes from
both zero and all-set flag words. Draw, erase and animate transitions plus
stationary updates supply additional flag evidence. The mapping is:

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
bit assignments. The [original-file API](#original-save-file-interoperability) translates these bits
and preserves unmapped raw bits; operational meaning for 0x8000 remains unclaimed.

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

#### Persistence verdicts

Static disassembly of the decoded KQ3 2.936 image, MH1 3.002.107 and GR1
3.002.149; strings read from the hash-pinned data segments.

- **F-persistence-01 (fact; engine matches).** Accepted restart state clears
  (2.936 kq3 ResetAll 0x0FA5 / 3.002.107 mh1 0x11FA / 3.002.149 gr1 0x11B3):
  FillMem(var,256,0) at DS+0x09, ClearFlags (rep stosw 32B DS+0x109),
  ClearControl (50B), aniObj zero-fill. The fill starts at DS+0x09 — gameID
  (DS+0x02), keyMap (DS+0x145) and userStr (DS+0x20D) survive restart; only
  the boot-time data image initializes them.
- **F-persistence-02 (fact; engine diverges on PC/IIgs).** Restart prompt
  cursor and `CancelLine` ordering (PC `RestartGame`: `2.001` `0x2176`,
  `2.089` `0x22ab`, `2.230` `0x21ed`, `2.272` `0x2289`, `2.411` `0x241f`,
  `2.439` `0x242d`, `2.440` `0x2435`, `2.903` `0x246b`, `2.915` `0x2470`,
  `2.917`/`2.936` `0x2472`, `3.002.086` `0x272b`, `3.002.102`/`3.002.107`
  `0x2741`, `3.002.149` `0x26e0`, each from its build's action table at
  `DS:0x61b` slot `0x80`; Amiga: `2.082` `h45+0x000`, `2.176..2.333`
  `h63+0x000`; IIgs `1.014` `seg2+0x0311`): in every binary, `CancelLine` is
  never called before the confirmation prompt or on the cancelled branch; it
  runs only on the accepted branch after `WaitAcAb != 0` or the `f16` bypass
  (e.g. `2.089` `0x22d1`, `2.936` `0x24a8`, `3.002.149` `0x2721`, Amiga `2.082`
  `h45+0x052`, `2.176..2.333` `h63+0x064`, IIgs `1.014` `seg2+0x035d`), so
  declining `restart.game` leaves `INLINE` (`editLine`) and the typed command
  row intact across all twenty profiles. PC `2.001` has no `CancelLine` call at
  all (`0x2176..0x21e7`), so its accepted restart keeps a partly typed line
  too (`restartCancelsLine: false`; [Original restart state
  boundary](#original-restart-state-boundary)). For cursor visibility, all builds
  call `EraseCur` before the prompt; PC `3.002.086..3.002.149` save
  `CursorState()` to `[bp-6]` before `EraseCur` and at the tail call `WriteCur`
  if `[bp-2] != 0 || [bp-6] != 0`, whereas PC `2.089..2.936`, Amiga
  `2.082..2.333`, and IIgs `1.014` call `WriteCur` unconditionally at the tail
  (PC `2.001` omits `WriteCur`). Engine: `confirmSessionAction` leaves
  `editLine` untouched around the confirmation window and clears it only in
  `restart()` when the prompt is accepted (field `originalRestartRestore`);
  `confirmCursor` is `"erased"` only on the Amiga profiles, so on PC and IIgs
  the cursor stays visible through the prompt and the original's conditional
  `WriteCur` is not reproduced. Whether the original's accepted `CancelLine`
  clears the input row when input is disabled is unverified; the engine calls
  `drawInputRow()`, which blanks that row while input is disabled.
- **F-persistence-03 (fact; engine matches).** Restore tail (PC `RestoreGame`:
  `2.001` `0x21e8..0x22f2`, `2.089` `0x240a..0x24d1`, `2.230` `0x234c..0x2417`,
  `2.272` `0x23e8..0x24b3`, `2.411` `0x24c5..0x2590`, `2.439` `0x24cb..0x2596`,
  `2.440` `0x24d3..0x259e`, `2.903` `0x2642..0x2692`, `2.915` `0x2647..0x2697`,
  `2.917`/`2.936` `0x2647..0x2699`, `3.002.086` `0x2912..0x2976`,
  `3.002.102`/`3.002.107` `0x2928..0x298c`, `3.002.149` `0x28c7..0x292b`;
  Amiga: `2.082` `h47+0x000..0x290`, `2.176`/`2.202` `h66+0x000..0x288`,
  `2.310`/`2.316` `h66+0x000..0x2a8`, `2.333` `h66+0x000..0x294` (on
  `2.176..2.333` `h65` is an empty hunk at `h66`'s base); IIgs `1.014`
  `restore.game` `seg2+0x0000..0x0272`, tail `seg2+0x01bc..0x0272`, from the
  action table at ~arrays+0x3fe slot `0x7e`): after reading the save blocks and closing the
  file, **PC `2.903..3.002.149`** (`2.903` `0x264a..0x2674`, `2.915`
  `0x264f..0x2679`, `2.917`/`2.936` `0x2651..0x267b`, `3.002.086`
  `0x292e..0x2958`, `3.002.102`/`3.002.107` `0x2944..0x296e`, `3.002.149`
  `0x28e3..0x290d`) rewrite `var[20] = (byte)computerType` (`0` on PC),
  `var[26] = (byte)monitorType` (`3` on EGA), and if `computerType == 0` set
  `var[22] = 1` (retaining the save file's `f11`), else set `var[22] = 3` and
  `Set(11)` (`f11 = 1`) (`restoreRewritesMachineState: true`). **PC
  `2.001..2.440`, Amiga `2.082..2.333`, and IIgs `1.014`** have no post-read
  `v20`/`v22`/`v26`/`f11` rewrite (`restoreRewritesMachineState: false`),
  preserving those four values from the save file's `VARS`/`FLAGS` blocks. All
  builds run reconstruction, which ends with EraseCur, CancelLine, showing the
  picture buffer, the status line and the input row (GR1 `0x6d40` → `0x3ad9`,
  `0x6d43` → `0x3a29`, `0x6d46` → `0x576f`, then `0x380f` and `0x3b66`; Amiga
  2.202 h156+0x28e..0x2b2), so the edit line empties while the echo buffer,
  which lies outside the save blocks, survives; then `ClearControl`, and (`2.089+`, Amiga, IIgs)
  `Set(12)` (`f12 = 1`), then CloseHandles (`2.230+`, Amiga, IIgs) and
  EnableAllItems (PC `2.411+`, Amiga, IIgs; [Original menu across restart and
  restore](#original-menu-across-restart-and-restore)); `f2`/`f4`/`v19` are not touched — `f2`/`f4` are cleared
  at every main-cycle top (e.g. kq3 `0x161`/`0x16B`). Engine: the authentic
  restore tail clears controllers, applies the per-profile machine-state
  rewrite when `restoreRewritesMachineState` is true, sets `f12` and enables
  every menu item, counts the restored picture as shown (host restores keep
  their recorded value), empties the edit line
  and keeps the echo line, leaving
  `f2`/`f4` to the next cycle top and never writing `v19`; host-image restores
  (history, autosave) always keep the recorded machine vars intact.
- **F-persistence-04 (fact; engine matches).** Timer across persistence
  (2.936 kq3): sysTimer is a 32-bit dword at DS+0x129 incremented by
  `add [0x129],1; adc [0x12b],0` in the tick routine (0x7F01); there is no
  sub-tick remainder word. Accepted restart zeroes both words (0x24DB);
  restore reloads the dword wholesale inside block 1 and leaves it untouched.
- **F-persistence-05 (fact; engine matches).** Restart/quit prompts (PC
  `2.001..3.002.149`, Amiga `2.082..2.333`, IIgs `1.014`): on PC, restart =
  `"Press ENTER to restart\nthe game.\n\nPress ESC to continue\nthis game."`
  (e.g. kq3 `DS+0xADB`), and quit (`2.272+`, IIgs; PC `2.001..2.230` `0x0265`
  exit immediately with no operand via `exitAlwaysImmediate: true`) =
  `"Press ENTER to quit.\nPress ESC to keep playing."` (e.g. kq3 `DS+0x5E3`,
  IIgs `main+0x2299`, ~arrays+0x10db, through `main+0x02d0` →
  `seg2+0x2239`). Both PC text prompts use `WindowPrint` with height/width 0
  (auto-size) and `WaitAcAb`, and `quit(1)` skips the prompt on every build
  with an operand. On Amiga `2.082..2.333`, `restart.game` (`2.082`
  `h45+0x000`, `2.176..2.333` `h63+0x000`) passes `"Restart the game?"`
  (`2.082` `h35+0x2d`, `2.176..2.333` `h49+0x2d`) with Intuition gadget labels
  `"Restart"`/`"Cancel"` (`h46+0x00`/`+0x08`, `h64+0x00`/`+0x08`) to
  `WindowPrint` (`h40+0x150` / `h57+0x150`), and `quit` (`2.082` `h2+0x18e`,
  `2.176`/`2.202` `h2+0x1c2`, `2.310..2.333` `h2+0x1ce`) passes `"Quit the
game, or continue?"` (`h3+0x00`) with gadget labels `"Quit"`/`"Continue"`
  (`h3+0x25`/`+0x2a`); no Amiga binary contains `"Do you want to quit?"`. On
  IIgs `1.014` (`SQ2.SYS16` `e1a2788f92cb7622…`), `restart.game`
  (`seg2+0x0311`) passes three far pointers to the dialog routine
  `seg2+0x2239` (`seg2+0x0336..0x0348`): ~arrays+0x1271 `"Restart the game?"`
  and the labels ~arrays+0x1496 `"Restart"` and ~arrays+0x149e `"Cancel"`; the
  binary holds no `"Press ENTER to restart"` string. Engine:
  `confirmSessionAction` renders `"Restart the game?\n\n\nRestart    Cancel"`
  on Amiga and IIgs profiles (`windowFrameGeometry` `"amiga"` or `"iigs"`),
  `"Quit the game, or continue?\n\n\nQuit               Continue"` on Amiga
  profiles, and the PC Enter/Escape strings otherwise, with Enter accepting
  and Escape cancelling across all profiles while neither f15 nor v21 applies
  (F-persistence-prompt-modes; fields `originalRestartRestore`,
  `exitAlwaysImmediate` and `confirmPromptModes`). The IIgs dialog's button geometry is not
  established, so its labels are plain text with no click targets.
- **F-persistence-prompt-modes (fact; engine matches).** The restart and quit
  confirmations call the shared message routine `print` uses, so f15 and v21
  apply to them. Calls: PC restart `2.001` `0x218d → 0x1b15`, `2.089`
  `0x22c2 → 0x1ba9`, `2.230` `0x2204 → 0x1aeb`, `2.272` `0x22a0 → 0x1b87`,
  `2.411` `0x2436 → 0x1c95`, `2.936` `0x2499 → 0x1ce8`, `3.002.149`
  `0x270d → 0x1f70`; quit (`2.272+`) calls the same routine, for example
  `2.411` `0x0263`, `2.936` `0x0296`, `3.002.149` `0x028f`. Amiga: restart
  h63+0x3a (`2.082` h45+0x26) and quit h2+0x1ba / +0x1ee / +0x1fa → WindowPrint
  h57+0x150 (`2.082` h40+0x150). IIgs `1.014`: restart seg2+0x0348 and quit
  main+0x0309 → seg2+0x2239. **f15** (PC `2.411..3.002.149`, Amiga
  `2.176..2.333`, IIgs): if f15 is set, the routine clears it and returns
  accept at once, leaving the window open (`2.411` `0x1cab..0x1cc6`, GR1
  `0x1f86..0x1fa1`, Amiga h57+0x184..0x1b8, IIgs seg2+0x2275..0x22a5); 2.31x
  also sets h59+0xc and the IIgs `$1590`. PC `2.001..2.272` and Amiga `2.082`
  have no f15 test. **v21** (every build except PC `2.001`): if v21 ≠ 0, the
  routine waits until `timer + v21 × 10` or until its accept/abort poll
  returns Enter (1) or Esc (0), then returns accept either way and sets
  v21 := 0 (`2.089` `0x1c24`, `2.411` `0x1d2d`, `3.002.149` `0x2008`; Amiga
  h57+0x204 / +0x20c, `2.082` h40+0x1cc; IIgs seg2+0x2340). Other keys are
  dequeued and dropped (`3.002.149` `0x4744`). **v21 = 0**: the routine blocks
  until Enter (accept) or Esc (cancel); on Amiga the first gadget
  (`"Restart"`, GadgetID 2) posts Enter and the second (`"Cancel"`, ID 3)
  posts Esc (h106+0x158..0x1a8; `2.082` h78+0x148..0x192). Every handler
  accepts on a result of 1; quit with operand 1 skips the prompt. Not
  established: the IIgs button path (inference from the Amiga: Enter and
  Esc), full-machine runs. Engine: field `confirmPromptModes` (`"none"` on
  `2.001`, `"timed"` on `2.089..2.272` and Amiga `2.082`, `"timed-and-f15"`
  elsewhere). With f15 set, `confirmSessionAction` opens the prompt as the
  persistent window, clears f15 and accepts. With v21 set it parks a timed
  confirmation whose window closes after v21 half-seconds, as a timed print
  does; the close answers Enter, Enter or Esc accept early, other keys are
  dropped, and v21 is zeroed. Tests: [original-lifecycle.test.ts](../test/original-lifecycle.test.ts),
  [worker-confirm-gadgets.test.ts](../app/test/worker-confirm-gadgets.test.ts).
- **F-persistence-05-gadgets (fact; engine matches the rectangles).** Amiga
  WindowPrint gadget geometry, read off all six executables (`Sierra` 2.082
  `80c6b0c4912a4ca5…` h40 `9f9e04710ff4e18c…`; `KQ2` 2.176
  `62b17ac8049a982e…` h57 `90f7d02648af2c98…`; `SQ2` 2.202
  `557215fbbf431193…` h57 `4b3b5915cf53b938…`; `PQ` 2.310
  `72ddbb3ecda804b8…`, `GR` 2.316 `7bfa2f36616923a4…` and `MH2` 2.333
  `5ce3b163bd32ee02…` share h57 `6895a48299a9da74…`): with either label
  non-null the window's text rows gain 3 (`2.082` h40+0x286, `2.176`/`2.202`
  h57+0x2c8, `2.31x` h57+0x2d0). The gadget routine (`2.082`
  h40+0x4b8..0x5f0, `2.176`/`2.202` h57+0x51c..0x692, `2.31x`
  h57+0x524..0x69a) sets, for each of two static 44-byte `Gadget` structs,
  `Height = fontHeight + 4`, `Width = strlen(label) × fontWidth + 8`,
  `TopEdge = windowBottom − 5 − Height`, and `LeftEdge = windowLeft + 10`
  for the first label and `windowRight − 10 − Width` for the second (a lone
  label is centred on `2.176+`; `2.082` has no centring branch). The font
  words are 8×8 in every build (`2.082` `$9f8c`/`$9f8e`, `2.176`
  `$9e14`/`$9e16`, `2.202` `$9e48`/`$9e4a`, `2.310` `$a540`/`$a542`, `2.316`
  `$a674`/`$a676`, `2.333` `$a640`/`$a642`), so gadgets are 12 px high and
  `8 × len + 8` wide. Each gadget is drawn with `RectFill` in pen 2 (first)
  or pen 4 (second), then `AddGadget`; its `IntuiText` has FrontPen 15,
  BackPen 2/4, `LeftEdge 4`, `TopEdge 2`; `GadgetType 1` (BOOLGADGET),
  Activation 1 (RELVERIFY). The window variables the routine reads (e.g.
  `2.316` `$810c`/`$810e`/`$8110`/`$8112`, written by h97+0x4e..0xa0) are the
  frame's inclusive bounds `x0 = 8·textLeft − 10`, `y0 = 8·textTop − 6`,
  `x1 = 8·(textLeft + cols) + 10`, `y1 = 8·(textTop + rows) + 4`: the
  `windowFrameGeometry: "amiga"` overlay. With no label the routine adds one
  gadget covering the whole window (`2.316` h57+0x4b2..0x4f0; not modelled:
  the engine's print windows take Enter/Escape only). Engine:
  `amigaConfirmText` adds the three rows, `confirmGadgetAt` hit-tests the two
  rectangles (`top = y1 − 17`, 12 rows; the first from `x0 + 10`, the second
  ending at `x1 − 11`) and answers Enter for the first and Escape for the
  second, and draws each rectangle's fill in the window overlay
  (`WindowOverlay.gadgets`, restamped on restore and replay) in pen 2 and
  pen 4 with the label cells in pen 15 on that pen. Divergence (cell
  surface): the engine writes the labels as 8 px cells on the window's last
  text row, starting at the first text column and ending at the last, which
  is 3 px below and 4 px beside the original glyphs at `(LeftEdge + 4,
TopEdge + 2)`; the cell row hanging below the fill is painted white, so the
  visible fill equals the rectangle.
- **F-OPCORE-04-adjacent (fact; engine matches).** `ResetAll` tail (PC: `2.001`
  `0x106d..0x10fe`, `2.089` `0x0ed6..0x1002`, `2.230` `0x0e50..0x0f57`, `2.272`
  `0x0e7c..0x0f85`, `2.411` `0x0f6a..0x1086`, `2.439` `0x0f70..0x10a4`, `2.440`
  `0x0f78..0x10ac`, `2.903` `0x0fa0..0x10dc`, `2.915`/`2.917`/`2.936`
  `0x0fa5..0x10e1`, `3.002.086` `0x11e2..0x131c`, `3.002.102`/`3.002.107`
  `0x11fa..0x1334`, `3.002.149` `0x11b3..0x12ed`; Amiga: `2.082`
  `h23+0x074..0x1e6`, `2.176`/`2.202` `h33+0x07a..0x206`, `2.310..2.333`
  `h33+0x08e..0x21a`; IIgs `1.014` `initseg+0x0069..0x0255`): in every binary,
  `ResetAll` writes `var[20] := machType` (`0` on PC, `5` on Amiga, `7` on
  IIgs), `Set(f5)`, `userCtrl := 1`, `picNo := 0`, `blocking := 0`, and (`2.439+`
  PC) `var[26] := monType`, `var[24] := 41`, `var[22] := 1` (PC) else `3 +
Set(f11)` (PC `2.230..2.411` set `v22 = 3` and `f11 = 1` unconditionally;
  `2.272+` and Amiga set `v24 = 41`, IIgs sets `v24 = 40`; `2.411+` PC and
  `2.176+` Amiga set `v26 = 3`). Reached from the accepted restart path across
  all twenty profiles, so logic 0 sees `f5 = 1` after restart as well as after
  startup. No var slot is set to 255. Engine: `applyResetAllDefaults` writes the
  exact per-profile `[v8, v20, v22, v24, v26, f5, f11]` tuple at construction
  and on accepted restart (with `soundDevice === 0` overriding `v22 = 1` and
  `f11 = 0` on PC `2.439+` where `computerType == 0` branches).

**Correction.** The audit narrative above reports the accepted restart path
as setting f6 and lists f5 only among the startup writes; that reading
stopped before the ResetAll tail. The disassembly behind
F-OPCORE-04-adjacent shows ResetAll executes `Set(f5)` on the accepted
restart path across all twenty profiles (including kq3 2.936 0x0FA5, mh1
3.002.107 0x11FA, gr1 3.002.149 0x11B3), so logic 0 observes f5=1 after
restart as well as after startup. The engine, which sets f5 on restart,
matches the original.

### Game signature across restore

**Fact (GR1 3.002.149, static disassembly).** Input `gr1` under
[Verified inputs](#verified-inputs); its data segment comes from `AGIDATA.OVL`
(`914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804`).

| Routine        | Offset | Behavior                                                                                                                                |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `set.game.id`  | 0x108c | copies the message into DS0x0002, at most 7 bytes including its NUL, then 0x5ede compares it with the built-in id and exits on mismatch |
| save file name | 0x5f01 | formats `"%s%s%ssg.%d"` (DS0x1164) from directory, separator, DS0x0002 and slot                                                         |
| slot candidate | 0x8ee4 | reads the 31-byte description, skips the block length, reads 7 bytes and compares them with DS0x0002 as NUL-terminated strings (0x50b0) |
| selector scan  | 0x8b2c | save (0x73) shows all 12 slots, a rejected one blank; restore lists only accepted slots, else "There are no games to restore"           |
| restore core   | 0x2856 | reads block 1 to DS0x0002 (see [the audit](#original-save-and-restart-audit)), the signature area included                              |

So a successful restore replaces the running signature with the file's, and a
file carrying another signature is neither listed for restore nor, since its
name carries that other signature, overwritten by a save. A game sets the
signature only when it runs `set.game.id`: KQ1's logic 0 does so only while v0
is 0, on its boot pass (game bytecode), so after a restore the file is its only
source.

**Inference.** The other PC profiles share this: the spec gives every profile
the same block-1 signature area and candidate check, and the Amiga and IIgs
readers restore the region `set.game.id` writes
([Save image](#save-image-fact),
[Bounds, objects and the save image](#bounds-objects-and-the-save-image-fact)).

**Engine contract.** `applyRestore` reinstates the signature from the image's
first seven block-1 bytes, up to the first NUL, for `restore.game` and host
resumes alike; the engine selector keeps the strict filter. It reads the
signature from the block that carries it: block 1 on PC and Amiga, block 2 on
the Apple IIgs, whose image holds the 0x38-byte ~globals lead block first
([Bounds, objects and the save image](#bounds-objects-and-the-save-image-fact)),
so an IIgs game lists its own saves and no PC image. The engine compares
all seven bytes where the original stops at the NUL; the two agree on every
image the engine writes, since it zero-pads the area. App storage keys saves by
game and slot, not by the signature-stemmed name, so a save written under a
wrong signature replaces the slot the original would have left alone. Images a
resume wrote before this fix carry an all-zero signature: the game's own
selector does not list them, as the original would not, and an autosave such a
session wrote resumes unsigned until a restart runs the game's `set.game.id`
again.

**Tests:** `test/autosave.test.ts` (hand-computed signature bytes through a host
resume), `test/kq1.test.ts` (KQ1 slots across a resume, fixture-gated) and
`app/test/worker-save-signature.test.ts` (the worker boot resume and selector).

### 3-002-107-is-3-002-102

Interpreter build 3.002.107 behaves as 3.002.102; profile detection maps the 3.002.107 version
string to the 3.002.102 profile. Similarly 2.903 and 2.915 select 2.917 and 2.439 selects 2.440.

Manhunter (3.002.107) runs its full first day on the 3.002.102 profile, and Police Quest I (2.903)
runs to completion (254 points) on the 2.917 profile.

**Specification:** version_profiles.md, per-profile paragraphs.

**Evidence:**

- The builds behave identically on every verified behavior in this file (wherever this file lists
  3.002.102/3.002.107 offsets, they are the same routine in both). The two executables differ in
  length (40,898 and 40,962 bytes), and their overlay load bases differ (InsertObj is reached
  through `0xa386` and `0xa3c6`); they were not compared byte for byte in this pass.
- Full binary comparison of `2.903` (`start.exe` sha256
  `db97accc32e48bac0c759a6364f48790830c90f14a1486be53d1f0b7899730a7`, `AGIDATA.OVL` sha256
  `df46a3f13c360045b2d355e97bfad6cb6e1df77ee614fed7b4b1f89778425db3`), `2.915` (`AGI` sha256
  `6ee9d44b87e11dd3dba847468902932ab53ed08e714e349dc3679de544fc4c2f`, `AGIDATA.OVL` sha256
  `067bf5c9dcee550b5e9c6d5d16046048c9f53a0d68be6e22a64580d68fe7d2e3`), and `2.917` (`AGI`
  descrambled sha256 `bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04`,
  `AGIDATA.OVL` sha256 `f7ca256c1c0ab12509d695baabdd44a3c5e72a570b08118d3ead995a47f4c383`):
  `AGIDATA.OVL` bytes `0x0000..0x0ace` are identical apart from handler pointers: the 174
  action entries (4-byte entries from `0x061d`, pointer first; action `0xad` at `0x08d1` points
  to `0x5f54` / `0x5f53` / `0x5f67`) and the 19 condition entries (pointers at `0x08f5 + 4n`);
  `0x0acf` is the last digit of the version string. A diff of the three executables'
  disassembly with immediates normalized finds code differences only at the four sites below;
  every other differing byte is an in-code switch jump table (`jmp word near [cs:bx+…]`) whose
  absolute targets shift with the code, or a data island. The differences are:
  (1) the command-line tail check at `0x00c0..0x00d5` (+5 bytes in `2.915`/`2.917`),
  (2) DOS volume-handle closing `CloseAllVols` (`0x30cf` / `0x30d4` / `0x30d6`) called from
  `NewRoom` in `2.917` (`0x181f: call 0x30d6`, +3 bytes),
  (3) DOS startup video/sound adapter detection (`0x4193` vs `0x4198`/`0x419a`, −6 bytes, and
  `0x5589..0x559b`, +18 bytes in `2.917`), and
  (4) the embedded default game ID string (`"PQ\0"` at `0x5a91`, `"MG\0"` at `0x5a90`, `"KQ1\0"`
  at `0x5aa4`, +1 byte) and the `" or the disk is write-protected"` save-error string at
  `AGIDATA.OVL+0x0df6` (+34 = `0x22` bytes, shifting later DS globals by `+0x22`). None of these
  affect observable AGI engine behavior.

**Tests:** [profile.test.ts](../test/profile.test.ts), [games-profile.test.ts](../test/games-profile.test.ts), [mh1.test.ts](../test/mh1.test.ts).

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
  `positionActionOrder: "place-when-drawn"` (`0x511c`); `statusLineFormat: "booter-2.001"`
  (`0x2e2e`, `DS+0x0aa9`: `"Score:%d  "` at col 1, omitting `of %d`, and `"Sound:%s"` with
  `"on "` / `"off"` at col 30); `windowFrameGeometry: "pc-2.001"` (`OpenWndw` `0x4de6` and `EGA_GRAF.OVL` `DrawWndw`
  `0x0107..0x017f`, with `winBot = 19` at `DS+0x0c31` compared against `0x12 = 18` lines at
  `0x1b87`/`0x1be8`, inclusive fill `x in [8*col - 10, 8*(col + cols) + 9]`,
  `y in [8*row - 5, 8*(row + rows) + 4]`, and 2×1 red bars inset `(2, 1)` px);
  `preLogicDirectionMirror: false` (`0x013c..0x0159`); `defaultScriptBufferPairs: 50` and
  `scriptSizeResetsSequence: true` (`0x685c`); `keyByteStoredBeforeEdit: true` (`0x31f9`);
  `keypadWordsNormalized: true` (`0x33cc`); `modalDismissalKeys: "enter-escape"` (`0x41ec`);
  `inventoryListEndsOnAnyEvent: true` (`0x30b4`); `originalTextWindows: true` (`0x1ee9`);
  `parserStopsAtTenthWord: true` (`0x0767`); `originalInputCapacity: true` and
  `inputLineEditCap: "early-35"` (`0x3376`, fixed cap `0x23 = 35`);
  `originalRestartRestore: true` and `restoreRewritesMachineState: false`
  (`0x2176`, `0x21e8`); and
  `soundStopsBeforeFault: true` (`0x4943`); the game's logic bytecode decodes completely within
  the earliest operand grammar.
- Earlier 2.089-family baseline: pre-existing profile fields not re-probed in this audit (exit operand
  count, string slots, key-map capacity, save block layout and block count) retain the earliest
  documented (2.089-family) value.

**Evidence:** the authorized booter disk image; all 204 indexed resources extract byte-identically to
an independent probe of the same image.

**Tests:** [booter.test.ts](../test/booter.test.ts).

### PC booter inventory file

The observed 2.001 OBJECT file is u16le item-table size followed immediately by three-byte
(nameOffset u16le, location u8) entries and the name pool: 179 bytes = 2 + 59 × 3. There is no
maximum-drawable-object-index byte in the header.

**Disassembly evidence:** load-module offset 0x10aa..0x10b3 loads the OBJECT resource:

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

**Tests:** [inventory-file.test.ts](../test/inventory-file.test.ts).

### PC booter action 0x8f (max.drawn.objects)

In AGI 2.001, action dispatch is bounded at 0x90 (144 actions, load-module offset 0x025e: `cmp al, 0x90`).
Action 0x8f is NOT `set.game.id` (which was introduced in later AGI 2.089+); in 2.001 it is `max.drawn.objects`.

**Disassembly evidence:** action dispatch table at DGROUP offset 0x2e5 (stored in `AGIDATA.OVL` offset 0x2e5)
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

The shipped 2.001 boot logic (Logic 28) executes `0x8f 0x19` to allocate 25 animated objects. Read
with the 2.936 opcode mapping, 0x8f becomes `set.game.id` and tries to look up message 25 in a logic
defining only 6 messages. The native handler never accesses messages and never aborts. Under the 2.001
profile, opcode 0x8f does not look up a message.

**Tests:** [booter.test.ts](../test/booter.test.ts).

### PC booter sound rows

A 2.001 sound payload (sounds 1..26) is a row period byte followed by a stream of rows: raw SN76489
register writes terminated by a zero byte, one row per `period` timer ticks; an empty row (two adjacent
terminators) writes nothing in its slot. Playback completes on the tick after the last row and silences the chip.

**Row period (fact; decoded executable SHA-256 `424da51a6c161cca8c7dfb9fd78e94b89a1d5301640c845999b54128d1bcd2dd`).**
The start routine at `0x7408..0x746a` stores the payload bounds in `[0x122a]` / `[0x122c]`, reads the
first byte (`mov al,[di]` at `0x7422`, after `inc [0x122a]` at `0x741e`) into `[0x122e]` and zeroes the
countdown `[0x1230]`. The cursor therefore starts one byte in: the period byte is never written to the
chip or the speaker. On device 0 (speaker) a zero period branches to cleanup `0x4b96` at `0x743d`, which returns
early because the sound is inactive (see the speaker entry's recovery note); with a nonzero device (chip) it activates normally. Each tick the reader
(`0x746b`) first compares the cursor with the end (`0x7473..0x747c`, cleanup on exhaustion), then
`dec [0x1230]` and returns while the result is positive (`jng` at `0x7486`); otherwise it reloads
`[0x1230]` from `[0x122e]` (`0x748b`) and consumes one row. The countdown starts at zero, so row 0 plays
on tick 1 and later rows every `period` ticks; a chip-path period of zero decrements to -1 and plays
every tick like period 1. Exhaustion is seen on the next tick regardless of the countdown.
Hand-computed streams in
[sound-register-fidelity.test.ts](../test/sound-register-fidelity.test.ts) failed before the fix.
Earlier hosts wrote the period byte to the chip as a stray register byte.

**Completion (fact, both devices).** The row loop ends at `0x7556` (`jmp` from the exhaustion test
at `0x7494..0x749a`, the zero terminator at `0x74a1..0x74a6`, or a finished device-0 selector), which
only does `inc [0x122a]` and returns: it never calls cleanup. Cleanup `0x4b96` is reached only from
the entry test at `0x7473..0x747c`, on a later tick, before the countdown. It clears the active word
`[0x0e74]` (`0x4ba2`), sets the completion flag through `0x6aba` with the stored index `[0x0e80]`
(`0x4ba8..0x4bac`) and then runs `0x7560`: on a chip device (`[0x0d42]` nonzero, `0x7565`) that
writes `9f bf df ff` straight to port `0xc0` (`0x7577..0x75ac`, not flag-9 gated). The chip therefore
completes one tick after its final row, like the speaker, even when the final row has no terminator
(the cursor then ends one past the end). Earlier hosts completed the chip path on the final row's
tick. A 2.001 sound of `n` rows with period `p` completes on tick `2 + (n - 1) * p`.
The addresses come from static disassembly of the decoded executable; no emulator run covers the
chip device.

#### Booter sound verdict

- **F-SOUND-01 (fact; engine matches the f9 gate; tick delivery
  diverges).** Booter f9 gate (2.001, ddp decoded
  `424da51a…`; the row-stream offsets are owned by
  [PC booter sound rows](#pc-booter-sound-rows)): flag 9 is tested inside the
  per-write chip routine (0x75BB `call flagGetter` → `jz → ret`), so with f9
  clear every chip write is skipped — the suppression writes nothing, so it
  does not silence the chip: the chip holds its last-programmed state while
  the row cursor and countdown keep advancing per INT 1Ch tick
  (0x74B0/0x7482), and the done flag is set only at payload exhaustion
  (0x747C → 0x4B96, SetFlag via the stored index DS:0xE80). The exhaustion
  silence (0x4B96 → 0x7560) writes 9F BF DF FF straight to port 0xC0 on the
  Tandy path — not f9-gated — but routes through the gated writer on the
  PC-speaker path, so there it is suppressed too while f9 is clear. The
  engine now matches the gate: with f9 clear the row player suppresses the
  chip writes but keeps the row cursor and countdown advancing, and the done
  flag fires only at payload exhaustion — no stop on the first disabled tick.
  The gate is scoped to the booter 2.001 row player; other families' disabled
  stop is unchanged. Tick delivery now matches too: the rows and the clock run
  on the BIOS INT 1Ch rate of 18.2065 Hz, since the booter never reprograms PIT
  channel 0 ([PC booter clock](#pc-booter-clock)).
  (Incidental: the booter writer carries the early family's Tandy +3
  attenuation rule — `(b & 0x90) == 0x90 && nibble < 8` at 0x75DA, all four
  attenuation latches — see the early-family F-SOUND-02 entry.)

### PC booter clock

The 2.001 booter (decoded executable SHA-256
`424da51a6c161cca8c7dfb9fd78e94b89a1d5301640c845999b54128d1bcd2dd`) never reprograms PIT
channel 0: it has no `out 0x40`, and its only port `0x43` writes select the speaker's
channel 2. Fact: InitTimer (`0x4bba`) hooks INT 1Ch with the handler at `0x4c1d`, which calls
`0x76d7` and from there TimerInt (`0x73c5`) on every BIOS tick, 1,193,182 / 65,536 =
18.2065 Hz (inference: the BIOS default rate, since nothing changes it). Per tick, TimerInt:

1. polls input (`call 0x3f6f`);
2. returns while the pause word `DS:0x2e3` is set (`0x73cd`), so pause stops everything below;
3. adds 1 to the 32-bit tick count `DS:0x12f` (`0x73d4`);
4. adds 1 to the pacing counter `DS:0x2df` (`0x73de`);
5. adds 1 to `DS:0x1228` and, at 18, clears it and calls UpdateClock (`0x5626`);
6. runs the row-sound player (`0x746b`) while a sound plays (`0x7401`).

UpdateClock recomputes the clock from the tick count T rather than counting seconds:
`s = floor(((T * 10) mod 2^32) / 182)`, then v11 = `s mod 60`, v12 = `(s / 60) mod 60`,
v13 = `(s / 3600) mod 24` and v14 = `(s / 86400) mod 256` (`0x562e..0x5668`). So one game second
is 18.2 ticks; v11 changes once per 18 ticks and holds one value for two refreshes once every
91 refreshes; script writes to v11..v14 last until the next refresh. The pacing wait
(`0x0111..0x011f`) admits a pass once the counter reaches v10 and clears it, counting 54.9 ms
ticks. Only the pause action sets the pause word, and it stops the sound first; the save and
restore selectors and message windows leave it clear. Restart (`0x21c9`) zeroes the tick
count; the save block `DS+6..0x2de` (see [Booter 2.001](#booter-2001)) includes it, so a
restore brings the saved clock back, while `DS:0x1228` lies outside the block.

The engine selects this cadence with `frameTiming: "booter-int1c"`: sound, pacing and the clock
run on 54.925 ms ticks, the clock is rewritten every 18 ticks from the saved tick count, and only
pause freezes it. The tests in [original-scheduler.test.ts](../test/original-scheduler.test.ts)
and [worker-original-scheduler.test.ts](../app/test/worker-original-scheduler.test.ts) failed
before the change. Superseded: this entry previously concluded that the engine's row player
treats byte 0 as row data and that a stray first write remains. [PC booter sound
rows](#pc-booter-sound-rows) records the correction: the start routine reads payload byte 0 as
the row period (`mov al,[di]` at `0x7422`), the cursor starts one byte in, and the period byte
is never written to the chip or the speaker.

### Original directory and resource loading

Static disassembly of KQ1 2.917, SQ2 2.936 and the KQ4 3.002.086 code body
(body offsets); shipped directory bytes cross-checked against the game files.

- **F-LOAD-02 (fact; malformed-input/memory-only divergence).** Directory
  bounds (2.917 kq1 / 2.936 sq2, GetSeg 0x2E56; 3.002.086 kq4 body 0x311B): no
  offset-vs-volume-size validation at directory load (InitDir 0x4305) or
  resource load; an out-of-bounds entry lseeks past EOF, the short read enters
  DiskError ("Press ENTER to try again." 0x401D) and MustGet (0x2E32) retries
  until the user aborts to Quit. kq1 SNDDIR[34..37] and sq2
  LOGDIR[141]/PICDIR[147] ship such entries; shipped bytecode never loads them.
  This behavior only arises when loading an out-of-bounds directory entry or
  experiencing a short disk read (malformed resource / I/O fault).
- **F-LOAD-03 (fact; malformed-input/memory-only divergence).** Record header
  validation (2.917/2.936 GetSeg 0x2F3A; 3.002.086 body 0x320E): bad 0x12 0x34
  magic or a volume-byte mismatch (v2 full-byte; v3 low nibble when metadata
  0x80 set) is not fatal — CloseAllVols, segErr=1, WrongVol ("That is the wrong
  disk." / "Please insert disk %d") and retry via OpenAllVols; Quit only on
  abort. Short/truncated reads go to DiskError's ENTER-to-retry prompt; a
  missing VOL (open returns -1 silently) takes the insert-disk prompt. This
  behavior only arises on corrupt record headers, truncated volume files or
  missing floppy volumes (malformed container / disk I/O fault).
- **F-LOAD-08 (fact; engine matches).** Absent-resource load (2.917/2.936
  filter 0x434E; 3.002.086 body 0x476C): directory absence is volume nibble
  0xF (v2) or exact FF FF FF (v3), tested in the LogSeg/ViewSeg/PicSeg/SndSeg
  helpers before any volume I/O; an absent load prints "%s %d not found" with
  the kind name and Quits the interpreter — never the insert-disk prompt,
  never a silent null.
- **F-LOAD-06 (fact; malformed-input/memory-only divergence).** WORDS.TOK
  (2.917/2.936 load 0xF6F, Match 0x1A6B; 3.002.086 load body 0x11AE, Match body
  0x1D8F): the file is LoadFile'd raw and section offsets are used as-is — no
  validation of ordering or bounds; offset 0 means empty section (unknown
  word). The per-word scan is linear and overwrites the result on every full
  match, so a duplicated word resolves to its last entry in the section. Any
  difference from the engine's dictionary loader only arises on out-of-bounds
  section offsets or malformed duplicate entries in `WORDS.TOK`.

### Original input, menu and modal handling

Static disassembly across all twenty shipped interpreter binaries (PC
`2.001..3.002.149`, Amiga `2.082..2.333`, and Apple IIgs `1.014`); event-queue
layout, key translation tables, and hook tables read from the hash-pinned code
and data segments.

- **F-IN-01 (fact; engine differs on PC `2.001..2.272`, open).**
  Direction-event toggle. `v6` is `DS:0x15` on `2.001` and `DS:0x0f` on
  `2.089` and later; `DS:0x0c` is `v3`. No PC build up to `2.272` compares a
  direction event against `v6`:
  - **PC `2.001`:** the type-2 case (`0x322d`) only stores the value
    (`mov [0x145],ax`). The toggle happens earlier, in MapKey
    (`0x417e..0x419c`), which compares against `[0x137]` when `[0xe26] != 0`.
    The main cycle (`0x142..0x157`) sets `v6 := [0x145]` while the player has
    control, and otherwise copies ego's direction byte (`rec+0x21`) into `v6`.
  - **PC `2.089`** (`0x305e`) and **`2.230`** (`0x2fa4`): the input phase
    handles four event types. Keyboard directions arrive as type 4 (posted at
    `2.089` `0x3f12`) and toggle against the word `[0x131]`. Type 2 (joystick)
    stores its value in `[0x13f]` with no compare. The main cycle copies
    `[0x13f]` into `v6` while the player has control (`0xec..0x101`). Neither
    build clears ego's motion.
  - **PC `2.272`** (`0x3072`): compares against the shadow word `[0x13f]`,
    then, while the player has control, clears ego's motion
    (`mov byte [di+0x22],0`).
  - Consequence: on `2.001..2.272`, a script's write to `v6` is overwritten
    every cycle while the player has control and never feeds the toggle.
  - **PC `2.411..3.002.149`** (`2.411` `0x34fc`, `2.936` `0x35fa`,
    `3.002.149` `0x3911`), **Amiga `2.082..2.333`** (`2.082` `h63+0x70`,
    `2.176..2.333` `h85+0x76`), and **IIgs `1.014`** (`seg2+0x1685`): compare
    against the ego record's direction field (`[bx+0x21]` on PC, `+0x36` on
    Amiga/IIgs) — equal: `v6 := 0`, else `v6 := value` — and, while the player
    has control, clear ego's motion (`+0x22` on PC). Because the cycle-tail
    mirror writes `v6` into ego's direction at the end of every logic pass, the
    two are equal at the start of every input phase; they differ only if two or
    more direction events arrive within one cycle, which no shipped game
    depends on.
    Engine: keeps `v6` as the toggle operand on every profile and does not model
    the `2.001..2.272` shadow word. It omits the motion clear on
    `2.001..2.230` and clears ego's motion under player control on `2.272` and
    later, Amiga and IIgs. The `2.001..2.272` shadow-word behavior is an open
    deviation. The catalogued games select `2.411` or later by default; the
    `2.089` SQ1 release and Donald Duck's Playground under `2.272` assign `v6`
    from room logic (SQ1 logics 20, 24, 36, 37 and 70; DDP logics 15 and
    20..24), and whether those writes happen while the player has control has
    not been checked.
- **F-IN-02 (fact; engine matches).** Input-phase v19 order (PC input phase:
  2.001 0x32de, 2.089 0x32a8, 2.230 0x3207, 2.272 0x3295, 2.411 0x34ac, 2.440
  0x34ba, 2.903 0x35a6, 2.917/2.936 0x35ad, 3.002.086 0x394a,
  3.002.102/3.002.107 0x3960, 3.002.149 0x38fb; Amiga: 2.082 h63+0x8c,
  2.176..2.333 h85+0x92; IIgs 1.014 seg3+0x0eb5): in every shipped binary, the
  type-1 case stores the event's low byte into v19 unconditionally and FIRST —
  before the input-acceptance gate and before EditLine consumes
  Enter/Backspace/printables (e.g. PQ1 2.903 `AGI` `db97accc…` — `START.EXE` is
  the 6,160-byte launcher stub — input phase 0x35A6-0x35C9: `8B 44 02 mov
ax,[si+2]`; `A2 1C 00 mov [0x1c],al`; `83 3E D3 05 00 cmp word [0x5d3],0`;
  `74 DB jz`; `FF 74 02 push word [si+2]`; `E8 85 00 call 0x364b`; Amiga:
  `move.w 2(a0),d0; move.b d0,(v19)` before `tst.l (inputAccepted)`; IIgs:
  `lda $02,s; sep #$20; sta $0302f1` before `lda $0131; beq`). Editing keys
  therefore reach v19 on every profile. Engine: the key byte lands in v19
  before the acceptance gate and before the line editor consumes it across all
  twenty profiles (field `keyByteStoredBeforeEdit`).
- **F-IN-03 (fact; engine matches).** have.key (3.002.102 demopac4 0x0C13 /
  3.002.107 mh1 0x0C13 / 2.936 kq3 0x09BE): truth test and v19 store are on
  the LOW byte (`test al,al`). Extended words (F1=0x3B00) have AL=0 → false,
  v19 untouched. No blocking: the drain loop exits on queue-empty or
  GetKey≠−1.
- **F-IN-04 (fact; engine matches).** Button-word normalization (`ButtonToChar`:
  PC `2.001` `0x40c5`, `2.089` `0x3ea6`, `2.230` `0x3e2a`, `2.272` `0x3e88`,
  `2.411` `0x44fe`, `2.440` `0x4530`, `2.903` `0x4633`, `2.917`/`2.936`
  `0x4634`, `3.002.086` `0x4a62`, `3.002.102`/`3.002.107` `0x4a78`, `3.002.149`
  `0x488f`, called from `GetKey` at `0x4802`; Amiga mapping `2.082`
  `h76+0x28e..0x2ae`, `2.176..2.333` `h103+0x2a4..0x2c4`; IIgs `1.014`
  `eventseg+0x351..0x39d`): across all twenty shipped binaries, the event queue
  stores full 16-bit type+value words (`PostEvent` 4-byte stride, 20 slots).
  `ButtonToChar` runs inside `GetKey` / `WaitKey` — so `have.key`,
  `get.string`/`get.num` (`WaitChar`), and all `ChkAcAb` modals normalize — plus
  the inventory, menu, and confirmation handlers:
  - **PC (`2.001..3.002.149`) and Amiga (`2.082..2.333`):** `0x0101` and
    `0x0301` map to `0x0d` (`CR`), and `0x0201` and `0x0401` map to `0x1b`
    (`ESC`). In `GetUserInput` (the ordinary input phase; `3.002.149`
    `0x47b1`), `0x0101..0x0401` are matched against `keyMap`
    (`set.key(1, 1..4, c)`), and a mapped word becomes a type-3 event with no
    rewrite to `CR`/`ESC`. Nearly every shipped game binds these four words
    with `set.key`, so they are reachable input.
  - **Apple IIgs (`1.014`):** `ButtonToChar` (`eventseg+0x351..0x39d`) maps all
    four words `0x0101`, `0x0201`, `0x0301`, and `0x0401` to `0x0d` (`CR`).
    MapKey (`eventseg+0x1b0`) turns mapped keys into type-3 events. In the
    type-1 case, `GetUserInput` (`seg2+0x1638..0x1652`) rewrites unmapped
    words `0x0101` and `0x0201` to `0x0d` (`CR`) before storing `v19`
    (`seg2+0x165b`) and calling `EditLine`.
    Engine: `InputQueue.enqueueKey` preserves `0x0101..0x0401` across all twenty
    profiles so `set.key(1, 1..4, c)` bindings fire in `GetUserInput`,
    `normalizeKeyWord` normalizes `0x0101..0x0401` per platform in `pollRawKey`,
    `modalKey`, and `confirmWaitLoop`, and `handleKey` applies the IIgs
    `0x0101`/`0x0201 -> 0x0d` rewrite.
- **F-IN-05 (fact; engine matches).** Menu-interaction gate (3.002.107 mh1 /
  3.002.149 gr1): allow.menu (0xB1) stores its operand to a dedicated word
  (mh1 DS+0x5E3, gr1 DS+0x403), shipped value 1, never re-initialized.
  menu.input (0xA1) tests f14 only and sets the request word; the gate is
  tested at the head of DoMenu (mh1 0x9895), and the gated exit leaves the
  request word set — a gated request pends until allow.menu(1). No
  gr1/mh1/demopac4 logic calls allow.menu. Engine: the gate ships 1, is never
  re-initialized, and a gated menu request stays pending until allow.menu(1).
- **F-IN-07 (fact; engine matches).** `hold.key` (`0xad`), `release.key`
  (`0xb5`) and Keypad 5 across all twenty builds. Each PC action dispatcher
  rejects an opcode above its last action (`cmp al,N; jna`, else error `0x10`):
  `N` is `0x90` on `2.001`, `0x9a` on `2.089` and `2.230`, `0xa0` on `2.272`,
  `0xa9` on `2.411`/`2.440`, `0xad` on `2.917`, `0xaf` on `2.936`, `0xb1` on
  `3.002.086`, and `0xb5` on `3.002.102`/`3.002.107`/`3.002.149` (`2.903` was
  not rechecked).
  - **PC `2.001..2.440`:** `hold.key` and `release.key` are out of range. The
    `2.411`/`2.440` INT 9 hook (`2.411` `0x5e16`) handles only Keypad 5 and
    Ctrl+Alt+arrows, then chains to the BIOS; there is no hold byte and no key
    latch.
  - **PC `2.917`, `2.936` and `3.002.086`:** `hold.key` increments a byte
    (`inc byte`: `2.917` `0x5f67` on `[0x1526]`, `2.936` `0x602f` on
    `[0x1530]`, `3.002.086` `0x6468` on `[0x15a0]`); `release.key` is out of
    range. Each build installs an INT 9 hook that latches scan codes
    `0x47..0x51` (`2.917` `0x5f6e`, `2.936` `0x6036`, `3.002.086` `0x646f`).
    Its break path reads the byte (`2.936` `0x60e6`, `3.002.086` `0x651f`), so
    after `hold.key` releasing a latched key posts `{type: 2, value: 0}`, and
    nothing turns that off.
  - **PC `3.002.102`/`3.002.107`/`3.002.149`:** `hold.key` sets the byte to 1
    and `release.key` sets it to 0 (`3.002.107` `0x6477`/`0x647f`
    `mov byte [0x5e5],1`/`0`; `3.002.149` `0x63a8`/`0x63b0` on `[0x405]`). The
    INT 9 hook (`3.002.107` `0x6487`) windows scan codes `0x47..0x51` and
    consults an 11-byte selected-key mask (`3.002.107` DS+0x159C =
    `FF FF FF 00 FF 00 FF 00 FF FF FF`, the eight direction keys) and an
    11-byte pressed latch (DS+0x15A7). Make: latch set → swallowed repeat; else
    clear all latches and latch this key. Break: latch clear → no event; else
    clear the latch and, when the byte is nonzero, post `{type: 2, value: 0}`.
  - **Amiga `2.082..2.202`:** `hold.key` and `release.key` are out of range.
    `2.082` bounds actions with `cmpi.l #$a1; ble` (table ends at `0xa0`);
    `2.176`/`2.202` use `cmpi.b #$aa; bls` at `h6+0x0a` (table `h5` is `0x3fc`
    bytes, 170 entries `0..0xa9`). An action out of range calls `h94+0`, fatal
    error 16.
  - **Amiga `2.310..2.333`:** the bound is `cmpi.b #$b7`. `0xad` and `0xb5`
    point to the shared stub (`link; move.l 8(a6),d0; unlk; rts`) at `h6+0x64`
    on PQ (`2.310`) and `h6+0x66` on GR and MH2 (`2.316`, `2.333`). Key-up
    codes post nothing: the translator's `cmpi.w #$60,d7; bcc` returns 0 for
    them, so the `RAWKEY` arm (`h106+0x1f6`) has no event to post.
  - **Apple IIgs `1.014`:** `0xad` runs `seg3+0xecc` (`inc $0080` at
    `+0xed7`). The dispatcher bound is `sbc #$00b1` (`actionseg+0x33`), so
    `0xb5` is out of range.
  - **Usage:** among the shipped fixtures, `hold.key` appears only in `mh1`,
    `mumg` (`2.917`, logic 0) and `mh2-amiga`; no game calls `release.key`.
  - **Keypad 5 (stop ego):** `2.001`'s key-to-direction tables (DS `0x116d`,
    or DS `0x1191` when `[0xd42] == 2`) have no `0x4c` or `'5'` entry, and its
    INT 9 hook (`0x5832`) handles only Ctrl+Alt+arrows, so Keypad 5 does
    nothing on `2.001`. `2.089` and `2.230` also lack the entry (tables
    `0x125f` and `0x1251`). From `2.272` on, the INT 9 hook reads the scan code
    (`in al,0x60; cmp al,0x4c; and ah,0x0f; jnz`), posts `{type: 2, value: 0}`
    and swallows the key: `2.272` `0x586b`, `2.411` `0x5e16`, `2.936`
    `0x6036`, `3.002.107` `0x6487`, `3.002.149` `0x63b8`. Amiga `2.082..2.333`
    map `RAWKEY` `0x2d` to `0xf500` (`h79`/`h107`), and IIgs `1.014` maps
    `KeyMapPad` `'5'` (`~arrays+0x1019`) to `0xf500`; both post direction 0.
    Engine: `releaseGateAction` is `unavailable` on `2.001..2.440` and
    `amiga-2.082`/`2.176`/`2.202` (an out-of-range action faults), `increment`
    (one byte) on `2.917`, `2.936`, `3.002.086` and IIgs, `set` on
    `3.002.102` and later, and `noop` on `amiga-2.310..2.333`. While the gate is
    nonzero, the host posts the release when a direction key or touch direction
    is released. `hasKeypadStop` ignores Keypad 5 on `2.001`, `2.089` and
    `2.230`.
- **F-IN-08 (fact; engine matches).** Modal acknowledgement keys (PC ChkAcAb:
  2.001 0x41ec, 2.089 0x44b7, 2.230 0x443f, 2.272 0x44ab, 2.411 0x44ca, 2.440
  0x44fc, 2.903 0x45ef, 2.917/2.936 0x45f0, 3.002.086 0x4a1e,
  3.002.102/3.002.107 0x4a34, 3.002.149 0x484b; Amiga ChkAcAb: 2.082 h77+0x84,
  2.176..2.333 h105+0x84; IIgs 1.014 seg2+0x0b79..0x0bbf): across all twenty
  shipped binaries (thirteen PC, six Amiga, and IIgs 1.014), all
  print/show.obj/show.pri/save/restore modals funnel to WaitAcAb → ChkAcAb: CR
  (`0x0d`) → accept(1), ESC (`0x1b`) → abort(0) (after `GetKey`'s
  `ButtonToChar` normalization); every other key and all non-CHAR
  events return `-1` and are ignored — Space does NOT dismiss
  (`modalDismissalKeys: "enter-escape"`). v21≠0 on the print path swaps the bare
  wait for a sysTimer deadline loop (e.g. PQ1 2.903 `AGI` `db97accc…` ChkAcAb
  0x45EF / WaitAcAb 0x4617 / timed wait 0x6062; IIgs 1.014 `seg2+0x2be6` calls
  `WaitAcAb` at `seg2+0x0bc0`). Engine: modals dismiss on Enter/Escape only
  across all twenty profiles (`modalDismissalKeys: "enter-escape"`), with the
  v21 deadline on the print path.
- **F-IN-11 (fact; engine matches).** Pointer acknowledgement. Amiga `2.082`
  left-button handling at `h78+0x25c` (`cmpi.w #$68; cmpi.l #1,h129`) posts
  Enter when the flag `h129+0x0` is set. Its only writer is `text.screen`
  (action `0x6a`, set at `h128+0x0e`, cleared at `h128+0x18a`).
  `show.pri.screen` (action `0x1d`, `h123+0x20a`) swaps the screens, redraws
  and calls WaitAcAb (`h76+0x218`) without setting it, so a click on the
  priority screen is not Enter. `2.176+` omits the branch; there `h180+0x0` is
  written only in text mode (`h179+0x24`/`+0x1d8`), and Intuition menus do not
  raise it. IIgs `1.014` uses its text-mode bit in the click handler
  (`seg3+0xa6f`), including top-row text clicks. A priority display leaves
  that bit clear and does not turn its clicks into Enter. Engine: a click on
  the `amiga-2.082` text screen posts Enter, and no profile turns a click on
  the priority screen into Enter. Window hits and modal gates are detailed
  under [Original click-to-walk](#original-click-to-walk).
- **F-IN-14 (fact; engine matches).** Non-interactive inventory dismiss (PC
  Status: 2.001 0x30b4, 2.089 0x3070, 2.230 0x2fd3, 2.272 0x3061, 2.411 0x3293,
  2.440 0x32a1, 2.903 0x32e2, 2.917/2.936 0x32e9, 3.002.086 0x3680,
  3.002.102/3.002.107 0x3696, 3.002.149 0x3635; Amiga: 2.082 h59+0x154,
  2.176..2.333 h82+0x192; IIgs 1.014 statusseg+0x0206): on every shipped
  binary, the non-interactive inventory screen (always on 2.001, 2.089 and
  amiga-2.082 where `inventorySelector` is false, and when f13 is clear on the
  later builds) ends with a single bare WaitEvent — any queued event (any key
  incl. low-byte-0 words, navigation, controllers, joystick) dismisses it. Only
  the f13-set interactive path normalizes keys and filters CR/ESC/DIR. Engine:
  the acknowledgement-only list closes on any queued event across all twenty
  profiles (`inventoryListEndsOnAnyEvent: true`), while the interactive path
  keeps the CR/ESC/DIR filter.
- **F-IN-15 (fact; engine matches on verified profile `2.936`).** Menu Home/End (2.936 kq3 DoMenu
  0x9517): value 8 loads menuBase (root heading) and value 6 loads
  menuBase->prev (rightmost) UNCONDITIONALLY — disabled edge headings are
  selected and shown. The enabled-skip loop exists only in the left/right
  cases (3/7: `cmp word [si+0xa],0; jz` at 0x94BC/0x9501); item up/down (1/5)
  likewise do not skip disabled items. Engine: gated by
  `profile.menuHomeEndUnconditional` (`true` on `2.936`; other profiles keep
  their previous enabled-heading scan on Home/End until verified).
- **F-IN-16 (fact; native keyboard translation).** The executable hashes are
  pinned in the PC input table and the Amiga/IIgs build sections above.
  - **PC (`2.001..3.002.149`):** BIOS words carry ASCII in the low byte and
    scan in the high byte. PollKey strips the scan byte when ASCII is nonzero
    (`int 16h` with `ah=0`; `test al,al; jz; xor ah,ah`: `2.001` `0x55ad`,
    `2.089` `0x52ab`, `3.002.149` `0x5e02`); PostEvent itself stores both
    words unchanged. Cursor directions become
    type 2, while joystick buttons enter PostEvent directly as type-1 words
    `0x0101..0x0401`. Thus an injected BIOS `0x1e61` binds `set.key(97,0,c)`,
    while a joystick `0x0101` binds `set.key(1,1,c)`.
  - **Amiga:** keyboard translator `2.082` `h78+0x340`, `2.176`/`2.202`
    `h106+0x358`, `2.310..2.333` `h106+0x35a`, ending at `h106+0x43a`, with
    unshifted, shifted and Alt tables in `h79` / `h107`. F1..F10 produce
    `0x3b00..0x4400`; Help produces F1, Alt+Help produces the sound switch
    `0xff00`; Delete produces `0x7f`. Keypad 1..9 produce `0xf100..0xf900`,
    which MapKey converts to directions `6,5,4,7,0,3,8,1,2`. Ctrl uses the
    shifted table minus `0x40`; `2.176+` alone rewrites `X` to `C` first
    (`cmpi.w #$58` → `#$43`), so Ctrl+X gives `0x03`. Alt letters and top-row
    digits use PC scan words. Either Amiga key (qualifier mask `0xc0`) sets
    bit 8 on a nonzero word (`bset #8`), so Amiga+Q is `0x0171`. The `0xff00`
    branch (`h106+0x41a`) switches sound and zeroes the word, so nothing is
    posted. The message pump runs from the tick server `h194+0`
    (`h103+0x32`), so keys are translated during modal waits too. No shipped
    game binds an Amiga-qualified word (`0x01xx` other than
    `0x0101..0x0401`).
  - **IIgs `1.014`:** translator `seg3+0xb95..0xc46`; keypad table
    `~arrays+0x1019`, direction table `~arrays+0xff1`, Alt scan table
    `~arrays+0xef1`, and final translation table `~arrays+0x1041`.
    Keypad-qualified digits produce the same `0xf100..0xf900` words.
    Control letters map to `1..26`; Option+letters/digits produce PC scan
    words, and Option+/ produces the sound switch. Delete (`0x7f`) becomes
    Backspace (`0x08`), and the symbols `! @ # $ % ^ & * ( )` become F1..F10.
    The sound-switch word is consumed by the translator at `seg3+0xc20..0xc39`,
    rather than reaching v19 or the script key map.
    Engine: `translatePlatformKey` applies these translations to physical
    keys. Native text composition remains owned by the browser input; the
    phone key panel uses the same translator for modifier letters and Delete.
    The browser keeps Command shortcuts unless the game binds the resulting
    word.
- **F-IN-17 (fact; engine matches except the PC poll interval, open).**
  Joystick calibration and polling. `init.joy` is action
  `0x8b`. These are static binary findings, not measurements of a modern
  controller's physical calibration.
  - **PC:** InitJoy entry points are `2.001` `0x58cd`, `2.089` `0x585f`,
    `2.230` `0x585a`, `2.272` `0x58f4`, `2.411` `0x5e9f`, `2.440` `0x5ed1`,
    `2.903` `0x6062`, `2.917` `0x6075`, `2.936` `0x613c`, `3.002.086`
    `0x6575`, `3.002.102`/`3.002.107` `0x658d`, `3.002.149` `0x64be`
    (load-module offsets). A missing axis disables polling. `2.001..2.272`
    accept a pressed fire button and cancel on any keyboard key (`2.089`
    `0x58aa..0x58c8`); on `2.001` and `2.089`, when the mode word
    (`[0xd42]`, `[0xe40]`) is 2, InitJoy skips the axis check. `2.411+` wait
    for Enter or Escape through WaitKey → GetKey → ButtonToChar (`2.411`
    `0x44a1` → `0x4468` → `0x44fe`; `3.002.149` `0x64fb..0x6512`), so fire
    buttons count once normalized. The later button poll emits on release, so
    holding fire keeps that calibration window open. Accepted centers give
    thresholds `center - trunc(center/2)` and `center + trunc(center/2)`
    (`idiv` by a code-segment word of 2, `3.002.149` `0x651e..0x6556`). Axis
    changes post direction events, including 0 on returning to center
    (`3.002.149` `0x65a8..0x65bf`, JoyDir `0x66c1..0x673d`). The joystick poll
    waits 9 ticks between samples (`3.002.149` `0x65c3`). Button records hold
    the single and double words (DS `0x1368` = `{0x0101, 0x0301}`, DS `0x1374`
    = `{0x0201, 0x0401}`), posted with PostEvent(1, word) (`3.002.149`
    `0x661d`/`0x666c`). With f8 clear a release posts the single word. With f8
    set, a second release before the deadline posts the double word, and the
    deadline posts the single word only from the waiting state (state 2).
    v15 = 0 fires on the next poll.
  - **PC timer unit for v15** (addresses from `3.002.149`): `2.089..3.002.149`
    set the PIT divisor to `0x4dae` (about 60 Hz; `0x874d`) and chain the BIOS INT 8
    handler every third interrupt (`0x8839..0x884b`). INT 1C (`0x8852`) runs
    `0x8210`, which does `add [0x129],1` and rolls the seconds every 20 ticks
    (`0x8231`). One tick is therefore `3 × 19886 / 1193182` s, about 50.0 ms
    (20 Hz). The fire deadline is `[0x129] + v15` (`0x664c..0x6664`). The
    `2.001` booter leaves the PIT alone and rolls seconds every 18 ticks
    (`0x73ec`); its deadline is `[0x12f] + v15` (`[0x1e]`), in BIOS 18.2 Hz
    ticks.
  - **Amiga:** InitJoy (`2.082` `h108`; `2.176..2.333` `h145`) opens
    `gameport.device` unit 1 once, with `GPCT_ABSJOYSTICK`, up/down triggers
    and unit X/Y deltas; it does not display calibration. Polling is enabled
    at boot (`h33+0x20` → `h103+0` → `h145+0`) with `SETCTYPE` 3 and trigger
    `{3, 0, 1, 1}`. The direction table (`h146+0xe`) is column-major
    `8,7,6 / 1,0,5 / 2,3,4` for `(ie_X,ie_Y)` in `-1..1`. SQ2
    `h145+0x172..0x2d2` posts a changed direction. Its single fire button uses
    the same f8/v15 state machine (`h145+0x2d4..0x3be`) and posts on release:
    `0x0101` at once when f8 is clear or after the timeout when f8 is set, and
    **`0x0401`** on a second release (data words at `h146+0x6/+0x8`). It does
    not have a second joystick fire button. The mouse right-double-click path
    is separate from this joystick state.
  - **IIgs `1.014`:** InitJoy is `main+0x1cff..0x1dc8`. A missing axis
    returns without a prompt. Either fire button or **any keyboard key**
    accepts the center. The two shifts at `main+0x1d8c..0x1db1` derive
    `low = center >> 2` and
    `high = center + (center >> 1) + (center >> 2)`, so odd centers retain
    the original integer rounding. JoyDir posts transitions at
    `main+0x1dc9..0x1dff`; the button reader at `main+0x1e1d..0x1e88`
    debounces held buttons and posts Enter on a press. There is no PC-style
    pair of button-release or double-click event words on this path.
  - Engine: `EngineHost.sampleJoystick` supplies native axis counts for
    PC/IIgs and
    signed digital axes for Amiga. Unit tests assert calibration, thresholds,
    direction changes and platform button words against these rules.
    The browser adapter samples the first connected Gamepad's stick or D-pad,
    mapping normalized axes to counts `round(128 + 127 * axis)` on PC/IIgs.
    Native polling runs on host ticks, independently of game-selected logic
    pacing; the engine does not model the PC 9-tick poll interval (open). The
    fire deadline counts v15 in 50 ms units (the interpreter's 20 Hz tick) on
    PC `2.089` and later, in `65536/1193182` s units on `2.001`, and in the
    selected region's tick on Amiga. Disconnecting or relinquishing
    play ownership cancels held directions and button state without a fire
    release. Browsers reveal a Gamepad only after its first button press, so
    `init.joy` in logic 0 usually finds no host sample on PC and IIgs. The
    original reads a connected stick whenever it polls; the engine therefore
    keeps that `init.joy` pending and brings the first sample online without a
    window, calibrated at the normalized center 128 (an adapter choice: the
    browser has already calibrated its axes). A player who declines with
    Escape keeps the stick off. Optional host checkpoint and recording fields
    retain calibration, the pending state, native deadlines and samples;
    released files omit them unchanged.

### Original window and status-line text

Static disassembly across all twenty shipped interpreter binaries (PC
2.001..3.002.149, Amiga 2.082..2.333, and Apple IIgs 1.014); format strings
read byte-exact from the hash-pinned data segments.

- **F-text-01 (fact; engine matches).** Window word wrap (PC `_Print`: 2.001
  0x1ee9, 2.089 0x1d4d, 2.230 0x1c65, 2.272 0x1d01, 2.411 0x1ea3, 2.440 0x1eb1,
  2.903 0x1f8e, 2.917/2.936 0x1f93, 3.002.086 0x224b, 3.002.102/3.002.107
  0x2260, 3.002.149 0x220c; Amiga: 2.082 h40+0x336, 2.176..2.333 h57+0x466;
  IIgs 1.014 seg2+0x2467): in every binary, word wrap breaks on space only;
  when col ≥ width the last space is overwritten with '\n' (space consumed,
  excluded from maxLength) and all leading spaces of the continuation are
  stripped; no space on the line → '\n' inserted at the width (hard split).
  Escape char is a global (e.g. kq3 DS:0xD0D, default '\\'; show.obj sets '@').
  Engine: wrapLines consumes the break space and strips continuation spaces the
  same way across all twenty profiles (field `originalTextWindows`).
- **F-text-02 (fact; engine matches).** Status line (PC WriteStatus: 2.001
  0x2e2e, 2.089 0x2dee, 2.230 0x3169, 2.272 0x31f7, 2.411 0x33dd, 2.440 0x33eb,
  2.903 0x34b6, 2.917/2.936 0x34bd, 3.002.086 0x385a, 3.002.102/3.002.107
  0x3870, 3.002.149 0x380b; Amiga: 2.082 h62+0x36, 2.176..2.333 h84+0x36; IIgs
  1.014 statusseg+0x07a1): clear the status row to white and `SetTextAtr(0, 15)`,
  followed by one of three profile-selected string layouts (`statusLineFormat`):
  - `"booter-2.001"` on PC 2.001 (`0x2e2e`, `DS+0x0aa9`): col 1
    `printf("Score:%d  ", v3)` (two trailing spaces, omitting `of %d`) and col 30
    `printf("Sound:%s", "on "/"off")`.
  - `"early-2.089"` on PC 2.089 (`0x2dee`, `DS+0x0b59`): col 1
    `printf("Score:%d of %d", v3, v7)` (no trailing spaces) and col 30
    `printf("Sound:%s", "on"/"off")` (unpadded `"on"`).
  - `"common"` on PC 2.230..3.002.149, Amiga 2.082..2.333, and IIgs 1.014:
    col 1 `printf("Score:%d of %d  ", v3, v7)` (no space after the colon, two
    trailing spaces) and col 30 `printf("Sound:%s", "on "/"off")` with `"on "`
    space-padded.
    Engine: the text-surface status line renders each profile's exact format
    (fields `originalTextWindows` and `statusLineFormat`).
- **F-text-03 (fact; engine matches).** Message window (`WindowNoWait` and
  `OpenWndw` across all twenty binaries): interior `SetTextAtr(0, 15)`; the box
  spans `H = 8·rows+10` scanlines (`200`-space) by `W = 4·cols+10` logical X
  units (`160`-space, `2·W = 8·cols+20` pixels at `320×200`), with
  `pos_x = 4·leftCol − 5` (`8·leftCol − 10` screen px) and `bottom_y_rel =
(topRow − picTop + rows)·8 + 4` on PC and Amiga (`+ 5` on IIgs 1.014 at
  `seg2+0x2be2`) (e.g. kq1 2.917 / kq3 2.936 WindowNoWait 0x1E4B: `shl di,1 /
shl di,1 / add di,0xa`; executed under Unicorn on descrambled kq1 `bf53a4f9…`:
  `print("Hi")` with `winRows=1, winCols=2` yields `winDim 0x1212` = 18×18;
  action `0xa9` `close.window` calls `CloseWndw` directly, while `WindowNoWait`'s
  modal path runs `WaitAcAb(); CloseWndw();`). No character-cell border glyphs
  exist in any binary; `OpenWndw` draws a white (`15`) fill plus four solid red
  (`4`) sub-cell bars in one of four profile families (`windowFrameGeometry`):
  - **PC `2.001`** (`OpenWndw` 0x4de6, `EGA_GRAF.OVL` `DrawWndw` 0x0107..0x017f,
    `"pc-2.001"`): `winBot = 19` (`DS+0x0c31` compared against `0x12 = 18` lines
    at 0x1b87/0x1be8); inclusive fill `x in [8·leftCol − 10, 8·(leftCol+cols) + 9]`
    (`w = 8·cols + 20`), `y in [8·topRow − 5, 8·(topRow+rows) + 4]`
    (`h = 8·rows + 10`); 1-scanline top/bottom bars inset 1 scanline (`y0 + 1`
    and `y1 − 1`) and 1-nibble (`2`-px at `320×200`) side bars inset 1 nibble
    (`x0 + 2..x0 + 3` and `x1 − 3..x1 − 2`), spanning `y0 + 1 .. y1 − 1`.
  - **PC `2.089..3.002.149`** (`OpenWndw` at 2.089 0x50eb, 2.230 0x506f, 2.272
    0x510b, 2.411 0x53a7, 2.440 0x53d1, 2.903/2.917 0x5400, 2.936 0x54c8,
    3.002.086 0x58e2, 3.002.102/3.002.107 0x58f1, 3.002.149 0x56f4, `"pc"`):
    `winBot = 20` (19 max lines); identical inclusive fill and 2×1 red bars
    inset `(2, 1)` px (`inc ah / dec al` at kq3 0x54EA/0x54EC).
  - **Amiga `2.082..2.333`** (`OpenWndw` at 2.082 h71+0x0000, 2.176..2.333
    h97+0x0000, `"amiga"`): `winBot = 20`; `graphics.library/RectFill(rp, x0, y0, x1, y1)`
    is inclusive on both endpoints (confirmed by `CloseWndw` at h71+0x0222..0x022c
    passing `width = x1 − x0 + 1 = 8·cols + 21` and `height = y1 − y0 + 1 = 8·rows + 11`),
    yielding inclusive fill `x in [8·leftCol − 10, 8·(leftCol+cols) + 10]` and
    `y in [8·topRow − 6, 8·(topRow+rows) + 4]`, plus `Move`/`Draw` 1-px red
    bars inset `(2, 2)` screen px (`x0 + 2`, `x1 − 2`, `y0 + 2`, `y1 − 2`).
  - **IIgs `1.014`** (`OpenWndw` seg2+0x4a62..0x4b84, `"iigs"`): `winBot = 20`;
    QuickDraw II `_PaintRect` (`#0x5404`, half-open `[left, right) × [top, bottom)`
    with `bottom = 8·(topRow+rows) + 5` and `top = bottom − H = 8·topRow − 5`)
    yields inclusive fill `x in [8·leftCol − 10, 8·(leftCol+cols) + 9]` and
    `y in [8·topRow − 5, 8·(topRow+rows) + 4]`, and `_FrameRect` (`#0x5304`) with
    `_SetPenSize(1, 1)` (`#0x2c04`) after insetting the `Rect` by 2 on all four
    sides (`+0x4b15..+0x4b41`) paints 1-px red bars inset `(2, 2)` screen px
    (`x0 + 2`, `x1 − 2`, `y0 + 2`, `y1 − 2`).
    Engine: `TextSurface` records the active `WindowOverlay` with its write-order
    stamp, and `compositeFrame` renders the exact sub-cell fill and border bars
    for each profile's `windowFrameGeometry` (including `show.obj`), with text
    starting at `(topRow, leftCol)` matching `SetCurPos`.
- **F-text-04 (fact; engine matches).** Window placement (PC WindowNoWait:
  2.001 0x1da2, 2.089 0x1c06, 2.230 0x1b1e, 2.272 0x1bba, 2.411 0x1d5c, 2.440
  0x1d6a, 2.903 0x1e47, 2.917/2.936 0x1E69, 3.002.086 0x2121, 3.002.102/3.002.107
  0x2136, 3.002.149 0x20e2; Amiga: 2.082 h40+0x204, 2.176..2.333 h57+0x246; IIgs
  1.014 seg2+0x2b50): `top = picTop + 1 + ((winBot − 1 − numLines) >> 1)`
  (`winBot = 19` on PC 2.001, `20` on all other nineteen builds), `left = (40 −
maxLength) >> 1` (`shr` = floor; slack non-negative via the verbose gate);
  engine centering matches. `print.at` row/col overrides are stored VERBATIM
  (`picTop` still added to row) with no clamping — off-screen overrides write
  outside the window bounds rather than shifting to fit. Engine: `print.at`
  overrides are stored verbatim with `picTop` added across all twenty profiles
  (field `originalTextWindows`); when a script passes off-screen `print.at`
  coordinates, `writeModalWindow` wraps horizontally past column `39` (`col >=
40` advances `row += 1, col = 0`) and caps vertical advancement at row `24`
  (`row >= 24` stays on row `24`), matching `PutChar` / `SetCurPos`, while the
  saved rectangle is canonicalized so checkpoints validate.
- **F-text-08 (fact; engine matches).** Timed print (2.917 kq1 0x1CE8 / 2.936
  kq3): timeOut = sysTimer + v21*10 (dword, 20 Hz → half-second units);
  busy-wait `while (sysTimer < timeOut && ChkAcAb() == -1)` — tick-quantized
  > = expiry, key closes early; var[21] = 0 after a timed close. The engine's
  > millisecond countdown/epsilon is a re-modeling valid only under exact 20 Hz
  > clock advancement.
- **F-text-10 (fact; engine matches).** Overlong messages (PC WindowNoWait
  verbose gate: 2.001 0x1b87/0x1be8, 2.089 0x1ba9, 2.230 0x1ac1, 2.272 0x1b5d,
  2.411 0x1cff, 2.440 0x1d0d, 2.903 0x1dea, 2.917/2.936 0x1E0C, 3.002.086
  0x20c4, 3.002.102/3.002.107 0x20d9, 3.002.149 0x2085; Amiga: 2.082 h40+0x114,
  2.176..2.333 h57+0x150; IIgs 1.014 seg2+0x2af7): if the formatted message
  exceeds `winBot − 1` lines (`18` lines on PC 2.001 where `winBot = 19` at
  `DS+0x0c31`; `19` lines on PC 2.089..3.002.149, Amiga 2.082..2.333, and IIgs
  1.014 where `winBot = 20`, `cmp #$0013` at `seg2+0x2af7`), WindowNoWait
  truncates the source at 20 chars and substitutes the literal
  `"Message too verbose:\n\n\"%s...\"\n\nPress ESC to continue."`, then
  re-formats; `_Print` also aborts expansion past the line cap. Engine:
  overflow triggers the same 20-char verbose substitution and reformat across
  all twenty profiles (fields `originalTextWindows` and `windowFrameGeometry`).

### Original picture drawing and fill

Static disassembly of the 15 PC executables and six Amiga executables listed under
[add.to.pic verdicts](#addtopic-verdicts). Apple IIgs `1.014` addresses come from
the earlier pass and were not re-verified. PC routine starts (MZ body offsets; `show.pic` and
`show.pri.screen` are the action `0x1a` and `0x1d` entries of each build's `AGIDATA.OVL` table):

| Build         | show.pic | show.pri.screen | clrScreen | plot     | colorFill | relativeDraw | drawline | DrwPicNC loop |
| ------------- | -------- | --------------- | --------- | -------- | --------- | ------------ | -------- | ------------- |
| 2.001         | `0x464c` | `0x6976`        | `0x4c8d`  | `0x4d29` | `0x4d6c`  | `0x5cf2`     | `0x5d7d` | `0x5c13`      |
| 2.089         | `0x43e7` | `0x6901`        | `0x49f5`  | `0x4a91` | `0x4ad4`  | `0x5c8e`     | `0x5d19` | `0x5baf`      |
| 2.230         | `0x436e` | `0x68ba`        | `0x495b`  | `0x49f7` | `0x4a3a`  | `0x5c89`     | `0x5d14` | `0x5baa`      |
| 2.272         | `0x43cc` | `0x6956`        | `0x49c7`  | `0x4a63` | `0x4aa6`  | `0x5d17`     | `0x5da2` | `0x5c38`      |
| 2.411         | `0x4a4c` | `0x6f59`        | `0x5059`  | `0x50fb` | `0x513d`  | `0x62c6`     | `0x6351` | `0x61d8`      |
| 2.439         | `0x4a76` | `0x7076`        | `0x5083`  | `0x5125` | `0x5167`  | `0x63eb`     | `0x646e` | `0x6202`      |
| 2.440         | `0x4a7e` | `0x707e`        | `0x508b`  | `0x512d` | `0x516f`  | `0x63f3`     | `0x6476` | `0x620a`      |
| 2.903         | `0x4b81` | `0x7241`        | `0x518e`  | `0x5230` | `0x5272`  | `0x6584`     | `0x6607` | `0x639b`      |
| 2.915         | `0x4b80` | `0x7240`        | `0x518d`  | `0x522f` | `0x5271`  | `0x6583`     | `0x6606` | `0x639a`      |
| 2.917         | `0x4b82` | `0x7254`        | `0x518f`  | `0x5231` | `0x5273`  | `0x6597`     | `0x661a` | `0x63ae`      |
| 2.936         | `0x4b82` | `0x731b`        | `0x5257`  | `0x52f9` | `0x533b`  | `0x665e`     | `0x66e1` | `0x6475`      |
| 3.002.086     | `0x4fb0` | `0x775a`        | `0x566b`  | `0x570d` | `0x574f`  | `0x6a97`     | `0x6b1a` | `0x68ae`      |
| 3.002.102/107 | `0x4fc6` | `0x7772`        | `0x5673`  | `0x5715` | `0x5757`  | `0x6aaf`     | `0x6b32` | `0x68c6`      |
| 3.002.149     | `0x4ddd` | `0x764f`        | `0x548a`  | `0x5522` | `0x5564`  | `0x69d6`     | `0x6a59` | `0x67ed`      |

The 2.001 handlers come from the booter's two-byte action table; relativeDraw is the `0xf7`
handler entry (`call`, `jc`, store, plot, then `lodsb / cmp al,0xef / ja`). Amiga picture code:
DrwPicNC loop `h102+0x0052` (`2.082`) / `h152` (`2.176..2.333`), clrScreen `h114+0x0018` /
`h152+0x0636` (`2.176`, `2.202`) / `h152+0x0624` (`2.310..2.333`), plot `h114+0x00d2` /
`h152+0x0700` / `h152+0x06ee`, colorFill `h114+0x0110` / `h152+0x073a` / `h152+0x0728`, drawline
`h102+0x0254` / `h152+0x051c` / `h152+0x050a`.

- **F-picture-01 (fact on PC; engine matches).** `show.pic` (action `0x1a`) on `2.001`, `2.089`,
  `2.230` and `2.272` calls BackToScrn and sets `picVisible = 1`, with no flag-15 reset and no
  CloseWindow call (for example `2.089` `0x43ec: call 0x4ce0`, `0x43ef: mov word [0xf21],0x1`).
  On `2.411..3.002.149` it pushes `0xf` and calls Reset, calls CloseWindow with `0`, calls
  BackToScrn and sets `picVisible = 1`, in that order (`2.936` `0x4b87..0x4b9d`). Earlier text
  saying the early builds call CloseWindow was wrong; the engine already closes the window only
  when `showPictureClearsF15` is `true`. The Amiga and IIgs `show.pic` addresses of the earlier
  pass were not re-verified and are removed; the profiles keep `amiga-2.082` `false` and the
  later Amiga builds and `iigs-1.014` `true` from that pass. Engine:
  `profile.showPictureClearsF15` is `false` on `2.001..2.272` and `amiga-2.082`.
- **F-picture-02 (fact on PC and Amiga at the cited entries; engine matches the modeled fill;
  documented divergence on unusual input when deep flood-fill branching exceeds the original CPU
  stack).** colorFill is a 4-connected scanline fill whose pending-line stack is the CPU stack,
  seeded with four `0xffff` words (PC `mov ax,0xffff` and four `push ax`, `2.936` `0x5377..0x537d`)
  and popped until the sentinel, with no stack-pointer bound. On PC the visual channel is tested
  first (`test bh,0x0f`), a fill with visual `15` or, with visual disabled, priority `4` is
  dropped, and the seed byte masked with the active channel must equal `0x4f & mask`
  (`2.936` `0x5344..0x5374`). The vertical bound test against `0xa7` and the Amiga and IIgs
  channel tests are from the earlier pass. The engine uses a heap-allocated work stack and
  completes deep fills that would overflow the original stack.
- **F-picture-04 (fact on PC; engine matches).** `show.pri.screen` (action `0x1d`) on every PC
  build sets `showPri = 1`, calls BackToScrn, waits (`WaitAcAb`), sets `showPri = 0` and calls
  BackToScrn again, with no CloseWindow (`2.936` `0x7320..0x732f`). The Amiga and IIgs addresses
  of the earlier pass were not re-verified (`h177` is an empty data hunk on `2.176`) and are
  removed. Engine: `profile.showPriScreenPreservesWindow` is `true` for every profile.
- **F-picture-09 (fact on PC and Amiga; engine matches).** Picture core:
  - clrScreen stores `0x3480` words (`26,880` bytes) with `rep stosw` on PC
    (`mov cx,0x3480`) and `0x1a40` longwords on Amiga (`move.w #$1a3f,d0` loop); the fill value
    `0x4f4f` (visual `15`, priority `4`) comes from the caller (Amiga `h102+0x001e`
    `move.l #$4f4f4f4f,d1` on `2.082`).
  - plot indexes `y * 160 + x` with shifts and no `x < 160` clamp (PC `2.936` `0x52fe..0x531d`),
    so `x = 160` lands on `(0, y + 1)`.
  - drawline initializes the minor-axis error to `major >> 1`, steps `major` times, and adds
    `dx` and `dy` to the error accumulators. On all 15 PC builds the accumulators are the 8-bit
    `ah`/`al` registers (`add ah,dh` and `add al,dl` in each drawline above; `2.936`
    `0x6741..0x675d`), so a minor-axis error above 255 wraps modulo 256. On all six Amiga builds
    they are 16-bit words (`add.w d6,d0 / cmp.w d4,d0` at `h102+0x02f2`, `h152+0x05d6` on
    `2.176`/`2.202`, `h152+0x05c4` on `2.310..2.333`), exercised by `mh2-amiga` picture 75's
    `(159, 105) → (1, 0)` segment. IIgs `1.014` 16-bit `adc`/`sbc` (`main+0x0de1..0x0ed9`) is
    from the earlier pass.
  - relativeDraw (`0xf7`) decodes sign-magnitude steps in 8-bit arithmetic, clamps `x > 0x9f`
    to `159`, and clamps `y > 0xa7` to `167` on every PC build (`cmp bl,0xa7 / jna / mov bl,0xa7`
    at relativeDraw`+0x3d`, for example `2.001` `0x5d2f`, `2.936` `0x669b`). All six Amiga builds
    clamp `y > 0xa7` to `0x9f` (`159`): `cmpi.b #$a7,d2 / bls.w / move.b #$9f,d2` at
    `h102+0x01dc` (`2.082`), `h152+0x04a4` (`2.176`, `2.202`) and `h152+0x0492`
    (`2.310..2.333`); rows `160..167` pass unchanged. IIgs `1.014` (`main+0x0c66..0x0cf0`,
    clamp to `167`) is from the earlier pass. The engine applied the Amiga clamp to every row
    above `159` until the MAME comparison of SQ2 Amiga picture 2 showed six red cells around
    `(24..26, 157..161)` that the original draws and the engine left black; the regression in
    [picture-profile.test.ts](../test/picture-profile.test.ts) failed before the fix.
  - Picture commands: the DrwPicNC loop reads a byte, stops on `0xff`, skips bytes below `0xf0`
    and above the last command (`sub al,0xf0 / jc` then `cmp al,N / ja` back to the read). `N`
    is `0x8` on `2.001..2.272` (`pictureMaxCommand: 0xf8`, `patternProfile: "none"`) and `0xa`
    on `2.411..3.002.149`. Amiga `2.082` uses `cmpi.b #$8,d0 / bhi` (`h102+0x0068`) and
    `2.176` uses `cmpi.b #$a,d0 / bhi` (`h152+0x006e`). The per-build `0xf9`/`0xfa` brush
    handlers (`"point-2.411"` on `2.411`, `"square-r1"` on `2.439..2.936`, `"center-row"` on
    `3.002.x`) were not re-verified in this pass; Amiga and IIgs brushes are in
    [Original Amiga and IIgs pattern brushes](#original-amiga-and-iigs-pattern-brushes).
- **F-picture-10 (fact on PC and Amiga; malformed-input-only divergence).** The DrwPicNC loop
  has no stream-length register: it reads until a `0xff` byte, skipping bytes outside the command
  range, so a stream without `0xff` reads past the buffer. Every shipped picture resource in the
  game fixtures ends with `0xff`; the engine's clean stop at the end of the resource differs only
  on truncated resources.

### Original shake.screen and picture reveal

Static disassembly; hashes as in [Original scheduler and modal timing](#original-scheduler-and-modal-timing)
(PC), [Amiga interpreter profiles](#amiga-interpreter-profiles) and
[Apple IIgs interpreter (SQ2 1.014)](#apple-iigs-interpreter-sq2-1014). Action `0x6e` takes a
count n. On every platform the handler loops until it is done, so the rest of the pass, the
movers and the animation wait, while the timer interrupt keeps sound and the clock running and
input stays queued for later.

- PC (handler `2.089` `0x6f40`, `2.230` `0x6ef9`, `2.272` `0x6f95`, `2.411` `0x763e`, `2.440`
  `0x7763`, `2.903` `0x7926`, `2.917` `0x7939`, `2.936` `0x7a00`, `3.002.086` `0x7e3f`,
  `3.002.102`/`3.002.107` `0x7e57`, `3.002.149` `0x7d14`): the handler dispatches on the display
  type. The EGA routine (KQ3 `EGA_GRAF.OVL`, called at `0x7a17`) latch-copies the screen into
  page 1 shifted 8 EGA pixels right and 4 lines down (`di = 0x20a1`, 196 rows of 39 bytes), then
  shows page 1 and page 0 alternately for four vertical retraces each, four times per unit:
  32 retraces, 533 ms per unit at 60 Hz (inference from the mode's refresh rate). Page 1's
  uncovered left and top edge is black. CGA, PCjr and Tandy instead nudge the CRTC sync
  registers through the table `01 01 ff 01 01 ff ff ff 00 00`, one 20 Hz tick per step;
  Hercules shifts 8 pixels and 8 lines; MCGA inverts the colours on alternate ticks.
- PC booter 2.001 (handler `0x6f38`, EGA driver `0x790c`): per unit, four copies shifted by
  (8, 4), (-8, -4), (-8, 4) and (8, -4) EGA pixels and lines, each shown until the BIOS tick
  changes, from the table at `DS:0x1294`.
- Amiga (handler `h182+0x0` on `2.176..2.333`, `h131+0x0` on `2.082`): five steps per unit set
  the screen ViewPort's `DxOffset`/`DyOffset` to the saved values plus 10 times the table
  `1, 1, -1, 1, 1, -1, -1, -1, 0, 0`, call MakeScreen and RethinkDisplay, and wait for the timer
  tick to change. On the 320×200 lores screen that is 10 pixels and 10 lines. A count of 0 does
  nothing.
- IIgs (`shakeseg+0x0`): for 5n ticks, it fills colour table 0 with sixteen colours
  `(r * 17) & 0x0fff` from sixteen draws of the game's random-number routine, the one `random`
  uses (`shakeseg+0x003c`), sets it with SetColorTable and waits for the tick to change; then it
  restores the standard table. Nothing moves, and each unit consumes 80 random numbers.
- A count of 0 makes the PC `loop` run 65,536 units (hours); the engine treats it as no shake,
  a divergence on unusual input.

Engine: action `0x6e` opens a shake modal ([shake.ts](../src/runtime/shake.ts)) that the clock
ends: PC steps last 66.7 ms, the others end at timer ticks. The worker posts each step's offset
and IIgs colours, and the player's screen moves its whole frame by that offset inside a black,
clipped screen, or recolours it. Under CGA RGB the engine shakes as EGA does; the CRTC nudge is
not reproduced. Tests:
[shake.test.ts](../test/shake.test.ts) (each failed before the change),
[worker-shake.test.ts](../app/test/worker-shake.test.ts) and
[shake-screen.spec.ts](../app/e2e/shake-screen.spec.ts).

Picture reveal (fact): PC `show.pic` copies the picture bottom to top with no wait or palette
change, and no PC executable or overlay contains a dissolve (no `0x3500` constant). `new.room`
has no screen effect on any platform. The Amiga and IIgs dissolve is in
[Original picture dissolve](#original-picture-dissolve).

### Original picture dissolve

Static disassembly of the six Amiga executables (hashes under
[Amiga interpreter profiles](#amiga-interpreter-profiles); `hN+0x...` are code-hunk offsets with
relocations resolved) and the IIgs `SQ2.SYS16` 1.014 (sha256 `e1a2788f92cb7622…`). MAME 0.289
(a500n with Kickstart 1.3, NTSC; apple2gsr1) is the cross-check.

**When it runs (fact).** `show.pic` tests a longword flag: zero calls the dissolve, nonzero copies
the picture at once (Amiga BltBitMap, IIgs a linear copy at `main+0x15d8`). The draw-picture
routine stores 0 after decoding and the overlay routine stores 1, and nothing else writes the
flag, so every `show.pic` after a `draw.pic` dissolves, a second `show.pic` without a new
`draw.pic` included, and one after `overlay.pic` does not. The flag is zero at load (Amiga BSS,
IIgs `~globals` data). `restore.game` ends in the dissolve without testing the flag, after it has
rebuilt the room's picture and objects. Before the loop both wait while a menu is held (Amiga
`h108+0x8`, IIgs `$008e`).

| Build (game, sha256)                               | `show.pic` → dissolve | Flag: test; `draw.pic` 0; `overlay.pic` 1             | Dissolve             | `restore.game`                                                                    | Rows 0..1 left out                                                                                                                                                            |
| -------------------------------------------------- | --------------------- | ----------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.082 (SQ1, `80c6b0c4…`)                           | `h83+0x286`           | `h84+0x12`: `h83+0x27e`; `h83+0x1b4`; `h83+0x264`     | `h154+0x2c0`         | `h116+0x29a`                                                                      | always: source `+0x50`, screen `+0x190` (10 lines), limit `cmpi.l #$33e0` (`h154+0x340`)                                                                                      |
| 2.176 (KQ2, `62b17ac8…`), 2.202 (SQ2, `557215fb…`) | `h115+0x298`          | `h117+0x12`: `h115+0x290`; `h115+0x1b0`; `h115+0x260` | `h215+0x2e0`         | `h156+0x29a`                                                                      | while the picture top `h181+0x20` (row × 8, written by `configure.screen` at `h179+0x22a`) is nonzero: screen `+0x190`, limit `0x3480 - 0xa0`                                 |
| 2.310 (PQ1, `72ddbb3e…`)                           | `h115+0x298`          | `h117+0x12`: `h115+0x290`; `h115+0x1b0`; `h115+0x260` | `h215+0x300`         | `h156+0x29a`                                                                      | while the picture top is nonzero and the status-enabled longword `h206+0x400` is set; with the status line off the screen offset is `0x140` (8 lines) and all rows are copied |
| 2.316 (GR, `7bfa2f36…`)                            | `h115+0x2aa`          | `h117+0x12`: `h115+0x2a2`; `h115+0x1bc`; `h115+0x272` | `h215+0x300`         | `h156+0x29a`                                                                      | as 2.310                                                                                                                                                                      |
| 2.333 (MH2, `5ce3b163…`)                           | never                 | `h117+0x12`: `h115+0x29a`; `h115+0x1c6`; `h115+0x262` | `h215+0x300`, unused | never                                                                             | –                                                                                                                                                                             |
| IIgs 1.014                                         | `seg2+0x55e8`         | `$1608`: `seg2+0x55e0`; `seg2+0x550f`; `seg2+0x58a3`  | `main+0x0f53`        | `seg2+0x0656` (the rebuild at `seg2+0x3c4`, called once the save blocks are read) | never; it writes all 168 rows from the line table entry for `$b7`                                                                                                             |

2.333 (fact): `show.pic` (`h115+0x292`) and the restore (`h156+0x29a`) first test `h117+0x16`
and copy at once when it is set. Its only writer, the picture module's start-up routine
(`h115+0x0`, called at `h33+0x62`), sets it when `strcmp(*h116+0xa, "blit") == 0`. The pointer
`h116+0xa` has one relocation, to `h116+0x0`, which holds `"blit\0lve\0"`, and no instruction
writes it, so the test is always true and 2.333 never dissolves. Inference: `"lve"` is the tail of
`"dissolve"`, overwritten with `"blit"`.

**Order (fact).** First the top-left corner: the Amiga copies one byte of each of the four
bitplanes (`h215+0x354`), cells 0 and 1 (160 and 161 when rows 0..1 are left out); the IIgs copies
one word (`main+0x0f91`), cell 0. Then, from state 1, `lsr` and `eor #$3500` on carry until the
state is 1 again, copying cell s for each state below the limit (s + 160 when rows 0..1 are left
out). A cell is two picture pixels: on the Amiga one nibble of each plane byte, the high nibble
for even s (`h215+0x388`); on the IIgs one word, the source's colour nibbles doubled into four
screen pixels (`main+0x0fb4`). Cell s is picture row `s / 80`, x `2 * (s mod 80)`. The register
walks all 16,383 nonzero 14-bit states, 13,439 below `0x3480` and 13,279 below `0x33e0`, so each
cell is written once; the Amiga's last state rewrites cell 1, and on the IIgs cell 1 changes
last. The first states are `0x3500` (past the limit), 6784, 3392, 1696, 848, 424, 212, 106, 53.

**Timing (fact and measurement).** Neither loop waits for a frame or a timer or masks
interrupts: it runs at the CPU's speed. The 68000 cycles of the Amiga loop, summed over the
16,383 states from the instruction timings, are 5,084,134 on 2.082 (an immediate compare),
5,259,678 on the later builds with all rows and 5,215,198 with rows 0..1 left out; at
7.159 MHz that is 710, 735 and 728 ms. In MAME the SQ2 title and station-exterior dissolves took
794.4 and 793.9 ms (a line through the furthest register state on screen in each 60 Hz frame,
within 116 states of every frame), about 9% over the bare count; inference: chip-bus contention
and interrupt service. The room 2 dissolve took 827 ms. The IIgs loop is 1,131,955 cycles, 395 ms
at 2.864 MHz before the slow writes to bank `$E1`; MAME measured 448.2 and 447.5 ms.

**During the dissolve (fact).** The Amiga VERTB server and the IIgs heartbeat keep running, so
sound plays and the clock counts; key events wait in the window's message port or the event
queue. A busy flag set for the loop (2.082 `h80+0xc`, 2.176/2.202 `h108+0xc`, 2.31x `h206+0x410`,
IIgs `$0090`) makes the menu handler (Amiga MENUVERIFY at `h106+0x10e`, 2.082 `h78+0x10e`; IIgs
`seg3+0x08fd`) refuse a menu. The IIgs hides the mouse cursor (`$9004`) for the loop. Only
picture rows change: the title bar, status and input lines stay. The loop writes the screen
bitmap directly, so text in the picture band disappears cell by cell (inference from the writes).

Engine: `showPictureReveal` selects the variant per profile. `show.pic` with the flag clear
(`draw.pic` clears it, `overlay.pic` sets it) parks the pass on a dissolve modal
([dissolve.ts](../src/runtime/dissolve.ts)) that the clock ends, like the shake: its length is the
build's cycle count at the rate MAME measured for SQ2 (6,566.6 cycles per ms on NTSC, scaled by
7.09379 / 7.15909 on PAL; 447.9 ms on the IIgs), and the presentation shows each cell from the
new frame once the register has passed it, at a constant rate. The dissolve starts from the frame
composed before the pass's first `draw.pic`, or at `show.pic` without one, and from black before
the first picture of the session. `restore.game` starts
one from the frame before the restore and enters logic 0 when it ends; restores the host makes
(autosave, history) show the image at once. Checkpoints carry an open dissolve, its start frame
as 26,880 hex digits, and the flag (`pictureRevealInstant`). Tests:
[dissolve.test.ts](../test/dissolve.test.ts) (hand-computed first states per platform, durations,
replay round trip mid-dissolve, restore), each of which failed before the change except the
instant cases, which a reversed profile or host restore made fail;
[worker-dissolve.test.ts](../app/test/worker-dissolve.test.ts) (presented frames, and a recording
made through dissolves replaying from its boot and every anchor) and
[picture-dissolve.spec.ts](../app/e2e/picture-dissolve.spec.ts).

Cross-check against MAME, each frame against the engine's order at the frame's time (cells
whose two pictures agree left out): SQ2 Amiga title 0.42%, station 0.61% and room 2 2.58% of
cells differ, IIgs station 0.84% and room 2 0.87%. All differences lie within one frame's
progress of the predicted state (the beam scans the frame while the CPU writes), apart from the
pointer cells at the top left and room 2's slower dissolve, whose last frames trail by up to
two frames.

Divergences: text in the picture band goes at `show.pic` instead of dissolving away (the engine
keeps text in its own cell layer); where the original leaves rows 0..1 alone, the engine shows
the new rows at once (under the title bar while the status line is on); the length is fixed per
build, while the original varies with interrupt load (room 2 above, +4%); and the start frame is
the engine's composition before `draw.pic`, so screen objects that the pass erased before it are gone
from the start frame. Inference: the original's screen still shows them until their cells are
reached.

### Original cel handling and priority table

Static disassembly of the 15 PC executables, the ten `IBM_OBJS.OVL` overlays and the six Amiga
executables listed under [View verdicts, second pass](#view-verdicts-second-pass). Apple IIgs `1.014`
addresses come from the earlier pass and were not re-verified.

- **F-VIEWS-01 (fact on PC and Amiga; “engine matches” conclusion superseded).** Cel mirroring. MirrorCell tests the
  cel's `skipclr & 0x80`, compares `(skipclr & mask) >> 4` with the loop number and, when they
  differ, rewrites those bits and reverses the cel's row runs in place in the loaded view.

  | Build                   | Routine                        | Mask   | Called from                     |
  | ----------------------- | ------------------------------ | ------ | ------------------------------- |
  | 2.001, 2.089            | none                           | –      | –                               |
  | 2.230                   | `_SetLoop` `0x350d`            | `0x30` | MirrorLoop `0x50af` at `0x3564` |
  | 2.272                   | MirrorCell `0x5111`            | `0x30` | InsertObj `0x4fa2`              |
  | 2.411 / 2.439 / 2.440   | `0x5664` / `0x568e` / `0x5696` | `0x30` | overlay InsertObj               |
  | 2.903 / 2.915 / 2.917   | `0x57a2` / `0x57a1` / `0x57b5` | `0x70` | overlay InsertObj               |
  | 2.936                   | `0x587d`                       | `0x70` | overlay InsertObj               |
  | 3.002.086 / 102 / 107   | `0x5c98` / `0x5ca7` / `0x5ca7` | `0x70` | overlay InsertObj               |
  | 3.002.149               | `0x5ac5`                       | `0x70` | InsertObj `0x5bf5`              |
  | Amiga 2.082             | `h112+0x03f2`                  | `$30`  | InsertObj (`h112`)              |
  | Amiga 2.176/2.202/2.310 | `h149+0x03f2`                  | `$30`  | InsertObj (`h149`)              |
  | Amiga 2.316/2.333       | `h149+0x03f2`                  | `$70`  | InsertObj (`h149`)              |

  The PC masks are `and al,0x30` / `and al,0x70` with `shr al,cl` (`cl = 4`); Amiga
  `andi.b #$30,d0` / `#$70` at `+0x0400` and `lsr.b #4,d0`. The overlay InsertObj tests
  `test byte [si+0x2],0x80` at `+0x0097` and calls MirrorCell at `+0x009e`; the call resolves to
  the addresses above through the overlay load base (the executable reaches InsertObj at base
  `+6`). No direct call to MirrorCell exists in those executables: the earlier text that `_SetCel`
  also calls MirrorCell was wrong. `2.001` and `2.089` have no mirroring code (SetLoop `0x36d9` /
  `0x354d` and InsertObj test no mirror bit). `2.230` mirrors whole loops in `_SetLoop` (`0x350d`,
  called from the SetLoop routine
  `0x3493`): with the
  packed loop header bit `0x80` set and `(header & 0x30) >> 4 != loop`, it calls MirrorLoop only
  when header bit `0x40` is set, then stores `loop << 4` into bits 4..5. Because InsertObj mirrors
  before each blit on `2.272+` and Amiga, two objects sharing a cel on mirrored loops each orient
  it for their own blit. IIgs `1.014` (MirrorCell `main+0x135a`, mask `0x70`) is from the earlier
  pass. Engine: `profile.celMirrorLoopMask` is `0` on `2.001`/`2.089`, `3` on `2.230..2.440` and
  `amiga-2.082..2.310`, and `7` on `2.903..3.002.149`, `amiga-2.316`/`2.333` and `iigs-1.014`.

  **Engine correction.** The initial “engine matches” conclusion was premature: dimension
  updates still changed nonpacked orientation, and `show.obj` could draw rows last oriented by
  a screen object sharing its VIEW. Those paths are corrected. SetLoop/SetCel dimension reads leave
  nonpacked rows unchanged; screen objects, `show.obj`, add.to.pic and detached previews use the same
  profile-aware cel-for-blitting boundary. Packed `2.230` still mirrors at loop selection and
  reads that selected orientation when blitting. **Remaining packed exception:** `show.obj`
  and add.to.pic reselect the shared loop before drawing, which can change a loaded screen object's
  facing. This behavior is retained pending original-interpreter evidence; it is not a verified
  match to F-VIEWS-10. Direct selection of loop 2 and selection via
  loop 1 now give the same first nonpacked blit when no blit intervenes. Native repeated blits
  outside the orientation mask still toggle, as the recorded native contract requires.

  **Host recordings.** An authentic restore rebinds each object's packed loop from the save
  image, so its facing follows the original. A host restore (History, autosave, recordings)
  re-parses every recorded view, which resets the packed headers to the file's orientation, so
  the engine records each loaded packed view's loop orientation, mirror bit and mirrored state
  in the replay state (`viewCache.loops`, packed `2.230` only) and puts it back. A recording made
  before 1.2.6 has none: the restore selects each active object's loop and cel in object order,
  which reproduces a single alias but not a longer selection history, and its fingerprint is
  checked without the field. Tests: [view-mirror-boundary.test.ts](../test/view-mirror-boundary.test.ts),
  [worker-view-orientation.test.ts](../app/test/worker-view-orientation.test.ts).

  **Authoring translation.** The builder and Screen object Studio carry the same packed-header and
  mirror-mask capabilities as the reader. An authored mirror becomes independent reversed
  cels when either loop index lies outside the stable native range, the profile has no
  mirroring, or adding another mutable alias would change the requested facing. Mirror chains
  resolve from displayed art. Native cel-count and resource-size limits remain errors. Opening
  an imported VIEW keeps its original bytes, including native alias quirks; newly compiled
  authoring intent uses the translation above.

- **F-VIEWS-05 (fact on PC: SetCel clamps; divergence on unusual input: InsertObj does not
  clip).** The `set.cel` path (SetCel) clamps the object persistently: `cmp ax,0xa0 / jng` on
  `x + xsize` (`x := 160 - xsize`) and `cmp ax,0xffff / jnl` on `y - ysize` (`y := ysize - 1`,
  then `horizon + 1` when `y <= horizon` and `IGNRHRZ` is clear), each setting `REPOS`
  (`or word [si+0x25],0x400`). SetCel per build: `2.001` `0x3802`, `2.089` `0x3677`, `2.230`
  `0x35f8`, `2.272` `0x3674`, `2.411` `0x3bc9`, `2.439` `0x3bf3`, `2.440` `0x3bfb`, `2.903`
  `0x3cc4`, `2.915` `0x3cc9`, `2.917`/`2.936` `0x3ccb`, `3.002.086` `0x4068`,
  `3.002.102`/`3.002.107` `0x407e`, `3.002.149` `0x3f2f`. Fact: InsertObj itself does not clip.
  PC computes the start offset as `(y - height + 1) * 160 + x` in byte registers (overlay
  `+0x00a9..+0x00b3` and the shared helper, `2.936` `0x5666`) and walks the cel's run-length rows
  with no width or row test; Amiga computes `y - (height - 1)` and indexes its row table with it
  (`h149+0x0076..+0x00a8`) with no test. A cel that reaches past column 159 continues on the next
  row, and a top above row 0 wraps (PC) or indexes before the row table (Amiga). The SetCel clamps
  keep valid placements inside the picture. Engine:
  `profile.originalCelBlitClippingAndPriorityMask` is `true` for every profile and clips such a
  blit in place; the original writes outside the cel's columns or rows, which is a divergence on
  unusual input only. Amiga and IIgs SetCel addresses of the earlier pass were not re-verified.
- **F-VIEWS-06 (fact on PC and Amiga; engine matches except the unusual inputs listed).**
  Draw order. MakeObjList builds a key per object: `PriToY(pri)` when `FIXEDPRI` (`0x4`) is set,
  else `y`. Keys are 16-bit words. It then repeats a selection pass: the minimum starts at
  `0x00ff`, a key wins only when strictly smaller under a signed compare (PC
  `cmp ax,[bp-0x208] / jnl`, Amiga `cmp.w -$40e(a6),d2 / bge`), and the chosen key is overwritten
  with `0x00ff`.
  MakeObjList: PC `2.001` `0x038f`, `2.089` `0x036c` (these two collect animated objects, `0x40`,
  and give those lacking `DRAWN | UPDATE`, `0x11`, key `0xff`), `2.230` `0x0295`, `2.272` `0x02c1`,
  `2.411..2.440`
  `0x0325`, `2.903` `0x0353`, `2.915..3.002.107` `0x0358`, `3.002.149` `0x0351`; Amiga
  `h7+0x006e` in all six builds.

  PriToY: `2.001` `0x4775`, `2.089` `0x44ff`, `2.230` `0x4487`, `2.272` `0x44f3`, `2.411`
  `0x4b85`, `2.439` `0x4baf`, `2.440` `0x4bb7`, `2.903` `0x4cba`, `2.915` `0x4cb9` and `2.917`
  `0x4cbb` return the closed form `(pri - 5) * 12 + 48` (
  `sub ax,0x5 / imul word [cs:..] / add ax,0x30`) as a signed 16-bit word, not masked to a byte:
  fixed priority `0` gives `-12` and sorts
  first. Amiga PriToY (`h87+0x0024` on `2.082`, `h121+0x0024` on `2.176..2.333`) is the same
  closed form (`subq.w #$4 / subq.w #$1 / muls.w #$c / addi.w #$30`), with no flag. On `2.936`
  (`0x4cbb`), `3.002.086` (`0x50e9`), `3.002.102`/`3.002.107` (`0x50ff`) and `3.002.149`
  (`0x4f16`) PriToY uses the closed form while a flag word is nonzero (`2.936` `[0x124a]`,
  `3.002.086` `[0x12aa]`, `3.002.102/107` `[0x12bd]`, `3.002.149` `[0x1072]`). `set.pri.base`
  (`2.936` `0x4d10`, `3.002.086` `0x513e`, `3.002.102/107` `0x5146`, `3.002.149` `0x4f5d`)
  clears it and rebuilds the table as `y < base → 4`, else
  `min(15, 5 + (y - base) * 168 / floor((168 - base) * 168 / 10))`, which equals the engine's
  `min(15, 5 + floor((y - base) * 10
/ (168 - base)))` for every `base` from 0 to 167 (checked exhaustively). With the flag clear:
  - `2.936` and `3.002.086` return `0xffff` for `pri == 0`; otherwise they scan `i` from `168`
    down while `pri_tbl[i] >= pri` (unsigned), stopping at `i == 0`. `pri_tbl[168]` is the byte
    after the table (`2.936` DS `0x1322`, `3.002.086` DS `0x1392`), `0` in `AGIDATA.OVL` with no
    absolute reference, so any `pri > 0` returns `168`.
  - `3.002.102`, `3.002.107` and `3.002.149` start at `167` and have no lower bound or zero test.
    `pri == 0` never terminates. When no row has `pri_tbl[i] < pri` (after `set.pri.base`, any
    `pri <= 4`), the scan continues below the table into the flood-fill state (DS `0x12fc` on
    `3.002.102/107`, written at `0x5939`; DS `0x10b1` on `3.002.149`, written at `0x5746`) and
    returns `-1` only if that byte is below `pri`.

  Divergences on unusual input: the engine returns `-1` for `pri == 0` and for "no row below"
  on `3.002.102+`, where the original hangs or reads fill state. Keys of `255` or more (fixed
  priority `>= 23` in the closed form) never win the selection, so the previous pass's index is
  drawn again (on the first pass an uninitialized stack word); the engine sorts such keys
  normally. Engine: `priToY()` in `src/runtime/engine.ts` (closed form while the default table
  is active, then the scan with `profile.priorityTableScanStart` `168` or `167`).

### Original script capacity and version handlers

Static disassembly across all twenty shipped interpreter binaries; shipped
data-image words read from the hash-pinned PC overlays, Amiga state hunks and
IIgs `~globals`.

- **F-timing-01 / F-OPCORE-15 / F-persistence-07 (fact; engine matches).**
  Script default capacity (PC `AGIDATA.OVL` `SCRIPTSIZE = 0x0032`: `2.001`
  `DS+0x0143`, `2.089` `DS+0x0143`, `2.230` `DS+0x013f`, `2.272..3.002.149`
  `DS+0x0141`; Amiga state hunk init = `0x0032`: `2.082` `h146+0x28`,
  `2.176..2.333` `h206+0x26`; IIgs `1.014` `~globals+$0127 = 0x0032`): every
  shipped data image initializes the script buffer capacity to 50 pairs
  (allocated at `scriptSize * 2` bytes by `InitScript`), and any larger runtime
  capacity arrives through game-side `script.size` calls (`F-timing-02` /
  `F-OPCORE-03`), not the default. Engine: the default script buffer holds the
  shipped 50 pairs across all twenty profiles (field
  `defaultScriptBufferPairs: 50`).
- **F-timing-02 / F-OPCORE-03 (fact; engine matches).** `script.size` `0x8e`
  (PC handler: `2.001` `0x685c`, `2.089` `0x6b2f`, `2.230` `0x6adc`, `2.272`
  `0x6b78`, `2.411` `0x6da8`, `2.439` `0x6ef4`, `2.440` `0x6ea3`, `2.903`
  `0x7094`, `2.915`/`2.917` `0x70a3`, `2.936` `0x716a`, `3.002.086` `0x75a9`,
  `3.002.102`/`3.002.107` `0x75c1`, `3.002.149` `0x74e8`; Amiga: `2.082`
  `h116+0x0`, `2.176..2.333` `h160+0x0`; IIgs `1.014` `seg2+0x3d36`): in every
  shipped binary across all twenty profiles, the `0x8e` handler stores the
  operand into `SCRIPTSIZE`, then calls `RestoreAll`, `InitScript` (reallocates
  `scriptSize * 2` if unallocated; `scriptTop := script`; `SCRIPTENTRIES := 0`),
  `AllInBack` — a recorded-pair reset plus update-list refresh, not a bare
  capacity store. Engine: `script.size` stores the capacity, resets the
  recorded pair sequence and restores/re-stamps the update lists in the
  original's order across all twenty profiles (field `scriptSizeResetsSequence:
true`).
- **F-OPCORE-02 / F-PROFILES-01 (fact; engine matches for games/gr1).** Gold
  Rush room alias (gr1 3.002.149, NewRoom body 0x1A0A): the room operand is
  stored to var[0] unaliased (`mov [0x9],al` at 0x1A93) and passed raw to the
  logic loader; the image contains no compare against 0x7D-0x81 and no 0x49
  constant, and the overlay no alias table. games/gr1 does NOT carry the
  0x7e-0x80→0x49 alias; the spec's observed build is a different Gold Rush
  release (unidentified — identity unresolved).
- **F-OPCORE-07 (fact; engine matches).** `version` `0x8d` (PC handler and
  `versionMsg`: `2.001` `0x6a09` / `DS+0x0934`, `2.089` `0x6ce8` / `DS+0x09ac`,
  `2.230` `0x6ca9` / `DS+0x09ee`, `2.272` `0x6d45` / `DS+0x0a04`, `2.411`
  `0x6f7a` / `DS+0x0a49`, `2.439` `0x70c6` / `DS+0x0a39`, `2.440` `0x7075` /
  `DS+0x0a39`, `2.903` `0x7266` / `DS+0x0a77`, `2.915`/`2.917` `0x7275` /
  `DS+0x0aa5`, `2.936` `0x733c` / `DS+0x0aab`, `3.002.086` `0x7771` /
  `DS+0x0af7`, `3.002.102`/`3.002.107` `0x7789` / `DS+0x0b59`, `3.002.149`
  `0x7670` / `DS+0x0ab1`; Amiga: `2.082` `h124+0x00` / `h125+0x00`,
  `2.176..2.333` `h178+0x00` / `h179+0x00`; IIgs: `1.002`/`1.003`
  `seg2+0x3ee9` / `seg2+0x3efe`, `1.014` `main+0x1f0a` / `main+0x234c`): across
  all twenty shipped profiles, `version` takes no bytecode operands, passes the
  built-in `versionMsg` (`"Adventure Game Interpreter\n      Version 2.001\n"`
  with trailing newline on `2.001` `DS+0x0934`; `"Adventure Game Interpreter\n      Version <version>"`
  without trailing newline on all other nineteen profiles, using the exact
  build number on multi-build profiles `2.439`, `2.915`, `3.002.107` and
  stripping the `amiga-` / `iigs-` profile prefix) to `WindowPrint` — a modal
  window with key-poll / `var[21]` timeout — and returns with string slot 0
  untouched. Engine: `version` displays the exact per-build `versionMsg`
  modally with the `v21` timeout honored and leaves string slot 0 alone across
  all twenty profiles.

### Early PC family (2.089/2.230/2.272)

Static disassembly of the decoded SQ1 2.089 image (`e31e5e86…`), XMAS 2.230
(`875547de…`) and XMAS 2.272 (`a0c26b5d…`), runtime offsets; see
[Verified inputs](#verified-inputs) for the images. The three builds are one
lineage with per-version deltas.

- **F-motion-01 / F-OPCORE-01 (fact; engine matches).** Original position
  handlers (2.001 ddp `424da51a`: position 0x6b92, position.v 0x6bea; 2.089 sq1
  `e31e5e86`: position 0x7141, position.v 0x7199): on both 2.001 and 2.089, the
  operands are stored to x (+0x03) and y (+0x05); then, only when the control
  word's drawn bit (0x01) is set (`and cx,1 / cmp ax,1` at 2.089 0x7172, 2.001
  0x6bc3), the placement fixup (2.089 0x515C, 2.001 0x4ea3) runs; prevx/prevy
  (+0x16/+0x18) are snapshotted LAST, from the possibly adjusted coordinates.
  The fixup is not an erase: it first raises y to horizon+1 when y ≤ the
  horizon word (DS:0x12F) and the record's ignore-horizon bit (0x08) is clear
  (2.089 0x5167-0x517B), then tests the position with three predicates —
  bounds+horizon (0x5236), object collision (0x3F8B, skipped under
  ignore-objects 0x0200) and the control-screen footprint test (0x4E25, which
  first recomputes the priority band unless fixed-priority 0x04) — and, while
  any of them fails, spiral-searches a legal placement with legs
  x−−/y++/x++/y−−, the leg length incremented after the down and up legs (the
  spiral 2.936's FindPosn keeps, F-motion-12), with no iteration cap. The fixup
  routine survives in 2.230 (0x515D) with other callers, but 2.230 (0x70FA),
  2.272 (0x7196), every later PC build (`2.411..3.002.149`), all six Amiga
  builds (`2.082` h125+0x0, `2.176..2.333` h171+0x0) and IIgs `1.014`
  (`seg2+0x6280`) dropped the call: they store x into prevx/x and y into
  prevy/y together, with no drawn test and no placement fixup — store-together.
  Engine: under the 2.001 and 2.089 profiles (`positionActionOrder:
"place-when-drawn"`), position/position.v on a drawn object run the same
  horizon raise and spiral placement search, then snapshot prevx/prevy from the
  adjusted coordinates; the remaining eighteen profiles use `"store-together"`,
  matching their binaries.
- **F-motion-15 (fact; engine matches).** Original distance (2.089 sq1
  0x4061, 2.230 0x3FE5, 2.272 0x4043): center-X+baseline-Y Manhattan sum
  computed in 16 bits, then a plain `mov [var],al` byte store — wraps mod
  256, no clamp. Either object undrawn → 0xFF (both control words are
  tested for the drawn bit 0x01 before the sum). The 254 clamp exists by
  2.936, still absent from all three early builds: kq3's distance body ends
  `cmp word [bp-0x2],0xfe / jna / mov ax,0xfe` (0x4893) before the byte
  store.
- **F-VIEWS-02 (fact; engine matches).** Original 2.230 packed loop header
  (xmas `875547de`, _SetLoop 0x350D, LastCel 0x36E2): loop byte 0 =
  celcnt&0x0F | orientation<<4 (0x30) | mirrorable 0x40 | mutable 0x80; cel
  count masked with `and ax,0xf`. 2.089 (0x35C7) and 2.272 (0x35C4) use a
  full-byte cel count with no in-header orientation — the packed form is
  2.230-only.
- **F-VIEWS-08 (fact; engine matches).** 2.230 packed loop-header writeback
  (xmas `875547de`, _SetLoop 0x350D; mutable branch 0x3545, writeback
  0x356A): after storing the loop/cel fields, a mutable (0x80) loop header
  is updated in place. The skip test compares the stored 2-bit orientation
  ((hdr&0x30)>>4) against the FULL loop operand, so a loop ≥ 4 can never
  test equal. If the mirrorable bit (0x40) is set, MirrorLoop (0x50AF)
  rebuilds every cel mirrored in a 0x800-byte stack buffer and rep-movsb's
  it back over the original — in-place mutation of the loaded view
  resource. The writeback `and ax,0xffcf / or ax,(loop<<4) / mov [di],al`
  stores the whole shifted operand's low byte: loops 0-3 update only the
  orientation field, but loops 4-7 also SET the mirrorable bit 0x40, 8-11
  set the mutable bit 0x80 and 12-15 set both. So a mutable, non-mirrorable
  header 0x82 becomes 0xC2 on the first set.loop(4) — no mirror yet, 0x40
  was clear on entry — and every later set.loop with a loop ≥ 4 mirrors the
  loop again, the truncated field never matching the full operand. All other
  nineteen shipped binaries (`2.001`, `2.089`, `2.272..3.002.149`, Amiga
  `2.082..2.333` and IIgs `1.014`) use unpacked loop headers (`packedViewLoopHeader:
false`). Engine: on the 2.230 profile (`packedViewLoopHeader: true`), the
  packed path models the whole writeback — comparing the stored 2-bit
  orientation against the full loop operand and storing the unmasked `loop<<4`
  byte — so a repeated set.loop(≥4) re-mirrors exactly as the original does.
- **F-SOUND-02 (fact; engine matches).** Early sound player (2.089 sq1
  0x7615, 2.230 0x7598, 2.272 0x7634): the PSG path emits both tone bytes,
  then the control byte. On machType==2 (Tandy) the control byte first
  passes ConvertTDVolume (sq1 0x7657, 2.230 0x75DA; 2.272's instance is
  owned by the Sound verdicts entry): `(b & 0x90) == 0x90 && (b & 0x0F) < 8` raises
  the low nibble by 3. The mask matches the whole attenuation-latch family
  — 0x90/0xB0/0xD0/0xF0, all three tone channels AND the noise channel —
  not channel zero alone; tone and continuation bytes never match it. The
  engine applies the +3 to every channel's control byte under its
  early-2.089/early-2.272 families — the same scope. 2.272 additionally
  adds var[23] to the whole control byte with a signed clamp (owned by the
  Sound verdicts entry). Sound end silences all four channels with 9F BF DF FF
  (selector|0x0F) written straight to port 0xC0 (sq1 0x75F6); on machType 0
  the stop routes a single 0x9F through the speaker path, the only control
  byte that path treats as a mute. (The 2.411/2.440 forms of the same rules
  are under [Sound verdicts](#sound-verdicts).)
- **F-Parser-03 (fact; engine matches).** said() tail terminator introduction
  point (sq1 2.089 `e31e5e86` Said 0x965 vs xmas 2.230 0x851): 2.089 has no
  0x270F immediate anywhere in the interpreter and gates the match on
  `cmp cl,[numWords]` exact-count equality; 2.230/2.272 have
  `cmp ax,0x270f → shl cx,1; add si,cx; xor cx,cx` succeed-with-
  words-remaining. Terminator introduced between 2.089 and 2.230.
- **F-PROFILES-03 (fact; engine matches via profile flags).** Restart/show.mem
  in the early family (2.001 0x2358, sq1 2.089 0x22AB, xmas 2.230 0x21ED, xmas
  2.272 0x2289, kq2 2.411 0x2366, lsl1 2.440 0x2374): no f16 test precedes the
  confirmation prompt through 2.411 (or on `amiga-2.082`) — restart always
  prompts (`restartPromptBypassedByF16: false`); the f16 bypass is introduced
  in 2.440 (`0x2374`) and present on 2.440..3.002.149, `amiga-2.176..2.333`, and
  `iigs-1.014` (`restartPromptBypassedByF16: true`). `show.mem` formats only
  `"heapsize/now:… max/max script"` (ovl string, e.g. DS+0x70F in sq1) through
  2.440 (`heapDiagnosticExtraLine: false`); the `"rm.0, etc."` line is present
  on PC 2.903..3.002.149 (`heapDiagnosticExtraLine: true`) and absent on Amiga
  and IIgs.
- **F-PROFILES-04 (fact; engine matches).** set.key capacity in the early
  family (sq1 2.089 0x4481, xmas 2.230 0x4409, xmas 2.272 0x4475): free-slot
  scan `cmp di,0x27; jnl discard` — 39 entries, same as 2.411–3.002.102; full
  table silently drops the mapping.

## Appendix B: Amiga evidence

Static disassembly of the six Amiga hunk executables, cross-checked against the
shipped save images. The behaviors the Amiga shares with the Apple IIgs
(pattern brushes, click-to-walk and motion counters) are recorded here, with
the IIgs addresses beside the Amiga ones.

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

**Tests:** [profile.test.ts](../test/profile.test.ts),
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

Shipped SQ1 and SQ2 `Save/` images decode exactly
to end-of-file under the PC envelope: a 31-byte description header, then
five blocks each `{u16le length, payload}`. Controlled execution additionally verifies
all six builds in [original-file interoperability](#original-save-file-interoperability). The block partition differs
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

The sound player is verified separately in
[Original Amiga sound player](#original-amiga-sound-player). Each shipped `Save/` image of the SQ1 and SQ2 fixtures decodes
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
  `objectDistanceCap` (null, then 254) splits the generations accordingly.
- `stop.motion` (`0x4d`) clears both the direction and motion words
  (`+0x36`/`+0x38`) on every Amiga build checked (`Sierra 2.082` `h120+0x24e`,
  `KQ2 2.176` `h165+0x1d6`, `SQ2 2.202` and `2.310..2.333` `h165+0x262`) and
  for ego clears `v6` and the `userCtrl` flag (`+0x1a` / `+0x1c`), matching
  `movementClear: "later"` (`F-motion-04`). `start.motion` (`0x4e`,
  `Sierra 2.082` `h120+0x29a`, `KQ2 2.176` `h165+0x222`, `SQ2 2.202` and
  `2.310..2.333` `h165+0x2ae`) clears only the motion word (`+0x38`), retains
  direction (`+0x36`), and for ego clears `v6 = 0` and sets `userCtrl = 1`.
- `show.pic` on 2.176, 2.202 and 2.31x calls the flag-clear routine
  (h175+0x4c, a `bclr` into the `+0x3d2` flag bank) with operand 15 —
  `showPictureClearsF15`. Sierra's `show.pic` touches no flag.
- The print worker on 2.176 and 2.202 tests flag 15 (h57+0x3ee0 calls
  the `btst` routine) then resets it (h57+0x3ef0) when the print opens
  a non-blocking window — `printConsumesF15`. Sierra's print worker
  holds no flag operation; its `moveq #$f` push feeds a text-tail
  routine (h128+0x144 writes `+0x2dc`/`+0x2de`), so 2.082 keeps the
  early value.

#### Amiga profile fields verified from the handlers

Each remaining profile field was classified against the executables' own
handlers (static disassembly, the dispatch tables above). Values that change
behavior were confirmed independently at the addresses given (**fact**):

| Build(s)             | Field                        | Value                                 | Evidence                                                                                                                                                     |
| -------------------- | ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.082                | `restartPromptBypassedByF16` | false                                 | `restart.game` (h45+0x0) goes straight to the confirm dialog; 2.176+ test f16 first (KQ2 h63+0x10)                                                           |
| 2.082, 2.176+        | `timedPrintClearsV21`        | true                                  | the timed wait clears v21 on both the deadline and the key exit (Sierra h40+0x1cc, KQ2/GR h57+0x204/+0x20c)                                                  |
| all                  | `heapDiagnosticExtraLine`    | false                                 | `show.mem` prints heapsize, now/max, max script and "fast RAM"; no "rm.0" string exists in any executable                                                    |
| 2.176                | `targetMotionDeferred`       | false                                 | `move.obj` ends with `jsr h45+0x0`, the steering routine (KQ2 h165+0x90); Sierra 2.082's (h120) does not                                                     |
| 2.176                | `inventorySelector`          | true                                  | `status` (h82) waits for event type 0x0b and stores its code in v25 (h82+0x184); Sierra 2.082 never writes v25                                               |
| 2.176                | `pictureMaxCommand`          | 0xfa                                  | the picture dispatcher accepts `f0..fa` (`cmpi.b #$a; bhi`, KQ2/SQ2 h152+0x6e); Sierra 2.082 stops at 0xf8                                                   |
| 2.176, 2.202, 2.31x  | `patternProfile`             | `short-r1`, `center-row-320`          | [Original Amiga and IIgs pattern brushes](#original-amiga-and-iigs-pattern-brushes)                                                                          |
| all                  | `windowFrameGeometry`        | `amiga`                               | `OpenWndw` (Sierra h71+0x0, 2.176+ h97+0x0) draws inclusive `RectFill` (`8·cols+21` × `8·rows+11`) and 1-px red frame                                        |
| all                  | `keypadWordsNormalized`      | false                                 | `ButtonToChar` (`Sierra h76+0x28e..0x2ae`, `2.176+ h103+0x2a4..0x2c4`) maps `0x0101/0x0301 -> 0x0d` and `0x0201/0x0401 -> 0x1b` without PC keypad scan words |
| all                  | `modalDismissalKeys`         | `enter-escape`                        | `ChkAcAb` (Sierra h77+0x84, 2.176+ h105+0x84) accepts only `0x0d` and `0x1b`                                                                                 |
| all                  | `inputLineEditCap`           | `prompt-40`                           | `EditLine` (Sierra h63+0x136, 2.176+ h85+0x13c) uses `min(var[24], 40 - strlen(s0) - (promptByte != 0))`                                                     |
| all                  | `presentation`               | `amiga`                               | [Amiga screen, font and pointer](#amiga-screen-font-and-pointer): screen title status line, ROM font, own pointer                                            |
| 2.082, 2.176+, 2.31x | `palette`                    | `amiga-2.082`, `amiga`, `amiga-2.31x` | the 16×3 nibble table each build loads with SetRGB4 (same section)                                                                                           |
| all                  | `inputLineOrder`             | `prompt-edit-cursor`                  | `ShowInput` prints string 0, the edit buffer, then the cursor byte (Sierra h63+0x360, 2.176+ h85+0x366/+0x36a)                                               |
| all                  | `confirmCursor`              | `erased`                              | RestartGame calls EraseCur before the prompt and WriteCur at the tail (F-persistence-02: Sierra h45, 2.176+ h63)                                             |
| 2.082, 2.176+        | `confirmPromptModes`         | `timed`, `timed-and-f15`              | WindowPrint tests v21 on every build (h40+0x17a, h57+0x1b2) and f15 from 2.176 (h57+0x184); [F-persistence-prompt-modes](#persistence-verdicts)              |
| 2.310, 2.316, 2.333  | `restartKeepsMaxScore`       | true                                  | RestartGame saves v7 before ResetAll and puts it back (h63+0x50, h63+0xc2); [Original restart state boundary](#original-restart-state-boundary)              |

Fields whose slot is above a build's dispatch bound (see the table above)
never run there: `menuInteractionGate`, `releaseGateAction`,
`releaseGateClearAction` and `priorityBaseAction` below 2.310, and
`inputWidthActions` on 2.082. `closeWindowClearsInputWidth` has no input-width
state to clear on any Amiga build (0xa3/0xa4 are stubs or absent).

The same scan verified all other fields on the six Amiga executables: `roomAliases`
null (no 0x7e..0x80 compare in `new.room`), `wordSequenceTailTerminator` true
(`cmpi.w #$270f`, h17+0x55c / h23+0x268), `positionActionOrder`
store-together (h125+0x0 / h171+0x0), `earlierPartitionOrder` drawing-key, `packedViewLoopHeader`
false (a u16be loop-offset table), `clampExactZeroLeftBoundary` false (a
strict negative test, h127+0x168), `preLogicDirectionMirror` false on 2.082
(h5+0x01f0..0x022e runs `GetObjDirs` before the ego↔`v6` mirror) and true on
2.176..2.333 (h6+0x0206 / h6+0x0246 runs the mirror before `GetObjDirs`),
`keyByteStoredBeforeEdit` true (h63+0x8c / h85+0x92),
`inventoryListEndsOnAnyEvent` true (h59+0x154 / h82+0x192),
`originalTextWindows` true and `statusLineFormat` `common` (h40 / h57, h62 /
h84), `defaultScriptBufferPairs` 50 and `scriptSizeResetsSequence` true (h116 /
h160), `parserStopsAtTenthWord` true (h19+0x7c / h25+0x7c..0x80),
`originalInputCapacity` true (h63+0x136 / h85+0x13c),
`soundStopsBeforeFault` true (h97+0x3e / h135+0x54),
`originalRestartRestore` true and
`restoreRewritesMachineState` false (h45/h47 and h63/h65), 2.082's `targetMotionDeferred` true,
`inventorySelector` false, `pictureMaxCommand` 0xf8 and `patternProfile`
none, and on 2.31x `menuInputAction`, `releaseGateAction`,
`inputWidthActions` and `priorityBaseAction` as the stub slots and
`directionLoopTiming` cadence-due (h16+0x14e). PQ 2.310 and MH2 2.333 differ
from GR 2.316 only in version, disk-count and game-ID strings, one init
routine and relocations. `soundEnvelope` is inert on 2.082, whose driver has
no envelope table.

### Amiga screen, font and pointer

How the six Amiga interpreters put their frame on screen, read off the
executables of the [build table](#amiga-interpreter-profiles) (SQ2 2.202
`557215fbbf431193…` addresses unless noted; KQ2 2.176 and the 2.31x builds
keep the same hunk numbering, SQ1 2.082 is listed separately). Facts come
from the binaries and the game files; what Kickstart draws on the
interpreter's behalf is marked as such and was cross-checked on MAME 0.289
(`a500n`, `kick13`), which emulates the chips and is not ground truth.

**Screen and window (fact).** `h130+0x94` calls OpenScreen (wrapper
`h245+0xd0`, `-$c6(a6)` on IntuitionBase `$9f50`) with the NewScreen at
`h131+0x24`: 320×200, depth 4, DetailPen 0, BlockPen 15, Type CUSTOMSCREEN,
Font → the TextAttr at `h131+0x0c` (`"topaz.font"` at `h131+0x00`, YSize 8,
Style 0, Flags `FPF_ROMFONT`), DefaultTitle `"AGI screen"`. `h130+0xd8`
opens the window of `h131+0x44` on it: 320×200, DetailPen 0, BlockPen 15,
IDCMP `$000c2568`, Flags `$1900` (BACKDROP | BORDERLESS | ACTIVATE), no
gadgets, no title. The interpreter never calls OpenFont, OpenDiskFont or
SetFont (no `diskfont.library` string exists; graphics `-$48`/`-$42` are not
called): the font is the ROM Topaz 8 Intuition opens for the screen, and no
Amiga game disk in the fixtures carries a `fonts/` directory or `.font`
file. Game text is drawn with `Text` (`h227+0x00`, `-$3c(a6)` on GfxBase
`$9f54`) after `Move` to `(8·col, …)` — `h73+0x00` computes `$5bae = $5bac ×
$9e48` with `$9e48 = 8` — so text cells are 8 px aligned, and the text rows,
window frames and gadget rectangles of
F-persistence-05-gadgets sit where the PC puts
them. The 2.176+ builds share this layout (`h130+0x94`/`+0xd8`, `h131`); SQ1
2.082 opens the same structures from `h93+0x94`/`+0xd8` with `h94`.

**Palette (fact).** After OpenScreen, `h130+0x3b2..0x3ea` walks a 16-entry
table of three words (R, G, B nibbles) at `h131+0x74` and calls SetRGB4
(wrapper `h244+0x64`, `-$120(a6)`) for pens 0..15. The tables, as AGI
colours 0..15 in 12-bit RGB:

| Build(s)                      | Table                                              | Colours 0..15                                                     |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| SQ1 2.082 (`Sierra`)          | `h94+0x74` (file `0xcef0`)                         | `000 00f 080 0db c00 b7d 850 bbb 777 0bf 0e0 0fd f98 f70 ee0 fff` |
| KQ2 2.176, SQ2 2.202          | `h131+0x74` (file `0x128fc`, `0x12958`)            | `000 00f 080 0db c00 b7d 850 bbb 777 0bf 0e0 0fd f98 d0f ee0 fff` |
| PQ 2.310, GR 2.316, MH2 2.333 | `h131+0x74` (file `0x1346c`, `0x13720`, `0x13794`) | `000 00b 0b0 0bb b00 b0b c70 bbb 777 00f 0f0 0ff f00 f0f ff0 fff` |

The loop is `h93+0x360` in SQ1 (`lea $9fec`), `h130+0x37a` in KQ2 and
`h130+0x3b0..0x3b2` in the 2.31x builds (`lea $a5a0`/`$a6d4`/`$a6a0`). The
2.176+ builds precede it with a check (`h130+0x370..0x3a2`) that lowercases
the constant `"ORANGE"` and compares it with `"purple"`; the strings are
constants, so the compare never matches and the branch that would set colour
13 to `$f70` is dead — colour 13 is purple on every 2.176+ build and orange on
SQ1, whose table stores `$f70` directly. The engine profile field `palette`
names the table; the app expands each nibble to two hex digits, as the
hardware's 4-bit DACs show them.

**Status line (fact; Kickstart draws it).** The status routine `h82+0x42c`
formats `"Score:%d of %d  "` (`h83+0x5c`) with v3 and v7 into a buffer
(`h84+0x0a`), pads it to 39 characters, writes an optional string at column
18 (every caller in play passes NULL) and `"Sound:%s"` (`h83+0x6d`, with
`"on "`/`"off"` at `h83+0x76`/`+0x7a`) at column 26, then calls
SetWindowTitles(window, -1, buffer) (`h82+0x51c`, wrapper `h245+0x174`,
`-$114(a6)`) followed by ShowTitle(screen, TRUE) (`h82+0x526..0x530`);
`status.line.off` runs `h82+0x56c`, ShowTitle(screen, FALSE) followed by a
RectFill of rows 0..10 in pen 0 (`h82+0x590..0x5bc`). The status line is
therefore the Intuition screen title, which the interpreter never draws into
the play surface, and the configured status row plays no part: the
`configure.screen` handler (`h179+0x1fc`) stores its third operand at
`$f8a0`, which no other instruction reads; it stores the first operand at
`$f8a2` (the picture top) and in 2.176 (`KQ2`), 2.202 (`SQ2`) and the 2.31x
builds sets `$6a14 = picTop != 0`, and both `status.line.on` (`h82+0x548`) and
the off path test `$6a14` first, so a game whose picture starts at row 0 never
shows the title bar on those builds. In 2.082 (`SQ1`, `80c6b0c4912a4ca5…`),
`h60+0x2ba` (`status.line.on`) and `h60+0x2d2` (`status.line.off` and the
RectFill) are unconditional and do not test the picture top; in 2.310, 2.316
and 2.333, `status.line.off` additionally tests the status-enabled longword at
`h206+0x400` (`h82+0x580`) and returns when the status line is already off.
Kickstart 1.3 renders a screen title bar of ten rows in the block pen
(15) with the title text in the detail pen (0) starting at (2, 1), a bottom
line in the detail pen on row 10, and the two screen depth gadgets, 17 px
each, at the right edge in pens 0, 1 and 2 (observed on MAME; the bar, text
offset and gadget imagery are the ROM's, not the interpreter's). With the
status line on, picture rows 0..2 lie under the bar. Engine: `drawStatus`
leaves the cell grid alone and reports the 39-byte title through
`getPresentation().statusBar` (null while hidden, or while gated at picture
top row 0 on 2.176..2.333), and the host draws the bar from it
(`app/src/render/composite.ts`, `drawAmigaTitleBar`) with its own drawing
of the depth gadgets. Amiga profiles initialize `displayBaseRow` (`$f8a2`) to 0
at cold start and on an accepted `restart.game`, matching the state-hunk load
image; `profile.statusLineGate` (`"unconditional"` on `amiga-2.082`, `"pic-top"`
on `amiga-2.176`/`amiga-2.202`, `"pic-top-and-enabled"` on `amiga-2.310`..`2.333`)
governs both `statusBarText()` and `status.line.on` / `.off`. `.off` leaves the
configured status row alone and stamps the 320×11 window pixels of rows 0..10
(`titleFill` on `TextSurface`) with the current draw sequence in pen 0
(`windowOverlay` value 1), and later picture (`show.pic`, `draw.pic`,
`overlay.pic`) or priority (`show.pri.screen`) writes in rows 0..10 stamp
`TITLE_PICTURE_BIT` over cells with older text so neither the fill nor older
text resurrects in rows 0..10 while preserving untouched text pixels in rows
11..15, and the stamps are serialized with host images so checkpoint restore
reproduces an uninterrupted run. The same routine and strings sit at
`h82+0x42c` in KQ2 and the 2.31x builds and at `h60+0x28e` (SetWindowTitles)
in SQ1.

**Input row (fact, all six builds).** `ShowInput` prints, in order, string
0 (formatted to width 40), the edit buffer and then the cursor byte:
SQ2/KQ2 2.202/2.176 `h85+0x366` (s0 `$f566`/`$f52e`, buffer `$6e2c`/`$6e78`,
cursor write `h85+0x3d6`), PQ/GR/MH2 2.31x `h85+0x36a` (s0
`$fd06`/`$fe7e`/`$fe5e`, buffer `$745c`/`$7470`/`$7474`), SQ1 2.082
`h63+0x360` (s0 `$f218`, buffer `$7168`, cursor `h63+0x3d0`).
`set.cursor.char` (SQ2 `h85+0x338`) stores its message's first byte in the
cursor variable (`$f89a`), and `EraseCur` (`h85+0x2c6`) backspaces over it.
The prompt character a player sees is string 0 (SQ2's logic 104 sets `">"`),
not the cursor byte, and the cursor follows the typed text. Engine: the
profile field `inputLineOrder` is `"prompt-edit-cursor"` on the six Amiga
profiles, whose `drawInputRow` writes `s0 + edit + cursor`; `confirmCursor`
is `"erased"` there, so the cursor leaves the row while a restart or quit
confirmation is open and returns when it closes (every Amiga RestartGame
calls EraseCur first and WriteCur unconditionally at the tail,
F-persistence-02). The PC profiles keep the engine's earlier
cursor-first row and cursor handling until their own input routines are
read. On the IIgs the input routine is read
(`seg2+0x19cd` under [Apple IIgs presentation](#apple-iigs-presentation))
and shows the same `s0 + edit + cursor` order, so the engine's
cursor-first row is a recorded divergence there. The PQ1 2.903 frame in
the mame-diff baseline shows a prompt glyph followed by the cursor,
which is an observation, not a reading of the PC binary.

**Gadget labels (fact).** Each confirmation gadget's IntuiText has LeftEdge
4 and TopEdge 2 inside the gadget (F-persistence-05-gadgets), so the label
glyphs sit at `(x0 + 4, y0 + 2)` of the 12 px fill — three pixels above the
cell row the engine's text surface carries them on. Engine:
`getPresentation().gadgets` describes each fill with its label, and the
Amiga look draws the label there, over the cells.

**Pointer (fact).** `h130+0x404..0x4b2` reads `data/pointer` (`h131+0x105`):
72 bytes of hardware sprite data (a 16-row, 16-wide two-plane hardware sprite with
its control words), then two signed bytes of hot-spot offset and three words
of colour, and `h130+0x4d6..0x534` reads `data/busy` the same way, falling
back to the pointer data. `h130+0x560` calls SetPointer(window, data, 16, 16,
x, y) (`h130+0x594`, wrapper `h245+0x152`, `-$10e(a6)`) and SetRGB4 for pens
17..19 with the file's colours. Every fixture's `Pointer` file ends
`ff 00 0d22 0000 0fca`: hot spot `(-1, 0)` — the tip one pixel into the image
— and colours `$d22`, `$000`, `$fca`; `Busy` ends `f9 f8` (hot spot
`(-7, -8)`, its centre). The busy pointer shows during disk loads, which the
engine has none of; the arrow is the player's cursor over the screen, drawn
by the app as its own arrow in those colours and hot spot and scaled like
the screen's pixels in each direction (`app/src/play/amigaPointer.ts`); as
browser chrome it is absent from composed and exported frames. SQ1 2.082 reads only `data/pointer`.

**Glyph shapes (decision).** The font the player saw is the ROM's Topaz 8.
The app's Amiga font (`app/src/render/fontAmiga.ts`) is a recreation of the
Amiga Topaz 8 bitmap design, kept as this project's own table and matched
pixel for pixel for printable ASCII: bitmap typeface designs carry no ROM
data, so no ROM or font file ships and nothing is read from a ROM at build
or run time, and the font is neither the original file nor endorsed. The
table was transcribed from the interpreter's own screen output (every
printable character typed on the SQ2 input line under MAME) and checked
glyph by glyph against a contributor's Kickstart 1.3 ROM by
`app/test/font-amiga-provenance.test.ts`, which decodes the ROM's Topaz
strike (`0x9134`, stride `0xc0`, CharLoc table `0x9734`) when the ROM is
present, skips otherwise, and asserts identity for 0x20..0x7e. Against the
MAME frames the remaining differences are the redrawn depth gadgets, the
emulator's pointer parked at the top-left corner, and the animation phase
of moving objects.

### Amiga directory absence

The 2.31x combined-directory loader decides whether a three-byte entry
names a resource before any volume is opened. Its predicate lives at
h100+0x118 in the PQ 2.310 and MH2 2.333 executables (sha256
`72ddbb3ecda804b8dac2f65ed115099af0241d475ac8d432de48428b28cd5cca` and
`5ce3b163bd32ee025f6ba8ca8c946b03a06ff2960da8cc723c1d6184a3cc346a`); both
builds' predicate bytes hash identically
(`02a9c19a546c9fef0ad9dfcf09df609d3b4b4fa8b6425702d68bb40f88470e87`), and
GR 2.316 (`7bfa2f36616923a41ecb5aa9e3595e7225cdd48ea453e1c1b8310ace0fcdb7db`)
carries the same bytes — a static identity; its routine was not executed.

The original routine was executed unchanged on controlled inputs: 768
three-byte entries per build, 1536 of 1536 agreeing with the rule that an
entry whose first byte's high nibble is `f` is absent, regardless of its
remaining bytes (`00 00 00` and `ef ff fc` present; `f0 00 00`,
`ff ff fc` and `ff ff ff` absent). That differs from the DOS v3 rule,
where only the exact `ff ff ff` triple is absent and the nibble can name
a real `VOL.15`. An absent entry answers "no such resource": the loader
never reaches the volume open, so an `f`-nibble entry cannot trigger the
missing-volume report a real `VOL.14` reference produces, and it is never
treated as a successful load. The MH2 `dirs` (sha256
`4c4ed1128707c0b5cf35ae978b9bb77b9bb98f18b98e0f87a9911620d54515da`,
picture section at offset 599) lists picture 106 as `ff ff fc` at file
offset 0x395: absent under this rule, not a reference to an unshipped
`VOL.15`.

The probes establish the predicate on the 2.310/2.316/2.333
combined-directory builds — executed on 2.310 and 2.333, byte-identical
on 2.316. The earlier Amiga builds and the IIgs were not exercised here.
In the engine, the rule is the profile's `directoryAbsence`
(`volume-nibble-f` on these three profiles, `exact-fff` on the DOS v3
profiles); the same boundary caps a pack's destination volume at 14 for
the nibble-f rule and 15 under exact-fff.

**Tests:** [amiga-directory.test.ts](../test/amiga-directory.test.ts),
[amiga-directory-review.test.ts](../test/amiga-directory-review.test.ts),
[container-profile-roundtrip.test.ts](../app/test/container-profile-roundtrip.test.ts).

### Original Amiga sound player

The Amiga editions play the same SOUND resources as the PC releases (the
Gold Rush payloads are byte-identical, 44 of 44) through a dedicated Paula
driver instead of the PC chip writes. On the GR 2.316 executable (134,852
bytes, sha256 `7bfa2f36616923a4` — see the
[build table](#amiga-interpreter-profiles)) the driver is code
hunk 197 (`hunk` type, base `0xf0b8`, `0x6c4` bytes) and its data is hunk
198 (base `0xf77c`, `0x120` bytes), followed by bss hunk 199 (`0x9c`).

Cross-check: data hunk 198 is byte-identical in SQ2 2.202, PQ 2.310 and
MH2 2.333 (sha256 `aa58503273b9af41`). Code hunk 197 is byte-identical
between GR, SQ2 and PQ (sha256 `06c91c9320595f16`); MH2's copy differs only
in branch targets and the called shutdown slot (sha256 `8a739721db6a206c`),
and KQ2 2.176's copy (base `0xe760`, sha256 `13459f357a19d4c0`) differs
from GR's only in absolute addresses — with those masked, the two
disassemble to the same instruction sequence. SQ1 2.082 carries an earlier
driver, described in [its own subsection](#the-older-2082-driver-fact).

```bash
python scripts/probe-interpreter-amiga.py info games/goldrush-amiga/GR
python scripts/probe-interpreter-amiga.py hunk games/goldrush-amiga/GR 198
python scripts/probe-interpreter-amiga.py hunk games/kq2-amiga/KQ2 198
python scripts/probe-interpreter-amiga.py info games/sq1-amiga/Sierra
```

Code hunks were disassembled with capstone (m68k) after patching each
reloc32 slot with its target hunk's base, so the absolute operands quoted
below are image addresses.

**Tests:** [sound-playback.test.ts](../test/sound-playback.test.ts),
[sound-register-fidelity.test.ts](../test/sound-register-fidelity.test.ts),
[ports.test.ts](../test/ports.test.ts),
[audio.test.ts](../app/test/audio.test.ts).

#### The 2.176+ driver (fact)

Init (`0xf0b8`): allocates an 8-byte tone buffer and copies h198 `+0xf8`
into it — the signed-PCM waveform `00 40 7f 40 00 c0 81 c0` (0, 64, 127,
64, 0, -64, -127, -64); allocates `0x1000` bytes and fills them with a
noise PCM: an LFSR seeded with 1, each step `state = (state & 1) ?
(state >> 1) ^ 0x0ca0 : state >> 1`, storing the low byte of every new
state. Two `0x44`-byte IOAudio request blocks are prepared, `ioa_Data` points
at the 1-byte `ADCMD_ALLOCATE` channel-mask array `0x0f` at h198 `+0x100`
(requesting all four Paula channels simultaneously, `h197+0x047e..0x048e`), the
reply port is named `AGI-sound-port` (NUL-terminated at h198 `+0x101`), and
`audio.device` (h198 `+0x110`) is opened.

Channel records (init at `0xf1ec`): four `0x20`-byte records at `0xf89c` —
`+0` stream pointer, `+4` channel number, `+6` countdown (starts at 1),
`+8` Paula period, `+a` base attenuation, `+c` volume, `+e` envelope
table start, `+12` envelope cursor (both set to h198 `+0` for every
channel), `+16` active flag, `+1a` DMACON bit `1 << channel`, `+1c` the
AUDx register block `0xdff0a0 + channel * 0x10`. `StartSound` at `0xf1ec`
calls the audio-device helper at `0xf4c4..0xf654`; `0xf62c..0xf640` writes
each voice's `AUDxLC` and `AUDxLEN` once before the first tick: tone voices point at the 8-byte sample
with AUDxLEN 4 (words); the noise voice points at the 4,096-byte PCM with
AUDxLEN `0x800` (`0xf62c..0xf640`). Each voice's buffer is fixed by its
channel for the whole session.

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
data hunk 139 holding only the `0x0f` `ADCMD_ALLOCATE` channel-mask byte at
`+0x00`, `AGI-sound-port` at `+0x01`, and `audio.device` at `+0x10` — no
envelope table.

- Init (`0xe5fc`) allocates a 4-byte tone buffer and writes `00 80 00 80`
  into it (`0xe65c..0xe67c`), a two-sample square cycle played with
  AUDxLEN 2 words; the noise buffer is `0x400` bytes of the same LFSR PCM
  (`cmpi.w #$400` at `0xe684`), AUDxLEN `0x200` (`0xe976..0xe98e`).
- Channel records are `0x16` bytes at `0xec68` (the later driver uses
  `0x20`), initialized at `0xe72e`.
- The tick (`0xe7b6`) makes the same flag-9 test, then programs a voice
  only when a note decodes — held ticks write nothing. Unlike `2.176+`
  (which sets `AUDxLC` and `AUDxLEN` once at `StartSound`), `0xe95e..0xe9b0`
  rewrites `AUDxLC`, `AUDxLEN`, `AUDxPER`, `AUDxVOL` and the `DMACON` enable
  on every decoded note (`AUD0..2LEN = 2`, `AUD3LEN = 0x200`). Since the
  tone and noise buffer addresses and lengths never change across the
  session, these writes leave the selected sample unchanged. Setting an
  already-enabled DMA bit preserves its running phase.
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

#### Original m68k player execution across all six builds (fact)

Each relocated Amiga executable below was executed in Unicorn 2.1.4
(`UC_ARCH_M68K`, `UC_CPU_M68K_M68000`) with MMIO hooks on `$DFF096`
(`DMACON`) and `$DFF0A0..$DFF0DF` (`AUD0..3LC`, `AUD0..3LEN`, `AUD0..3PER`,
`AUD0..3VOL`). The harness runs `InitSound`, `StartSound`, `PlaySound` ticks
and `StopSound` against synthetic four-voice vectors (notes, held ticks,
zero-tone rests, all four noise types `0..3`, `v23 = 0` and `v23 = 5`, and
mid-note flag-9 clear), plus the first five available SOUND resources in
each game. Across all six builds (**2,992 ticks**, **10,160 register
writes**), the raw writes match an independently specified register model.
The shipped TypeScript `SoundPlayback` was run separately on the same inputs:
its per-tick period, volume, DMA-enable state and completion match the original.
This compares register state; the host packets repeat a held period on later
builds where the original writes only the volume. Sample bytes, fixed sample
addresses/lengths and audio-device allocation operands are checked separately.

| Build   | Executable SHA-256 prefix | Code / data hunk SHA-256 prefixes       | `Init` / `Play` / `Start` / `Stop`        | Verified ticks | Register writes | State mismatches |
| ------- | ------------------------- | --------------------------------------- | ----------------------------------------- | -------------: | --------------: | ---------------: |
| `2.082` | `80c6b0c4912a4ca5`        | `888b23c04c2358f6` / `1ecff0f84c84c309` | `0xe5fc` / `0xe7b6` / `0xe72e` / `0xe926` |            380 |             693 |                0 |
| `2.176` | `62b17ac8049a982e`        | `13459f357a19d4c0` / `0f50641a37644ec6` | `0xe760` / `0xe92a` / `0xe894` / `0xea9a` |            745 |           3,008 |                0 |
| `2.202` | `557215fbbf431193`        | `06c91c9320595f16` / `aa58503273b9af41` | `0xe7a0` / `0xe96a` / `0xe8d4` / `0xeada` |            468 |           1,950 |                0 |
| `2.310` | `72ddbb3ecda804b8`        | `06c91c9320595f16` / `aa58503273b9af41` | `0xef40` / `0xf10a` / `0xf074` / `0xf27a` |            240 |             906 |                0 |
| `2.316` | `7bfa2f36616923a4`        | `06c91c9320595f16` / `aa58503273b9af41` | `0xf0b8` / `0xf282` / `0xf1ec` / `0xf3f2` |            745 |           1,925 |                0 |
| `2.333` | `5ce3b163bd32ee02`        | `8a739721db6a206c` / `aa58503273b9af41` | `0xf098` / `0xf262` / `0xf1cc` / `0xf3d2` |            414 |           1,678 |                0 |

#### Paula onset and A500 output

**Region and pitch.** Commodore's [Amiga Hardware Reference Manual,
chapter 5, "Limitations on Selection of Sampling Period", p. 138](https://retro-commodore.eu/files/downloads/amigamanuals-xiik.net/Other/Amiga%20Hardware%20Reference%20%28within%20all%20pictures%29%20-%20Manual-ENG.pdf)
lists the audio clock as 3,579,545 Hz for NTSC and 3,546,895 Hz for PAL.
The byte rate is clock / AUDxPER; an eight-byte tone at period 1,000 is
447.443125 Hz on NTSC and 443.361875 Hz on PAL. Settings > Advanced offers
Amiga timing: NTSC (US) or PAL (Europe), saved locally for the next start.
The session region selects the audio clock and frame timing.

The NTSC default follows a MAME 0.289 NTSC A500 comparison using the US
PQ1 2.310 and SQ2 2.202 releases. The previous PAL-clock output measured
median pitch errors of -15.87 and -15.85 cents respectively, against
`1200 * log2(3546895 / 3579545) = -15.86` cents predicted by the hardware
clock ratio. This is measured emulation evidence for the default, distinct
from the original driver machine-code facts below.
A fresh 60-second NTSC engine render against the retained reference measures
PQ1's median error as +0.01 cents (119 mixed-voice spectral candidates;
+0.01 cents also across the 52 confidently aligned intro-note peaks).
SQ2's 111 candidates have a median within 0.01 cents of zero. These medians
establish removal of the colour-clock tuning error; PQ1's later SOUND 30
alignment remains uncertain and individual mixed-voice peaks remain ambiguous.

**Original frame timing facts.** The PQ1 and SQ2 executable hashes are
listed below and in [Amiga interpreter profiles](#amiga-interpreter-profiles).
Their h135 interrupt code has the same unrelocated SHA-256
`6b82c1fe6db6009af28c6bf069a90765ab17f9e4b7730910ab4aa2cd8f2734a9`.
PQ1 h200 (base `0xf7c0`, SHA-256
`4360355b398b9e16bb40c7ec212eea871a178944965241d21d910d2af1a6beef`)
and SQ2 h200 (base `0xf020`, SHA-256
`eda9acd119d343110a8db5f6acf2084764f7a22e18ec823b9ff4aa92ff34c19d`)
install h135 through Exec AddIntServer with interrupt number 5 (VERTB) at
h200+0x1b8..0x1d6. PQ1's Exec veneer h246+0..0x14 calls vector -168;
[Commodore's Exec interrupt documentation](https://wiki.amigaos.net/wiki/Exec_Interrupts)
identifies this as the vertical-blank server chain.

| Interpreter operation                     | Hunk offsets    | PQ1 2.310 addresses | SQ2 2.202 addresses |
| ----------------------------------------- | --------------- | ------------------- | ------------------- |
| Sound soft interrupt each active frame    | h135+0x06..0x16 | `0xa8aa..0xa8ba`    | `0xa1b2..0xa1c2`    |
| Game soft interrupt every third frame     | h135+0x1a..0x38 | `0xa8be..0xa8dc`    | `0xa1c6..0xa1e4`    |
| Game callback installed                   | h200+0x222      | `0xf9e2` → `0xee48` | `0xf242` → `0xe6a8` |
| Sound callback installed                  | h200+0x274      | `0xfa34` → `0xf10a` | `0xf294` → `0xe96a` |
| Game seconds increment every 20 callbacks | h194+0x16..0x38 | `0xee5e..0xee80`    | `0xe6be..0xe6e0`    |

Both h194 timer hunks have unrelocated SHA-256
`162c154512ea27ee43e31904b581fa27e52cf82faf72fa9183c92e7feef90dbc`.
Sound callbacks decrement the driver note countdown and step its envelope;
these are interpreter instructions, separate from SOUND and LOGIC bytecode.
The frame divider and 20-callback second counter contain fixed constants.

**Measured PAL timing.** MAME 0.289 ran the original PQ1 2.310 and SQ2
2.202 executables on `a500` (PAL) and `a500n` (NTSC), both with `kick13`.
Captures used `-video none -sound none -nothrottle`, 48 kHz WAV output, no
keyboard input, and 200 emulated seconds for PQ1 or 150 for SQ2. SQ2 used
its bootable original disk (SHA-256
`e46084876466879600fbde240a512dcd23b10e23058c680151d7f0e608dee4c4`).
PQ1 used a reconstructed OFS boot disk containing the unchanged original
executable and resources (SHA-256
`a0509b8e161b05e8c9a1312a66977f22efc9063f4d68cb51cc4393cdf6cd0220`),
rather than a preservation image. Periodic screenshots established that both
intros reached the measured music.

A read-only Lua probe located relocated h194 in RAM from its instruction
signature, obtained the callback counter and v11 addresses from its relocated
operands, and observed them each emulated frame. It neither wrote RAM nor
changed game resources. Loaded addresses were:

| Game / machine | h194      | Callback counter | v11       |
| -------------- | --------- | ---------------- | --------- |
| PQ1 / PAL      | `0x271f0` | `0x28068`        | `0x2833d` |
| PQ1 / NTSC     | `0x24ef0` | `0x25d68`        | `0x2603d` |
| SQ2 / PAL      | `0x26a38` | `0x278b0`        | `0x27b85` |
| SQ2 / NTSC     | `0x24738` | `0x255b0`        | `0x25885` |

Every measured game-second interval contained 60 frames and 20 callbacks.
PQ1 supplied 140 PAL intervals and 169 NTSC intervals; SQ2 supplied 99 and 119. Both games measured 1.199993233 seconds per game second on PAL and
0.998800022 on NTSC. MAME's reconstructed frame rates are approximately
50.000282 and 60.072086 Hz, explaining the small difference from nominal
50/60 Hz. These are observed counter changes in the original interpreter,
independent of the TypeScript engine.

The opening PQ1 SOUND 36 passage supplied four resolved first-channel note
attacks at sound ticks 0, 39, 148 and 186. SQ2 SOUND 60 supplied sixteen
resolved second-channel attacks through tick 500. Regression of attack time
against sound ticks measured PAL/NTSC duration ratios of 1.200988 (PQ1) and
1.200669 (SQ2). Median pitch shifts were −15.842 and −15.864 cents. Thus PAL
music is about 16.7% slower; pitch is about 0.9% lower, following Paula's
colour clock rather than the frame-rate ratio. Analysis retained the raw 48 kHz
captures, demodulated resolved note frequencies for attacks, and used an FFT
with interpolated log peaks in each note's middle half for pitch. Temporary
12 kHz analysis copies had no time stretching or equalization. Mixed voices,
short attacks and unresolved later effects are outside these measurements.

**Other Amiga profiles.** Static inspection extends the fixed frame divider to
KQ2 2.176, GR 2.316 and MH2 2.333: their h135 and h194 hashes match those
above. Their executable identities are in
[Amiga interpreter profiles](#amiga-interpreter-profiles). SQ1 2.082 uses the
same interrupt bytes in h97; its h136 timer (SHA-256
`9561d22a00dac7c15bcba73fbd5cf99bbf3474cbaa1ceeb5c67b7fc3472bb110`)
increments at +0x16, compares against 20 at +0x1c and increments v11 at
+0x34. Its h141 (base `0xecdc`, SHA-256
`d6f72da253a4451b762ca6768ebc4ca3d305fdc0bfb8f7f445ad5a42b25b9e9d`)
installs h97 through AddIntServer 5 at +0x1c0..0x1ca and h136 as the callback
at +0x216. Unlike h194's greater-or-equal test, h136
uses equality; the normal frame division is the same. These additional
profiles were inspected statically, without a full-machine PAL measurement.

| Build     | Frame hunk / image base | Timer hunk / image base |
| --------- | ----------------------- | ----------------------- |
| SQ1 2.082 | h97 / `0xa2d0`          | h136 / `0xe50c`         |
| KQ2 2.176 | h135 / `0xa16c`         | h194 / `0xe668`         |
| GR 2.316  | h135 / `0xaa1c`         | h194 / `0xefc0`         |
| MH2 2.333 | h135 / `0xa9e8`         | h194 / `0xefa0`         |

**Regional release limit.** The measured executables came from US releases.
The [PQ1 release catalogue](https://www.mobygames.com/game/146/police-quest-in-pursuit-of-the-death-angel/releases/)
identifies a 1993 U.S. Gold Kixx XL Amiga release in France, Germany, Italy
and the United Kingdom. A verified executable from that release was unavailable
for this comparison. Its timing, and any European timing patch, remain unverified.

**Engine timing.** The Amiga profile variants use nominal 60 Hz NTSC or 50 Hz
PAL sound heartbeats, three frames per pacing increment and 20 increments per
game second. PAL therefore has 60 ms pacing increments and 1.2-second game
seconds. PC and IIgs keep their existing timing. Settings > Advanced > Amiga
timing selects the region for the next start. The running session keeps its
region; autosaves, numbered saves, tapes and recorded tests restore it.
Optional region metadata preserves existing format versions, with omission
meaning NTSC. Numbered saves retain authentic native bytes and carry the region
in their host storage or archive metadata.

A fresh PQ1 PAL run through the shipped offline audio graph used 48 kHz output,
RNG/noise seed 1 and master gain 0.1. Against the four resolved MAME PAL SOUND
36 notes, median pitch error was +0.017 cents and tempo error was −0.22%
(regressed attack spacing). Envelope/filter attack uncertainty is several
milliseconds; this establishes the opening passage's tuning and tempo rather
than a sample-exact match or alignment of later SOUND 30 effects.

Reproduce the static checks with privately supplied executables:

```bash
python scripts/probe-interpreter-amiga.py disasm games/pq1-amiga/PQ 200 --start 0x172 --end 0x27e
python scripts/probe-interpreter-amiga.py disasm games/sq2-amiga/SQ2 200 --start 0x172 --end 0x27e
python scripts/probe-interpreter-amiga.py disasm games/pq1-amiga/PQ 135 --start 0 --end 0x40
python scripts/probe-interpreter-amiga.py disasm games/sq2-amiga/SQ2 135 --start 0 --end 0x40
python scripts/probe-interpreter-amiga.py disasm games/pq1-amiga/PQ 194 --start 0 --end 0xd8
python scripts/probe-interpreter-amiga.py disasm games/sq2-amiga/SQ2 194 --start 0 --end 0xd8
```

**Original driver facts.** PQ Amiga 2.310 (`PQ`, SHA-256
`72ddbb3ecda804b8dac2f65ed115099af0241d475ac8d432de48428b28cd5cca`)
has h197 at image base `0xef40`. Its unrelocated code SHA-256 is
`06c91c9320595f165ae819201d6654c87880c8a9ab4dd99ee51918cd6db2cdd8`,
identical to GR 2.316 (`GR`, SHA-256
`7bfa2f36616923a41ecb5aa9e3595e7225cdd48ea453e1c1b8310ace0fcdb7db`).
The following are relocated **interpreter machine-code** addresses, cross-checked
against both executables; the SOUND and LOGIC resources are separate bytecode.

| Operation                            | h197 offset    | PQ 2.310       | GR 2.316       |
| ------------------------------------ | -------------- | -------------- | -------------- |
| Noise AUDxLC, then AUDxLEN = 0x800   | +0x574, +0x57a | 0xf4b4, 0xf4ba | 0xf62c, 0xf632 |
| Tone AUDxLC, then AUDxLEN = 4        | +0x582, +0x588 | 0xf4c2, 0xf4c8 | 0xf63a, 0xf640 |
| Note AUDxPER                         | +0x382         | 0xf2c2         | 0xf43a         |
| Call envelope step                   | +0x38a         | 0xf2ca         | 0xf442         |
| Note AUDxVOL                         | +0x38e         | 0xf2ce         | 0xf446         |
| Set DMACON channel bit (OR 0x8000)   | +0x39c         | 0xf2dc         | 0xf454         |
| Held-tick AUDxVOL                    | +0x224         | 0xf164         | 0xf2dc         |
| Terminator clears DMACON channel bit | +0x5b0         | 0xf4f0         | 0xf668         |

LC/LEN are set during sound setup, before the first note enables DMA.
The note routine writes PER, computes the envelope, writes VOL, then sets
the DMA bit. It contains no DMA clear, LC/LEN rewrite, raster wait or timed
attack ramp. The envelope subroutine includes the division helper, so these
writes have instruction execution time between them; this inspection establishes
order, rather than a measured bus-cycle delay. Between notes DMA remains enabled.
The positive `2, 1, 0` envelope entries are the attack values described above.
A terminator or stop clears DMA. Consequently a new note on an enabled channel
continues phase; a new DMA activation reloads the sample start.
The terminator at h197+0x5a6..0x5ba (`0xf4e6..0xf4fa`) tests and clears
the channel's software active field, then writes its mask to DMACON. It
writes no AUDxVOL. The emitted null-period event's zero volume is therefore
a software stop marker, rather than a hardware volume write.

No instruction in h197 accesses CIA-A PRA or its direction register.
A literal-address census of all hunks in both executables finds no operands
`0xbfe001`, `0xbfe201`, `0xbfe000` or `0xbfe200`. This establishes the
absence of direct literal accesses; it does not observe OS calls or indirect
addresses. The driver uses `audio.device` to allocate channels and writes
Paula registers itself. These checks can be reproduced without distributing
interpreter bytes:

```bash
python scripts/probe-interpreter-amiga.py disasm games/pq1-amiga/PQ 197 --start 0x372 --end 0x3aa
python scripts/probe-interpreter-amiga.py disasm games/goldrush-amiga/GR 197 --start 0x372 --end 0x3aa
python scripts/probe-interpreter-amiga.py cia games/pq1-amiga/PQ
```

**Hardware facts.** Commodore's [Amiga Hardware Reference Manual,
chapter 5](https://oldcrap.org/wp-content/uploads/2023/04/amiga-all-hw-ref-manual.pdf),
"Playing the Waveform", "Joining Tones" and "The Audio State Machine",
describes DMA start, pointer/length reload and high-byte/low-byte output.
The period counter reloads from AUDxPER at each byte transition; setting an
already-set DMACON bit leaves DMA running. Channels 0 and 3 feed the left
output; 1 and 2 feed the right output. The manual's "Low-Pass Filter" section
and appendix F identify CIA-A bit 1 as the active-low power LED/filter control
on later A500 models.

The [Commodore A500 rev 6a/7 schematic, sheet 4](https://www.amigawiki.org/dnl/schematics/A500_R6.pdf)
gives the always-connected RC stage as R321/R331 = 360 ohm and
C321/C331 = 0.1 uF: a `1 / (2 * pi * 360 * 0.1e-6) = 4,420.97 Hz` pole.
The switched unity-gain Sallen-Key stage uses R322/R323 = 10 kohm and
C322/C323 = 6,800/3,900 pF: nominal cutoff
`1 / (2 * pi * 10e3 * sqrt(6800e-12 * 3900e-12)) = 3,090.53 Hz` and
`Q = sqrt(6800 / 3900) / 2 = 0.6602`, with a 12 dB/octave roll-off.
**Hardware-only tolerance limit:** these are nominal component values.
Resistor/capacitor tolerances, op-amp behavior, LED-switch characteristics and
external loading vary across individual boards. No production tolerance range
or measured board response is established here. Only physical measurements can
characterize a particular unit. The host uses the nominal formulas in
[paula.ts](../app/src/audio/paula.ts); it does not fit its filters to MAME.

The schematic also places C324/C325 (22 uF + 0.33 uF in parallel) between
the left filter output and R324 (1 kohm), with R325 (390 ohm) to ground;
C334/C335 and R334/R335 mirror this on the right. **Circuit inference:**
an unloaded jack has a 31.0387 ms high-pass time constant, a 5.128 Hz pole,
and passband gain 390/1390. An external load changes both. The presentation
normalizes that passband gain into the existing host volume scale.

The manual's non-DMA section states that an idle DAC retains its last
value. [Figure 5-8 in the third edition, printed page 166](https://www.ikod.se/wp-content/uploads/2020/08/Amiga_Hardware_Reference_Manual_3rd_Edition.pdf)
shows exit from the low-byte state 011 without a data or volume clear.
The model finishes the current word and retains its low byte and volume;
a re-enable before that exit keeps phase. Interrupt service and horizontal
DMA slot timing remain unmeasured.

**Presentation model and limits.** The app selects this A500 analogue path
with the LED bright, since the inspected driver leaves the filter control alone.
This is an explicit boot-state assumption; OS LED state was not captured.
A first-order IIR models the RC stage and a Web Audio lowpass biquad models
the LED stage. [Web Audio's lowpass Q](https://www.w3.org/TR/webaudio-1.0/#dom-biquadfilternode-q)
uses decibels, so the circuit's dimensionless Q is converted with `20 * log10(Q)`. The two low-pass filters and output coupling preserve state across notes.
The four voices route to the hardware's stereo sides.

DMA starts at sample byte zero with the playback rate installed **before**
its start quantum. On period changes, a replacement source starts at the next
byte boundary and the current sample offset. Volume writes land at the
register tick independently of that boundary. This avoids Web Audio's k-rate `playbackRate` transition, which
otherwise emits several fast cycles at onset before the intended period takes
effect. Each signed DAC byte occupies 32 identical buffer frames, so browser
reconstruction approximates a held sample rather than interpolating across
the entire byte period. The browser's sample reconstruction remains an approximation; this
model does not claim bus-cycle accuracy, DAC PWM emulation or measured analogue
component tolerances. Period 0 counts 65,536 clocks while keeping volume;
it can emit slow changes. A DMA clear retains output through the coupling
stage. Natural SOUND completion preserves that graph for the next sound;
explicit host disposal releases its nodes.

**Click cause and limits.** The later tone bytes
`0, 64, 127, 64, 0, -64, -127, -64` have exact mean zero and first byte zero.
The older 2.082 tone `0, -128, 0, -128` has mean -64. Volume changes scale
the currently held byte immediately; a retrigger restarts the positive
`2, 1, 0` attack while DMA continues. These finite gain steps can click on
hardware. DMA stop holds a level, and the coupling circuit turns that level
into a decaying transient. Its 5.128 Hz pole barely changes the click band
above 20 Hz. This establishes a physical mechanism, rather than a measured
A500 recording or a guarantee of quieter playback. No added attack ramp
or sample recentering conceals the original driver behavior.

**Regression evidence.** [paula-offline.test.ts](../app/test/paula-offline.test.ts)
boots PQ's original LOGIC and captures 1,800 sound heartbeats through the real
`AgiAudio` graph in headless Chromium's `OfflineAudioContext`. It covers SOUND
36, repeated SOUND 19, then SOUND 37 and the intro music in SOUND 30.
The harness advances the game clock and uses the shipped `CycleClock` for
`v10` pacing, with controlled game and presentation RNG seeds of 1.
The same harness boots PQ PC/Amiga and SQ2 PC/Amiga/IIgs, using each edition's
own LOGIC and scheduler. IIgs loads the original wave RAM and instrument bank.
Per-voice renders measure starts, ends, rests, DMA clears and IIgs source
halts. Metrics include adjacent jumps in 4 ms, the difference of signed
2 ms means, 20 ms local means and whole-capture voice DC, and DC-removed
20–800 Hz energy in 10 ms against a nearby tone window. The periodogram
integrates on a 20 Hz grid; its actual resolution is about 100 Hz. These
finite windows include carrier phase, pitch, envelope and leakage, so their
energy and mean differences are proxies rather than isolated click energy.

An independent held-byte DAC reference follows the documented register
sequence through the nominal filters. PQ's baseline fails the DMA-off step
comparison by 0.06680 full scale; corrected DMA-off errors stay below one
output DAC LSB (`0.4 / 128 / 2`), and rests below two. The earlier high-band
bound is replaced by these step comparisons: held bytes have legitimate
harmonics which whole-byte interpolation removed. The 0.08 adjacent-jump
bound remains, and high-band energy remains reported.
Optional `AGI_AUDIO_RENDER_DIR` writes float WAVs, fixed-scale spectrograms
and per-boundary JSON, preserving over-range IIgs samples for analysis.
Each fixture explicitly skips with content-identified setup instructions.
[paula.test.ts](../app/test/paula.test.ts) checks phase, signed DAC output,
coupling and measurements with hand-computed expectations;
[audio.test.ts](../app/test/audio.test.ts) checks register scheduling,
held output and filter-state survival across completed streams.

**MAME 0.289 NTSC and PAL register and audio cross-check.** Running SQ2
`2.202` (`SOUND 60` title music) in MAME 0.289 under both `a500n -bios kick13`
(NTSC, 60 Hz `CIA-B` interrupt cadence, `3,579,545 Hz` Paula clock) and
`a500 -bios kick13` (PAL, 50 Hz `VBlank` cadence, `3,546,895 Hz` Paula clock)
with read-only memory write taps on `$DFF096` and `$DFF0A0..$DFF0DF` captures
`StartSound`'s sample setup (`AUD0..2LC = 0xbdc0`, `AUD0..2LEN = 4`;
`AUD3LC = 0x54a00`, `AUD3LEN = 0x800`) followed by **4,914** NTSC writes
across **1,345** ticks and **4,961** PAL writes across **1,358** ticks.
Per-tick period, volume and DMA-enable state have **zero mismatches** against
`SoundPlayback`. The recording ends during the tune, so this does not check its
final completion boundary. Unicorn covers completion separately.

For the same resource rendered through the shipped 48 kHz `OfflineAudioContext`
graph at master 1, 18 seconds of NTSC and 22 seconds of PAL audio were aligned
at the first audible onset (5 ms RMS blocks). MAME WAV channels 0/1 carry Paula;
channel 2 is silent. After averaging those channels and applying the same
40 Hz two-pole Butterworth high-pass to each recording, Welch spectra
(16,384-sample windows) have cosine similarities **0.9975** for both regions.
Energy above 4 kHz is **0.0516% / 0.0539%** in the host versus
**1.808% / 1.857%** in MAME (NTSC / PAL). The host applies the schematic's
nominal RC and LED filter cascade; the captured MAME output lacks that roll-off.
The mixed spectra support arrangement and pitch agreement, not an every-note
pitch or onset bound. DMA slot/interrupt latency and physical filter tolerances
remain separate from the matching register state.

**Backend comparison.** TI's [SN76489 family data sheet](https://ftp.whtech.com/datasheets%20and%20manuals/Datasheets%20-%20TI/SN76489.pdf)
describes separate frequency counters and attenuation registers. The app
keeps its bipolar square oscillators running while an attenuation latch
gates their gain; a rest reaches zero gain without a persistent signed DAC
level. Abrupt gain changes still have carrier-dependent steps. Exact NCR
8496/SN76496 phase behavior remains the hardware evidence gap described in
[SN76489 attenuation latching](#sn76489-attenuation-latching-and-rest-notes).
Apple's [IIgs hardware reference](https://downloads.reactivemicro.com/Apple%20II%20Items/Documentation/Manuals/IIgs/IIgs%20Hardware%20Reference.pdf)
defines DOC halt on zero data or the halt bit. The Note Synthesizer's
instrument attack/release envelope can reduce a tone before its oscillators
halt; a halt itself is abrupt. See the instrument and driver evidence under
[IIgs sound](#sound-format-fact-except-where-marked). Apple's
[technical note 11](https://apple2.gs/technotes/tn-iigs-011/) also documents
physical DOC swap clicks, which this presentation does not model.
Those captures preceded the [Tandy clock](#tandy-psg-clock) and
[IIgs DOC corrections](#iigs-doc-pitch-volume-and-headroom). Their carrier,
arrangement and presentation levels differ, so raw step maxima alone establish
neither smaller clicks nor listener preference.

#### Engine/app mapping

`SoundPlayback` emits `{kind: "paula", channel, period, volume, driver?}`
per voice on the session's 60 Hz NTSC or 50 Hz PAL clock: the 2.176+ family
every tick for every live voice, the 2.082 family (`driver: "2.082"`) on decode
ticks only. Studio audition (`SoundAudition` in
[soundAudition.ts](../app/src/audio/soundAudition.ts)) reads the same stored
`monotio_agi.amigaRegion` preference and steps `"paula"` previews at 50 Hz
(`20 ms` per tick) with `amigaRegion: "pal"` when PAL is selected, keeping
Studio audition in tempo and pitch parity with Play.
`period` is the value written to AUDxPER (null when the voice's DMA is
off) and `volume` the value written to AUDxVOL while DMA is on, always 0..64.
With a null period its zero volume is a software stop marker
(`AMIGA_ENVELOPE_TABLE`, `AMIGA_2176_ENVELOPE_TABLE`,
`AMIGA_2082_NOISE_PERIODS`, `AMIGA_TONE_SAMPLE`,
`AMIGA_2082_TONE_SAMPLE`, `amigaNoisePcm` in `src/sound/sound.ts`).
`app/src/audio/AgiAudio.ts` renders fixed per-channel buffers at
`3579545 / period` for NTSC or `3546895 / period` for PAL, through stereo
A500 output filters.
A driver change rebuilds the voices. Phase, register boundaries and the LED
model are described in [Paula onset and A500 output](#paula-onset-and-a500-output).
Periods below 124 colour clocks retain the DMA-limit approximation, and period 0
counts 65,536 clocks at the programmed volume. The `soundDevice` operand stays a PC-family
selection. PC and IIgs graphs keep their own synthesis paths.

### Amiga timer and pacing

Fact, all six executables (hashes under
[Amiga interpreter profiles](#amiga-interpreter-profiles)): a VERTB interrupt server, installed
with `AddIntServer` and `moveq #$5,d0` (`2.082` `h141+0x1c0`, `2.176` `h200+0x1c6`,
`2.202..2.333` `h200+0x1cc`), is byte-identical in every build (`2.082` `h97`, the others `h135`).
Each frame it causes the sound soft interrupt while a sound is active; every third frame it
causes the game soft interrupt unconditionally. The constant 3 is fixed and nothing reads the
video standard, so pacing and the clock run at 20 Hz on NTSC and 16.7 Hz on PAL machines. The
timer (`h194`, `h136` on `2.082`) adds 1 to the tick count and reads input outside the pause
gate, then advances pacing and the seconds sub-counter (`>= 20`, `== 20` on `2.082`). Pacing
differs in mechanism from PC: the interrupt clears the counter and signals the main task when
it reaches v10, and the main loop (`h2+0x10`, `h2+0x0a` on `2.082`) waits for that signal only
when v10 is not 0. No WaitTOF or other frame wait exists. Besides the pause action (which stops
the sound), the IDCMP handlers set the pause word on MENUVERIFY until MENUPICK and on
INACTIVEWINDOW until ACTIVEWINDOW; on `2.176..2.333` INACTIVEWINDOW also stops the sound, while
`2.082` has a `nop` there.

Engine: `frameTiming: "amiga-vblank"` matches the rates for the selected region
([amiga-timing.test.ts](../test/amiga-timing.test.ts)). Divergences: the signal-locked pacing
grid differs from the engine's admission-time clear only when a pass overruns v10 ticks; the
menu-hold pause is modelled by the engine's native strip (the game clock stops while the right button holds it); the inactive-window pause is not, because browser focus is not Intuition's.

### Original Amiga and IIgs pattern brushes

The shaped brush of picture commands 0xf9/0xfa differs from both PC
families in two ways (**fact**):

- **Horizontal limit.** Every Amiga plotter and the IIgs clamp the doubled
  start x to `0x140 - 2r` — 320, the v2 limit — including the builds whose
  radius-1 shape is the v3 cross (KQ2 and GR h152+0x162 `move.w #$140`; IIgs
  `main+0xa2b` `lda #$0140`). A plot clamped at the right edge therefore
  writes one column past 159, into the next row, as on PC v2. The vertical
  limit is `0xa7 - 2r` (167), as on the PC.
- **Radius 1.** The Amiga brush table (h150+0x5a) is eight relocated
  pointers to per-radius row arrays. On 2.176 and 2.202 radius 1's array
  holds two rows (`e000 e000`, h150+0x7c..0x80) but the plotter reads three,
  so its third row is radius 2's first word, `7000`: the brush is
  `[e000, e000, 7000]`. 2.310/2.316/2.333 store the cross
  `[4000, e000, 4000]`, as does the IIgs's flat table (`~globals+0x18b`).
  Radii 0 and 2..7 match the PC v2 rows on every build.

The stipple generator is the PC one: the seed is ORed with 1, then
`lsr` / `eor #$b8` per pixel, writing only when bit 0 is clear and bit 1 set
(GR h152+0x1d0..0x230; IIgs `main+0xad1`). `AgiProfile.patternProfile`
selects `short-r1` for 2.176/2.202 and `center-row-320` for the 2.31x
generation and the IIgs. Tests:
[picture-profile.test.ts](../test/picture-profile.test.ts).

### Original native menu dispatch

The Amiga menu event path is separate from `menu.input`. In PQ1 Amiga
2.310, the action table dispatches that opcode to the no-op h6+0x64.
Intuition MENUVERIFY and MENUPICK messages enter h106 instead. Addresses
below identify interpreter machine code, with hunk relocations resolved;
they describe the original event boundary, not game LOGIC or a browser
implementation of the native OS.

PQ1 executable SHA-256 is
`72ddbb3ecda804b8dac2f65ed115099af0241d475ac8d432de48428b28cd5cca`.
MENUHOT verification at h106+0x106 rejects a nonzero h206+0x410 inhibit,
text-screen state h180+0 equal to 1, or clear AGI flag 14. The text-screen
meaning is established by the dispatched text.screen/graphics handlers in
h179. The separate inhibit is written by dialog and picture-transfer paths;
it is broader than a single modal kind. Successful verification sets freeze
flag h4+2 and menu ownership h108+8 only if the freeze was previously clear.
MENUPICK at h106+0xdc clears those fields only when h108+8 identifies this
owner. The timer tests h4+2 at h194+0x0c and returns before game-clock and
pacing updates when it is set. These instructions establish the game-clock
gate, not original OS scheduling or an audio-pause rule.

Selection h221+0x434 returns immediately for `0xffff` cancellation. Otherwise
it calls ItemAddress, reads the selected item's status byte at +0x1a,
sign-extends it, enqueues type 3 through h103+0x40 and follows NextSelect at
+0x20. Controlled M68000 execution of the unchanged selection, queue, input
drain and condition dispatch tested all 256 status bytes. Only OS ItemAddress
was replaced with a synthetic lookup; the controller array and surrounding
memory started zeroed. The drain's h85+0xac arm sign-extends the event word
again and writes byte 1 relative to controller base h120. Statuses 0..127
write their positive slots; 128..255 write offsets -128..-1. Condition 12's
ordinary unsigned controller predicate is true for 0..127 and false for
128..255 in this controlled case. This proves the consumer does not fold
negative statuses back to unsigned. It does not establish adjacent-memory
effects, real disabled-item selection or whole-game behavior, and does not
justify reproducing the original out-of-bounds write.

Static comparisons extend those inspected instruction boundaries to Gold
Rush 2.316 (`7bfa2f36616923a41ecb5aa9e3595e7225cdd48ea453e1c1b8310ace0fcdb7db`)
and MH2 2.333 (`5ce3b163bd32ee025f6ba8ca8c946b03a06ff2960da8cc723c1d6184a3cc346a`).
Their selection h221+0x434..0x482, signed controller-write arm h85+0xac..0xbe,
MENUHOT h106+0x106..0x158, MENUPICK h106+0xdc..0x106, flag predicate
h175+0xa2..0xc2, ItemAddress veneer h248+0x88..0xa0 and initial timer
h194+0..0x40 match PQ1, including every resolved relocation target. Their
unsigned controller predicate matches at h23+0x19c..0x1ac. This is static
identity of those regions; it does not substitute for original OS interaction
or independently prove every downstream callee.

Earlier native gates differ. Sierra/SQ1 2.082
(`80c6b0c4912a4ca5b44ad94c1c1b66a42e2b490f8a4ace90fb8b05f1fb39ea0f`)
MENUHOT h78+0x106 checks inhibitor h80+0x0c and text mode h129+0, with no
flag-14 test before freeze at +0x12c. KQ2 2.176
(`62b17ac8049a982e08b1830463f067e102960feb2abb78e992e28bbe15a1cf42`)
and SQ2 2.202
(`557215fbbf431193e99578be53372496bd4bf1cfad7c4ba93a61968e5c760dec`)
check h108+0x0c, text mode h180+0 and flag 14 at h106+0x106..0x158.
Their print worker restores the prior inhibitor before its nonblocking f15
return; PQ1 does likewise at h57+0x1a8. A persistent window therefore
does not itself prove native menu inhibition on these builds.

The early controller paths also sign-extend selected status: SQ1 selection
h159+0x410 and write h63+0xa2 use controller base h86; KQ2/SQ2 use h85+0xa8
and h120. SQ1's condition-table h18 slot 12 resolves to h17+0x484, which
zero-extends the operand before reading h86. KQ2/SQ2's unsigned predicate
at h23+0x19c matches the later predicate. These are static consumer/predicate
findings, separately from the executed PQ1 cases.

SQ2 IIgs 1.014 executable SHA-256 is
`e1a2788f92cb76220e5ac228945bf2eaf7f3a97208f0c3af2ae81d947407717f`.
Its native menu.input handler seg3+0x142f returns unchanged. The top-bar
entry at seg3+0x910..0x919 requires flag 14, `$0090==0` and `$00b3!=1`.
Native selection seg3+0x13d7 masks the identifier to eight bits before
enqueueing type 3; construction and enable/disable use `id & 0xff | 0x0100`.
This unsigned path differs from the inspected Amiga consumer. `$00b3` is
text mode: text.screen seg2+0x6ac writes 1 at +0x6ba, while the graphics
helper clears it at +0x88c. `$0090` inhibits drawing/dialog interaction:
picture transfer main+0xf8e sets it and +0xfcc clears it; print/wait
seg2+0x2251 sets it. The nonblocking f15 return at +0x22a5 branches past
the clear at +0x2352, so the persistent print window retains menu inhibition
until window close. This differs from the inspected Amiga f15 return.
Full TaskMaster completion routing and original time/audio ownership remain
separate evidence questions. These IIgs findings are static, with no original
Toolbox execution claimed.

### Original Amiga menu strip and pull-downs

How the six Amiga interpreters build the Intuition menu strip and how
Kickstart 1.3 draws it while the right mouse button is held. Facts come
from the executables ([build table](#amiga-interpreter-profiles); SQ2 2.202
`557215fbbf431193…` addresses) and from headless MAME 0.289 frames (`a500n`,
`kick13`) of SQ2 2.202 with the button held; what Kickstart draws on the
interpreter's behalf is marked as such and MAME is not ground truth.

**Strip construction (fact, SQ2 2.202; the other five builds share the
routine).** `set.menu` (`h221+0x00`) allocates a 30-byte `Menu` and links
it: `LeftEdge` = the running width total (`$118d8`, starting at 0),
`Width` = 8 × (title length + 1) (`h221+0x7a..0x90`, font width `$9e48` =
8), `TopEdge` 0, `Height` = font height + 1 = 9, `Flags` 1 (MENUENABLED),
and the title copied as `MenuName`. `set.menu.item` (`h221+0x106`)
allocates a 34-byte `MenuItem`: `Width` = 8 × (text length) + 8
(`h221+0x17e..0x198`), `Height` 9, `TopEdge` = the menu's running item
height (`$118da`), `Flags` `0x52` (ITEMTEXT | ITEMENABLED | HIGHCOMP), the
controller number in the status byte at +0x1a, and an `IntuiText` with
FrontPen 0, BackPen 15, DrawMode 1, `LeftEdge` 4 and `TopEdge` 1
(`h221+0x21e..0x232`). The first item of each menu decides the items'
shared `LeftEdge` (`h221+0x19c..0x1be`): zero, unless the title's
`LeftEdge` plus the item width reaches the screen width (`$9f60+8` = 320),
when it becomes `Menu.Width - itemWidth` so the pull-down opens to the
left. `submit.menu` calls SetMenuStrip (`h221+0x2a2` through the veneer
`h245+0x13a`); `enable.item` / `disable.item` (`h221+0x348` / `+0x370`)
walk the strip and call OnMenu / OffMenu (`h245+0xb8` / `+0xa0`) with the
item's menu number, so a disabled item is standIned by Intuition and cannot
be selected.

**What the player sees (MAME frames, SQ2 2.202; Kickstart draws it).**
While the right button is held the strip replaces the screen title: rows
0..9 in pen 15 with the pen 0 line on row 10 and no depth gadgets; titles
in pen 0 at (`LeftEdge` + 2, 1); the title under the pointer complemented
over x `LeftEdge + 1 .. LeftEdge + Width`, rows 0..8. Its pull-down box
is `maxItemWidth + 8` wide and `9 × items + 8` tall, starting at x
`LeftEdge + itemsLeft - 2` (kept on screen: SQ2's `Sierra` box at 0..87)
and row 9: a one-pixel pen 0 line top and bottom, two-pixel sides, pen 15
inside; each item's select box sits four pixels inside the box, 9 rows per
item, with its text at (+4, +1) in pen 0 (SQ2's `File` box spans 54..173 ×
9..61 with `Save     <F5>` at (62, 14)). A standIned item is drawn and then
erased through Intuition's standIn pattern aligned to the screen: on odd
rows every pixel with x ≡ 1 (mod 4) returns to pen 15, on even rows x ≡ 3
(mod 4) (the separator's dashes at row 35 lose x = 65, 73, 81). The
highlighted item's select box is complemented (inference from HIGHCOMP
and the item rectangle above; the MAME pointer could not be steered onto
an item for a frame). Releasing the button over an enabled item selects
it and anything else cancels; the strip and the title bar swap back at
once (frames before and after the release).

**Engine.** `src/runtime/nativeMenu.ts` computes the titles, boxes and
select boxes from the headings `set.menu` built; `Engine.nativeMenuOpen`
/ `Move` / `Release` run the strip as a menu modal with native state,
gated by [Original native menu dispatch](#original-native-menu-dispatch)
(`profile.nativeMenu`, `nativeMenuF14Gate`; the engine also treats a
parked host wait as the inhibitor), freeze the game clock while open, and
deliver the released item's controller at the next input phase, dropping
statuses 128..255. The Amiga look paints the strip from
`getPresentation().menu` (`app/src/render/composite.ts`). Host access that
the hardware never had, documented as such: a touch long press on the
title bar and the touch Menu button open a strip that stays until a tap
or Esc, and arrow keys move on it. Not modelled: chained NextSelect
selections, Intuition command keys, the right-button double click while
the strip is available (Intuition consumes the button then), and the
pointer sprite. Tests: [native-menu.test.ts](../test/native-menu.test.ts),
[composite.test.ts](../app/test/composite.test.ts),
[worker-native-menu.test.ts](../app/test/worker-native-menu.test.ts),
[amiga-menu.spec.ts](../app/e2e/amiga-menu.spec.ts).

### Original Amiga save and restore dialogs

The Amiga `save.game` / `restore.game` dialogs are AGI text windows the
interpreter draws through WindowPrint with Intuition gadgets, not a file
requester. Facts from the executables (SQ2 2.202 `557215fbbf431193…`
addresses; the same strings and call shapes are in `Sierra` 2.082
`h10`/`h47`/`h49`, `KQ2` 2.176 and `PQ`/`GR`/`MH2` 2.31x `h13`/`h66`/`h69`)
and from headless MAME 0.289 frames of SQ2 2.202's save and restore
sequences.

**Windows (fact).** The dialog routine `h13+0x256` opens every window
through `h57+0x224`, which formats the message at a given width
(`$4b96`), forces the column count to that width when asked, forces the
row count when given, adds three rows when gadget labels are passed
(`h57+0x2b6..0x2d0`), centres the window like a message window
(`topRow = ((19 - rows) >> 1) + 1 + picTop`, `leftCol = (40 - cols) >> 1`,
`h57+0x346..0x3b2`) and attaches the two gadgets of
F-persistence-05-gadgets. The steps and their strings (`h14`):

- Volume: `"         SAVE GAME\n%sdo you wish to save this game?\n\n%s\n\n"`
  (`h14+0x47`; `%s` = `"\nOn which volume or in which directory "` and
  `"(For example, \"Save:\" or \"/Save\")"`), width 31, gadgets `OK` /
  `Cancel`, the directory typed on the input row (`h13+0xcc`); the
  default directory is `"Save"` (`h14+0x00`) and the typed answer is
  lowercased by the line editor, so the file names start `save/`. Restore
  uses `"        RESTORE GAME\n\n%sis the game that you want to restore?…"`.
- Slots: `"Select the slot in which you wish to save the game."` /
  `"Select the game which you wish to restore."` at width 34 with the
  columns forced to 34 and the rows forced to `count + 3` (`h13+0x360..
0x3aa`), then gadgets `OK` / `Cancel`. The save list holds all twelve
  slots (`h13+0x2be`), the restore list only existing files; each line is
  `" - %s"` at the window's left column from row `top + 3`, the pointer
  glyph 0xbb (`h13+0x6e4`) on the current line, and an invisible 240 × 8
  BOOLGADGET with id `0x100 + i` from column `left + 3` on each line
  (`h13+0x742..0x7b4`), whose click posts a type `0x0a` event the loop
  takes as that slot (`h13+0x484`). Up and Down wrap (`h13+0x53c..0x5ee`),
  Enter selects, Escape cancels. The initial line is the newest file by
  date (`h13+0x2a4`); the engine starts on the first line, having no file
  dates. No files: `"There are no games to\nrestore in\n\n%s"` with no
  gadgets.
- Describe: `"How would you like to describe this saved game?\n\n"` at width
  31, columns forced, gadgets `OK` / `Cancel`, the current description
  edited on row `bottom - 3` in the front pen on the background pen
  (`h13+0x7a..0x8c`, editor `h30+0x188`, 31 bytes).
- Confirm: `"About to save the game\ndescribed as:\n\n%s\n\nin file:\n%s"`
  with gadgets `Save` / `Cancel` (`h69+0x32..0x72`, `h70`), or
  `"About to restore the game\ndescribed as:\n\n%s\n\nfrom file:\n%s"` with
  `Restore` / `Cancel` (`h66+0x46..0x72`, `h67`), width 35, columns from the
  longest line; the file is `"%s%s%ssg.%d"` (`h207+0x00`): the directory, `/`
  unless it ends in `:` or `/`, the game id and the slot number.
- 2.31x only strings, not modelled: `"   Sorry, this disk is full.\n…"` and
  `"Use the arrow keys to move\nthe pointer to your name,\nthen press RETURN\n"`.

**Frames (MAME, SQ2 2.202).** The twelve-line save window spans text rows
2..19 at columns 3..36 (frame x 14..306, y 10..164), its `OK` fill at x
24..63 and `Cancel` at 240..295, rows 147..158; the describe window is 31
columns wide at rows 8..14 with the input row on row 11; the confirm
window's columns follow the longest line (28 for the 28-character
description in the frame). The pointer glyph 0xbb is
`00 cc 66 33 66 cc 00 00`.

**Engine.** `src/runtime/saveDialog.ts` renders these windows on the
Amiga profiles (`platform: "amiga"`), skipping the volume step: the
default directory answers it, so a player saves straight to a slot and
the confirm window names the file as the original does after accepting
the default. Gadgets and slot lines answer clicks and taps through
`Engine.pointerKeyAt`. A rejected write shows the engine's own notice in
a window. The PC and IIgs profiles keep the spec-derived selector. Tests:
[save-dialog.test.ts](../test/save-dialog.test.ts),
[amiga-menu.spec.ts](../app/e2e/amiga-menu.spec.ts).

### Original click-to-walk

Every Amiga build and the Apple IIgs build start a click-move of ego on a
left-button-down; the PC interpreters take no pointer input (inference:
the decoded PC dispatch has no pointer path). Static
disassembly of the executables listed under
[Amiga interpreter profiles](#amiga-interpreter-profiles) and
[Apple IIgs interpreter (SQ2 1.014)](#apple-iigs-interpreter-sq2-1014) (GR 2.316 first, the
other builds by the same routines at the listed offsets), all **fact**
unless marked.

**Pointer input (Amiga).** The game window is a borderless backdrop window
at (0, 0), 320x200 (NewWindow template GR h131+0x44, flags `0x1900`), so its
mouse coordinates are screen pixels. Its IDCMP template (h131+0x4e, flags
`0x000c2568`) subscribes to button, gadget, menu, raw-key and
activation messages (`GADGETUP = 0x40`, `MOUSEBUTTONS = 0x08`, `MENUPICK = 0x100`,
`RAWKEY = 0x400`) but not MOUSEMOVE or DELTAMOVE, so the pointer position
is only seen inside a button message. The message pump (Sierra `2.082 h78+0x00`,
`2.176+ h106+0x3c`) copies the message's MouseX/MouseY — screen pixels on the
320x200 screen — and dispatches on the class and code:

- **Window gadget click (`GADGETUP = 0x40`, Sierra `h78+0x148`, `2.176+ h106+0x158`):**
  when a window has neither button string, the print path attaches an
  Intuition boolean gadget with GadgetID 1 (attach `Sierra h40+0x432..0x494`,
  `2.176+ h57+0x474..0x4f8`; gadget `Sierra h41+0x5c`, SQ2 `h58+0x5c`).
  `OpenWndw` (`Sierra h71+0x60..0xca`, `2.176+ h97+0x60..0xca`) only computes
  and fills the rectangle the gadget covers: `LeftEdge = 8*leftCol - 10`,
  `TopEdge = 8*topRow - 6`, `Width = 8*cols + 21`, `Height = 8*rows + 11`, with
  Flags 3 and Activation 1 (`RELVERIFY`). A click inside it posts `GADGETUP`.
  On `2.176+` the jump table at `h106+0x17c` posts `{1, 0x0d}` (Enter) for
  IDs 1, 2 and 4 and `{1, 0x1b}` (Escape) for ID 3; for IDs outside 1..4, bit
  9 posts type `0x0b` and bit 8 type `0x0a`. `2.082` posts Enter for IDs 1 and
  2, Escape for ID 3, and type `0x0a` for bit 7. ID 0 posts nothing. Clicks
  outside the rectangle miss the gadget. Engine: an inclusive hit on the
  window rectangle posts Enter.
- **Left-button-down (`MOUSEBUTTONS = 0x08`, code `0x68 = SELECTDOWN`, Sierra `h78+0x228`, `2.176..2.202 h106+0x262`, `2.31x h106+0x258`):**
  1. if the text-screen flag (`Sierra h129+0x0`, `2.176+ h180+0x0`) is clear:
     - **2.31x only:** set flag 19 (`moveq #$13` into the `bset` routine
       `h175+0x16`) and store MouseX/MouseY in `h108+0xc/+0xe`;
     - skip the walk if the text-window flag (`Sierra h42+0x8`, `2.176+ h59+0x8`)
       is set (set by the windowed print path `h57+0x446`, cleared at `h57+0x796` —
       an open non-blocking print window);
     - call the starter (`Sierra h33+0x15c`, `2.176+ h45+0x14a`) with `(MouseX, MouseY)`.
  2. **Sierra `2.082` only (`h78+0x25c`):** when `h129+0x0` is set
     (`cmpi.w #$68; cmpi.l #1,h129`), the `SELECTDOWN` arm enqueues
     `{1, 0x0d}` (Enter). Only `text.screen` (action `0x6a`, `h128+0x0e`,
     cleared at `h128+0x18a`) writes that flag; `show.pri.screen` (action
     `0x1d`, `h123+0x20a`) calls WaitAcAb (`h76+0x218`) without setting it.
     So a left click satisfies a `text.screen` wait on `amiga-2.082` with
     Enter, and a click on the priority screen does not. `2.176+` removed this
     branch; there `h180+0x0` is written only in text mode
     (`h179+0x24`/`+0x1d8`), and Intuition menus do not raise it.
- **Right-button-up (`MOUSEBUTTONS = 0x08`, code `0xe9 = MENUUP`, Sierra `h78+0x282..0x2d8`, `2.176..2.202 h106+0x294..0x2ea`, `2.31x h106+0x2a4..0x2fa`):**
  calls Intuition `DoubleClick(prevSec, prevMicro, curSec, curMicro)`
  (LVO `-0x66`). When it returns non-zero and the text-window flag
  (`Sierra h42+0x8`, `2.176+ h59+0x8`) is clear, the arm posts
  `move.l #$401`, event `{1, 0x0401}`, via `Sierra h75+0x40` /
  `2.176+ h103+0x40`. It never tests the text-screen flag. Posting leaves the
  stored time unchanged; the arm records `(curSec, curMicro)` only when it
  posts no double click (`h106+0x2da`), so a third quick click is compared
  with the same stored time. `ButtonToChar` (`Sierra h76+0x28e..0x2ae`,
  `2.176+ h103+0x2a4..0x2c4`) normalizes `0x0401` to `0x1b` (Escape), while
  `set.key(1, 4, c)` binds controller `c` to the raw word `0x0401`; nearly
  every shipped game binds `0x0101..0x0401`. Engine: the right double click
  posts only when no engine modal and no f15 window is open (inference: an
  open print window raises the text-window flag). The browser adapter pairs
  clicks within 500 ms and starts a new pair after posting (an adapter
  choice).

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

**Apple IIgs 1.014.** The mouse-down arm is `seg3+0x8eb..0xa83`.
For a top-row click (`where.y < 8`), native menu selection requires flag 14,
`$0090 == 0` and `$00b3 != 1`; otherwise the click continues to the window
hit-test at `seg3+0x9b4..0x9c4`. `$00b3` is text mode, not a generic modal
flag (text.screen writes it at `seg2+0x6ba`).

The hit-test (`seg3+0xe1f..0xecb`) first asks the Toolbox for a window/control
hit. Its AGI rectangle fallback at `+0xe87` requires `$158d != 0` (set at
`seg2+0x2d21`), compares
X with inclusive `$15f2..$15f6` and Y with inclusive `$15f4..$15f8`, and
returns part 2 for a hit. These bounds are populated at `seg2+0x4aa3..0x4ae0`;
the right and bottom bounds include one pixel beyond the drawn frame's last
pixel. The dispatch posts Enter or Escape for dialog control hits; a normal
print or show.obj frame hit (part 2) posts Enter through the relocated table
at `seg3+0xa32`.

The no-hit arm (`seg3+0xa4b..0xa67`) checks `$1592`, set by opening a print
window at `seg2+0x2c27` and cleared by CloseWndw at `seg2+0x2162`. It walks when
`($1592 == 0 && $b3 == 0) || $1590 != 0`. The f15 branch at
`seg2+0x2275..0x22a5` returns without closing the window and sets
`$1590 = 1` (`seg2+0x2295`), so an open f15 window allows outside
click-to-walk; any other open print window blocks it. Clicking the window's
frame still posts Enter. Otherwise text mode posts Enter (`seg3+0xa6f`),
including a click in the top row. show.pri.screen
(`debugseg+0x258..0x284`) swaps the picture nibbles and calls WaitAcAb without
setting text mode: its graphics click is not an Enter event.

The walk starter `movetoseg+0xb4` checks player control `$011d`, sets mode 4,
`+0x40 = x/2 - width/2`, `+0x42 = y - $b7` (the play-area top), `+0x44 = +0x30`,
and no nudge. The finish (`movetoseg+0x198`) skips the completion flag for mode 4
and hands control back; the mover's edge case (`moveobjsse+0x1ec`) finishes only
mode 3; `newroomseg+0x115` clears a mode-4 ego and v6. The IIgs has no
`mouse.posn`, flag-19 or nudge surface. The menu gate fields `$0090` and `$00b3`
are also described under [Original native menu dispatch](#original-native-menu-dispatch).
Engine: an open f15 window lets outside clicks walk on the IIgs, and clicking
its frame posts Enter.

**Engine mapping.** The host reports left-button-downs through
`EngineHost.takePointerClicks` as screen pixels during gameplay and routes clicks
during modal/window states through `Engine.pointerKeyAt(x, y)`; Amiga right-button
double-clicks route through `Engine.pointerRightDoubleClick()`. The parameter bank
holds the target words and saved step, which Amiga and IIgs save images carry
whole at +0x40..+0x45.
**Tests:** [click-move.test.ts](../test/click-move.test.ts), [input-fidelity.test.ts](../test/input-fidelity.test.ts).

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

## Appendix C: Apple IIgs evidence

Static disassembly of `SQ2.SYS16`, the Space Quest II interpreter for the Apple
IIgs, with the engine's boot trace. The click-to-walk, motion counter and
pattern brush entries in [Appendix B](#appendix-b-amiga-evidence) also cover
this build.

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

#### Apple IIgs presentation

Evidence is SQ2 2.0A interpreter 1.014, `SQ2.SYS16`, SHA-256
`e1a2788f92cb76220e5ac228945bf2eaf7f3a97208f0c3af2ae81d947407717f`.
Addresses below are **named OMF segment offsets**, decoded with 16-bit A/X
(`probe-interpreter-iigs.py --m 0 --x 0`). They are not flat file addresses.
The [Apple IIgs Toolbox Reference, volume 2](https://mirrors.apple2.org.za/ftp.apple.asimov.net/documentation/programming/65816_gs/Apple%20IIGS%20Toolbox%20Reference%20Volume%202.pdf),
chapter 16, defines the QuickDraw II font record and toolbox calls.

- **Palette (fact; implemented).** `~arrays+0x0e67` contains sixteen RGB12
  little-endian words, in AGI index order:
  `0000 000f 0080 00db 0c00 0b7d 0850 0bbb 0777 00bf 00e0 00fd 0f98 0d9f 0ee0 0fff`.
  `initscrseg+0x0087..0x0093` passes this table to `SetColorTable` (`$0e04`),
  table zero. The picture copy at `main+0x158d..0x1599` masks with `$0f0f`
  and duplicates each index nibble horizontally. Text calls `SetForeColor`
  (`$a004`) and `SetBackColor` (`$a204`) at `seg2+0x52f0..0x5306`, so text
  and pictures share that index mapping. RGB8 conversion repeats each nibble
  (`f→255`, `8→136`), matching MAME's captured colour values.
- **Game font (metrics verified; optional player font and project fallback).** `initmachseg+0x016f`
  opens the path `data/AgiFont` at `~arrays+0x0e0e`. After loading its handle,
  `+0x0280` saves the previous font; `+0x029b` and `+0x02c1` call `SetFont`
  (`$9404`) for the game and saved ports. The fixture's 2,126-byte `AGIFONT`
  has SHA-256 `5978fce553c17b2903ab57e82745c3f00677abea4fef909b116275bf19953610`.
  Its Mac-style record starts at byte 12: characters 0–255, `widMax=8`,
  `kernMax=-30`, height 8, ascent 7, descent 1, leading 0, `rowWords=66`.
  The strike begins at byte 38 (132 bytes per row); location table at 1094;
  offset/width table at 1610. Each width entry's low byte is advance and high
  byte is offset plus the negative kernMax; `$ffff` selects glyph 256.
  Blank defined glyphs remain blank. `seg2+0x504b..0x5078` sets the cursor to
  `(8*column, 8*row+7)`; `seg2+0x539e` calls `DrawChar` (`$a404`). Thus the
  interpreter's fixed cell placement, rather than each glyph's advance,
  determines text positions. Status, messages and input use this path.
  The renderer decodes a player's optional `AGIFONT` into fixed 8×8 cells.
  It validates the record and table bounds, monotonic strike locations and
  the verified eight-row, seven-ascent, one-descent metrics. Missing or invalid
  data falls back to a packed 2 KiB table of the project's own MIT drawings,
  adapted from its existing ASCII art with independently drawn accents and
  Mac Roman symbols. No original glyphs ship with the project. `AGIFONT` is
  auxiliary data: import, captured builds, remix and export preserve it, while
  the canonical playable set and resource revisions exclude it. Metadata establishes defined codes
  0, 9, 13, 17–20 and 32–216; blank codes are 0, 9, 13, 32, 37, 127, 202 and 216. Other codes select a project-drawn replacement box. Raw advances are
  zero for 0/13, nine for semicolon and eight otherwise; the interpreter's
  fixed eight-pixel placement supersedes these. Baseline is seven, ascent
  seven and descent one. Engine-private frame/cursor codes 1–7 retain the
  project's own shapes; those UI primitives are separate from game glyphs.
- **Input (fact; behavior correction separate).** `seg2+0x19cd` (`WriteInput`) formats string 0
  at `+0x19ff..0x1a1c`, draws the edit buffer at `+0x1a22..0x1a28`, then calls
  `WriteCur` at `+0x1a2e`. `WriteCur` (`+0x18bd`) reads byte `$0135`;
  `set.cursor.char` writes the first message byte there at `+0x19ba`.
  This is a suffix cursor, not the prompt prefix. SQ2 LOGIC 104 sets string
  0 to `>` and the cursor to `_`: the visible empty line is `>_`.
  `EditLine` at `seg2+0x16f8` subtracts `strlen(s0)` from 39, then
  `+0x171b..0x1726` subtracts one if the cursor is nonzero, bounded by v24.
  Earlier evidence incorrectly named `seg3+0x0f75` (menu construction) and
  omitted this cursor deduction. The capacity correction is recorded here;
  prompt composition and edit capacity belong to the input behavior correction,
  rather than this palette/font change.
- **Status (fact; already implemented).** At `statusseg+0x07a1..0x0861` the interpreter draws black
  on white: column 1 `Score:%d of %d  `, column 30 `Sound:%s` with `on ` or
  `off` (strings at `~arrays+0x1660..0x167e`). It uses the game font above. The captured status pixels match,
  excluding glyph interiors and the original mouse arrow overlapping the top-left corner.
- **Message windows (fact; already implemented).** `seg2+0x4a62..0x4b84`
  uses `PaintRect` and a one-pixel `FrameRect`, red index 4 inset by two
  pixels. Inclusive bounds are `[8*left-10, 8*(left+cols)+9]` by
  `[8*top-5, 8*(top+rows)+4]`. See F-Text-03 for the common placement and
  wrapping contract. MAME message-frame pixels match after palette selection;
  glyph interiors use project drawings. Differences outside the window are
  described below.
- **Screen mode (fact); physical aspect (unverified).**
  `initscrseg+0x00fe..0x010d` constructs a 320×200 port; `main+0x1584`
  writes the Super Hi-Res screen at `$e1:2000`. A picture pixel occupies
  two horizontal display pixels; text cells are 8×8. MAME 0.289's
  `apple2gsr1` screenshot is 704×231 with an active 640×200 rectangle at
  `(32,16)`. Halving that rectangle horizontally gives the native 320×200
  grid. This proves raster geometry, not a physical monitor's pixel aspect.
  The app's existing original-proportions/square-pixel setting is unchanged.
- **Menus and mouse (observed divergence; not implemented).** A headless
  MAME capture with the Sierra menu open shows a 13-pixel menu bar, text
  beginning at y=3, and glyph shapes different from AGIFONT (including
  lowercase `i` and `l`). The interpreter constructs native menus in `seg3`;
  the executable has no `SetSysFont` (`$b204`) call. Inference: these are
  QuickDraw's system-font menus, not the game-port font. The precise system
  font bitmap source and menu geometry still require separate binary
  verification. The app currently retains its cell-based menus and browser
  pointer. An original arrow at x=0..6, y=0..9 accounts for 41 differing
  pixels in otherwise exact title/chapter captures. These captures do not
  establish full native-menu or mouse-cursor fidelity.

Verification: headless MAME 0.289, `apple2gsr1`, original disk-image SHA-256
`b0f08338a2ccb8706097c62b40e537ba53fe9d22c7d8dfeedeebae6ec271b553` and
`6c3b701e0983ecdf709450a8563b93bf016e55c4bd589a4339835ebfa9210596`.
Nearest-neighbour normalization only. Frame comparisons mask foreground glyph
pixels within occupied text cells, leaving background pixels, cell spacing,
window frames and all other pixels subject to exact comparison. Unit tests
assert 8×8 cells, baseline seven, eight-pixel advance, character coverage and
exact foreground/background RGB values. The native pointer and later animated
poses remain divergences; these captures do not establish full look fidelity.
With the player's font, the title and chapter captures differ at 41 native-pointer
pixels and 26 input-line pixels: the current input path places the cursor before
text and omits string 0. That composition belongs to the input behavior correction.
The later beep/message captures additionally differ in the animated character and
broom region; independently timed captures do not establish identical animation
phase. Palette, status text and message-window pixels outside those regions match.
These are cross-checks of the binary findings, not a zero-difference target.
Commercial resources and captured frames remain local evidence.

| Aspect         | Evidence                                        | Coverage                                                   |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Palette        | RGB12 table and MAME frames                     | Exact 16-colour mapping                                    |
| Game font      | Font metadata and fixed-cell DrawChar placement | Player font or project drawings; exact metrics and colours |
| Status         | `statusseg+0x07a1..0x0861`, captured row        | Text placement/colours; pointer remains different          |
| Input          | `seg2+0x19cd..0x1a2e`                           | Binary order verified; input correction separate           |
| Message window | `seg2+0x4a62..0x4b84`, captured chapter frame   | Exact frame geometry; glyph interiors masked               |
| Raster         | 320×200 port and 640×200 MAME active area       | Exact logical geometry; existing aspect setting            |
| Menus          | Native-menu capture and `seg3`                  | Divergence; cell menus remain                              |
| Mouse pointer  | Original arrow in captured status corner        | Divergence; browser pointer remains                        |

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

**Host model:** `0xaf`/`0xb0` arm the fade watchdog described under
[Apple IIgs sound fade](#apple-iigs-sound-fade-fact--host-limitation); `0xb1` terminates the session through the normal
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
six blocks, each prefixed by a little-endian u16 length.
[Execution of the writer and reader](#original-save-file-interoperability) corrects
the earlier high-byte-first inference:

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
reader. No shipped IIgs save image exists in the fixture; controlled
writer captures and reader execution now verify the layout and bytes. The writer's far pointers resolve through the
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

All 72 SND resources differ from the PC edition. The player (`seg3`) reads
the resource's first word as its type (seg3+0x1448): 1 is a sampled note,
anything else an event stream. Everything after the type word is the sound's
data. The interpreter writes no `$C03x` DOC registers itself; it drives the
chip through the Note Synthesizer (toolset `$19`) and Sound Manager (toolset
`$08`).

**Wave RAM.** At startup (seg3+0x2155) the player reads
`data/sierrastandard` in eight 8 KiB chunks and writes each to DOC RAM with
`WriteRamBlock(buffer, page, $1FFF)` (seg3+0x2275), then calls
`NSStartUp(150)` — a 60 Hz update rate, in the toolbox's 0.4 Hz units. The
`$1FFF` count leaves the last byte of every 8 KiB page unwritten; what the
chip holds there is unknown, and the app keeps the file's byte (the file's
bytes at those offsets are nonzero, so this matters only if the chip's
content there is zero, which would halt an oscillator crossing it). The file
is not parsed: instruments address it by page.

**Instruments.** 28 Note Synthesizer instrument records tile
`~globals+0x04BC`..`0x09C8`, in the layout of Apple's Note Synthesizer ERS:
eight envelope segments `{breakpoint u8, increment u16le}`, then release
segment, priority increment, pitch-bend range, vibrato depth and speed, a
spare byte, the A and B wave counts, and six-byte wave entries `{top key,
DOC page, size/resolution, DOC mode, relative pitch i16le}`. A 50-entry
program map at `~globals+0x0A08` holds far pointers that the OMF loader's
relocation records fill in (the file image holds zeros there). Programs
without an instrument, and every channel before its first program change,
use the record at `~globals+0x05C4`: a four-way key-split instrument.

**Event streams (type 2, 23 sounds).** The heartbeat (seg3+0x1dcd) first
spends a pending delay: a nonzero delay is decremented and the tick ends
(+0x1e3d). Otherwise it loops (+0x1e49..+0x1e6b): in the timing state a byte
adds its value to the delay and switches to the event state — `0xf8` instead
stores 255 and stays in the timing state (+0x1e7d); in the event state one
event runs and returns to the timing state (+0x1ec8). An event therefore runs
exactly its timing byte's value in ticks after the previous one, and events
behind zero timing bytes run in the same tick. A status byte (bit 7) sets the
class and channel; a data byte keeps the running status. The handlers:

| Class | Handler | Data | Effect                                                                                                                                       |
| ----- | ------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `8n`  | +0x1f42 | 2    | releases the channel's first generator holding the note                                                                                      |
| `9n`  | +0x1fb5 | 2    | `AllocGen`, then `NoteOn(gen, note, volume[ch], instrument[ch])` — the note byte is the semitone, unmodified; velocity 0 is a note-off       |
| `Bn`  | +0x20a3 | 2    | stores the value as the channel's note volume for **any** controller; controller 7 also sets the volume of the channel's sounding generators |
| `Cn`  | +0x205b | 1    | selects the channel's instrument through the program map                                                                                     |
| `Fn`  | +0x2333 | 0    | channel 12 (`0xfc`) ends the sound; other channels do nothing                                                                                |

Other classes have no handler, so their data bytes are read as timing bytes.
Velocity never reaches the synthesizer, and nothing transposes the note.
Every shipped stream ends with `0xfc`. The engine reproduces this timing
exactly ([sound.ts](../src/sound/sound.ts)); an earlier model that spent a
tick on each timing read and each event played the streams 30–40% slow.

**Sampled notes (type 1, 49 sounds).** The data holds the semitone, volume,
wave offset (`0x2c` in every resource) and byte count as u16le words, then an
instrument record at data+8 and unsigned 8-bit PCM at data+8+0x2c
(seg3+0x1460). E.g. snd 1 (7,791 bytes): semitone `0x33`, volume `0x5a`. On a
new sample the player turns all notes off, shuts the synthesizer down, writes
the PCM to DOC RAM `$C000` with `WriteRamBlock`, restarts it, and plays
`NoteOn` on the embedded instrument, whose waves point at page `$C0`. The
heartbeat polls `FFSoundDoneStatus` (`$1408`, seg3+0x1e29) until the
generator halts. There is no `FFStartSound` call. Every embedded envelope
sustains, so only the Ensoniq DOC stops the note: it halts an oscillator on a
zero sample, or at the end of its table in one-shot mode. 33 samples end with
a zero byte. The other 16 fill their table exactly (the byte count equals
`256 << T`): four are one-shot and halt at the table's end, and twelve are
free-running loops — they play until the game stops the sound, and their done
flag never sets. The engine completes a halting sample at the first heartbeat
at or after its start plus bytes played / DOC byte rate. The byte rate uses
the same frequency word, relative pitch and resolution as the renderer;
see [IIgs DOC pitch, volume and headroom](#iigs-doc-pitch-volume-and-headroom).

**Rendering (host).** The app builds each note from its instrument: the A and
B wave entries whose exclusive upper key covers the semitone, each a table of
`256 << T` bytes from its DOC page, ending at its first zero byte; one-shot
waves play once and free-running waves loop (the swap mode's A/B hand-off is
approximated as a loop, and a halted oscillator is silent). Envelope levels
are logarithmic — 16 steps per 6 dB — and each segment ramps at
`increment / 256` levels per 60 Hz update; an increment of 0 sustains, and a
note-off jumps to the release segment. Envelope and note volume combine before
conversion to the DOC's 8-bit volume. Pitch, resolution and mix scaling follow
the evidence below. A game without `SIERRASTANDARD` or its `.SYS16`
falls back to a triangle per note. Tests:
[sound-playback.test.ts](../test/sound-playback.test.ts),
[iigs-synth.test.ts](../app/test/iigs-synth.test.ts).

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

**Host mapping:** without a GS system volume, `SoundPlayback.armFade`
latches a synthetic `0xff` budget. Each step now emits a `system-volume`
event before that heartbeat's notes; completion emits AllNotesOff followed
by restoration to `0xff`. ROM 01 `FF:41f3..425a` establishes the call's
meaning: generator `$ff` selects the system control, stores the full byte
and writes its upper nibble to `$C03C`. The app applies that nibble on a
separate gain bus for bank voices and the fallback synth; UI volume remains
independent. Linear gain `nibble / 15` is a host rendering assumption, not
a measurement of the physical master-volume circuit. The watchdog's replay
fields and event cursor positions keep their released representation.

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

Fact (SQ2.SYS16 `e1a2788f…`): one SetHeartBeat task (`main+0xeda`, re-armed
with count 1) runs the sound tick every heartbeat and, every third heartbeat,
the timer at `main+0x186f`: the 32-bit tick count, then the pause gate, then
the pacing counter and the v11 cascade (`== 20`). The pacing wait at
`main+0x1901..0x1911` is `lda v10; and #$00ff; cmp pacing; bcs loop`, looping
while `v10 >= pacing`, then clears the counter: a pass needs v10 + 1 timer
ticks, and v10 = 0 still waits one tick (20 passes a second). The engine
applies this through `profile.pacingAdmission: "exceeds-v10"`
(`Engine.pacingDelay`); the regression in
[original-scheduler.test.ts](../test/original-scheduler.test.ts) failed first, and
the MAME walk comparison of SQ2 IIgs matched the original's 15 pixels per 1.5 s
only after the change. Inference: the heartbeat is 60 Hz; a 50 Hz IIgs was not
examined.

#### Apple IIgs sound discard

Action 0xae is `discard.sound` on the IIgs, not `set.pri.base` (the action
table at `~arrays+0x3fe` sends it to `seg3+0x1c73`; **fact**). It reads the
sound number as an immediate, looks the sound up (`jsl $0019bd`), raises
error 9 if it is not loaded, records replay type 9 through the resource
recorder (`seg2+0x3d0a`, which skips recording while flag 7 is set), cuts the
loaded-sound list at that sound — releasing it and every sound loaded after
it — and frees the memory around an object-list erase/redraw. A playing sound
is not stopped. The engine keeps the loaded sounds in load order and replays
type 9 on restore. Tests: [port-handlers.test.ts](../test/port-handlers.test.ts).

#### IIgs profile fields verified from the handlers

Values that change behavior, confirmed at the addresses given (**fact**):

| Field                         | Value                   | Evidence                                                                                                                     |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `menuInputAction`             | noop                    | 0xa1 → `seg3+0x142f`, which returns the operand pointer unchanged                                                            |
| `inputWidthActions`           | noop                    | 0xa3/0xa4 → `seg2+0x3bb8`/`+0x3be4`, the same pure stub                                                                      |
| `priorityBaseAction`          | noop                    | 0xae is the [sound discard](#apple-iigs-sound-discard)                                                                       |
| `objectDistanceCap`           | 255                     | `collide+0x313`: `sbc #$00ff` and a signed test store 255 for any sum of 255 or more, the value an undrawn object also reads |
| `heapDiagnosticExtraLine`     | false                   | `show.mem` (memmgrseg+0xc1) prints heapsize, now/max, max script and "Sys RAM"; no "rm.0" line                               |
| `patternProfile`              | `center-row-320`        | [Original Amiga and IIgs pattern brushes](#original-amiga-and-iigs-pattern-brushes)                                          |
| `windowFrameGeometry`         | `iigs`                  | `OpenWndw` (`seg2+0x4a62..0x4b84`): `_PaintRect` white fill (`8·cols+20` × `8·rows+10`) plus 1-px red `_FrameRect` inset 2   |
| `inputLineEditCap`            | `iigs-39`               | `EditLine` (`seg2+0x16f8..0x1726`): `min(var[24], 39 - strlen(s0) - (cursor != 0))`                                          |
| `keypadWordsNormalized`       | false                   | `ButtonToChar` (`eventseg+0x351..0x39d`) maps `0x0101..0x0401 -> 0x0d` without PC keypad scan words                          |
| `playerControlMotionClear`    | `on-control-transition` | `player.control` (`motionseg+0x02b2`): `lda $011d; bne ret` skips clearing ego motion `+0x38` when `$011d` is already 1      |
| `restoreRewritesMachineState` | false                   | `restore.game` (`seg2+0x0000..0x0272`, tail `seg2+0x01bc..`) writes `f12 = 1` without touching `v20`, `v22`, `v26`, or `f11` |

`timedPrintClearsV21` stays true: the timed wait (`seg2+0x22a8`, v21 at
`$0302f3`) zeroes v21 as it closes (`seg2+0x2340`). `menuInteractionGate`
and `releaseGateClearAction` have no slot (0xb1 is the wild dispatch, 0xb5 is
past the table) and `closeWindowClearsInputWidth` has no state to clear.

The scan found the rest matching the 2.936 contract, spot-checked:
`volumeHeaderBytes` 5, `inventoryMetadataEncrypted` true and
`inventoryEntryBytes` 3 (read off the shipped files), `exitAlwaysImmediate`
false (quit's selector 1 exits at once, others confirm), `menuActions` full,
`releaseGateAction` increment (`seg3+0xecc` `inc $0080`), `roomAliases` null,
`wordSequenceTailTerminator` true (`main+0x2284`), `positionActionOrder`
store-together, `earlierPartitionOrder` drawing-key, `packedViewLoopHeader`
false, `targetMotionDeferred` false, `inventorySelector` true,
`showPictureClearsF15` and `printConsumesF15` true (flagseg calls with 15),
`clampExactZeroLeftBoundary` false, `pictureMaxCommand` 0xfa,
`restartPromptBypassedByF16` true (flag 16 tested before the prompt),
`saveBlock3Xor` false (the save writer never calls `encryptseg`),
`preLogicDirectionMirror` true (`main+0x0386..0x03c4`),
`defaultScriptBufferPairs` 50 and `scriptSizeResetsSequence` true
(`seg2+0x3d36`), `keyByteStoredBeforeEdit` true (`seg2+0x1113`),
`modalDismissalKeys` `enter-escape` (`ChkAcAb` `seg2+0x0b79..0x0bbf`),
`inventoryListEndsOnAnyEvent` true (`statusseg+0x0206`),
`originalTextWindows` true (`seg2+0x2bcb..0x2c13`) and `statusLineFormat` `common`
(`statusseg+0x07a1..0x0861`),
`parserStopsAtTenthWord` true (`main+0x1f35`), `originalInputCapacity` true
(`seg2+0x16f8..0x1726`), `originalRestartRestore` true
(`restart.game` `seg2+0x0311`, `restore.game` `seg2+0x0000`), and `soundStopsBeforeFault` true
(`soundseg+0x004a`).
`soundEnvelope` is inert: the IIgs driver has no Paula envelope.

### Tandy PSG clock

**Evidence class:** hardware documentation, combined with the original divisor
write evidence in [PC sound](#pc-sound),
[Original sound player audit](#original-sound-player-audit) and
[SN76489 attenuation latching](#sn76489-attenuation-latching-and-rest-notes).
The [Tandy 1000 SX Technical Reference Manual](https://www.lo-tech.co.uk/downloads/manuals/tandy/Tandy_1000SX_Technical_Reference_Manual.pdf)
audio/joystick schematic, sheet 7 of 10 (PDF page 72), connects `CLK358`
to the SN76496's clock pin 14. Its Timing Control Generator specification
defines that clock as the 28.63636 MHz oscillator divided by eight:
3,579,545 Hz. The [TI SN76489 family data sheet](https://map.grauw.nl/resources/sound/texas_instruments_sn76489an.pdf)
defines a tone counter clocked at input / 16 and toggling after each divisor
count, hence tone frequency `3579545 / (32 * divisor)`.

The renderer now uses that PSG clock independently of the PC speaker's
1,193,180 Hz PIT clock. Divisor 226 gives 494.9592090707965 Hz on the PSG;
speaker divisor 2,712 gives 439.9631268436578 Hz. Original resource divisor
bytes, profile selection and the speaker path retain their existing contracts.
The same PSG constant drives SOUND previews, decoded frequencies, note-name
editing, MIDI import/export and VGM clock conversion. An authored A4 uses
divisor 254 (440.39677657480314 Hz); C4 uses 428 (261.3569655373832 Hz).
Existing resources retain their stored native divisors. The editor and agent
feedback display pitches using this clock as well.
New preset applications encode their named notes through the same conversion.
[audio.test.ts](../app/test/audio.test.ts) failed with the shared clock and
passes with these hand-computed frequencies. The same 16 PQ1 publisher-note
windows used in the MAME comparison have median error +0.0032 cents after
the correction, versus -203.8781 cents before. The subsequent
[PCjr and Tandy noise](#pcjr-and-tandy-noise) change uses the same clock.

### PCjr and Tandy noise

**Evidence class:** manufacturer hardware documentation for chip identities,
mode, clock and rate; reported hardware sampling for exact feedback and reset.
The generator is independently written from these behavioral descriptions.
Original AGI port-write evidence is recorded in
[SN76489 attenuation latching](#sn76489-attenuation-latching-and-rest-notes).

The [IBM PCjr Technical Reference](https://bitsavers.trailing-edge.com/pdf/ibm/pc/pc_jr/PCjr_Technical_Reference_Nov83.pdf),
Sound Subsystem, identifies the TI SN76496N. The
[original Tandy 1000 manual](https://manualzz.com/doc/54837143/tandy-1000-ms-dos-technical-reference-manual)
includes the TI SN76496 specification and sound schematic. The
[SX manual](https://www.lo-tech.co.uk/downloads/manuals/tandy/Tandy_1000SX_Technical_Reference_Manual.pdf)
also depicts that part. The
[HX manual](https://www.lo-tech.co.uk/downloads/manuals/tandy/Tandy_1000HX_Technical_Reference_Manual.pdf)
includes NCR's own 8496 datasheet (Devices section, PDF pages 313–325).
Section 2.3 on PDF pages 320–321 specifies XNOR noise feedback, white/periodic
selection and shift rates input clock / 512, / 1024, / 2048 or tone generator 3's
output. At 3,579,545 Hz the fixed rates are 6,991.298828125, 3,495.6494140625 and
1,747.82470703125 shifts per second. Coupled mode shifts once per complete
tone-2 period, `3579545 / (32 * divisor)`; zero selects divisor 1,024.

Hardware identity has a production boundary as well as a model boundary:

| Machine                   | Chip                   | Evidence and limits                                                                                                                                                                                                    |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCjr                      | TI SN76496             | IBM technical reference.                                                                                                                                                                                               |
| Tandy 1000, A, HD         | TI SN76496             | Original 1000 manual; A/HD production identities rely on component reports.                                                                                                                                            |
| Tandy EX, SX              | TI SN76496 or NCR 8496 | SX schematic shows TI; mixed production is reported in the [component survey](https://nerdlypleasures.blogspot.com/2015/10/the-journey-of-pcjrtandy-sound-chip.html). Board-specific identity needs a component check. |
| Tandy HX, TX              | NCR 8496               | HX manufacturer datasheet and schematic; TX identity also appears in the component survey.                                                                                                                             |
| Tandy SL, TL, RL families | PSSJ                   | Integrated sound core; the component survey identifies the NCR-derived core. Exact PSSJ revisions have thinner evidence.                                                                                               |

Interpreter versions can run on several of these machines. The profile's
`psgNoise` is a representative playback choice: PC profiles 2.001 through
2.440 use the TI SN76496; common-family 2.917, 2.936 and 3.002.x use the NCR
8496, representing an NCR-equipped SX/HX/TX. This is a presentation policy,
with the era and available hardware as its basis. It establishes no particular
board identity for a game's interpreter. Amiga and IIgs use their existing
output families. PSG events carry optional chip metadata on noise writes;
the renderer also accepts SN76489 and PSSJ-3 for an explicit hardware selection.
The profile ids and saved interpreter replay state keep their existing format.

The detailed sequence follows the hardware-sampling findings recorded in the
[MAME chip investigation history](https://github.com/mamedev/mame/blob/mame0289/src/devices/sound/sn76496.cpp),
including the 2010 periodic-ring correction and 2018 NCR/PSSJ findings. These
are reported measurements, with exact tap/reset behavior still awaiting an
independent silicon capture. MAME's general Tandy machine selection is broader
than the hardware identities above.

Bit numbering below uses a right shift and output at bit 0. Storage width
includes output stages after the 15-stage feedback ring; this explains the
different width and tap labels in descriptions of the chip's physical ring.

| Chip               | Storage width | White feedback into highest bit | Output voltage | Register reset             |
| ------------------ | ------------- | ------------------------------- | -------------- | -------------------------- |
| SN76489            | 15            | bit 0 XOR bit 1                 | Negated        | Every noise write          |
| SN76489A / SN76496 | 17            | bit 2 XOR bit 3                 | Positive       | Every noise write          |
| NCR 8496           | 16            | bit 1 XNOR bit 5                | Negated        | White/periodic bit changes |
| PSSJ-3             | 16            | bit 1 XNOR bit 5                | Positive       | White/periodic bit changes |

Reset seeds the highest storage bit and clears the other storage bits.
Periodic mode feeds back the first tap alone: a single pulse every 15 shifts,
with the variant's output delay at startup. A register reset leaves the held
output and pending shift edge in place. Rate writes and both bytes of a tone-2
update take effect after that pending edge. Preserving the output flip-flop and
counter phase is inferred from the counter model and emulator behavior; it has
yet to receive an independent silicon measurement. Attenuation remains latched through
the existing gain path; data-only noise/attenuation writes keep their existing
ignored-byte contract. Natural SOUND completion leaves the quiet PSG clocking;
an explicit audio transport stop releases it.

[psg-noise.test.ts](../test/psg-noise.test.ts) checks hand-computed bits,
periodic rates, repeated/rate/mode writes and shift-counter phase.
[audio.test.ts](../app/test/audio.test.ts) checks actual buffer bits, held DAC
frames, variant selection, tone-2 updates and quiet SOUND boundaries.
Web Audio plays complete deterministic sequences with their transient prefix
outside the loop. Each bit occupies 32 frames before resampling, keeping the
DAC level flat for most of the shift interval. The analogue amplifier, output
filter, cold-boot divider phase and exact resampler remain presentation limits.

### IIgs DOC pitch, volume and headroom

**Evidence class:** original 65816 machine-code inspection, observed DOC bus
writes during original SQ2 execution, and chip documentation. Inputs are the
SQ2 1.014 disk interpreter and wave RAM identified in
[Original games through MAME audio](#original-games-through-mame-audio),
Apple ROM 01 `342-0077-b` SHA-256
`34cd454c6201bfd26839d6ace2ff6b1231e09d6279e49b4890311756dc3825fb`,
and the disk's loaded Note Synthesizer `TOOL025` SHA-256
`611fcd90f75ba50f63657d611a9caf1c10dfd93b006c839b584b923df65abe86`.
Offsets below refer to the tool's loaded OMF segment, rather than resource
LOGIC bytecode or file offsets. Its code base in the observed boot was
`04:e8a9`. Original code and bulk disassembly remain private.

**Clock and address rate.** ROM Sound Manager initialization at
`FF:3ebd..3ed3` writes `$3e` to DOC register `$e1`, enabling all 32
oscillators. Note Synthesizer startup at `TOOL025+0105..0147` configures
oscillator 14 as its interrupt timer, with frequency word 300, volume zero,
size/resolution zero and control `$08` for `NSStartUp(150)`.
The [ICS1261 / Ensoniq 5503 DOC data sheet](https://audiopro.r-massive.com/Ensoniq/Schematics/ICS1261%20%28rebadged%205503%20DOC%29.pdf),
pages 3–5, specifies the master clock divided by eight, one slot per enabled
oscillator plus two refresh slots, and a 24-bit phase accumulator.
With the capture system's nominal 7,159,090 Hz DOC clock and 32 enabled oscillators, scan rate is
`7159090 / (8 * 34)` Hz. Table size `T` selects `256 << T` bytes and
resolution `R` selects accumulator address bits: byte rate is
`scan * frequencyWord / 2^(9 + R - T)`. Table size also masks the low
wave-pointer bits. Resolution and table size have separate effects.

**Note setup.** SQ2 `seg3+1fb5..205b` passes the resource note unchanged,
uses the channel volume rather than note-on velocity, and selects the
instrument through its relocated program map. `TOOL025+0311..0347` selects
each A/B wave using `note < topKey`. At `+0349..0368` it adds the signed
relative pitch to `note << 8`; the carry from A survives into B's addition.
The pitch conversion at `+074a..076b` discards the low pitch bit, indexes
1,536 fractional-semitone words at `+0a4c..164b`, then shifts by octave.
The independently calculated `floor(20905.466 * 2^(fraction / 3072))`
matches all 1,536 observed words before their integer octave shifts. This
replaces the earlier 69 = 440 Hz / 256-byte-wave inference. For example,
note 69 with relative pitch +256 produces frequency word 1,164 and byte
rate 59,837.29291130515 Hz at `T=R=0`.

The bus capture agrees with this decoding: at the intro's first notes,
oscillators 0/1 receive frequency words 217/216, volume 188, page 4 and
size/resolution `$12`; percussion oscillators 16/17 receive frequency 163,
volume 63, page `$88` and size/resolution `$1b`. A later instrument-20 pair
receives 1,042/1,043, confirming the A-to-B carry. The eight intro channels
select programs 40, 41, 20, 32, 20, 35, 1 and 40. Their instruments use
`R=T`, with free-running or one-shot oscillators. Swap and sync modes are
absent from this intro; their existing host approximations remain.

**Volume and envelope.** The envelope updater at `+05f7..0683` advances
signed 8.8 levels, clamps at a breakpoint and proceeds to the next segment.
At `+0613..063e` the envelope's integer level and note volume combine as
`max(0, level + volume - 127)` before lookup in a 128-entry byte-volume table
at `+094c..09cb`; both oscillators receive the result. Independent exponential
calculation `max(1, floor(255 * 2^((index - 127) / 16)))` matches that table
with upward rounding by one at indices 44, 60, 76, 92 and 108. For example,
envelope 90 and note volume 96 produce register value 13, while two levels
of 111 produce 63. The host schedules every active envelope update as a byte-volume write,
including repeated byte values. NoteOn's initial update, integer breakpoint
clamps and NoteOff's transition follow the instructions described in
[PC and IIgs sound streams](#pc-and-iigs-sound-streams). Controller 7 is a
direct Sound Manager byte write to the channel's mapped generators; it does
not change NS's original note-volume operand. A released generator's channel
mapping has been cleared, so this controller skips it.

**Headroom.** The DOC multiplies an 8-bit wave sample by an 8-bit volume and
time-multiplexes its enabled oscillators. The host's wave and volume are
already normalized by 128 and 255, so a mix gain of `1/32` bounds a physical
32-oscillator sum by one. Zero data halts an oscillator; the largest sounding
sample magnitude is 127/128. This scale preserves relative oscillator levels
and is independent of the tune. The real SQ2 intro graph at master 1 now
has zero over-range samples. This fixture result covers the Web Audio graph;
the mathematical bound alone does not cover resampler overshoot. Original
`AllocGen` at `+01f4..0249` manages 14 paired generators by priority and
allocation age; the host now models this bound and the channel-slot tables.
A DOC halt does not itself free an NS generator; its envelope lifetime
controls allocation. Tests also cover this distinction for one-shot waves.

**Regression and comparison.** Hand-computed tests in
[iigs-synth.test.ts](../app/test/iigs-synth.test.ts) failed first for pitch,
resolution, key splits, pointer masking, paired carry, volume and mix gain.
[sound-playback.test.ts](../test/sound-playback.test.ts) covers sampled-note
completion using the same byte rate, including its first-tick start.
[paula-offline.test.ts](../app/test/paula-offline.test.ts) failed with an SQ2
full-gain peak of 6.27356 and now checks that the real intro stays within full
scale, skipping explicitly when its private fixture is absent.

The stored MAME capture and corrected 48 kHz float render use the same
45-second window and 20 Hz DC-removal highpass. Results are:

| SQ2 IIgs measurement             |   Before |   After |              MAME |
| -------------------------------- | -------: | ------: | ----------------: |
| Peak at master 1                 |  6.27350 | 0.08289 | Uncalibrated gain |
| AC RMS at master 1               |  1.14851 | 0.01544 | Uncalibrated gain |
| Samples over unity at master 0.5 |  8.7846% |      0% | Uncalibrated gain |
| AC energy above 4 kHz            | 27.9969% | 3.7000% |           2.1391% |

Separate host channel renders show the bass channel 3 changing from -1.60 dB
to +0.84 dB relative to channel 0, and percussion channel 6 from -8.46 dB to
-5.19 dB. These measure host balance before and after; the stored mixed MAME
capture does not isolate individual voices. The residual high-band difference
has an unresolved cause. Web Audio interpolates the wave buffers, whereas
the DOC addresses discrete bytes at its scan rate. Native DOC output holding,
analogue filtering and envelope timing remain separate evidence questions;
no equalizer or inferred instrument remapping was added. Listening pairs
use one AC-RMS match and common peak-safe gain, with MAME followed by the
corrected render. Absolute GS system gain remains uncalibrated.

### PC and IIgs sound streams

**Evidence class:** original x86 player execution in Unicorn 2.1.4,
65816 interpreter/tool/ROM inspection, and a fresh MAME 0.289 audio and DOC
bus cross-check. Original bytes and bulk disassembly stay local. MAME's
chip models establish a comparison, not physical chip truth.

**DOS builds (fact).** Each row identifies the decoded MZ executable,
matching data overlay and load-module player entry. The probe substitutes
only the flag-9 query, initializes the original player's channel records
and captures its unchanged port instructions. For each build, device 1/2
and v23 0/3/255 exercise four independent two-tick notes, one-tick zero-tone
rests and terminators: 72 cases, four ticks each. All captured port-$C0
byte streams match `SoundPlayback`. This establishes those vectors, not
exhaustive resource equivalence or hardware identity.

| Build     | Executable SHA-256                                                 | AGIDATA.OVL SHA-256                                                | Player   |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------- |
| 2.089     | `e31e5e8611c81d58ba2a8fcc63ecdf7ded767814324c66dfd73b6452f7199cb4` | `47b34a71bf394302f2826f5e43788b8b5ac0c3eaa1b853ef6bfb4713d0b48bde` | `0x7557` |
| 2.230     | `875547deb3d83b7ed2dd7578d357f43b6a5843a9ac8de1332245df9f60ff4570` | `33a327736deb611df48d0d3232c1958b00af1b1cae5fba45ed3aadf88871af8a` | `0x74da` |
| 2.272     | `a0c26b5dee86b6761d0996f463d9bed2b93ff356aa4fbb56a55d369501fb588a` | `2e2a695a4da7d545c52ea0c01556d198b6d0c3f7eba19e6cbc2b65642616ec40` | `0x7576` |
| 2.411     | `d99938d6622ef18556bea76ebe72214b18cecac7305b83885a1157ddcff539bf` | `1201f66b68f7f6e4ec24abadee5e6fe2d4390315cc56605d8b0b1e7828c96631` | `0x7c2b` |
| 2.440     | `c70e2f327eaad8dbcb1d526e9fb3f933b342329b84c6a803f9062c245ccb7676` | `5b696520d68d6b843711184a63c85cc313818e08cd0afc0452225a97939483a4` | `0x7d4e` |
| 2.903     | `db97accc32e48bac0c759a6364f48790830c90f14a1486be53d1f0b7899730a7` | `df46a3f13c360045b2d355e97bfad6cb6e1df77ee614fed7b4b1f89778425db3` | `0x7f42` |
| 2.917     | `bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04` | `f7ca256c1c0ab12509d695baabdd44a3c5e72a570b08118d3ead995a47f4c383` | `0x7f55` |
| 2.936     | `4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400` | `b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9` | `0x801c` |
| 3.002.086 | `b9b27b403015bb18f6562ba1b8b04c2829e0c3b53c042196bee7924d1df7be65` | `9738d643dd284d622cee7ee9897a4578ab27d376487ef38ed835c14dcf88d733` | `0x845b` |
| 3.002.102 | `7cf6eac9d5bbfbd944a2b5d7189878ffe4b2d608646d91c87d5372399fa9d1d0` | `1251a5365d5c74232bfb8b01819f85c31ff25c9cd358e942e349a055bc588ea1` | `0x8473` |
| 3.002.107 | `ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e` | `bb22a87cd215ed52154d49754493e0eb2f6be5688411d8f3b7ac17c417ddae1f` | `0x8473` |
| 3.002.149 | `12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41` | `914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804` | `0x8330` |

Zero-tone records write `00 00` before their attenuation in every DOS
build above. Early 2.089/2.230/2.272/2.411 terminators program the saved
`8f 00 9f`, `af 00 bf`, `cf 00 df`, `ef 00 ff` notes before the final
`9f bf df ff` stop. Build 2.440 skips the zero byte after `ef`; common
players write attenuation only at a terminator. Early terminator controls
use the same signed v23 conversion as live notes: v23 255 changes `9f`
to `9e` in 2.272/2.411/2.440. These previously omitted writes now reach
Play, Studio audition and offline preview through the shared sequencer.

The earlier [PC booter row finding](#pc-booter-sound-rows) remains distinct:
2.001's decoded executable SHA-256 is
`424da51a6c161cca8c7dfb9fd78e94b89a1d5301640c845999b54128d1bcd2dd`;
`7473..75b3` consumes device-specific rows. The 72 DOS vectors above do not
execute that separate row player; its speaker execution is covered below.

**Speaker (fact and rendering).** The early drivers compare the full
control byte with `9f`; common drivers additionally use base attenuation 15. Thus raw `bf` in the first channel enables the early speaker path.
The documented PlayNote sites and the 2.089 `7615` / 2.230 `7598` routines
establish this difference. The host treats a programmed PIT count zero as
65,536 and a null divisor as speaker-off. This fixes the former 0-Hz
render without changing the interpreter's divisor stream. Profile PSG
selection remains a representative machine policy; no binary identifies
whether its user's board contains TI, NCR or PSSJ silicon.

**IIgs 1.014 (facts).** The bootable disk interpreter SHA-256 is
`e5c414881d6b1a12f65ed662e2d179688b61ac3df713fec159577af5b2912678`.
Its `TOOL025` and ROM 01 hashes are pinned in
[IIgs DOC pitch, volume and headroom](#iigs-doc-pitch-volume-and-headroom).
The extracted interpreter has the same seg3 sound routine offsets as the
other 1.014 image already documented above.

- `TOOL025+01f4..0249` searches 14 generator priority bytes. It takes the
  first zero immediately; preceding positive priorities age by one with a
  floor of one. Without a free slot, the first strict minimum below the
  requested priority wins. SQ2 always requests 64 (`seg3+201c..2025`).
- `seg3+2029..202f` stores the note in the selected slot of that channel's
  table. `seg3+1f8b..1fa8` searches its slots downward, clears the matching
  entry and calls NoteOff with that slot and pitch. Stealing does not clear
  other channels' stale slot entries. NS checks the actual pitch before
  releasing (`TOOL025+0460..046e`). The host preserves these tables rather
  than assuming request order identifies the releasing generator.
- `TOOL025+03de..03f2` runs the initial envelope update at NoteOn.
  `+05f7..0683` advances a signed 8.8 level, clamps at a breakpoint, loads
  the next segment and writes the clamped level in that update. The branch
  at `+0683` targets `+0611`, not the increment at `+05f7`. A zero increment
  on a later update holds the previous DOC byte. Every other update writes
  both oscillator volumes even when the rounded byte repeats.
- NoteOff (`+0472..049a`) halves allocation priority, arms the release
  segment and sets a temporary target equal to the current level with
  increment one. The first following update holds that level and loads
  the release decrement; the next applies it. The host represents this
  transition on its event heartbeat. Exact native callback phase at release
  remains unmeasured and may differ by a heartbeat.
- The periodic loop `+0541..059f` frees an NS generator when its envelope
  returns zero. It does not poll for a halted DOC waveform. The host keeps
  this allocation lifetime independent of the audible waveform's end.
  Quiet browser loop sources stay bounded by the 14 slots and retire on
  replacement or stop; zero gain represents the envelope's silent end.
- Controller 7 (`seg3+20fc..2115`) walks the channel's mapped slots and
  calls `SetSoundVolume` directly. It changes neither the instrument nor
  NS's note-volume operand. The next active envelope update overwrites
  that raw byte, including when its exponential table value repeats.
- `TOOL025+03f2` calls the initial vibrato update at `NoteOn`. The periodic
  handler (`+0581..0590`) toggles voice status bit 7 and runs another update on
  odd heartbeats, at nominal times `0, 1/60, 3/60, ...`, across `NoteOff`.
  At `+0686..06c9`, the 8-bit phase advances by `vibratoSpeed`; a negative
  phase is folded with one's complement. The resulting `0..127` index selects
  the log-triangle byte table at `+09cc..0a4b`. An independent piecewise
  logarithmic fit in [iigsSynth.ts](../app/src/audio/iigsSynth.ts) matches all
  128 observed table bytes. The phase addition's carry survives into the
  table-byte plus depth addition, then `sbc #$7f` consumes that carry. A
  negative result gives zero delta; otherwise the byte-volume table at
  `+094c..09cb` supplies the magnitude. Negative phases apply one's complement
  before `asl`, giving `-2 * magnitude - 2`, versus `2 * magnitude` for positive
  phases. The delta is added to both saved A/B base pitches and converted at
  `+074a..076b`. A looping control buffer presents the full phase cycle to
  each oscillator's playback rate, preserving sustain and release without a
  duration cap. These controls retire with their voice on replacement or stop.
- Studio previews bind the selected project's files explicitly, including its
  IIgs instrument bank and a private DOC RAM image. They cannot inherit another
  game's bank through a global audio instance. Type-1 sample resources carry
  their own instrument and can render even without a `.SYS16` bank.

The fade's exact call operands, watchdog schedule, upper-nibble mapping
and synthetic maximum-volume latch are described in
[Apple IIgs sound fade](#apple-iigs-sound-fade-fact--host-limitation).

**Cross-check and limits.** Fresh MAME execution reaches SQ2's intro with
its original disk interpreter. The first program-32, note-60 generator at
volume 120 writes DOC volumes
`bc ac 9e 91 85 7a 70 66 5e 56 4f 48 42 3d 38 33 2f 2b`.
The independently computed NS envelope and byte-volume table produce the
same first 18 writes; the first A/B frequency words are 217/216. This
checks attack and early decay, not every release or allocation boundary.

Two further MAME 0.289 `apple2gsr1` executions redirect the title's SNDDIR
entry to existing `SOUND 68` and `SOUND 63`, leaving interpreter code unchanged.
The SOUND 68 run captures **26,881** DOC data writes. Its first allocation of
pair 8 (program 23, note 66, depth 75, speed 25) supplies **13** frequency-pair
updates; pair 0 (program 34, note 66, depth 30, speed 13) supplies **14**.
The SOUND 63 run captures **2,385** data writes, including **47** updates on
pair 16 (program 16, note 79, depth 66, speed 25), spanning multiple phase wraps.
Every captured frequency word in those three allocations matches `vibratoStep`
and `iigsByteRate`, including negative phases and A-to-B carry. Program 23 starts
`740/740, 743/743, 743/744, 740/741`; program 16 starts
`1562/1563, 1567/1568, 1568/1569, 1563/1564`.
The median periodic interval is about **33.058 ms**, versus the host's nominal
**33.333 ms**; matching frequency words does not establish wall-clock identity
with the DOC interrupt timer. The host retains its nominal 60 Hz envelope clock.

For SOUND 68, an eight-second span aligned by first audible onset uses MAME
channels 1/2 (DOC left/right; channel 0 is the boot speaker), host master 1,
and the same 40 Hz high-pass/Welch method as the Amiga comparison. Spectral
cosine similarity is **0.8634**, with **0.162%** host energy above 4 kHz versus
**0.271%** in MAME. The averaged host output peaks at **0.1225**, with no clipping.
The existing DOC output-holding approximation, nominal heartbeat difference,
release-phase limit and mixed-voice balance prevent a waveform-equivalence
claim; no gain or analogue filter was fitted to the MAME capture.

The fresh PQ1 Tandy capture reaches the original publisher music. Comparing
13 mixed note windows against the current 48 kHz host render gives median
pitch error -0.036 cents and maximum absolute error 1.318 cents. Eleven
windows fall within one cent; the two outside that bound contain overlapping
voices and remain unresolved. Median demodulated start/end residuals are
0/-1.42 ms, but continuing pitches produce ambiguous edges up to 812 ms and
the estimator's mixed-voice uncertainty is about 20 ms. These medians do not
establish an every-note, one-tick pass. Individual voice balance is unmeasured;
the reference is mixed. The IIgs first mixed wavetable partial measures
-1.16 cents in a 200 ms window; its detuned A/B pair and other concurrent
voices prevent a single-oscillator tuning verdict. Its 60-second host render
has peak 0.0862 at master 1, preserving headroom. No analogue filter or gain
was fitted to either MAME waveform.

The finite allocator, discrete envelopes and `TOOL025+0686..0749` vibrato
close identified host gaps. The following remaining differences have separate
scopes:

- **Swap and sync (documented limitation; unused in SQ2).**
  `docMode` bits 2:1 select sync/swap as 2/3. A scan of all SQ2 IIgs sound
  resources and their bank bindings finds neither mode in any used MIDI
  program (`0, 1, 2, 4, 5, 10, 11, 14, 16, 20, 23, 24, 32, 34, 35, 38,
40, 41, 42, 43`) or type-1 sample. All 98 sample waves use mode 0 or 1;
  swap waves exist only in unused bank programs. The host's independent
  buffers therefore leave a digital gap for other instruments, with no
  affected SQ2 cue identified. This is resource coverage, not general mode
  equivalence.
- **Vibrato frequency words (`TOOL025+0686..0749`, verified).** Used SQ2 programs 16, 23 and 34
  (active in sounds 63, 68, 71, 72, 73, 75, 76 and 77) and any custom
  instrument or type-1 sample with nonzero `vibratoDepth` and `vibratoSpeed`
  now step `vibratoStep` at `NoteOn` and on odd 60 Hz heartbeats across
  `NoteOff` in [iigsSynth.ts](../app/src/audio/iigsSynth.ts), matching the
  captured MAME DOC frequency words bit-for-bit in the private execution evidence.
  [iigs-synth.test.ts](../app/test/iigs-synth.test.ts) separately asserts hand-computed
  pitch offsets and their scheduled playback rates.
- **DOC sample holding (documented presentation limit).** The host omits
  scan-rate output holding. The measured high-frequency imaging difference
  is primarily above 4 kHz (about 3.7% versus 2.1% spectral energy). Its
  audible effect cannot be isolated from the hardware's analogue
  reconstruction filtering by the present mixed-output comparison. Keep
  that uncertainty separate from the exact frequency/volume words.
- **Release heartbeat phase (documented timing limit).** The temporary
  target and release decrement follow the original tool code, but the
  first host update uses the event heartbeat. Its phase can differ by at
  most one 60 Hz tick (16.7 ms). This is not expected to be perceptible;
  a native release trace would settle the phase.
- **Per-build voice balance (documented acoustic limit).** Digital
  attenuation and volume tables match the binary evidence. The captures
  do not isolate every voice, and acoustic balance depends on real
  hardware gain, speaker and analogue filtering. The mixed MAME results
  cannot certify a per-build acoustic balance match.

Web Audio interpolation and mono mixing versus MAME's separate DOC channels
also limit comparison. Real hardware is needed for silicon continuation/reset
behavior, DAC/master-volume transfer and analogue output filtering.

Hand-computed regressions live in
[sound-register-fidelity.test.ts](../test/sound-register-fidelity.test.ts),
[sound-preview.test.ts](../test/sound-preview.test.ts),
[audio.test.ts](../app/test/audio.test.ts) and
[iigs-synth.test.ts](../app/test/iigs-synth.test.ts).

### 2.001 speaker row execution

**Original-execution evidence.** Build 2.001 decoded executable SHA-256
`424da51a6c161cca8c7dfb9fd78e94b89a1d5301640c845999b54128d1bcd2dd`;
load-module reader `746b..755f`, speaker writer `7607..766a`, cleanup
`4b96..4bb8` / `7560..7575`. Unicorn 2.1.4 executes the unchanged reader,
writer and cleanup, substituting only the flag-9 query and hardware port
input (port 61 returns `a0`); port outputs are captured. Four synthetic
payloads, each with flag 9 set/clear, cover 40 entries including completed
entries. All PIT/control writes and completion entries match the host.
This establishes the command stream, not the physical speaker waveform.

**Facts.** Device 0 dispatches on the high nibble (`74c1..7553`). Selector
`80` consumes two bytes, computes `12 * ((first & 15) | ((second & 63) << 4))`
and calls the writer. Selector `90` consumes one byte and calls the writer
with zero only for exact `9f`. Selectors `a0/c0/e0` skip pairs and
`b0/d0/f0` skip single bytes. A pair's second byte can be zero without
ending the row. The writer gates every call on flag 9; zero disables the
speaker instead of programming PIT count 65,536. Nonzero counts write
`b6` to port 43, low/high bytes to port 42, then set port-61 bits 0/1.
The reader checks exhaustion at its next entry, so the final row holds
for its tick and cleanup occurs one entry later. Speaker cleanup also
passes through the flag-9 gate, including on an empty payload.

**Hand calculation.** `81 23` gives 6732 (`1a4c`, PIT bytes `4c 1a`);
`81 00` gives 12; `80 00` switches off; `8f 3f` gives 12276 (`2ff4`);
an unterminated `82 02` gives 408 (`0198`). Empty rows hold the last tone.
The shared sequencer now selects this speaker path for Play, Studio audition
and offline preview, including snapshot continuation and speaker stop.
Regressions in [sound-register-fidelity.test.ts](../test/sound-register-fidelity.test.ts)
failed before implementation.

**Bounds and remaining scope.** A speaker sound with period 0 branches to cleanup `0x4b96`
at `0x743d` while inactive: `cmp word [0xe74],0` / `jz 0x4bb5` (`0x4b9b..0x4ba0`) returns
early, so the original never sets the completion flag and never completes. The host
completes it on tick 1 as a deliberate bounded recovery. On malformed truncated pairs the host uses
zero for a missing continuation; original code reads past the payload. Unknown
selectors are ignored by the host; the original can loop without advancing.
Those are bounded recovery policies, not original valid-resource behavior.
The PSG row path does not apply 2.001 device-2 attenuation conversion. Those separate paths are outside this
speaker correction. No new MAME or real-hardware speaker measurement was made.

**Released recording migration.** The v1.2.4 engine split the entire payload,
including the period byte, at every zero. Its active booter playback always
carried countdown 1, advanced one old row per heartbeat and completed on the
last row. Replay state now writes version 2 only while carrying corrected booter
playback. Silent states and other profiles keep the released form and its
fingerprints; an omitted version retains released semantics. At the recording
restore boundary, the resource translates the old cursor to its consumed-byte
boundary, then selects the first corrected
row whose start is at or after that boundary. A partly consumed corrected row
is skipped in full, including any remaining writes. The next whole row runs on
the next heartbeat (countdown 0), then follows the resource's corrected period.
An exhausted stream, or period-zero speaker stream, cleans up and sets the done
flag on that next heartbeat. PSG uses its own zero-separated rows after the
period byte; it receives the same byte-boundary translation. This is a host
migration policy for old recordings, not evidence of original interpreter behavior.

For period 1 followed by five `81 00 00` groups, released cursor 7 maps to
corrected speaker cursor 4: the next heartbeat writes divisor 12, and the
following heartbeat completes. Impossible released active cursors, countdowns
and channel state are rejected before conversion; current playback bounds stay
unchanged. Tape replay, recorded tests, History boot/anchor restores and
retained earlier sessions share this migration. History viewing and rewind use
[historyDrive.ts](../app/src/worker/historyDrive.ts); Undo rewind and earlier-session
restores take `historyViewRestore` → `adoptResumePoint` in
[resumePoint.ts](../app/src/worker/resumePoint.ts). Both authenticate through
`fingerprintMatchesRecorded` in
[releasedHostImage.ts](../app/src/worker/releasedHostImage.ts): check the stored
fingerprint first, then independently derive the expected fingerprint from
`migrateRecordedReplayState` and compare the recaptured engine. Released checkpoints
without booter playback need no replay-state conversion.

Other comparison boundaries: the readers and PAL fallback in
[src/agent/history.ts](../src/agent/history.ts) authenticate stored bytes against
stored fingerprints without recapturing or migrating. The later History sync
checks compare observed game behavior, not replay-state representations, and stay
enabled. Rewind snapshots in [replay.ts](../app/src/worker/replay.ts) and launches
in [roomLaunch.ts](../app/src/worker/roomLaunch.ts) capture their current engine in
the same session; those checkpoints cannot contain released replay states.
Recorded tests in [gameTestsRunner.ts](../src/agent/gameTestsRunner.ts) run through
[Simulation](../src/agent/playtest.ts), which calls `Engine.restoreReplayState`
without comparing a recapture against a stored fingerprint. New History checkpoints
are stamped from current captures in [history.ts](../app/src/worker/history.ts).

The original image and replay bytes remain unchanged in
[sound-1.2.4.json.gz](../test/formats/sound-1.2.4.json.gz), gzip-compressed without
changing its JSON content, captured by tag v1.2.4
(`01fcce5d55ccea285a1e02d33a8b698cb220f754`) using synthetic resources. Tests
cover speaker and PSG, zero tone continuations, period zero/nonzero, partial
rows, an unterminated tail and near-end cursors, including the completion flag
and game logic after resume. The sound History wrappers were assembled using the
released stamper around real engine captures; they contain no recorded events or
later sync marks. A separate worker test retains all real post-anchor re-entry
and pause events from the released non-sound
[1.2.2 history](../app/test/formats/history-1.2.2-paused-reenter.json), checks its
final state and proves later sync-mark reachability is checked.

Checkpoint compatibility does not guarantee that a whole released booter-sound
timeline verifies: the earlier sound-timing correction changes future completion
times, so a later split-digest mark may report “diverged”. That would be a timing
compatibility difference from the earlier correction, not this migration. These
sound captures have no such later History marks and cannot establish that result;
the migration does not remove or weaken sync checks. Released combined-digest
marks remain unverified under the existing History compatibility policy.

### Original games through MAME audio

**Evidence class:** original interpreter execution on MAME 0.289 reconstructed
hardware. This supplements the machine-code findings above. Chip emulation,
resampling, output gain and analogue filtering remain separate evidence questions.
The comparison used `t1000sx`, `a500n` with Kickstart 1.3, and `apple2gsr1`.
MAME was operated through boot media, keyboard input, screen captures and WAV
output. Its implementation was neither inspected nor copied for this comparison.

PQ1 used PC 2.936 and Amiga 2.310. SQ2 used the original Amiga 2.202 disk and
the bootable IIgs 2MG edition, with its own extracted resources and instruments.
That IIgs interpreter identifies as 1.014; `SQ2.SYS16` SHA-256 is
`e5c414881d6b1a12f65ed662e2d179688b61ac3df713fec159577af5b2912678`.
It differs at file offsets `0x1f66` and `0xea94` from the unpacked interpreter
documented above: the disk has `af`, the unpacked file `22`, at both locations.
The instrument bank used for rendering came from this disk interpreter.
Its `SIERRASTANDARD` hash is the one recorded above. SQ2 Amiga's interpreter
SHA-256 is `557215fbbf431193e99578be53372496bd4bf1cfad7c4ba93a61968e5c760dec`;
its resources match the unpacked 2.202 fixture.

The offline app render booted the same resources through `Engine`, `CycleClock`
and 60 Hz sound packets into headless Chromium's `OfflineAudioContext` at
48 kHz. Master volume 0.1 preserved headroom. Four 45-second pairs start at
the first audible note. Individual SOUND calls were matched by cross-correlation
of pitched spectral energy; individual notes were refined with demodulated
envelope slopes and envelope correlation. Repeated effects, short notes and
overlapping partials retain explicit uncertainty. PQ1 Amiga's later intro SOUND
30 had low alignment confidence within this span: its logo sequence takes
longer on the original emulated machine than in the offline harness.

| Comparison                    | Measured pitch difference, app minus MAME                                                                                 | Other observations                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PQ1 Tandy, publisher SOUND 36 | Median -203.88 cents, 16 resolved spectral peaks                                                                          | Ten longer note windows have median start/end residuals -0.75/-0.83 ms; the demodulation method has about 20 ms mixed-voice uncertainty. |
| PQ1 Amiga, publisher SOUND 36 | Median -15.87 cents, 16 resolved spectral peaks                                                                           | Median start/end residuals +12.54/+1.00 ms in ten longer windows; output bandwidth differs substantially.                                |
| SQ2 Amiga, SOUND 60           | Median -15.85 cents, 162 resolved spectral peaks                                                                          | Median start/end residuals +34.42/+21.33 ms in 135 longer windows; drift and filter-dependent attacks need separate investigation.       |
| SQ2 IIgs, SOUND 60            | Dominant wavetable partials usually fall near their counterparts; dense mixtures prevent a single reliable tuning verdict | Strong level and instrument-balance differences; spectral alignment confidence 0.58, so note timing remains unresolved.                  |

**Tandy finding at capture.** The app used the PC speaker's `99431.67 / divisor` constant
for PSG oscillators. MAME reports an NCR8496 at 3,579,545 Hz; its measured tone
frequencies agree with `3579545 / (32 * divisor)`. The ratio predicts
-203.91 cents, matching the measured error. Original interpreter port-write
evidence in [Original sound player audit](#original-sound-player-audit) already
establishes the divisor bytes. This is a strong app presentation finding.
The next change should separate the PSG and speaker clocks and verify the
chosen Tandy hardware clock. The envelope contour of a held publisher note
supports approximately 2 dB attenuation steps. PQ1 SOUND 19 also exercises
noise: the app's random buffer and bandpass approximation need replacement
with independently specified chip behavior, including periodic noise and
tone-channel coupling. The exact NCR noise variant still needs hardware evidence.

**IIgs finding.** The unclipped offline render reaches 6.27 full-scale units
at master volume 1. At the app's default 0.5 setting, 8.78% of the stereo
samples in the compared span would exceed full scale. MAME's corresponding
DOC outputs have no clipped samples. Headroom is therefore the first app fix
to investigate. After level matching, the app remains much brighter: energy
above 4 kHz is approximately 28.0% of its AC spectrum, against 2.14% in the
reference. This does not identify a filter correction by itself. Verify the
Note Synthesizer's oscillator pairing, waveform resolution, volume conversion
and instrument envelopes against the original ROM/toolset before adjusting
voice balance. MAME exports separate DOC output channels; the app combines its
voices into mono. Their relationship to the stock IIgs speaker and an external
stereo adapter must be specified before treating this routing difference as a bug.

**Amiga boundary.** The requested NTSC reference runs at a different clock
from the app's PAL Paula constant. Their clock ratio predicts the measured
15.86-cent difference. Region selection is the appropriate follow-up.
The reference carries far more high harmonic energy than the app's documented
A500 RC and LED filter path. The original driver's register order remains the
authority for onset/offset work. A maximum adjacent-sample jump in a mixed WAV
also includes ordinary waveform transitions, so it cannot establish a click defect
on its own. This comparison leaves the analogue-filter coverage of MAME's
Paula path and its effective LED state unresolved.

**Capture limits.** MAME documents a default DC-removal highpass and optional
output effects in its [Audio Effects menu](https://docs.mamedev.org/usingmame/mamemenus.html#audio-effects-menu).
The headless `-sound none -wavwrite` files here retain separate output channels
and substantial Tandy DC. The listening comparison therefore applies a stated
20 Hz highpass to both members; untouched speaker-channel WAVs are retained.
No additional cabinet lowpass was selected. The declared filtered PC speaker
device is separate from the PSG. Analogue Tandy speaker response and IIgs DOC
output filtering were not established by this black-box run. Absolute MAME gain
and GS system-volume calibration remain unknown; clipping headroom and
level-matched timbre carry stronger conclusions than an absolute loudness ratio.

The original SQ2 PC TD0 fails in MAME's floppy conversion at cylinder 6,
head 0: `expected_size=100000, current_size=256032`. Its overlapping,
bad-CRC protection sectors cannot be represented as independent full sectors
within that DD track. A file copy reaches the original Sierra disk check and
does not pass it. This leaves SQ2 Tandy audio unmeasured; it supplies no chip
evidence. The extracted PC interpreter identifies as 2.936 and matches the
unpacked fixture, including `AGI` SHA-256
`2d4c5389e6665570f83f024cdbe9b369d048b864183d2921ca45e7f6758021cc`.
A preservation image that retains the protection track is needed for that pair.
The alternate IIgs PO dump also remained at its original-disk check; the 2MG
dump supplied the successful IIgs measurement. See the repeatable method in
[Testing](testing.md#original-interpreter-audio-comparison).

## Appendix D: Tooling and open questions

How to inventory, decode, disassemble and probe an original interpreter without
committing any of its bytes, and which questions the evidence above leaves
open.

### Inspecting an interpreter

PC offsets in this document are load-module offsets unless marked as DS
offsets.

**Static inventory.** Inventory contributor-supplied fixtures without executing
code or exporting binary data:

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

**Disassembly.** v3 `AGI` executables disassemble directly. Set `HEADER_BYTES` from that image's
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

**v2 loader scrambling.** The v2 scrambling XORs each 128-byte block with the evolving 128-byte key at
loader file offset 0x41. Initial carry is zero. After each block, rotate each
key byte through carry, from byte 0 through byte 127; OR the final carry into
byte 0's high bit. The loader's saved flags also retain that final carry for
rotation of the next block. This is not a simple circular rotation.

Two tempting shortcuts are wrong: initializing carry from byte 0 each block,
and omitting the final wrap. Either produces corrupt instructions in otherwise
plausible images, and synthetic carry regressions fail against both. No
original instruction was patched or guessed. The independent
[loader probe](../scripts/probe-interpreter-loader.py) executes the original
COM routine and compares **every output byte** with the TypeScript CLI:

| Input            | COM routine offset (loaded at 0x100) | Bytes compared |
| ---------------- | ------------------------------------ | -------------- |
| KQ1 / KQ1.COM    | 0x9f4                                | 39,424         |
| KQ2 / SIERRA.COM | 0x969                                | 38,400         |
| KQ3 / SIERRA.COM | 0x9f4                                | 39,424         |
| BC / BC.COM      | 0x96d                                | 38,400         |
| SQ2 / SIERRA.COM | 0x9f4                                | 39,424         |

All five comparisons pass. Decoded SHA-256 identities are listed under
[Verified inputs](#verified-inputs). Reproduce
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

| Investigation                          | Current evidence and remaining acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler and modal timing             | [Coupled original IRQ, pacing and modal execution](#original-scheduler-and-modal-timing) covers representative v2/v3 builds, delay changes, backlogs and wait classes. Full-machine interrupt arrival, physical clock accuracy and successful disk-transfer latency remain outside this evidence.                                                                                                                                                                                                                                                                                                                                                                                     |
| Startup and restore reconstruction     | [Startup, reconstruction and main-loop control execution](#startup-and-reconstruction-execution) establishes cold defaults, lazy RNG seeding, resource replay, follower reset and same-cycle re-entry in two builds. Actual resource bodies, full DOS startup and object bit 0x8000 remain unverified; controlled file interoperability is covered by the [separate API](#original-save-file-interoperability).                                                                                                                                                                                                                                                                       |
| Complete movement and collision passes | [Original dispatcher and movement execution](#original-complete-movement-and-follow-audit) covers seven builds and synthetic terrain/object/cadence vectors. Dispatcher cases intercept graphics and cel binding; separate cases execute the actual cel setter. This does not prove rendered-pixel or full-machine gameplay fidelity.                                                                                                                                                                                                                                                                                                                                                 |
| Follow retries and older profiles      | The movement audit executes signed retry edges and stationary RNG rejection/call counts across the listed v2/v3 builds. Earlier profiles absent from that matrix remain unverified; no new profile distinction was inferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Chip and device semantics              | [Original sound execution](#signed-adjustment-and-device-2-edges) covers byte arithmetic and device-2 edges in four builds. TI documentation establishes programming formats, but zero-divisor and undocumented continuation behavior across chip variants still require independent hardware evidence.                                                                                                                                                                                                                                                                                                                                                                               |
| Rare edge behaviors on unusual input   | Documented divergences in `F-motion-07` (`direction > 8` table overread), `F-motion-12` (`FindPosn` spiral exhaustion), `F-motion-16` (`Error(errNum, errVal)` `longjmp` recovery and `loop == loopCnt` overread) and `F-Parser-09` (`word.to.string` index `>= 10` `DS` overread): opcode `0x74` (`word.to.string`) is absent from all 2,425 decoded `LOGIC` resources across the 25 unpacked AGI fixtures, while runtime reachability of the three motion/view edges is not established by static scan (with unreadable `LOGIC` entries and `// !!` decoding warnings listed in `F-motion-07`); safe fallbacks are kept and raw overreads / `longjmp` / hang behavior are deferred. |

The shared object parameter bank at `0x27..0x2a` is already evidenced; it does
not prove the remaining flags or full-machine save reconstruction across arbitrary games.
Controlled file bytes and mapped-state imports are covered by the
[original-file API](#original-save-file-interoperability). Preserve existing lifecycle and
cadence assertions while widening each investigation. Store probe
commands, tool versions and controlled inputs alongside private outputs; publish
only concise findings and independently authored expected vectors.

### PC fonts and display adapters

**Font evidence.** PQ1 PC 2.903 (`AGI` SHA-256
`db97accc32e48bac0c759a6364f48790830c90f14a1486be53d1f0b7899730a7`),
load-relative `0x2c4e..0x2c72`, copies eight glyph rows from
`F000:FA6E + character × 8` into its drawing buffer. The graphics text uses
the host's BIOS typeface, rather than the Tandy character-generator typeface.
The app's `font8x8.ts` recreates the printable BIOS graphics bitmap design
pixel for pixel in its own packed table, credited as a recreation. No ROM
or font file ships, and neither build nor runtime reads one. The optional
local-reference test compares codes `0x20..0x7f` against the Tandy 1000 SX
BIOS (`8040328.u41`, reference offset `0x7a6e`), so the recreated design is
the Tandy BIOS one: IBM-BIOS machines hold a different design at F000:FA6E,
not yet recreated. The released engine window
and cursor aliases `0x01..0x07` retain their checkpoint-compatible masks.
The extended box characters used by Gold Rush! are recreated with the
PC code-page strokes, checked against the local `bigblue.chr` character
reference (eight row banks at stride 256). This reference check establishes
the glyph shapes; a Gold Rush! Bible-page frame comparison remains open.

The aligned MAME 0.289 `t1000sx` PQ1 opening, message and restart scenes
changed from 264 / 1,791 / 956 differing RGB pixels to 30 / 30 / 22 after
the recreation. The status and play regions agree exactly in all three;
the remaining differences occupy the prompt/cursor area at rows 184–191,
consistent with the PC input-row order, whose routine is not yet read.
These are raw 320×200 comparisons without masks or colour adjustment.
They establish the sampled graphics typeface, not every PC adapter's font.

**CGA RGB mapping.** The inspected DOS builds' CGA driver initializes BIOS
mode 4, background colour 1 and palette 0: blue, green, red and brown.
PQ1 2.903 `CGA_GRAF.OVL` SHA-256
`1dce45a21dcdcc27e3fcc8c193119489d1f8cbac76f18fc8a41864fdf7caa5e5`,
`0x00db..0x0114`, establishes those register calls. Its `0x0015..0x0036`
returns a two-row picture pattern from `AGIDATA.OVL + 0x1d0a`, while
`0x0037..0x00da` maps cel colours through the separate table at `0x1d4a`.
Thus a post-process with one four-colour palette cannot reproduce it.
The compositor accepts screen object ownership and an explicit cel-pixel mask
for previews and persistent stamps to select the cel mapping, uses
alternating picture rows and retains both horizontal hardware pixels.

The following DOS inputs have identical sixteen three-byte picture entries
and sixteen cel entries. Their executable/data identities are listed under
[PC and IIgs sound streams](#pc-and-iigs-sound-streams); the table addresses below are in `AGIDATA.OVL`.
The driver modes are confirmed by the shipped overlays' initialization paths.

| Build     | Picture patterns | Cel patterns | Graphics paths                               |
| --------- | ---------------- | ------------ | -------------------------------------------- |
| 2.089     | `0x1786`         | `0x17c6`     | EGA, CGA RGB/composite, PCjr/Tandy           |
| 2.230     | `0x177a`         | `0x17ba`     | EGA, CGA RGB/composite, PCjr/Tandy           |
| 2.272     | `0x184a`         | `0x188a`     | EGA, CGA RGB/composite, PCjr/Tandy           |
| 2.411     | `0x1acb`         | `0x1b0b`     | EGA, CGA RGB/composite, PCjr/Tandy, Hercules |
| 2.440     | `0x1b78`         | `0x1bb8`     | EGA, CGA RGB/composite, PCjr/Tandy, Hercules |
| 2.903     | `0x1d0a`         | `0x1d4a`     | Above plus MCGA                              |
| 2.917     | `0x1d2c`         | `0x1d6c`     | Above plus MCGA                              |
| 2.936     | `0x1d36`         | `0x1d76`     | Above plus MCGA                              |
| 3.002.086 | `0x1dc2`         | `0x1e02`     | Above plus MCGA                              |
| 3.002.102 | `0x1dd2`         | `0x1e12`     | Above plus MCGA                              |
| 3.002.107 | `0x1dd4`         | `0x1e14`     | Above plus MCGA                              |
| 3.002.149 | `0x1b89`         | `0x1bc9`     | Above plus MCGA                              |

The EGA driver requests BIOS mode `0x0d`; MCGA requests `0x13` and writes
indices 0–15, doubling every picture pixel; PCjr/Tandy requests `0x89`.
These paths share the sixteen digital RGB colours at the app's logical
raster. This does not establish analogue output or every adapter's BIOS font.
The 2.001 booter's full adapter census remains unverified here.

**Text attributes.** A shared routine computes the attribute byte that text
output hands to the BIOS from fg and bg arguments (PQ1 2.903
`0x7729..0x77c3`). On monitor type 2 it returns `0x07` or `0x70` by whether
fg exceeds bg. With the interpreter's text screen active (`DS:0x172b` in
2.903, set from startup through text display and cleared when graphics
resume) it returns `fg | bg<<4` unchanged. Otherwise a nonzero bg returns
`0x8f`; monitor type 3 or a nonzero computer type returns fg; and computer
type 0 on the remaining adapters maps fg through a fifteen-entry jump table:
`0→0`, `1..3→1`, `4..6→2`, `7..8→3`, `9..11→1`, `12..14→2` and `>14→3`.
The same grouping appears in every inspected build — 2.089 `cs:0x6dea`,
2.230 `0x6da3`, 2.272 `0x6e3f`, 2.411 `0x74bd`, 2.439 `0x75da`, 2.440
`0x75e2`, 2.903 `0x77a5`, 2.915 `0x77a4`, 2.917 `0x77b8`, 2.936 `0x787f`,
3.002.086 `0x7cbe`, 3.002.102 `0x7cd6`, 3.002.107 `0x7cd6` and 3.002.149
`0x7bb3` (executable and data identities under
[Verified inputs](#verified-inputs)). The routine differs only in its
Hercules branch, which the 2.089..2.272 builds lack.

The character write (2.903 `0x29ef..0x2b05`) treats attribute bit 7 as a
request in graphics mode: it copies the glyph to a one-glyph buffer and
inverts every bit (`0x2c30`, buffer `DS:0xe7c`; INT 1Fh points there from
startup at `0x83a1`, while EGA repoints INT 43h per write at `0x2a97`), then
issues BIOS `AH=09h` with `BL = attribute & 0x7f`. So `0x8f` draws the
inverted glyph in BIOS colour `0x0f` — colour 3 of the two-bit mode —
showing background-coloured letterforms on colour-3 cells. The MAME 0.289
`t1000sx` PQ1 status row confirms the result: 170/85/0 cells with 0/0/170
letterforms. On EGA the same `0x8f` keeps all four colour bits, so inverted
glyphs print colour-0 strokes on colour-15 cells.

**Monitor switch.** PQ1 2.903 `0x7872..0x78ad` admits `toggle.monitor`
only on computer type 0, outside room 0, when the monitor type is neither
EGA (3) nor Hercules (2). The room test is `cmp byte [0x0009],0`: the
variables start at `DS:0x0009`, as ResetAll's v20 write to `0x001d` and v26
write to `0x0023` show, so it reads v0. It XORs the monitor type with 1 and
reloads and redraws the picture inside a cursor save and restore: this
exchanges composite (0) and RGB (1) on CGA. It does not change v26.
PCjr/Tandy and MCGA computer types bypass the switch. The XOR sites are
2.089 `0x6eb1`, 2.230 `0x6e6a`, 2.272 `0x6f06`, 2.411 `0x75ae`, 2.439
`0x76cb`, 2.440 `0x76d3`, 2.903 `0x7896`, 2.915 `0x7895`, 2.917 `0x78a9`,
2.936 `0x7970`, 3.002.086 `0x7daf`, 3.002.102 and 3.002.107 `0x7dc7`, and
3.002.149 `0x7c84`. Every gate from 2.411 on has the same four tests;
2.089..2.272 test computer type, v0 and EGA, since they have no Hercules
driver. The engine implements the gate and the XOR and keeps the switched
monitor type in its replay state.

**Start options and v26.** From 2.411 on the start routine reads one-letter
options: `-c` composite (0), `-r` RGB (1), `-e` EGA (3), `-h` Hercules (2),
`-v` MCGA (4), and computer types `-p` (0), `-t` (2) and `-s` (8) (2.903
`0x00c4..0x014a`). Without an option, detection (2.903 `0x40ab..0x41c4`)
picks Hercules, then MCGA, then EGA, and leaves a CGA card in composite
mode (0). 2.089..2.272 read no options and pick EGA or else 0 (2.089
`0x3a67..0x3ab0`), so their CGA start is composite and RGB is reached only
through `toggle.monitor`. Every CGA overlay sets background 1 and palette 0
only when the monitor type is nonzero (`CGA_GRAF.OVL` `0x00db` from 2.411
on, `0x00c3` in 2.089). ResetAll copies the monitor type into v26 from
2.411 on (2.411 and 2.439 `0x104b`, 2.440 `0x1053`, 2.903 `0x1081`, 2.915,
2.917 and 2.936 `0x1086`, 3.002.086 `0x12c5`, 3.002.102 and 3.002.107
`0x12db`, 3.002.149 `0x1294`). The 2.903+ RestoreGame tail copies it again
(2.903 `0x2650`, 2.915 `0x2655`, 2.917 and 2.936 `0x2657`, 3.002.086
`0x2934`, 3.002.102 and 3.002.107 `0x294a`, 3.002.149 `0x28e9`). The
constant 3 recorded under F-OPCORE-04-adjacent and F-persistence-03 is this
copy on an EGA machine. The app therefore offers CGA for 2.411 and later,
which start in RGB with `-r` and give v26 the value 1. It offers EGA alone
for 2.001..2.272.

**Cel colours.** The overlay's view conversion (`CGA_GRAF.OVL`
`0x0037..0x00da`) runs as each view loads. It copies the cel table to a
scratch table, then for every cel sets the scratch entry of that cel's
transparent colour to the transparent code before converting the cel's
runs. The entry stays set for the later cels of the same load, so a later
cel's pixels in an earlier cel's transparent colour become transparent. A
loop whose offset equals the previous loop's is skipped. The screen copy
(`0x01b5..0x0214`) writes the buffer's low nibbles to video memory
unchanged. A buffer pixel therefore keeps the code of the routine that last
wrote it: picture patterns for picture drawing, cel codes for objects,
`add.to.pic` stamps and the `show.obj` preview. The engine reproduces the
conversion's transparency and reports each pixel's cel provenance. The
compositor maps cel pixels through the cel table and picture pixels through
the row patterns. Against the PQ1 2.903 `start -p -r` MAME 0.289
`t1000sx` captures (raw 320×200 RGB, no masks), the opening, message and
restart scenes now differ by 30, 30 and 22 pixels, all in the prompt row;
the play areas match. Without stamp provenance the opening differed by 202
pixels, its stamped cels drawn with picture patterns. Applying the row
patterns to cel-mapped colours gave 751, 328 and 514. After `toggle.monitor` selects composite, new views load through
the composite table at `AGIDATA.OVL + 0x1d3a`. That belongs to the
composite display, so a CGA session keeps the RGB conversion and look
until composite is implemented.

**Display choice across sessions.** The display is a setting for the next
start, and a resumed autosave starts with the current choice. The Amiga
region is different: it travels with saves and autosaves because it sets
the game clock, which the saved state depends on. The display's only trace
in game state is v26, which the save already carries, so restoring on
another display matches carrying a save disk to another machine.

**Remaining adapter work.** Hercules is a separate monochrome raster:
PQ1's driver programs a 720×348 display, places the 640×336 picture at
horizontal pixel 40, and uses four pairs of dither rows per colour
(`HGC_GRAF.OVL` `0x0099..0x0125`, data table `0x1d7c`). The game's
`HGC_FONT` contains 128 glyphs of 16×12 pixels. The driver's custom
INT 10h AH=9 path (`0x027b..0x02f4`) indexes `character × 24`, reads
six pairs of words, and writes each first word to the later scanline and
each second word to the earlier one. The status row occupies 12 scanlines;
later text rows have two blank scanlines followed by the glyph (14 in all).
The file must come from the player's copy when this path is implemented. Composite programs CGA control `0x1a` and
colour `0x27` (`CGA_GRAF.OVL` `0x00f8..0x0113`); its 640-pixel signal and
colour decoding are distinct from RGB mode. Neither path is approximated
by a palette here.

### Display geometry

The active image remains 320×200 on PC, IIgs and the inspected Amiga builds.
At the logical NTSC/EGA pixel width:height of 5:6 it has aspect 4:3. With
PAL Amiga pixel width:height 16:15, the same 200-line active window has
aspect 128:75; a complete 320×256 PAL field would be 4:3. The geometry
helpers distinguish these and retain an 8:5 square-pixel option. Play
takes the region from the running engine's frames, never from the
next-start preference.

CRT overscan, blank borders, screen position and calibration belong to the
physical monitor. The app's optional CRT scanlines, glow and curved glass
are display effects, rather than measurements of a particular monitor.
Square-pixel presentation samples the bitmap with nearest-neighbour filtering.
