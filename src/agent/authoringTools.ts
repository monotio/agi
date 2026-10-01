import {
  authoredLogicSource,
  authoredPictureSource,
  type AgentSessionState,
  type AgentToolResult,
} from "./agentState.ts";
import { sourceRevision, validateAuthoringState, type BindingKind } from "./authoringState.ts";
import { allocateProjectIds } from "../authoring/resourceAllocation.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { readPictureSource } from "../picture/source.ts";

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

/**
 * Revision of the editable snapshot: shown text plus the context it compiles
 * in. That context is what the text depends on — the words its said() calls
 * quote, with their ids, and the bindings it names. Vocabulary or bindings it does not use
 * cannot change how it compiles, so registering them does not stale a read.
 */
export function sourceContextRevision(
  state: AgentSessionState,
  kind: "logic" | "picture",
  num: number,
  source: string,
): string {
  const byCodePoint = ([a]: [string, unknown], [b]: [string, unknown]) =>
    a < b ? -1 : a > b ? 1 : 0;
  // Only said() quotes vocabulary; message and menu text that happens to be a
  // word ("Save") is not a dependency.
  const quoted = new Set(
    [...source.matchAll(/\bsaid\s*\(([^)]*)\)/g)].flatMap((call) =>
      [...call[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.toLowerCase()),
    ),
  );
  const names = new Set(source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  return sourceRevision(state.container.getResource(kind, num), source, {
    profile: state.profile.id,
    words: [...state.sources.words]
      .filter(([word]) => quoted.has(word))
      .sort(byCodePoint)
      .map(([word, id]) => `${word}=${id}`),
    bindings: Object.fromEntries(
      Object.entries(state.authoring.bindings)
        .filter(([name]) => names.has(name))
        .sort(byCodePoint),
    ),
  });
}

/**
 * Runs reserve_binding and update_world, which change only authoring state.
 * edit_resource_source is not here: resolveSourceEdit patches the text, and
 * the dispatcher writes it through the ordinary logic or picture writer.
 */
export function executeAuthoringTool(
  state: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (name !== "reserve_binding" && name !== "update_world") return undefined;
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
      const allocationWarnings = new Set<string>();

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
          // Earlier batch items are already bound, so the live record covers them.
          const allocation = allocateProjectIds(
            {
              container: state.container,
              profile: state.profile,
              dictionary: state.sources.words,
              bindings: state.authoring.bindings,
            },
            kind,
          );
          num = allocation.ids[0]!;
          for (const warning of allocation.warnings) allocationWarnings.add(warning);
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
            ...(allocationWarnings.size ? { warnings: [...allocationWarnings] } : {}),
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
          ...(allocationWarnings.size ? { warnings: [...allocationWarnings] } : {}),
          authoringChanged: true,
        },
      };
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
    return unchanged(name, error);
  }
}

function unchanged(tool: string, error: unknown): AgentToolResult {
  return {
    success: false,
    error: String(error),
    details: { diagnostic: { tool, message: String(error), changed: false } },
  };
}

/** The text an edit_resource_source call leaves, for the writer to compile. */
export interface SourceEdit {
  readonly kind: "logic" | "picture";
  readonly num: number;
  readonly source: string;
}

/**
 * Resolves edit_resource_source against the revision the agent read: every
 * find must match exactly one section of the same snapshot. Returns the
 * patched text, or a failure that changed nothing.
 */
export function resolveSourceEdit(
  state: AgentSessionState,
  args: Record<string, unknown>,
): SourceEdit | AgentToolResult {
  const tool = "edit_resource_source";
  try {
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
    if (!Array.isArray(edits) || !edits.length || edits.length > 65535)
      throw new Error("edits must name 1..65535 find/replace pairs.");
    const fail = (message: string, editIndex: number, excerpt: string): AgentToolResult => ({
      success: false,
      error: message,
      details: { diagnostic: { tool, message, changed: false, editIndex, excerpt, revision } },
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
    return { kind, num, source: next };
  } catch (error) {
    return unchanged(tool, error);
  }
}
