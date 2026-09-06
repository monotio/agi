<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from "vue";
import UiIcon from "./UiIcon.vue";

const props = withDefaults(
  defineProps<{
    label: string;
    testId?: string | undefined;
    iconOnly?: boolean;
    icon?: "more" | "chevron";
    disabled?: boolean;
  }>(),
  {
    testId: undefined,
    iconOnly: false,
    icon: "chevron",
    disabled: false,
  },
);

const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const positioned = ref(false);
const menuStyle = ref<Record<string, string>>({});
const menuId = useId();
const openingFocus = ref<"first" | "last">("first");
const anchorPosition = ref<{ left: number; top: number } | null>(null);
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
  anchorPosition.value = null;
  removeWindowListeners();
}

function closeAndRestoreFocus(): void {
  closeWithoutFocus();
  void nextTick(() => trigger.value?.focus({ preventScroll: true }));
}

function onWindowScroll(event: Event): void {
  const target = event.target;
  if (target instanceof Node && menu.value?.contains(target)) return;
  const anchor = anchorPosition.value;
  if (!anchor || !trigger.value) return;
  const current = trigger.value.getBoundingClientRect();
  if (Math.abs(current.left - anchor.left) > 0.5 || Math.abs(current.top - anchor.top) > 0.5)
    closeWithoutFocus();
}

function onOutsidePointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!trigger.value?.contains(target) && !menu.value?.contains(target)) closeWithoutFocus();
}

async function positionMenu(): Promise<void> {
  await nextTick();
  if (!open.value || !trigger.value || !menu.value) return;

  const gutter = 8;
  const gap = 6;
  const triggerRect = trigger.value.getBoundingClientRect();
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
  if (props.disabled) return;
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
    if (trigger.value?.contains(active) || menu.value?.contains(active)) return;
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
    if (focusStayedInMenu) trigger.value?.focus();
  });
}

onBeforeUnmount(removeWindowListeners);
</script>

<template>
  <span class="action-menu" @focusout="onFocusOut" @keydown.tab="onTabKeydown">
    <button
      ref="trigger"
      type="button"
      class="ui-button ui-button--secondary"
      :class="{ 'ui-button--icon': iconOnly }"
      :aria-label="iconOnly ? label : undefined"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      :data-testid="testId"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown.down.stop.prevent="openMenu('first')"
      @keydown.up.stop.prevent="openMenu('last')"
      @keydown.esc.stop.prevent="closeAndRestoreFocus"
    >
      <span v-if="!iconOnly">{{ label }}</span>
      <UiIcon :name="icon" />
    </button>
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
  z-index: 1000;
  display: grid;
  min-width: min(180px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 5px;
  border: 1px solid #507477;
  border-radius: 6px;
  background: #10191b;
  box-shadow: 0 10px 24px #000b;
  visibility: hidden;
}
.action-menu__popup--positioned {
  visibility: visible;
}
.action-menu__popup
  :deep(:is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"])) {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 0;
  border-radius: 4px;
  color: #dcecec;
  background: transparent;
  font:
    700 14px/1.4 system-ui,
    sans-serif;
  text-align: left;
  cursor: pointer;
}
.action-menu__popup
  :deep(
    :is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):hover:not(:disabled)
  ),
.action-menu__popup
  :deep(:is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):focus-visible) {
  color: #fff;
  background: #203537;
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
  color: var(--ui-danger);
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
  color: #8fa7a9;
  font-size: 12px;
  font-weight: 400;
}
</style>
