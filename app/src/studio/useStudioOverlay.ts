/**
 * The canvas overlays Room Studio derives from its state: hover, selection
 * and refusal-flash outlines, point handles, band guides, control-line
 * labels and where the contextual toolbar sits above the selection.
 */
import { computed, type Ref } from "vue";
import { itemHandles, type LineHandle } from "../../../src/studio/editPoints.ts";
import type { PictureDocument } from "../../../src/studio/pictureDocument.ts";
import type { Viewport } from "../../../src/studio/viewport.ts";
import type { MaskPaths } from "./StudioCanvas.vue";
import {
  bandGuides,
  controlLabels,
  maskBox,
  maskFillPath,
  maskOutlinePath,
  type StudioLens,
} from "./studioView.ts";

/** More handles than this and only the inspector's points table edits them. */
const MAX_HANDLES = 160;

const pathsOf = (mask: Uint8Array | null): MaskPaths | null =>
  mask && { fill: maskFillPath(mask), outline: maskOutlinePath(mask) };

export function useStudioOverlay(options: {
  lens: Readonly<Ref<StudioLens>>;
  showBands: Readonly<Ref<boolean>>;
  viewport: Readonly<Ref<Viewport>>;
  priority: () => Uint8Array;
  hoveredId: Readonly<Ref<string | undefined>>;
  hoverMask: (id: string) => Uint8Array | null;
  selectionMask: Readonly<Ref<Uint8Array | null>>;
  flash: Readonly<Ref<Uint8Array | null>>;
  editableId: Readonly<Ref<string | undefined>>;
  document: () => PictureDocument;
  dragging: Readonly<Ref<boolean>>;
  drawing: Readonly<Ref<boolean>>;
}) {
  const { lens, showBands, viewport, hoveredId, selectionMask, editableId } = options;
  const hoverPaths = computed(() =>
    options.dragging.value || hoveredId.value === undefined
      ? null
      : pathsOf(options.hoverMask(hoveredId.value)),
  );
  const selectionPaths = computed(() => pathsOf(selectionMask.value));
  const flashPaths = computed(() => pathsOf(options.flash.value));
  const handleList = computed<readonly LineHandle[]>(() => {
    const id = editableId.value;
    return id === undefined ? [] : itemHandles(options.document(), id);
  });
  const handles = computed(() =>
    handleList.value.length > 0 && handleList.value.length <= MAX_HANDLES ? handleList.value : null,
  );
  const guides = computed(() => (showBands.value && lens.value !== "art" ? bandGuides() : null));
  const labels = computed(() => (lens.value === "walk" ? controlLabels(options.priority()) : null));
  /** The contextual toolbar sits above the selection (below it near the top), inside the pane. */
  const ctxAt = computed(() => {
    const mask = selectionMask.value;
    const hidden =
      editableId.value === undefined || options.dragging.value || !mask || options.drawing.value;
    const box = hidden ? null : maskBox(mask);
    if (!box) return null;
    const { zoom: z, pixelAspect } = viewport.value;
    const above = box.y * z - 44;
    return {
      left: `${Math.max(0, Math.min(box.x * pixelAspect * z, 160 * pixelAspect * z - 360))}px`,
      top: `${above >= 4 ? above : (box.y + box.height) * z + 8}px`,
    };
  });
  return { hoverPaths, selectionPaths, flashPaths, handleList, handles, guides, labels, ctxAt };
}
