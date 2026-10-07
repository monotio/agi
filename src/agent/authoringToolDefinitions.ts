import { toolDescription, parameterDescriptions } from "../vocabulary.ts";
/** Schemas for the authoring tools (bindings and source edits); executeAuthoringTool runs them. */
import type { ToolDefinition } from "./tools.ts";

const nullableId = { type: ["integer", "null"], minimum: 0, maximum: 255 };
const string = { type: "string" };

export const AUTHORING_TOOLS: readonly ToolDefinition[] = [
  {
    name: "reserve_name",
    description: toolDescription(
      "reserve_name",
      "Bind stable lowercase names to resources, flags or variables of `kind` (logic, picture, view, sound, flag or variable). Supports a `bindings` array to reserve multiple names at once, or single `name`/`kind`/`id`. Null `id` allocates a free slot; an explicit `id` binds that slot without changing its contents. Returns `#define` lines.",
    ),
    parameters: parameterDescriptions("reserve_name", {
      type: "object",
      additionalProperties: false,
      properties: {
        bindings: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: string,
              kind: {
                type: "string",
                enum: ["logic", "picture", "view", "sound", "flag", "variable"],
              },
              id: nullableId,
            },
            required: ["name", "kind", "id"],
          },
          description: "List of bindings to reserve in one call.",
        },
        name: { type: ["string", "null"], maxLength: 64 },
        kind: {
          type: ["string", "null"],
          enum: ["logic", "picture", "view", "sound", "flag", "variable", null],
        },
        id: nullableId,
      },
      required: ["bindings", "name", "kind", "id"],
    }),
  },
  {
    name: "edit_source",
    description: toolDescription(
      "edit_source",
      "Apply a batch of exact-text edits to logic or picture `kind` number `num` in one call. Every `find` must occur exactly once in the same source snapshot read_logic or read_picture returns. overlapping occurrences count, and all matches resolve against that snapshot before any edit applies. Edits must not overlap; they apply together through one compilation and one commit. `expectedRevision` must match the current revision. Any conflict or compile error changes nothing.",
    ),
    parameters: parameterDescriptions("edit_source", {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["logic", "picture"] },
        num: { type: "integer", minimum: 0, maximum: 255 },
        expectedRevision: string,
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 65535,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { find: string, replace: string },
            required: ["find", "replace"],
          },
        },
      },
      required: ["kind", "num", "expectedRevision", "edits"],
    }),
  },
  {
    name: "update_plan",
    description: toolDescription(
      "update_plan",
      "Update persistent `rooms`, `facts` and `quests` intent. Empty arrays leave other entries unchanged. Intent does not alter or verify game behavior.",
    ),
    parameters: parameterDescriptions("update_plan", {
      type: "object",
      additionalProperties: false,
      properties: {
        rooms: {
          type: "array",
          maxItems: 255,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              num: { type: "integer", minimum: 1, maximum: 255 },
              title: string,
              description: string,
              exits: {
                type: "array",
                maxItems: 32,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: { name: string, room: { type: "integer", minimum: 1, maximum: 255 } },
                  required: ["name", "room"],
                },
              },
            },
            required: ["num", "title", "description", "exits"],
          },
        },
        facts: {
          type: "array",
          maxItems: 512,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { name: string, text: string },
            required: ["name", "text"],
          },
        },
        quests: {
          type: "array",
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: string,
              description: string,
              requires: { type: "array", maxItems: 64, items: string },
              completedFlag: { type: ["string", "null"] },
            },
            required: ["name", "description", "requires", "completedFlag"],
          },
        },
      },
      required: ["rooms", "facts", "quests"],
    }),
  },
  {
    name: "configure_launch",
    description: toolDescription(
      "configure_launch",
      "Create, update or remove a named Launch configuration for `room`. Create requires a new id or null to allocate one; an existing id is rejected. Update requires an existing id: null or omitted fields retain their values, supplied values replace them, and `clear` lists optional fields to remove. A field cannot be both set and cleared. Maps are arrays of unique {id,value} records; [] removes all map entries. Remove deletes launch `id`. Create uses defaults for null fields. `selected` true selects this launch, false deselects it, and null leaves selection unchanged.",
    ),
    parameters: parameterDescriptions("configure_launch", {
      type: "object",
      additionalProperties: false,
      properties: {
        room: { type: "integer", minimum: 1, maximum: 255 },
        action: { type: "string", enum: ["create", "update", "remove"] },
        id: { type: ["string", "null"] },
        name: { type: ["string", "null"], maxLength: 60 },
        note: { type: ["string", "null"] },
        cameFrom: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            room: { type: "integer", minimum: 0, maximum: 255 },
            edge: { type: ["integer", "null"], minimum: 1, maximum: 4 },
          },
          required: ["room", "edge"],
        },
        flags: {
          type: ["array", "null"],
          maxItems: 256,
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
        variables: {
          type: ["array", "null"],
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "integer", minimum: 0, maximum: 255 },
              value: { type: "integer", minimum: 0, maximum: 255 },
            },
            required: ["id", "value"],
          },
        },
        items: {
          type: ["array", "null"],
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "integer", minimum: 0, maximum: 255 },
              value: { type: "integer", minimum: 0, maximum: 255 },
            },
            required: ["id", "value"],
          },
        },
        clear: {
          type: ["array", "null"],
          maxItems: 7,
          items: {
            type: "string",
            enum: ["note", "cameFrom", "flags", "variables", "items", "hero", "seed"],
          },
        },
        hero: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            x: { type: "integer", minimum: 0, maximum: 159 },
            y: { type: "integer", minimum: 0, maximum: 167 },
          },
          required: ["x", "y"],
        },
        seed: { type: ["integer", "null"], minimum: 0, maximum: 65535 },
        selected: { type: ["boolean", "null"] },
      },
      required: [
        "room",
        "action",
        "id",
        "name",
        "note",
        "cameFrom",
        "flags",
        "variables",
        "items",
        "hero",
        "seed",
        "selected",
        "clear",
      ],
    }),
  },
];
