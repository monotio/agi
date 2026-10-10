<script setup lang="ts">
import { documentLabel } from "../../../src/logic/numberedLabels.ts";
import { projectLabelContext } from "../shell/projectLabelContext.ts";
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
import { parseView, selectViewCel } from "../../../src/view/view.ts";
import { EGA_RGB } from "../../../src/picture/png.ts";
import { renderSoundPreview } from "../../../src/sound/preview.ts";
import { disassembleLogic } from "../../../src/logic/disassembler.ts";
import { parseGameTests } from "../../../src/agent/gameTestFormat.ts";
import { readInventoryObjects } from "../../../src/authoring/inventory.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import UiButton from "../ui/UiButton.vue";
const props = defineProps<{
  documentKey: string;
  before: ProjectContent | undefined;
  beforeDocuments: Readonly<Record<string, ProjectContent>>;
  afterDocuments: Readonly<Record<string, ProjectContent>>;
  after: ProjectContent | null;
  beforeImage: GameContainer | undefined;
  afterImage: GameContainer | undefined;
  profile: AgiProfile;
  navigation?: boolean;
  inspection?: boolean;
}>();
defineEmits<{ open: [target: { resource: string; loop: number; cel: number }] }>();
const launchChanges = computed(() => {
  if (props.after !== null || !props.documentKey.startsWith("logic:")) return [];
  const worldText = props.beforeDocuments["world"];
  if (typeof worldText !== "string") return [];
  const world = JSON.parse(worldText) as { launches?: unknown };
  return launchRemovalMessages(
    world.launches === undefined ? undefined : readWorldLaunches(world.launches),
    new Set([props.documentKey]),
    projectLabelContext(props.beforeDocuments, props.profile),
  );
});
const CodeDiff = defineAsyncComponent(() => import("../studio/logic/AgentCodeDiff.vue"));
const SoundPreview = defineAsyncComponent(() => import("../authoring/SoundPreview.vue"));
const sides = computed(() =>
  props.inspection
    ? [{ image: props.afterImage, index: 1 }]
    : [
        { image: props.beforeImage, index: 0 },
        { image: props.afterImage, index: 1 },
      ],
);
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
    if (kind !== "picture") return [];
    return sides.value
      .filter(({ image }) => image !== undefined)
      .map(({ image, index }) => {
        const label = `${documentLabel(target, projectLabelContext(index ? props.afterDocuments : props.beforeDocuments, props.profile))} ${index ? "After" : "Before"}`;
        const bytes = image?.getResource(kind, Number(num));
        const surface = createPictureSurface();
        if (bytes) renderPicture(bytes, surface, { profile: props.profile });
        const png = encodePngRgba(
          320,
          168,
          pictureReviewPixels(
            surface.visual,
            index ? props.afterDocuments : props.beforeDocuments,
            target,
          ),
        );
        return {
          label,
          caption: props.inspection ? "Preview" : index ? "After" : "Before",
          url: dataUrl(png, "image/png"),
        };
      });
  });
});
const views = computed(() => {
  const targets =
    props.documentKey === "images"
      ? imageReviewTargets(props.beforeDocuments, props.afterDocuments)
      : [props.documentKey];
  return targets
    .filter((target) => target.startsWith("view:"))
    .flatMap((target) =>
      sides.value
        .filter(({ image }) => image !== undefined)
        .map(({ image, index }) => {
          const bytes = image?.getResource("view", Number(target.split(":")[1]));
          const label = `${documentLabel(target, projectLabelContext(index ? props.afterDocuments : props.beforeDocuments, props.profile))} ${index ? "After" : "Before"}`;
          if (!bytes) return { label, resource: target, after: index === 1, loops: [] };
          const view = parseView(bytes, props.profile);
          return {
            label,
            resource: target,
            after: index === 1,
            loops: view.loops.map((loop, loopIndex) => ({
              index: loopIndex,
              cels: loop.cels.map((_cel, celIndex) => {
                const cel = selectViewCel(view, loopIndex, celIndex)!;
                const rgba = new Uint8Array(cel.width * 2 * cel.height * 4);
                for (let y = 0; y < cel.height; y++)
                  for (let x = 0; x < cel.width * 2; x++) {
                    const color = cel.pixels[y * cel.width + Math.floor(x / 2)]!;
                    const offset = (y * cel.width * 2 + x) * 4;
                    rgba.set(EGA_RGB[color]!, offset);
                    rgba[offset + 3] = color === cel.transparentColor ? 0 : 255;
                  }
                return {
                  index: celIndex,
                  url: dataUrl(encodePngRgba(cel.width * 2, cel.height, rgba), "image/png"),
                };
              }),
            })),
          };
        }),
    );
});
const sounds = computed(() => {
  if (!props.documentKey.startsWith("sound:")) return [];
  return sides.value
    .filter(({ image }) => image !== undefined)
    .map(({ image, index }) => {
      const bytes = image?.getResource("sound", Number(props.documentKey.split(":")[1]));
      return {
        caption: `${documentLabel(props.documentKey, projectLabelContext(index ? props.afterDocuments : props.beforeDocuments, props.profile))}${props.inspection ? "" : index ? " After" : " Before"}`,
        url: bytes ? dataUrl(renderSoundPreview(bytes, props.profile).wav, "audio/wav") : "",
      };
    });
});
const source = computed(() => {
  if (!props.inspection) return undefined;
  if (typeof props.after === "string") return props.after;
  if (!(props.after instanceof Uint8Array) || !props.documentKey.startsWith("logic:"))
    return undefined;
  const words = props.afterDocuments["words"];
  let dictionary: Map<string, number> | undefined;
  try {
    dictionary = new Map(
      typeof words === "string"
        ? (JSON.parse(words) as [string, number][])
        : words
          ? parseWordsTok(words).map(({ word, id }) => [word, id])
          : [],
    );
  } catch {
    /* Numeric word identities remain available. */
  }
  return disassembleLogic(props.after, {
    profile: props.profile,
    ...(dictionary ? { dictionary } : {}),
  });
});
const tests = computed(() => {
  if (props.documentKey !== "tests") return [];
  return sides.value.map(({ index }) => {
    const content = index ? props.after : props.before;
    return {
      label: props.inspection ? "Tests" : index ? "After" : "Before",
      tests: parseGameTests(
        typeof content === "string" ? new TextEncoder().encode(content) : (content ?? undefined),
        props.profile,
      ).tests,
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
  <template v-if="images.length || views.length">
    <div v-if="images.length" class="agent-art-review" data-testid="agent-art-review">
      <figure v-for="image in images" :key="image.label">
        <figcaption>{{ image.caption }}</figcaption>
        <img v-if="image.url" :src="image.url" :alt="`${documentKey} ${image.label}`" /><span v-else
          >Empty</span
        >
      </figure>
    </div>
    <div v-if="views.length" class="agent-view-review" data-testid="agent-view-review">
      <section v-for="view in views" :key="view.label">
        <h4>{{ view.label }}</h4>
        <details v-for="loop in view.loops" :key="loop.index" :open="loop.index === 0">
          <summary>Loop {{ loop.index }} · {{ loop.cels.length }} cels</summary>
          <div class="agent-view-review__cels">
            <figure v-for="cel in loop.cels" :key="cel.index">
              <img :src="cel.url" :alt="`${view.label}, loop ${loop.index}, cel ${cel.index}`" />
              <figcaption>Cel {{ cel.index }}</figcaption>
              <UiButton
                v-if="navigation && view.after"
                size="sm"
                variant="ghost"
                @click="
                  $emit('open', { resource: view.resource, loop: loop.index, cel: cel.index })
                "
                >Open current cel</UiButton
              >
            </figure>
          </div>
        </details>
        <p v-if="!view.loops.length">Empty</p>
      </section>
    </div>
  </template>
  <SoundPreview
    v-else-if="sounds.length"
    :audio="sounds.filter((sound) => sound.url)"
    class="agent-sound-review"
  />
  <div v-else-if="tests.length" class="agent-tests-review" data-testid="agent-tests-review">
    <section v-for="side in tests" :key="side.label">
      <h4>{{ side.label }}</h4>
      <table v-if="side.tests.length">
        <thead>
          <tr>
            <th>Test</th>
            <th>Room</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="test in side.tests" :key="test.name">
            <td>{{ test.name }}</td>
            <td>{{ test.room }}</td>
            <td>{{ test.steps.length }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else>Empty</p>
    </section>
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
  <pre v-else-if="source !== undefined" class="agent-source-preview">{{ source }}</pre>
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
.agent-tests-review table {
  width: 100%;
  font-size: var(--text-xs);
  border-collapse: collapse;
}
.agent-tests-review th,
.agent-tests-review td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--hairline);
  text-align: left;
}
.agent-source-preview {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--text-xs);
}
.agent-view-review__cels {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-3) 0;
}
.agent-view-review__cels figure {
  margin: 0;
}
.agent-view-review__cels img {
  image-rendering: pixelated;
  max-width: 100%;
  min-width: 40px;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-0) 0% 50%) 0 / 8px 8px;
}
.agent-view-review summary {
  cursor: pointer;
  font-size: var(--text-xs);
}
.agent-view-review figcaption {
  color: var(--muted);
  font-size: var(--text-xs);
}
</style>
