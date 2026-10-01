<script setup lang="ts">
/**
 * The optional reference-art generator: compose -> review -> one explicit
 * send -> detached offer -> explicit Use. All state lives in the injected
 * controller; this file is only the form, the review sheet and the offer
 * tray, so the manual workspace keeps working without it. The panel disposes
 * the controller on unmount so a nonsettling request cannot land after the
 * dock closes.
 */
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue";
import { versionRefKey, type Rect, type VersionRef } from "../../../../src/creative/catalog.ts";
import type {
  CreativeGenerationController,
  CreativeGenerationFailureInfo,
  CreativeGenerationInput,
  CreativeGenerationPhase,
  CreativeGenerationReferenceOption,
  CreativeGenerationReview,
  CreativeGenerationSourceOption,
} from "./creativeGeneration.ts";
import type {
  OpenAiImageBackground,
  OpenAiImageKind,
  OpenAiImageOffer,
  OpenAiImageQuality,
  OpenAiImageRole,
} from "./openaiImageProvider.ts";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiDisclosure from "../../ui/UiDisclosure.vue";
import UiPanel from "../../ui/UiPanel.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import UiSelect from "../../ui/UiSelect.vue";

const { controller } = defineProps<{
  readonly controller: CreativeGenerationController;
}>();

/* --- Controller state mirror: the controller notifies, we re-read it. --- */
interface Snapshot {
  readonly phase: CreativeGenerationPhase;
  readonly notice: string;
  readonly failure: CreativeGenerationFailureInfo | null;
  readonly review: CreativeGenerationReview | null;
  readonly offer: OpenAiImageOffer | null;
  readonly offerStale: boolean;
  readonly credentialReady: boolean;
  readonly composite: boolean;
  readonly sources: readonly CreativeGenerationSourceOption[];
  readonly references: readonly CreativeGenerationReferenceOption[];
}
function readController(): Snapshot {
  return {
    phase: controller.phase,
    notice: controller.notice,
    failure: controller.failure,
    review: controller.review,
    offer: controller.offer,
    offerStale: controller.offerStale,
    credentialReady: controller.credentialReady(),
    composite: controller.editComposite() !== null,
    sources: controller.sourceOptions(),
    references: controller.referenceOptions(),
  };
}
const state = ref<Snapshot>(readController());
const unsubscribe = controller.subscribe(() => {
  state.value = readController();
});
const phase = computed(() => state.value.phase);
const notice = computed(() => state.value.notice);
const failure = computed(() => state.value.failure);
const review = computed(() => state.value.review);
const offer = computed(() => state.value.offer);
const offerStale = computed(() => state.value.offerStale);
const credentialReady = computed(() => state.value.credentialReady);

onBeforeUnmount(() => {
  unsubscribe();
  controller.dispose();
});

/* --- Local form state, copied into the request at Review. --- */
const models = controller.provider.models;
const modelIds = Object.keys(models);
const kind = ref<OpenAiImageKind>("generate");
const role = ref<OpenAiImageRole>("room");
const model = ref<string>(modelIds[0] ?? "");
const prompt = ref("");
const size = ref("");
const customSize = ref("2048x2048");
const quality = ref<OpenAiImageQuality | "">("");
const background = ref<OpenAiImageBackground | "">("");
const inputFidelity = ref<"low" | "high" | "">("");
const assetKey = ref("");
const referenceKeys = ref<string[]>([]);
const selection = ref({ x: 0, y: 0, width: 1, height: 1 });

const capability = computed(() => models[model.value]);

const KIND_OPTIONS = [
  { value: "generate" as const, label: "Generate", testid: "generate-kind-generate" },
  { value: "variation" as const, label: "Variation", testid: "generate-kind-variation" },
  { value: "edit" as const, label: "Edit", testid: "generate-kind-edit" },
];
const ROLE_OPTIONS: readonly { value: OpenAiImageRole; label: string }[] = [
  { value: "room", label: "Room" },
  { value: "character", label: "Character" },
  { value: "object", label: "Object" },
  { value: "inspiration", label: "Inspiration" },
];

const usesAsset = computed(() => kind.value === "variation" || kind.value === "edit");
const usesFidelity = computed(() => usesAsset.value && capability.value?.inputFidelity === true);

const sourceOptions = computed(() => state.value.sources);
const referenceOptions = computed(() => state.value.references);
const sourceByKey = computed(
  () => new Map(sourceOptions.value.map((option) => [option.key, option])),
);
const referenceByKey = computed(
  () => new Map(referenceOptions.value.map((option) => [option.key, option])),
);

watch(
  () => model.value,
  () => {
    const caps = capability.value;
    if (caps === undefined) return;
    if (!caps.sizes.includes(size.value) && !(caps.customSizes && size.value === "custom"))
      size.value = caps.sizes[0] ?? "";
    if (!caps.qualities.includes(quality.value as OpenAiImageQuality))
      quality.value = caps.qualities[0] ?? "";
    if (!caps.backgrounds.includes(background.value as OpenAiImageBackground))
      background.value = caps.backgrounds[0] ?? "";
    if (!usesFidelity.value) inputFidelity.value = "";
  },
  { immediate: true },
);

watch(kind, () => {
  if (!usesFidelity.value) inputFidelity.value = "";
});

/* --- Edit selection: numeric rect over the asset's canonical raster. --- */
const baseRaster = shallowRef<{ pixels: Uint8Array; width: number; height: number } | null>(null);
const baseCanvas = useTemplateRef("baseCanvas");
let rasterRequest = 0;

watch(
  () => [kind.value, assetKey.value] as const,
  async () => {
    const ticket = ++rasterRequest;
    baseRaster.value = null;
    if (kind.value !== "edit" || assetKey.value === "") return;
    const option = sourceByKey.value.get(assetKey.value);
    if (option === undefined) return;
    const raster = await controller.assetRaster(option.identity);
    if (ticket !== rasterRequest || raster === null) return;
    baseRaster.value = raster;
    paintBase();
  },
);

function paintBase(): void {
  const canvas = baseCanvas.value;
  const raster = baseRaster.value;
  if (canvas === null || raster === null) return;
  canvas.width = raster.width;
  canvas.height = raster.height;
  const image = new ImageData(raster.width, raster.height);
  image.data.set(raster.pixels);
  canvas.getContext("2d")?.putImageData(image, 0, 0);
}
watch(baseCanvas, paintBase);

const selectionStyle = computed(() => {
  const raster = baseRaster.value;
  if (raster === null) return {};
  return {
    left: `${(selection.value.x / raster.width) * 100}%`,
    top: `${(selection.value.y / raster.height) * 100}%`,
    width: `${(selection.value.width / raster.width) * 100}%`,
    height: `${(selection.value.height / raster.height) * 100}%`,
  };
});

const selectionValid = computed(() => {
  const raster = baseRaster.value;
  const s = selection.value;
  if (!Number.isInteger(s.x) || !Number.isInteger(s.y)) return false;
  if (!Number.isInteger(s.width) || !Number.isInteger(s.height)) return false;
  if (s.width < 1 || s.height < 1 || s.x < 0 || s.y < 0) return false;
  if (raster === null) return true;
  return s.x + s.width <= raster.width && s.y + s.height <= raster.height;
});

/* --- The detached offer preview: a blob URL for the exact PNG bytes. --- */
const offerUrl = ref("");
watch(
  offer,
  (next) => {
    if (offerUrl.value !== "") URL.revokeObjectURL(offerUrl.value);
    offerUrl.value =
      next === null
        ? ""
        : URL.createObjectURL(
            new Blob([next.encodedBytes.slice().buffer as ArrayBuffer], {
              type: next.encoded.mime,
            }),
          );
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (offerUrl.value !== "") URL.revokeObjectURL(offerUrl.value);
});

/* --- Form validity: a light local gate; the review re-checks everything. --- */
const formReady = computed(() => {
  if (prompt.value.trim() === "") return false;
  if (model.value === "") return false;
  if (usesAsset.value && assetKey.value === "") return false;
  if (kind.value === "edit" && !selectionValid.value) return false;
  return true;
});

const formDisabled = computed(
  () => phase.value === "preparing" || phase.value === "submitting" || phase.value === "using",
);

function identityOf(
  key: string,
  table: Map<string, { identity: VersionRef }>,
): VersionRef | undefined {
  const entry = table.get(key);
  return entry === undefined ? undefined : { ...entry.identity };
}

function currentInput(): CreativeGenerationInput {
  const asset = usesAsset.value ? identityOf(assetKey.value, sourceByKey.value) : undefined;
  const references = referenceKeys.value
    .map((key) => identityOf(key, referenceByKey.value))
    .filter((ref): ref is VersionRef => ref !== undefined);
  const rect: Rect | undefined =
    kind.value === "edit"
      ? {
          x: Math.floor(selection.value.x),
          y: Math.floor(selection.value.y),
          width: Math.floor(selection.value.width),
          height: Math.floor(selection.value.height),
        }
      : undefined;
  return {
    kind: kind.value,
    role: role.value,
    model: model.value,
    prompt: prompt.value,
    size: size.value === "custom" ? customSize.value : size.value,
    quality: quality.value as OpenAiImageQuality,
    background: background.value as OpenAiImageBackground,
    ...(inputFidelity.value !== "" ? { inputFidelity: inputFidelity.value } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(rect !== undefined ? { selection: rect } : {}),
  };
}

function prepareReview(): void {
  void controller.prepareReview(currentInput());
}

function short(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

const compositeNote = computed(() => state.value.phase === "offer" && state.value.composite);

const noKey = computed(() => !credentialReady.value || failure.value?.reason === "no-key");
</script>

<template>
  <UiPanel title="Generate" class="generate">
    <!-- Failure and status surface once, plainly. -->
    <p v-if="failure !== null" class="generate__error" role="alert" data-testid="generate-error">
      {{ failure.message }}
      <UiButton
        v-if="failure.reason === 'no-key'"
        size="sm"
        data-testid="generate-settings"
        @click="controller.openSettings()"
        >Open AI settings</UiButton
      >
    </p>
    <p v-else-if="notice !== ''" class="generate__note" role="status" data-testid="generate-notice">
      {{ notice }}
    </p>
    <p v-if="noKey" class="generate__note" data-testid="generate-key">
      Add an OpenAI key in AI settings to generate images.
      <UiButton
        size="sm"
        variant="ghost"
        data-testid="generate-key-settings"
        @click="controller.openSettings()"
        >Open AI settings</UiButton
      >
    </p>

    <!-- Compose -->
    <form
      v-if="phase === 'compose' || phase === 'preparing'"
      class="generate__form"
      data-testid="generate-form"
      @submit.prevent="prepareReview"
    >
      <UiSegmented v-model="kind" label="Request kind" :options="KIND_OPTIONS" block size="sm" />

      <label class="generate__field">
        <span>Prompt</span>
        <textarea
          v-model="prompt"
          rows="4"
          aria-label="Prompt"
          :disabled="formDisabled"
          data-testid="generate-prompt"
        />
      </label>

      <div class="generate__row">
        <label class="generate__field">
          <span>Role</span>
          <UiSelect
            v-model="role"
            size="sm"
            aria-label="Role"
            :disabled="formDisabled"
            data-testid="generate-role"
          >
            <option v-for="option in ROLE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </UiSelect>
        </label>
        <label class="generate__field">
          <span>Model</span>
          <UiSelect
            v-model="model"
            size="sm"
            aria-label="Model"
            :disabled="formDisabled"
            data-testid="generate-model"
          >
            <option v-for="id in modelIds" :key="id" :value="id">
              {{ models[id]?.label ?? id }}
            </option>
          </UiSelect>
        </label>
      </div>

      <div class="generate__row">
        <label class="generate__field">
          <span>Size</span>
          <UiSelect
            v-model="size"
            size="sm"
            aria-label="Size"
            :disabled="formDisabled"
            data-testid="generate-size"
          >
            <option v-if="capability?.customSizes" value="custom">Custom</option>
            <option v-for="entry in capability?.sizes ?? []" :key="entry" :value="entry">
              {{ entry }}
            </option>
          </UiSelect>
        </label>
        <label v-if="size === 'custom'" class="generate__field">
          <span>Custom size</span>
          <input
            v-model="customSize"
            :disabled="formDisabled"
            placeholder="2048x2048"
            data-testid="generate-custom-size"
          />
        </label>
        <label class="generate__field">
          <span>Quality</span>
          <UiSelect
            v-model="quality"
            size="sm"
            aria-label="Quality"
            :disabled="formDisabled"
            data-testid="generate-quality"
          >
            <option v-for="entry in capability?.qualities ?? []" :key="entry" :value="entry">
              {{ entry }}
            </option>
          </UiSelect>
        </label>
        <label class="generate__field">
          <span>Background</span>
          <UiSelect
            v-model="background"
            size="sm"
            aria-label="Background"
            :disabled="formDisabled"
            data-testid="generate-background"
          >
            <option v-for="entry in capability?.backgrounds ?? []" :key="entry" :value="entry">
              {{ entry }}
            </option>
          </UiSelect>
        </label>
        <label v-if="usesFidelity" class="generate__field">
          <span>Fidelity</span>
          <UiSelect
            v-model="inputFidelity"
            size="sm"
            aria-label="Input fidelity"
            :disabled="formDisabled"
            data-testid="generate-fidelity"
          >
            <option value="low">low</option>
            <option value="high">high</option>
          </UiSelect>
        </label>
      </div>

      <label v-if="usesAsset" class="generate__field">
        <span>Asset</span>
        <UiSelect
          v-model="assetKey"
          size="sm"
          aria-label="Departure asset"
          :disabled="formDisabled"
          data-testid="generate-asset"
        >
          <option value="" disabled>Choose a source…</option>
          <option v-for="option in sourceOptions" :key="option.key" :value="option.key">
            {{ option.title }} ({{ option.width }}×{{ option.height }})
          </option>
        </UiSelect>
      </label>

      <UiDisclosure
        id="generate-references"
        label="References"
        :hint="`${referenceKeys.length} chosen`"
        test-id="generate-references"
      >
        <fieldset class="generate__refs" :disabled="formDisabled">
          <label v-for="option in referenceOptions" :key="option.key" class="generate__ref">
            <input
              v-model="referenceKeys"
              type="checkbox"
              :value="option.key"
              :aria-label="`Reference ${option.title}`"
            />
            <span class="generate__ref-title">{{ option.title }}</span>
            <UiChip v-for="r in option.roles" :key="r">{{ r }}</UiChip>
          </label>
          <p v-if="referenceOptions.length === 0" class="generate__empty">
            Approved board entries appear here.
          </p>
        </fieldset>
      </UiDisclosure>

      <section v-if="kind === 'edit'" class="generate__selection" data-testid="generate-selection">
        <span class="generate__label">Selection</span>
        <div v-if="baseRaster !== null" class="generate__base">
          <canvas
            ref="baseCanvas"
            class="generate__base-canvas"
            :width="baseRaster.width"
            :height="baseRaster.height"
            aria-label="Departure asset preview"
          />
          <span class="generate__region" :style="selectionStyle" aria-hidden="true" />
        </div>
        <div class="generate__quad">
          <input
            v-model.number="selection.x"
            type="number"
            min="0"
            aria-label="Selection x"
            :disabled="formDisabled"
            data-testid="generate-selection-x"
          />
          <input
            v-model.number="selection.y"
            type="number"
            min="0"
            aria-label="Selection y"
            :disabled="formDisabled"
            data-testid="generate-selection-y"
          />
          <input
            v-model.number="selection.width"
            type="number"
            min="1"
            aria-label="Selection width"
            :disabled="formDisabled"
            data-testid="generate-selection-width"
          />
          <input
            v-model.number="selection.height"
            type="number"
            min="1"
            aria-label="Selection height"
            :disabled="formDisabled"
            data-testid="generate-selection-height"
          />
        </div>
        <p v-if="!selectionValid" class="generate__error" role="alert">
          The selection stays inside the asset's pixels.
        </p>
        <p class="generate__hint">Only this area may change; every other pixel is preserved.</p>
      </section>

      <UiButton
        type="submit"
        variant="primary"
        block
        :disabled="!formReady || formDisabled"
        :title="formReady ? '' : 'A prompt is needed; a variation or edit also needs a source'"
        data-testid="generate-review"
      >
        {{ phase === "preparing" ? "Preparing review…" : "Review request" }}
      </UiButton>
    </form>

    <!-- Review: the exact request, before it may cost anything. -->
    <section
      v-if="phase === 'review' && review !== null"
      class="generate__review"
      data-testid="generate-review-sheet"
    >
      <h3 class="generate__sub">Review</h3>
      <dl class="generate__facts">
        <dt>Request</dt>
        <dd>
          {{ review.summary.kind }} · {{ review.summary.provider }} · {{ review.summary.model }}
        </dd>
        <dt>Endpoint</dt>
        <dd>
          <code>{{ review.summary.endpoint }}</code>
        </dd>
        <dt>Options</dt>
        <dd>
          {{ review.summary.size }} · {{ review.summary.quality }} · {{ review.summary.background
          }}<template v-if="review.summary.inputFidelity !== undefined">
            · fidelity {{ review.summary.inputFidelity }}</template
          >
          · {{ review.summary.count }} image · {{ review.summary.outputFormat }}
        </dd>
        <template v-if="review.selection !== undefined">
          <dt>Selection</dt>
          <dd>
            {{ review.selection.rect.width }}×{{ review.selection.rect.height }} at
            {{ review.selection.rect.x }},{{ review.selection.rect.y }} · mask
            {{ short(review.selection.mask.hash) }}… ·
            {{ bytes(review.selection.mask.byteLength) }}
          </dd>
        </template>
        <dt>Prompt</dt>
        <dd class="generate__prompt">{{ review.summary.prompt }}</dd>
      </dl>
      <ul v-if="review.images.length > 0" class="generate__images" role="list">
        <li v-for="image in review.images" :key="versionRefKey(image.identity)">
          <span class="generate__img-title">{{ image.title }}</span>
          <UiChip v-for="r in image.roles" :key="r">{{ r }}</UiChip>
          <span class="generate__img-facts">
            {{ image.width }}×{{ image.height }} · {{ image.mime }} ·
            {{ bytes(image.byteLength) }} · <code>{{ short(image.hash) }}…</code>
          </span>
        </li>
      </ul>
      <UiDisclosure
        id="generate-bounds"
        label="Request limits"
        hint="request limits"
        test-id="generate-bounds"
      >
        <ul class="generate__limits" role="list">
          <li>{{ review.summary.limits.maxInputImages }} input images</li>
          <li>{{ bytes(review.summary.limits.maxInputBytesTotal) }} total input</li>
          <li>{{ bytes(review.summary.limits.maxEncodedBytes) }} per input</li>
          <li>{{ bytes(review.summary.limits.maxResponseBytes) }} response</li>
          <li>{{ Math.round(review.summary.limits.timeoutMs / 1000) }}s timeout</li>
          <li>{{ review.summary.limits.maxPromptLength }} prompt code units</li>
        </ul>
        <p class="generate__hint">
          OpenAI bills this image request to your account. Costs follow the provider's pricing.
        </p>
      </UiDisclosure>
      <div class="generate__actions">
        <UiButton variant="primary" data-testid="generate-submit" @click="void controller.submit()"
          >Send one request</UiButton
        >
        <UiButton variant="ghost" data-testid="generate-change" @click="controller.discardReview()"
          >Change request</UiButton
        >
      </div>
    </section>

    <!-- In flight -->
    <section v-if="phase === 'submitting'" class="generate__flight" data-testid="generate-flight">
      <p class="generate__note">The request is on its way…</p>
      <UiButton variant="secondary" data-testid="generate-cancel" @click="controller.cancel()"
        >Cancel</UiButton
      >
    </section>

    <!-- The detached offer: it stages on Use alone. -->
    <section
      v-if="phase === 'offer' && offer !== null"
      class="generate__offer"
      data-testid="generate-offer"
    >
      <h3 class="generate__sub">Result</h3>
      <img
        v-if="offerUrl !== ''"
        :src="offerUrl"
        class="generate__preview"
        alt="The provider's returned image"
        data-testid="generate-preview"
      />
      <dl class="generate__facts">
        <dt>Image</dt>
        <dd>
          {{ offer.width }}×{{ offer.height }} · {{ offer.format }} ·
          {{ bytes(offer.encoded.byteLength) }} · <code>{{ short(offer.encoded.hash) }}…</code>
        </dd>
        <dt v-if="offer.usage !== undefined">Tokens</dt>
        <dd v-if="offer.usage !== undefined">
          {{ offer.usage.totalTokens }} total · {{ offer.usage.outputImageTokens }} image
        </dd>
      </dl>
      <p v-if="offerStale" class="generate__error" role="alert" data-testid="generate-stale">
        This result belongs to an earlier version of your work. Dismiss it and start a new request.
      </p>
      <p v-else-if="compositeNote" class="generate__hint" data-testid="generate-composite">
        Use image places the result inside your selection. The rest stays as it was.
      </p>
      <div class="generate__actions">
        <UiButton
          variant="primary"
          :disabled="offerStale"
          :title="
            offerStale ? 'Dismiss this result and start a new request for the current work' : ''
          "
          data-testid="generate-use"
          @click="void controller.useImage()"
          >Use image</UiButton
        >
        <UiButton variant="ghost" data-testid="generate-dismiss" @click="controller.dismissOffer()"
          >Dismiss</UiButton
        >
      </div>
    </section>

    <p v-if="phase === 'using'" class="generate__note" role="status" data-testid="generate-using">
      Staging the image through the workspace…
    </p>
  </UiPanel>
</template>

<style scoped>
.generate__error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  color: var(--danger);
  font-size: var(--text-sm);
}
.generate__note {
  margin: 0 0 var(--space-3);
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.generate__hint {
  margin: var(--space-2) 0 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.generate__form {
  display: grid;
  gap: var(--space-3);
}
.generate__row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.generate__field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}
.generate__field > span,
.generate__label {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.generate__field textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 72px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  resize: vertical;
}
.generate__refs {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-5) var(--space-3);
  border: 0;
}
.generate__ref {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.generate__ref-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.generate__empty {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.generate__selection {
  display: grid;
  gap: var(--space-2);
}
.generate__base {
  position: relative;
  display: inline-block;
  max-width: 100%;
  border: 1px solid var(--hairline);
}
.generate__base-canvas {
  display: block;
  width: 160px;
  max-width: 100%;
  height: auto;
  image-rendering: pixelated;
}
.generate__region {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid var(--action);
  background: color-mix(in srgb, var(--action) 18%, transparent);
  pointer-events: none;
}
.generate__quad {
  display: flex;
  gap: var(--space-2);
}
.generate__quad input {
  width: 64px;
  min-height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-sm) var(--font-sans);
}
.generate__sub {
  margin: var(--space-3) 0 var(--space-2);
  color: var(--ink-2);
  font: var(--weight-semibold) var(--text-sm) / 1 var(--font-sans);
}
.generate__review,
.generate__offer,
.generate__flight {
  display: grid;
  gap: var(--space-2);
}
.generate__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-sm);
}
.generate__facts dt {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.generate__facts dd {
  margin: 0;
  min-width: 0;
}
.generate__prompt {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.generate__images {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.generate__images li {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.generate__img-title {
  font-weight: var(--weight-semibold);
}
.generate__img-facts {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.generate__limits {
  margin: 0;
  padding: var(--space-1) var(--space-5) var(--space-2) var(--space-8);
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.generate__actions {
  display: flex;
  gap: var(--space-2);
}
.generate__preview {
  max-width: 220px;
  max-height: 220px;
  border: 1px solid var(--hairline);
  image-rendering: pixelated;
}
</style>
