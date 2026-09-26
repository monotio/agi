// Dev and test entry for studio-harness.html; not a production build input.
// `?pic=1|2|3` opens the tutorial's scene art, `?pic=demo` (the default) the
// annotated demo picture, `?pic=injected` the source or bytes a test or script
// set on `window.studioHarnessInput` before the page loads (for pictures that
// are generated or held privately); `&authored=0` withholds the source so the
// studio falls back to disassembling the bytes. The kernel is exposed on
// `window.studioHarness` so browser tests compute expectations independently.
import { createApp, h, ref } from "vue";
import "../styles/tokens.css";
import RoomStudio from "./RoomStudio.vue";
import { EGA_PALETTE } from "../palette.ts";
import { ORIGINAL_SCENE_PICTURES } from "../../../games/adventure-department/sceneArt.ts";
import { compilePictureSource, disassemblePicture } from "../../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../../src/runtime/profile.ts";
import { inferNativeItems } from "../../../src/studio/nativeItems.ts";
import { parsePictureDocument } from "../../../src/studio/pictureDocument.ts";
import { compileDocument, itemAt, itemMask, renderUpTo } from "../../../src/studio/pictureQuery.ts";
import { toScreen } from "../../../src/studio/viewport.ts";
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
const source =
  pic === "demo"
    ? DEMO_PICTURE_SOURCE
    : pic === "injected"
      ? (input?.source ?? disassemblePicture(new Uint8Array(input?.bytes ?? []), { profile }))
      : ORIGINAL_SCENE_PICTURES[Number(pic)];
if (source === undefined) throw new Error(`studio harness: unknown ?pic=${pic}`);
const bytes = input?.bytes
  ? new Uint8Array(input.bytes)
  : compilePictureSource(source, { profile }).bytes;
const authored =
  params.get("authored") !== "0" && (pic !== "injected" || input?.source !== undefined);
const pictureNumber =
  pic === "demo" ? 0 : pic === "injected" ? (input?.pictureNumber ?? 0) : Number(pic);
const closes = ref(0);

const probe = {
  pic,
  source,
  bytes,
  profile,
  authored,
  get closes(): number {
    return closes.value;
  },
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
  },
  palette: EGA_PALETTE,
};
export type StudioHarnessProbe = typeof probe;
(window as Window & { studioHarness?: StudioHarnessProbe }).studioHarness = probe;

createApp({
  render: () =>
    h(RoomStudio, {
      pictureNumber,
      bytes,
      authoredSource: authored ? source : undefined,
      profile,
      title: TITLES[pic] ?? `Picture ${pic}`,
      subtitle:
        pic === "demo" ? "demo · shapes" : pic === "injected" ? "" : `room ${pic} · PIC ${pic}`,
      onClose: () => closes.value++,
    }),
}).mount("#studio");
