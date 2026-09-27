// Dev and test entry for sprite-harness.html; not a production build input.
// `?view=N` (default 0) opens the tutorial's VIEW N in Sprite Studio, on the
// tutorial's real files: its rooms' pictures for the in-room preview and its
// logics for the usage. Keep succeeds in memory (each kept edit lands in
// `spriteHarness.kept`); `&keep=stale|install|storage` makes it refuse with
// that code instead; `&staged=1` opens the view as a staged character-sheet
// candidate. The sprite kernel is on `window.spriteHarness` so browser tests
// compute expectations independently.
import { createApp, h, ref } from "vue";
import "../../styles/tokens.css";
import SpriteStudio, { type SpriteKeepFn } from "./SpriteStudio.vue";
import { buildTutorial } from "../../../../games/adventure-department/game.ts";
import { requireResourceRevision } from "../../../../src/gameIdentity.ts";
import { DEFAULT_V2_PROFILE } from "../../../../src/runtime/profile.ts";
import { openSprite } from "../../../../src/view/spriteDocument.ts";
import { applySpriteEdit } from "../../../../src/studio/sprite/spriteOperations.ts";
import { parseView } from "../../../../src/view/view.ts";
import { authoringFingerprint } from "../../gameStorage.ts";
import { ResourceCommitError } from "../../projectTransaction.ts";
import type { ViewEdit } from "../../resourceCommit.ts";
import { studioSpriteSource } from "../../world/studioSource.ts";

const params = new URLSearchParams(location.search);
const viewNumber = Number(params.get("view") ?? "0");
const profile = DEFAULT_V2_PROFILE;
const tutorial = buildTutorial();
const source = studioSpriteSource({ files: tutorial.files, profile }, viewNumber, 1);
if (!source) throw new Error(`sprite harness: the tutorial has no VIEW ${viewNumber}`);
const revision = (n: number) => requireResourceRevision(n.toString(16).padStart(64, "0"));
const kept: { edit: ViewEdit; staged: string | undefined }[] = [];
const refusal = params.get("keep");
const closes = ref(0);
const reopens = ref(0);
const keep: SpriteKeepFn = async (edit, staged) => {
  if (refusal === "stale" || refusal === "install" || refusal === "storage")
    throw new ResourceCommitError(refusal, `The harness refuses with ${refusal}.`);
  kept.push({ edit, staged });
  return {
    status: "committed",
    projectId: null,
    revision: revision(kept.length + 1),
    authoring: authoringFingerprint(undefined),
  };
};

const probe = {
  viewNumber,
  bytes: [...source.bytes],
  kept,
  get closes(): number {
    return closes.value;
  },
  get reopens(): number {
    return reopens.value;
  },
  kernel: { openSprite, applySpriteEdit, parseView },
  profile,
};
export type SpriteHarnessProbe = typeof probe;
(window as Window & { spriteHarness?: SpriteHarnessProbe }).spriteHarness = probe;

createApp({
  render: () =>
    h(SpriteStudio, {
      viewNumber,
      bytes: source.bytes,
      profile,
      baseRevision: revision(1),
      keep,
      files: source.files,
      usage: source.usage,
      rooms: source.rooms,
      // The tutorial's logic 0 boots with v10 = 1.
      speed: 1,
      stagedReference: params.get("staged") === "1" ? "harness-staged" : undefined,
      onClose: () => closes.value++,
      onReopen: () => reopens.value++,
    }),
}).mount("#studio");
