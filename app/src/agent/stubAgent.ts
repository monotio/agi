/**
 * Deterministic stub authoring agent: no LLM, no keys, no network — but it
 * uses the REAL toolchain (assembler -> bytecode, container patch) that the
 * LLM agent will use. This is the eval harness baseline and the Playwright
 * driver for standard AGI room transitions.
 */
import { assembleLogic } from "../../../src/logic/assembler.ts";
import { buildView } from "../../../src/view/view.ts";
import { compilePictureSource } from "../../../src/picture/source.ts";
import type { LlmRequest, AgentHandler, AgentEventSink } from "./sabBridge.ts";
import type { RoomPatch } from "../../../src/agent/roomPatch.ts";

export const GAME_DICTIONARY = new Map<string, number>([
  ["look", 100],
  ["east", 101],
  ["west", 102],
  ["north", 103],
  ["south", 104],
  ["take", 105],
  ["open", 106],
]);

/** logic 0: boot pattern, dispatches to the current room logic. */
const LOGIC_0_SOURCE = `
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

/** Minimal valid view: 1 loop, 1 cel, 1x1 pixel of color 5, built with buildView. */
export const EGO_VIEW = buildView({
  loops: [
    {
      cels: [
        {
          width: 1,
          height: 1,
          transparentColor: 0,
          pixels: [5],
        },
      ],
    },
  ],
});

/**
 * Room logic template. Exits: west returns to a known room directly
 * (old rooms stay alive), east enters a reserved room using new.room.
 * The harness authors missing rooms. All parser responses are ordinary AGI.
 */
function roomSource(n: number, back: number | null, extra?: string): string {
  const westExit = back !== null ? `if (said("west") || equaln(v2, 4)) { new.room(${back}); }` : "";
  return `
#message 1 "You stand in generated room ${n}."
#message 2 "Try LOOK, EAST or WEST."
if (isset(f5)) {
  assignn(v50, ${n});
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(40);
  animate.obj(o0);
  set.view(o0, 0);
  position(o0, ${back !== null ? 20 : 80}, 120);
  draw(o0);
  accept.input();
  print(1);
${extra ?? ""}
}
${westExit}
${n < 255 ? `if (said("east") || equaln(v2, 2)) { new.room(${n + 1}); }` : ""}
if (said("look")) { print(m1); }
if (isset(f2) && !isset(f4)) { print(m2); }
return;
`;
}

/**
 * Deterministic picture source for room n: two-tone landscape + priority line.
 * Written in the same DSL the LLM agent writes and compiled with the same
 * compiler, so the offline path exercises the real `write_picture` pipeline.
 */
export function roomPictureSource(n: number): string {
  const sky = (n % 14) + 1;
  const ground = ((n * 3) % 14) + 1;
  return [
    `vis ${sky}`,
    "line 0,0 159,0 159,99 0,99 0,0",
    "fill 5,5",
    `vis ${ground}`,
    "line 0,100 159,100 159,167 0,167 0,100",
    "fill 5,150",
    "vis off",
    "pri 4",
    "line 0,100 159,100",
    "pri off",
    "end",
  ].join("\n");
}

/** The compiled picture bytes for room n. */
export function roomPicture(n: number): Uint8Array {
  return compilePictureSource(roomPictureSource(n)).bytes;
}

export class StubAgent implements AgentHandler {
  /** World log: generated room numbers in creation order. */
  readonly rooms: number[] = [1];
  /** Room -> the room its west exit returns to, so a room can be re-authored. */
  private readonly roomBack = new Map<number, number | null>([[1, null]]);
  /** Extra logic appended to a room by remix turns, keyed by room. */
  private readonly roomExtras = new Map<number, string[]>();
  private readonly onEvent: AgentEventSink;

  constructor(onEvent: AgentEventSink) {
    this.onEvent = onEvent;
  }

  /**
   * Deterministic remix turn: the offline twin of the LLM live-patch loop
   *. It runs the REAL assembler and returns a
   * real patched logic resource, so the e2e proves the whole path — freeze,
   * patch, room re-entry, resume — with no API key in sight.
   *
   * The one instruction it understands is a sign: anything containing "sign"
   * adds a sign the player reads on entering the room. Anything else is
   * answered in words and patches nothing (the bubble closes, nothing moves).
   */
  async powerUp(
    instruction: string,
    room: number,
  ): Promise<{ text: string; patched: RoomPatch["resources"] }> {
    const asked = instruction.toLowerCase();
    if (!asked.includes("sign")) {
      this.onEvent("response", `[Remix stub] no patch for "${instruction}"`);
      return { text: `Nothing in room ${room} answers to "${instruction}".`, patched: [] };
    }
    const extras = this.roomExtras.get(room) ?? [];
    extras.push('print("A weathered sign is nailed to a post here.");');
    this.roomExtras.set(room, extras);
    const back = this.roomBack.get(room) ?? (room > 1 ? room - 1 : null);
    const logic = assembleLogic(roomSource(room, back, extras.join("\n")), {
      dictionary: GAME_DICTIONARY,
    });
    this.onEvent(
      "response",
      `[Remix stub] patched logic ${room}: ${logic.code.length}B bytecode with a sign`,
    );
    const patched: RoomPatch["resources"] = [{ kind: "logic", num: room, payload: logic.payload }];
    return { text: `A weathered sign now stands in room ${room}.`, patched };
  }

  /** Resources for the base game (logic 0 + ego view + room 1). */
  initialResources(): { kind: "logic" | "view" | "picture"; num: number; payload: Uint8Array }[] {
    const room1 = assembleLogic(roomSource(1, null), { dictionary: GAME_DICTIONARY });
    this.onEvent("response", "assembled room 1 logic");
    return [
      {
        kind: "logic",
        num: 0,
        payload: assembleLogic(LOGIC_0_SOURCE, { dictionary: GAME_DICTIONARY }).payload,
      },
      { kind: "logic", num: 1, payload: room1.payload },
      { kind: "picture", num: 1, payload: roomPicture(1) },
      { kind: "view", num: 0, payload: EGO_VIEW },
    ];
  }

  async handle(req: LlmRequest): Promise<string> {
    switch (req.op) {
      case "room": {
        const from = Number(req.context["from"]);
        const n = Number(req.context["room"]);
        if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error("Invalid room number");
        const logic = assembleLogic(roomSource(n, from), { dictionary: GAME_DICTIONARY });
        const picture = roomPicture(n);
        this.rooms.push(n);
        this.roomBack.set(n, from);
        this.onEvent(
          "response",
          `authored room ${n}: logic ${logic.code.length}B bytecode + picture, patched into VOL`,
        );
        // Resources travel IN the bridge response: the worker is suspended on
        // the room request and cannot process patch messages until it resumes.
        return JSON.stringify({
          room: n,
          resources: [
            { kind: "logic", num: n, data: Array.from(logic.payload) },
            { kind: "picture", num: n, data: Array.from(picture) },
          ],
        });
      }
      default:
        // Host-served ops (getnum/getstring/restore/waitkey) never reach a game
        // agent; an empty reply is the bridge's "no answer" value.
        return "";
    }
  }
}
