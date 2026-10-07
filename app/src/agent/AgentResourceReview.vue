<script setup lang="ts">
import { launchRemovalMessages } from "../../../src/authoring/projectRemoval.ts";
import { readWorldLaunches } from "../../../src/authoring/launches.ts";
import { computed, defineAsyncComponent } from "vue";
import { createPictureSurface } from "../../../src/types.ts";
import type { GameContainer } from "../../../src/types.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { renderPicture } from "../../../src/picture/renderer.ts";
import { encodePngRgba } from "../../../src/creative/composite.ts";
import { imageReviewTargets, pictureReviewPixels } from "./workspaceImageReview.ts";
import { viewFeedback } from "../../../src/agent/viewFeedback.ts";
import { renderSoundPreview } from "../../../src/sound/preview.ts";
import { readInventoryObjects } from "../../../src/authoring/inventory.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
const props = defineProps<{
  documentKey: string;
  before: ProjectContent | undefined;
  beforeDocuments: Readonly<Record<string, ProjectContent>>;
  afterDocuments: Readonly<Record<string, ProjectContent>>;
  after: ProjectContent | null;
  beforeImage: GameContainer;
  afterImage: GameContainer;
  profile: AgiProfile;
}>();
const launchChanges = computed(() => {
  if (props.after !== null || !props.documentKey.startsWith("logic:")) return [];
  const worldText = props.beforeDocuments["world"];
  if (typeof worldText !== "string") return [];
  const world = JSON.parse(worldText) as { launches?: unknown };
  return launchRemovalMessages(
    world.launches === undefined ? undefined : readWorldLaunches(world.launches),
    new Set([props.documentKey]),
  );
});
const CodeDiff = defineAsyncComponent(() => import("../studio/logic/AgentCodeDiff.vue"));
function dataUrl(bytes: Uint8Array, mime: string): string {
  let data = "";
  for (const byte of bytes) data += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(data)}`;
}
const images = computed(() => {
  const targets =
    props.documentKey === "images"
      ? imageReviewTargets(props.beforeDocuments, props.afterDocuments)
      : [props.documentKey];
  return targets.flatMap((target) => {
    const [kind, num] = target.split(":");
    if (kind !== "picture" && kind !== "view") return [];
    return [props.beforeImage, props.afterImage].map((image, index) => {
      const label = `${target.replace(":", " ").toUpperCase()} ${index ? "After" : "Before"}`;
      const bytes = image.getResource(kind, Number(num));
      if (!bytes && kind === "view") return { label, url: "" };
      const surface = createPictureSurface();
      if (kind === "picture" && bytes) renderPicture(bytes, surface, { profile: props.profile });
      const png =
        kind === "picture"
          ? encodePngRgba(
              320,
              168,
              pictureReviewPixels(
                surface.visual,
                index ? props.afterDocuments : props.beforeDocuments,
                target,
              ),
            )
          : viewFeedback(bytes!, props.profile, Number(num)).png;
      return { label, url: dataUrl(png, "image/png") };
    });
  });
});
const sounds = computed(() => {
  if (!props.documentKey.startsWith("sound:")) return [];
  return [props.beforeImage, props.afterImage].map((image, index) => {
    const bytes = image.getResource("sound", Number(props.documentKey.split(":")[1]));
    return {
      label: index ? "After" : "Before",
      url: bytes ? dataUrl(renderSoundPreview(bytes, props.profile).wav, "audio/wav") : "",
    };
  });
});
function entries(content: ProjectContent | null | undefined): string[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    try {
      const value: unknown = JSON.parse(content);
      if (Array.isArray(value)) return value.map((entry) => JSON.stringify(entry));
    } catch {
      /* Source diff remains available. */
    }
    return content.split("\n");
  }
  if (props.documentKey === "words")
    return parseWordsTok(content).map(({ word, id }) => JSON.stringify([word, id]));
  if (props.documentKey === "inventory")
    return readInventoryObjects(content, props.profile).map((entry) => JSON.stringify(entry));
  return [`${content.byteLength} bytes`];
}
const beforeBytes = computed(() => (props.before instanceof Uint8Array ? props.before.length : 0));
const afterBytes = computed(() => (props.after instanceof Uint8Array ? props.after.length : 0));
const added = computed(() =>
  entries(props.after).filter((entry) => !entries(props.before).includes(entry)),
);
const removed = computed(() =>
  entries(props.before).filter((entry) => !entries(props.after).includes(entry)),
);
</script>
<template>
  <p v-for="message in launchChanges" :key="message" data-testid="launch-removal-change">
    {{ message }}
  </p>
  <div v-if="images.length" class="agent-art-review" data-testid="agent-art-review">
    <figure v-for="image in images" :key="image.label">
      <figcaption>{{ image.label }}</figcaption>
      <img v-if="image.url" :src="image.url" :alt="`${documentKey} ${image.label}`" /><span v-else
        >Empty</span
      >
    </figure>
  </div>
  <div v-else-if="sounds.length" class="agent-sound-review">
    <label v-for="sound in sounds" :key="sound.label"
      >{{ sound.label }}<audio v-if="sound.url" :src="sound.url" controls preload="metadata"></audio
      ><span v-else>Empty</span></label
    >
  </div>
  <div
    v-else-if="documentKey === 'words' || documentKey === 'inventory'"
    class="agent-entry-review"
  >
    <pre v-for="entry in removed" :key="`removed-${entry}`" class="agent-entry-review__removed">
− {{ entry }}</pre>
    <pre v-for="entry in added" :key="`added-${entry}`" class="agent-entry-review__added">
+ {{ entry }}</pre>
  </div>
  <CodeDiff
    v-else-if="typeof before === 'string' || typeof after === 'string'"
    :before="typeof before === 'string' ? before : ''"
    :after="typeof after === 'string' ? after : ''"
  />
  <p v-else>{{ beforeBytes }} → {{ afterBytes }} bytes</p>
</template>
<style scoped>
.agent-art-review {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.agent-art-review figure {
  margin: 0;
  min-width: 0;
}
.agent-art-review img {
  width: 100%;
  image-rendering: pixelated;
}
.agent-art-review figcaption {
  color: var(--muted);
  font-size: var(--text-xs);
  margin-bottom: var(--space-2);
}
.agent-entry-review pre {
  white-space: pre-wrap;
  font-size: var(--text-xs);
}
.agent-entry-review__added {
  color: var(--accent);
}
.agent-entry-review__removed {
  color: var(--danger);
}
.agent-sound-review audio {
  width: 100%;
}
</style>
