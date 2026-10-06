// Dev and test entry for sprite-harness.html; not a production build input.
// `?view=N` (default 0) opens the tutorial's VIEW N in the VIEW editor, on
// the tutorial's real files: its rooms' pictures for the in-room preview and
// its logics for the usage. `&staged=1` opens the view as a staged
// character-sheet candidate; `&rooms=N` says rooms 1 to N use the view (a
// long usage). The sprite kernel is on `window.spriteHarness` so browser
// tests compute expectations independently.
import { createApp, h } from "vue";
import "../../styles/tokens.css";
import SpriteStudio from "./SpriteStudio.vue";
import { buildTutorial } from "../../../../games/adventure-department/game.ts";
import { requireResourceRevision } from "../../../../src/gameIdentity.ts";
import { DEFAULT_V2_PROFILE } from "../../../../src/runtime/profile.ts";
import { openSprite } from "../../../../src/view/spriteDocument.ts";
import { applySpriteEdit } from "../../../../src/studio/sprite/spriteOperations.ts";
import { parseView } from "../../../../src/view/view.ts";
import { studioSpriteSource } from "../../world/studioSource.ts";

const params = new URLSearchParams(location.search);
const viewNumber = Number(params.get("view") ?? "0");
const profile = DEFAULT_V2_PROFILE;
const tutorial = buildTutorial();
const source = studioSpriteSource({ files: tutorial.files, profile }, viewNumber, 1);
if (!source) throw new Error(`actor harness: the tutorial has no VIEW ${viewNumber}`);
const revision = (n: number) => requireResourceRevision(n.toString(16).padStart(64, "0"));
const usedBy = Number(params.get("rooms") ?? "0");
const usage =
  usedBy > 0
    ? { ...source.usage, rooms: Array.from({ length: usedBy }, (_, k) => k + 1) }
    : source.usage;

const probe = {
  viewNumber,
  bytes: [...source.bytes],
  kernel: { openSprite, applySpriteEdit, parseView },
  profile,
};
export type SpriteHarnessProbe = typeof probe;
(window as Window & { spriteHarness?: SpriteHarnessProbe }).spriteHarness = probe;

createApp({
  render: () =>
    h(SpriteStudio, {
      embedded: true,
      viewNumber,
      bytes: source.bytes,
      profile,
      baseRevision: revision(1),
      files: source.files,
      usage,
      rooms: source.rooms,
      // The tutorial's logic 0 boots with v10 = 1.
      speed: 1,
      stagedReference: params.get("staged") === "1" ? "harness-staged" : undefined,
    }),
}).mount("#studio");
