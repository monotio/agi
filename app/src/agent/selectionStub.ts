/** Deterministic selection scenarios inside the workspace provider; no network. */
import { SELECTION_TOOLS } from "../../../src/agent/selectionTools.ts";
import type { AgentToolImage, AgentToolResult } from "../../../src/agent/agentState.ts";
import type { LlmTurnResult, UnifiedConversation } from "./llmClient.ts";
import { describeImages, MANIFEST_LINE } from "./referenceStub.ts";

type Scenario =
  "walkable" | "eyes" | "bad" | "move" | "withdraw" | "impossible" | "reference" | "none";

/** The stub's explanation when it declines ("impossible"): nothing is proposed. */
const STUB_DECLINE_TEXT =
  "I can't do that within your selection: the change would need cells outside it, so I left the draft as it is.";

/** The stub's reason for withdrawing its own candidate ("withdraw"). */
const STUB_WITHDRAW_REASON =
  "The walkway would not reach the floor the player walks on, so it should not be accepted.";

function scenarioOf(instruction: string): Scenario {
  const asked = instruction.toLowerCase();
  if (asked.includes("impossible")) return "impossible";
  if (asked.includes("reference")) return "reference";
  if (asked.includes("withdraw")) return "withdraw";
  if (asked.includes("bad")) return "bad";
  if (/\bmove\b/.test(asked)) return "move";
  if (asked.includes("eye")) return "eyes";
  if (asked.includes("walk")) return "walkable";
  return "none";
}

const propose = SELECTION_TOOLS.find((tool) => tool.name === "edit_selection")!;
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

/** How far "move" moves the selection, in pixels to the right. */
const STUB_MOVE_DX = 8;

function moveProposal(context: PictureContext) {
  const target = context.selection[0]!;
  return {
    baseRevision: context.baseRevision,
    summary: `Moved the ${target.label.toLowerCase()} ${STUB_MOVE_DX} pixels right.`,
    pictureOps: [
      op("pictureOps", { type: "moveItem", itemId: target.id, dx: STUB_MOVE_DX, dy: 0 }),
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
 * A scripted conversation for workspace selection tools: the same tool calls a
 * model makes, decided from the tool results it is shown. No network.
 */
export function createSelectionStub(
  instruction: string,
  initial: readonly unknown[] = [],
): UnifiedConversation {
  const scenario = scenarioOf(instruction);
  const transcript: unknown[] = [...initial];
  const names = new Map<string, string>();
  let context: PictureContext | ViewContext | null = null;
  const outcomes: boolean[] = [];
  /** "withdraw": what withdraw_selection answered, once called. */
  let withdrawn: AgentToolResult | null = null;
  let calls = 0;
  /** "reference": the attached art's id, what read_reference_image answered, and the request's images. */
  let attachedArt: string | null = null;
  let viewed: AgentToolResult | null = null;
  let carried: ReturnType<typeof describeImages> = [];
  const call = (name: string, input: Record<string, unknown>): LlmTurnResult => {
    const id = `stub-${++calls}`;
    names.set(id, name);
    transcript.push({ role: "assistant", text: JSON.stringify({ tool: name, input }) });
    return { toolCalls: [{ id, name, input }] };
  };
  const say = (text: string): LlmTurnResult => {
    transcript.push({ role: "assistant", text });
    return { text, toolCalls: [] };
  };
  /** "reference": what the art looked like and what the request carried, in one sentence. */
  const referenceReply = (): LlmTurnResult => {
    if (!attachedArt) return say("No reference art was attached to this request.");
    if (!viewed?.success)
      return say(`I could not view ${attachedArt}: ${viewed?.error ?? "no result"}.`);
    const images = carried.map((image) => `${image.width}x${image.height}`).join(", ");
    return say(
      `I viewed ${attachedArt} and left the selection as it is; this request carried its reference list and ${carried.length === 1 ? "one image" : `${carried.length} images`} (${images || "none"}).`,
    );
  };
  const next = (): LlmTurnResult => {
    if (scenario === "reference" && attachedArt && !viewed)
      return call("read_reference_image", {
        id: attachedArt,
        size: "small",
        region: null,
        grid: null,
      });
    if (!context) return say("I could not read the selection.");
    if (scenario === "reference") return referenceReply();
    const last = outcomes.at(-1);
    if (withdrawn)
      return say(
        withdrawn.success ? STUB_WITHDRAW_REASON : `I could not withdraw: ${withdrawn.error}`,
      );
    if (scenario === "withdraw" && last === true)
      return call("withdraw_changes", { reason: STUB_WITHDRAW_REASON });
    if (last === true) return say(`Proposed: ${instruction.trim()}.`);
    if (scenario === "impossible") return say(STUB_DECLINE_TEXT);
    if (context.kind === "view") {
      if (scenario !== "eyes" || outcomes.length > 0)
        return say("I could not make that change within the selection.");
      return call("edit_selection", eyesProposal(context));
    }
    if (scenario === "none" || scenario === "eyes")
      return say("The stub has no selection change for that request.");
    if (scenario === "move")
      return outcomes.length === 0
        ? call("edit_selection", moveProposal(context))
        : say("I could not make that change within the selection.");
    const walkable = walkableProposal(context);
    if (outcomes.length === 0 && scenario === "bad")
      return call("edit_selection", artProposal(context));
    if (walkable && outcomes.length === (scenario === "bad" ? 1 : 0))
      return call("edit_selection", walkable);
    return say("I could not make that change within the selection.");
  };
  return {
    setAvailableTools() {},
    async sendUserMessage(text: string, images?: readonly AgentToolImage[]) {
      carried = describeImages(images);
      transcript.push({ role: "user", text, images: carried });
      if (scenario === "reference") {
        const lines = [...text.matchAll(MANIFEST_LINE)];
        attachedArt =
          lines.find((line) => line[0].includes("attached to this request"))?.[1] ?? null;
      }
      return call("read_edit_context", { images: false });
    },
    appendToolResults(results: { toolCallId: string; result: AgentToolResult }[]) {
      for (const { toolCallId, result } of results) {
        transcript.push({
          role: "assistant",
          text: JSON.stringify({
            toolCallId,
            result: { ...result, images: describeImages(result.images) },
          }),
        });
        const name = names.get(toolCallId);
        if (name === "read_reference_image") viewed = result;
        if (name === "read_edit_context" && result.success) context = asEditContext(result.details);
        if (name === "edit_selection") outcomes.push(result.success);
        if (name === "withdraw_changes") withdrawn = result;
      }
    },
    async complete() {
      return next();
    },
    recordInterruption(text) {
      transcript.push({ role: "user", text });
    },
    getTranscript() {
      return structuredClone(transcript);
    },
  };
}
