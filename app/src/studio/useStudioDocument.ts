/**
 * The Room Studio's read-only document model: which source stands for the
 * picture bytes, its items and draw-order timeline, the surface at the
 * scrubber's playhead, and per-pixel ownership. `buildStudioModel` is pure;
 * the composable adds the playhead and caches masks for hover.
 */

import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { renderPicture } from "../../../src/picture/renderer.ts";
import { disassemblePicture, sourceCompilesTo } from "../../../src/picture/source.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { inferNativeItems } from "../../../src/studio/nativeItems.ts";
import {
  parsePictureDocument,
  pictureCommandText,
  pictureItemAtLine,
  type PictureDocument,
  type PictureItemKind,
  type StudioDiagnostic,
} from "../../../src/studio/pictureDocument.ts";
import {
  dominantValues,
  EGA_COLOUR_NAMES,
  groupSceneItems,
  sectionSceneRows,
} from "../../../src/studio/sceneGroups.ts";
import {
  commandTimeline,
  compileDocument,
  itemAt,
  itemMask,
  renderUpTo,
  whyNotFilled,
  type CompiledPictureDocument,
  type FillExplanation,
  type PicturePlane,
  type TimelineEntry,
} from "../../../src/studio/pictureQuery.ts";
import { createPictureSurface, SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import {
  CONTROL_VALUES,
  priorityMeaning,
  spanIndexAt,
  tickFor,
  type StudioLens,
} from "./studioView.ts";

export interface StudioSource {
  bytes: Uint8Array;
  /** Authored text; used only while it compiles to exactly `bytes`. */
  authoredSource?: string | undefined;
  profile: AgiProfile;
}

/** Row id of the loose lines outside every item (not a valid item id). */
export const UNASSIGNED = "(unassigned)";
/** Prefixes of group and section row ids; item ids start with a letter, so none collides. */
const GROUP = "(group)";
const SECTION = "(section)";

export interface SceneRow {
  id: string;
  label: string;
  kind: PictureItemKind | "loose";
  locked: boolean;
  /** Timeline indices of the row's byte-emitting commands, ascending. */
  entries: number[];
  /**
   * EGA colour of the value most of its own pixels hold (visual for art,
   * priority for depth and walk; a control value in its Walk lens colour),
   * or null when it owns none.
   */
  swatch: number | null;
  /**
   * The value most of its own pixels hold on its plane (visual for art and
   * mixed, priority for depth and walk), or null when it owns none there.
   */
  value: number | null;
  /** Short tag: the kind, or the one priority/control value a depth/walk item draws. */
  tag: string;
}

/** An automatic group of consecutive items (sceneGroups.ts), as a row of its own. */
export interface SceneGroupRow extends SceneRow {
  /** Member item ids, in draw order; at least two. */
  members: readonly string[];
}

/** One entry of the Scene list above the items: a group, or a single item shown flat. */
export type SceneBranch =
  | { readonly group: SceneGroupRow; readonly rows: readonly SceneRow[] }
  | { readonly group: null; readonly rows: readonly [SceneRow] };

/**
 * A draw-order section: a contiguous run of branches that a long list
 * (sceneGroups.ts `sectionSceneRows`) folds into one row, "Steps a–b".
 */
export interface SceneSectionRow extends SceneGroupRow {
  branches: readonly SceneBranch[];
  /** Its two or three dominant colours, by command count. */
  swatches: readonly number[];
}

export interface StudioModel {
  source: string;
  /** Whether the authored source was used (it compiles to the exact bytes). */
  trusted: boolean;
  document: PictureDocument;
  diagnostics: StudioDiagnostic[];
  compiled: CompiledPictureDocument;
  timeline: TimelineEntry[];
  /** Drawing commands: the timeline without its closing `end`, which draws nothing. */
  commands: number;
  /** Items in draw order, then the Unassigned group when there are loose commands. */
  rows: SceneRow[];
  /** The items (not Unassigned) folded into automatic groups, in draw order. */
  branches: SceneBranch[];
  /** The multi-item groups, for lookups by id. */
  groups: SceneGroupRow[];
  /** Draw-order sections over the branches; empty unless there are more than 60 branches. */
  sections: SceneSectionRow[];
  /** Groups and sections: every row that stands for several items. */
  folds: SceneGroupRow[];
  /** Per byte offset, the index into `rows` of the line that emitted it. */
  byteRow: Int32Array;
  profile: AgiProfile;
}

const PLANES: readonly PicturePlane[] = ["visual", "priority"];

function dominant(counts: Uint32Array): number | null {
  let best = -1;
  for (let v = 0; v < counts.length; v++)
    if (counts[v]! > 0 && (best < 0 || counts[v]! > counts[best]!)) best = v;
  return best < 0 ? null : best;
}

function tagFor(kind: SceneRow["kind"], entries: readonly TimelineEntry[]): string {
  if (kind !== "depth" && kind !== "walk") return kind;
  const values = [
    ...new Set(
      entries
        .filter((e) => tickFor(e).kind !== "state" && e.priority !== null)
        .map((e) => e.priority!),
    ),
  ];
  if (values.length !== 1) return kind;
  const value = values[0]!;
  return value < 4 ? CONTROL_VALUES[value]!.name : `pri ${value}`;
}

/** "Brown art · 12", "Band 9 depth · 4", "Barrier walk · 3"; "Covered" when no pixel is left. */
export function groupLabel(kind: SceneRow["kind"], value: number | null, count: number): string {
  const name =
    value === null
      ? "covered"
      : kind === "depth" || kind === "walk"
        ? priorityMeaning(value)
        : EGA_COLOUR_NAMES[value]!;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${kind} · ${count}`;
}

/** Fold consecutive items into automatic groups; one-item groups stay plain rows. */
function branchesOf(items: readonly SceneRow[]): SceneBranch[] {
  return groupSceneItems(items).map(({ start, count, kind, value }): SceneBranch => {
    const rows = items.slice(start, start + count);
    const first = rows[0]!;
    if (count === 1) return { group: null, rows: [first] };
    const tags = new Set(rows.map((row) => row.tag));
    return {
      group: {
        id: `${GROUP}${first.id}`,
        label: groupLabel(kind, value, count),
        kind,
        locked: rows.every((row) => row.locked),
        entries: rows.flatMap((row) => row.entries),
        swatch: first.swatch,
        value,
        tag: tags.size === 1 ? first.tag : kind,
        members: rows.map((row) => row.id),
      },
      rows,
    };
  });
}

/** Fold a long list of branches into draw-order sections, "Steps a–b" in playhead numbers. */
function sectionsOf(branches: readonly SceneBranch[]): SceneSectionRow[] {
  const heads = branches.map((branch) => branch.group ?? branch.rows[0]);
  const spans = sectionSceneRows(heads.map((row) => row.entries.length)) ?? [];
  return spans.map(({ start, count }) => {
    const rows = branches.slice(start, start + count).flatMap((branch) => branch.rows);
    const entries = rows.flatMap((row) => row.entries);
    const steps =
      entries.length === 0 ? "" : ` ${entries[0]! + 1}–${entries[entries.length - 1]! + 1}`;
    return {
      id: `${SECTION}${rows[0]!.id}`,
      label: `Steps${steps}`,
      kind: "mixed",
      locked: rows.every((row) => row.locked),
      entries,
      swatch: null,
      value: null,
      tag: "section",
      members: rows.map((row) => row.id),
      branches: branches.slice(start, start + count),
      swatches: dominantValues(
        rows.map((row) => ({ value: row.swatch, weight: row.entries.length })),
      ),
    };
  });
}

/** A source ready to model: its annotated text and whether it was authored. */
export interface ResolvedStudioSource {
  source: string;
  /** The authored text was used (it compiles to the exact bytes). */
  trusted: boolean;
  profile: AgiProfile;
}

/**
 * Resolve the source (authored when it compiles to the bytes, else the
 * disassembly) and wrap an unannotated source in native items.
 */
export function resolveStudioSource({
  bytes,
  authoredSource,
  profile,
}: StudioSource): ResolvedStudioSource {
  const trusted = authoredSource !== undefined && sourceCompilesTo(authoredSource, bytes, profile);
  const base = trusted ? authoredSource : disassemblePicture(bytes, { profile });
  let source = base;
  try {
    source = inferNativeItems(base, { profile });
  } catch {
    // An ungroupable source stays one Unassigned row.
  }
  return { source, trusted, profile };
}

/**
 * Compile a source and derive the scene rows. Picture bytes are resolved
 * first (resolveStudioSource); a resolved source (Studio's draft) is modelled
 * as it stands.
 */
export function buildStudioModel(input: StudioSource | ResolvedStudioSource): StudioModel {
  const { source, trusted, profile } = "source" in input ? input : resolveStudioSource(input);
  const { document, diagnostics } = parsePictureDocument(source);
  const compiled = compileDocument(document, profile);
  const timeline = commandTimeline(document, profile);
  const commands = timeline.at(-1)?.op === "end" ? timeline.length - 1 : timeline.length;

  const rows: SceneRow[] = document.items.map((item) => ({
    id: item.id,
    label: item.label,
    kind: item.kind,
    locked: item.locked,
    entries: [],
    swatch: null,
    value: null,
    tag: item.kind,
  }));
  const rowOf = new Map(document.items.map((item, index) => [item.id, index]));
  const loose: SceneRow = {
    id: UNASSIGNED,
    label: "Unassigned",
    kind: "loose",
    locked: false,
    entries: [],
    swatch: null,
    value: null,
    tag: "loose",
  };
  const byteRow = new Int32Array(compiled.bytes.length).fill(-1);
  compiled.spans.forEach((span, k) => {
    const index = rowOf.get(pictureItemAtLine(document, span.line)?.id ?? "") ?? rows.length;
    byteRow.fill(index, span.start, span.end);
    // The closing `end` draws nothing, so no row lists it.
    if (k < commands) (rows[index] ?? loose).entries.push(k);
  });
  if (loose.entries.length > 0) rows.push(loose);

  const counts = PLANES.map(() => rows.map(() => new Uint32Array(16)));
  PLANES.forEach((plane, p) => {
    const owners = compiled.owners[plane];
    const values = compiled[plane];
    for (let i = 0; i < owners.length; i++) {
      const owner = owners[i]!;
      if (owner < 0) continue;
      const row = byteRow[owner]!;
      if (row >= 0 && row < rows.length) counts[p]![row]![values[i]! & 0x0f]!++;
    }
  });
  rows.forEach((row, r) => {
    const primary = row.kind === "depth" || row.kind === "walk" ? 1 : 0;
    const own = dominant(counts[primary]![r]!);
    row.value = own;
    // A control value shows in its Walk lens colour, as on the canvas.
    row.swatch =
      own === null
        ? dominant(counts[1 - primary]![r]!)
        : primary === 1 && own < 4
          ? CONTROL_VALUES[own]!.colour
          : own;
    row.tag = tagFor(
      row.kind,
      row.entries.map((k) => timeline[k]!),
    );
  });
  const branches = branchesOf(rows.filter((row) => row.id !== UNASSIGNED));
  const groups = branches.flatMap((branch) => (branch.group ? [branch.group] : []));
  const sections = sectionsOf(branches);
  return {
    source,
    trusted,
    document,
    diagnostics,
    compiled,
    timeline,
    commands,
    rows,
    branches,
    groups,
    sections,
    folds: [...groups, ...sections],
    byteRow,
    profile,
  };
}

export interface SceneFilter {
  /** Items matching the filter, flat; null while it is empty (the list shows its groups). */
  matches: SceneRow[] | null;
  /** The Unassigned row, when there is one and it matches. */
  loose: SceneRow | undefined;
  /** The rows the canvas arrows step through, in draw order. */
  steps: SceneRow[];
}

/** Narrow the Scene list by label, id, tag, kind or group label ("brown" finds a group's members). */
export function filterScene(
  model: Pick<StudioModel, "rows" | "groups">,
  filter: string,
): SceneFilter {
  const needle = filter.trim().toLowerCase();
  const groupLabels = new Map<string, string>();
  for (const group of model.groups)
    for (const id of group.members) groupLabels.set(id, group.label);
  const matching = (row: SceneRow): boolean =>
    needle === "" ||
    [row.label, row.id, row.tag, row.kind, groupLabels.get(row.id) ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    );
  const items = model.rows.filter((row) => row.id !== UNASSIGNED);
  const matches = needle === "" ? null : items.filter(matching);
  const loose = model.rows.find((row) => row.id === UNASSIGNED && matching(row));
  return { matches, loose, steps: [...(matches ?? items), ...(loose ? [loose] : [])] };
}

/** The plane a row's pixels are highlighted on under `lens`. */
export function rowPlane(row: Pick<SceneRow, "kind">, lens: StudioLens): PicturePlane {
  if (row.kind === "art") return "visual";
  if (row.kind === "depth" || row.kind === "walk") return "priority";
  return lens === "art" ? "visual" : "priority";
}

/** The plane the canvas is read from under `lens`, and the fallback. */
export function lensPlanes(lens: StudioLens): readonly [PicturePlane, PicturePlane] {
  return lens === "art" ? ["visual", "priority"] : ["priority", "visual"];
}

export interface PlanePixel {
  value: number;
  /** Timeline index of the command that last wrote the cell, or null. */
  entry: number | null;
  line: number | null;
  text: string | null;
  rowId: string | undefined;
}

export interface PixelInfo {
  x: number;
  y: number;
  visual: PlanePixel;
  priority: PlanePixel;
}

/** A compiled document whose surface and owners are the picture drawn up to `count` commands. */
function partialCompiled(
  model: StudioModel,
  count: number,
  surface: { visual: Uint8Array; priority: Uint8Array },
): CompiledPictureDocument {
  const { compiled, profile } = model;
  const end = count === 0 ? 0 : compiled.spans[count - 1]!.end;
  const bytes = new Uint8Array(end + 1);
  bytes.set(compiled.bytes.subarray(0, end));
  bytes[end] = 0xff;
  const cells = SCREEN_WIDTH * SCREEN_HEIGHT;
  const owners = { visual: new Int32Array(cells), priority: new Int32Array(cells) };
  renderPicture(bytes, createPictureSurface(), { profile, owner: owners });
  return { ...compiled, owners, visual: surface.visual, priority: surface.priority };
}

export function useStudioDocument(source: MaybeRefOrGetter<StudioSource | ResolvedStudioSource>) {
  const model = computed(() => buildStudioModel(toValue(source)));
  const total = computed(() => model.value.commands);
  /** Drawing commands drawn: 0..total; total shows the finished picture. An edit shows it all. */
  const playhead = ref(0);
  watch(model, (next) => (playhead.value = next.commands), { immediate: true });

  const surface = computed(() => {
    const k = Math.min(playhead.value, total.value);
    const { compiled, profile } = model.value;
    return k >= total.value ? compiled : renderUpTo(compiled, k, profile);
  });
  /** Ownership for the surface on screen; the partial owners are rendered only when asked. */
  const view = computed(() =>
    playhead.value >= total.value
      ? model.value.compiled
      : partialCompiled(model.value, playhead.value, surface.value),
  );

  /** Masks for the ownership on screen; replaced whenever that changes. */
  let masks = {
    of: undefined as CompiledPictureDocument | undefined,
    byKey: new Map<string, Uint8Array>(),
  };

  function maskFor(rowId: string, plane: PicturePlane): Uint8Array {
    if (masks.of !== view.value) masks = { of: view.value, byKey: new Map() };
    const key = `${plane}:${rowId}`;
    const cached = masks.byKey.get(key);
    if (cached) return cached;
    const { document, byteRow, rows } = model.value;
    let mask: Uint8Array;
    if (rowId === UNASSIGNED) {
      const index = rows.findIndex((row) => row.id === UNASSIGNED);
      const owners = view.value.owners[plane];
      mask = new Uint8Array(owners.length);
      for (let i = 0; i < owners.length; i++)
        if (owners[i]! >= 0 && byteRow[owners[i]!] === index) mask[i] = 1;
    } else {
      mask = itemMask(view.value, document, rowId, plane);
    }
    masks.byKey.set(key, mask);
    return mask;
  }

  /**
   * The highlight mask of a row under `lens`: its own plane, or for a mixed
   * or loose row whose pixels there were all overwritten, the other plane.
   * A group's or section's mask is the union of its members'.
   */
  function rowMask(rowId: string, lens: StudioLens): Uint8Array {
    const group = model.value.folds.find((candidate) => candidate.id === rowId);
    if (group) {
      const union = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
      for (const member of group.members) {
        const mask = rowMask(member, lens);
        for (let i = 0; i < union.length; i++) if (mask[i] === 1) union[i] = 1;
      }
      return union;
    }
    const row = model.value.rows.find((candidate) => candidate.id === rowId);
    if (!row) return new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    const plane = rowPlane(row, lens);
    const mask = maskFor(rowId, plane);
    if (row.kind !== "mixed" && row.kind !== "loose") return mask;
    return mask.includes(1) ? mask : maskFor(rowId, plane === "visual" ? "priority" : "visual");
  }

  /** The row that last wrote x,y on `plane`, if any. */
  function rowAt(x: number, y: number, plane: PicturePlane): string | undefined {
    const item = itemAt(view.value, model.value.document, x, y, plane);
    if (item) return item.id;
    const owner = view.value.owners[plane][y * SCREEN_WIDTH + x];
    if (owner === undefined || owner < 0) return undefined;
    return model.value.rows[model.value.byteRow[owner]!]?.id;
  }

  /** The row under x,y for `lens`: its own plane first, then the other. */
  function rowAtForLens(x: number, y: number, lens: StudioLens): string | undefined {
    const [first, second] = lensPlanes(lens);
    return rowAt(x, y, first) ?? rowAt(x, y, second);
  }

  function planePixel(x: number, y: number, plane: PicturePlane): PlanePixel {
    const index = y * SCREEN_WIDTH + x;
    const owner = view.value.owners[plane][index]!;
    const entry = owner < 0 ? -1 : spanIndexAt(view.value.spans, owner);
    const line = entry < 0 ? null : view.value.spans[entry]!.line;
    return {
      value: surface.value[plane][index]!,
      entry: entry < 0 ? null : entry,
      line,
      text: line === null ? null : pictureCommandText(model.value.document.lines[line - 1] ?? ""),
      rowId: rowAt(x, y, plane),
    };
  }

  function pixelInfo(x: number, y: number): PixelInfo {
    return { x, y, visual: planePixel(x, y, "visual"), priority: planePixel(x, y, "priority") };
  }

  /** whyNotFilled for x,y on the plane the fill at timeline index `entry` floods. */
  function explainFill(entry: number, x: number, y: number): FillExplanation | undefined {
    const command = model.value.timeline[entry];
    if (command?.op !== "fill") return undefined;
    const plane: PicturePlane = command.visual !== null ? "visual" : "priority";
    return whyNotFilled(model.value.compiled, x, y, plane);
  }

  return {
    model,
    total,
    playhead,
    surface,
    view,
    maskFor,
    rowMask,
    rowAt,
    rowAtForLens,
    pixelInfo,
    explainFill,
  };
}

export type StudioDocument = ReturnType<typeof useStudioDocument>;
