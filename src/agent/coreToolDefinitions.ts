/** Schemas for core resource editing and runtime inspection tools. */
import type { ToolDefinition } from "./tools.ts";
import { MAX_FRAMES } from "./frames.ts";

export const CORE_AGENT_TOOLS: readonly ToolDefinition[] = [
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
    name: "list_resources",
    description:
      "List occupied ranges and next free IDs. `kind` is logic, picture, view, sound, or null for all. Writing an occupied ID replaces it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: ["string", "null"],
        },
      },
      required: ["kind"],
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
      "Inspect compiled view `num` as a labeled contact sheet. Large views sample at most 32 cels. Fails for absent or invalid resources.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { num: { type: "integer" } },
      required: ["num"],
    },
  },
  {
    name: "write_view",
    description:
      "Compile and replace view `num` from `spec`. Each loop has cels or mirrors a preceding loop (cels null). Pixels are row-major EGA indices. Pixel-count corrections appear in `adjustments`. Returns a compiled contact sheet; large views sample 32 cels. Failure stores nothing.",
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
            loops: {
              type: "array",
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
          required: ["description", "loops"],
        },
      },
      required: ["num", "spec"],
    },
  },
  {
    name: "finish_genesis",
    description:
      "Validate genesis by booting the world in a bounded simulation. The starting room must draw, accept input and place initialized ego fully in walkable space. Returns observed state and a screenshot; failures do not complete genesis. `notes` is optional free text and is not interpreted.",
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
      "Compile and replace the complete OBJECT inventory table from `objects`. `startingRoom`: 255 carried, 1..254 in that room, 0 inactive.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        objects: {
          type: "array",
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
      },
      required: ["objects"],
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
      "Inspect cartridge resources and authored intent, including staged edits. `filter` is all, rooms, objects, words or intent (null: all); with intent, `section` (rooms, facts, quests or bindings) plus `name` or `offset` selects one entry. Inventory locations are definitions; use read_state for live inventory. This indexes resources and does not prove puzzle behavior.",
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
      },
      required: ["filter", "section", "name", "offset"],
    },
  },
  {
    name: "playtest_room",
    description:
      "Run a bounded isolated playtest of `room` against staged resources. `steps` command, move, enter or wait; `expect` asserts room, inventory and flags. Null `spawnX`/`spawnY` use initialized ego; null steps checks its footprint. captureTicks samples completed ticks within that step into a composed animation sheet. Null `cycleBudget` (600) and `instructionBudget` (50000) bound the run. Missing destinations report `needs_authoring`.",
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
        steps: {
          type: ["array", "null"],
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: ["command", "move", "enter", "wait"] },
              command: { type: ["string", "null"] },
              direction: {
                type: ["string", "null"],
                enum: [
                  "up",
                  "up-right",
                  "right",
                  "down-right",
                  "down",
                  "down-left",
                  "left",
                  "up-left",
                  null,
                ],
              },
              ticks: { type: ["integer", "null"], minimum: 1, maximum: 60000 },
              captureTicks: {
                type: ["array", "null"],
                maxItems: 9,
                items: { type: "integer", minimum: 1, maximum: 60000 },
              },
            },
            required: ["action", "command", "direction", "ticks", "captureTicks"],
          },
        },
        expect: {
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
          },
          required: ["room", "carriedItems", "flags"],
        },
        room: {
          type: "integer",
        },
        spawnX: {
          type: ["integer", "null"],
        },
        spawnY: {
          type: ["integer", "null"],
        },
      },
      required: ["room", "spawnX", "spawnY", "steps", "expect", "cycleBudget", "instructionBudget"],
    },
  },
  {
    name: "read_frames",
    description:
      "Read the last `count` (1..9) frames oldest first, sampling every `stride` cycles; null returns one visual frame. `sheet` tiles them into one contact sheet to show motion; `plane` is visual or priority (collision/depth). Text is transcribed separately. Fails without frames.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        count: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: MAX_FRAMES,
        },
        stride: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 255,
        },
        sheet: {
          type: ["boolean", "null"],
        },
        plane: {
          type: ["string", "null"],
        },
      },
      required: ["count", "stride", "sheet", "plane"],
    },
  },
  {
    name: "read_objects",
    description:
      "Read the current screen-object table: view/cel, geometry, priority, direction, cycling and motion. `ids` selects objects; null reads all. Object 0 is ego. Read again after movement. Fails without an attached game.",
    parameters: {
      type: "object",
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
  },
  {
    name: "read_state",
    description:
      "Read live rooms, ego, variables, flags, strings, parsed input, horizon and modal state. Null selects complete tables; compact omits zeroes. Fails without a game.",
    parameters: {
      type: "object",
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
        compact: {
          type: ["boolean", "null"],
        },
      },
      required: ["variables", "flags", "compact"],
    },
  },
];
