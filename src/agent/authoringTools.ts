import {
  authoredPictureSource,
  executeAgentTool,
  type AgentSessionState,
  type AgentToolResult,
  type ToolDefinition,
} from "./tools.ts";
import { readInventoryObjects } from "./inventory.ts";
import { resourceRevision, validateAuthoringState, type BindingKind } from "./authoringState.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { readPictureSource } from "../picture/source.ts";

const nullableId = { type: ["integer", "null"], minimum: 0, maximum: 255 };
const string = { type: "string" };

export const AUTHORING_TOOLS: readonly ToolDefinition[] = [
  {
    name: "reserve_binding",
    description:
      "Bind a stable lowercase `name` to a resource, flag or variable of `kind` (logic, picture, view, sound, flag or variable). Null `id` allocates safely; an explicit `id` binds that slot without changing its contents. Indirect variable/flag access prevents automatic allocation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: string,
        kind: { type: "string", enum: ["logic", "picture", "view", "sound", "flag", "variable"] },
        id: nullableId,
      },
      required: ["name", "kind", "id"],
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
      "Replace one exact source section of logic or picture `kind` number `num`: `find` must occur once in the source read_logic or read_picture returns and becomes `replace`. Pictures written this session keep their authored source; disassembly can normalize other syntax. `expectedRevision` must match the current revision. The full result compiles before storage; any conflict or compile error changes nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["logic", "picture"] },
        num: { type: "integer", minimum: 0, maximum: 255 },
        expectedRevision: string,
        find: string,
        replace: string,
      },
      required: ["kind", "num", "expectedRevision", "find", "replace"],
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
      const symbol = args["name"];
      const kind = args["kind"] as BindingKind;
      if (
        typeof symbol !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(symbol) ||
        ["__proto__", "constructor", "prototype"].includes(symbol)
      )
        throw new Error("name must be a lowercase identifier of at most 64 characters.");
      if (!["logic", "picture", "view", "sound", "flag", "variable"].includes(kind))
        throw new Error("Invalid binding kind.");
      const existing = state.authoring.bindings[symbol];
      let num = args["id"];
      if (existing) {
        if (existing.kind !== kind || (num != null && existing.num !== num))
          throw new Error(
            `Binding '${symbol}' already means ${existing.kind} ${existing.num}; use its existing ID.`,
          );
        num = existing.num;
      } else if (num == null) {
        const used = occupiedIds(state, kind);
        const start = kind === "flag" || kind === "variable" ? 32 : 1;
        num = Array.from({ length: 256 - start }, (_, index) => start + index).find(
          (id) => !used.has(id),
        );
        if (num === undefined) throw new Error(`No free ${kind} IDs remain.`);
      }
      if (typeof num !== "number" || !Number.isInteger(num) || num < 0 || num > 255)
        throw new Error("id must be null or an integer in 0..255.");
      state.authoring.bindings[symbol] = { kind, num };
      return {
        success: true,
        message: `${symbol} = ${kind} ${num}. Logic tools accept this name.`,
        details: {
          name: symbol,
          kind,
          num,
          define: `#define ${symbol} ${num}`,
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
      const payload = state.container.getResource(kind, num);
      if (!payload || resourceRevision(payload) !== args["expectedRevision"])
        throw new Error(
          "Resource revision changed or is absent. Read the current source before editing.",
        );
      // One source of truth per kind: pictures edit the text the agent wrote
      // (what read_picture returns) while it still matches the resource, and
      // fall back to disassembly for pictures never written or since changed.
      const source =
        kind === "logic"
          ? disassembleLogic(payload, { dictionary: state.sources.words, profile: state.profile })
          : (authoredPictureSource(state, num) ??
            readPictureSource(state.container, num, { profile: state.profile }));
      const find = args["find"];
      const replacement = args["replace"];
      if (
        !source ||
        typeof find !== "string" ||
        !find ||
        typeof replacement !== "string" ||
        source.split(find).length !== 2
      )
        throw new Error("find must match exactly one nonempty source section.");
      return executeAgentTool(state, kind === "logic" ? "write_logic_source" : "write_picture", {
        room: num,
        source: source.replace(find, () => replacement),
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
