<script setup lang="ts">
/**
 * The one settings sheet: sound and display, AI, this game's downloads and
 * Start over, and the advanced diagnostics. A modal sheet anchored to the
 * right edge, with no backdrop — the game stays visible. Tab and Shift+Tab
 * cycle inside it and never reach the page behind; Escape closes it from
 * anywhere and returns focus to the Settings button; a click outside closes
 * it too, leaving focus with what was clicked. Toggles keep it open; actions
 * close it. Keys pressed inside never reach the game (App.vue skips events
 * from dialogs).
 */
import { nextTick, onBeforeUnmount, ref, useTemplateRef } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import { useShellBridge } from "./shellBridge.ts";
import { nextAudioMode, soundChipLabel, soundFamily } from "../audio/useAudioController.ts";
import { useShell } from "./useShell.ts";

const { touchControls, crtEnabled, originalAspect, gpuBackend, debugOpen, exportBusy } =
  defineProps<{
    touchControls: boolean;
    crtEnabled: boolean;
    originalAspect: boolean;
    gpuBackend: string | undefined;
    debugOpen: boolean;
    exportBusy: boolean;
  }>();

const emit = defineEmits<{
  "update:touchControls": [value: boolean];
  "update:crtEnabled": [value: boolean];
  "update:originalAspect": [value: boolean];
  "update:debugOpen": [value: boolean];
  "export-zip": [project: boolean];
  "start-over": [];
  /** Open Developer activity, which no screen keeps on the page. */
  "developer-activity": [];
}>();

const { state, resumeAudio, toggleMute, setAudioMode, currentGame } = useEngineApi();
const { aiModelLabel, aiSettingsUnavailable, openAiSettings } = useAiSettings();
const bridge = useShellBridge();
const shell = useShell();

const sheet = useTemplateRef("sheet");
const open = ref(false);
/** Advanced disclosure: sound-chip emulation and diagnostics live under it. */
const advanced = ref(false);
let trigger: HTMLElement | null = null;

function onOutsidePointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (sheet.value?.contains(target) || trigger?.contains(target)) return;
  // A click into another dialog (AI settings) is not a click outside.
  if (target instanceof Element && target.closest("dialog[open]")) return;
  close("stay");
}

const TAB_STOPS =
  "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * Tab past either end of the sheet wraps to its other end; from anywhere
 * outside it (focus dropped to the page body), Tab enters it.
 */
function trapTab(event: KeyboardEvent): void {
  const root = sheet.value;
  if (!root) return;
  const stops = Array.from(root.querySelectorAll<HTMLElement>(TAB_STOPS)).filter(
    (stop) => stop.getClientRects().length > 0,
  );
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  const edge = event.shiftKey ? first : last;
  if (inside && active !== edge) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus({ preventScroll: true });
}

/**
 * Keys while the sheet is open: Escape anywhere closes it (the sheet, not the
 * game, takes it) and Tab stays inside it.
 */
function onWindowKeydown(event: KeyboardEvent): void {
  if ((event.key !== "Escape" && event.key !== "Tab") || event.defaultPrevented) return;
  // Another dialog above the sheet (AI settings) handles its own keys.
  const target = event.target;
  const other = target instanceof Element ? target.closest("dialog[open]") : null;
  if (other && other !== sheet.value) return;
  if (event.key === "Tab") {
    trapTab(event);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  close("trigger");
}

/**
 * Focus taken outside by anything but Tab (the game claiming its input, a
 * click the outside handler has not seen) closes the sheet behind it.
 */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (!(next instanceof Node)) return;
  if (sheet.value?.contains(next) || trigger?.contains(next)) return;
  close("stay");
}

async function show(from: HTMLElement | null): Promise<void> {
  trigger = from;
  open.value = true;
  window.addEventListener("pointerdown", onOutsidePointerDown, true);
  window.addEventListener("keydown", onWindowKeydown, true);
  await nextTick();
  if (!sheet.value?.open) sheet.value?.show();
  sheet.value?.querySelector<HTMLElement>("[data-sheet-item]")?.focus({ preventScroll: true });
}

/**
 * Close the sheet. "game" hands the keyboard back to the running game (the
 * trigger at the menu screen); "trigger" returns it to the gear; "stay"
 * leaves focus where the closing click put it.
 */
function close(focus: "game" | "trigger" | "stay"): void {
  if (!open.value) return;
  open.value = false;
  window.removeEventListener("pointerdown", onOutsidePointerDown, true);
  window.removeEventListener("keydown", onWindowKeydown, true);
  sheet.value?.close();
  if (focus === "game" && state.phase === "running") bridge.focusGameInput();
  else if (focus !== "stay") trigger?.focus({ preventScroll: true });
}

function toggle(from: HTMLElement | null): void {
  if (open.value) close("trigger");
  else void show(from);
}

/** Actions leave the sheet; the flows they start own focus from here. */
function act(run: () => void): void {
  close("stay");
  run();
}

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onOutsidePointerDown, true);
  window.removeEventListener("keydown", onWindowKeydown, true);
});

defineExpose({ toggle, close, open });
</script>

<template>
  <dialog
    ref="sheet"
    class="settings-sheet"
    aria-labelledby="settings-sheet-title"
    aria-modal="true"
    data-testid="settings-menu-menu"
    @focusout="onFocusOut"
  >
    <template v-if="open">
      <header class="settings-sheet__head">
        <h2 id="settings-sheet-title">Settings</h2>
        <UiIconButton icon="x" label="Close settings" size="sm" @click="close('game')" />
      </header>

      <section class="settings-sheet__group" aria-labelledby="settings-sound-display">
        <h3 id="settings-sound-display">Sound and display</h3>
        <UiSwitch
          class="settings-row"
          data-sheet-item
          data-testid="toggle-mute"
          :model-value="!state.soundMuted"
          @update:model-value="
            resumeAudio();
            toggleMute();
          "
        >
          Sound<small>Linked to the game’s own sound setting</small>
        </UiSwitch>
        <UiSwitch
          v-if="gpuBackend"
          class="settings-row"
          data-testid="toggle-crt"
          :model-value="crtEnabled"
          @update:model-value="emit('update:crtEnabled', $event)"
        >
          Display<small>CRT scanlines, glow and curved glass</small>
        </UiSwitch>
        <UiSwitch
          class="settings-row"
          data-testid="toggle-original-aspect"
          :model-value="originalAspect"
          @update:model-value="emit('update:originalAspect', $event)"
        >
          Original 4:3<small>Taller pixels, as 1980s monitors showed them</small>
        </UiSwitch>
        <UiSwitch
          class="settings-row"
          data-testid="toggle-touch-controls"
          :model-value="touchControls"
          @update:model-value="emit('update:touchControls', $event)"
        >
          On-screen controls<small>Directions, keyboard and game keys</small>
        </UiSwitch>
      </section>

      <section class="settings-sheet__group" aria-labelledby="settings-ai">
        <h3 id="settings-ai">AI</h3>
        <button
          type="button"
          class="settings-row"
          data-testid="open-ai-settings"
          :disabled="aiSettingsUnavailable"
          @click="act(() => openAiSettings($event, 'header'))"
        >
          <span
            >AI settings…<small>{{ aiModelLabel }}</small></span
          >
          <span class="setting-value">Change</span>
        </button>
      </section>

      <section
        v-if="state.phase === 'running'"
        class="settings-sheet__group"
        aria-labelledby="settings-game"
      >
        <h3 id="settings-game">This game</h3>
        <button
          type="button"
          class="settings-row"
          data-testid="btn-edit-game"
          :disabled="state.powerUp.busy || !shell.createAvailable.value"
          @click="act(shell.openRemix)"
        >
          <span>Edit game…<small>Opens Create: rooms, art and playtests</small></span>
        </button>
        <button
          type="button"
          class="settings-row"
          data-testid="btn-download-game"
          :disabled="exportBusy || state.powerUp.busy"
          @click="act(() => emit('export-zip', true))"
        >
          <span>Download game…<small>The whole project: edits, saves and history</small></span>
        </button>
        <button
          type="button"
          class="settings-row"
          data-testid="btn-export-game"
          :disabled="exportBusy || state.powerUp.busy"
          @click="act(() => emit('export-zip', false))"
        >
          <span v-if="currentGame()?.workInProgress"
            >Export game…<small data-testid="export-work-in-progress"
              >ZIP, work in progress: exits to unbuilt rooms stop the game</small
            ></span
          >
          <span v-else>Export game…<small>The playable game, ready to share</small></span>
        </button>
        <button
          type="button"
          class="settings-row settings-row--danger"
          data-testid="btn-start-over"
          @click="act(() => emit('start-over'))"
        >
          <span
            >Start over<small
              >Restart from the beginning; earlier sessions stay on the timeline</small
            ></span
          >
        </button>
      </section>

      <section class="settings-sheet__group" aria-label="Advanced">
        <button
          type="button"
          class="settings-row"
          data-testid="settings-advanced"
          :aria-expanded="advanced"
          @click="advanced = !advanced"
        >
          <span>Advanced…<small>Sound chip emulation and diagnostics</small></span>
          <UiIcon
            class="settings-row__chevron"
            :name="advanced ? 'chevron-up' : 'chevron-down'"
            :size="16"
          />
        </button>
        <template v-if="advanced">
          <button
            type="button"
            class="settings-row"
            data-testid="toggle-sound-mode"
            :disabled="soundFamily(state.profile) !== 'pc'"
            @click="
              resumeAudio();
              setAudioMode(nextAudioMode(state.soundMode));
            "
          >
            <span
              >Sound chip<small>{{
                soundChipLabel(soundFamily(state.profile), state.soundMode)
              }}</small></span
            >
            <span v-if="soundFamily(state.profile) === 'pc'" class="setting-value">Change</span>
          </button>
          <UiSwitch
            v-if="state.phase === 'running'"
            class="settings-row"
            data-testid="settings-inspect"
            :model-value="debugOpen"
            @update:model-value="emit('update:debugOpen', $event)"
          >
            Inspector<small>Priority layers, state and trace</small>
          </UiSwitch>
          <button
            type="button"
            class="settings-row"
            data-testid="settings-developer-activity"
            @click="
              close('trigger');
              emit('developer-activity');
            "
          >
            <span>Developer activity<small>Agent log, debug bundle and renderer</small></span>
          </button>
        </template>
      </section>
    </template>
  </dialog>
</template>

<style scoped>
.settings-sheet {
  position: fixed;
  inset: calc(var(--shell-bar-h, 52px) + var(--space-2)) var(--space-3) auto auto;
  z-index: var(--z-popover);
  width: min(380px, calc(100vw - 2 * var(--space-3)));
  max-height: calc(100dvh - var(--shell-bar-h, 52px) - 2 * var(--space-3));
  margin: 0;
  padding: 0 0 var(--space-3);
  overflow-y: auto;
  box-sizing: border-box;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  box-shadow: var(--shadow-pop);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
/* The sheet drops in from under the bar (motion.css: sheets slide 8px). */
.settings-sheet[open] {
  animation: ui-sheet-in-down var(--duration) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .settings-sheet[open] {
    animation: none;
  }
}
.settings-sheet__head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-3) var(--space-2) var(--space-5);
  background: var(--surface-1);
}
.settings-sheet__head h2 {
  margin: 0;
  font: var(--weight-semibold) var(--text-lg) / var(--leading-tight) var(--font-sans);
}
.settings-sheet__group {
  display: grid;
  gap: var(--space-0);
  padding: var(--space-2) var(--space-2) var(--space-3);
  border-top: 1px solid var(--hairline);
}
.settings-sheet__group h3 {
  margin: var(--space-2) var(--space-3) var(--space-1);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.settings-sheet .settings-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  min-height: var(--control-h-touch);
  box-sizing: border-box;
  padding: var(--space-3);
  border: 0;
  border-radius: var(--radius);
  color: var(--ink);
  background: transparent;
  font: var(--weight-semibold) var(--text-md) / 1.4 var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.settings-sheet .settings-row:hover:not(:disabled) {
  background: var(--surface-3);
}
.settings-sheet .settings-row:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.settings-row small {
  display: block;
  color: var(--ink-3);
  font-size: var(--text-xs);
  font-weight: 400;
}
.settings-row--danger {
  color: var(--danger);
}
.settings-row__chevron {
  margin-left: auto;
  color: var(--ink-3);
}
.setting-value {
  flex: none;
  margin-left: auto;
  color: var(--action);
  font-size: var(--text-xs);
  white-space: nowrap;
}
</style>
