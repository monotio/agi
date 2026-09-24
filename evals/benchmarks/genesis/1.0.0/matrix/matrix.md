# Genesis quality/cost matrix

Source: `evals/benchmarks/genesis/1.0.0/runs`. One row per completed run (report.json + resources). Regenerate with `npm run eval:matrix -- <results-dir> <out-dir>`.
Measured columns come from report.json, events.json, transcript.json and the AGI files (parsed with the repo's own container/logic/picture/view/sound code). The brief checklist is a keyword heuristic. Judgment lives only in the optional hand-written `reading-<case>.md`.

Definitions: *room code B* = bytecode bytes of room logics (excludes logic 0 and called logics like 255). *said (distinct / groups)* = said() calls in room logics (distinct word-id patterns / distinct word groups). *cmds used* = distinct AGI actions + tests in room logics. *depth-drawn %* = picture cells whose priority is 5..15 (4 is the unpainted default). *ctlN %* = share of the 160x168 plane holding control value N (0 barrier, 1 conditional barrier, 2 trigger, 3 water). *reachable %* = flood fill from the ego start over footprints (ego cel width) that avoid control 0/1, rows at or below the horizon. *authored res.* = resources not byte-identical to the base template.

## badge-of-millhaven (5 runs)

### Cost and efficiency (measured, from report.json and events.json)

| lane | cost $ | wall s | turns | tool calls | repair turns | failures (by kind) | input tok (cached %) | output tok | authored res. | $/res. | playtest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | 1.922 | 594 | 13 | 20 | 0 | 0 () | 0.99M (89.5%) | 61.2k | 6 | 0.32 | passed |
| claude-opus-5-5 medium | 1.028 | 295 | 15 | 20 | 1 | 1 (playtest-walk 1) | 0.7M (90.9%) | 29k | 8 | 0.129 | passed |
| gpt-6-astra medium | 1.415 | 312 | 13 | 26 | 1 | 1 (assembler 1) | 0.33M (88.8%) | 13.2k | 7 | 0.202 | passed |
| gpt-6-luna medium | 0.026 | 257 | 27 | 44 | 6 | 7 (dictionary 3, picture/scene 2, view 1, other 1) | 1.02M (94.5%) | 19.4k | 4 | 0.007 | passed |
| gpt-6-sol medium | 0.298 | 223 | 17 | 27 | 2 | 2 (view 1, assembler 1) | 0.45M (92%) | 12.4k | 4 | 0.075 | passed |

### Content richness (measured from the generated resources)

| lane | room code B | room msgs (chars) | said (distinct / groups) | vocab words/groups | cmds used (room) | room flags/vars | OBJECT items | exits from start | score awards (max) | death calls | anim. objs | views (loops x cels) | ego 4-dir walk | sounds (notes, s) | tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | 1489 | 78 (6464) | 95 (92 / 49) | 203/67 | 28 | 11/11 | 8 | 2,3 | 10+50 (215) | 0 | 3 | v0:4/4/4/4 v1:8 v2:8 | yes (9x30) | template only | 3 |
| claude-opus-5-5 medium | 831 | 46 (3940) | 41 (40 / 25) | 119/47 | 28 | 8/8 | 6 | 2,3 | 10+50 (215) | 0 | 4 | v0:4/4/4/4 v1:2 v2:4 v3:1 | yes (8x29) | template only | 3 |
| gpt-6-astra medium | 687 | 22 (2637) | 44 (44 / 28) | 53/39 | 27 | 10/7 | 6 | 2,3 | 10+50 (215) | 0 | 4 | v1:2/2/2/2 v2:1 v3:8 v4:2 | yes (9x30) | template only | 6 |
| gpt-6-luna medium | 232 | 4 (769) | 9 (8 / 8) | 65/46 | 31 | 2/10 | 2 | 2 | 10 (-) | 0 | 2 | v1:2/2/1/1 v2:1/1/1/1 | no (9x30) | template only | 1 |
| gpt-6-sol medium | 584 | 21 (2285) | 39 (36 / 23) | 79/43 | 21 | 9/7 | 2 | 2,3 | 10+50 (215) | 0 | 2 | v1:2/2/2/2 v2:2/2/2/2 | yes (8x30) | template only | 2 |

### Picture fidelity: priority and control (measured from the rendered start-room picture)

| lane | pic bytes (cmds) | colours | visual fill % | bands used | depth-drawn % (pri 5-15) | ctl0 % | ctl1 % | ctl2 % | ctl3 % | horizon | ego start (pri) | reachable % below horizon | reaches edges | ctl3 reachable | stands on (top colours % of reachable) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | 852 (182) | 12 | 97.6 | 4,12 | 2 | 8.7 | 0 | 0 | 0 | 94 | 94,142 (4) | 78.2 | left,right,bottom,horizon | no | lgray 87.7, dgray 5.6 |
| claude-opus-5-5 medium | 343 (74) | 9 | 99.6 | 4,9 | 4.8 | 0.5 | 0 | 0 | 0 | 76 | 40,130 (4) | 84.8 | left,right,bottom,horizon | no | lgray 100 |
| gpt-6-astra medium | 861 (171) | 12 | 99.1 | 4,10 | 4.3 | 2.8 | 0 | 0 | 0 | 77 | 78,135 (4) | 91.5 | left,right | no | lgray 78.1, dgray 14.2, brown 5.2 |
| gpt-6-luna medium | 3003 (637) | 10 | 99.4 | 4,8 | 7.9 | 0.3 | 0 | 0 | 0 | 72 | 27,147 (4) | 99.5 | left,right,bottom,horizon | no | blue 42, red 20.7, lcyan 16.8, brown 15 |
| gpt-6-sol medium | 2362 (519) | 12 | 99.6 | 4,12 | 7.1 | 1 | 0 | 0 | 0 | 108 | 57,145 (4) | 68.9 | left,right,bottom,horizon | no | brown 84.4, black 8.1, dgray 4.5 |

### Template and authoring behaviour (measured)

| lane | logic 0 | logic 255 | picture writes (using pri) | control cmds written | visible prose chars | top tools |
| --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | modified: msgs 17,18; +1 insns (assignn(7,215)) | identical | 2 (1) | 2 | 40762 | write_view 3, playtest_room 3, edit_resource_source 2, inspect_world_bible 1 |
| claude-opus-5-5 medium | modified: msgs 17,18; +2 insns (assignn(7,215) status()) | modified: msgs 3; +0 insns () | 2 (1) | 1 | 15739 | write_view 4, edit_resource_source 4, read_logic 2, inspect_world_bible 1 |
| gpt-6-astra medium | modified: msgs 18; +1 insns (assignn(7,215)) | identical | 2 (1) | 2 | 608 | write_view 4, read_authoring_guide 3, update_world 2, write_logic_source 2 |
| gpt-6-luna medium | identical | identical | 6 (5) | 2 | 0 | playtest_room 5, write_words 4, write_view 4, read_picture 4 |
| gpt-6-sol medium | identical | identical | 3 (3) | 5 | 0 | playtest_room 5, read_authoring_guide 3, read_logic 2, write_words 2 |

### Brief checklist (HEURISTIC keyword/structure checks against the brief's starting room; not a quality judgment)

| check | claude-opus-5-5 high | claude-opus-5-5 medium | gpt-6-astra medium | gpt-6-luna medium | gpt-6-sol medium |
| --- | --- | --- | --- | --- | --- |
| precinct / front desk (message) | Y | Y | Y | Y | Y |
| Sergeant Prakash named | Y | Y | Y | Y | Y |
| talk to Prakash (said talk) | Y | Y | Y | Y | Y |
| badge (OBJECT) | Y | Y | Y | Y | Y |
| radio (OBJECT) | Y | Y | Y | Y | Y |
| board readable (said board) | Y | Y | Y | Y | Y |
| lead: driver/pharmacy mentioned | Y | Y | Y | Y | Y |
| receive assignment +10 | Y | Y | Y | Y | Y |
| >=1 exit | Y | Y | Y | Y | Y |
| Dana/Reyes named | Y | Y | Y | - | Y |
| ego navy/blue uniform | Y | Y | Y | Y | Y |
| palette: red brick + blue + green | Y | - | Y | - | Y |
| lexicon verbs in said() | 8/8 | 8/8 | 8/8 | 4/8 | 8/8 |
| lexicon nouns in said() | 6/8 | 3/8 | 8/8 | 1/8 | 3/8 |
| score | 12/12 | 11/12 | 12/12 | 10/12 | 12/12 |

### Representative tool failures (verbatim, truncated)

- claude-opus-5-5 medium `playtest_room` [playtest-walk]: steps[9]: walkTo did not reach its goal: unreachable_under_current_model (No route in the current static model.).
- gpt-6-astra medium `write_logic_source` [assembler]: Assembler error in logic 1: AssemblerError: 52:3: unknown action 'ignore.objects' or action not available in profile 2.936 (check spelling and the selected profile). Use read_comma
- gpt-6-luna medium `write_words` [dictionary]: Dictionary compilation error: Error: 'about' is an ignored word (group 0) and cannot join a synonym group.
- gpt-6-luna medium `patch_view_cels` [view]: View cels were not patched: Error: patches[0] (loop 0, cel 0).recolor[0]: from 0 is the cel's transparent color; use rows to change transparency.
- gpt-6-sol medium `write_logic_source` [assembler]: Assembler error in logic 1: AssemblerError: 79:7: word 'file' is not in the dictionary. Use read_words to inspect existing word groups, then write_words to register the missing voc
- gpt-6-sol medium `read_view` [view]: View 0 is not present in the container.

### Images

| lane | first frame | visual | priority (EGA palette) | walk (dimmed = unreachable; red ctl0, orange ctl1, green ctl2, blue ctl3, yellow horizon, magenta ego start) |
| --- | --- | --- | --- | --- |
| claude-opus-5-5 high | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-high-first-frame.png) | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-high-visual.png) | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-high-priority.png) | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-high-walk.png) |
| claude-opus-5-5 medium | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-medium-first-frame.png) | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-medium-visual.png) | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-medium-priority.png) | ![](badge-of-millhaven/anthropic-claude-opus-5-5-lean-medium-walk.png) |
| gpt-6-astra medium | ![](badge-of-millhaven/openai-gpt-6-astra-lean-medium-first-frame.png) | ![](badge-of-millhaven/openai-gpt-6-astra-lean-medium-visual.png) | ![](badge-of-millhaven/openai-gpt-6-astra-lean-medium-priority.png) | ![](badge-of-millhaven/openai-gpt-6-astra-lean-medium-walk.png) |
| gpt-6-luna medium | ![](badge-of-millhaven/openai-gpt-6-luna-lean-medium-first-frame.png) | ![](badge-of-millhaven/openai-gpt-6-luna-lean-medium-visual.png) | ![](badge-of-millhaven/openai-gpt-6-luna-lean-medium-priority.png) | ![](badge-of-millhaven/openai-gpt-6-luna-lean-medium-walk.png) |
| gpt-6-sol medium | ![](badge-of-millhaven/openai-gpt-6-sol-lean-medium-first-frame.png) | ![](badge-of-millhaven/openai-gpt-6-sol-lean-medium-visual.png) | ![](badge-of-millhaven/openai-gpt-6-sol-lean-medium-priority.png) | ![](badge-of-millhaven/openai-gpt-6-sol-lean-medium-walk.png) |

### Reading (auto-generated, facts only)

- Cost spread: gpt-6-luna medium $0.026 to claude-opus-5-5 high $1.922 (73x).
- Most distinct said() patterns: claude-opus-5-5 high 92, gpt-6-astra medium 44, claude-opus-5-5 medium 40, gpt-6-sol medium 36, gpt-6-luna medium 8.
- Depth-drawn priority area (pri 5-15): gpt-6-luna medium 7.9%, gpt-6-sol medium 7.1%, claude-opus-5-5 medium 4.8%, gpt-6-astra medium 4.3%, claude-opus-5-5 high 2%.
- All runs passed the harness playtest: yes.

### Reading (hand-written; JUDGMENT unless a number is quoted from the tables)

Facts:

- Every lane passed its playtest; the five runs cost $4.69 together. Opus at `high` made no failed tool call, Opus at `medium`, Astra and Sol one or two, Luna seven.
- Opus at `high` writes the richest parser (92 distinct said() patterns) and gives Sergeant Prakash an eight-frame idle loop; Astra covers all eight lexicon nouns.
- Opus, Astra and Sol give Officer Reyes a four-direction walk. Luna's hero walks left and right only, and its sergeant is four one-cel loops with front and back identical.

Judgment (single run per lane):

- Best overall: Opus at `high` ($1.92), for the parser depth and the animated precinct. Opus at `medium` ($1.03) gives the same four-frame walk for about half the cost.
- Best value: Sol ($0.30). A uniformed officer with a stride in every direction, 12 of 12 brief checks, and two repairs.
- Luna ($0.03) is playable and on-brief in its words, but the least animated and the least deep.

## knights-trial (5 runs)

### Cost and efficiency (measured, from report.json and events.json)

| lane | cost $ | wall s | turns | tool calls | repair turns | failures (by kind) | input tok (cached %) | output tok | authored res. | $/res. | playtest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | 2.062 | 647 | 13 | 22 | 0 | 0 () | 1M (89.1%) | 67k | 6 | 0.344 | passed |
| claude-opus-5-5 medium | 1.426 | 393 | 18 | 23 | 1 | 1 (assembler 1) | 0.97M (91.7%) | 42.2k | 6 | 0.238 | passed |
| gpt-6-astra medium | 1.65 | 347 | 17 | 31 | 2 | 2 (view 2) | 0.44M (91.1%) | 15.1k | 7 | 0.236 | passed |
| gpt-6-luna medium | 0.028 | 328 | 21 | 48 | 6 | 11 (view 7, picture/scene 1, assembler 2, playtest-expect 1) | 0.75M (92.5%) | 27.2k | 7 | 0.004 | passed |
| gpt-6-sol medium | 0.254 | 190 | 14 | 24 | 1 | 1 (view 1) | 0.34M (90.4%) | 11k | 6 | 0.042 | passed |

### Content richness (measured from the generated resources)

| lane | room code B | room msgs (chars) | said (distinct / groups) | vocab words/groups | cmds used (room) | room flags/vars | OBJECT items | exits from start | score awards (max) | death calls | anim. objs | views (loops x cels) | ego 4-dir walk | sounds (notes, s) | tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | 912 | 37 (3360) | 43 (37 / 29) | 158/60 | 31 | 4/5 | 8 | 2,3 | 10 (230) | 1 | 6 | v1:4/4/4/4 v2:1/1/1/1 v3:6 | yes (8x30) | template only | 3 |
| claude-opus-5-5 medium | 1123 | 49 (4019) | 67 (67 / 45) | 134/59 | 31 | 8/8 | 6 | 6,2 | 10 (230) | 1 | 5 | v0:4/4/4/4 v1:1/3/2 v2:6/6 | yes (8x30) | template only | 3 |
| gpt-6-astra medium | 637 | 22 (1759) | 37 (37 / 31) | 52/38 | 33 | 9/9 | 5 | 2,3 | none (230) | 1 | 4 | v1:4/4/4/4 v2:1 v3:2 v4:4 | yes (9x30) | template only | 6 |
| gpt-6-luna medium | 497 | 14 (1203) | 20 (17 / 17) | 62/38 | 32 | 5/10 | 2 | 2,3 | 10 (-) | 0 | 5 | v1:2/2/1/1 v2:1 v3:1 v4:1 v5:1 | no (7x24) | template only | 1 |
| gpt-6-sol medium | 660 | 27 (1956) | 27 (27 / 24) | 74/40 | 23 | 6/6 | 2 | 2,3 | none (230) | 2 | 4 | v1:2/2/2/2 v2:1 v3:2 v4:2 | yes (9x30) | template only | 2 |

### Picture fidelity: priority and control (measured from the rendered start-room picture)

| lane | pic bytes (cmds) | colours | visual fill % | bands used | depth-drawn % (pri 5-15) | ctl0 % | ctl1 % | ctl2 % | ctl3 % | horizon | ego start (pri) | reachable % below horizon | reaches edges | ctl3 reachable | stands on (top colours % of reachable) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | 855 (142) | 12 | 99.8 | 4,11 | 2.1 | 2.9 | 0 | 0 | 0 | 72 | 76,140 (4) | 78.7 | left,right,horizon | no | lgreen 48.5, brown 23.1, blue 22.4, dgray 3 |
| claude-opus-5-5 medium | 3732 (818) | 12 | 100 | 4 | 0 | 1 | 0 | 0 | 0.5 | 40 | 30,140 (4) | 92.7 | left,right,bottom,horizon | yes | lgreen 40.8, blue 16.2, lgray 15.9, brown 11.2, green 7.6, black 3.5 |
| gpt-6-astra medium | 5746 (1193) | 12 | 98.4 | 4,12 | 4.3 | 1 | 0 | 0 | 9.3 | 58 | 78,143 (4) | 93.5 | left,right,bottom,horizon | yes | green 36.8, yellow 16.2, brown 14.5, lblue 12.6, lgreen 7.6, lgray 6, dgray 3.3 |
| gpt-6-luna medium | 2374 (506) | 9 | 100 | 4,5 | 22.6 | 0.2 | 0 | 0 | 8.6 | 90 | 80,155 (4) | 97.6 | left,right,bottom,horizon | yes | green 69, blue 18.1, brown 9.5 |
| gpt-6-sol medium | 4592 (931) | 10 | 100 | 4 | 0 | 11.1 | 0 | 0 | 0 | 105 | 109,157 (4) | 83.1 | left,right,bottom,horizon | no | brown 56.9, lgreen 21, green 12.9, black 3.4, blue 3.3 |

### Template and authoring behaviour (measured)

| lane | logic 0 | logic 255 | picture writes (using pri) | control cmds written | visible prose chars | top tools |
| --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 high | modified: msgs 21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41; +35 insns (assignn(7,230) print(21) print(22)) | identical | 1 (1) | 1 | 46018 | playtest_room 5, write_view 3, read_logic 2, edit_resource_source 2 |
| claude-opus-5-5 medium | modified: msgs 18; +1 insns (assignn(7,230)) | identical | 2 (1) | 2 | 16979 | write_view 3, playtest_room 3, read_logic 2, reserve_binding 2 |
| gpt-6-astra medium | modified: msgs 18; +1 insns (assignn(7,230)) | identical | 2 (2) | 8 | 545 | write_view 6, playtest_room 4, read_authoring_guide 3, read_logic 2 |
| gpt-6-luna medium | identical | identical | 4 (4) | 14 | 0 | write_view 13, inspect_world_bible 6, playtest_room 4, read_logic 3 |
| gpt-6-sol medium | identical | identical | 2 (2) | 4 | 0 | write_view 5, playtest_room 4, read_logic 3, read_authoring_guide 2 |

### Brief checklist (HEURISTIC keyword/structure checks against the brief's starting room; not a quality judgment)

| check | claude-opus-5-5 high | claude-opus-5-5 medium | gpt-6-astra medium | gpt-6-luna medium | gpt-6-sol medium |
| --- | --- | --- | --- | --- | --- |
| royal notice (message) | Y | Y | Y | Y | Y |
| notice readable (said read/look notice) | Y | Y | Y | Y | Y |
| bread takeable (said + OBJECT) | Y | Y | Y | Y | Y |
| lit lantern (OBJECT) | Y | Y | Y | Y | Y |
| alligator in moat (message) | Y | Y | Y | Y | Y |
| swimming warned then fatal (call 255) | Y | Y | Y | - | Y |
| hall/drawbridge mentioned | Y | Y | Y | Y | Y |
| meadow mentioned | Y | Y | Y | - | Y |
| >=2 exits (hall + meadow) | Y | Y | Y | Y | Y |
| accept errand +10 | Y | Y | - | Y | - |
| King Brannoc named | Y | Y | Y | Y | Y |
| Wenna/Thornwall named | Y | Y | Y | Y | Y |
| ego red/brown (tunic, hair) | Y | Y | Y | Y | Y |
| palette: green + blue + gray | Y | Y | Y | Y | Y |
| lexicon verbs in said() | 6/7 | 7/7 | 7/7 | 6/7 | 7/7 |
| lexicon nouns in said() | 3/8 | 8/8 | 8/8 | 4/8 | 8/8 |
| score | 14/14 | 14/14 | 13/14 | 12/14 | 13/14 |

### Representative tool failures (verbatim, truncated)

- claude-opus-5-5 medium `write_logic_source` [assembler]: Assembler error in logic 1: AssemblerError: 4:27: expected number, got 'f32'. Use read_command_reference for the active profile's exact signatures and semantics. Candidates below a
- gpt-6-astra medium `write_view` [view]: View 1 was not written: line 2: unknown command "#": use cel, loop, description or endview.
- gpt-6-luna medium `write_logic_source` [assembler]: Assembler error in logic 1: AssemblerError: 47:54: word 'pick' is not in the dictionary. Use read_words to inspect existing word groups, then write_words to register the missing vo
- gpt-6-luna medium `write_view` [view]: View 1 was not written: line 47: cel wf0 row 13 has 8 symbols; its width is 7. Send exactly 7.
- gpt-6-sol medium `write_view` [view]: View 4 was not written: line 11: cel gator0 row 7 has 29 symbols; its width is 28. Send exactly 28.

### Images

| lane | first frame | visual | priority (EGA palette) | walk (dimmed = unreachable; red ctl0, orange ctl1, green ctl2, blue ctl3, yellow horizon, magenta ego start) |
| --- | --- | --- | --- | --- |
| claude-opus-5-5 high | ![](knights-trial/anthropic-claude-opus-5-5-lean-high-first-frame.png) | ![](knights-trial/anthropic-claude-opus-5-5-lean-high-visual.png) | ![](knights-trial/anthropic-claude-opus-5-5-lean-high-priority.png) | ![](knights-trial/anthropic-claude-opus-5-5-lean-high-walk.png) |
| claude-opus-5-5 medium | ![](knights-trial/anthropic-claude-opus-5-5-lean-medium-first-frame.png) | ![](knights-trial/anthropic-claude-opus-5-5-lean-medium-visual.png) | ![](knights-trial/anthropic-claude-opus-5-5-lean-medium-priority.png) | ![](knights-trial/anthropic-claude-opus-5-5-lean-medium-walk.png) |
| gpt-6-astra medium | ![](knights-trial/openai-gpt-6-astra-lean-medium-first-frame.png) | ![](knights-trial/openai-gpt-6-astra-lean-medium-visual.png) | ![](knights-trial/openai-gpt-6-astra-lean-medium-priority.png) | ![](knights-trial/openai-gpt-6-astra-lean-medium-walk.png) |
| gpt-6-luna medium | ![](knights-trial/openai-gpt-6-luna-lean-medium-first-frame.png) | ![](knights-trial/openai-gpt-6-luna-lean-medium-visual.png) | ![](knights-trial/openai-gpt-6-luna-lean-medium-priority.png) | ![](knights-trial/openai-gpt-6-luna-lean-medium-walk.png) |
| gpt-6-sol medium | ![](knights-trial/openai-gpt-6-sol-lean-medium-first-frame.png) | ![](knights-trial/openai-gpt-6-sol-lean-medium-visual.png) | ![](knights-trial/openai-gpt-6-sol-lean-medium-priority.png) | ![](knights-trial/openai-gpt-6-sol-lean-medium-walk.png) |

### Reading (auto-generated, facts only)

- Cost spread: gpt-6-luna medium $0.028 to claude-opus-5-5 high $2.062 (75x).
- Most distinct said() patterns: claude-opus-5-5 medium 67, claude-opus-5-5 high 37, gpt-6-astra medium 37, gpt-6-sol medium 27, gpt-6-luna medium 17.
- Depth-drawn priority area (pri 5-15): gpt-6-luna medium 22.6%, gpt-6-astra medium 4.3%, claude-opus-5-5 high 2.1%, claude-opus-5-5 medium 0%, gpt-6-sol medium 0%.
- All runs passed the harness playtest: yes.

### Reading (hand-written; JUDGMENT unless a number is quoted from the tables)

Facts:

- Every lane passed its playtest; the five runs cost $5.42 together. Opus at `high` made no failed tool call; the other lanes made one or two, except Luna (11, seven of them view rows of the wrong width).
- Every lane but Luna gives the hero a four-direction walk: Opus and Astra with four cels per direction, Sol with two. Luna's hero walks left and right but has one cel each for front and back.
- Opus at `medium`, Astra and Sol cover all eight lexicon nouns in said(); Opus at `high` covers three.

Judgment (single run per lane):

- Best sprites: Astra and Opus. Both draw the squire in profile for the side loops, give front and back their own drawings, and animate a stride over four frames; Opus also floats a six-frame alligator in the moat, at both efforts.
- Best value: Sol ($0.25). A readable two-frame walk in every direction, side views marked by an offset eye and swept hair, and 13 of 14 brief checks.
- Luna ($0.03) builds a complete, playable opening, but thin: few parser words, and a static front and back.
