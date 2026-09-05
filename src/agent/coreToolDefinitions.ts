/** Schemas for core resource editing and runtime inspection tools. */
import type { ToolDefinition } from "./tools.ts";

export const CORE_AGENT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_room_context",
    description:
      "Inspect a room's compiled behavior and current authoring intent in one bounded read. room null selects the live room when attached; otherwise supply its number. Returns a resource index, revision and dependencies for the room logic, named bindings and inventory definitions, with compact live state when available. Live state describes the paused interpreter, while compiled resources include staged edits. It does not infer story facts from filenames or claim a puzzle works.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 255,
          description: "Room number, or null for the live current room.",
        },
      },
      required: ["room"],
    },
  },
  {
    name: "write_words",
    description:
      "Register parser vocabulary and compile it into WORDS.TOK. groups optionally supplies explicit arrays of synonyms, preserving multiword phrases such as pick up. Each entry in `words` is one dictionary word, or a slash-separated synonym group ('take/get/grab') whose members share a single word id. said() compiles only against words already registered here, and standard navigation words are added automatically and listed under `adjustments`. Returns the total word count and the compiled dictionary size; a compilation failure stores nothing.",
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
          description:
            "Explicit synonym groups; null uses only words. Multiword phrases retain their spaces.",
        },
        words: {
          type: "array",
          items: { type: "string" },
          description:
            "List of words and synonym groups (e.g. ['look', 'take/get', 'open', 'door']).",
        },
      },
      required: ["words", "groups"],
    },
  },
  {
    name: "write_logic_source",
    description:
      "Compile AGI logic source to genuine bytecode and store it as logic `room` (0 is the boot script, 1..255 are room logics). `source` is the complete resource text \u2014 #message directives plus code \u2014 and replaces whatever that number held. On success it returns the bytecode size, total payload size and message count. On failure the assembler's diagnostic comes back verbatim and nothing is stored, so correct it and resend the complete source; a said() word that is not in the dictionary is one such failure.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: "integer",
          description: "Logic resource number (0 for boot logic, 1..255 for room logics).",
        },
        source: {
          type: "string",
          description:
            "Full AGI logic source including #message directives and code. Prefer ASCII punctuation. Inside string literals, smart quotes, en/em dashes and ellipses are converted to ASCII and reported; explicit byte escapes remain exact. Other non-byte characters fail compilation.",
        },
      },
      required: ["room", "source"],
    },
  },
  {
    name: "write_picture",
    description:
      "Compile a line-oriented picture source, render it, store it as picture `room`, and return the rendering as an image block to look at. `source` is the complete picture: every call replaces the whole resource, so never send a fragment. The result carries the render plus fill-coverage, palette, command-count and priority-band metrics; an 8x7 grid of the dominant colour per cell of what actually rendered; for every `# layout: <name> x<a>-<b> y<c>-<d> colour <n>` comment in the source, the colour and coverage that landed in that box, the extent of the largest region drawn there, and a verdict (OK/UNDERFILLED/SHIFTED/MISSING); when you are revising a picture you already wrote this session, how many of the previous source's commands survived in order and how far the pixel change spread beyond the one region it touched; and a revision counter for this picture. Compile errors come back verbatim with line numbers and nothing is stored.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: "integer",
          description: "Picture resource number (0..255).",
        },
        source: {
          type: "string",
          description:
            "Complete picture source: one command per line (vis/pri/line/polygon/rect/rel/xcorner/ycorner/fill/pen/plot/end), decimal operands, 'x,y' coordinate pairs, '#' comments.",
        },
      },
      required: ["room", "source"],
    },
  },
  {
    name: "read_picture",
    description:
      "Read a stored picture back as editable vector source and a rendered image block. `num` is the picture resource number. Returns the source text, line count and actual compiled rendering, so you can inspect existing scenery after loading a cartridge. Fails, naming the number, when that picture is absent or invalid.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer", description: "Picture resource number (0..255)." },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
          description: "Zero-based source line offset; null starts at zero.",
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 400,
          description: "Maximum source lines; null returns 200.",
        },
        include: {
          type: ["string", "null"],
          enum: ["source", "image", "both", null],
          description: "Select source, image, or both (null).",
        },
      },
      required: ["num", "offset", "limit", "include"],
    },
  },
  {
    name: "read_logic",
    description:
      "Read a stored logic resource back as assembler source, disassembled from the container bytecode with said() word ids resolved through the dictionary. `num` is the logic resource number. The output re-assembles to byte-identical bytecode, so a one-line change round-trips exactly through write_logic_source. Returns the source and the resource size; it fails when the number is absent or the bytecode does not disassemble.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer", description: "Logic resource number (0..255)." },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
          description: "Zero-based source line offset; null starts at zero.",
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 400,
          description: "Maximum source lines; null returns 200.",
        },
      },
      required: ["num", "offset", "limit"],
    },
  },
  {
    name: "list_resources",
    description:
      "List which logic, picture, view and sound numbers the container holds and which are free. `kind` narrows the report to one family ('logic', 'picture', 'view' or 'sound'); null lists all four. Writing an occupied number replaces that resource, so this is how you find a safe number for anything new. Returns the present ranges and the next free numbers per family.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: ["string", "null"],
          description:
            "Optional single family to list: 'logic', 'picture', 'view' or 'sound'. Null lists all four.",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "read_words",
    description:
      "Summarise the parser dictionary: how many words are registered, how they group into synonym sets by word id, and a sample of the vocabulary. `prefix` filters to words starting with it; null returns the whole summary. Returns the group listing and whether the dictionary has been compiled yet, which is the ground truth for what said() can match.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        exact: {
          type: ["string", "null"],
          description: "Exact word to look up; null disables exact filtering.",
        },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
          description: "Zero-based synonym group offset; null means zero.",
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 100,
          description: "Maximum groups; null means 60.",
        },
        prefix: {
          type: ["string", "null"],
          description: "Optional prefix filter; null returns the whole summary.",
        },
      },
      required: ["prefix", "exact", "offset", "limit"],
    },
  },
  {
    name: "read_view",
    description:
      "Inspect an existing sprite from its compiled bytes, including after loading a saved or imported cartridge. `num` is the view resource number; use read_objects or read_logic to identify the view actually used by ego. Returns a bounded contact-sheet image with loop/cel labels and resource counts, without pixel arrays in text. Large sprites sample at most 32 cels; the caption identifies the sample. Fails when the resource is absent or invalid.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { num: { type: "integer", description: "View resource number (0..255)." } },
      required: ["num"],
    },
  },
  {
    name: "write_view",
    description:
      "Compile a view resource \u2014 the sprite format of loops (facing directions) holding cels (animation frames) \u2014 and store it as view `num`; view 0 is the protagonist. Each entry in `spec.loops` either carries its own `cels` (width, height, transparentColor and row-major EGA pixel indices) or a `mirrorLoop` index naming the loop it mirrors, never both. Pixel counts that disagree with width * height are padded or truncated and every correction is reported under `adjustments`. Returns a contact-sheet image rendered from the compiled bytes, including mirrored directions, plus loop count and compiled size. Inspect the image before continuing. Large views are sampled to at most 32 cels in one image; the caption identifies every tile. A compilation failure stores nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
          description: "View resource number (0 for ego/protagonist, 1..255 for NPCs/objects).",
        },
        spec: {
          type: "object",
          additionalProperties: false,
          description: "View specification with loops, cels, and optional view description.",
          properties: {
            description: {
              type: ["string", "null"],
              description: "Optional description of the view resource.",
            },
            loops: {
              type: "array",
              description:
                "For automatic walking directions, use four loops in AGI order: loop 0 = right, loop 1 = left, loop 2 = down (front), loop 3 = up (back). Two or three loops automatically select only right/left; up/down keep the current loop. Single-loop props and game-controlled loops are also valid. Inspect existing logic for fix.loop overrides when remixing.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  mirrorLoop: {
                    type: ["integer", "null"],
                    description:
                      "Optional 0-based index of a preceding loop to mirror (e.g. loop 1 mirroring loop 0). When mirroring, set cels to null. Loop 0 must have cels and mirrorLoop null.",
                  },
                  cels: {
                    type: ["array", "null"],
                    description:
                      "Cels belonging to this loop (required if mirrorLoop is null; set to null if mirrorLoop is specified).",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        width: {
                          type: "integer",
                          description: "Width in logical pixels (1..160).",
                        },
                        height: {
                          type: "integer",
                          description: "Height in logical pixels (1..168).",
                        },
                        transparentColor: {
                          type: ["integer", "null"],
                          description: "Transparent color index (0..15). Defaults to 0 if null.",
                        },
                        mirror: {
                          type: ["boolean", "null"],
                          description:
                            "Whether this cel is mirrorable (bit 0x80). Defaults to false if null.",
                        },
                        pixels: {
                          type: "array",
                          items: { type: "integer" },
                          description:
                            "Row-major color indices (0..15), length must equal width * height.",
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
      "Validate a from-scratch world by booting the real interpreter in an isolated bounded simulation. `notes` describes what was built. The actual starting room must show a picture, enable input, initialize ego and place its complete footprint in valid walkable space. Returns observed state and a screenshot; missing dependencies, blocking host services or runaway code fail without completing genesis. Use playtest_room with commands and expected outcomes to validate puzzles separately.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        notes: {
          type: ["string", "null"],
          description: "Summary of genesis world creation and starting room setup.",
        },
      },
      required: ["notes"],
    },
  },
  {
    name: "write_inventory_objects",
    description:
      "Define the inventory item table (the OBJECT file) from `objects`, each an item name with its starting location. `startingRoom` is 255 for an item the player starts carrying, 1..254 for one lying in that room, and 0 for an inactive item. Every call replaces the whole table, so always send the complete item list. Returns the item count and the encoded size.",
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
              name: { type: "string", description: "Display name of the inventory item." },
              startingRoom: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 255,
                description: "Starting room: 255 = carried, 1..254 = in room, 0 = inactive.",
              },
            },
            required: ["name", "startingRoom"],
          },
          description: "List of inventory items with display names and initial room locations.",
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "write_sound",
    description:
      "Compile a sound resource of up to four channels \u2014 three tone voices and one noise voice \u2014 and store it as sound `num`. `tracks` holds one entry per channel; each note in a track carries a `duration` in 60 Hz ticks plus either a `note` (a MIDI number such as 60, or a name such as 'C4' or 'D#5', or 'rest' for silence) or a raw `freqDivisor`, and an `attenuation` of 0..15 where 15 is silent. Note names and MIDI numbers are converted to authentic AGI frequency divisors for you. Returns the track count and the compiled size.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: {
          type: "integer",
          description: "Sound resource number (1..255).",
        },
        tracks: {
          type: "array",
          description:
            "Array of channel tracks (channels 0..2 for tone voices, channel 3 for noise). Each track is an array of notes.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              notes: {
                type: "array",
                description: "Sequence of notes in this channel.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    note: {
                      type: ["integer", "string", "null"],
                      description:
                        "MIDI note number (e.g. 60 for C4, 69 for A440) or note name ('C4', 'E4', 'G4', 'rest'). Null or 'rest' for silence.",
                    },
                    duration: {
                      type: "integer",
                      description:
                        "Duration in 60Hz sound ticks (1..65534). E.g. 15 = eighth note, 30 = quarter note, 60 = half note.",
                    },
                    freqDivisor: {
                      type: ["integer", "null"],
                      description:
                        "Optional raw 10-bit tone frequency divisor (0..1023). Leave null to compute automatically from note.",
                    },
                    attenuation: {
                      type: ["integer", "null"],
                      description:
                        "Attenuation volume level 0 (loudest) to 15 (silence). Default is 0 if null, or 15 for rests.",
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
      "Report resources from the current cartridge, including saved/imported resources and edits staged this turn. `filter` selects 'all', 'rooms', 'objects' or 'words'; null means all. Returns room/resource numbers, views, sounds, indexed inventory definitions and dictionary size. Authored intent is summarized; filter intent reads one full entry from section rooms, facts, quests or bindings, selected by exact name or offset. Inventory startingRoom values are definitions, not current carried locations; use read_state for live inventory. This is a resource index, not a story synopsis or proof that puzzles work.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        section: {
          type: ["string", "null"],
          enum: ["rooms", "facts", "quests", "bindings", null],
          description: "Intent section; null selects facts.",
        },
        name: {
          type: ["string", "null"],
          description:
            "Exact intent key (room number as text, fact, quest or binding name); null selects by offset.",
        },
        offset: {
          type: ["integer", "null"],
          minimum: 0,
          description: "Zero-based entry offset for intent pagination; null starts at zero.",
        },
        filter: {
          type: ["string", "null"],
          description: "Optional filter: 'all', 'rooms', 'objects', 'words', or 'intent'.",
        },
      },
      required: ["filter", "section", "name", "offset"],
    },
  },
  {
    name: "playtest_room",
    description:
      "Run a bounded isolated copy of the actual interpreter with staged game resources. room selects the room; spawnX and spawnY null use its initialized ego position. steps can type commands, move, press Enter, or wait; expect asserts the resulting room, carriedItems and flags. Returns observed state, action results, messages and one screenshot. Missing future rooms are reported as needs_authoring, not successful tested destinations; unsupported host services stop without external effects. Null steps checks only the complete spawn footprint, not interaction reachability.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cycleBudget: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 60000,
          description:
            "Total simulated cycles; null uses 600. Increase for long timers or walkthroughs.",
        },
        instructionBudget: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 1000000,
          description:
            "Instructions per cycle; null uses 50000. Increase for complex valid logic; non-returning loops still fail.",
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
            },
            required: ["action", "command", "direction", "ticks"],
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
          description: "Room resource number to playtest (1..255).",
        },
        spawnX: {
          type: ["integer", "null"],
          description: "Optional spawn X coordinate (null uses actual ego).",
        },
        spawnY: {
          type: ["integer", "null"],
          description: "Optional spawn Y coordinate (null uses actual ego).",
        },
      },
      required: ["room", "spawnX", "spawnY", "steps", "expect", "cycleBudget", "instructionBudget"],
    },
  },
  {
    name: "read_frames",
    description:
      "Look at the running game: returns recently rendered frames from the interpreter's frame ring as PNG image blocks. `count` (1..9) frames are sampled every `stride` interpreter cycles and returned oldest first; `sheet` true packs them into one row-major contact sheet so motion reads in a single image; `plane` 'priority' renders the control/depth surface instead of the visual one. The picture band is composited exactly as the screen shows it (320x200, each logical pixel doubled horizontally), while text rows are not drawn into the image and come back transcribed in the message instead. Fails when no game is attached to the session, or when the ring holds no frame yet.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        count: {
          type: ["integer", "null"],
          description: "How many frames to return, oldest first, newest last. 1..9; null means 1.",
        },
        stride: {
          type: ["integer", "null"],
          description:
            "Take every Nth interpreter cycle. 1 (null) samples consecutive cycles; larger values span more time.",
        },
        sheet: {
          type: ["boolean", "null"],
          description:
            "True packs the frames into one contact sheet image; false (null) returns one image per frame.",
        },
        plane: {
          type: ["string", "null"],
          description:
            "'visual' (null) renders what the player sees; 'priority' renders the priority/control surface instead.",
        },
      },
      required: ["count", "stride", "sheet", "plane"],
    },
  },
  {
    name: "read_objects",
    description:
      "Dump the interpreter's screen-object table as it stands right now: every active object with its view, loop and cel, position, size, priority and whether that priority is fixed, direction, step size and time, cycling mode and time, motion mode and update flag. Object 0 is ego. ids optionally selects object numbers; null returns all active objects. It reflects the exact cycle the game is parked on, so read it again after anything moves. Fails when no game is attached to the session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ids: {
          type: ["array", "null"],
          maxItems: 256,
          items: { type: "integer", minimum: 0, maximum: 255 },
          description: "Selected screen object IDs; null returns all active objects.",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "read_state",
    description:
      "Read the live interpreter state: the version profile, current and previous room, ego position and direction, all 256 vars and all 256 flags, the string slots, the last input line with its parsed word ids and word count, the horizon row, and any open modal window. variables and flags optionally select numeric IDs; compact true returns only nonzero values when no IDs are selected. Null options return the complete tables. This is where the running game says which room the player is in and which flags are set. Fails when no game is attached to the session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        variables: {
          type: ["array", "null"],
          maxItems: 256,
          items: { type: "integer", minimum: 0, maximum: 255 },
          description: "Selected variable IDs, or null for all.",
        },
        flags: {
          type: ["array", "null"],
          maxItems: 256,
          items: { type: "integer", minimum: 0, maximum: 255 },
          description: "Selected flag IDs, or null for all.",
        },
        compact: {
          type: ["boolean", "null"],
          description:
            "True omits zero values unless their IDs were explicitly requested; null returns complete arrays.",
        },
      },
      required: ["variables", "flags", "compact"],
    },
  },
];
