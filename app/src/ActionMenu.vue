<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef } from "vue";
import UiButton from "./ui/UiButton.vue";
import UiIconButton from "./ui/UiIconButton.vue";

const {
  testId = undefined,
  iconOnly = false,
  icon = "chevron-down",
  disabled = false,
} = defineProps<{
  label: string;
  testId?: string | undefined;
  iconOnly?: boolean;
  icon?: "ellipsis" | "chevron-down";
  disabled?: boolean;
}>();

const trigger = useTemplateRef("trigger");
const triggerEl = computed(() => trigger.value?.$el);
const menu = useTemplateRef("menu");
const open = ref(false);
const positioned = ref(false);
const menuStyle = ref<Record<string, string>>({});
const menuId = useId();
const openingFocus = ref<"first" | "last">("first");
const anchorPosition = ref<{ left: number; top: number }>();
let keyboardFocusExit = false;
let popupPointerActive = false;

function menuItems(): HTMLElement[] {
  if (!menu.value) return [];
  return Array.from(
    menu.value.querySelectorAll<HTMLElement>(
      ':is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):not([disabled]):not([aria-disabled="true"])',
    ),
  );
}

function removeWindowListeners(): void {
  window.removeEventListener("pointerdown", onOutsidePointerDown, true);
  window.removeEventListener("resize", closeWithoutFocus);
  window.removeEventListener("scroll", onWindowScroll, true);
}

function closeWithoutFocus(): void {
  open.value = false;
  positioned.value = false;
  anchorPosition.value = undefined;
  removeWindowListeners();
}

function closeAndRestoreFocus(): void {
  closeWithoutFocus();
  void nextTick(() => triggerEl.value?.focus({ preventScroll: true }));
}

function onWindowScroll(event: Event): void {
  const target = event.target;
  if (target instanceof Node && menu.value?.contains(target)) return;
  const anchor = anchorPosition.value;
  if (!anchor || !triggerEl.value) return;
  const current = triggerEl.value.getBoundingClientRect();
  if (Math.abs(current.left - anchor.left) > 0.5 || Math.abs(current.top - anchor.top) > 0.5)
    closeWithoutFocus();
}

function onOutsidePointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!triggerEl.value?.contains(target) && !menu.value?.contains(target)) closeWithoutFocus();
}

async function positionMenu(): Promise<void> {
  await nextTick();
  const triggerRectEl = triggerEl.value;
  if (!open.value || !triggerRectEl || !menu.value) return;

  const gutter = 8;
  const gap = 6;
  const triggerRect = triggerRectEl.getBoundingClientRect();
  const menuRect = menu.value.getBoundingClientRect();
  const width = Math.min(
    Math.max(triggerRect.width, menuRect.width),
    window.innerWidth - gutter * 2,
  );
  const left = Math.min(Math.max(gutter, triggerRect.left), window.innerWidth - width - gutter);
  const roomBelow = window.innerHeight - triggerRect.bottom - gutter;
  const top =
    menuRect.height > roomBelow && triggerRect.top > roomBelow
      ? Math.max(gutter, triggerRect.top - menuRect.height - gap)
      : Math.min(triggerRect.bottom + gap, window.innerHeight - menuRect.height - gutter);

  menuStyle.value = { left: `${left}px`, top: `${Math.max(gutter, top)}px`, width: `${width}px` };
  anchorPosition.value = { left: triggerRect.left, top: triggerRect.top };
  positioned.value = true;
  await nextTick();
  if (!open.value) return;
  const items = menuItems();
  const item = openingFocus.value === "last" ? items.at(-1) : items[0];
  item?.focus({ preventScroll: true });
}

function openMenu(initialFocus: "first" | "last" = "first"): void {
  if (disabled) return;
  openingFocus.value = initialFocus;
  open.value = true;
  window.addEventListener("pointerdown", onOutsidePointerDown, true);
  window.addEventListener("resize", closeWithoutFocus);
  window.addEventListener("scroll", onWindowScroll, true);
  void positionMenu();
}

function toggleMenu(): void {
  if (open.value) closeAndRestoreFocus();
  else openMenu();
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeAndRestoreFocus();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

  event.preventDefault();
  event.stopPropagation();
  const items = menuItems();
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let item: HTMLElement | undefined;
  if (event.key === "Home") item = items[0];
  else if (event.key === "End") item = items.at(-1);
  else if (event.key === "ArrowDown") item = items[(current + 1 + items.length) % items.length];
  else item = items[(current - 1 + items.length) % items.length];
  item?.focus({ preventScroll: true });
}

function onTabKeydown(): void {
  keyboardFocusExit = true;
}

function onPopupPointerDown(): void {
  popupPointerActive = true;
  window.setTimeout(() => {
    popupPointerActive = false;
  });
}

function onFocusOut(event: FocusEvent): void {
  const keyboardDeparture = keyboardFocusExit;
  keyboardFocusExit = false;
  if (popupPointerActive) return;
  const relatedTarget = event.relatedTarget;
  window.setTimeout(() => {
    const active = document.activeElement;
    if (triggerEl.value?.contains(active) || menu.value?.contains(active)) return;
    if (keyboardDeparture || (relatedTarget instanceof Node && relatedTarget !== document.body))
      closeWithoutFocus();
  });
}

function onMenuClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const item = target.closest<HTMLElement>(
    ':is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"])',
  );
  if (!item) return;
  if (
    item.matches('[role="menuitemcheckbox"], [role="menuitemradio"]') ||
    item.hasAttribute("data-keep-open")
  ) {
    item.focus({ preventScroll: true });
    return;
  }

  window.setTimeout(() => {
    if (!open.value) return;
    const focusStayedInMenu =
      document.activeElement === document.body ||
      (menu.value?.contains(document.activeElement) ?? false);
    closeWithoutFocus();
    if (focusStayedInMenu) triggerEl.value?.focus();
  });
}

onBeforeUnmount(removeWindowListeners);
</script>

<template>
  <span class="action-menu" @focusout="onFocusOut" @keydown.tab="onTabKeydown">
    <UiIconButton
      v-if="iconOnly"
      ref="trigger"
      :icon="icon"
      :label="label"
      class="action-menu__trigger action-menu__trigger--icon"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      :data-testid="testId"
      :disabled
      @click="toggleMenu"
      @keydown.down.stop.prevent="openMenu('first')"
      @keydown.up.stop.prevent="openMenu('last')"
      @keydown.esc.stop.prevent="closeAndRestoreFocus"
    />
    <UiButton
      v-else
      ref="trigger"
      class="action-menu__trigger"
      :trailing-icon="icon"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      :data-testid="testId"
      :disabled
      @click="toggleMenu"
      @keydown.down.stop.prevent="openMenu('first')"
      @keydown.up.stop.prevent="openMenu('last')"
      @keydown.esc.stop.prevent="closeAndRestoreFocus"
    >
      {{ label }}
    </UiButton>
    <Teleport to="body">
      <div
        v-if="open"
        :id="menuId"
        ref="menu"
        class="action-menu__popup"
        :class="{ 'action-menu__popup--positioned': positioned }"
        role="menu"
        :aria-label="label"
        :data-testid="testId ? `${testId}-menu` : undefined"
        :style="menuStyle"
        @keydown="onMenuKeydown"
        @keydown.tab="onTabKeydown"
        @pointerdown.capture="onPopupPointerDown"
        @click="onMenuClick"
        @focusout="onFocusOut"
      >
        <!--
          Slot children are the menu items (role="menuitem", "menuitemcheckbox"
          or "menuitemradio"). Put <div role="separator"></div> between groups:
          it is drawn as a rule and skipped by keyboard navigation.
        -->
        <slot />
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.action-menu {
  display: inline-flex;
}
.action-menu__popup {
  position: fixed;
  z-index: var(--z-popover);
  display: grid;
  min-width: min(180px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 5px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-2);
  box-shadow: var(--shadow-pop);
  visibility: hidden;
}
.action-menu__popup--positioned {
  visibility: visible;
}
.action-menu__popup :deep([role="separator"]) {
  height: 1px;
  margin: 4px 2px;
  border: 0;
  background: var(--hairline-strong);
}
.action-menu__popup
  :deep(:is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"])) {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: var(--control-h-touch);
  box-sizing: border-box;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: transparent;
  font: var(--weight-bold) var(--text-md) / 1.4 var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.action-menu__popup
  :deep(
    :is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):hover:not(:disabled)
  ),
.action-menu__popup
  :deep(:is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):focus-visible) {
  color: var(--ink);
  background: var(--surface-3);
}
.action-menu__popup
  :deep(:is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]).danger),
.action-menu__popup
  :deep(
    :is(
      [role="menuitem"],
      [role="menuitemcheckbox"],
      [role="menuitemradio"]
    ).action-menu-item--danger
  ),
.action-menu__popup
  :deep(
    :is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]).ui-button--danger
  ) {
  color: var(--danger);
}
.action-menu__popup
  :deep(:is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):disabled),
.action-menu__popup
  :deep(
    :is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"])[aria-disabled="true"]
  ) {
  cursor: not-allowed;
  opacity: 0.55;
}
.action-menu__popup
  :deep(:is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]) small) {
  display: block;
  color: var(--ink-3);
  font-size: var(--text-xs);
  font-weight: 400;
}
</style>
