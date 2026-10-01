<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, useId } from "vue";
import type { PictureSourceSpan } from "../../../../src/picture/source.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { TimelineEntry } from "../../../../src/studio/pictureQuery.ts";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiButton from "../../ui/UiButton.vue";
import UiDialog from "../../ui/UiDialog.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { clipType, recordClip } from "./renderClip.ts";
import { stillPng, type ShareCaption } from "./shareFrame.ts";

/**
 * Share in Room Studio's top bar, after the room's name: the picture painting itself as a clip
 * (renderClip.ts), or the finished picture as a still (shareFrame.ts), each
 * with its caption card. It shares the draft on the canvas, unkept changes
 * included, and says so. The file is previewed before it is downloaded or,
 * where the browser can share files (phones), handed to the system share.
 */
const { picture, timeline, profile, caption, fileBase } = defineProps<{
  /** The draft's compiled picture: its bytes and command spans, and the finished visual plane. */
  picture: { bytes: Uint8Array; spans: readonly PictureSourceSpan[]; visual: Uint8Array };
  timeline: readonly TimelineEntry[];
  profile: AgiProfile;
  caption: ShareCaption;
  /** The file name without extension, e.g. "adventure-department-room-2". */
  fileBase: string;
}>();

type Share =
  | { step: "painting"; progress: number; abort: AbortController }
  | { step: "ready"; kind: "clip" | "still"; file: File; url: string }
  | { step: "failed"; message: string };

const noteId = useId();
const type = clipType();
const share = shallowRef<Share | null>(null);
const open = computed({
  get: () => share.value !== null,
  set: (value) => {
    if (!value) close();
  },
});
const title = computed(() => {
  const current = share.value;
  if (current?.step === "ready") return current.kind === "clip" ? "Your clip" : "Your still";
  return current?.step === "failed" ? "No clip this time" : "Painting a clip";
});
const percent = computed(() =>
  share.value?.step === "painting" ? Math.floor(share.value.progress * 100) : 0,
);
const canShare = computed(() => {
  const current = share.value;
  if (current?.step !== "ready" || typeof navigator.canShare !== "function") return false;
  return navigator.canShare({ files: [current.file] });
});
const size = computed(() => {
  const current = share.value;
  if (current?.step !== "ready") return "";
  const kb = current.file.size / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
});

function close(): void {
  const current = share.value;
  if (current?.step === "painting") current.abort.abort();
  if (current?.step === "ready") URL.revokeObjectURL(current.url);
  share.value = null;
}

function ready(kind: "clip" | "still", file: File): void {
  close();
  share.value = { step: "ready", kind, file, url: URL.createObjectURL(file) };
}

async function still(): Promise<void> {
  const name = `${fileBase}.png`;
  const png = await stillPng(picture.visual, caption);
  ready("still", new File([png.slice()], name, { type: "image/png" }));
}

async function clip(): Promise<void> {
  if (!type) return;
  close();
  const abort = new AbortController();
  const painting = (): boolean =>
    share.value?.step === "painting" && share.value.abort === abort && !abort.signal.aborted;
  share.value = { step: "painting", progress: 0, abort };
  // The draft as it is now: Studio waits behind the dialog while it records.
  const source = { compiled: picture, timeline, profile, caption: { ...caption } };
  const name = `${fileBase}.${type.startsWith("video/mp4") ? "mp4" : "webm"}`;
  try {
    const blob = await recordClip(source, {
      type,
      signal: abort.signal,
      onProgress: (progress) => {
        if (painting()) share.value = { step: "painting", progress, abort };
      },
    });
    if (painting()) ready("clip", new File([blob], name, { type: blob.type }));
  } catch (error) {
    if (painting())
      share.value = {
        step: "failed",
        message: `Recording stopped: ${String(error).replace(/^\w*Error: /, "")}`,
      };
  }
}

function download(): void {
  const current = share.value;
  if (current?.step !== "ready") return;
  const link = document.createElement("a");
  link.href = current.url;
  link.download = current.file.name;
  link.click();
}

async function shareFile(): Promise<void> {
  const current = share.value;
  if (current?.step !== "ready") return;
  try {
    await navigator.share({ files: [current.file], title: caption.room });
  } catch {
    // Dismissed, or the system share refused the file: Download still works.
  }
}

onBeforeUnmount(close);
</script>

<template>
  <ActionMenu label="Share picture" test-id="studio-share" icon-only icon="share" size="sm">
    <div role="group" :aria-labelledby="noteId">
      <p :id="noteId" class="share-menu__note">
        Shares this draft as you see it, unkept changes included.
      </p>
      <button
        type="button"
        role="menuitem"
        data-testid="studio-share-clip"
        :disabled="!type"
        :title="type ? undefined : 'Video recording is unavailable in this browser'"
        @click="clip"
      >
        <UiIcon name="film" :size="18" />
        <span
          >Clip<small>{{
            type
              ? "The picture painting itself, in draw order, as video"
              : "Video recording is unavailable. Choose Still to share an image."
          }}</small></span
        >
      </button>
      <button type="button" role="menuitem" data-testid="studio-share-still" @click="still">
        <UiIcon name="image" :size="18" />
        <span>Still<small>The finished picture as a PNG</small></span>
      </button>
    </div>
  </ActionMenu>
  <Teleport to="body">
    <UiDialog v-model:open="open" :title size="sm" data-testid="studio-share-dialog">
      <template v-if="share?.step === 'painting'">
        <div
          class="share__bar"
          role="progressbar"
          aria-label="Clip recorded"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent"
        >
          <i :style="{ width: `${percent}%` }"></i>
        </div>
        <p class="share__status" data-testid="studio-share-progress">Painting {{ percent }}%…</p>
      </template>
      <template v-else-if="share?.step === 'ready'">
        <video
          v-if="share.kind === 'clip'"
          class="share__preview"
          :src="share.url"
          autoplay
          loop
          muted
          playsinline
          aria-label="The clip"
        ></video>
        <img v-else class="share__preview" :src="share.url" alt="The still" />
        <p class="share__status" data-testid="studio-share-file">
          {{ share.file.name }} · {{ size }}
        </p>
      </template>
      <p v-else-if="share?.step === 'failed'" class="share__status">{{ share.message }}</p>
      <template #footer>
        <UiButton
          v-if="share?.step === 'painting'"
          data-testid="studio-share-cancel"
          @click="close"
        >
          Cancel
        </UiButton>
        <template v-else-if="share?.step === 'ready'">
          <UiButton v-if="canShare" icon="share" @click="shareFile">Share…</UiButton>
          <UiButton
            variant="primary"
            icon="download"
            data-testid="studio-share-download"
            @click="download"
          >
            Download
          </UiButton>
        </template>
        <UiButton v-else @click="close">Close</UiButton>
      </template>
    </UiDialog>
  </Teleport>
</template>

<style scoped>
.share-menu__note {
  max-width: 17rem;
  margin: 0;
  padding: var(--space-2) var(--space-3) var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.share__bar {
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
}
.share__bar i {
  display: block;
  height: 100%;
  background: var(--action);
  transition: width var(--duration-fast) linear;
}
.share__status {
  margin: var(--space-3) 0 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
/* The file at its own pixels, never smoothed. */
.share__preview {
  display: block;
  width: 100%;
  aspect-ratio: 320 / 200;
  border-radius: var(--radius-sm);
  background: var(--agi-0);
  image-rendering: pixelated;
}
</style>
