/** Room scaffolding compiles ordinary AGI resources; the low-level source tools remain available. */
import { assembleLogic } from "../logic/assembler.ts";
import { buildWordsTok, parseWordsTok, matchDictionaryPhrase } from "../logic/words.ts";
import { openContainer } from "../container/container.ts";
import { parseView, readViewCel } from "../view/view.ts";
import { renderPicture } from "../picture/renderer.ts";
import { createPictureSurface } from "../types.ts";
import {
  createAgentSessionState,
  type AgentSessionState,
  type AgentToolResult,
  type ToolDefinition,
} from "./tools.ts";
import { executeAuthoringTool } from "./authoringTools.ts";
import { resourceRevision, validateAuthoringState, type BindingKind } from "./authoringState.ts";
import { readInventoryObjects } from "./inventory.ts";
import { normalizeAuthoredLogic } from "./logicText.ts";

const reference = {
  type: ["integer", "string"],
  description: "A resource ID or existing named binding of the matching kind.",
};
const nullableReference = { type: ["integer", "string", "null"] };
const nullableText = { type: ["string", "null"] };
const nullableItem = { type: ["integer", "null"], minimum: 0, maximum: 255 };
const EDGES: Readonly<Record<string, number>> = { top: 1, right: 2, bottom: 3, left: 4 };

export const ROOM_TOOLS: readonly ToolDefinition[] = [
  {
    name: "write_room",
    description: `Compile a complete room scaffold with picture, ego, spawn, edge exits and command interactions; title and description record the room intent. Resource references are integer IDs or reserved binding names, not quoted numbers. Registers needed words while preserving IDs. Use expectedRevision "${resourceRevision(null)}" for a new room; otherwise match its revision. Picture, ego view and inventory items must exist; exit rooms can be authored later. Leaves boot logic intact and returns revision, bindings, commands and intent updates.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: reference,
        picture: reference,
        egoView: reference,
        title: {
          type: "string",
          maxLength: 160,
        },
        description: {
          type: "string",
          maxLength: 4000,
        },
        expectedRevision: { type: "string" },
        spawn: {
          type: "object",
          additionalProperties: false,
          properties: {
            x: { type: "integer", minimum: 0, maximum: 159 },
            y: { type: "integer", minimum: 0, maximum: 167 },
            horizon: { type: "integer", minimum: 0, maximum: 166 },
          },
          required: ["x", "y", "horizon"],
        },
        exits: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              edge: { type: "string", enum: Object.keys(EDGES) },
              destination: reference,
              requiresFlag: nullableReference,
              blockedResponse: nullableText,
            },
            required: ["edge", "destination", "requiresFlag", "blockedResponse"],
          },
        },
        interactions: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              commands: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: { type: "string", maxLength: 80 },
              },
              response: { type: "string", maxLength: 1000 },
              blockedResponse: nullableText,
              requiresItem: nullableItem,
              requiresFlag: nullableReference,
              giveItem: nullableItem,
              removeItem: nullableItem,
              setFlag: nullableReference,
              destination: nullableReference,
            },
            required: [
              "commands",
              "response",
              "blockedResponse",
              "requiresItem",
              "requiresFlag",
              "giveItem",
              "removeItem",
              "setFlag",
              "destination",
            ],
          },
        },
      },
      required: [
        "room",
        "picture",
        "egoView",
        "title",
        "description",
        "expectedRevision",
        "spawn",
        "exits",
        "interactions",
      ],
    },
  },
];

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`${label} must be text of at most ${max} characters.`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function referenceId(
  state: AgentSessionState,
  value: unknown,
  kind: BindingKind,
  label: string,
  min = 0,
): number {
  if (typeof value === "string") {
    const binding = state.authoring.bindings[value];
    if (!binding || binding.kind !== kind)
      throw new Error(
        `${label}: '${value}' needs a ${kind} binding. Use reserve_binding or a numeric ID.`,
      );
    return integer(binding.num, label, min, 255);
  }
  return integer(value, label, min, 255);
}
function flag(state: AgentSessionState, value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return integer(value, "flag", 0, 255);
  if (typeof value !== "string")
    throw new Error("A flag must be a named binding, numeric ID, or null.");
  const result = executeAuthoringTool(state, "reserve_binding", {
    name: value,
    kind: "flag",
    id: null,
  });
  if (!result?.success) throw new Error(result?.error ?? "Flag binding failed.");
  return state.authoring.bindings[value]!.num;
}

export function executeRoomTool(
  state: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (name !== "write_room") return undefined;
  try {
    const room = referenceId(state, args["room"], "logic", "room", 1);
    const previous = state.container.getResource("logic", room);
    const revision = resourceRevision(previous);
    if (args["expectedRevision"] !== revision)
      throw new Error(
        `Room ${room} revision is '${revision}'. Read its current logic and use that expectedRevision before replacing it.`,
      );
    const title = text(args["title"], "title", 160);
    const description = text(args["description"], "description", 4000);
    const picture = referenceId(state, args["picture"], "picture", "picture");
    const egoView = referenceId(state, args["egoView"], "view", "egoView");
    const picturePayload = state.container.getResource("picture", picture);
    if (!picturePayload)
      throw new Error(`Picture ${picture} is missing. Write it before creating the room.`);
    renderPicture(picturePayload, createPictureSurface(), { profile: state.profile });
    const viewPayload = state.container.getResource("view", egoView);
    const cel = viewPayload && readViewCel(parseView(viewPayload, state.profile), 0, 0);
    if (!cel)
      throw new Error(`Ego view ${egoView} needs a valid loop 0 cel 0 before creating the room.`);
    const spawn = object(args["spawn"], "spawn");
    const x = integer(spawn["x"], "spawn.x", 0, 159),
      y = integer(spawn["y"], "spawn.y", 0, 167),
      horizon = integer(spawn["horizon"], "spawn.horizon", 0, 166);
    if (x + cel.width > 160 || y < cel.height - 1 || y <= horizon)
      throw new Error(
        `Spawn must fit the ${cel.width}x${cel.height} ego inside the picture and below horizon ${horizon}.`,
      );
    const exits = args["exits"],
      interactions = args["interactions"];
    if (!Array.isArray(exits) || exits.length > 4)
      throw new Error("exits must contain at most four edge definitions.");
    if (!Array.isArray(interactions) || interactions.length > 32)
      throw new Error(
        "interactions must contain at most 32 entries in this helper. Use write_logic_source for more elaborate room behavior.",
      );

    const files = state.getFiles();
    const detached = createAgentSessionState(
      openContainer(files, { kind: state.profile.container }),
    );
    const staged: AgentSessionState = {
      ...detached,
      profile: state.profile,
      authoring: validateAuthoringState(state.authoring),
    };
    const words = files.get("WORDS.TOK");
    const dictionary = new Map(
      words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : state.sources.words,
    );
    const usedIds = new Set([...dictionary.values(), 0, 1, 9999]);
    let nextWord = 100;
    const addedWords: { word: string; id: number }[] = [];
    const commandPatterns: string[] = [];
    const inventory = readInventoryObjects(files.get("OBJECT"), state.profile);
    const itemId = (value: unknown, label: string): number | null => {
      if (value == null) return null;
      const id = integer(value, label, 0, 255);
      if (!inventory[id])
        throw new Error(
          `${label}: inventory item ${id} is missing. Define it with upsert_inventory_item first.`,
        );
      return id;
    };
    const variableNames = [
      "room_picture_number",
      "room_ego_step_time",
      "room_ego_cycle_time",
      "room_ego_previous_x",
      "room_ego_previous_y",
      "room_ego_current_x",
      "room_ego_current_y",
    ] as const;
    const roomVariables: Record<string, number> = {};
    for (const variableName of variableNames) {
      const reserved = executeAuthoringTool(staged, "reserve_binding", {
        name: variableName,
        kind: "variable",
        id: null,
      });
      if (!reserved?.success)
        throw new Error(reserved?.error ?? `Could not allocate ${variableName}.`);
      roomVariables[variableName] = staged.authoring.bindings[variableName]!.num;
    }
    const pictureVariable = roomVariables["room_picture_number"]!;
    const stepTimeVariable = roomVariables["room_ego_step_time"]!;
    const cycleTimeVariable = roomVariables["room_ego_cycle_time"]!;
    const previousXVariable = roomVariables["room_ego_previous_x"]!;
    const previousYVariable = roomVariables["room_ego_previous_y"]!;
    const currentXVariable = roomVariables["room_ego_current_x"]!;
    const currentYVariable = roomVariables["room_ego_current_y"]!;
    const lines = [
      `if (isset(f5)) {`,
      `  assignn(v${pictureVariable}, ${picture}); load.pic(v${pictureVariable}); draw.pic(v${pictureVariable}); show.pic();`,
      `  set.horizon(${horizon}); load.view(${egoView}); animate.obj(0); set.view(0, ${egoView});`,
      `  assignn(v${stepTimeVariable}, 1); step.time(0, v${stepTimeVariable});`,
      `  assignn(v${cycleTimeVariable}, 3); cycle.time(0, v${cycleTimeVariable});`,
      `  position(0, ${x}, ${y}); draw(0); normal.motion(0); normal.cycle(0); stop.cycling(0);`,
      `  get.posn(0, v${previousXVariable}, v${previousYVariable});`,
      `  assignn(v6, 0); player.control(); accept.input();`,
      `}`,
      `get.posn(0, v${currentXVariable}, v${currentYVariable});`,
      `if (equaln(v6, 0)) { stop.cycling(0); }`,
      `if (!equaln(v6, 0) && (!equalv(v${currentXVariable}, v${previousXVariable}) || !equalv(v${currentYVariable}, v${previousYVariable}))) { start.cycling(0); }`,
      `if (equalv(v${currentXVariable}, v${previousXVariable}) && equalv(v${currentYVariable}, v${previousYVariable})) { stop.cycling(0); }`,
      `assignv(v${previousXVariable}, v${currentXVariable}); assignv(v${previousYVariable}, v${currentYVariable});`,
    ];
    const namedExits: Record<string, number> = {};
    for (const raw of exits) {
      const exit = object(raw, "exit");
      const edge = exit["edge"];
      if (typeof edge !== "string" || !EDGES[edge])
        throw new Error("edge must be top, right, bottom or left.");
      if (Object.hasOwn(namedExits, edge)) throw new Error(`Duplicate exit for edge '${edge}'.`);
      const destination = referenceId(staged, exit["destination"], "logic", "exit destination", 1);
      namedExits[edge] = destination;
      const required = flag(staged, exit["requiresFlag"]);
      lines.push(`if (equaln(v2, ${EDGES[edge]})) {`);
      if (required !== null)
        lines.push(
          `  if (isset(f${required})) { new.room(${destination}); } else { assignn(v6, 0); print(${JSON.stringify(exit["blockedResponse"] == null ? "That way is closed for now." : text(exit["blockedResponse"], "blockedResponse", 1000))}); }`,
        );
      else lines.push(`  new.room(${destination});`);
      lines.push("}");
    }
    for (const raw of interactions) {
      const interaction = object(raw, "interaction");
      const commands = interaction["commands"];
      if (!Array.isArray(commands) || commands.length < 1 || commands.length > 8)
        throw new Error("Each interaction needs one to eight commands.");
      const patterns: string[] = [];
      for (const rawCommand of commands) {
        const command = text(rawCommand, "command", 80)
          .toLowerCase()
          .replace(/['`\-"\u2018\u2019\u201c\u201d]/g, "")
          .replace(/[ ,.?!();:[\]{}]+/g, " ")
          .trim();
        const tokens = command.split(" ");
        if (!command || tokens.length > 10 || tokens.some((word) => !/^[a-z][a-z0-9]*$/.test(word)))
          throw new Error(
            "Commands need one to ten ASCII words beginning with a letter, for example 'open the gate'.",
          );
        const retained: string[] = [];
        for (let index = 0; index < tokens.length;) {
          const match = matchDictionaryPhrase(tokens, index, dictionary);
          index += match.length;
          if (match.id === undefined) {
            while (nextWord <= 65535 && usedIds.has(nextWord)) nextWord++;
            if (nextWord > 65535) throw new Error("No vocabulary IDs remain.");
            dictionary.set(match.text, nextWord);
            usedIds.add(nextWord);
            addedWords.push({ word: match.text, id: nextWord++ });
          }
          if (match.id !== 0) retained.push(match.text);
        }
        if (!retained.length)
          throw new Error(`Command '${command}' contains only ignored dictionary words.`);
        patterns.push(`said(${retained.map((word) => JSON.stringify(word)).join(", ")})`);
        commandPatterns.push(command);
      }
      const requiredItem = itemId(interaction["requiresItem"], "requiresItem");
      const giveItem = itemId(interaction["giveItem"], "giveItem");
      const removeItem = itemId(interaction["removeItem"], "removeItem");
      const requiredFlag = flag(staged, interaction["requiresFlag"]);
      const setFlag = flag(staged, interaction["setFlag"]);
      const conditions: string[] = [];
      if (requiredItem !== null) conditions.push(`has(${requiredItem})`);
      if (requiredFlag !== null) conditions.push(`isset(f${requiredFlag})`);
      lines.push(`if (${[...new Set(patterns)].join(" || ")}) {`);
      if (conditions.length) lines.push(`  if (${conditions.join(" && ")}) {`);
      if (giveItem !== null) lines.push(`  get(${giveItem});`);
      if (removeItem !== null) lines.push(`  put(${removeItem}, 0);`);
      if (setFlag !== null) lines.push(`  set(f${setFlag});`);
      const response = text(interaction["response"], "response", 1000);
      if (response) lines.push(`  print(${JSON.stringify(response)});`);
      if (interaction["destination"] != null)
        lines.push(
          `  new.room(${referenceId(staged, interaction["destination"], "logic", "interaction destination", 1)});`,
        );
      if (conditions.length) {
        const blocked =
          interaction["blockedResponse"] == null
            ? "You are not ready to do that yet."
            : text(interaction["blockedResponse"], "blockedResponse", 1000);
        lines.push(`  } else { print(${JSON.stringify(blocked)}); }`);
      }
      lines.push("}");
    }
    lines.push("return;");
    const normalized = normalizeAuthoredLogic(lines.join("\n"));
    const compiled = assembleLogic(normalized.source, { dictionary, profile: state.profile });
    const wordsPayload = buildWordsTok([...dictionary].map(([word, id]) => ({ word, id })));
    staged.authoring.world.rooms[String(room)] = { title, description, exits: namedExits };
    const authoring = validateAuthoringState(staged.authoring);
    // The only fallible live mutation happens first. All source/metadata writes follow it.
    const bindings = Object.fromEntries(
      Object.entries(authoring.bindings).filter(
        ([name]) =>
          variableNames.includes(name as (typeof variableNames)[number]) ||
          !Object.hasOwn(state.authoring.bindings, name),
      ),
    );
    state.container.putResource("logic", room, compiled.payload);
    state.sources.logics.set(room, normalized.source);
    state.sources.words.clear();
    for (const [word, id] of dictionary) state.sources.words.set(word, id);
    state.wordsPayload = wordsPayload;
    state.authoring = authoring;
    return {
      success: true,
      message: `Room ${room} compiled: ${exits.length} edge exits, ${interactions.length} interactions. Use playtest_room with steps and expected outcomes, or read_logic to customize the generated source.`,
      adjustments: normalized.adjustments,
      details: {
        room,
        revision: resourceRevision(compiled.payload),
        writtenResources: [{ kind: "logic", num: room }],
        updatedFiles: ["WORDS.TOK"],
        authoringChanged: true,
        commands: commandPatterns.slice(0, 32),
        commandCount: commandPatterns.length,
        addedWords: addedWords.slice(0, 64),
        addedWordCount: addedWords.length,
        bindings,
        exits: namedExits,
        bytes: compiled.payload.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      details: { diagnostic: { tool: name, changed: false } },
    };
  }
}
