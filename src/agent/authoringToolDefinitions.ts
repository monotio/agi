/** Schemas for the authoring tools (bindings and source edits); executeAuthoringTool runs them. */
import type { ToolDefinition } from "./tools.ts";

const nullableId = { type: ["integer", "null"], minimum: 0, maximum: 255 };
const string = { type: "string" };

export const AUTHORING_TOOLS: readonly ToolDefinition[] = [
  {
    name: "reserve_binding",
    description:
      "Bind stable lowercase names to resources, flags or variables of `kind` (logic, picture, view, sound, flag or variable). Supports a `bindings` array to reserve multiple names at once, or single `name`/`kind`/`id`. Null `id` allocates a free slot; an explicit `id` binds that slot without changing its contents. Returns `#define` lines.",
    parameters: {
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
    },
  },
  {
    name: "edit_resource_source",
    description:
      "Apply a batch of exact-text edits to logic or picture `kind` number `num` in one call. Every `find` must occur exactly once in the same source snapshot read_logic or read_picture returns — overlapping occurrences count, and all matches resolve against that snapshot before any edit applies. Edits must not overlap; they apply together through one compilation and one commit. `expectedRevision` must match the current revision. Any conflict or compile error changes nothing.",
    parameters: {
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
    },
  },
  {
    name: "update_world",
    description:
      "Update persistent `rooms`, `facts` and `quests` intent. Empty arrays leave other entries unchanged. Intent does not alter or verify game behavior.",
    parameters: {
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
    },
  },
];
