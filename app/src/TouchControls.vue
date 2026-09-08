<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { FUNCTION_KEYS, ALT_LETTER_SCANS } from "./gameControls.ts";

const { disabled, navigating, hold } = defineProps<{
  disabled: boolean;
  navigating: boolean;
  hold: boolean;
}>();
const emit = defineEmits<{ direction: [direction: number]; key: [code: number]; keyboard: [] }>();
const active = ref<number>();
const assistiveHeld = ref(false);
let pointer: number | null = null;
let heldKey: string | null = null;
const directions = [
  { dir: 8, glyph: "↖", name: "northwest" },
  { dir: 1, glyph: "↑", name: "north" },
  { dir: 2, glyph: "↗", name: "northeast" },
  { dir: 7, glyph: "←", name: "west" },
  { dir: 0, glyph: "Type", name: "Keyboard" },
  { dir: 3, glyph: "→", name: "east" },
  { dir: 6, glyph: "↙", name: "southwest" },
  { dir: 5, glyph: "↓", name: "south" },
  { dir: 4, glyph: "↘", name: "southeast" },
];
const extraKeys: Record<string, number> = {
  ...FUNCTION_KEYS,
  Tab: AGI_KEY.TAB,
  Backspace: AGI_KEY.BACKSPACE,
  Insert: AGI_KEY.INSERT,
  Delete: AGI_KEY.DELETE,
  "Scroll Lock": 0x4600,
};
const modifier = ref<"none" | "ctrl" | "alt">("none");
const letters = "abcdefghijklmnopqrstuvwxyz".split("");

function press(event: PointerEvent, dir: number): void {
  if (disabled || event.button !== 0 || pointer !== null || heldKey !== null) return;
  if (assistiveHeld.value) release();
  pointer = event.pointerId;
  active.value = dir;
  const target = event.currentTarget as HTMLElement;
  // Synthetic accessibility/test events need not represent an active pointer.
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    /* No active pointer. */
  }
  emit("direction", dir);
}

function pressKey(event: KeyboardEvent, dir: number): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  // Cancel native button activation: this key's down/up already owns the gesture.
  event.preventDefault();
  if (disabled || event.repeat || pointer !== null || heldKey !== null) return;
  if (assistiveHeld.value) release();
  heldKey = event.key;
  active.value = dir;
  emit("direction", dir);
}

function release(event?: Event): void {
  if (pointer === null && heldKey === null && !assistiveHeld.value) return;
  if (event instanceof PointerEvent && event.pointerId !== pointer) return;
  if (event instanceof KeyboardEvent && event.key !== heldKey) return;
  pointer = null;
  heldKey = null;
  assistiveHeld.value = false;
  active.value = undefined;
  emit("direction", 0);
}

/** Click-only activation holds a virtual key until another activation or blur. */
function clickDirection(event: MouseEvent, dir: number): void {
  if (disabled || event.detail !== 0 || pointer !== null || heldKey !== null) return;
  if (assistiveHeld.value) {
    const stopping = active.value === dir && !navigating;
    release();
    if (stopping) return;
  }
  if (hold && !navigating) {
    assistiveHeld.value = true;
    active.value = dir;
    emit("direction", dir);
    return;
  }
  emit("direction", dir);
  emit("direction", 0);
}

function hidden(): void {
  if (document.hidden) release();
}

watch(
  () => disabled,
  (disabled) => {
    if (disabled) release();
  },
);
onMounted(() => {
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", hidden);
});
onBeforeUnmount(() => {
  release();
  window.removeEventListener("blur", release);
  document.removeEventListener("visibilitychange", hidden);
});
</script>

<template>
  <section class="touch-controls" data-testid="touch-controls" aria-label="Touch game controls">
    <div class="touch-main">
      <div class="direction-pad" role="group" :aria-label="navigating ? 'Navigate dialog' : 'Walk'">
        <button
          v-for="direction in directions"
          :key="direction.dir"
          type="button"
          :disabled
          :class="{ pressed: active === direction.dir, 'keyboard-key': direction.dir === 0 }"
          :aria-pressed="
            hold && !navigating && direction.dir ? active === direction.dir : undefined
          "
          :aria-label="
            direction.dir ? `${navigating ? 'Navigate' : 'Walk'} ${direction.name}` : 'Keyboard'
          "
          @pointerdown.prevent="direction.dir ? press($event, direction.dir) : undefined"
          @pointerup="release"
          @pointercancel="release"
          @lostpointercapture="release"
          @keydown="direction.dir ? pressKey($event, direction.dir) : undefined"
          @keyup="release"
          @blur="release"
          @click="direction.dir ? clickDirection($event, direction.dir) : emit('keyboard')"
        >
          {{ direction.glyph }}
        </button>
      </div>
      <div class="action-keys">
        <button type="button" :disabled @click="emit('key', AGI_KEY.ENTER)">Enter</button>
        <button type="button" :disabled @click="emit('key', AGI_KEY.ESCAPE)">Esc</button>
        <button type="button" :disabled @click="emit('key', AGI_KEY.SPACE)">Space</button>
      </div>
    </div>
    <p class="movement-help">
      {{
        navigating
          ? "Arrows select · Enter accepts · Esc returns"
          : assistiveHeld
            ? "Activate this arrow again to stop."
            : hold
              ? "Hold an arrow to walk. Release to stop."
              : "Tap an arrow to walk. Tap it again to stop."
      }}
    </p>
    <details class="extra-keys">
      <summary>Keys</summary>
      <div class="key-grid">
        <button
          v-for="(code, label) in extraKeys"
          :key="label"
          type="button"
          :disabled
          @click="emit('key', code)"
        >
          {{ label }}
        </button>
      </div>
      <label class="modifier"
        >Letter keys
        <select v-model="modifier" :disabled aria-label="Key modifier">
          <option value="none">Letters</option>
          <option value="ctrl">Ctrl + letter</option>
          <option value="alt">Alt + letter</option>
        </select>
      </label>
      <div class="key-grid letters">
        <button
          v-for="(letter, index) in letters"
          :key="letter"
          type="button"
          :disabled
          @click="
            emit(
              'key',
              modifier === 'ctrl'
                ? index + 1
                : modifier === 'alt'
                  ? ALT_LETTER_SCANS[letter.toUpperCase()]! << 8
                  : letter.charCodeAt(0),
            )
          "
        >
          {{
            modifier === "none"
              ? letter
              : `${modifier === "ctrl" ? "Ctrl" : "Alt"}+${letter.toUpperCase()}`
          }}
        </button>
      </div>
    </details>
  </section>
</template>

<style scoped>
.touch-controls {
  width: min(100%, 360px);
  color: #c6d6df;
}
.touch-main {
  display: flex;
  gap: 16px;
  justify-content: center;
}
.direction-pad {
  display: grid;
  grid-template-columns: repeat(3, 48px);
  gap: 5px;
}
button,
select,
summary {
  font: inherit;
  color: inherit;
  border: 1px solid #41576a;
  border-radius: 6px;
  background: #111d2b;
}
button {
  min-width: 44px;
  min-height: 44px;
  padding: 6px;
  cursor: pointer;
  touch-action: manipulation;
}
.direction-pad button {
  font-size: 23px;
  touch-action: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.direction-pad .keyboard-key {
  font-size: 13px;
  font-weight: 600;
}
button:active,
button.pressed {
  background: #284758;
  border-color: #55ffff;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
.action-keys {
  display: grid;
  gap: 5px;
  min-width: 88px;
}
.movement-help {
  font-size: 12px;
  margin: 8px 0;
  text-align: center;
}
summary {
  padding: 9px 12px;
  cursor: pointer;
  min-height: 24px;
}
.key-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
  margin: 8px 0;
}
.modifier {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}
select {
  min-height: 44px;
  padding: 6px;
}
.extra-keys[open] {
  max-height: 45vh;
  overflow: auto;
}
@media (orientation: landscape) and (max-height: 600px) {
  .direction-pad {
    grid-template-columns: repeat(3, 44px);
    gap: 3px;
  }
  .touch-main {
    gap: 8px;
  }
  .action-keys {
    min-width: 64px;
    gap: 3px;
  }
  .touch-controls {
    width: 220px;
  }
  .movement-help {
    font-size: 11px;
  }
}
</style>
