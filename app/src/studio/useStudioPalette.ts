import { computed, type Ref } from "vue";
import type { TimelineEntry } from "../../../src/studio/pictureQuery.ts";
import type { StudioEditing } from "./useStudioEditing.ts";
import { isDrawingTool, type CurrentValues, type StudioTool } from "./studioTools.ts";
import { tickFor, type StudioLens } from "./studioView.ts";

export const PALETTE_HINT = "Pick a drawing tool to paint, or select a shape to recolour it";
export type PaletteAction = "draw" | "recolour" | "hint";
export interface PaletteValues {
  readonly visual: number | null | undefined;
  readonly priority: number | null | "band" | undefined;
}

export function paletteContext(tool: StudioTool, lens: StudioLens, selected: boolean) {
  const action: PaletteAction = isDrawingTool(tool)
    ? "draw"
    : tool === "select" && selected
      ? "recolour"
      : "hint";
  return { action, lens };
}
export function useStudioPalette(options: {
  tool: Ref<StudioTool>;
  lens: Ref<StudioLens>;
  selected: () => boolean;
  timeline: () => readonly TimelineEntry[];
  editing: StudioEditing;
  current: Ref<CurrentValues>;
  setValues: (patch: Partial<CurrentValues>) => void;
  frozen: () => boolean;
}) {
  const context = computed(() =>
    paletteContext(options.tool.value, options.lens.value, options.selected()),
  );
  function drawn(itemId: string, plane: "visual" | "priority"): number[] {
    return options
      .timeline()
      .filter((entry) => entry.itemId === itemId && tickFor(entry).kind !== "state")
      .map((entry) => entry[plane])
      .filter((value): value is number => value !== null);
  }
  function single(plane: "visual" | "priority"): number | null | undefined {
    const values = new Set(options.editing.targets.value.flatMap((item) => drawn(item.id, plane)));
    return values.size === 0 ? null : values.size === 1 ? [...values][0] : undefined;
  }
  const values = computed<PaletteValues>(() =>
    context.value.action === "recolour"
      ? { visual: single("visual"), priority: single("priority") }
      : options.current.value,
  );
  function choose(patch: Partial<CurrentValues>): void {
    if (options.frozen() || context.value.action === "hint") return;
    if (context.value.action === "draw") {
      options.setValues(patch);
      return;
    }
    if (options.editing.targets.value.length === 0) {
      options.editing.say({ tone: "warn", text: "Select a shape in Items to recolour it." });
      return;
    }
    const lens = options.lens.value;
    const plane = lens === "art" ? "visual" : "priority";
    const value = patch[plane];
    if (value === undefined || value === "band") return;
    const missing = options.editing.targets.value.find(
      (item) =>
        !drawn(item.id, plane).some(
          (value) => lens === "art" || (lens === "depth" ? value >= 4 : value < 4),
        ),
    );
    if (missing) {
      const reason =
        lens === "art"
          ? "has no art colour. Select a shape with art to recolour it."
          : lens === "depth"
            ? "has no depth band. Add depth or select a shape with depth."
            : "has no walk line. Select a Wall, Gate, Trigger or Water shape.";
      options.editing.say({ tone: "warn", text: `${missing.label} ${reason}` });
      return;
    }
    options.editing.setColour(plane, value);
  }
  return { context, values, choose };
}
