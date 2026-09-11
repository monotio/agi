/** Schemas for core resource editing and runtime inspection tools. */
import type { ToolDefinition } from "./tools.ts";
import { MAX_FRAMES } from "./frames.ts";

/** A variable check: exact `value`, or an inclusive `min`/`max` range. */
const VAR_ASSERTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "integer", minimum: 0, maximum: 255 },
    value: { type: ["integer", "null"], minimum: 0, maximum: 255 },
    min: { type: ["integer", "null"], minimum: 0, maximum: 255 },
    max: { type: ["integer", "null"], minimum: 0, maximum: 255 },
  },
  required: ["id", "value", "min", "max"],
};

/** Step vocabulary shared by playtest_room and stored game tests (write_game_tests). */
export const PLAYTEST_STEPS_SCHEMA = {
  type: ["array", "null"],
  maxItems: 256,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [
          "command",
          "move",
          "enter",
          "wait",
          "key",
          "direction",
          "walkTo",
          "answer",
          "walkWaypoints",
          "walkPath",
        ],
      },
      command: { type: ["string", "null"], maxLength: 80 },
      direction: {
        type: ["string", "integer", "null"],
        enum: [
          "up",
          "up-right",
          "right",
          "down-right",
          "down",
          "down-left",
          "left",
          "up-left",
          0,
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          null,
        ],
      },
      key: { type: ["integer", "null"], minimum: 0, maximum: 65535 },
      x: { type: ["integer", "null"], minimum: 0, maximum: 159 },
      y: { type: ["integer", "null"], minimum: 0, maximum: 167 },
      answer: { type: ["string", "null"], maxLength: 80 },
      until: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          room: { type: ["integer", "null"], minimum: 0, maximum: 255 },
          flag: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              id: { type: "integer", minimum: 0, maximum: 255 },
              value: { type: "boolean" },
            },
            required: ["id", "value"],
          },
          var: { ...VAR_ASSERTION_SCHEMA, type: ["object", "null"] },
        },
        required: ["room", "flag", "var"],
      },
      waypoints: {
        type: ["array", "null"],
        maxItems: 32,
        items: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "integer", minimum: 0, maximum: 167 },
        },
      },
      target: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          x0: { type: "integer", minimum: 0, maximum: 159 },
          y0: { type: "integer", minimum: 0, maximum: 167 },
          x1: { type: "integer", minimum: 0, maximum: 159 },
          y1: { type: "integer", minimum: 0, maximum: 167 },
        },
        required: ["x0", "y0", "x1", "y1"],
      },
      ticks: { type: ["integer", "null"], minimum: 1, maximum: 60000 },
      captureTicks: {
        type: ["array", "null"],
        maxItems: 9,
        items: { type: "integer", minimum: 1, maximum: 60000 },
      },
    },
    required: [
      "action",
      "command",
      "direction",
      "key",
      "x",
      "y",
      "answer",
      "until",
      "waypoints",
      "target",
      "ticks",
      "captureTicks",
    ],
  },
};

/** Expectations shared by playtest_room and stored game tests. */
export const PLAYTEST_EXPECT_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    room: { type: ["integer", "null"], minimum: 0, maximum: 255 },
    carriedItems: {
      type: ["array", "null"],
      items: { type: "integer", minimum: 0, maximum: 255 },
    },
    flags: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer", minimum: 0, maximum: 255 },
          value: { type: "boolean" },
        },
        required: ["id", "value"],
      },
    },
    vars: { type: ["array", "null"], items: VAR_ASSERTION_SCHEMA },
    printed: { type: ["string", "null"], maxLength: 200 },
    text: { type: ["string", "null"], maxLength: 200 },
    score: { type: ["integer", "null"], minimum: 0, maximum: 255 },
    object: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        num: { type: "integer", minimum: 0, maximum: 255 },
        view: { type: ["integer", "null"], minimum: 0, maximum: 255 },
        x0: { type: ["integer", "null"], minimum: 0, maximum: 159 },
        y0: { type: ["integer", "null"], minimum: 0, maximum: 167 },
        x1: { type: ["integer", "null"], minimum: 0, maximum: 159 },
        y1: { type: ["integer", "null"], minimum: 0, maximum: 167 },
        active: { type: ["boolean", "null"] },
      },
      required: ["num", "view", "x0", "y0", "x1", "y1", "active"],
    },
    reachable: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        x: { type: "integer", minimum: 0, maximum: 159 },
        y: { type: "integer", minimum: 0, maximum: 167 },
      },
      required: ["x", "y"],
    },
  },
  required: [
    "room",
    "carriedItems",
    "flags",
    "vars",
    "printed",
    "text",
    "score",
    "object",
    "reachable",
  ],
};
export const CORE_AGENT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_diagnostic",
    description:
      "Retrieve a stored diagnostic artifact by `id` (a tool result's diagnosticId when fields were truncated). `fields` limits output to named detail fields; `offset`/`limit` page the serialized text.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 32 },
        fields: {
          type: ["array", "null"],
          maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
        offset: { type: ["integer", "null"], minimum: 0 },
        limit: { type: ["integer", "null"], minimum: 1, maximum: 32000 },
      },
      required: ["id", "fields", "offset", "limit"],
    },
  },
  {
    name: "read_room_context",
    description:
      "Inspect a room's compiled resources, intent, dependencies, bindings, inventory and live state. Null selects the live room. Live state is paused; resources include staged edits.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 255,
        },
      },
      required: ["room"],
    },
  },
  {
    name: "write_words",
    description:
      "Compile parser vocabulary into WORDS.TOK. Slash-separated words share an ID; `groups` preserves explicit synonyms and multiword phrases. Register words before using them in said(). Standard navigation words are added automatically. Failure stores nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        groups: {
          type: ["array", "null"],
          maxItems: 512,
          items: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
        words: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["words", "groups"],
    },
  },
  {
    name: "write_logic_source",
    description:
      "Compile and replace AGI logic `room` from complete `source`, including #message directives. Failure returns assembler diagnostics and stores nothing; said() words must already be registered.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: "integer",
        },
        source: {
          type: "string",
        },
      },
      required: ["room", "source"],
    },
  },
  {
    name: "write_picture",
    description:
      "Compile and replace picture `room` from complete vector `source`. Returns a visual/priority/overlay comparison image, spatial metrics and revision. A `# layout: <name> x<a>-<b> y<c>-<d> colour <n>` comment reports the colour and coverage that rendered in that box with an OK/UNDERFILLED/SHIFTED/MISSING verdict. A `# actor: <name> x<X> y<baseline> width<W> height<H> priority<P>` comment reports that footprint's extent, the control values on its baseline and how many cells of higher-priority scenery would occlude it. Failure stores nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: "integer",
        },
        source: {
          type: "string",
        },
      },
      required: ["room", "source"],
    },
  },
  {
    name: "read_picture",
    description:
      "Read editable source and rendered priority/control analysis for picture `num`. `include` selects source, image or both; null paging uses offset 0, limit 200 and both. Fails for absent or invalid resources.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer" },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 400,
        },
        include: {
          type: ["string", "null"],
          enum: ["source", "image", "both", null],
        },
      },
      required: ["num", "offset", "limit", "include"],
    },
  },
  {
    name: "read_logic",
    description:
      "Disassemble logic `num` to editable, byte-identical source with said() words resolved. Null paging uses offset 0 and limit 200. Fails for absent or invalid resources.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer" },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 400,
        },
      },
      required: ["num", "offset", "limit"],
    },
  },
  {
    name: "read_words",
    description:
      "Inspect parser words and synonym groups by word ID. `prefix` or `exact` narrows the words; `offset` and `limit` page the groups (null: 0 and 60). The compiled dictionary determines what said() can match.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        exact: {
          type: ["string", "null"],
        },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 100,
        },
        prefix: {
          type: ["string", "null"],
        },
      },
      required: ["prefix", "exact", "offset", "limit"],
    },
  },
  {
    name: "read_view",
    description:
      "Inspect compiled view `num`: labeled contact sheet, per-cel size and EGA color usage, and the resource `revision` accepted by patch tools. `cels` selects a cel subset ({loop,cel}); `rows` returns exact EGA hex rows for the selection, or every cel when `cels` is null, within a 32768-pixel budget. Fails for absent or invalid resources.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer" },
        cels: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              loop: { type: "integer", minimum: 0, maximum: 254 },
              cel: { type: "integer", minimum: 0, maximum: 254 },
            },
            required: ["loop", "cel"],
          },
        },
        rows: { type: ["boolean", "null"] },
      },
      required: ["num", "cels", "rows"],
    },
  },
  {
    name: "write_view",
    description:
      "Compile and replace view `num` from `spec`. Provide exactly one of `loops` (each has cels or mirrors a preceding loop) or `facings` (four-facing actor shorthand: right/left/down/up hex-row cels, a shared transparentColor, mirror flags; omitted directions are filled from available facings and reported in warnings). Pixels are row-major EGA indices; facings rows are hex strings. Pixel-count corrections appear in `adjustments`. Returns a compiled contact sheet; large views sample 32 cels. Failure stores nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
        },
        spec: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: {
              type: ["string", "null"],
            },
            facings: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                description: { type: ["string", "null"], maxLength: 512 },
                transparentColor: { type: "integer", minimum: 0, maximum: 15 },
                mirrorLeftFromRight: { type: ["boolean", "null"] },
                mirrorUpFromDown: { type: ["boolean", "null"] },
                right: {
                  type: ["array", "null"],
                  items: { type: "array", items: { type: "string" } },
                },
                left: {
                  type: ["array", "null"],
                  items: { type: "array", items: { type: "string" } },
                },
                down: {
                  type: ["array", "null"],
                  items: { type: "array", items: { type: "string" } },
                },
                up: {
                  type: ["array", "null"],
                  items: { type: "array", items: { type: "string" } },
                },
              },
              required: [
                "description",
                "transparentColor",
                "mirrorLeftFromRight",
                "mirrorUpFromDown",
                "right",
                "left",
                "down",
                "up",
              ],
            },
            loops: {
              type: ["array", "null"],
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  mirrorLoop: {
                    type: ["integer", "null"],
                  },
                  cels: {
                    type: ["array", "null"],
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        width: {
                          type: "integer",
                        },
                        height: {
                          type: "integer",
                        },
                        transparentColor: {
                          type: ["integer", "null"],
                        },
                        mirror: {
                          type: ["boolean", "null"],
                        },
                        pixels: {
                          type: "array",
                          items: { type: "integer" },
                        },
                      },
                      required: ["width", "height", "transparentColor", "mirror", "pixels"],
                    },
                  },
                },
                required: ["mirrorLoop", "cels"],
              },
            },
          },
          required: ["description", "loops", "facings"],
        },
      },
      required: ["num", "spec"],
    },
  },
  {
    name: "handover",
    description:
      "Finish authoring and resume the running game. Validates first: every stored game test runs against the current resources, and a session's first handover also boots the world in simulation (ego spawn, room display, modal handling). Failure returns the verdict for repair; only a passing handover resumes play. `notes` is optional free text.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        notes: {
          type: ["string", "null"],
        },
      },
      required: ["notes"],
    },
  },
  {
    name: "write_inventory_objects",
    description:
      "Compile the OBJECT inventory table. `mode` replace (default) writes the complete table from `objects` (`startingRoom`: 255 carried, 1..254 in that room, 0 inactive); `mode` merge updates one item from `item` while preserving other IDs — null `item.id` appends, `item.location` is carried, room or inactive, and `item.room` (1..254) applies only to a room location. Live ownership is unchanged; game logic changes it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: ["string", "null"], enum: ["replace", "merge", null] },
        objects: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              startingRoom: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 255,
              },
            },
            required: ["name", "startingRoom"],
          },
        },
        item: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            id: { type: ["integer", "null"], minimum: 0, maximum: 255 },
            name: { type: "string" },
            location: { type: "string", enum: ["carried", "room", "inactive"] },
            room: { type: ["integer", "null"], minimum: 1, maximum: 254 },
          },
          required: ["id", "name", "location", "room"],
        },
      },
      required: ["mode", "objects", "item"],
    },
  },
  {
    name: "write_sound",
    description:
      "Compile and replace four-channel SOUND `num` from `tracks`: three tone voices and one noise voice. Durations use 60 Hz ticks; attenuation 0 is loudest and 15 silent. Notes accept MIDI, names, rest, or raw frequency divisors.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
        },
        tracks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              notes: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    note: {
                      type: ["integer", "string", "null"],
                    },
                    duration: {
                      type: "integer",
                    },
                    freqDivisor: {
                      type: ["integer", "null"],
                    },
                    attenuation: {
                      type: ["integer", "null"],
                    },
                  },
                  required: ["note", "duration", "freqDivisor", "attenuation"],
                },
              },
            },
            required: ["notes"],
          },
        },
      },
      required: ["num", "tracks"],
    },
  },
  {
    name: "inspect_world_bible",
    description:
      "Inspect game resources and authored intent, including staged edits. `filter` is all, rooms, objects, words, intent or slots (null: all); slots lists occupied ranges and next free IDs, narrowed by `kind` (logic, picture, view, sound, null for all). With intent, `section` (rooms, facts, quests or bindings) plus `name` or `offset` selects one entry. Inventory locations are definitions; use read_live for live inventory. This indexes resources and does not prove puzzle behavior.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        section: {
          type: ["string", "null"],
          enum: ["rooms", "facts", "quests", "bindings", null],
        },
        name: {
          type: ["string", "null"],
        },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
        },
        filter: {
          type: ["string", "null"],
        },
        kind: {
          type: ["string", "null"],
          enum: ["logic", "picture", "view", "sound", null],
        },
      },
      required: ["filter", "section", "name", "offset", "kind"],
    },
  },
  {
    name: "playtest_room",
    description:
      "Run a bounded isolated playtest of `room` against staged resources. `steps` command, move, enter, wait, key, direction, walkTo or answer; answer queues a get.string/get.num reply without advancing a cycle and requires null ticks/captureTicks; `expect` asserts room, inventory, flags, variables, a printed message (`printed`) and visible text (`text`). Null `spawnX`/`spawnY` use initialized ego; null steps checks its footprint. captureTicks samples completed ticks within that step into a composed animation sheet. `fromLiveCheckpoint` restores the paused live game's captured checkpoint instead of booting. Null `cycleBudget` (600) and `instructionBudget` (50000) bound the run. Missing destinations report `needs_authoring`.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cycleBudget: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 60000,
        },
        instructionBudget: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 1000000,
        },
        steps: PLAYTEST_STEPS_SCHEMA,
        expect: PLAYTEST_EXPECT_SCHEMA,
        room: {
          type: "integer",
        },
        spawnX: {
          type: ["integer", "null"],
        },
        spawnY: {
          type: ["integer", "null"],
        },
        fromLiveCheckpoint: {
          type: ["boolean", "null"],
        },
      },
      required: [
        "room",
        "spawnX",
        "spawnY",
        "steps",
        "expect",
        "cycleBudget",
        "instructionBudget",
        "fromLiveCheckpoint",
      ],
    },
  },
  {
    name: "read_live",
    description:
      "Read live interpreter state. `state` returns rooms, ego, variables, flags, strings, parsed input, horizon and modal — `compact` omits zeroes, `variables`/`flags` select indices. `objects` returns the screen-object table (view/cel, geometry, priority, direction, cycling, motion; `ids` selects entries, null reads all, object 0 is ego). `frames` returns the last `count` (1..9) frames oldest first, sampled every `stride` cycles — `sheet` (default true) tiles them into one contact sheet, `plane` is visual or priority. Each section null omits it; at least one is required. `read_room_context` bundles the same live sections with room resources and intent. Fails without an attached game.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            variables: {
              type: ["array", "null"],
              maxItems: 256,
              items: { type: "integer", minimum: 0, maximum: 255 },
            },
            flags: {
              type: ["array", "null"],
              maxItems: 256,
              items: { type: "integer", minimum: 0, maximum: 255 },
            },
            compact: { type: ["boolean", "null"] },
          },
          required: ["variables", "flags", "compact"],
        },
        objects: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            ids: {
              type: ["array", "null"],
              maxItems: 256,
              items: { type: "integer", minimum: 0, maximum: 255 },
            },
          },
          required: ["ids"],
        },
        frames: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            count: { type: ["integer", "null"], minimum: 1, maximum: MAX_FRAMES },
            stride: { type: ["integer", "null"], minimum: 1, maximum: 255 },
            sheet: { type: ["boolean", "null"] },
            plane: { type: ["string", "null"] },
          },
          required: ["count", "stride", "sheet", "plane"],
        },
      },
      required: ["state", "objects", "frames"],
    },
  },
];
