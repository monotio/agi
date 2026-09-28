/**
 * Rules bound to Room Studio picture items (`// @rule … item=<id>`) follow
 * them: after a picture edit, every bound door exit or region box moves by
 * its item's translation, so moving a doorway in Room Studio moves the exit
 * that walks through it in the same Keep.
 *
 * An item's translation is how far the centre of its points' bounding box
 * moved (itemHandles: every vertex and fill seed). A moveItem shifts every
 * point by the same dx,dy, so that is exactly its dx,dy; a points edit that
 * reshapes the item moves the box by the shift of the item's centre, rounded
 * to whole pixels. The box keeps its size. Nothing is mutated.
 */
import { itemHandles } from "../editPoints.ts";
import type { PictureDocument } from "../pictureDocument.ts";
import { assembleAuthoredLogic } from "../../agent/agentState.ts";
import { serializeLogicDocument, type LogicDocument } from "./logicDocument.ts";
import { applyRuleEdit, type RuleSession } from "./ruleEdit.ts";
import { readRules, ruleBox } from "./ruleModel.ts";

/** How far a picture item moved between two documents; null when either has no points for it. */
export function itemTranslation(
  before: PictureDocument,
  after: PictureDocument,
  itemId: string,
): { readonly dx: number; readonly dy: number } | null {
  const centre = (document: PictureDocument): [number, number] | null => {
    const handles = itemHandles(document, itemId);
    if (handles.length === 0) return null;
    const xs = handles.map((h) => h.x);
    const ys = handles.map((h) => h.y);
    return [Math.min(...xs) + Math.max(...xs), Math.min(...ys) + Math.max(...ys)];
  };
  const from = centre(before);
  const to = centre(after);
  if (from === null || to === null) return null;
  // Centres are kept doubled so a moveItem's integer shift stays exact; +0 folds -0.
  return { dx: Math.round((to[0] - from[0]) / 2) + 0, dy: Math.round((to[1] - from[1]) / 2) + 0 };
}

export type FollowResult =
  | {
      readonly ok: true;
      readonly document: LogicDocument;
      readonly source: string;
      /** The assembled logic for `source`. */
      readonly bytes: Uint8Array;
      /** Rules whose box moved, with the item translation applied. */
      readonly moved: readonly {
        readonly rule: string;
        readonly item: string;
        readonly dx: number;
        readonly dy: number;
      }[];
      /** Bound rules left as they were, and why. */
      readonly detached: readonly {
        readonly rule: string;
        readonly item: string;
        readonly reason: string;
      }[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Move every rule bound to an item of the edited picture by that item's
 * translation, through the same moveRegionBox edit the UI uses, and assemble
 * the result. Refuses — so the whole Keep can be refused — when a bound rule
 * is native or its box would leave the picture.
 */
export function followPictureEdit(
  logic: LogicDocument,
  before: PictureDocument,
  after: PictureDocument,
  session: RuleSession,
): FollowResult {
  let document = logic;
  let source = serializeLogicDocument(logic);
  let bytes: Uint8Array;
  let messages: readonly (string | null)[];
  try {
    ({ payload: bytes, messages } = assembleAuthoredLogic(session, source));
  } catch (error) {
    return {
      ok: false,
      error: `The room's logic does not assemble as it stands: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const moved: { rule: string; item: string; dx: number; dy: number }[] = [];
  const detached: { rule: string; item: string; reason: string }[] = [];
  for (const { rule, model } of readRules(logic, {
    messages,
    bindings: session.authoring.bindings,
  })) {
    const item = rule.item;
    if (item === null) continue;
    const translation = itemTranslation(before, after, item);
    if (translation === null) {
      const gone = !after.items.some((candidate) => candidate.id === item);
      detached.push({
        rule: rule.id,
        item,
        reason: gone
          ? `picture item '${item}' no longer exists`
          : `picture item '${item}' has no points to follow`,
      });
      continue;
    }
    const { dx, dy } = translation;
    if (dx === 0 && dy === 0) continue;
    if (model === "native")
      return {
        ok: false,
        error: `Rule '${rule.id}' follows '${item}' but is written directly in the room's script; move its box in the script text.`,
      };
    const box = ruleBox(model);
    if (box === null) {
      detached.push({ rule: rule.id, item, reason: "an edge exit has no box to move" });
      continue;
    }
    const next = { x1: box.x1 + dx, y1: box.y1 + dy, x2: box.x2 + dx, y2: box.y2 + dy };
    if (next.x1 < 0 || next.y1 < 0 || next.x2 > 159 || next.y2 > 167)
      return {
        ok: false,
        error: `Moving '${item}' by ${dx},${dy} would put rule '${rule.id}' off the picture.`,
      };
    const result = applyRuleEdit(
      document,
      { op: "moveRegionBox", id: rule.id, box: next },
      session,
    );
    if (!result.ok) return result;
    ({ document, source, bytes } = result);
    moved.push({ rule: rule.id, item, dx, dy });
  }
  return { ok: true, document, source, bytes, moved, detached };
}
