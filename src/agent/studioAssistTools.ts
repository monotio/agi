/**
 * Studio assist tools: the model changes just what the creator selected in
 * Room Studio or Sprite Studio. Offered only in a Studio assist task; every
 * other phase, and any call without a `StudioAssist` attached, is refused.
 *
 * API (the UI and the session call these; the model calls the tools):
 *
 *   createStudioAssist(focus, { maxProposals? })  the request's tool state
 *     focus.scope    the scope contract (src/studio/assistScope.ts), built
 *                    with pictureAssistScope / viewAssistScope
 *     focus.draft()  the Studio's CURRENT draft, read on every call, so an
 *                    edit the creator makes mid-request is a stale base
 *     focus.lens, .room, .ghost, .horizon   context for read_edit_context
 *                    (a picture's lens and unlocks live in its scope)
 *   executeAgentToolAsync(session, name, args, { studio: assist, ... })
 *     read_edit_context  the bounded focus: selection, excerpt or cel rows,
 *                        protected cells, room context, crop and overview
 *     propose_edit       ops on a detached copy of the draft, checked by
 *                        checkCandidate: a candidate with a before | after |
 *                        diff PNG, or a refusal in plain words
 *   assist.candidate     the latest candidate that passed its scope, or null;
 *                        `candidate.draft` holds the edited source or payload
 *
 * Nothing here writes the session, the live draft or the game's resources:
 * a candidate is data until the creator accepts it in the UI.
 */

import type { AgiProfile } from "../runtime/profile.ts";
import {
  assistRefusalText,
  checkCandidate,
  draftRevision,
  selectionArea,
  type AssistCheck,
  type AssistDraft,
  type AssistScope,
  type PictureAssistScope,
  type ViewAssistScope,
} from "../studio/assistScope.ts";
import { applyEdit, type EditOperation } from "../studio/editOperations.ts";
import {
  compileEditDocument,
  footprintMask,
  type CellBox,
  type CompiledDocument,
} from "../studio/editValidation.ts";
import {
  parsePictureDocument,
  PICTURE_ITEM_KINDS,
  serializePictureDocument,
  type PictureDocument,
  type PictureItem,
  type PictureItemKind,
} from "../studio/pictureDocument.ts";
import type { PicturePlane } from "../studio/pictureQuery.ts";
import { probeActor } from "../studio/probe.ts";
import type { SceneShape } from "../studio/shapes.ts";
import { RESIZE_ANCHORS, type ResizeAnchor } from "../studio/sprite/spriteCels.ts";
import { openSprite, type SpriteDocument } from "../studio/sprite/spriteDocument.ts";
import {
  applySpriteEdit,
  type CelRef,
  type SpriteEdit,
} from "../studio/sprite/spriteOperations.ts";
import { walkableMask } from "../studio/walkable.ts";
import { depthValuesLocked } from "../studio/lensRules.ts";
import { PictureSourceSyntaxError } from "../picture/source.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { parseView } from "../view/view.ts";
import { colourGrid, PICTURE_COMPARISON_LEGEND } from "./pictureFeedback.ts";
import { scanContainerExits } from "./roomMap.ts";
import { roomPictureUse } from "./roomPictures.ts";
import {
  cropScale,
  PICTURE_ASSIST_PREVIEW_CAPTION,
  pictureAssistPreviewPng,
  pictureCropPng,
  pictureOverviewPng,
  spriteSheetPng,
  type CelPair,
} from "./studioAssistPreview.ts";
import type { AgentSessionState, AgentToolImage, AgentToolResult } from "./agentState.ts";
import type { ToolDefinition } from "./tools.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;
/** AGI's power-on horizon (engine.ts), for the walkable estimate. */
const DEFAULT_HORIZON = 36;
/** Excerpt lines read_edit_context shows at most, and per item. */
const MAX_EXCERPT_LINES = 160;
const MAX_ITEM_LINES = 60;
/** Hex rows read_edit_context shows at most, in pixels, as read_view. */
const MAX_ROW_PIXELS = 32768;
/** Rows a sprite candidate sheet shows at most. */
const MAX_SHEET_ROWS = 8;
/** propose_edit calls one request allows: a ceiling, not a target. */
const DEFAULT_MAX_PROPOSALS = 4;

/** A ghost actor placed in Room Studio: one cel standing at one place. */
interface StudioGhost {
  readonly view: number;
  readonly loop: number;
  readonly cel: number;
  readonly x: number;
  readonly baselineY: number;
  readonly priority: number | "band";
}

/** What the creator selected and asked about; built by the UI per request. */
export interface StudioFocus {
  readonly scope: AssistScope;
  /** The Studio's current draft; read on every tool call. */
  readonly draft: () => AssistDraft;
  /** The Studio lens ("art" | "depth" | "walk" in Room Studio), reported as is. */
  readonly lens?: string | undefined;
  /** The room the Studio was opened from. */
  readonly room?: number | undefined;
  readonly ghost?: StudioGhost | undefined;
  /** The room's horizon for the walkable estimate; AGI's default 36 otherwise. */
  readonly horizon?: number | undefined;
  /**
   * The draft's interpreter profile — the one the Studio compiles and
   * Accept re-checks with. The request's tools read the draft and the game
   * under it, so a candidate the tools accept is the one Accept sees.
   */
  readonly profile?: AgiProfile | undefined;
}

interface CandidateBase {
  /** "c1", "c2", … in proposal order. */
  readonly candidateId: string;
  readonly num: number;
  /** The draft revision the candidate was made from. */
  readonly baseRevision: string;
  /** The candidate's own draft revision. */
  readonly revision: string;
  /** The model's one-sentence description. */
  readonly summary: string;
  /** Before | after | diff, as returned to the model. */
  readonly previewPng: Uint8Array;
  readonly check: AssistCheck;
}

export type StudioCandidate =
  | (CandidateBase & {
      readonly kind: "picture";
      readonly ops: readonly EditOperation[];
      readonly draft: { readonly kind: "picture"; readonly source: string };
      /**
       * Walkable baseline cells in the selection before and after, as the
       * model was told; absent where the priority plane is locked or no ego
       * view is known.
       */
      readonly walkable?: { readonly before: number; readonly after: number };
    })
  | (CandidateBase & {
      readonly kind: "view";
      readonly ops: readonly SpriteEdit[];
      readonly draft: { readonly kind: "view"; readonly payload: Uint8Array };
    });

/** The tool state of one Studio assist request. */
export interface StudioAssist {
  readonly focus: StudioFocus;
  /** The latest candidate that passed the scope check; a refusal never clears it. */
  candidate: StudioCandidate | null;
  /** propose_edit calls so far, and how many of them were refused. */
  proposals: number;
  refusals: number;
  readonly maxProposals: number;
}

export function createStudioAssist(
  focus: StudioFocus,
  options: { readonly maxProposals?: number } = {},
): StudioAssist {
  const maxProposals = options.maxProposals ?? DEFAULT_MAX_PROPOSALS;
  if (!Number.isInteger(maxProposals) || maxProposals < 1)
    throw new RangeError("maxProposals must be a positive integer");
  return { focus, candidate: null, proposals: 0, refusals: 0, maxProposals };
}

const nullable = (schema: Record<string, unknown>) => ({
  ...schema,
  type: [schema["type"], "null"],
});
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const POINT = {
  type: "object",
  additionalProperties: false,
  properties: { x: int(0, SCREEN_WIDTH - 1), y: int(0, SCREEN_HEIGHT - 1) },
  required: ["x", "y"],
} as const;
const CEL_REF = {
  type: "object",
  additionalProperties: false,
  properties: { loop: int(0, 254), cel: int(0, 254) },
  required: ["loop", "cel"],
} as const;

/** One kernel operation, flat: fields another type does not use are null. */
const PICTURE_OP = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [
        "moveItem",
        "setPoint",
        "insertPoint",
        "setItemColor",
        "deleteItem",
        "duplicateItem",
        "reorderItem",
        "insertShape",
        "insertFill",
        "insertPlot",
        "setItemMeta",
      ],
    },
    itemId: nullable({ type: "string", maxLength: 32 }),
    dx: nullable(int(-159, 159)),
    dy: nullable(int(-167, 167)),
    line: nullable(int(1, 100000)),
    pointIndex: nullable(int(0, 1000)),
    x: nullable(int(0, SCREEN_WIDTH - 1)),
    y: nullable(int(0, SCREEN_HEIGHT - 1)),
    plane: { type: ["string", "null"], enum: ["visual", "priority", null] },
    value: nullable(int(0, 15)),
    toIndex: nullable(int(0, 1000)),
    atLine: nullable(int(1, 100001)),
    id: nullable({ type: "string", maxLength: 32 }),
    label: nullable({ type: "string", maxLength: 64 }),
    kind: { type: ["string", "null"], enum: [...PICTURE_ITEM_KINDS, null] },
    locked: nullable({ type: "boolean" }),
    visual: nullable(int(0, 15)),
    priority: nullable(int(0, 15)),
    shape: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["rect", "polygon", "line"] },
        color: nullable(int(0, 15)),
        priority: nullable(int(0, 15)),
        filled: { type: "boolean" },
        x1: nullable(int(0, SCREEN_WIDTH - 1)),
        y1: nullable(int(0, SCREEN_HEIGHT - 1)),
        x2: nullable(int(0, SCREEN_WIDTH - 1)),
        y2: nullable(int(0, SCREEN_HEIGHT - 1)),
        points: { type: ["array", "null"], minItems: 2, maxItems: 64, items: POINT },
      },
      required: ["kind", "color", "priority", "filled", "x1", "y1", "x2", "y2", "points"],
    },
    pen: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: { radius: int(0, 7), stipple: { type: "boolean" } },
      required: ["radius", "stipple"],
    },
    points: { type: ["array", "null"], minItems: 1, maxItems: 64, items: POINT },
    seed: nullable(int(0, 239)),
  },
  required: [
    "type",
    "itemId",
    "dx",
    "dy",
    "line",
    "pointIndex",
    "x",
    "y",
    "plane",
    "value",
    "toIndex",
    "atLine",
    "id",
    "label",
    "kind",
    "locked",
    "visual",
    "priority",
    "shape",
    "pen",
    "points",
    "seed",
  ],
} as const;

const SPRITE_OP_TYPES = [
  "setPixels",
  "fillCel",
  "recolor",
  "flipCel",
  "shiftCel",
  "resizeCel",
  "setTransparent",
  "addCel",
  "deleteCel",
  "moveCel",
  "unlinkMirror",
] as const;

const SPRITE_OP = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: SPRITE_OP_TYPES },
    loop: nullable(int(0, 254)),
    cel: nullable(int(0, 254)),
    propagate: nullable({ type: "boolean" }),
    changes: {
      type: ["array", "null"],
      minItems: 1,
      maxItems: 4096,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { x: int(0, 159), y: int(0, 167), color: nullable(int(0, 15)) },
        required: ["x", "y", "color"],
      },
    },
    x: nullable(int(0, 159)),
    y: nullable(int(0, 167)),
    color: nullable(int(0, 15)),
    recolorScope: { type: ["string", "null"], enum: ["cels", "loop", "view", null] },
    cels: { type: ["array", "null"], minItems: 1, maxItems: 64, items: CEL_REF },
    from: nullable(int(0, 15)),
    to: nullable(int(0, 254)),
    axis: { type: ["string", "null"], enum: ["h", "v", null] },
    dx: nullable(int(-159, 159)),
    dy: nullable(int(-167, 167)),
    width: nullable(int(1, 160)),
    height: nullable(int(1, 168)),
    anchor: { type: ["string", "null"], enum: [...RESIZE_ANCHORS, null] },
    remap: nullable(int(0, 15)),
    at: nullable(int(0, 255)),
    source: { ...CEL_REF, type: ["object", "null"] },
  },
  required: [
    "type",
    "loop",
    "cel",
    "propagate",
    "changes",
    "x",
    "y",
    "color",
    "recolorScope",
    "cels",
    "from",
    "to",
    "axis",
    "dx",
    "dy",
    "width",
    "height",
    "anchor",
    "remap",
    "at",
    "source",
  ],
} as const;

/** Strict-compatible schemas; offered only in a Studio assist task. */
export const STUDIO_ASSIST_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_edit_context",
    description:
      "Studio assist only. What the creator selected and may let you change: the picture or view, the lens and locked planes, the selected items (ids, labels, kinds, footprints) with an annotated-source excerpt of just those items and their neighbours (1-based line numbers for setPoint, insertPoint and atLine), or the selected cels as hex rows; the cells or cels you may not change; the room context; and the `baseRevision` propose_edit needs. `images` (default true) attaches a crop of the selection and a room overview. Never the whole project.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { images: { type: ["boolean", "null"] } },
      required: ["images"],
    },
  },
  {
    name: "propose_edit",
    description:
      "Studio assist only. Propose a candidate change to the selection as ordered edit operations; nothing is applied. Send `baseRevision` from read_edit_context, a one-sentence `summary`, and `pictureOps` for a picture (Room Studio kernel ops: moveItem itemId dx dy; setPoint line pointIndex x y; insertPoint itemId line pointIndex x y (adds a vertex to a line, polyline, polygon or rel line of the item, before the point now at pointIndex; the point count appends, on a polygon its closing edge); setItemColor itemId plane value (null value turns the plane off); deleteItem itemId; duplicateItem itemId dx dy id label; reorderItem itemId toIndex; insertShape atLine shape id label kind; insertFill atLine x y visual priority id label; insertPlot atLine pen points seed visual priority id label; setItemMeta itemId label kind locked (locked stays null: only the creator locks or unlocks items)) or `spriteOps` for a view (Sprite Studio kernel ops on loop/cel: setPixels changes; fillCel x y color; recolor from to over recolorScope cels|loop|view; flipCel axis; shiftCel dx dy; resizeCel width height anchor; setTransparent color remap; addCel loop at source; deleteCel; moveCel to; unlinkMirror loop; propagate edits a shared mirror block). Unused fields are null. The ops run on a detached copy and the result is checked on decoded pixels against the selection, the locked planes, the protected cels and loops and the byte budget. Returns a candidateId with a before | after | diff image, or a refusal naming the broken constraint: fix that and call again. Each accepted call replaces the candidate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseRevision: { type: "string", minLength: 1, maxLength: 64 },
        summary: { type: "string", minLength: 1, maxLength: 240 },
        pictureOps: { type: ["array", "null"], minItems: 1, maxItems: 32, items: PICTURE_OP },
        spriteOps: { type: ["array", "null"], minItems: 1, maxItems: 32, items: SPRITE_OP },
      },
      required: ["baseRevision", "summary", "pictureOps", "spriteOps"],
    },
  },
];

export const STUDIO_ASSIST_TOOL_NAMES: readonly string[] = STUDIO_ASSIST_TOOLS.map((t) => t.name);

/** The refusal outside a Studio assist task. */
export const STUDIO_ONLY =
  "is only available in a Studio assist task, where the creator's selection defines what may change.";

class OpError extends Error {}

type Raw = Record<string, unknown>;

/** A field `type` needs, or an OpError naming it. */
function need<T>(raw: Raw, field: string, label: string): T {
  const value = raw[field];
  if (value === null || value === undefined)
    throw new OpError(`${label} (${String(raw["type"])}) needs ${field}`);
  return value as T;
}

function pictureOp(raw: Raw, label: string): EditOperation {
  const get = <T>(field: string) => need<T>(raw, field, label);
  const meta = () => ({ id: get<string>("id"), label: get<string>("label") });
  switch (raw["type"]) {
    case "moveItem":
      return { type: "moveItem", itemId: get("itemId"), dx: get("dx"), dy: get("dy") };
    case "setPoint":
      return {
        type: "setPoint",
        line: get("line"),
        pointIndex: get("pointIndex"),
        x: get("x"),
        y: get("y"),
      };
    case "insertPoint":
      return {
        type: "insertPoint",
        itemId: get("itemId"),
        line: get("line"),
        pointIndex: get("pointIndex"),
        x: get("x"),
        y: get("y"),
      };
    case "setItemColor":
      return {
        type: "setItemColor",
        itemId: get("itemId"),
        plane: get("plane"),
        value: (raw["value"] as number | null | undefined) ?? null,
      };
    case "deleteItem":
      return { type: "deleteItem", itemId: get("itemId") };
    case "duplicateItem": {
      const { id, label: newLabel } = meta();
      return {
        type: "duplicateItem",
        itemId: get("itemId"),
        dx: get("dx"),
        dy: get("dy"),
        newId: id,
        newLabel,
      };
    }
    case "reorderItem":
      return { type: "reorderItem", itemId: get("itemId"), toIndex: get("toIndex") };
    case "insertShape": {
      const shape = get<Raw>("shape");
      const common = {
        color: (shape["color"] as number | null) ?? null,
        priority: (shape["priority"] as number | null) ?? null,
        filled: shape["filled"] === true,
      };
      const scene: SceneShape =
        shape["kind"] === "rect"
          ? {
              kind: "rect",
              ...common,
              x1: need(shape, "x1", `${label}.shape`),
              y1: need(shape, "y1", `${label}.shape`),
              x2: need(shape, "x2", `${label}.shape`),
              y2: need(shape, "y2", `${label}.shape`),
            }
          : {
              kind: shape["kind"] === "line" ? "line" : "polygon",
              ...common,
              points: need(shape, "points", `${label}.shape`),
            };
      return {
        type: "insertShape",
        atLine: get("atLine"),
        shape: scene,
        ...meta(),
        kind: get<PictureItemKind>("kind"),
      };
    }
    case "insertFill":
      return {
        type: "insertFill",
        atLine: get("atLine"),
        x: get("x"),
        y: get("y"),
        visual: (raw["visual"] as number | null | undefined) ?? null,
        priority: (raw["priority"] as number | null | undefined) ?? null,
        ...meta(),
      };
    case "insertPlot": {
      const seed = raw["seed"];
      return {
        type: "insertPlot",
        atLine: get("atLine"),
        pen: get("pen"),
        points: get("points"),
        ...(typeof seed === "number" ? { seed } : {}),
        visual: (raw["visual"] as number | null | undefined) ?? null,
        priority: (raw["priority"] as number | null | undefined) ?? null,
        ...meta(),
      };
    }
    case "setItemMeta": {
      const {
        label: newLabel,
        kind,
        locked,
      } = raw as {
        label?: string | null;
        kind?: PictureItemKind | null;
        locked?: boolean | null;
      };
      return {
        type: "setItemMeta",
        itemId: get("itemId"),
        ...(typeof newLabel === "string" ? { label: newLabel } : {}),
        ...(typeof kind === "string" ? { kind } : {}),
        ...(typeof locked === "boolean" ? { locked } : {}),
      };
    }
    default:
      throw new OpError(`${label}: unknown picture operation '${String(raw["type"])}'`);
  }
}

function spriteOp(raw: Raw, label: string): SpriteEdit {
  const get = <T>(field: string) => need<T>(raw, field, label);
  const ref = () => ({ loop: get<number>("loop"), cel: get<number>("cel") });
  const propagate = raw["propagate"] === true ? { propagate: true } : {};
  switch (raw["type"]) {
    case "setPixels":
      return { type: "setPixels", ...ref(), changes: get("changes"), ...propagate };
    case "fillCel":
      return {
        type: "fillCel",
        ...ref(),
        x: get("x"),
        y: get("y"),
        color: (raw["color"] as number | null | undefined) ?? null,
        ...propagate,
      };
    case "recolor": {
      const scope = get<"cels" | "loop" | "view">("recolorScope");
      return {
        type: "recolor",
        scope: scope === "cels" ? get<CelRef[]>("cels") : scope,
        ...(scope === "loop" ? { loop: get<number>("loop") } : {}),
        from: get("from"),
        to: get("to"),
        ...propagate,
      };
    }
    case "flipCel":
      return { type: "flipCel", ...ref(), axis: get("axis"), ...propagate };
    case "shiftCel":
      return { type: "shiftCel", ...ref(), dx: get("dx"), dy: get("dy"), ...propagate };
    case "resizeCel": {
      const anchor = raw["anchor"] as ResizeAnchor | null | undefined;
      return {
        type: "resizeCel",
        ...ref(),
        width: get("width"),
        height: get("height"),
        ...(anchor ? { anchor } : {}),
        ...propagate,
      };
    }
    case "setTransparent": {
      const remap = raw["remap"];
      return {
        type: "setTransparent",
        ...ref(),
        color: get("color"),
        ...(typeof remap === "number" ? { remap } : {}),
        ...propagate,
      };
    }
    case "addCel": {
      const source = raw["source"] as CelRef | null | undefined;
      return {
        type: "addCel",
        loop: get("loop"),
        at: get("at"),
        from: source ?? "blank",
        ...propagate,
      };
    }
    case "deleteCel":
      return { type: "deleteCel", ...ref(), ...propagate };
    case "moveCel":
      return { type: "moveCel", ...ref(), to: get("to"), ...propagate };
    case "unlinkMirror":
      return { type: "unlinkMirror", loop: get("loop") };
    default:
      throw new OpError(`${label}: unknown sprite operation '${String(raw["type"])}'`);
  }
}

/** The ids a picture op edits, and the ids it creates. */
function opItems(
  op: EditOperation,
  document: PictureDocument,
): { edits: string[]; creates: string[] } {
  switch (op.type) {
    case "setPoint": {
      const item = document.items.find((i) => i.openLine < op.line && op.line < i.closeLine);
      return { edits: item ? [item.id] : [`line ${op.line}`], creates: [] };
    }
    case "duplicateItem":
      return { edits: [op.itemId], creates: [op.newId] };
    case "insertShape":
    case "insertFill":
    case "insertPlot":
      return { edits: [], creates: [op.id] };
    default:
      return { edits: [op.itemId], creates: [] };
  }
}

interface CellCount {
  readonly cells: number;
  readonly bbox: CellBox | null;
}

function countMask(mask: Uint8Array, where?: (index: number) => boolean): CellCount {
  let cells = 0;
  let x0 = SCREEN_WIDTH;
  let y0 = SCREEN_HEIGHT;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < CELLS; i++) {
    if (mask[i] !== 1 || (where && !where(i))) continue;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    cells++;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { cells, bbox: cells === 0 ? null : { x0, y0, x1, y1 } };
}

function changedMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const mask = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) if (a[i] !== b[i]) mask[i] = 1;
  return mask;
}

const box = (count: CellCount) =>
  count.bbox === null
    ? "no cells"
    : `${count.cells} cell${count.cells === 1 ? "" : "s"} at ${count.bbox.x0},${count.bbox.y0}..${count.bbox.x1},${count.bbox.y1}`;

function openPicture(
  session: AgentSessionState,
  draft: AssistDraft,
): { document: PictureDocument; compiled: CompiledDocument } {
  if (draft.kind !== "picture") throw new OpError("the Studio draft is not a picture");
  const { document, diagnostics } = parsePictureDocument(draft.source);
  const problem = diagnostics[0];
  if (problem)
    throw new OpError(
      `the draft has a directive problem at line ${problem.line}: ${problem.message}`,
    );
  try {
    return { document, compiled: compileEditDocument(document, session.profile) };
  } catch (error) {
    if (error instanceof PictureSourceSyntaxError)
      throw new OpError(`the draft does not compile: ${error.message}`);
    throw error;
  }
}

function openView(session: AgentSessionState, draft: AssistDraft): SpriteDocument {
  if (draft.kind !== "view") throw new OpError("the Studio draft is not a view");
  try {
    return openSprite(draft.payload, session.profile);
  } catch (error) {
    throw new OpError(`the draft view does not decode: ${String(error)}`);
  }
}

/** The ego's first cel size, for the walkable estimate; null without a view 0. */
function egoSize(session: AgentSessionState): { width: number; height: number } | null {
  try {
    const payload = session.container.getResource("view", 0);
    const cel = payload ? parseView(payload, session.profile).loops[0]?.cels[0] : undefined;
    return cel ? { width: cel.width, height: cel.height } : null;
  } catch {
    return null;
  }
}

/** Walkable cells for the ego inside `area` and overall, or null without an ego view. */
function walkable(
  session: AgentSessionState,
  focus: StudioFocus,
  priority: Uint8Array,
  area: Uint8Array,
): { inSelection: number; overall: number } | null {
  const ego = egoSize(session);
  if (!ego) return null;
  const mask = walkableMask({
    priority,
    egoWidth: ego.width,
    egoHeight: ego.height,
    observeBlocks: true,
    waterGate: null,
    horizon: focus.horizon ?? DEFAULT_HORIZON,
  });
  return {
    inSelection: countMask(mask, (i) => area[i] === 1).cells,
    overall: countMask(mask).cells,
  };
}

const walkRelevant = (scope: PictureAssistScope) => !scope.lockedPlanes.includes("priority");

/** Control values 0..3 inside `area`: what a Walk lens edit may repaint. */
function controlsIn(priority: Uint8Array, area: Uint8Array) {
  return [0, 1, 2, 3].flatMap((value) => {
    const count = countMask(area, (i) => priority[i] === value);
    return count.cells > 0 ? [{ value, ...count }] : [];
  });
}

const CONTROL_NAMES = ["barrier", "conditional barrier", "signal", "water"];

function roomContext(
  session: AgentSessionState,
  focus: StudioFocus,
  planes: { visual: Uint8Array; priority: Uint8Array } | null,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (focus.room !== undefined) {
    try {
      const logics = new Map<number, Uint8Array>();
      const pictures = new Set<number>();
      for (let num = 0; num < 256; num++) {
        const logic = session.container.getResource("logic", num);
        if (logic) logics.set(num, logic);
        if (session.container.getResource("picture", num)) pictures.add(num);
      }
      const { scans, shared } = scanContainerExits(logics, session.profile);
      const use = roomPictureUse(focus.room, { scans, shared, pictures });
      out["room"] = focus.room;
      out["pictures"] = use.pictures.map((p) => p.picture);
      if (use.runtime) out["picturesChosenAtRuntime"] = true;
    } catch (error) {
      out["room"] = focus.room;
      out["picturesError"] = String(error);
    }
  }
  const ghost = focus.ghost;
  if (ghost && planes) {
    try {
      const payload = session.container.getResource("view", ghost.view);
      const cel = payload
        ? parseView(payload, session.profile).loops[ghost.loop]?.cels[ghost.cel]
        : undefined;
      if (!cel) throw new Error(`view ${ghost.view} has no loop ${ghost.loop}, cel ${ghost.cel}`);
      const probe = probeActor({
        picture: planes,
        cel,
        x: ghost.x,
        baselineY: ghost.baselineY,
        priority: ghost.priority,
        profile: session.profile,
      });
      out["ghost"] = {
        ...ghost,
        bandPriority: probe.bandPriority,
        drawPriority: probe.drawPriority,
        hiddenPixels: countMask(probe.hiddenMask).cells,
        drawnPixels: countMask(probe.drawnMask).cells,
        controlHits: probe.controlHits.map(({ value, cells }) => ({ value, cells: cells.length })),
        footprintAccepted: probe.footprint.accepted,
      };
    } catch (error) {
      out["ghost"] = { error: String(error) };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function footprintOf(compiled: CompiledDocument, id: string) {
  return {
    visual: countMask(footprintMask(compiled, id, "visual")),
    priority: countMask(footprintMask(compiled, id, "priority")),
  };
}

/** Target items and their neighbours in document order, with 1-based line numbers. */
function excerpt(document: PictureDocument, targets: readonly string[]): string {
  const keep = new Set<number>();
  document.items.forEach((item, index) => {
    if (!targets.includes(item.id)) return;
    for (const near of [index - 1, index, index + 1])
      if (near >= 0 && near < document.items.length) keep.add(near);
  });
  const out: string[] = [];
  for (const index of [...keep].sort((a, b) => a - b)) {
    const item: PictureItem = document.items[index]!;
    const last = Math.min(item.closeLine, document.lines.length);
    const role = targets.includes(item.id) ? "selected" : "neighbour";
    out.push(`-- ${role} '${item.id}', lines ${item.openLine}-${last}`);
    for (let line = item.openLine; line <= last; line++) {
      if (line - item.openLine >= MAX_ITEM_LINES && line < last) {
        out.push(`   … ${last - line} more lines`);
        out.push(`${String(last).padStart(4)}| ${document.lines[last - 1]!.replace(/\r$/, "")}`);
        break;
      }
      out.push(`${String(line).padStart(4)}| ${document.lines[line - 1]!.replace(/\r$/, "")}`);
    }
    if (out.length >= MAX_EXCERPT_LINES) {
      out.length = MAX_EXCERPT_LINES;
      out.push("   … excerpt truncated");
      break;
    }
  }
  return out.join("\n");
}

function readPictureContext(
  session: AgentSessionState,
  focus: StudioFocus,
  scope: PictureAssistScope,
  draft: AssistDraft,
  images: boolean,
): AgentToolResult {
  const { document, compiled } = openPicture(session, draft);
  const revision = draftRevision(draft);
  const area = selectionArea(compiled, scope.targetIds);
  const areaCount = countMask(area);
  const items = scope.targetIds.map((id) => {
    const item = document.items.find((candidate) => candidate.id === id);
    if (!item) return { id, missing: true };
    return {
      id,
      label: item.label,
      kind: item.kind,
      locked: item.locked,
      lines: [item.openLine, item.closeLine],
      footprint: footprintOf(compiled, id),
    };
  });
  const may: Record<PicturePlane, string> = { visual: "", priority: "" };
  for (const plane of ["visual", "priority"] as const) {
    if (scope.lockedPlanes.includes(plane)) {
      may[plane] = "locked: no cell may change";
      continue;
    }
    const extra =
      scope.allowedMask instanceof Uint8Array ? scope.allowedMask : scope.allowedMask?.[plane];
    const own = scope.targetIds.map((id) => footprintMask(compiled, id, plane));
    const mask = new Uint8Array(CELLS);
    for (const m of [...own, ...(extra ? [extra] : [])])
      for (let i = 0; i < CELLS; i++) if (m[i] === 1) mask[i] = 1;
    may[plane] =
      `may change only in ${box(countMask(mask))} (the selection; a moved target also licenses its new footprint)`;
  }
  const room = roomContext(session, focus, compiled);
  const walk = walkRelevant(scope) ? walkable(session, focus, compiled.priority, area) : null;
  const controls = walkRelevant(scope) ? controlsIn(compiled.priority, area) : [];
  const depthLocked = depthValuesLocked(scope.lens, scope.unlocks);
  const crop =
    areaCount.bbox === null
      ? { x0: 0, y0: 0, x1: SCREEN_WIDTH - 1, y1: SCREEN_HEIGHT - 1 }
      : {
          x0: Math.max(0, areaCount.bbox.x0 - 4),
          y0: Math.max(0, areaCount.bbox.y0 - 4),
          x1: Math.min(SCREEN_WIDTH - 1, areaCount.bbox.x1 + 4),
          y1: Math.min(SCREEN_HEIGHT - 1, areaCount.bbox.y1 + 4),
        };
  const cropW = crop.x1 - crop.x0 + 1;
  const cropH = crop.y1 - crop.y0 + 1;
  const cropVisual = new Uint8Array(cropW * cropH);
  for (let y = 0; y < cropH; y++)
    for (let x = 0; x < cropW; x++)
      cropVisual[y * cropW + x] = compiled.visual[(crop.y0 + y) * SCREEN_WIDTH + crop.x0 + x]!;
  const grid = colourGrid(cropVisual, Math.min(8, cropW), Math.min(7, cropH), {
    width: cropW,
    height: cropH,
  });
  const stale = revision !== scope.baseRevision;
  const imageList: AgentToolImage[] = [];
  if (images) {
    const scale = cropScale(crop);
    imageList.push(
      {
        png: pictureCropPng(compiled, crop, scale),
        caption: `Selection crop x${crop.x0}-${crop.x1} y${crop.y0}-${crop.y1}, each cell ${scale * 2}x${scale} image pixels. ${PICTURE_COMPARISON_LEGEND}`,
      },
      {
        png: pictureOverviewPng(compiled.visual, area),
        caption: "Whole room, visual plane at 320x168; the selection is tinted magenta.",
      },
    );
  }
  const lines = [
    `Picture ${scope.num}, lens ${scope.lens}, locked planes: ${scope.lockedPlanes.join(", ") || "none"}. baseRevision ${revision}${stale ? ` (the request was made on ${scope.baseRevision}: the draft changed since; proposals will be refused as stale)` : ""}.`,
    `Selected: ${items.map((i) => ("missing" in i ? `${i.id} (missing)` : `${i.id} "${i.label}" ${i.kind}${i.locked ? " locked" : ""}`)).join(", ")}; on screen ${box(areaCount)}.`,
    `Visual plane ${may.visual}. Priority plane ${may.priority}.`,
    ...(depthLocked
      ? [
          "Depth values 4–15 are locked in the Walk lens: paint only control values 0–3 (0 barrier, 1 conditional barrier, 2 signal, 3 water; water blocks only an actor kept on land), and change no cell into, out of or within 4–15.",
        ]
      : []),
    ...(controls.length
      ? [
          `Control values in the selection: ${controls.map((c) => `${c.value} ${CONTROL_NAMES[c.value]} ${box(c)}`).join("; ")}.`,
        ]
      : []),
    ...(walk
      ? [
          `Walkable estimate for the ego (view 0 cel size, horizon ${focus.horizon ?? DEFAULT_HORIZON}): ${walk.inSelection} baseline cells in the selection, ${walk.overall} overall.`,
        ]
      : []),
    `Dominant colour of the crop, x${crop.x0}-${crop.x1} y${crop.y0}-${crop.y1}:`,
    grid,
    "Annotated source of the selection and its neighbours:",
    excerpt(document, scope.targetIds),
  ];
  return {
    success: true,
    message: lines.join("\n"),
    details: {
      kind: "picture",
      num: scope.num,
      lens: scope.lens,
      lockedPlanes: scope.lockedPlanes,
      depthValuesLocked: depthLocked,
      controls,
      baseRevision: revision,
      stale,
      selection: items,
      selectionArea: areaCount,
      protected: may,
      maxBytes: scope.maxBytes,
      bytes: compiled.bytes.length,
      lineCount: document.lines.length,
      ...(room ? { roomContext: room } : {}),
      ...(walk ? { walkable: walk } : {}),
      crop,
    },
    ...(imageList.length ? { images: imageList } : {}),
  };
}

function celRows(document: SpriteDocument, targets: readonly CelRef[]) {
  let pixels = 0;
  const out: {
    loop: number;
    cel: number;
    width: number;
    height: number;
    transparent: number;
    rows?: string[];
  }[] = [];
  for (const { loop, cel } of targets) {
    const c = document.loops[loop]?.cels[cel];
    if (!c) continue;
    pixels += c.width * c.height;
    const entry = { loop, cel, width: c.width, height: c.height, transparent: c.transparent };
    if (pixels > MAX_ROW_PIXELS) {
      out.push(entry);
      continue;
    }
    const rows = Array.from({ length: c.height }, (_, y) =>
      [...c.pixels.subarray(y * c.width, (y + 1) * c.width)]
        .map((p) => p.toString(16).toUpperCase())
        .join(""),
    );
    out.push({ ...entry, rows });
  }
  return out;
}

function readViewContext(
  session: AgentSessionState,
  focus: StudioFocus,
  scope: ViewAssistScope,
  draft: AssistDraft,
  images: boolean,
): AgentToolResult {
  const document = openView(session, draft);
  const revision = draftRevision(draft);
  const stale = revision !== scope.baseRevision;
  const targetLoops = [...new Set(scope.targetCels.map(({ loop }) => loop))].sort((a, b) => a - b);
  const loops = document.loops.map((loop, index) => ({
    loop: index,
    cels: loop.cels.length,
    mirrorOf: loop.alias,
    selected: targetLoops.includes(index),
    protected: scope.protectedLoops?.includes(index) === true,
  }));
  const rows = celRows(document, scope.targetCels);
  const colours = scope.targetCels.flatMap(({ loop, cel }) => {
    const c = document.loops[loop]?.cels[cel];
    if (!c) return [];
    const counts: Record<string, number> = {};
    for (const p of c.pixels) if (p !== c.transparent) counts[p] = (counts[p] ?? 0) + 1;
    return [{ loop, cel, colours: counts }];
  });
  const partners = targetLoops.flatMap((loop) => {
    const alias = document.loops[loop]?.alias;
    const group = document.loops.flatMap((other, index) =>
      index !== loop && (index === alias || other.alias === (alias ?? loop)) ? [index] : [],
    );
    return group.length ? [{ loop, sharesBlockWith: group }] : [];
  });
  const room = roomContext(session, focus, null);
  const lines = [
    `View ${scope.num}: ${document.loops.length} loops. baseRevision ${revision}${stale ? ` (the request was made on ${scope.baseRevision}: the draft changed since; proposals will be refused as stale)` : ""}.`,
    `Selected cels (the only cels whose pixels may change): ${scope.targetCels.map(({ loop, cel }) => `L${loop} C${cel}`).join(", ")}.`,
    `Protected: every other cel${scope.protectedLoops?.length ? `; loops ${scope.protectedLoops.join(", ")} entirely` : ""}; the loop count and description.`,
    ...partners.map(
      (p) =>
        `Loop ${p.loop} shares its data block with loop ${p.sharesBlockWith.join(", ")} (a mirror): an edit of loop ${p.loop} splits it off by copy-on-write unless propagate is set, which would change the partner too.`,
    ),
    "Rows are EGA hex digits per pixel, top to bottom; the cel's transparent colour marks empty pixels.",
    ...rows.map(
      (r) =>
        `L${r.loop} C${r.cel} ${r.width}x${r.height} transparent ${r.transparent}:${r.rows ? `\n${r.rows.join("\n")}` : " (rows over the budget; select fewer cels)"}`,
    ),
  ];
  return {
    success: true,
    message: lines.join("\n"),
    details: {
      kind: "view",
      num: scope.num,
      lens: focus.lens ?? null,
      baseRevision: revision,
      stale,
      loops,
      selection: scope.targetCels,
      protectedLoops: scope.protectedLoops ?? [],
      mirrors: partners,
      colours,
      maxBytes: scope.maxBytes,
      bytes: document.payload.length,
      ...(room ? { roomContext: room } : {}),
    },
    ...(images
      ? {
          images: [
            {
              png: spriteSheetPng(
                scope.targetCels
                  .slice(0, MAX_SHEET_ROWS)
                  .map(({ loop, cel }) => ({ after: document.loops[loop]?.cels[cel] })),
                false,
              ),
              caption: `Selected cels ${scope.targetCels
                .slice(0, MAX_SHEET_ROWS)
                .map(({ loop, cel }) => `L${loop} C${cel}`)
                .join(
                  ", ",
                )}, one per row; each pixel twice as wide as tall; dark grey is transparent.`,
            },
          ],
        }
      : {}),
  };
}

const HINTS: Record<string, string> = {
  "stale-base": "Call read_edit_context again and build the proposal on its baseRevision.",
  "unknown-target": "The selection itself is out of date; tell the creator.",
  "locked-plane": "Leave the locked plane exactly as it is.",
  "walk-depth":
    "In the Walk lens paint only control values 0–3 (0 barrier, 1 conditional, 2 signal, 3 water) and leave depth values as they are.",
  "outside-mask": "Confine the change to the selected items' cells.",
  "fill-spill": "Keep every fill inside a closed outline within the selection.",
  "outside-target": "Change only the selected items or cels.",
  "protected-loop": "Leave the protected loops exactly as they are.",
  "max-bytes": "Use fewer drawing commands.",
};

function refusal(
  assist: StudioAssist,
  reason: string,
  violations: readonly { constraint: string; message: string }[],
): AgentToolResult {
  assist.refusals++;
  const hints = [...new Set(violations.map((v) => HINTS[v.constraint]).filter(Boolean))];
  const left = assist.maxProposals - assist.proposals;
  const kept = assist.candidate
    ? `Candidate ${assist.candidate.candidateId} is still the one the creator sees.`
    : "There is no candidate yet.";
  return {
    success: false,
    error: `Refused; nothing was proposed: ${reason}.${hints.length ? ` ${hints.join(" ")}` : ""} ${kept} ${left > 0 ? `${left} proposal${left === 1 ? "" : "s"} left in this request.` : "No proposals are left in this request; reply with one sentence saying what blocks the change."}`,
    details: {
      ok: false,
      violations,
      candidateId: assist.candidate?.candidateId ?? null,
      proposalsLeft: left,
    },
  };
}

function proposePicture(
  session: AgentSessionState,
  assist: StudioAssist,
  scope: PictureAssistScope,
  draft: AssistDraft,
  rawOps: readonly Raw[],
  summary: string,
): AgentToolResult {
  const before = openPicture(session, draft);
  const ops = rawOps.map((raw, index) => pictureOp(raw, `pictureOps[${index}]`));
  const allowed = new Set(scope.targetIds);
  let document = before.document;
  for (const [index, op] of ops.entries()) {
    const { edits, creates } = opItems(op, document);
    const outside = edits.filter((id) => !allowed.has(id));
    if (outside.length)
      return refusal(
        assist,
        `pictureOps[${index}] (${op.type}) edits ${outside.join(", ")}, which is not selected`,
        [{ constraint: "outside-target", message: `${op.type} edits ${outside.join(", ")}` }],
      );
    const result = applyEdit(document, op, { profile: session.profile });
    if ("error" in result)
      return refusal(
        assist,
        `the editor refused pictureOps[${index}] (${op.type}): ${result.error}`,
        [{ constraint: "kernel", message: result.error }],
      );
    document = result.document;
    for (const id of creates) allowed.add(id);
  }
  const source = serializePictureDocument(document);
  if (source === serializePictureDocument(before.document))
    return refusal(assist, "the operations change nothing", []);
  const after = compileEditDocument(document, session.profile);
  const check = checkCandidate(before.compiled, after, scope);
  if (!check.ok) return refusal(assist, assistRefusalText(check), check.violations);
  const candidateId = `c${assist.proposals}`;
  const previewPng = pictureAssistPreviewPng(before.compiled, after);
  const changed = {
    visual: countMask(changedMask(before.compiled.visual, after.visual)),
    priority: countMask(changedMask(before.compiled.priority, after.priority)),
  };
  const area = selectionArea(before.compiled, scope.targetIds);
  const walk = walkRelevant(scope)
    ? (() => {
        const was = walkable(session, assist.focus, before.compiled.priority, area);
        const now = walkable(session, assist.focus, after.priority, area);
        return was && now ? { before: was.inSelection, after: now.inSelection } : null;
      })()
    : null;
  const candidateDraft = { kind: "picture", source } as const;
  const revision = draftRevision(candidateDraft);
  assist.candidate = {
    kind: "picture",
    candidateId,
    num: scope.num,
    baseRevision: scope.baseRevision,
    revision,
    summary,
    ops,
    draft: candidateDraft,
    previewPng,
    check,
    ...(walk ? { walkable: walk } : {}),
  };
  return {
    success: true,
    message: `Candidate ${candidateId} for picture ${scope.num}: ${summary}\nChanged: visual ${box(changed.visual)}; priority ${box(changed.priority)}.${walk ? ` Walkable baseline cells in the selection: ${walk.before} → ${walk.after}.` : ""} ${after.bytes.length} bytes (${after.bytes.length - before.compiled.bytes.length >= 0 ? "+" : ""}${after.bytes.length - before.compiled.bytes.length}).\nThe creator sees the attached before | after | diff and accepts or rejects it. Call propose_edit again to replace it, or reply with one sentence describing the change.`,
    details: {
      ok: true,
      candidateId,
      summary,
      kind: "picture",
      num: scope.num,
      baseRevision: scope.baseRevision,
      revision,
      changed,
      bytes: after.bytes.length,
      ...(walk ? { walkable: walk } : {}),
    },
    images: [{ png: previewPng, caption: PICTURE_ASSIST_PREVIEW_CAPTION }],
  };
}

function proposeView(
  session: AgentSessionState,
  assist: StudioAssist,
  scope: ViewAssistScope,
  draft: AssistDraft,
  rawOps: readonly Raw[],
  summary: string,
): AgentToolResult {
  const before = openView(session, draft);
  const ops = rawOps.map((raw, index) => spriteOp(raw, `spriteOps[${index}]`));
  let document = before;
  const isolated = new Set<number>();
  for (const [index, op] of ops.entries()) {
    const result = applySpriteEdit(document, op);
    if ("error" in result)
      return refusal(
        assist,
        `the editor refused spriteOps[${index}] (${op.type}): ${result.error}`,
        [{ constraint: "kernel", message: result.error }],
      );
    document = result.document;
    for (const loop of result.isolated) isolated.add(loop);
  }
  if (draftRevision({ kind: "view", payload: document.payload }) === draftRevision(draft))
    return refusal(assist, "the operations change nothing", []);
  const check = checkCandidate(before, document, scope);
  if (!check.ok) return refusal(assist, assistRefusalText(check), check.violations);
  const changedCels: { loop: number; cel: number; pixels: number }[] = [];
  const loops = Math.max(before.loops.length, document.loops.length);
  const pairs: CelPair[] = [];
  for (let loop = 0; loop < loops; loop++) {
    const cels = Math.max(
      before.loops[loop]?.cels.length ?? 0,
      document.loops[loop]?.cels.length ?? 0,
    );
    for (let cel = 0; cel < cels; cel++) {
      const a = before.loops[loop]?.cels[cel];
      const b = document.loops[loop]?.cels[cel];
      let pixels = 0;
      if (!a || !b || a.width !== b.width || a.height !== b.height)
        pixels = Math.max(a ? a.width * a.height : 0, b ? b.width * b.height : 0);
      else
        for (let i = 0; i < a.pixels.length; i++) {
          const pa = a.pixels[i] === a.transparent ? -1 : a.pixels[i];
          const pb = b.pixels[i] === b.transparent ? -1 : b.pixels[i];
          if (pa !== pb) pixels++;
        }
      if (pixels === 0) continue;
      changedCels.push({ loop, cel, pixels });
      if (pairs.length < MAX_SHEET_ROWS) pairs.push({ before: a, after: b });
    }
  }
  const previewPng = spriteSheetPng(
    pairs.length ? pairs : [{ before: undefined, after: undefined }],
    true,
  );
  const candidateId = `c${assist.proposals}`;
  const candidateDraft = { kind: "view", payload: document.payload.slice() } as const;
  const revision = draftRevision(candidateDraft);
  assist.candidate = {
    kind: "view",
    candidateId,
    num: scope.num,
    baseRevision: scope.baseRevision,
    revision,
    summary,
    ops,
    draft: candidateDraft,
    previewPng,
    check,
  };
  const split = [...isolated].sort((a, b) => a - b);
  return {
    success: true,
    message: `Candidate ${candidateId} for view ${scope.num}: ${summary}\nChanged: ${changedCels.map((c) => `L${c.loop} C${c.cel} ${c.pixels} px`).join(", ") || "metadata only"}.${split.length ? ` Loop ${split.join(", ")} now has its own data block (split from its mirror).` : ""} ${document.payload.length} bytes.\nThe creator sees the attached before | after | diff and accepts or rejects it. Call propose_edit again to replace it, or reply with one sentence describing the change.`,
    details: {
      ok: true,
      candidateId,
      summary,
      kind: "view",
      num: scope.num,
      baseRevision: scope.baseRevision,
      revision,
      changedCels,
      isolated: split,
      bytes: document.payload.length,
    },
    images: [
      {
        png: previewPng,
        caption: `Candidate cels, one per row (${pairs.map((_, i) => `L${changedCels[i]!.loop} C${changedCels[i]!.cel}`).join(", ")}): before | after | diff (changed pixels magenta). Each pixel is twice as wide as tall; dark grey is transparent.`,
      },
    ],
  };
}

/**
 * Execute read_edit_context or propose_edit for `assist`, or return undefined
 * for any other name. Arguments are already schema-validated.
 */
export function executeStudioAssistTool(
  session: AgentSessionState,
  assist: StudioAssist,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (!STUDIO_ASSIST_TOOL_NAMES.includes(name)) return undefined;
  const { scope } = assist.focus;
  try {
    const draft = assist.focus.draft();
    if (draft.kind !== scope.kind)
      return {
        success: false,
        error: `The Studio draft is a ${draft.kind}, but the request is about a ${scope.kind}.`,
      };
    if (name === "read_edit_context") {
      const images = args["images"] !== false;
      return scope.kind === "picture"
        ? readPictureContext(session, assist.focus, scope, draft, images)
        : readViewContext(session, assist.focus, scope, draft, images);
    }
    if (assist.proposals >= assist.maxProposals)
      return {
        success: false,
        error: `Refused: this request allows ${assist.maxProposals} proposals and all were used. Reply with one sentence saying what blocks the change.`,
        details: {
          ok: false,
          candidateId: assist.candidate?.candidateId ?? null,
          proposalsLeft: 0,
        },
      };
    assist.proposals++;
    const pictureOps = args["pictureOps"] as Raw[] | null;
    const spriteOps = args["spriteOps"] as Raw[] | null;
    const summary = String(args["summary"]).trim();
    const ops = scope.kind === "picture" ? pictureOps : spriteOps;
    const other = scope.kind === "picture" ? spriteOps : pictureOps;
    if (!ops || other)
      return refusal(
        assist,
        `this request is about ${scope.kind} ${scope.num}: send ${scope.kind === "picture" ? "pictureOps" : "spriteOps"} and set ${scope.kind === "picture" ? "spriteOps" : "pictureOps"} to null`,
        [],
      );
    const current = draftRevision(draft);
    if (current !== scope.baseRevision)
      return refusal(
        assist,
        "the creator changed the draft after asking, so this request can no longer propose a change; reply with one sentence asking them to ask again",
        [{ constraint: "stale-base", message: "the draft changed during the request" }],
      );
    if (args["baseRevision"] !== current)
      return refusal(
        assist,
        `baseRevision ${String(args["baseRevision"])} is not the draft's current revision`,
        [{ constraint: "stale-base", message: "the proposal was built on an older draft" }],
      );
    return scope.kind === "picture"
      ? proposePicture(session, assist, scope, draft, ops, summary)
      : proposeView(session, assist, scope, draft, ops, summary);
  } catch (error) {
    if (error instanceof OpError) {
      if (name === "propose_edit") return refusal(assist, error.message, []);
      return { success: false, error: `read_edit_context failed: ${error.message}` };
    }
    throw error;
  }
}
