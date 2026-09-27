/**
 * The Studio assist task: the creator selects something in Room Studio or
 * Sprite Studio and asks for a change to just that. The session runs it with
 * read_edit_context, propose_edit and read-only inspection
 * (STUDIO_ASSIST_TASK_TOOLS); every other tool is denied. The result's
 * candidate is data: the UI shows its before | after preview and applies
 * `candidate.draft` as one undo step when the creator accepts.
 *
 * The deterministic stub below scripts the model side for offline tests and
 * the eval harness's dry run: "walkable" turns the selection's barrier into
 * the walkable control value beside it (control 0–3 only, as the default
 * Walk locks allow), "eyes" recolours the selected cels' rarest colour blue,
 * "bad" first recolours the selected art under the lens lock, reads the
 * refusal, then retries with the walkable change, and "impossible" reads the
 * selection and declines with an explanation, proposing nothing.
 */
import {
  STUDIO_ASSIST_TOOLS,
  type StudioCandidate,
  type StudioFocus,
} from "../../../src/agent/studioAssistTools.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import type { LlmTurnResult, UnifiedConversation } from "./llmClient.ts";

export interface StudioAssistRequest {
  /** The creator's words. */
  readonly instruction: string;
  readonly focus: StudioFocus;
  /** propose_edit calls allowed; DEFAULT_MAX_PROPOSALS otherwise. */
  readonly maxProposals?: number;
}

export interface StudioAssistResult {
  /** The model's closing sentence. */
  readonly text: string;
  /** The latest candidate that passed its scope, or null when none did. */
  readonly candidate: StudioCandidate | null;
  readonly proposals: number;
  readonly refusals: number;
}

/** Provider turns with tool calls one request may take: a ceiling, not a target. */
export const MAX_STUDIO_ROUNDS = 8;

/** The user turn of a Studio assist request; the cached system prompt stays unchanged. */
export function createStudioAssistPrompt(instruction: string, focus: StudioFocus): string {
  const { kind, num } = focus.scope;
  const studio = kind === "picture" ? "Room Studio" : "Sprite Studio";
  return `### STUDIO ASSIST REQUEST

The creator is editing ${kind} ${num} in ${studio}${focus.lens ? ` (${focus.lens} lens)` : ""} and asks about their selection:

"${instruction.trim()}"

You may change only the selection. Call read_edit_context, then propose_edit with the operations that make exactly this change. The host checks each candidate on decoded pixels and refuses changes outside the selection, on a locked plane or protected loop, or over the byte budget: read the refusal, fix that, and propose again. Nothing is applied until the creator accepts. Finish with one sentence describing the change, or saying what blocks it.`;
}

type Scenario = "walkable" | "eyes" | "bad" | "impossible" | "none";

/** The stub's explanation when it declines ("impossible"): nothing is proposed. */
export const STUB_DECLINE_TEXT =
  "I can't do that within your selection: the change would need cells outside it, so I left the draft as it is.";

function scenarioOf(instruction: string): Scenario {
  const asked = instruction.toLowerCase();
  if (asked.includes("impossible")) return "impossible";
  if (asked.includes("bad")) return "bad";
  if (asked.includes("eye")) return "eyes";
  if (asked.includes("walk")) return "walkable";
  return "none";
}

const propose = STUDIO_ASSIST_TOOLS.find((tool) => tool.name === "propose_edit")!;
const opFields = (list: "pictureOps" | "spriteOps") =>
  (propose.parameters.properties[list] as { items: { required: readonly string[] } }).items
    .required;

/** A full strict-mode op: every field the schema lists, null unless given. */
function op(list: "pictureOps" | "spriteOps", given: Record<string, unknown>) {
  return Object.fromEntries(opFields(list).map((field) => [field, given[field] ?? null]));
}

interface PictureContext {
  kind: "picture";
  baseRevision: string;
  selection: { id: string; label: string; lines: [number, number] }[];
  selectionArea: { bbox: Box | null };
  /** Control values 0..3 in the selection, when the priority plane may change. */
  controls: { value: number; cells: number; bbox: Box | null }[];
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ViewContext {
  kind: "view";
  baseRevision: string;
  selection: { loop: number; cel: number }[];
  colours: { loop: number; cel: number; colours: Record<string, number> }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isBox = (value: unknown): value is Box =>
  isRecord(value) && ["x0", "y0", "x1", "y1"].every((key) => typeof value[key] === "number");

function isPictureContext(value: unknown): value is PictureContext {
  if (!isRecord(value) || value["kind"] !== "picture") return false;
  const area = value["selectionArea"];
  const controls = value["controls"];
  return (
    typeof value["baseRevision"] === "string" &&
    Array.isArray(value["selection"]) &&
    value["selection"].every(
      (s) =>
        isRecord(s) &&
        typeof s["id"] === "string" &&
        typeof s["label"] === "string" &&
        Array.isArray(s["lines"]) &&
        s["lines"].length === 2 &&
        s["lines"].every((n) => typeof n === "number"),
    ) &&
    isRecord(area) &&
    (area["bbox"] === null || isBox(area["bbox"])) &&
    Array.isArray(controls) &&
    controls.every(
      (c) =>
        isRecord(c) &&
        typeof c["value"] === "number" &&
        typeof c["cells"] === "number" &&
        (c["bbox"] === null || isBox(c["bbox"])),
    )
  );
}

function isViewContext(value: unknown): value is ViewContext {
  if (!isRecord(value) || value["kind"] !== "view") return false;
  return (
    typeof value["baseRevision"] === "string" &&
    Array.isArray(value["selection"]) &&
    value["selection"].every(
      (s) => isRecord(s) && typeof s["loop"] === "number" && typeof s["cel"] === "number",
    ) &&
    Array.isArray(value["colours"]) &&
    value["colours"].every(
      (c) =>
        isRecord(c) &&
        typeof c["loop"] === "number" &&
        typeof c["cel"] === "number" &&
        isRecord(c["colours"]),
    )
  );
}

/**
 * The read_edit_context payload the stub acts on. The tool result is untyped
 * details, so the shape — not a cast — decides whether it is one.
 */
function asEditContext(value: unknown): PictureContext | ViewContext {
  if (isPictureContext(value) || isViewContext(value)) return value;
  throw new Error("read_edit_context returned an unrecognised edit context.");
}

/**
 * Opens the selection's barrier under the default Walk locks: the barrier
 * cells' box becomes the walkable control value already there (water 3, else
 * signal 2), so no cell moves into, out of or within depth values 4–15.
 * Null when the selection holds no barrier or no walkable control to match.
 */
function walkableProposal(context: PictureContext) {
  const target = context.selection[0]!;
  const barrier = context.controls.find((c) => c.value === 0)?.bbox;
  const value = [3, 2].find((v) => context.controls.some((c) => c.value === v));
  if (!barrier || value === undefined) return null;
  return {
    baseRevision: context.baseRevision,
    summary: `Opened the barrier under the ${target.label.toLowerCase()} without touching its art.`,
    pictureOps: [
      op("pictureOps", {
        type: "insertShape",
        atLine: target.lines[1] + 1,
        shape: {
          kind: "rect",
          color: null,
          priority: value,
          filled: true,
          x1: barrier.x0,
          y1: barrier.y0,
          x2: barrier.x1,
          y2: barrier.y1,
          points: null,
        },
        id: `${target.id}-walk`.slice(0, 32),
        label: `${target.label} walkway`,
        kind: "walk",
      }),
    ],
    spriteOps: null,
  };
}

function artProposal(context: PictureContext) {
  const target = context.selection[0]!;
  return {
    baseRevision: context.baseRevision,
    summary: `Repainted the ${target.label.toLowerCase()}.`,
    pictureOps: [
      op("pictureOps", { type: "setItemColor", itemId: target.id, plane: "visual", value: 8 }),
    ],
    spriteOps: null,
  };
}

function eyesProposal(context: ViewContext) {
  const first = context.colours[0]!;
  const rarest = Object.entries(first.colours).sort(
    ([a, na], [b, nb]) => na - nb || Number(a) - Number(b),
  )[0]![0];
  return {
    baseRevision: context.baseRevision,
    summary: "Turned the robot's eyes blue on the selected loop.",
    pictureOps: null,
    spriteOps: [
      op("spriteOps", {
        type: "recolor",
        recolorScope: "cels",
        cels: context.selection,
        from: Number(rarest),
        to: 1,
      }),
    ],
  };
}

/**
 * A scripted conversation for the Studio assist loop: the same tool calls a
 * model makes, decided from the tool results it is shown. No network.
 */
export function createStudioAssistStub(instruction: string): UnifiedConversation {
  const scenario = scenarioOf(instruction);
  const transcript: unknown[] = [];
  const names = new Map<string, string>();
  let context: PictureContext | ViewContext | null = null;
  const outcomes: boolean[] = [];
  let calls = 0;
  const call = (name: string, input: Record<string, unknown>): LlmTurnResult => {
    const id = `stub-${++calls}`;
    names.set(id, name);
    transcript.push({ role: "assistant", tool: name, input });
    return { toolCalls: [{ id, name, input }] };
  };
  const say = (text: string): LlmTurnResult => {
    transcript.push({ role: "assistant", text });
    return { text, toolCalls: [] };
  };
  const next = (): LlmTurnResult => {
    if (!context) return say("I could not read the selection.");
    const last = outcomes.at(-1);
    if (last === true) return say(`Proposed: ${instruction.trim()}.`);
    if (scenario === "impossible") return say(STUB_DECLINE_TEXT);
    if (context.kind === "view") {
      if (scenario !== "eyes" || outcomes.length > 0)
        return say("I could not make that change within the selection.");
      return call("propose_edit", eyesProposal(context));
    }
    if (scenario === "none" || scenario === "eyes")
      return say("The stub has no Studio change for that request.");
    const walkable = walkableProposal(context);
    if (outcomes.length === 0 && scenario === "bad")
      return call("propose_edit", artProposal(context));
    if (walkable && outcomes.length === (scenario === "bad" ? 1 : 0))
      return call("propose_edit", walkable);
    return say("I could not make that change within the selection.");
  };
  return {
    setAvailableTools() {},
    async sendUserMessage(text: string) {
      transcript.push({ role: "user", text });
      return call("read_edit_context", { images: false });
    },
    appendToolResults(results: { toolCallId: string; result: AgentToolResult }[]) {
      for (const { toolCallId, result } of results) {
        transcript.push({ role: "tool", toolCallId, success: result.success });
        const name = names.get(toolCallId);
        if (name === "read_edit_context" && result.success) context = asEditContext(result.details);
        if (name === "propose_edit") outcomes.push(result.success);
      }
    },
    async complete() {
      return next();
    },
    getTranscript() {
      return structuredClone(transcript);
    },
  };
}
