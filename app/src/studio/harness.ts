// Dev and test entry for studio-harness.html; not a production build input.
// `?pic=1|2|3` opens the tutorial's scene art, `?pic=demo` (the default) the
// annotated demo picture, `?pic=injected` the source or bytes a test or script
// set on `window.studioHarnessInput` before the page loads (for pictures that
// are generated or held privately); `&authored=0` withholds the source so the
// studio falls back to disassembling the bytes. `&probe=1` mounts the ghost
// actor probe alone over the picture's art pane, with the tutorial's
// character VIEWs as its game (the full studio gets the same VIEWs for its
// probe). The kernel is exposed on
// `window.studioHarness` so browser tests compute expectations independently.
// Keep succeeds in memory (each kept edit lands in `studioHarness.kept`);
// `&keep=stale|install|storage` makes it refuse with that code instead.
import { createApp, defineComponent, h, ref } from "vue";
import "../styles/tokens.css";
import RoomStudio from "./RoomStudio.vue";
import { EGA_PALETTE } from "../palette.ts";
import { ORIGINAL_SCENE_PICTURES } from "../../../games/adventure-department/sceneArt.ts";
import { compilePictureSource, disassemblePicture } from "../../../src/picture/source.ts";
import { requireResourceRevision } from "../../../src/gameIdentity.ts";
import { DEFAULT_V2_PROFILE } from "../../../src/runtime/profile.ts";
import { ResourceCommitError, type PictureEdit } from "../resourceCommit.ts";
import { inferNativeItems } from "../../../src/studio/nativeItems.ts";
import { parsePictureDocument } from "../../../src/studio/pictureDocument.ts";
import { compileDocument, itemAt, itemMask, renderUpTo } from "../../../src/studio/pictureQuery.ts";
import { toScreen, type Viewport } from "../../../src/studio/viewport.ts";
import { containerFromResources } from "../../../src/container/container.ts";
import { renderPicture } from "../../../src/picture/renderer.ts";
import { probeActor } from "../../../src/studio/probe.ts";
import { createPictureSurface } from "../../../src/types.ts";
import { buildView, parseView, selectViewCel } from "../../../src/view/view.ts";
import { CHARACTER_VIEWS } from "../../../games/adventure-department/characterViews.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import GhostProbe from "./GhostProbe.vue";
import StudioCanvas from "./StudioCanvas.vue";
import { listGameViews, useGhostProbe } from "./useGhostProbe.ts";
import { DEMO_PICTURE_SOURCE } from "./demoPicture.ts";

const TITLES: Readonly<Record<string, string>> = {
  "1": "Picture Gallery",
  "2": "Sprite Lab",
  "3": "Priority Archive",
  demo: "Studio demo",
  injected: "Injected picture",
};

/** What `?pic=injected` shows: authored source, or stored bytes to disassemble. */
export interface StudioHarnessInput {
  source?: string;
  bytes?: number[];
  pictureNumber?: number;
}

const params = new URLSearchParams(location.search);
const pic = params.get("pic") ?? "demo";
const input =
  pic === "injected"
    ? (window as Window & { studioHarnessInput?: StudioHarnessInput }).studioHarnessInput
    : undefined;
const profile = DEFAULT_V2_PROFILE;
const written =
  pic === "demo"
    ? DEMO_PICTURE_SOURCE
    : pic === "injected"
      ? (input?.source ?? disassemblePicture(new Uint8Array(input?.bytes ?? []), { profile }))
      : ORIGINAL_SCENE_PICTURES[Number(pic)];
if (written === undefined) throw new Error(`studio harness: unknown ?pic=${pic}`);
const bytes = input?.bytes
  ? new Uint8Array(input.bytes)
  : compilePictureSource(written, { profile }).bytes;
const authored =
  params.get("authored") !== "0" && (pic !== "injected" || input?.source !== undefined);
/** What Studio models: the written text, or with `&authored=0` the bytes as an import disassembles them. */
const source = authored ? written : disassemblePicture(bytes, { profile });
const pictureNumber =
  pic === "demo" ? 0 : pic === "injected" ? (input?.pictureNumber ?? 0) : Number(pic);
const closes = ref(0);
const probeMode = params.get("probe") === "1";
/** The probe's game: the tutorial's character VIEWs, as container files. */
const ghostViewBytes = new Map(
  Object.entries(CHARACTER_VIEWS).map(([n, input]) => [Number(n), buildView(input)] as const),
);
const ghostFiles = containerFromResources({ view: ghostViewBytes }).files;
const reopens = ref(0);
const kept: PictureEdit[] = [];
const refusal = params.get("keep");
const revision = (n: number) => requireResourceRevision(n.toString(16).padStart(64, "0"));
async function keep(edit: PictureEdit) {
  if (refusal === "stale" || refusal === "install" || refusal === "storage")
    throw new ResourceCommitError(refusal, `The harness refuses with ${refusal}.`);
  kept.push(edit);
  return { status: "committed" as const, projectId: null, revision: revision(kept.length + 1) };
}

const probe = {
  pic,
  source,
  bytes,
  profile,
  authored,
  get closes(): number {
    return closes.value;
  },
  get reopens(): number {
    return reopens.value;
  },
  kept,
  kernel: {
    compilePictureSource,
    disassemblePicture,
    inferNativeItems,
    parsePictureDocument,
    compileDocument,
    itemAt,
    itemMask,
    renderUpTo,
    toScreen,
    probeActor,
    parseView,
    selectViewCel,
  },
  /** The probe harness's VIEW payloads by number, for in-page expectations. */
  ghostViews: Object.fromEntries([...ghostViewBytes].map(([n, b]) => [n, [...b]])),
  palette: EGA_PALETTE,
};
export type StudioHarnessProbe = typeof probe;
(window as Window & { studioHarness?: StudioHarnessProbe }).studioHarness = probe;

/** `&probe=1`: the art pane at zoom 3 with the ghost probe over it, active. */
const ProbeHarness = defineComponent(() => {
  const annotated = inferNativeItems(source, { profile });
  const { document } = parsePictureDocument(annotated);
  const compiled = compileDocument(document, profile);
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile });
  const viewport: Viewport = { zoom: 3, pixelAspect: 2, offsetX: 0, offsetY: 0 };
  const ghost = useGhostProbe({
    views: listGameViews(ghostFiles, profile),
    picture: surface,
    profile,
  });
  ghost.active.value = true;
  ghost.moveTo(60, 100);
  const describeCell = (x: number, y: number): string | undefined =>
    itemAt(compiled, document, x, y, "priority")?.label;
  const onKeydown = (event: KeyboardEvent): void => {
    if (!event.defaultPrevented) ghost.handleStudioKey(event);
  };
  return () =>
    h("div", { class: "probe-harness", tabindex: -1, onKeydown }, [
      h(UiIconButton, {
        icon: "actor",
        label: "Ghost actor probe",
        shortcut: "G",
        pressed: ghost.active.value,
        "data-testid": "ghost-probe-toggle",
        onClick: ghost.toggle,
      }),
      h("div", { style: { position: "relative", width: "fit-content" } }, [
        h(StudioCanvas, {
          layer: "art",
          label: "Picture, visual plane",
          visual: surface.visual,
          priority: surface.priority,
          viewport,
          dpr: globalThis.devicePixelRatio || 1,
        }),
        h(GhostProbe, { probe: ghost, viewport, describeCell }),
      ]),
    ]);
});

createApp({
  render: () =>
    probeMode
      ? h(ProbeHarness)
      : h(RoomStudio, {
          pictureNumber,
          bytes,
          authoredSource: authored ? source : undefined,
          profile,
          title: TITLES[pic] ?? `Picture ${pic}`,
          subtitle:
            pic === "demo" ? "demo · shapes" : pic === "injected" ? "" : `room ${pic} · PIC ${pic}`,
          baseRevision: revision(1),
          keep,
          files: ghostFiles,
          onClose: () => closes.value++,
          onReopen: () => reopens.value++,
        }),
}).mount("#studio");
