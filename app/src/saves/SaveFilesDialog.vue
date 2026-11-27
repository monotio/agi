<script setup lang="ts">
/**
 * Original .SAV import and export dialog.
 * Holds its own engine pause while open so mid-picker game cycles cannot open
 * modals or kill ego while the player chooses a file.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useShell } from "../shell/useShell.ts";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";

const { title } = defineProps<{
  /** The running game's title, used as the default save description and filename. */
  title: string;
}>();

const emit = defineEmits<{
  closed: [reason: "done" | "imported"];
}>();

const open = defineModel<boolean>("open", { required: true });

const {
  state,
  pauseEngine,
  resumeEngine,
  sendDirection,
  exportOriginalSavFile,
  importOriginalSavFile,
} = useEngineApi();
const shell = useShell();

const MAX_ORIGINAL_SAV_BYTES = 256 * 1024;

const fileInput = useTemplateRef("fileInput");
const description = ref("");
const busy = ref(false);
const error = ref("");
const status = ref("");
let pauseHeld = false;
let closeReason: "done" | "imported" = "done";
let requestToken = 0;

/** Block dismissing via Done, × or Esc while an import/export or autosave flush is in flight. */
const dialogOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (!value && busy.value) return;
    open.value = value;
  },
});

const isCreateMode = computed(() => shell.mode.value === "create");
const unsupportedProfile = computed(() => state.profile === "2.001");
const exportDisabledReason = computed(() => {
  if (busy.value) return "A save file action is in progress.";
  if (unsupportedProfile.value)
    return "PC booter 2.001 saves to floppy disk sectors; it has no standalone .SAV file.";
  if (state.historyView.active) return "Return to live play before exporting a save file.";
  if (state.walkthrough.active) return "Stop the walkthrough before exporting a save file.";
  return "";
});
const importDisabledReason = computed(() => {
  if (busy.value) return "A save file action is in progress.";
  if (unsupportedProfile.value)
    return "PC booter 2.001 saves to floppy disk sectors; it has no standalone .SAV file.";
  if (isCreateMode.value) return "Switch to Play before importing a save file.";
  if (state.historyView.active) return "Return to live play before importing a save file.";
  if (state.walkthrough.active) return "Stop the walkthrough before importing a save file.";
  if (state.otherTab)
    return "This game is open in another tab. Take back control in this tab before importing a save.";
  return "";
});

function syncPause(): void {
  const shouldPause = (open.value || busy.value) && state.phase === "running";
  if (shouldPause && !pauseHeld) {
    sendDirection(0);
    pauseEngine("saveFiles");
    pauseHeld = true;
  } else if (!shouldPause && pauseHeld) {
    pauseHeld = false;
    resumeEngine("saveFiles");
  }
}

watch(
  open,
  (isOpen) => {
    if (isOpen) {
      requestToken += 1;
      closeReason = "done";
      error.value = "";
      status.value = "";
      description.value = title.trim().slice(0, 30) || "AGI save";
    }
    syncPause();
  },
  { immediate: true },
);

watch(busy, () => {
  syncPause();
});

onBeforeUnmount(() => {
  requestToken += 1;
  if (pauseHeld) {
    pauseHeld = false;
    resumeEngine("saveFiles");
  }
});

function savFilename(gameTitle: string): string {
  const slug = gameTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "game"}.sav`;
}

async function onExport(): Promise<void> {
  if (exportDisabledReason.value) return;
  const token = ++requestToken;
  busy.value = true;
  error.value = "";
  status.value = "";
  try {
    const label = description.value.trim().slice(0, 30);
    const result = await exportOriginalSavFile(label || undefined);
    if (token !== requestToken) return;
    if (!result.bytes) {
      error.value = result.error || "Could not export a save file right now.";
      return;
    }
    const blob = new Blob([result.bytes.slice().buffer as ArrayBuffer], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = savFilename(title);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    status.value = `Downloaded ${anchor.download}.`;
  } catch (caught) {
    if (token !== requestToken) return;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (token === requestToken) busy.value = false;
  }
}

function chooseFile(): void {
  if (importDisabledReason.value) return;
  const input = fileInput.value;
  if (!input) return;
  input.value = "";
  input.click();
}

async function onFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = "";
  status.value = "";
  if (file.size === 0) {
    error.value = "That file is empty. Choose an original AGI save file.";
    return;
  }
  if (file.size > MAX_ORIGINAL_SAV_BYTES) {
    error.value = "That file is larger than 256 KB. Choose an original AGI save file.";
    return;
  }
  const token = ++requestToken;
  busy.value = true;
  try {
    const buffer = await file.arrayBuffer();
    if (token !== requestToken) return;
    const result = await importOriginalSavFile(new Uint8Array(buffer));
    if (token !== requestToken) return;
    if (!result.ok) {
      error.value = result.error || "That save file could not be loaded into this game.";
      return;
    }
    if (result.storageWarning) {
      error.value = result.storageWarning;
      return;
    }
    if (open.value) {
      closeReason = "imported";
      open.value = false;
    }
  } catch (caught) {
    if (token !== requestToken) return;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (token === requestToken) busy.value = false;
  }
}

function onDialogClosed(): void {
  const reason = closeReason;
  closeReason = "done";
  emit("closed", reason);
}
</script>

<template>
  <UiDialog
    v-model:open="dialogOpen"
    title="Save files"
    size="sm"
    :restore-focus="false"
    data-testid="save-files-dialog"
    @closed="onDialogClosed"
  >
    <div class="sav-dialog">
      <p v-if="error" role="alert" class="sav-dialog__error" data-testid="sav-error">
        {{ error }}
      </p>
      <p v-else-if="status" role="status" class="sav-dialog__status" data-testid="sav-status">
        {{ status }}
      </p>

      <section class="sav-dialog__section">
        <h3>Export current game</h3>
        <p class="sav-dialog__hint">
          Download an original interpreter save file for DOS, Amiga or Apple IIgs.
        </p>
        <label class="sav-dialog__field">
          <span>Description</span>
          <input
            v-model="description"
            type="text"
            maxlength="30"
            :disabled="busy || unsupportedProfile"
            data-testid="sav-description"
          />
        </label>
        <UiButton
          variant="primary"
          :disabled="exportDisabledReason !== ''"
          :title="exportDisabledReason"
          data-testid="sav-export-btn"
          @click="void onExport()"
        >
          Export .SAV
        </UiButton>
      </section>

      <section class="sav-dialog__section">
        <h3>Import an original save</h3>
        <p class="sav-dialog__hint">
          Load a Sierra save file (such as <code>KQ1SG.1</code> or <code>.sav</code>) into the
          running game. Earlier moments stay on the timeline.
        </p>
        <input
          ref="fileInput"
          type="file"
          hidden
          data-testid="sav-import-input"
          @change="void onFileSelected($event)"
        />
        <UiButton
          :disabled="importDisabledReason !== ''"
          :title="importDisabledReason"
          data-testid="sav-import-btn"
          @click="chooseFile"
        >
          Choose save file…
        </UiButton>
      </section>
    </div>

    <template #footer>
      <UiButton
        :disabled="busy"
        :title="busy ? 'Wait for the save file action to finish.' : ''"
        data-testid="sav-done"
        @click="dialogOpen = false"
      >
        Done
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.sav-dialog {
  display: grid;
  gap: var(--space-4);
}
.sav-dialog__section {
  display: grid;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--hairline);
}
.sav-dialog__section:first-of-type {
  padding-top: 0;
  border-top: 0;
}
.sav-dialog__section h3 {
  margin: 0;
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
}
.sav-dialog__hint {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.sav-dialog__field {
  display: grid;
  gap: var(--space-1);
}
.sav-dialog__field span {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.sav-dialog__field input {
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.sav-dialog__error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-sm);
}
.sav-dialog__status {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
</style>
