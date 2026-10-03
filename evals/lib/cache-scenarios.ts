/**
 * Representative multi-turn tasks for the cache probe, on the tutorial game
 * (games/adventure-department). Each scenario is a list of app-level turns (the
 * same AgentSession calls the shell makes) with a scripted model per
 * turn for the dry run. A live run plays the same turns with a real model.
 *
 *   remix-references  two Remix turns with a room plate attached (manifest,
 *                     contact strip, read_reference_image, a picture write and
 *                     finish), then an Ask: the request after the second
 *                     player message is where a viewed image could be
 *                     rewritten
 *   room-build        two just-in-time room builds, the second from the first
 *   studio-assist     a Studio request whose first proposal the host refuses
 *                     and a retry lands, then a second request
 *   ask               three Ask turns with inspection between them
 */
import { AgentSession } from "../../app/src/agent/agentSession.ts";
import type { LlmConfig } from "../../app/src/agent/llmClient.ts";
import { createStudioAssistStub } from "../../app/src/agent/studioAssist.ts";
import { roomReference, type DecodedImage } from "../../app/src/references/referenceArt.ts";
import { referenceSource } from "../../app/src/references/referenceHandles.ts";
import { buildTutorial, TUTORIAL_PICTURE_SOURCES } from "../../games/adventure-department/game.ts";
import { requireProjectId, requireResourceRevision } from "../../src/gameIdentity.ts";
import { referenceArtId } from "../../src/agent/referenceTools.ts";
import type { StudioFocus } from "../../src/agent/studioAssistTools.ts";
import { EGA_RGB, encodePngRgb } from "../../src/picture/png.ts";
import { pictureAssistScope } from "../../src/studio/assistScope.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { decodePng } from "./decode-png.ts";
import {
  installScriptedProvider,
  queueScript,
  type CapturedRequest,
  type ScriptProvider,
  type ScriptStep,
  type ScriptedTurn,
} from "./scripted-provider.ts";

type Session = ReturnType<typeof AgentSession.fromAuthoredData>;

interface ScenarioTurn {
  readonly label: string;
  /** The scripted model's answers for this turn, one per provider request. */
  readonly script: readonly ScriptStep[];
  /** A scripted conversation instead of steps (the Studio stub decides from results). */
  readonly stub?: () => Parameters<ReturnType<typeof installScriptedProvider>["use"]>[0];
  readonly run: (session: Session) => Promise<unknown>;
}

export interface Scenario {
  readonly id: string;
  readonly turns: readonly ScenarioTurn[];
}

const IDENTITY = {
  project: requireProjectId("cache-probe"),
  revision: requireResourceRevision("0".repeat(64)),
};
/** The tutorial rooms' walk horizon (sceneArt.ts FLOOR_Y). */
const HORIZON = 112;
const PLATE_ID = "ref-plate";

/** A 320x168 room plate: sky, a sun and a green floor, drawn by script. */
function plate(): DecodedImage {
  const width = 320;
  const height = 168;
  const rgb = new Uint8Array(width * height * 3);
  const rgba = new Uint8Array(width * height * 4);
  const paint = (index: number) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const sun = (x - 250) ** 2 + (y - 40) ** 2 < 400;
    return sun ? EGA_RGB[14]! : y < 100 ? EGA_RGB[11]! : EGA_RGB[2]!;
  };
  for (let index = 0; index < width * height; index++) {
    const [r, g, b] = paint(index) as readonly [number, number, number];
    rgb.set([r, g, b], index * 3);
    rgba.set([r, g, b, 255], index * 4);
  }
  return { width, height, rgba, mime: "image/png", bytes: encodePngRgb(width, height, rgb) };
}

const stored = [roomReference(PLATE_ID, 1, "A sunlit gallery", IDENTITY, plate())];
/** The plate's content-derived handle, the id read_reference_image is called with. */
const PLATE_ART_ID = referenceArtId(Buffer.from(stored[0]!.images[0]!.png, "base64"));

const picture = (sky: number, floor: number) =>
  [
    `vis ${sky}`,
    "rect 0,16 159,100",
    "fill 5,20",
    `vis ${floor}`,
    "rect 0,100 159,167",
    "fill 5,110",
    "vis 0",
    "line 0,100 159,100",
    "end",
  ].join("\n");

const roomLogic = (west: number) =>
  "if (isset(f5)) { load.pic(v0); draw.pic(v0); show.pic(); load.view(0); animate.obj(0); set.view(0,0); position(0,80,130); draw(0); accept.input(); }\n" +
  `if (v2 == 4) { new.room(${west}); }\nreturn;`;

function pictureFocus(session: Session, num: number, targetIds: string[]): StudioFocus {
  const source = TUTORIAL_PICTURE_SOURCES[num]!;
  const compiled = compileEditDocument(
    parsePictureDocument(source).document,
    session.state.profile,
  );
  return {
    scope: pictureAssistScope({ num, compiled, targetIds, lens: "walk" }),
    draft: () => ({ kind: "picture", source }),
    lens: "walk",
    room: num,
    horizon: HORIZON,
  };
}

const view = (size: "thumb" | "small" | "full", region: boolean): ScriptedTurn => ({
  calls: [
    {
      name: "read_reference_image",
      input: {
        id: PLATE_ART_ID,
        size,
        region: region ? { x: 0, y: 0, w: 64, h: 64 } : null,
        grid: region,
      },
    },
  ],
});
const call = (name: string, input: Record<string, unknown>): ScriptedTurn => ({
  calls: [{ name, input }],
});
const say = (text: string): ScriptedTurn => ({ text });
const HANDOVER = call("finish", { notes: null });

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "remix-references",
    turns: [
      {
        label: "remix with the plate attached",
        script: [
          {
            calls: [
              view("full", true).calls![0]!,
              { name: "read_room", input: { room: 1, state: null, frames: null } },
            ],
          },
          call("read_logic", { num: 1 }),
          call("write_picture", { room: 9, source: picture(11, 2) }),
          HANDOVER,
        ],
        run: (session) =>
          session.runPowerUp(
            "Paint picture 9 as a sunlit plate matching the attached reference. Leave the room logic as it is.",
            1,
            { referenceIds: [PLATE_ID] },
          ),
      },
      {
        label: "second remix, same plate",
        script: [
          view("small", false),
          call("write_picture", { room: 9, source: picture(9, 2) }),
          HANDOVER,
        ],
        run: (session) =>
          session.runPowerUp("Brighten the sky in picture 9.", 1, { referenceIds: [PLATE_ID] }),
      },
      {
        label: "ask after two remixes",
        script: [say("I painted picture 9 from the plate and brightened its sky.")],
        run: (session) => session.runAsk("What did you change?", 1),
      },
    ],
  },
  {
    id: "room-build",
    turns: [
      {
        label: "build room 4 from room 3",
        script: [
          {
            calls: [
              call("read_picture", { num: 3 }).calls![0]!,
              call("read_logic", { num: 3 }).calls![0]!,
            ],
          },
          {
            calls: [
              { name: "write_picture", input: { room: 4, source: picture(3, 6) } },
              { name: "write_logic", input: { room: 4, source: roomLogic(3) } },
            ],
          },
          HANDOVER,
        ],
        run: (session) =>
          session.handle({
            op: "room",
            context: {
              room: 4,
              from: 3,
              playerNotes: ["A quiet reading nook east of the archive."],
            },
          }),
      },
      {
        label: "build room 5 from room 4",
        script: [
          call("read_logic", { num: 4 }),
          {
            calls: [
              { name: "write_picture", input: { room: 5, source: picture(1, 7) } },
              { name: "write_logic", input: { room: 5, source: roomLogic(4) } },
            ],
          },
          HANDOVER,
        ],
        run: (session) => session.handle({ op: "room", context: { room: 5, from: 4 } }),
      },
    ],
  },
  {
    id: "studio-assist",
    turns: [
      {
        label: "walkable rope with a refused first proposal",
        script: [],
        // The stub's "bad" script proposes an art change the lens refuses,
        // then the walkable one; the request itself reads naturally.
        stub: () => createStudioAssistStub("bad: walk through the rope barrier"),
        run: (session) =>
          session.runStudioAssist({
            instruction: "Let the player walk through the rope barrier without changing the art.",
            focus: pictureFocus(session, 1, ["rope-barrier"]),
          }),
      },
      {
        label: "second request on the same selection",
        script: [],
        stub: () => createStudioAssistStub("walk through the rope barrier"),
        run: (session) =>
          session.runStudioAssist({
            instruction: "Open the rope barrier so the player can walk through it.",
            focus: pictureFocus(session, 1, ["rope-barrier"]),
          }),
      },
    ],
  },
  {
    id: "ask",
    turns: [
      {
        label: "ask about the keys",
        script: [
          call("read_room", { room: 1, state: null, frames: null }),
          say("Arrow keys walk; FAST and SLOW change speed."),
        ],
        run: (session) => session.runAsk("What keys do I press to play this game?", 1),
      },
      {
        label: "ask about the puzzle",
        script: [call("read_logic", { num: 1 }), say("Walk up to the rope and type PAINT MURAL.")],
        run: (session) => session.runAsk("How do I repair the mural?", 1),
      },
      {
        label: "ask a follow-up",
        script: [say("The next exhibit is east.")],
        run: (session) => session.runAsk("Where next?", 1),
      },
    ],
  },
];

/** The session a scenario runs on: the tutorial with the plate as reference art. */
export function scenarioSession(
  config: LlmConfig,
  onEvent: ConstructorParameters<typeof AgentSession>[1] = () => {},
): Session {
  const tutorial = buildTutorial();
  const session = AgentSession.fromAuthoredData(
    config,
    onEvent,
    tutorial.files,
    tutorial.words,
    [],
    undefined,
    tutorial.project!.authoringState,
  );
  session.setOrientation({ game: "adventure-department", profile: session.state.profile.id });
  session.setRuntime({
    referenceArt: async (attached) => referenceSource(stored, attached, decodePng),
  });
  return session;
}

/**
 * Play a scenario against the scripted model behind the real provider client
 * and return request bodies grouped by conversation. Background rooms start
 * separate conversations; foreground turns continue their task.
 */
export async function probeScenario(
  scenario: Scenario,
  provider: ScriptProvider,
  model: string,
): Promise<CapturedRequest[][]> {
  const scripted = installScriptedProvider(provider);
  try {
    const session = scenarioSession({ provider, apiKey: "cache-probe-offline", model });
    const tasks: CapturedRequest[][] = [];
    for (const turn of scenario.turns) {
      const start = scripted.requests.length;
      scripted.use(turn.stub ? turn.stub() : queueScript(turn.script));
      await turn.run(session);
      tasks.push(scripted.requests.slice(start));
    }
    return scenario.id === "room-build" ? tasks : [tasks.flat()];
  } finally {
    scripted.restore();
  }
}
