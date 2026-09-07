/**
 * Design and engine notes for the authoring agent, read on demand through
 * `read_authoring_guide`. Each topic records how the shipped Sierra
 * interpreters and games actually behave (the fixtures, their logic, and the
 * disassembled 2.411 to 3.002.149 builds) and turns that into guidance for
 * building and remixing games. The system prompt stays short and stable for
 * prefix caching; this is the long-form material behind it.
 *
 * Keep every claim tied to a verified behavior or a fixture; opinions are
 * phrased as guidance, not as engine facts.
 */

import type { ToolDefinition, AgentToolResult } from "./tools.ts";

export interface GuideTopic {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

export const AUTHORING_GUIDE: Record<string, GuideTopic> = {
  "text-and-captions": {
    title: "Text, captions and speech",
    summary:
      "How display, print and the text rows behave on the graphics screen, and how the classics paced captions and bubbles.",
    body: `Text and graphics share one screen in the interpreter. Everything below follows from that.

- display(row, col, message) writes at a text cell: 40 columns by 25 rows, each cell 4 picture pixels wide and 8 tall, row 0 at the top. The picture band normally starts at row 1 with the status line on row 0 and the input line at row 22 or 23 (configure.screen). A message may contain \\n: the text continues on the next row at column 0, not at the starting column. Text past column 39 also wraps to the next row at column 0, and the row stops at 24. Author two-line captions as two display calls at the same column when you want them aligned; one message with \\n gives a hanging layout.
- Displayed text stays until something repaints it. show.pic repaints the whole picture band and wipes every caption there. add.to.pic paints its opaque pixels into the picture for good, text included. draw(o) hides the older text under the pixels it paints, and that text returns when the sprite moves on or is erased. erase(o) and every updating sprite's per-cycle redraw restore the pixels saved at the draw, so text written over a moving or animating sprite is gone by the next frame. Place captions on quiet ground, or stop.update the sprite that shares the area.
- clear.text.rect(top, left, bottom, right, color) paints a text-cell rectangle in a color and is the tool for erasing a caption cleanly (color 0 on a black band, 15 inside a white bubble). clear.lines(top, bottom, color) does the same across full rows. Both paint opaque cells; a picture drawn afterwards covers them.
- set.text.attribute(fg, bg) sets the colors for following display calls and windows. Black on white inside a white speech bubble reads well at native resolution; yellow (14) on black is the classic instruction color. Restore 15 on 0 when done.
- print(message) opens a modal window centred in the picture band and waits for Enter; print.at places it. Windows word-wrap at the width you give and are the right form for narration and parser replies. Keep routine replies to one or two lines; reserve longer windows for discoveries.
- text.screen() switches to a full text screen (black, 40 by 25); graphics() returns. The Space Quest intro shows its story captions this way, one display per row every 16 cycles, counted with a variable decremented each cycle, and polls have.key() once per cycle so any key skips ahead. Use text.screen for credits, letters and long intros; never for room descriptions.
- Speech bubbles in the Mixed-up Mother Goose demonstration are a bubble VIEW drawn with draw(o) at priority 14 or 15, text displayed inside it at fixed rows and columns, a cycle counter to hold it, then clear.text.rect over the words and a redraw of the bubble cel with a picture inside. Copy the shape: draw the bubble first, write the text second, erase text before erasing the bubble.
- The Sierra demo menu paints rows 0..9 black with clear.text.rect, displays the instructions, then add.to.pic's the game cards on top of the black band. Paint first, draw second, because a later drawing wins.

A caption intro on a text screen, paced by a counter and skippable with any key (room logic, entered with new.room):

\`\`\`agi
if (isset(f5)) {
  prevent.input();
  text.screen();
  set.text.attribute(15, 0);
  assignn(v40, 1);
  assignn(v41, 16);
}
if (have.key()) {
  graphics();
  new.room(2);
}
decrement(v41);
if (equaln(v41, 0)) {
  assignn(v41, 16);
  if (equaln(v40, 1)) { display(4, 3, "Light-years from home, a survey ship"); }
  if (equaln(v40, 2)) { display(5, 3, "drifts toward an uncharted star."); }
  if (equaln(v40, 3)) { display(7, 3, "Nobody aboard has noticed yet."); }
  if (equaln(v40, 5)) { graphics(); new.room(2); }
  increment(v40);
}
return;
\`\`\``,
  },
  "timing-and-pacing": {
    title: "Cycles, clocks and pacing",
    summary:
      "What a cycle is, how v10, cycle.time and step.time relate, and how to pace scenes without freezing the game.",
    body: `The interpreter runs one logic pass and one object update per cycle; v10 is the delay between cycles in twentieths of a second (2 is the usual speed, ten cycles a second). Sound and the clock variables run on their own timers, independent of v10.

- cycle.time(o, v) sets how many cycles pass between cels; step.time(o, v) how many between movement steps; step.size(o, v) the pixels per step. Set them once on room entry from a variable you initialised there. Resetting cycle.time every cycle restarts its countdown and stalls the animation.
- Pace scenes with cycle counters: assignn(v40, 60); then decrement(v40) each cycle and act at equaln(v40, 1). The Space Quest intro paces its captions this way, the Mother Goose bubble holds for 60 cycles, and the demo pack times every beat with counters. Counters keep the game running, sprites animating and keys polled.
- The clock variables v11 (seconds), v12 (minutes), v13 (hours) and v14 (days) advance in real time. Sierra's 3.002 title screens spin on them inside one logic pass: assignn(v11, 0); L: if (greaterv(v49, v11)) { goto L; }. That is a busy-wait; the whole interpreter stops until the seconds pass and no sprite moves meanwhile. The engine parks such a loop and resumes it each host tick, and reports an error if it waits more than ten minutes. Prefer counters; use a clock wait only for a deliberate freeze such as a title card.
- have.key() polled once per cycle is the skip-key idiom: if (have.key()) { ... skip ... } lets Enter or Space leave an intro at any time. A loop that spins on have.key() inside one pass waits for a key and stops everything else, which is fine on a text screen that says Press any key.
- sound(n, f) starts a sound and sets flag f when it ends, so a scene can wait for its music to finish before moving on. Sounds keep playing through clock waits and modal windows.
- Direction keys toggle: pressing the direction the ego already walks stops it. Automated drivers and cutscene scripts must make one decision per cycle and never re-press the current direction. Border contact variables v2 (ego's edge), v4 (the other object) and v5 (its edge) are set for exactly one cycle and cleared at the start of the next movement pass; read them in the same cycle they occur.
- One decision per cycle also applies to keys the logic reads through controller(): a key sets its controller for the cycle it arrives in.`,
  },
  "sprites-and-animation": {
    title: "Sprites, loops and cels",
    summary:
      "Selection rules for views, loops and cels, what draw and erase do, and how the classics dressed a room.",
    body: `- set.view keeps the object's current loop when the new view has that many loops and otherwise takes loop 0; set.loop, set.loop.v and the automatic direction-driven loop change keep the current cel when the new loop has that many cels and otherwise take cel 0. Nothing resets to 0 on its own. To restart an animation from its first frame, call set.cel(o, 0) explicitly. Manhunter's knife game leans on this: it re-selects the barker's loop every cycle while waiting for his cel to come round.
- animate.obj(o) initialises the object; select view, loop, cel and position before draw(o). draw makes it visible and starts update processing; erase removes it and restores what was under it. stop.update(o) freezes a drawn object as scenery that no longer costs a redraw and no longer wipes text near it; start.update resumes.
- Four-loop views follow the direction table: loop 0 right, 1 left, 2 down, 3 up, chosen from the object's direction each step unless fix.loop holds it. Two- and three-loop views use loops 0 and 1 for right and left only. Mirror loops save bytes: the view format lets a loop mirror another.
- Cel width and height come from the cel; the object's baseline is its bottom row. Sprites clip at the screen edge and the interpreter clamps a placement that would leave the screen.
- end.of.loop(o, f) plays to the last cel and sets f; reverse.loop(o, f) plays back to cel 0. Both install a one-cycle delay before the first change, so a completion flag arrives one cycle later than a naive count suggests. Use them for doors, levers and gestures that must finish before the next step.
- Priority: an object takes the priority band of its baseline row (4 at the top, rising by one every twelve rows) unless set.priority fixes it. Scenery painted at a higher priority occludes the sprite; paint doorway frames and foreground rocks at the band above the floor they stand on. Priority 15 is drawn over everything and skips barrier and water checks, which is how cursors and floating labels behave.
- Scale the ego first. The classic hero is 6 to 10 pixels wide and 28 to 36 tall; doors, chairs and beds must fit that figure on the same baseline. Compose a frame with the real ego before drawing any other sprite.
- Two or three restrained environmental animations, a pennant, a drip, a blinking light, carry a room. Give each a readable phase pattern and a slow cycle.time. Crowds of tiny animations flicker at native resolution.`,
  },
  "walking-barriers-and-water": {
    title: "Walking, barriers, triggers and water",
    summary:
      "How the control screen judges a step, how triggers and water flags really latch, and how to hand ego to and from a script.",
    body: `Every step of every object is judged against the control priorities under its baseline, the cel-wide row of pixels at its feet. The interpreters scan that row left to right:

- Control 0 blocks. Control 1 blocks unless ignore.blocks. Control 2 is a trigger: f3 is set for ego when ANY baseline pixel touches control 2, so a one-pixel-wide trigger line is enough and ego cannot stand across it without triggering. Control 3 is water: f0 is set only when EVERY baseline pixel is on water, so a shoreline reads as land until the whole footprint is in. obj.on.water and obj.on.land gate movement with that all-cells rule.
- Priority 15 objects skip the scan entirely and clear both flags. Fixed priority does not skip it.
- Paint barriers along the visible obstacle they represent and leave exits open; a stray control-0 pixel in a doorway is the most common walking bug. A priority fill floods the connected region, so close every outline before filling. Keep open floor at 4.
- Room edges: ego touching an edge sets v2 (1 top, 2 right, 3 bottom, 4 left) for one cycle; the room logic reads it and calls new.room. set.horizon(y) keeps ego below the sky line unless ignore.horizon.
- Scripted movement: move.obj(o, x, y, step, f) walks an object to a point and sets f on arrival. On ego it takes control away from the player until arrival or a border stop, then hands it back and zeroes v6. A zero-distance move.obj on ego is the idiom for handing control back after a scripted placement. program.control and player.control switch it explicitly; wander(o) and follow.ego(o, distance, f) are the other motions.
- reposition(o, dx, dy) moves an object by variable deltas and runs the placement check at once, so a script can slide ego along a trigger line and wait for the exact pixel where a flag fires. The Gold Rush demonstration does exactly that to reach one coordinate.
- Death and failure: when the player walks into danger, decide it from the control screen or a posn() box, print a short message with a wry line, and offer restore. Keep the dangerous area visibly different so the death is fair.`,
  },
  "cutscenes-and-interfaces": {
    title: "Cutscenes, intros and alternative interfaces",
    summary:
      "Structures the Sierra games used for intros, demonstrations, cutscenes and the cursor-driven Manhunter interface.",
    body: `- Room entry: on isset(f5) load and draw the picture, position ego, set the horizon, place props and enable input. Everything else is per-cycle logic. new.room resets objects and clears the loaded resources; keep world state in flags and variables 32 and above, never in objects.
- A cutscene is a small state machine: a state variable, cycle counters, move.obj with completion flags, and prevent.input while it runs. Advance the state when a counter reaches 1 or a flag sets, and end with accept.input and player.control. The Manhunter tracker, the demo pack's six demonstrations and the Space Quest intro are all built this way.
- Intro sequence, Space Quest style: title picture, version and credits on rows 22..24, a logo animation with sprites, then text.screen with captions paced by a counter and skippable with have.key, then new.room to the first playable screen.
- Demonstration mode: the demo pack toggles selections with number keys, runs each demonstration as a sequence of rooms and returns to a menu room. Every prompt is printed with f15 kept set so windows stay open; a key or a counter closes them. Attract modes make good tutorials.
- Cursor interface (Manhunter): ego is a cursor sprite at priority 15 that the arrow keys move; each room checks get.posn against rectangles, stores a hotspot number in a variable, snaps the cursor to an anchor and displays the action on rows 23 and 24 ("Press <ENTER> to look."). Enter is a controller shared by every room. Hotspot registration fires on entry to the region, so pressing Enter right after the snap performs the intended action while moving on can leave the region. This is how to build point-and-click puzzles, map screens and menus in AGI without a parser.
- Map travel (Manhunter): a map room with pages; pushing the cursor off an edge sets v2 and the logic turns the page; hotspots per page carry destination room numbers.
- A hotspot room in that style, with the cursor as object 0 at priority 15 and Enter mapped once in logic 0 with set.key(13, 0, 20):

\`\`\`agi
if (isset(f5)) {
  assignn(v40, 1);
  load.pic(v40);
  draw.pic(v40);
  show.pic();
  load.view(5);
  animate.obj(o0);
  set.view(o0, 5);
  set.priority(o0, 15);
  ignore.blocks(o0);
  ignore.horizon(o0);
  position(o0, 80, 100);
  draw(o0);
  assignn(v48, 0);
  clear.lines(23, 24, 0);
}
get.posn(o0, v30, v31);
if (greatern(v30, 100) && greatern(v31, 60) && lessn(v31, 120) && !equaln(v48, 1)) {
  assignn(v48, 1);
  reposition.to(o0, 120, 90);
  display(23, 1, "Press ENTER to open the chest.");
}
if (equaln(v48, 1) && (lessn(v30, 101) || lessn(v31, 61) || greatern(v31, 119))) {
  assignn(v48, 0);
  clear.lines(23, 24, 0);
}
if (controller(20) && equaln(v48, 1)) {
  set(f40);
  print("The chest creaks open.");
}
return;
\`\`\`
- Skill games inside a room: the knife throw and the Kewpie doll booth sweep an object back and forth and judge Enter by the object's position at that cycle, then animate the result with a short counter. The player learns the rhythm; the logic stays simple.
- Save points: the interpreter's save file carries variables, flags, objects, strings and the resource replay. Blocking the script buffer with f7 (as demonstration games do) keeps the replay empty, so a restored game relies on its room logic to reload resources; author rooms so that isset(f5) alone rebuilds them.`,
  },
  "puzzles-and-inventory": {
    title: "Puzzles, parser and inventory",
    summary:
      "Vocabulary, said() patterns, inventory items and the puzzle shapes the golden-age games returned to.",
    body: `- Register every word before its said() handler; synonyms belong to the same word group so "get", "take" and "grab" share one number. said(1, ...) matches any word; 9999 accepts the rest of the line where the profile allows it. Handle the unknown-input case in the room with a useful hint rather than a generic refusal.
- Inventory items live in the OBJECT table with a starting room; get(item) moves it to the player (room 255), drop(item) leaves it in the current room, has(item) tests it. Keep item names short and concrete: "Medallion", "Data Card". The status inventory (Tab or a controller calling status()) lists carried items; with f13 set the player can select one and v25 receives its number, or 255 on cancel. Manhunter builds a whole puzzle on this: the barker gives you a look, and showing item 13 within eight seconds earns the prize.
- Puzzle shapes that recur: find the key object across rooms and use it at one place; a locked door with a visible hint about what opens it; an NPC who wants an item and gives another; a timed chase where the exit must be found before a counter ends; a skill game with a learnable rhythm; a maze whose walls are the control screen and whose reward is counted in flags (the demo pack's arcade maze collects twelve squares, each a flag). Chain them so each solved puzzle opens the next screen or unlocks a conversation.
- Fairness: every death should be foreshadowed by something the player can see or read; every essential item should be visible in the picture or named in a look description; every puzzle should have at least one in-world hint reachable by looking. The classics were unforgiving about walking dead states; avoid them or make the game warn.
- Points: add score with the scoring variable v3 on first completion of each step (guard with a flag), and set the maximum in v7 so the status line reads well. Small awards for looking and finding, larger ones for solving.
- Text economy: the parser reply that names the concrete object, action or consequence first reads best. Write the look description of a room as three to five sentences that mention every interactive object once.
- State discipline: one flag per world fact, one variable per counter, variables 32 and above for authored state, f200 reserved for the boot logic. Record what each flag and variable means in the world bible as you introduce it.`,
  },
  "sierra-craft": {
    title: "What made the Sierra games memorable",
    summary:
      "Composition, color, humor, pacing and detail: the craft habits worth carrying into new adventures.",
    body: `- Composition first. A Sierra screen reads as one picture: a horizon or wall plane, a middle ground where the action happens and a foreground element that frames it. The ego stands on a clear floor plane with enough room to walk. Decide where the player enters and leaves before drawing anything.
- Economy of means. Sixteen colors, filled polygons and a few lines. Broad fills carry the mood; a single dithered band suggests distance or water; detail is spent where the eye lands, on the object the puzzle needs. Isolated speckles and texture everywhere read as noise at native resolution.
- Color as identity. Each location keeps a palette: a cool blue and grey castle, a warm brown and green forest, a hot red and yellow volcano. Sky gradients are two or three bands, not ten. Night scenes drop to blue, black and one light source.
- Layering with priority. Doorframes, tree trunks and rocks painted one band above the floor let the hero walk behind them; that single trick gives depth to a flat picture. Test it by walking the real ego behind and in front.
- Small readable sprites. The hero's silhouette must be recognisable at 8 by 32 pixels: contrasting hair, tunic and legs; one accent color. Animate the walk with four cels and keep the feet on the baseline. Reactions are one or two cels: a raised arm, a turned head.
- Humor grows from consequence. The famous deaths and refusals were funny because they answered exactly what the player tried ("You have died. Perhaps that was not the wisest choice."). Write the specific reply, not a generic joke; let the restore prompt follow quickly.
- Reward looking. Every room deserves a look description that hints at its puzzle, and every named object a look reply. Players who read are rewarded with points and clues.
- Music and sound sparingly. A room theme on entry, a short jingle for a discovery, a distinct death sound. Silence in between makes the cues land.
- Pace the story. Intro captions, a first easy puzzle, then widening freedom; a mid-game hub with several open threads; a climb to a finale with a cutscene. Save the longest text for the ending.
- Playtest as a stranger. Walk every exit, try the obvious wrong verbs, read every reply aloud. Fix the first thing that confuses before adding anything new.`,
  },
};

export const AUTHORING_GUIDE_TOOL: ToolDefinition = {
  name: "read_authoring_guide",
  description:
    "Design and engine notes distilled from the shipped Sierra games and interpreters: text and captions, timing, sprites, walking and water, cutscenes and interfaces, puzzles and inventory, and the craft that made the classics memorable. Null topic lists the topics; a topic name returns its notes. Read the relevant topic before designing a scene, an intro, a caption or a puzzle.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      topic: {
        type: ["string", "null"],
        enum: [...Object.keys(AUTHORING_GUIDE), null],
      },
    },
    required: ["topic"],
  },
};

export function readAuthoringGuide(args: Record<string, unknown>): AgentToolResult {
  const topic = args["topic"];
  if (topic == null) {
    return {
      success: true,
      message: `Authoring guide topics:\n${Object.entries(AUTHORING_GUIDE)
        .map(([key, entry]) => `- ${key}: ${entry.title}. ${entry.summary}`)
        .join("\n")}`,
      details: { topics: Object.keys(AUTHORING_GUIDE) },
    };
  }
  const entry = typeof topic === "string" ? AUTHORING_GUIDE[topic] : undefined;
  if (!entry)
    return {
      success: false,
      error: `Unknown topic ${JSON.stringify(topic)}. Topics: ${Object.keys(AUTHORING_GUIDE).join(", ")}.`,
    };
  return {
    success: true,
    message: `${entry.title}\n\n${entry.body}`,
    details: { topic, title: entry.title },
  };
}
