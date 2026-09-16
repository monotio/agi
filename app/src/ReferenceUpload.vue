<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useEngineApi } from "./engineContext.ts";
import { referenceUpload } from "./referenceUploadState.ts";
import { decodeReferenceFile } from "./referenceDecode.ts";
import { ROOM_REFERENCE_ASPECT, type DecodedImage, type StoredReference } from "./referenceArt.ts";
import type { SheetFacing } from "../../src/view/characterSheet.ts";
import { viewFeedback } from "../../src/agent/viewFeedback.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { bytesToBase64 } from "./bytes.ts";
import { useAiSettings } from "./useAiSettings.ts";

/**
 * Reference-art upload: attach a picture the player supplies — a room plate
 * the agent hand-encodes with write_picture, or a character sheet that
 * converts to a staged VIEW the player keeps or revises. Raised from the
 * chat bubble or the world map's room detail via referenceUploadState.
 */
const engine = useEngineApi();
const { llmConfig } = useAiSettings();

const FACING_LABELS: Record<SheetFacing, string> = {
  right: "Facing right",
  left: "Facing left",
  down: "Facing down (front)",
  up: "Facing up (back)",
};
const FACINGS: readonly SheetFacing[] = ["right", "left", "down", "up"];

const kind = ref<"room" | "character">("room");
const target = ref(1);
const brief = ref("");
const busy = ref(false);
const error = ref("");
const roomFile = ref<File>();
const facingFiles = reactive<Record<SheetFacing, File | null>>({
  right: null,
  left: null,
  down: null,
  up: null,
});
const poses = ref(4);
const celHeight = ref(32);
const symmetric = ref(true);
const attached = ref<StoredReference>();
const sending = ref(false);
const existing = ref<StoredReference[]>([]);
const sendingId = ref("");

const characterViewNum = 0;

const suppliedFacings = computed(() => FACINGS.filter((f) => facingFiles[f] !== null));

const stagedPreview = computed(() => {
  const staged = attached.value?.staged;
  if (!staged) return null;
  try {
    const preview = viewFeedback(
      new Uint8Array(
        atob(staged.payload)
          .split("")
          .map((c) => c.charCodeAt(0)),
      ),
      DEFAULT_V2_PROFILE,
      staged.num,
    );
    return `data:image/png;base64,${bytesToBase64(preview.png)}`;
  } catch {
    return null;
  }
});

watch(
  () => referenceUpload.open,
  (open) => {
    if (!open) return;
    kind.value = "room";
    target.value = referenceUpload.room ?? engine.state.powerUp.room ?? 1;
    brief.value = "";
    error.value = "";
    attached.value = undefined;
    roomFile.value = undefined;
    for (const facing of FACINGS) facingFiles[facing] = null;
    void refreshExisting();
  },
);

async function refreshExisting(): Promise<void> {
  existing.value = await engine.listReferences().catch(() => []);
}

function pickRoomFile(ev: Event): void {
  roomFile.value = (ev.target as HTMLInputElement).files?.[0];
}

function pickFacingFile(facing: SheetFacing, ev: Event): void {
  facingFiles[facing] = (ev.target as HTMLInputElement).files?.[0] ?? null;
}

async function onAttach(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  attached.value = undefined;
  try {
    if (kind.value === "room") {
      const file = roomFile.value;
      if (!file) throw new Error("Choose an image file first.");
      const decoded = await decodeReferenceFile(file);
      attached.value = await engine.attachRoomReference(decoded, target.value, brief.value.trim());
      void refreshExisting();
    } else {
      const sheets: { decoded: DecodedImage; facing: SheetFacing }[] = [];
      for (const facing of suppliedFacings.value)
        sheets.push({ decoded: await decodeReferenceFile(facingFiles[facing]!), facing });
      if (sheets.length === 0) throw new Error("Choose at least one facing's pose row.");
      attached.value = await engine.attachCharacterReference(
        sheets,
        {
          poses: poses.value,
          celHeight: celHeight.value,
          symmetric: symmetric.value,
        },
        characterViewNum,
        brief.value.trim(),
      );
      void refreshExisting();
    }
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
}

async function onKeep(): Promise<void> {
  const id = attached.value?.id;
  if (!id || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await engine.keepStagedView(id);
    attached.value = { ...attached.value!, staged: undefined };
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
}

/** Revise / send: the note plus this reference's images reach the agent. */
async function onSendToAgent(): Promise<void> {
  const id = attached.value?.id;
  if (!id || sending.value) return;
  sending.value = true;
  error.value = "";
  try {
    if (!engine.state.powerUp.open) await engine.openPowerUp(llmConfig());
    const note =
      brief.value.trim() ||
      (attached.value?.kind === "character"
        ? "Use the attached character sheet for the player sprite."
        : "Use the attached reference for this room.");
    await engine.submitPowerUp(note, [id]);
    referenceUpload.open = false;
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    sending.value = false;
  }
}

/** Re-send a stored reference to the agent, or drop it from the project. */
async function onSendExisting(reference: StoredReference): Promise<void> {
  if (sendingId.value) return;
  sendingId.value = reference.id;
  error.value = "";
  try {
    if (!engine.state.powerUp.open) await engine.openPowerUp(llmConfig());
    await engine.submitPowerUp(
      reference.brief ||
        `Look at the attached reference for ${
          reference.kind === "room" ? `room ${reference.target}` : `view ${reference.target}`
        } again.`,
      [reference.id],
    );
    referenceUpload.open = false;
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    sendingId.value = "";
  }
}

async function onDetachExisting(reference: StoredReference): Promise<void> {
  try {
    await engine.detachReference(reference.id);
    if (attached.value?.id === reference.id) attached.value = undefined;
    await refreshExisting();
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  }
}

function close(): void {
  referenceUpload.open = false;
}
</script>

<template>
  <div
    v-if="referenceUpload.open"
    class="reference-upload"
    data-testid="reference-upload"
    role="dialog"
    aria-label="Attach reference art"
    @click.stop
    @pointerdown.stop
  >
    <header class="reference-upload-head">
      <h2>Reference art</h2>
      <button
        type="button"
        class="ui-button ui-button--secondary ui-button--icon dialog-close"
        aria-label="Close reference upload"
        data-testid="reference-upload-close"
        @click="close"
      >
        ×
      </button>
    </header>

    <div v-if="!attached" class="reference-upload-body">
      <div class="reference-kind" role="group" aria-label="Reference kind">
        <button
          type="button"
          data-testid="reference-kind-room"
          :aria-pressed="kind === 'room'"
          @click="kind = 'room'"
        >
          Room
        </button>
        <button
          type="button"
          data-testid="reference-kind-character"
          :aria-pressed="kind === 'character'"
          @click="kind = 'character'"
        >
          Character
        </button>
      </div>

      <template v-if="kind === 'room'">
        <p class="reference-hint">
          A room reference is a composition the agent redraws with native picture commands — it
          decides look and layout, never walkable space or exits. It presents best at a
          {{ ROOM_REFERENCE_ASPECT.toFixed(2) }}:1 proportion (the 160×168 picture surface, drawn
          double-wide).
        </p>
        <label>
          Room number
          <input
            v-model.number="target"
            type="number"
            min="1"
            max="255"
            data-testid="reference-room-num"
          />
        </label>
        <label>
          Image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            data-testid="reference-room-file"
            @change="pickRoomFile"
          />
        </label>
      </template>

      <template v-else>
        <p class="reference-hint">
          One pose row per facing on a flat key colour or real alpha, four to six poses, feet on one
          ground line. Missing facings reuse the opposite row — mirrored only when the design is
          symmetric. The result stages as VIEW {{ characterViewNum }} (the player sprite) for you to
          keep or revise.
        </p>
        <label v-for="facing in FACINGS" :key="facing" class="reference-facing">
          {{ FACING_LABELS[facing] }}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            :data-testid="`reference-facing-${facing}`"
            @change="pickFacingFile(facing, $event)"
          />
        </label>
        <div class="reference-manifest">
          <label>
            Poses per row
            <input
              v-model.number="poses"
              type="number"
              min="4"
              max="6"
              data-testid="reference-poses"
            />
          </label>
          <label>
            Cel height
            <input
              v-model.number="celHeight"
              type="number"
              min="8"
              max="168"
              data-testid="reference-cel-height"
            />
          </label>
          <label class="reference-symmetric">
            <input v-model="symmetric" type="checkbox" data-testid="reference-symmetric" />
            Symmetric design (missing left/right may mirror)
          </label>
        </div>
      </template>

      <label>
        Brief for the agent
        <textarea
          v-model="brief"
          rows="2"
          placeholder="What should the agent take from this reference?"
          data-testid="reference-brief"
        ></textarea>
      </label>

      <footer class="reference-upload-foot">
        <button
          type="button"
          class="ui-button ui-button--primary"
          data-testid="reference-attach"
          :disabled="busy"
          @click="onAttach"
        >
          {{ busy ? "Converting…" : kind === "character" ? "Convert & stage" : "Attach" }}
        </button>
      </footer>

      <section v-if="existing.length" class="reference-existing" data-testid="reference-existing">
        <h3>Attached to this project</h3>
        <ul>
          <li v-for="reference in existing" :key="reference.id" class="reference-existing-row">
            <img
              class="reference-thumb"
              :src="`data:${reference.images[0]?.mime ?? 'image/png'};base64,${reference.images[0]?.png ?? ''}`"
              alt=""
            />
            <span class="reference-existing-label">
              {{
                reference.kind === "room" ? `Room ${reference.target}` : `View ${reference.target}`
              }}
              <template v-if="reference.brief"> — {{ reference.brief }}</template>
            </span>
            <button
              type="button"
              class="ui-button ui-button--secondary"
              :data-testid="`reference-send-${reference.id}`"
              :disabled="sendingId !== ''"
              @click="onSendExisting(reference)"
            >
              {{ sendingId === reference.id ? "Sending…" : "Send" }}
            </button>
            <button
              type="button"
              class="ui-button ui-button--secondary ui-button--icon"
              :aria-label="`Remove reference ${reference.id}`"
              :data-testid="`reference-remove-${reference.id}`"
              @click="onDetachExisting(reference)"
            >
              ×
            </button>
          </li>
        </ul>
      </section>
    </div>

    <div v-else class="reference-upload-body" data-testid="reference-staged">
      <template v-if="attached.staged">
        <p class="reference-hint">
          Staged as VIEW {{ attached.staged.num }}. Inspect the contact sheet — check silhouettes,
          mirrored facings and the shared baseline.
        </p>
        <img
          v-if="stagedPreview"
          class="reference-preview"
          :src="stagedPreview"
          alt="Staged view contact sheet"
          data-testid="reference-preview"
        />
        <ul v-if="attached.staged.substitutions.length" class="reference-notes">
          <li v-for="(note, i) in attached.staged.substitutions" :key="`s${i}`">{{ note }}</li>
        </ul>
        <ul v-if="attached.staged.warnings.length" class="reference-warnings">
          <li v-for="(note, i) in attached.staged.warnings" :key="`w${i}`">{{ note }}</li>
        </ul>
        <footer class="reference-upload-foot">
          <button
            type="button"
            class="ui-button ui-button--primary"
            data-testid="reference-keep"
            :disabled="busy || sending"
            @click="onKeep"
          >
            Keep
          </button>
          <button
            type="button"
            class="ui-button ui-button--secondary"
            data-testid="reference-send"
            :disabled="busy || sending"
            @click="onSendToAgent"
          >
            {{ sending ? "Sending…" : "Send to agent" }}
          </button>
        </footer>
      </template>
      <template v-else>
        <p class="reference-hint" data-testid="reference-attached">
          Reference attached. It rides your next agent message as an image — or send it now with a
          note.
        </p>
        <footer class="reference-upload-foot">
          <button
            type="button"
            class="ui-button ui-button--primary"
            data-testid="reference-send"
            :disabled="sending"
            @click="onSendToAgent"
          >
            {{ sending ? "Sending…" : "Send to agent" }}
          </button>
        </footer>
      </template>
    </div>

    <p v-if="error" class="dialog-error" role="alert" data-testid="reference-error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.reference-upload {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  box-sizing: border-box;
  background: rgba(6, 12, 20, 0.97);
  border: 1px solid #55ffff;
  border-radius: 10px;
  padding: 16px;
  z-index: 5;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  font:
    14px/1.5 system-ui,
    sans-serif;
  color: #e3ecee;
  text-align: left;
}

.reference-upload-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #55ffff;
  border-bottom: 1px solid #1d3a46;
  padding-bottom: 8px;
  margin-bottom: 12px;
}

.reference-upload-head h2 {
  font-size: 14px;
  margin: 0;
  letter-spacing: 0.02em;
}

.reference-upload-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.reference-kind {
  display: flex;
  padding: 3px;
  background: #081217;
  border: 1px solid #38515b;
  border-radius: 8px;
  align-self: flex-start;
}

.reference-kind button {
  min-height: 44px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #a9bac0;
  padding: 7px 14px;
  font: inherit;
  cursor: pointer;
}

.reference-kind button[aria-pressed="true"] {
  background: #20454e;
  color: #a5ffff;
}

.reference-hint {
  color: #9db4bb;
  font-size: 12px;
  margin: 0;
}

.reference-upload label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #a9bac0;
}

.reference-upload input[type="number"],
.reference-upload textarea {
  background: #04080c;
  border: 1px solid #2a4a55;
  color: #e8e8e8;
  padding: 8px 10px;
  font: inherit;
  border-radius: 4px;
}

.reference-upload input[type="file"] {
  font-size: 12px;
  color: #9db4bb;
}

.reference-manifest {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: end;
}

.reference-manifest label {
  flex: 0 1 auto;
}

.reference-manifest input[type="number"] {
  width: 72px;
}

.reference-symmetric {
  flex-direction: row !important;
  align-items: center;
  gap: 8px !important;
}

.reference-preview {
  align-self: center;
  max-width: 100%;
  image-rendering: pixelated;
  border: 1px solid #294047;
  border-radius: 4px;
}

.reference-notes {
  margin: 0;
  padding-left: 18px;
  color: #9db4bb;
  font-size: 12px;
}

.reference-warnings {
  margin: 0;
  padding-left: 18px;
  color: #ffcf87;
  font-size: 12px;
}

.reference-upload-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.reference-existing {
  border-top: 1px solid #1d3a46;
  padding-top: 10px;
}

.reference-existing h3 {
  font-size: 12px;
  color: #55ffff;
  margin: 0 0 8px;
}

.reference-existing ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reference-existing-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reference-thumb {
  width: 40px;
  height: 28px;
  object-fit: contain;
  background: #04080c;
  border: 1px solid #294047;
  border-radius: 3px;
  image-rendering: pixelated;
}

.reference-existing-label {
  flex: 1;
  font-size: 12px;
  color: #a9bac0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-error {
  color: #ff8f8f;
  font-size: 12px;
  margin: 8px 0 0;
}
</style>
