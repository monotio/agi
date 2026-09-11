import {
  authoredLogicSource,
  authoredPictureSource,
  executeAgentTool,
  type AgentSessionState,
  type AgentToolResult,
  type ToolDefinition,
} from "./tools.ts";
import { readInventoryObjects } from "./inventory.ts";
import { sourceRevision, validateAuthoringState, type BindingKind } from "./authoringState.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { readPictureSource } from "../picture/source.ts";

const nullableId = { type: ["integer", "null"], minimum: 0, maximum: 255 };
const string = { type: "string" };

/** The exact text read_logic/read_picture show and edit_resource_source patches. */
export function editableSource(
  state: AgentSessionState,
  kind: "logic" | "picture",
  num: number,
): string | undefined {
  const payload = state.container.getResource(kind, num);
  if (!payload) return undefined;
  const decoded =
    kind === "logic"
      ? disassembleLogic(payload, { dictionary: state.sources.words, profile: state.profile })
      : readPictureSource(state.container, num, { profile: state.profile });
  return (
    (kind === "logic" ? authoredLogicSource(state, num) : authoredPictureSource(state, num)) ??
    decoded ??
    undefined
  );
}

/** Revision of the editable snapshot: shown text plus its compilation context. */
export function sourceContextRevision(
  state: AgentSessionState,
  kind: "logic" | "picture",
  num: number,
  source: string,
): string {
  return sourceRevision(state.container.getResource(kind, num), source, {
    profile: state.profile.id,
    words: [...state.sources.words.keys()].sort(),
    bindings: state.authoring.bindings,
  });
}

export const AUTHORING_TOOLS: readonly ToolDefinition[] = [
  {
    name: "reserve_binding",
    description:
      "Bind stable lowercase names to resources, flags or variables of `kind` (logic, picture, view, sound, flag or variable). Supports a `bindings` array to reserve multiple names at once, or single `name`/`kind`/`id`. Null `id` allocates safely; an explicit `id` binds that slot without changing its contents. Returns `#define` lines.",
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
    name: "upsert_inventory_item",
    description:
      "Add or update one inventory definition while preserving other IDs. Null `id` appends; `name` is the item text; `location` is carried, room or inactive, and `room` (1..254) applies only to location room. Live ownership is unchanged; game logic changes it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: nullableId,
        name: string,
        location: { type: "string", enum: ["carried", "room", "inactive"] },
        room: { type: ["integer", "null"], minimum: 1, maximum: 254 },
      },
      required: ["id", "name", "location", "room"],
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
          maxItems: 64,
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

/** Discover static operands; refuse automatic allocation where runtime indirection obscures usage. */
function occupiedIds(state: AgentSessionState, kind: BindingKind): Set<number> {
  const used = new Set(
    Object.values(state.authoring.bindings)
      .filter((binding) => binding.kind === kind)
      .map((binding) => binding.num),
  );
  if (kind !== "flag" && kind !== "variable") {
    for (let num = 0; num < 256; num++) {
      try {
        if (state.container.getResource(kind, num)) used.add(num);
      } catch {
        used.add(num);
      }
    }
    return used;
  }
  for (let num = 0; num < 256; num++) {
    const payload = state.container.getResource("logic", num);
    if (!payload) continue;
    const source = disassembleLogic(payload, {
      profile: state.profile,
      dictionary: state.sources.words,
    });
    if (
      source.includes("// !!") ||
      /\b(?:lindirectv|rindirect|lindirectn|set\.v|reset\.v|toggle\.v|isset\.v)\s*\(/.test(source)
    )
      throw new Error(
        `Logic ${num} has indirect or undecodable state access. Read its logic and bind an explicit ID; automatic allocation cannot establish a free ${kind}.`,
      );
    // Remove literals/comments: a message saying 'f32' is not an operand.
    const code = source.replace(/\/\/[^\n]*|"(?:\\[^\n]|[^"\\\n])*"/g, "");
    for (const match of code.matchAll(kind === "flag" ? /\bf(\d+)\b/g : /\bv(\d+)\b/g))
      used.add(Number(match[1]));
  }
  if (kind === "flag") used.add(200);
  return used;
}

export function executeAuthoringTool(
  state: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (!AUTHORING_TOOLS.some((tool) => tool.name === name)) return undefined;
  try {
    if (name === "reserve_binding") {
      let items: { name: unknown; kind: unknown; id: unknown }[];
      if (Array.isArray(args["bindings"])) {
        items = args["bindings"] as { name: unknown; kind: unknown; id: unknown }[];
        if (items.length === 0) throw new Error("bindings array must not be empty.");
      } else if (args["name"] != null) {
        items = [{ name: args["name"], kind: args["kind"], id: args["id"] }];
      } else {
        throw new Error("Must provide either 'bindings' array or 'name', 'kind', and 'id'.");
      }

      const reservedList: { name: string; kind: BindingKind; num: number; define: string }[] = [];
      const messages: string[] = [];

      for (const item of items) {
        const symbol = item.name;
        const kind = item.kind as BindingKind;
        if (
          typeof symbol !== "string" ||
          !/^[a-z][a-z0-9_]{0,63}$/.test(symbol) ||
          ["__proto__", "constructor", "prototype"].includes(symbol)
        )
          throw new Error(
            `name '${String(symbol)}' must be a lowercase identifier of at most 64 characters.`,
          );
        if (!["logic", "picture", "view", "sound", "flag", "variable"].includes(kind))
          throw new Error(`Invalid binding kind '${String(kind)}'.`);
        const existing = state.authoring.bindings[symbol];
        let num = item.id;
        if (existing) {
          if (existing.kind !== kind || (num != null && existing.num !== num))
            throw new Error(
              `Binding '${symbol}' already means ${existing.kind} ${existing.num}; use its existing ID.`,
            );
          num = existing.num;
        } else if (num == null) {
          const used = occupiedIds(state, kind);
          for (const b of reservedList) {
            if (b.kind === kind) used.add(b.num);
          }
          const start = kind === "flag" || kind === "variable" ? 32 : 1;
          num = Array.from({ length: 256 - start }, (_, index) => start + index).find(
            (id) => !used.has(id),
          );
          if (num === undefined) throw new Error(`No free ${kind} IDs remain.`);
        }
        if (typeof num !== "number" || !Number.isInteger(num) || num < 0 || num > 255)
          throw new Error("id must be null or an integer in 0..255.");
        state.authoring.bindings[symbol] = { kind, num };
        reservedList.push({
          name: symbol,
          kind,
          num,
          define: `#define ${symbol} ${num}`,
        });
        messages.push(`${symbol} = ${kind} ${num}`);
      }

      if (reservedList.length === 1 && !Array.isArray(args["bindings"])) {
        const first = reservedList[0]!;
        return {
          success: true,
          message: `${first.name} = ${first.kind} ${first.num}. Logic tools accept this name.`,
          details: {
            name: first.name,
            kind: first.kind,
            num: first.num,
            define: first.define,
            authoringChanged: true,
          },
        };
      }

      return {
        success: true,
        message: `${reservedList.length} bindings reserved: ${messages.join(", ")}. Logic tools accept these names.`,
        details: {
          bindings: reservedList,
          defines: reservedList.map((r) => r.define).join("\n"),
          authoringChanged: true,
        },
      };
    }
    if (name === "upsert_inventory_item") {
      const items = readInventoryObjects(state.getFiles().get("OBJECT"), state.profile);
      const id = args["id"] == null ? items.length : args["id"];
      const itemName = args["name"];
      if (
        typeof id !== "number" ||
        !Number.isInteger(id) ||
        id < 0 ||
        id > items.length ||
        id > 255
      )
        throw new Error("id must name an existing item, or be null to append.");
      if (
        typeof itemName !== "string" ||
        !itemName.trim() ||
        [...itemName].some((char) => char.charCodeAt(0) === 0 || char.charCodeAt(0) > 255)
      )
        throw new Error("name must be nonempty AGI byte text without zero bytes.");
      const location = args["location"];
      if (!["carried", "room", "inactive"].includes(String(location)))
        throw new Error("location must be carried, room, or inactive.");
      const room = location === "carried" ? 255 : location === "inactive" ? 0 : args["room"];
      if (
        typeof room !== "number" ||
        !Number.isInteger(room) ||
        room < 0 ||
        room > 255 ||
        (location === "room" && (room < 1 || room > 254))
      )
        throw new Error("A room location needs room 1..254.");
      items[id] = { name: itemName.trim(), startingRoom: room };
      const result = executeAgentTool(state, "write_inventory_objects", { objects: items });
      return {
        ...result,
        details: {
          ...result.details,
          id,
          name: itemName.trim(),
          updatedFiles: result.success ? ["OBJECT"] : [],
        },
      };
    }
    if (name === "edit_resource_source") {
      const kind = args["kind"];
      const num = args["num"];
      if (
        (kind !== "logic" && kind !== "picture") ||
        typeof num !== "number" ||
        !Number.isInteger(num) ||
        num < 0 ||
        num > 255
      )
        throw new Error("Select a logic or picture resource number 0..255.");
      const source = editableSource(state, kind, num);
      if (!source) throw new Error(`No readable source for ${kind} ${num}.`);
      // The token covers the shown text and its compilation context (profile,
      // dictionary, bindings), not just bytes — drift on any of them is a
      // revision conflict, even when the resource payload is unchanged.
      const revision = sourceContextRevision(state, kind, num, source);
      if (revision !== args["expectedRevision"])
        throw new Error(
          "Source revision changed. Read the current source before editing; its text, dictionary, profile, or named bindings may have drifted.",
        );
      const edits = args["edits"];
      if (!Array.isArray(edits) || !edits.length || edits.length > 64)
        throw new Error("edits must name 1..64 find/replace pairs.");
      const fail = (message: string, editIndex: number, excerpt: string): AgentToolResult => ({
        success: false,
        error: message,
        details: {
          diagnostic: {
            tool: name,
            message,
            changed: false,
            editIndex,
            excerpt,
            revision,
          },
        },
      });
      // Resolve every find against the same snapshot before applying anything.
      const resolved: { index: number; offset: number; length: number; replace: string }[] = [];
      for (const [index, raw] of edits.entries()) {
        const edit = raw as Record<string, unknown> | null;
        const find = edit?.["find"];
        const replace = edit?.["replace"];
        if (typeof find !== "string" || !find || typeof replace !== "string")
          return fail(
            `Edit ${index} must name a nonempty 'find' string and a 'replace' string.`,
            index,
            "",
          );
        const hits: number[] = [];
        for (let at = source.indexOf(find); at !== -1; at = source.indexOf(find, at + 1))
          hits.push(at);
        if (hits.length !== 1) {
          const at = hits[0] ?? 0;
          return fail(
            `Edit ${index}: 'find' matched ${hits.length} times; it must match exactly one source section.`,
            index,
            source.slice(Math.max(0, at - 60), at + find.length + 60),
          );
        }
        resolved.push({ index, offset: hits[0]!, length: find.length, replace });
      }
      const ordered = [...resolved].sort((a, b) => a.offset - b.offset);
      for (let i = 1; i < ordered.length; i++) {
        const previous = ordered[i - 1]!;
        const next = ordered[i]!;
        if (previous.offset + previous.length > next.offset)
          return fail(
            `Edits ${previous.index} and ${next.index} overlap; merge them into one find/replace.`,
            next.index,
            source.slice(previous.offset, next.offset + next.length),
          );
      }
      // Apply descending so earlier offsets stay valid on the shared snapshot.
      let next = source;
      for (const edit of ordered.reverse())
        next = next.slice(0, edit.offset) + edit.replace + next.slice(edit.offset + edit.length);
      return executeAgentTool(state, kind === "logic" ? "write_logic_source" : "write_picture", {
        room: num,
        source: next,
      });
    }
    const next = validateAuthoringState(state.authoring);
    for (const category of ["rooms", "facts", "quests"] as const) {
      const entries = args[category];
      if (!Array.isArray(entries))
        throw new Error(`${category} must be an array; use [] to leave it unchanged.`);
      for (const raw of entries) {
        if (!raw || typeof raw !== "object") throw new Error(`Invalid ${category} entry.`);
        const item = raw as Record<string, unknown>;
        if (category === "rooms") {
          if (!Array.isArray(item["exits"])) throw new Error("Room exits must be an array.");
          if (
            typeof item["num"] !== "number" ||
            !Number.isInteger(item["num"]) ||
            item["num"] < 0 ||
            item["num"] > 255
          )
            throw new Error("Room num must be 0..255.");
          next.world.rooms[String(item["num"])] = {
            title: item["title"] as string,
            description: item["description"] as string,
            exits: Object.fromEntries(item["exits"].map((exit) => [exit.name, exit.room])),
          };
        } else if (category === "facts") {
          Object.defineProperty(next.world.facts, String(item["name"]), {
            value: item["text"],
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } else {
          Object.defineProperty(next.world.quests, String(item["name"]), {
            value: {
              description: item["description"],
              requires: item["requires"],
              ...(item["completedFlag"] == null ? {} : { completedFlag: item["completedFlag"] }),
            },
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
    }
    state.authoring = validateAuthoringState(next);
    return {
      success: true,
      message: "Authoring intent updated. Compile game resources to implement it.",
      details: {
        rooms: Object.keys(next.world.rooms).length,
        facts: Object.keys(next.world.facts).length,
        quests: Object.keys(next.world.quests).length,
        authoringChanged: true,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
      details: { diagnostic: { tool: name, message: String(error), changed: false } },
    };
  }
}
