<script setup lang="ts">
/**
 * The AGI inspector's floating frame in Play mode (Create hosts the same
 * controls in its Inspect tab). Placement follows the usual inspector
 * pattern: docked just outside the frame's right edge by default so it
 * never covers the game; grab the header to float it anywhere over the
 * stage; the − button collapses it to a title strip. The controls and their
 * state live in inspector/; the marks over the stage are InspectorOverlay.
 */
import { ref, useTemplateRef } from "vue";
import InspectorView from "./inspector/InspectorView.vue";
import { useInspector } from "./inspector/useInspector.ts";

const emit = defineEmits<{ close: [] }>();

const { tab } = useInspector();
const collapsed = ref(false);
const dockEl = useTemplateRef("dock");

// ---------- placement: docked / floating drag / collapsed ----------

const floating = ref(false);
const floatPos = ref({ x: 8, y: 8 });
let drag: { px: number; py: number; ox: number; oy: number } | null = null;

function onHeadPointerDown(ev: PointerEvent): void {
  if ((ev.target as HTMLElement).closest("button")) return;
  const dock = dockEl.value;
  const host = dock?.offsetParent;
  if (!dock || !(host instanceof HTMLElement)) return;
  const hostRect = host.getBoundingClientRect();
  const dockRect = dock.getBoundingClientRect();
  floating.value = true;
  floatPos.value = {
    x: dockRect.left - hostRect.left,
    y: dockRect.top - hostRect.top,
  };
  drag = { px: ev.clientX, py: ev.clientY, ox: floatPos.value.x, oy: floatPos.value.y };
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
}

function onHeadPointerMove(ev: PointerEvent): void {
  if (!drag) return;
  const dock = dockEl.value;
  const host = dock?.offsetParent;
  const w = dock?.offsetWidth ?? 320;
  const h = host instanceof HTMLElement ? host.offsetHeight : 400;
  const hw = host instanceof HTMLElement ? host.offsetWidth : 640;
  floatPos.value = {
    x: Math.min(Math.max(drag.ox + ev.clientX - drag.px, -w + 48), hw - 48),
    y: Math.min(Math.max(drag.oy + ev.clientY - drag.py, 0), h - 36),
  };
}

function onHeadPointerUp(): void {
  drag = null;
}
</script>

<template>
  <aside
    ref="dock"
    class="debug-dock"
    :class="{ floating, collapsed }"
    :style="floating ? { '--fx': `${floatPos.x}px`, '--fy': `${floatPos.y}px` } : {}"
    data-testid="debug-dock"
    @click.stop
    @pointerdown.stop
  >
    <header
      class="dd-head"
      data-testid="dbg-head"
      title="Drag to float · − collapses · ⇥ re-docks"
      @pointerdown="onHeadPointerDown"
      @pointermove="onHeadPointerMove"
      @pointerup="onHeadPointerUp"
      @pointercancel="onHeadPointerUp"
    >
      <span class="dd-grip">⠿</span>
      <span class="dd-title">Inspector</span>
      <nav v-if="!collapsed" class="dd-tabs">
        <button
          v-for="t in ['screen', 'state', 'timeline'] as const"
          :key="t"
          type="button"
          class="dd-tab"
          :class="{ on: tab === t }"
          :data-testid="`dbg-tab-${t}`"
          @click="tab = t"
        >
          {{ t }}
        </button>
      </nav>
      <button
        v-if="floating"
        type="button"
        class="dd-icon-btn"
        title="Dock beside the frame"
        data-testid="dbg-dock-back"
        @click="floating = false"
      >
        ⇥
      </button>
      <button
        type="button"
        class="dd-icon-btn"
        :title="collapsed ? 'Expand' : 'Collapse'"
        data-testid="dbg-collapse"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? "+" : "−" }}
      </button>
      <button
        type="button"
        class="dd-icon-btn dd-close"
        title="Close inspector"
        @click="emit('close')"
      >
        ×
      </button>
    </header>
    <InspectorView v-if="!collapsed" />
  </aside>
</template>

<style scoped>
.debug-dock {
  position: absolute;
  z-index: 6;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 320px;
  overflow: hidden;
  border: 1px solid var(--action-line);
  border-radius: var(--radius-lg);
  color: var(--ink-2);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}

/* Docked: parked just outside the frame's right edge, never covering play. */
.debug-dock:not(.floating) {
  top: 0;
  bottom: 0;
  left: calc(100% + 12px);
}

/* Floating: user-dragged over the stage, clamped inside the frame. */
.debug-dock.floating {
  top: 0;
  left: 0;
  max-height: calc(100% - 12px);
  transform: translate(var(--fx, 8px), var(--fy, 8px));
}

/* Narrow/portrait screens: the docked position would overflow the viewport,
   so it starts as an in-frame floating panel instead. */
@media (max-width: 1340px), (orientation: portrait) {
  .debug-dock:not(.floating) {
    top: var(--space-3);
    right: var(--space-3);
    bottom: var(--space-3);
    left: auto;
    width: min(320px, 62%);
  }
}

.debug-dock.collapsed {
  bottom: auto;
  height: auto;
}

.dd-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-2);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.dd-head:active {
  cursor: grabbing;
}
.collapsed .dd-head {
  border-bottom: none;
}
.collapsed .dd-head > button:first-of-type {
  margin-left: auto;
}
.dd-grip {
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.dd-title {
  color: var(--action);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
}
.dd-tabs {
  display: flex;
  gap: var(--space-0);
  margin-left: auto;
  padding: var(--space-0);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-0);
}
.dd-tab {
  padding: 3px var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: none;
  font: inherit;
  font-size: var(--text-2xs);
  text-transform: capitalize;
  cursor: pointer;
}
.dd-tab.on {
  color: var(--action-ink);
  background: var(--action);
}
.dd-icon-btn {
  padding: var(--space-0) var(--space-1);
  border: none;
  color: var(--ink-3);
  background: none;
  font: inherit;
  font-size: var(--text-sm);
  line-height: 1;
  cursor: pointer;
}
.dd-icon-btn:hover {
  color: var(--action-hover);
}
@media (any-pointer: coarse) {
  .dd-icon-btn {
    min-width: var(--control-h-touch);
    min-height: var(--control-h-touch);
    padding: var(--space-4);
    font-size: var(--text-lg);
  }
}
.dd-close:hover {
  color: var(--danger-hover);
}
</style>
