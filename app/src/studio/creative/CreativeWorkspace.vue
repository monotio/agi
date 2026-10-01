<script setup lang="ts">
/**
 * The creative material workspace, docked under the resource editor: bring
 * an image in (Choose, drop or paste — no key, no provider), name it, pick a
 * role and prepare it. "Use as a room" pins a tracing underlay on the open
 * picture; "Use as a character or object" opens the frame editor for any
 * valid VIEW; "Keep as inspiration" pins the source to the project board.
 * Keep publishes prepared work through the shared EditableProject candidate
 * in one transaction; the studio's own Keep seals the same work too.
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useTemplateRef,
  watchEffect,
} from "vue";
import {
  versionRefKey,
  type CreativeBoardEntry,
  type Rect,
} from "../../../../src/creative/catalog.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../../src/types.ts";
import type { PreparedView } from "../../../../src/view/preparation.ts";
import { decodeCreativeImage, CreativeImageError } from "../../references/creativeImageDecode.ts";
import UiButton from "../../ui/UiButton.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import UiPanel from "../../ui/UiPanel.vue";
import UiSelect from "../../ui/UiSelect.vue";
import CreativeBoard, { type BoardPreview } from "./CreativeBoard.vue";
import CreativeFrameEditor from "./CreativeFrameEditor.vue";
import CreativeSourcePreview from "./CreativeSourcePreview.vue";
import { FieldDrafts, numericText } from "./creativeFieldEdits.ts";
import { drawRaster } from "./rasterCanvas.ts";
import type { CreativeMaterialWorkspace, UnderlayJob } from "./creativeWorkspace.ts";
import type { CreativeDraftSummary } from "../../project/creativeDrafts.ts";

const { workspace, resourceKind, resourceNumber } = defineProps<{
  /** The project's creative workspace; one per open EditableProject. */
  readonly workspace: CreativeMaterialWorkspace;
  /** The resource the surrounding editor holds — the default destination. */
  readonly resourceKind: "picture" | "view";
  readonly resourceNumber: number;
}>();
const emit = defineEmits<{
  /** A keep or draft write landed — the host may reread the draft. */
  changed: [keys: readonly string[]];
  /** Fold the panel to its rail; the host decides what that means. */
  collapse: [];
}>();

/** Controller state is non-reactive; subscribe and re-read on change. */
const tick = ref(0);
const unsubscribe = workspace.subscribe(() => tick.value++);
onBeforeUnmount(unsubscribe);

const status = ref("");
const intakeError = ref("");
const busy = ref(false);
const selectedKey = ref<string>();
const recoveries = shallowRef<readonly CreativeDraftSummary[]>([]);
const boardPreviews = shallowRef<Record<string, BoardPreview | null>>({});

/**
 * Every controller mutation runs through this: a refused edit — a Keep in
 * progress, a stale job — surfaces its named reason instead of throwing.
 */
function guard(action: () => void): void {
  try {
    action();
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Uncommitted text per numeric/text field, keyed to the job incarnation and
 * stamped with the entity content it was typed against — the same reason
 * the frame editor buffers: a `:value` binding would re-assert the model on
 * any unrelated workspace update mid-typing.
 */
const drafts = new FieldDrafts();
function underlayKey(field: string): string {
  return `underlay:${underlay.value?.incarnation ?? ""}\u0001${field}`;
}
function viewJobKey(field: string): string {
  return `view:${viewJob.value?.incarnation ?? ""}\u0001${field}`;
}
function commitNumeric(
  key: string,
  stamp: string,
  event: Event,
  apply: (text: string) => void,
): void {
  drafts.commit(key, stamp, event, numericText, apply);
}
/** Escape restores the model value; the draft leaves the field untouched. */
function revertField(key: string, model: string | number, event: Event): void {
  drafts.discard(key);
  (event.target as HTMLInputElement).value = String(model);
}
/** After an own underlay commit, surviving drafts re-stamp to the new content. */
function rebaseUnderlay(part: "crop" | "bounds"): void {
  const job = underlay.value;
  const stamp = job === null ? null : JSON.stringify(job[part]);
  drafts.rebase(`${underlayKey(part)}.`, () => stamp);
}

const sources = computed(() => {
  const _t = tick.value;
  return workspace.sources;
});
const underlay = computed<UnderlayJob | null>(() => {
  const _t = tick.value;
  return workspace.underlay;
});
const viewJob = computed(() => {
  const _t = tick.value;
  return workspace.viewJob;
});
const board = computed<readonly CreativeBoardEntry[]>(() => {
  const _t = tick.value;
  return workspace.board;
});

const selectedSource = computed(
  () =>
    sources.value.find((entry) => versionRefKey(entry.record.identity) === selectedKey.value) ??
    sources.value[0] ??
    null,
);

/** Re-derived on each tick so the UI shows the real recipe output. */
const prepared = computed<PreparedView | null>(() => {
  const _t = tick.value;
  if (workspace.viewJob === null) return null;
  try {
    return workspace.prepareViewJob();
  } catch {
    return null;
  }
});
const preparedError = computed(() => {
  const _t = tick.value;
  if (workspace.viewJob === null) return null;
  try {
    workspace.prepareViewJob();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});

async function refreshBoardPreviews(): Promise<void> {
  const out: Record<string, BoardPreview | null> = {};
  for (const entry of board.value) {
    const key = versionRefKey(entry.source);
    if (key in out) continue;
    const found = await workspace.sourceRaster(entry.source);
    const info = await workspace.sourceInfo(entry.source);
    out[key] =
      found === null
        ? null
        : {
            width: found.record.normalized.width,
            height: found.record.normalized.height,
            pixels: found.pixels,
            title: found.record.origin.title,
            recipes: info?.recipes.length ?? 0,
          };
  }
  boardPreviews.value = out;
}

async function refreshRecoveries(): Promise<void> {
  recoveries.value = await workspace.listRecoveries();
}

async function importFile(
  file: File | undefined | null,
  kind: "import" | "paste" = "import",
): Promise<void> {
  if (file === undefined || file === null) return;
  intakeError.value = "";
  try {
    const intake = await decodeCreativeImage(file);
    const source = await workspace.importIntake(intake, { title: file.name, kind });
    selectedKey.value = versionRefKey(source.identity);
    status.value = "";
    await refreshRecoveries();
  } catch (error) {
    intakeError.value =
      error instanceof CreativeImageError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
  }
}

function choose(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file !== undefined) void importFile(file);
}
function onDrop(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0];
  if (file === undefined || !file.type.startsWith("image/")) return;
  event.preventDefault();
  void importFile(file);
}
function onDragover(event: DragEvent): void {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
}
function onPaste(event: ClipboardEvent): void {
  const target = event.target as Element | null;
  if (target?.closest("input, textarea, [contenteditable]")) return;
  const item = [...(event.clipboardData?.items ?? [])].find((entry) =>
    entry.type.startsWith("image/"),
  );
  const file = item?.getAsFile();
  if (file === undefined || file === null) return;
  event.preventDefault();
  void importFile(file, "paste");
}

/** The picture numbers present in the draft, for the underlay destination. */
const pictureNumbers = computed(() => {
  const _t = tick.value;
  return workspace.project.draft
    .capture()
    .keys.filter((key) => key.startsWith("picture:"))
    .map((key) => Number(key.slice(8)))
    .sort((a, b) => a - b);
});
/** The default underlay destination: the open picture, else the first in the draft. */
const defaultPicture = computed(() =>
  resourceKind === "picture" ? resourceNumber : (pictureNumbers.value[0] ?? 1),
);

function useAsRoom(): void {
  const source = selectedSource.value;
  if (source === null) return;
  guard(() => workspace.beginUnderlay(versionRefKey(source.record.identity), defaultPicture.value));
}
function useAsObject(): void {
  const source = selectedSource.value;
  if (source === null) return;
  guard(() => {
    workspace.beginViewJob(versionRefKey(source.record.identity));
    // Preselect a sensible destination: the open VIEW, else the first free.
    workspace.setViewDestination(
      resourceKind === "view" ? resourceNumber : (workspace.freeViewNumber() ?? null),
    );
  });
}

/** Board rows start a new preparation from their kept source. */
async function prepareFromBoard(entry: CreativeBoardEntry, kind: "room" | "view"): Promise<void> {
  status.value = "";
  try {
    const adopted = await workspace.adoptSource(entry.source);
    if (adopted === null) {
      status.value = "That source is missing from the kept set.";
      return;
    }
    const key = versionRefKey(adopted.identity);
    if (kind === "room") workspace.beginUnderlay(key, defaultPicture.value);
    else {
      workspace.beginViewJob(key);
      workspace.setViewDestination(
        resourceKind === "view" ? resourceNumber : (workspace.freeViewNumber() ?? null),
      );
    }
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  }
}

/** Underlay crop in source pixels, clamped to the source. */
function patchCrop(patch: Partial<Rect>): void {
  const job = underlay.value;
  if (job === null) return;
  const raster = workspace.rasterForSourceKey(job.sourceKey);
  if (raster === null) return;
  const next = { ...job.crop, ...patch };
  const width = raster.record.normalized.width;
  const height = raster.record.normalized.height;
  guard(() =>
    workspace.updateUnderlay({
      crop: {
        x: Math.max(0, Math.min(next.x, width - 1)),
        y: Math.max(0, Math.min(next.y, height - 1)),
        width: Math.max(1, Math.min(next.width, width)),
        height: Math.max(1, Math.min(next.height, height)),
      },
    }),
  );
  rebaseUnderlay("crop");
}
/** Underlay destination bounds inside the 160×168 logical picture. */
function patchBounds(patch: Partial<Rect>): void {
  const job = underlay.value;
  if (job === null) return;
  const next = { ...job.bounds, ...patch };
  guard(() =>
    workspace.updateUnderlay({
      bounds: {
        x: Math.max(0, Math.min(next.x, SCREEN_WIDTH - 1)),
        y: Math.max(0, Math.min(next.y, SCREEN_HEIGHT - 1)),
        width: Math.max(1, Math.min(next.width, SCREEN_WIDTH)),
        height: Math.max(1, Math.min(next.height, SCREEN_HEIGHT)),
      },
    }),
  );
  rebaseUnderlay("bounds");
}
function patchUnderlayDestination(value: number): void {
  guard(() => workspace.updateUnderlay({ resourceId: Math.max(0, Math.min(value, 255)) }));
}

/** The raster the open view job reads, for the source-space frame boxes. */
const viewSource = computed(() => {
  const _t = tick.value;
  const key = workspace.viewJob?.sourceKeys[0];
  return key === undefined ? null : workspace.rasterForSourceKey(key);
});
/** The raster the open underlay reads, for its source preview. */
const underlaySource = computed(() => {
  const _t = tick.value;
  const job = workspace.underlay;
  return job === null ? null : workspace.rasterForSourceKey(job.sourceKey);
});

const viewDestinationText = computed(() => {
  const _t = tick.value;
  const job = workspace.viewJob;
  if (job === null || job.destination === null) return "no destination";
  const info = workspace.viewDestinationInfo(job.destination);
  if (!info.draftDoc && !info.keptRecipe) return `VIEW ${job.destination} (new)`;
  if (info.draftDoc && info.keptRecipe)
    return `VIEW ${job.destination}: replaces the existing view and its kept recipe`;
  if (info.draftDoc) return `VIEW ${job.destination}: replaces the existing view`;
  return `VIEW ${job.destination}: replaces a kept recipe's view`;
});

const pinRole = ref<"style" | "composition" | "character-identity" | "exact-source">("style");
const pinNote = ref("");
function pinToBoard(): void {
  const source = selectedSource.value;
  if (source === null) return;
  guard(() =>
    workspace.addBoardEntry(versionRefKey(source.record.identity), {
      roles: [pinRole.value],
      notes: pinNote.value,
    }),
  );
  pinNote.value = "";
  void refreshBoardPreviews();
}

async function keep(): Promise<void> {
  busy.value = true;
  status.value = "";
  try {
    await workspace.keep();
    status.value = "Creative work kept.";
    emit("changed", []);
    await refreshBoardPreviews();
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

function applyView(): void {
  try {
    const key = workspace.applyViewToDraft();
    status.value = `VIEW ${workspace.viewJob?.destination ?? "?"} is ready. Save to add it to the game.`;
    emit("changed", [key]);
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  }
}

const cleanupFailure = computed(() => {
  const _t = tick.value;
  return workspace.cleanupError ?? "";
});

/** Retries the durable recovery save after a refused cleanup. */
async function retryRecovery(): Promise<void> {
  busy.value = true;
  try {
    await workspace.saveRecovery();
    status.value = "Recovery saved.";
    await refreshRecoveries();
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function restore(entry: CreativeDraftSummary): Promise<void> {
  try {
    await workspace.restoreRecovery(entry.workspaceId);
    status.value = "Recovered the unsaved creative work.";
    await refreshBoardPreviews();
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  }
}
async function discardRecoveryRow(entry: CreativeDraftSummary): Promise<void> {
  await workspace.discardRecovery(entry);
  await refreshRecoveries();
}

const keepable = computed(
  () =>
    sources.value.length > 0 ||
    underlay.value !== null ||
    (viewJob.value !== null && viewJob.value.destination !== null) ||
    board.value.length > 0,
);

const suggestedView = computed(() => {
  const _t = tick.value;
  return workspace.freeViewNumber();
});

const underlayCanvas = useTemplateRef("underlayCanvas");
/** Paint the underlay's source raster into the preview canvas. */
watchEffect(() => {
  const raster = underlaySource.value;
  const canvas = underlayCanvas.value;
  if (canvas === null || raster === null) return;
  drawRaster(
    canvas,
    raster.pixels,
    raster.record.normalized.width,
    raster.record.normalized.height,
  );
});

onMounted(async () => {
  await workspace.ready;
  tick.value++;
  await refreshRecoveries();
  await refreshBoardPreviews();
});

defineExpose({ importFile });
</script>

<template>
  <UiPanel
    class="creative"
    title="Creative"
    data-testid="creative-workspace"
    @drop="onDrop"
    @dragover="onDragover"
    @paste="onPaste"
  >
    <template #actions>
      <UiIconButton
        icon="panel-right"
        size="sm"
        label="Fold the creative panel"
        data-testid="creative-collapse"
        @click="emit('collapse')"
      />
    </template>
    <div class="creative__body">
      <p v-if="cleanupFailure !== ''" class="creative__cleanup" role="alert">
        <span class="creative__cleanup-text">Recovery cleanup failed: {{ cleanupFailure }}</span>
        <UiButton
          size="sm"
          :disabled="busy"
          data-testid="creative-cleanup-retry"
          @click="retryRecovery"
          >Retry recovery</UiButton
        >
      </p>

      <p v-if="recoveries.length > 0" class="creative__recovery">
        <span v-for="entry in recoveries" :key="entry.workspaceId" class="creative__recovery-row">
          Unsaved creative work found<template v-if="entry.status === 'stale'">
            (older version)</template
          >.
          <UiButton
            size="sm"
            :disabled="entry.status !== 'current'"
            :title="
              entry.status !== 'current'
                ? 'This work is from an older version of the project'
                : undefined
            "
            @click="restore(entry)"
            >Restore</UiButton
          >
          <UiButton size="sm" variant="ghost" @click="discardRecoveryRow(entry)">Discard</UiButton>
        </span>
      </p>

      <div class="creative__intake">
        <label class="creative__choose">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            class="creative__file"
            data-testid="creative-choose"
            @change="choose"
          />
          <span class="creative__choose-label">Choose image…</span>
        </label>
        <span class="creative__hint">or drop / paste an image here</span>
      </div>
      <p v-if="intakeError !== ''" class="creative__error" role="alert">{{ intakeError }}</p>

      <ul v-if="sources.length > 0" class="creative__sources" role="list">
        <li v-for="source in sources" :key="versionRefKey(source.record.identity)">
          <CreativeSourcePreview
            :source
            :selected="versionRefKey(source.record.identity) === (selectedKey ?? '')"
            @select="selectedKey = versionRefKey(source.record.identity)"
          />
        </li>
      </ul>

      <div v-if="selectedSource !== null" class="creative__roles">
        <UiButton size="sm" @click="useAsRoom">Trace in room</UiButton>
        <UiButton size="sm" @click="useAsObject">Use as a character or object</UiButton>
        <span class="creative__pin">
          <UiSelect v-model="pinRole" size="sm" aria-label="Board role">
            <option value="style">Style</option>
            <option value="composition">Composition</option>
            <option value="character-identity">Character</option>
            <option value="exact-source">Exact source</option>
          </UiSelect>
          <input
            v-model="pinNote"
            type="text"
            placeholder="Note (optional)"
            aria-label="Board note"
            class="creative__note"
          />
          <UiButton size="sm" @click="pinToBoard">Add to board</UiButton>
        </span>
      </div>

      <section v-if="underlay !== null" class="creative__job" data-testid="underlay-job">
        <h3 class="creative__sub">Trace · PIC {{ underlay.resourceId }}</h3>
        <div class="creative__underlay">
          <canvas
            ref="underlayCanvas"
            class="creative__underlay-src"
            aria-hidden="true"
            data-testid="underlay-source"
          />
          <div class="creative__underlay-fields">
            <label class="creative__field">
              <span>Destination</span>
              <input
                type="number"
                :value="
                  drafts.show(
                    underlayKey('resourceId'),
                    String(underlay.resourceId),
                    underlay.resourceId,
                  )
                "
                min="0"
                max="255"
                aria-label="Trace destination picture"
                data-testid="underlay-destination"
                @input="drafts.edit(underlayKey('resourceId'), String(underlay.resourceId), $event)"
                @change="
                  commitNumeric(
                    underlayKey('resourceId'),
                    String(underlay.resourceId),
                    $event,
                    (t) => patchUnderlayDestination(Math.floor(Number(t))),
                  )
                "
                @keydown.escape="
                  revertField(underlayKey('resourceId'), underlay.resourceId, $event)
                "
              />
            </label>
            <label class="creative__field">
              <span>Crop</span>
              <span class="creative__quad">
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('crop.x'),
                      JSON.stringify(underlay.crop),
                      underlay.crop.x,
                    )
                  "
                  min="0"
                  aria-label="Crop x"
                  @input="drafts.edit(underlayKey('crop.x'), JSON.stringify(underlay.crop), $event)"
                  @change="
                    commitNumeric(
                      underlayKey('crop.x'),
                      JSON.stringify(underlay.crop),
                      $event,
                      (t) => patchCrop({ x: Math.floor(Number(t)) }),
                    )
                  "
                  @keydown.escape="revertField(underlayKey('crop.x'), underlay.crop.x, $event)"
                />
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('crop.y'),
                      JSON.stringify(underlay.crop),
                      underlay.crop.y,
                    )
                  "
                  min="0"
                  aria-label="Crop y"
                  @input="drafts.edit(underlayKey('crop.y'), JSON.stringify(underlay.crop), $event)"
                  @change="
                    commitNumeric(
                      underlayKey('crop.y'),
                      JSON.stringify(underlay.crop),
                      $event,
                      (t) => patchCrop({ y: Math.floor(Number(t)) }),
                    )
                  "
                  @keydown.escape="revertField(underlayKey('crop.y'), underlay.crop.y, $event)"
                />
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('crop.width'),
                      JSON.stringify(underlay.crop),
                      underlay.crop.width,
                    )
                  "
                  min="1"
                  aria-label="Crop width"
                  @input="
                    drafts.edit(underlayKey('crop.width'), JSON.stringify(underlay.crop), $event)
                  "
                  @change="
                    commitNumeric(
                      underlayKey('crop.width'),
                      JSON.stringify(underlay.crop),
                      $event,
                      (t) => patchCrop({ width: Math.max(1, Math.floor(Number(t))) }),
                    )
                  "
                  @keydown.escape="
                    revertField(underlayKey('crop.width'), underlay.crop.width, $event)
                  "
                />
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('crop.height'),
                      JSON.stringify(underlay.crop),
                      underlay.crop.height,
                    )
                  "
                  min="1"
                  aria-label="Crop height"
                  @input="
                    drafts.edit(underlayKey('crop.height'), JSON.stringify(underlay.crop), $event)
                  "
                  @change="
                    commitNumeric(
                      underlayKey('crop.height'),
                      JSON.stringify(underlay.crop),
                      $event,
                      (t) => patchCrop({ height: Math.max(1, Math.floor(Number(t))) }),
                    )
                  "
                  @keydown.escape="
                    revertField(underlayKey('crop.height'), underlay.crop.height, $event)
                  "
                />
              </span>
            </label>
            <label class="creative__field">
              <span>Place</span>
              <span class="creative__quad">
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('bounds.x'),
                      JSON.stringify(underlay.bounds),
                      underlay.bounds.x,
                    )
                  "
                  min="0"
                  :max="SCREEN_WIDTH - 1"
                  aria-label="Bounds x"
                  @input="
                    drafts.edit(underlayKey('bounds.x'), JSON.stringify(underlay.bounds), $event)
                  "
                  @change="
                    commitNumeric(
                      underlayKey('bounds.x'),
                      JSON.stringify(underlay.bounds),
                      $event,
                      (t) => patchBounds({ x: Math.floor(Number(t)) }),
                    )
                  "
                  @keydown.escape="revertField(underlayKey('bounds.x'), underlay.bounds.x, $event)"
                />
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('bounds.y'),
                      JSON.stringify(underlay.bounds),
                      underlay.bounds.y,
                    )
                  "
                  min="0"
                  :max="SCREEN_HEIGHT - 1"
                  aria-label="Bounds y"
                  @input="
                    drafts.edit(underlayKey('bounds.y'), JSON.stringify(underlay.bounds), $event)
                  "
                  @change="
                    commitNumeric(
                      underlayKey('bounds.y'),
                      JSON.stringify(underlay.bounds),
                      $event,
                      (t) => patchBounds({ y: Math.floor(Number(t)) }),
                    )
                  "
                  @keydown.escape="revertField(underlayKey('bounds.y'), underlay.bounds.y, $event)"
                />
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('bounds.width'),
                      JSON.stringify(underlay.bounds),
                      underlay.bounds.width,
                    )
                  "
                  min="1"
                  :max="SCREEN_WIDTH"
                  aria-label="Bounds width"
                  @input="
                    drafts.edit(
                      underlayKey('bounds.width'),
                      JSON.stringify(underlay.bounds),
                      $event,
                    )
                  "
                  @change="
                    commitNumeric(
                      underlayKey('bounds.width'),
                      JSON.stringify(underlay.bounds),
                      $event,
                      (t) => patchBounds({ width: Math.max(1, Math.floor(Number(t))) }),
                    )
                  "
                  @keydown.escape="
                    revertField(underlayKey('bounds.width'), underlay.bounds.width, $event)
                  "
                />
                <input
                  type="number"
                  :value="
                    drafts.show(
                      underlayKey('bounds.height'),
                      JSON.stringify(underlay.bounds),
                      underlay.bounds.height,
                    )
                  "
                  min="1"
                  :max="SCREEN_HEIGHT"
                  aria-label="Bounds height"
                  @input="
                    drafts.edit(
                      underlayKey('bounds.height'),
                      JSON.stringify(underlay.bounds),
                      $event,
                    )
                  "
                  @change="
                    commitNumeric(
                      underlayKey('bounds.height'),
                      JSON.stringify(underlay.bounds),
                      $event,
                      (t) => patchBounds({ height: Math.max(1, Math.floor(Number(t))) }),
                    )
                  "
                  @keydown.escape="
                    revertField(underlayKey('bounds.height'), underlay.bounds.height, $event)
                  "
                />
              </span>
            </label>
            <label class="creative__field">
              <span>Fit</span>
              <UiSelect
                size="sm"
                :model-value="underlay.fit"
                aria-label="Trace fit"
                @update:model-value="
                  guard(() => workspace.updateUnderlay({ fit: $event as UnderlayJob['fit'] }))
                "
              >
                <option value="contain">contain</option>
                <option value="cover">cover</option>
                <option value="stretch">stretch</option>
                <option value="origin">origin</option>
              </UiSelect>
            </label>
            <label class="creative__field">
              <span>Aspect</span>
              <UiSelect
                size="sm"
                :model-value="underlay.intendedAspect"
                aria-label="Display aspect"
                @update:model-value="
                  guard(() =>
                    workspace.updateUnderlay({
                      intendedAspect: $event as UnderlayJob['intendedAspect'],
                    }),
                  )
                "
              >
                <option value="native">native</option>
                <option value="square">square</option>
              </UiSelect>
            </label>
            <label class="creative__field">
              <span>Opacity</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="underlay.opacity"
                aria-label="Trace opacity"
                @input="
                  guard(() =>
                    workspace.updateUnderlay({
                      opacity: Number(($event.target as HTMLInputElement).value),
                    }),
                  )
                "
              />
              <span class="creative__value">{{ Math.round(underlay.opacity * 100) }}%</span>
            </label>
          </div>
        </div>
        <p class="creative__note-text">Shown over the room art as a tracing guide.</p>
        <UiButton size="sm" variant="ghost" @click="guard(() => workspace.clearUnderlay())"
          >Remove trace</UiButton
        >
      </section>

      <section v-if="viewJob !== null" class="creative__job" data-testid="view-job">
        <h3 class="creative__sub">View preparation</h3>
        <label class="creative__field">
          <span>Destination</span>
          <input
            type="number"
            min="0"
            max="255"
            :value="
              drafts.show(
                viewJobKey('destination'),
                String(viewJob.destination),
                viewJob.destination ?? '',
              )
            "
            placeholder="VIEW #"
            aria-label="VIEW destination"
            data-testid="view-destination"
            @input="drafts.edit(viewJobKey('destination'), String(viewJob.destination), $event)"
            @change="
              drafts.commit(
                viewJobKey('destination'),
                String(viewJob.destination),
                $event,
                () => true,
                (raw) =>
                  guard(() =>
                    workspace.setViewDestination(
                      raw === '' ? null : Math.max(0, Math.min(Math.floor(Number(raw)), 255)),
                    ),
                  ),
              )
            "
            @keydown.escape="
              revertField(viewJobKey('destination'), viewJob.destination ?? '', $event)
            "
          />
          <span class="creative__value" data-testid="view-destination-label">
            {{ viewDestinationText }}
          </span>
          <UiButton
            v-if="suggestedView !== undefined"
            size="sm"
            variant="ghost"
            :title="`Use the first free VIEW ${suggestedView}`"
            @click="guard(() => workspace.setViewDestination(suggestedView ?? null))"
            >Free: {{ suggestedView }}</UiButton
          >
        </label>
        <CreativeFrameEditor
          :job="viewJob"
          :prepared
          :prepared-error="preparedError"
          :source-width="viewSource?.record.normalized.width ?? 0"
          :source-height="viewSource?.record.normalized.height ?? 0"
          :source-pixels="viewSource?.pixels ?? null"
          :source-identity="
            viewJob.sourceKeys[0] !== undefined && viewSource !== null
              ? viewSource.record.identity
              : null
          "
          @update-frames="guard(() => workspace.updateViewJob({ frames: $event }))"
          @update-loops="guard(() => workspace.updateViewJob({ loops: $event }))"
          @update-mask="guard(() => workspace.updateViewJob({ mask: $event }))"
          @update-description="guard(() => workspace.updateViewJob({ description: $event }))"
        />
        <div class="creative__job-actions">
          <UiButton
            size="sm"
            :disabled="viewJob.destination === null || preparedError !== null"
            :title="
              viewJob.destination === null
                ? 'Choose a VIEW destination first'
                : (preparedError ?? '')
            "
            data-testid="apply-view"
            @click="applyView"
          >
            Prepare VIEW {{ viewJob.destination ?? "…" }}
          </UiButton>
          <UiButton size="sm" variant="ghost" @click="guard(() => workspace.clearViewJob())"
            >Discard job</UiButton
          >
        </div>
      </section>

      <section class="creative__job">
        <h3 class="creative__sub">Board</h3>
        <CreativeBoard
          :entries="board"
          :previews="boardPreviews"
          @remove="(entry) => guard(() => workspace.removeBoardEntry(entry.identity))"
          @prepare-room="(entry) => void prepareFromBoard(entry, 'room')"
          @prepare-view="(entry) => void prepareFromBoard(entry, 'view')"
        />
      </section>
    </div>

    <template #footer>
      <div class="creative__foot">
        <span class="creative__status" role="status">{{ status }}</span>
        <UiButton
          variant="primary"
          size="sm"
          :disabled="busy || !keepable"
          data-testid="creative-keep"
          @click="keep"
        >
          Save creative work
        </UiButton>
      </div>
    </template>
  </UiPanel>
</template>

<style scoped>
/* Docked to a direct studio (App.vue passes this class): a floating
   scrollable drawer over the editor's edge, so the art stage keeps the
   full workspace width for a usable zoom; a narrow screen stacks it under
   the editor with the smaller share. The rule lives here so the startup
   stylesheet never sees dock-only styles. */
.studio-host__creative {
  position: absolute;
  top: 52px;
  right: 0;
  bottom: var(--control-h-touch);
  width: 300px;
  min-height: 0;
  border-left: 1px solid var(--hairline);
  box-shadow: var(--shadow-pop);
}
.creative__body {
  display: grid;
  /* A pinned column: a child's intrinsic width (a row of number fields, a
     pin row) wraps inside the panel instead of widening it past the clip. */
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5) var(--space-4);
}
.creative__cleanup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius);
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.creative__cleanup-text {
  flex: 1;
}
.creative__recovery {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius);
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.creative__recovery-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.creative__intake {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.creative__file {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.creative__choose-label {
  display: inline-flex;
  align-items: center;
  min-height: var(--control-h);
  padding: 0 var(--space-5);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  font: var(--weight-bold) var(--text-md) / var(--leading-tight) var(--font-sans);
  cursor: pointer;
}
.creative__choose:hover .creative__choose-label {
  border-color: var(--action-line);
}
/* The file input is hidden but still keyboard-reachable; show its focus. */
.creative__choose:focus-within .creative__choose-label {
  outline: 2px solid var(--action-line);
  outline-offset: 2px;
}
.creative__hint {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.creative__error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-xs);
}
.creative__sources {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.creative__roles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.creative__pin {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
}
.creative__note {
  flex: 1 1 7rem;
  min-width: 5rem;
  padding: 2px var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-0);
  color: var(--ink);
  font-size: var(--text-xs);
}
.creative__job {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
}
.creative__sub {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.creative__field {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.creative__value {
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-xs) / 1 var(--font-mono);
}
.creative__underlay {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-3);
}
.creative__underlay-src {
  width: 140px;
  max-height: 140px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  image-rendering: pixelated;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 0 0 / 12px
    12px;
  flex: none;
}
.creative__underlay-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  min-width: 0;
}
.creative__quad {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.creative__quad input[type="number"],
.creative__field input[type="number"] {
  width: 4.5rem;
  padding: 2px var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-0);
  color: var(--ink);
  font: var(--weight-medium) var(--text-xs) / 1 var(--font-mono);
}
.creative__quad input[type="number"] {
  width: 3.5rem;
}
.creative__note-text {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.creative__job-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.creative__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 40px;
  padding: 0 var(--space-5);
}
.creative__status {
  min-width: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 900px) {
  .studio-host__creative {
    position: static;
    flex: 2 3 0;
    width: auto;
    min-height: 120px;
    border-left: 0;
    border-top: 1px solid var(--hairline);
    box-shadow: none;
  }
}
</style>
