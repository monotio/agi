<script setup lang="ts">
import { computed, ref, useTemplateRef, watch, watchEffect } from "vue";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { EngineStateReport } from "../../../../src/runtime/engine.ts";
import { newLaunchId, type Launch, type RoomLaunches } from "../../../../src/authoring/launches.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import { createPictureSurface } from "../../../../src/types.ts";
import { renderPicture } from "../../../../src/picture/renderer.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiButton from "../../ui/UiButton.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import UiDialog from "../../ui/UiDialog.vue";
import UiSwitch from "../../ui/UiSwitch.vue";

const props = defineProps<{
  room: number;
  roomName: string;
  readOnly?: boolean;
  launches: RoomLaunches | undefined;
  selectedLaunchId: string | undefined;
  livePreview: { state: EngineStateReport | null };
  pictureBytes: Uint8Array | undefined;
  profile: AgiProfile;
  bindings: string;
  inventory: readonly { num: number; name: string }[];
  rooms: readonly { room: number; title: string }[];
}>();

const emit = defineEmits<{
  edit: [launches: RoomLaunches];
  selectLaunch: [id: string];
  close: [];
}>();

const currentLaunchId = ref<string>("");
const confirmRemoveOpen = ref(false);

const entries = computed<Launch[]>(() => props.launches?.entries ?? []);

watch(
  entries,
  (list) => {
    if (list.length === 0) {
      currentLaunchId.value = "";
    } else if (!list.some((entry) => entry.id === currentLaunchId.value)) {
      currentLaunchId.value = list[0]!.id;
    }
  },
  { immediate: true },
);

const activeLaunch = computed<Launch | undefined>(() =>
  entries.value.find((entry) => entry.id === currentLaunchId.value),
);

const isSelectedForRun = computed(
  () => activeLaunch.value !== undefined && props.selectedLaunchId === activeLaunch.value.id,
);

const boundFlags = computed(() => {
  try {
    return Object.entries(readBindingsDocument(props.bindings))
      .filter(([, binding]) => binding.kind === "flag")
      .map(([name, binding]) => ({ name, num: binding.num }))
      .sort((a, b) => a.num - b.num);
  } catch {
    return [];
  }
});

const boundVars = computed(() => {
  try {
    return Object.entries(readBindingsDocument(props.bindings))
      .filter(([, binding]) => binding.kind === "variable")
      .map(([name, binding]) => ({ name, num: binding.num }))
      .sort((a, b) => a.num - b.num);
  } catch {
    return [];
  }
});

function itemName(num: number): string {
  const match = props.inventory.find((i) => i.num === num);
  return match ? `${match.name} (${num})` : `Item ${num}`;
}

function roomTitle(num: number): string {
  const match = props.rooms.find((r) => r.room === num);
  return match?.title ? `${match.title} (${num})` : `Room ${num}`;
}

const flagOptions = computed(() => {
  const result: { num: number; label: string }[] = [];
  const boundNums = new Set<number>();
  for (const f of boundFlags.value) {
    boundNums.add(f.num);
    result.push({ num: f.num, label: `${f.name} (Flag ${f.num})` });
  }
  for (let i = 1; i <= 255; i++) {
    if (!boundNums.has(i)) {
      result.push({ num: i, label: `Flag ${i}` });
    }
  }
  return result;
});

const varOptions = computed(() => {
  const result: { num: number; label: string }[] = [];
  const boundNums = new Set<number>();
  for (const v of boundVars.value) {
    boundNums.add(v.num);
    result.push({ num: v.num, label: `${v.name} (Variable ${v.num})` });
  }
  for (let i = 0; i <= 255; i++) {
    if (!boundNums.has(i)) {
      result.push({ num: i, label: `Variable ${i}` });
    }
  }
  return result;
});

function updateFlagNum(oldNum: string, newNum: number): void {
  if (!activeLaunch.value?.flags) return;
  const currentVal = activeLaunch.value.flags[oldNum] ?? false;
  const flags = { ...activeLaunch.value.flags };
  delete flags[oldNum];
  flags[String(newNum)] = currentVal;
  commitLaunch({ ...activeLaunch.value, flags });
}

function updateVarNum(oldNum: string, newNum: number): void {
  if (!activeLaunch.value?.variables) return;
  const currentVal = activeLaunch.value.variables[oldNum] ?? 0;
  const variables = { ...activeLaunch.value.variables };
  delete variables[oldNum];
  variables[String(newNum)] = currentVal;
  commitLaunch({ ...activeLaunch.value, variables });
}

function updateItemNum(oldNum: string, newNum: number): void {
  if (!activeLaunch.value?.items) return;
  const currentVal = activeLaunch.value.items[oldNum] ?? 255;
  const items = { ...activeLaunch.value.items };
  delete items[oldNum];
  items[String(newNum)] = currentVal;
  commitLaunch({ ...activeLaunch.value, items });
}

function commitLaunch(launch: Launch): void {
  const list = entries.value.map((entry) => (entry.id === launch.id ? { ...launch } : entry));
  emit("edit", {
    ...(props.launches?.selected ? { selected: props.launches.selected } : {}),
    entries: list,
  });
}

function createNewLaunch(): void {
  const id = newLaunchId(props.launches);
  const count = entries.value.length + 1;
  const name = `Launch ${count}`;
  const newEntry: Launch = { id, name };
  const nextEntries = [...entries.value, newEntry];
  currentLaunchId.value = id;
  emit("edit", {
    ...(props.launches?.selected ? { selected: props.launches.selected } : {}),
    entries: nextEntries,
  });
}

function duplicateCurrentLaunch(): void {
  const source = activeLaunch.value;
  if (!source) return;
  const id = newLaunchId(props.launches);
  const copy: Launch = {
    ...structuredClone(source),
    id,
    name: `Copy of ${source.name}`,
  };
  const nextEntries = [...entries.value, copy];
  currentLaunchId.value = id;
  emit("edit", {
    ...(props.launches?.selected ? { selected: props.launches.selected } : {}),
    entries: nextEntries,
  });
}

function removeCurrentLaunch(): void {
  const current = activeLaunch.value;
  if (!current) return;
  confirmRemoveOpen.value = false;
  const nextEntries = entries.value.filter((entry) => entry.id !== current.id);
  const selected = props.launches?.selected === current.id ? undefined : props.launches?.selected;
  emit("edit", {
    ...(selected !== undefined ? { selected } : {}),
    entries: nextEntries,
  });
}

function updateLaunchName(event: Event): void {
  const target = event.target as HTMLInputElement;
  const val = target.value.trim() || "Launch";
  if (!activeLaunch.value) return;
  commitLaunch({ ...activeLaunch.value, name: val });
}

function updateLaunchNote(event: Event): void {
  const target = event.target as HTMLInputElement;
  const val = target.value.trim();
  if (!activeLaunch.value) return;
  const updated = { ...activeLaunch.value };
  if (val) updated.note = val;
  else delete updated.note;
  commitLaunch(updated);
}

// ---- Adding rows with current game values --------------------------------

function addCameFrom(): void {
  if (!activeLaunch.value) return;
  const prev = props.livePreview.state?.previousRoom;
  const room = prev !== undefined && prev >= 1 && prev <= 255 ? prev : 1;
  commitLaunch({
    ...activeLaunch.value,
    cameFrom: { room },
  });
}

function addFlag(): void {
  if (!activeLaunch.value) return;
  const used = new Set(Object.keys(activeLaunch.value.flags ?? {}).map(Number));
  let pick = 1;
  for (let i = 1; i <= 255; i++) {
    if (i === 5) continue;
    if (!used.has(i)) {
      pick = i;
      break;
    }
  }
  const liveVal = Boolean(props.livePreview.state?.flags[pick]);
  const flags = { ...(activeLaunch.value.flags ?? {}), [String(pick)]: liveVal };
  commitLaunch({ ...activeLaunch.value, flags });
}

function addVariable(): void {
  if (!activeLaunch.value) return;
  const used = new Set(Object.keys(activeLaunch.value.variables ?? {}).map(Number));
  let pick = 1;
  for (let i = 1; i <= 255; i++) {
    if (i === 0 || i === 2) continue;
    if (!used.has(i)) {
      pick = i;
      break;
    }
  }
  const liveVal = props.livePreview.state?.vars[pick] ?? 0;
  const variables = { ...(activeLaunch.value.variables ?? {}), [String(pick)]: liveVal };
  commitLaunch({ ...activeLaunch.value, variables });
}

function addItem(): void {
  if (!activeLaunch.value) return;
  const used = new Set(Object.keys(activeLaunch.value.items ?? {}).map(Number));
  let pick = 0;
  for (const item of props.inventory) {
    if (!used.has(item.num)) {
      pick = item.num;
      break;
    }
  }
  const liveLoc = props.livePreview.state?.inventory.find((i) => i.num === pick)?.room ?? 255;
  const items = { ...(activeLaunch.value.items ?? {}), [String(pick)]: liveLoc };
  commitLaunch({ ...activeLaunch.value, items });
}

function addSeed(): void {
  if (!activeLaunch.value) return;
  commitLaunch({ ...activeLaunch.value, seed: 58235 });
}

function addHero(): void {
  if (!activeLaunch.value) return;
  const x = props.livePreview.state?.egoX ?? 80;
  const y = props.livePreview.state?.egoY ?? 120;
  commitLaunch({
    ...activeLaunch.value,
    hero: {
      x: Math.max(0, Math.min(159, x)),
      y: Math.max(0, Math.min(167, y)),
    },
  });
}

// ---- Row editing and deletions -------------------------------------------

function removeRow(kind: "cameFrom" | "seed" | "hero"): void {
  if (!activeLaunch.value) return;
  const updated = { ...activeLaunch.value };
  delete updated[kind];
  commitLaunch(updated);
}

function updateCameFromRoom(event: Event): void {
  const room = Number((event.target as HTMLSelectElement).value);
  if (!activeLaunch.value?.cameFrom) return;
  commitLaunch({
    ...activeLaunch.value,
    cameFrom: { ...activeLaunch.value.cameFrom, room },
  });
}

function updateCameFromEdge(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  if (!activeLaunch.value?.cameFrom) return;
  const edge = raw === "" ? undefined : (Number(raw) as 1 | 2 | 3 | 4);
  const cameFrom = { room: activeLaunch.value.cameFrom.room, ...(edge ? { edge } : {}) };
  commitLaunch({
    ...activeLaunch.value,
    cameFrom,
  });
}

function setFlagValue(key: string, value: boolean): void {
  if (!activeLaunch.value?.flags) return;
  commitLaunch({
    ...activeLaunch.value,
    flags: { ...activeLaunch.value.flags, [key]: value },
  });
}

function removeFlagRow(key: string): void {
  if (!activeLaunch.value?.flags) return;
  const flags = { ...activeLaunch.value.flags };
  delete flags[key];
  const updated = { ...activeLaunch.value };
  if (Object.keys(flags).length > 0) updated.flags = flags;
  else delete updated.flags;
  commitLaunch(updated);
}

function setVarValue(key: string, event: Event): void {
  const val = Math.max(0, Math.min(255, Number((event.target as HTMLInputElement).value)));
  if (!activeLaunch.value?.variables) return;
  commitLaunch({
    ...activeLaunch.value,
    variables: { ...activeLaunch.value.variables, [key]: val },
  });
}

function removeVarRow(key: string): void {
  if (!activeLaunch.value?.variables) return;
  const variables = { ...activeLaunch.value.variables };
  delete variables[key];
  const updated = { ...activeLaunch.value };
  if (Object.keys(variables).length > 0) updated.variables = variables;
  else delete updated.variables;
  commitLaunch(updated);
}

function setItemLocation(key: string, event: Event): void {
  const loc = Number((event.target as HTMLSelectElement).value);
  if (!activeLaunch.value?.items) return;
  commitLaunch({
    ...activeLaunch.value,
    items: { ...activeLaunch.value.items, [key]: loc },
  });
}

function removeItemRow(key: string): void {
  if (!activeLaunch.value?.items) return;
  const items = { ...activeLaunch.value.items };
  delete items[key];
  const updated = { ...activeLaunch.value };
  if (Object.keys(items).length > 0) updated.items = items;
  else delete updated.items;
  commitLaunch(updated);
}

function setSeedValue(event: Event): void {
  const seed = Math.max(0, Math.min(65535, Number((event.target as HTMLInputElement).value)));
  if (!activeLaunch.value) return;
  commitLaunch({ ...activeLaunch.value, seed });
}

function setHeroX(event: Event): void {
  const x = Math.max(0, Math.min(159, Number((event.target as HTMLInputElement).value)));
  if (!activeLaunch.value?.hero) return;
  commitLaunch({
    ...activeLaunch.value,
    hero: { ...activeLaunch.value.hero, x },
  });
}

function setHeroY(event: Event): void {
  const y = Math.max(0, Math.min(167, Number((event.target as HTMLInputElement).value)));
  if (!activeLaunch.value?.hero) return;
  commitLaunch({
    ...activeLaunch.value,
    hero: { ...activeLaunch.value.hero, y },
  });
}

// ---- Canvas rendering for hero position ----------------------------------

const heroCanvas = useTemplateRef("heroCanvas");

function renderHeroStage(): void {
  const canvasEl = heroCanvas.value;
  if (!canvasEl) return;
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return;

  if (props.pictureBytes) {
    const surface = createPictureSurface();
    renderPicture(props.pictureBytes, surface, { profile: props.profile });
    const imgData = ctx.createImageData(160, 168);
    for (let y = 0; y < 168; y++) {
      for (let x = 0; x < 160; x++) {
        const color = surface.visual[y * 160 + x] ?? 0;
        const rgba = EGA_PALETTE[color] ?? [0, 0, 0];
        const offset = (y * 160 + x) * 4;
        imgData.data[offset] = rgba[0]!;
        imgData.data[offset + 1] = rgba[1]!;
        imgData.data[offset + 2] = rgba[2]!;
        imgData.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  } else {
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, 160, 168);
  }

  // Draw hero crosshair marker
  const hero = activeLaunch.value?.hero;
  if (hero) {
    const hx = Math.max(0, Math.min(159, hero.x));
    const hy = Math.max(0, Math.min(167, hero.y));

    ctx.strokeStyle = "#ffff55";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(hx - 6, hy);
    ctx.lineTo(hx + 6, hy);
    ctx.moveTo(hx, hy - 6);
    ctx.lineTo(hx, hy + 6);
    ctx.stroke();
  }
}

watchEffect(() => {
  if (activeLaunch.value?.hero) {
    renderHeroStage();
  }
});

function handleCanvasDrag(event: MouseEvent): void {
  if (event.buttons !== 1 && event.type !== "click") return;
  const canvasEl = heroCanvas.value;
  if (!canvasEl || !activeLaunch.value?.hero) return;
  const rect = canvasEl.getBoundingClientRect();
  const rawX = Math.round(((event.clientX - rect.left) / rect.width) * 160);
  const rawY = Math.round(((event.clientY - rect.top) / rect.height) * 168);
  const x = Math.max(0, Math.min(159, rawX));
  const y = Math.max(0, Math.min(167, rawY));
  commitLaunch({
    ...activeLaunch.value,
    hero: { x, y },
  });
}
</script>

<template>
  <div class="launch-editor" data-testid="launch-editor">
    <header class="launch-editor__header">
      <div class="launch-editor__title-row">
        <h2 class="launch-editor__title">Launches · {{ roomName }}</h2>
        <UiButton size="sm" variant="ghost" data-testid="launch-editor-done" @click="emit('close')"
          >Done</UiButton
        >
      </div>

      <nav class="launch-editor__tabs" role="tablist" aria-label="Launches list">
        <button
          v-for="entry in entries"
          :key="entry.id"
          type="button"
          role="tab"
          class="launch-pill"
          :class="{ 'launch-pill--active': entry.id === currentLaunchId }"
          :aria-selected="entry.id === currentLaunchId"
          @click="currentLaunchId = entry.id"
        >
          <span>{{ entry.name || "Launch" }}</span>
          <span
            v-if="selectedLaunchId === entry.id"
            class="launch-pill__check"
            title="Selected to run"
            >✓</span
          >
        </button>
        <UiButton
          size="sm"
          variant="ghost"
          data-testid="launch-add-button"
          :disabled="readOnly"
          :title="readOnly ? 'Project is read-only' : ''"
          @click="createNewLaunch"
          >+ New launch</UiButton
        >
      </nav>
    </header>

    <div v-if="!activeLaunch" class="launch-editor__empty">
      <p class="launch-editor__empty-title">No launches saved for this room yet.</p>
      <p class="launch-editor__empty-hint">
        A Launch lets you test this room with custom entry state: where the hero came from, flags,
        variables, items, random seed or hero position.
      </p>
      <UiButton
        size="md"
        data-testid="launch-empty-add"
        :disabled="readOnly"
        :title="readOnly ? 'Project is read-only' : ''"
        @click="createNewLaunch"
        >+ New launch</UiButton
      >
    </div>

    <div v-else class="launch-editor__body">
      <div class="launch-editor__toolbar">
        <input
          type="text"
          class="launch-name-input"
          data-testid="launch-name-input"
          :value="activeLaunch.name"
          placeholder="Launch name"
          aria-label="Launch name"
          :disabled="readOnly"
          @change="updateLaunchName"
        />

        <div class="launch-editor__actions">
          <span
            v-if="isSelectedForRun"
            class="launch-selected-badge"
            data-testid="launch-selected-badge"
            title="This launch runs when you Play, Restart or Debug"
            >✓ Selected for run</span
          >
          <UiButton
            v-else
            size="sm"
            variant="ghost"
            data-testid="launch-select-for-run"
            :disabled="readOnly"
            :title="readOnly ? 'Project is read-only' : ''"
            @click="emit('selectLaunch', activeLaunch.id)"
            >Select for run</UiButton
          >

          <UiButton
            size="sm"
            variant="ghost"
            data-testid="launch-duplicate"
            :disabled="readOnly"
            :title="readOnly ? 'Project is read-only' : ''"
            @click="duplicateCurrentLaunch"
            >Duplicate</UiButton
          >

          <UiButton
            size="sm"
            variant="ghost"
            data-testid="launch-remove"
            :disabled="readOnly"
            :title="readOnly ? 'Project is read-only' : ''"
            @click="confirmRemoveOpen = true"
            >Remove…</UiButton
          >
        </div>
      </div>

      <div class="launch-editor__note-row">
        <input
          type="text"
          class="launch-note-input"
          data-testid="launch-note-input"
          :value="activeLaunch.note ?? ''"
          placeholder="Note (optional)"
          aria-label="Note"
          :disabled="readOnly"
          @change="updateLaunchNote"
        />
      </div>

      <div class="launch-editor__rows">
        <!-- Came from row -->
        <div v-if="activeLaunch.cameFrom" class="launch-row" data-testid="launch-row-came-from">
          <div class="launch-row__label">
            <strong>Came from</strong>
            <small>where the hero walked out</small>
          </div>
          <div class="launch-row__controls">
            <select
              class="launch-select"
              data-testid="launch-came-from-room"
              aria-label="Came from room"
              :value="activeLaunch.cameFrom.room"
              :disabled="readOnly"
              @change="updateCameFromRoom"
            >
              <option v-for="r in rooms" :key="r.room" :value="r.room">
                {{ roomTitle(r.room) }}
              </option>
            </select>

            <select
              class="launch-select"
              data-testid="launch-came-from-edge"
              aria-label="Edge where the hero walked out"
              :value="activeLaunch.cameFrom.edge ?? ''"
              :disabled="readOnly"
              @change="updateCameFromEdge"
            >
              <option value="">No edge</option>
              <option :value="1">Top (where the hero walked out)</option>
              <option :value="2">Right (where the hero walked out)</option>
              <option :value="3">Bottom (where the hero walked out)</option>
              <option :value="4">Left (where the hero walked out)</option>
            </select>
          </div>
          <UiIconButton
            icon="trash"
            size="sm"
            label="Remove came from row"
            data-testid="launch-remove-came-from"
            :disabled="readOnly"
            :title="readOnly ? 'Project is read-only' : 'Remove came from row'"
            @click="removeRow('cameFrom')"
          />
        </div>

        <!-- Flags rows -->
        <template v-if="activeLaunch.flags && Object.keys(activeLaunch.flags).length > 0">
          <div
            v-for="(val, flagNum) in activeLaunch.flags"
            :key="flagNum"
            class="launch-row"
            data-testid="launch-row-flag"
          >
            <div class="launch-row__label">
              <strong>Flag</strong>
              <small>named toggle</small>
            </div>
            <div class="launch-row__controls">
              <select
                class="launch-select"
                data-testid="launch-flag-select"
                aria-label="Flag picker"
                :value="Number(flagNum)"
                :disabled="readOnly"
                @change="
                  updateFlagNum(String(flagNum), Number(($event.target as HTMLSelectElement).value))
                "
              >
                <option v-for="opt in flagOptions" :key="opt.num" :value="opt.num">
                  {{ opt.label }}
                </option>
              </select>

              <UiSwitch
                size="sm"
                data-testid="launch-flag-toggle"
                :model-value="val"
                :disabled="readOnly"
                @update:model-value="setFlagValue(String(flagNum), $event)"
              >
                <span>{{ val ? "On" : "Off" }}</span>
              </UiSwitch>
            </div>
            <UiIconButton
              icon="trash"
              size="sm"
              label="Remove flag row"
              data-testid="launch-remove-flag"
              :disabled="readOnly"
              :title="readOnly ? 'Project is read-only' : 'Remove flag row'"
              @click="removeFlagRow(String(flagNum))"
            />
          </div>
        </template>

        <!-- Variables rows -->
        <template v-if="activeLaunch.variables && Object.keys(activeLaunch.variables).length > 0">
          <div
            v-for="(val, varNum) in activeLaunch.variables"
            :key="varNum"
            class="launch-row"
            data-testid="launch-row-var"
          >
            <div class="launch-row__label">
              <strong>Variable</strong>
              <small>named number</small>
            </div>
            <div class="launch-row__controls">
              <select
                class="launch-select"
                data-testid="launch-var-select"
                aria-label="Variable picker"
                :value="Number(varNum)"
                :disabled="readOnly"
                @change="
                  updateVarNum(String(varNum), Number(($event.target as HTMLSelectElement).value))
                "
              >
                <option v-for="opt in varOptions" :key="opt.num" :value="opt.num">
                  {{ opt.label }}
                </option>
              </select>

              <input
                type="number"
                min="0"
                max="255"
                class="launch-number-input"
                data-testid="launch-var-value"
                aria-label="Variable value"
                :value="val"
                :disabled="readOnly"
                @change="setVarValue(String(varNum), $event)"
              />
            </div>
            <UiIconButton
              icon="trash"
              size="sm"
              label="Remove variable row"
              data-testid="launch-remove-var"
              :disabled="readOnly"
              :title="readOnly ? 'Project is read-only' : 'Remove variable row'"
              @click="removeVarRow(String(varNum))"
            />
          </div>
        </template>

        <!-- Items rows -->
        <template v-if="activeLaunch.items && Object.keys(activeLaunch.items).length > 0">
          <div
            v-for="(loc, itemNum) in activeLaunch.items"
            :key="itemNum"
            class="launch-row"
            data-testid="launch-row-item"
          >
            <div class="launch-row__label">
              <strong>Item</strong>
              <small>{{ itemName(Number(itemNum)) }}</small>
            </div>
            <div class="launch-row__controls">
              <select
                class="launch-select"
                data-testid="launch-item-select"
                aria-label="Item picker"
                :value="Number(itemNum)"
                :disabled="readOnly"
                @change="
                  updateItemNum(String(itemNum), Number(($event.target as HTMLSelectElement).value))
                "
              >
                <option v-for="item in inventory" :key="item.num" :value="item.num">
                  {{ item.name }} ({{ item.num }})
                </option>
              </select>

              <select
                class="launch-select"
                data-testid="launch-item-location"
                aria-label="Item location"
                :value="loc"
                :disabled="readOnly"
                @change="setItemLocation(String(itemNum), $event)"
              >
                <option :value="255">With hero</option>
                <option :value="0">Away</option>
                <option v-for="r in rooms" :key="r.room" :value="r.room">
                  {{ roomTitle(r.room) }}
                </option>
              </select>
            </div>
            <UiIconButton
              icon="trash"
              size="sm"
              label="Remove item row"
              data-testid="launch-remove-item"
              :disabled="readOnly"
              :title="readOnly ? 'Project is read-only' : 'Remove item row'"
              @click="removeItemRow(String(itemNum))"
            />
          </div>
        </template>

        <!-- Seed row -->
        <div
          v-if="activeLaunch.seed !== undefined"
          class="launch-row"
          data-testid="launch-row-seed"
        >
          <div class="launch-row__label">
            <strong>Same random each time</strong>
            <small>random seed (0–65535)</small>
          </div>
          <div class="launch-row__controls">
            <input
              type="number"
              min="0"
              max="65535"
              class="launch-number-input"
              aria-label="Random seed"
              :value="activeLaunch.seed"
              :disabled="readOnly"
              @change="setSeedValue"
            />
          </div>
          <UiIconButton
            icon="trash"
            size="sm"
            label="Remove seed row"
            data-testid="launch-remove-seed"
            :disabled="readOnly"
            :title="readOnly ? 'Project is read-only' : 'Remove seed row'"
            @click="removeRow('seed')"
          />
        </div>

        <!-- Hero position row -->
        <div
          v-if="activeLaunch.hero"
          class="launch-row launch-row--hero"
          data-testid="launch-row-hero"
        >
          <div class="launch-row__label">
            <strong>Hero position</strong>
            <small>drag on room picture or set X / Y</small>
          </div>
          <div class="launch-row__controls launch-row__controls--hero">
            <div class="launch-hero-inputs">
              <label>
                <span>X</span>
                <input
                  type="number"
                  min="0"
                  max="159"
                  class="launch-coord-input"
                  aria-label="Hero X position"
                  :value="activeLaunch.hero.x"
                  :disabled="readOnly"
                  @change="setHeroX"
                />
              </label>
              <label>
                <span>Y</span>
                <input
                  type="number"
                  min="0"
                  max="167"
                  class="launch-coord-input"
                  aria-label="Hero Y position"
                  :value="activeLaunch.hero.y"
                  :disabled="readOnly"
                  @change="setHeroY"
                />
              </label>
            </div>
            <div class="launch-canvas-wrapper">
              <canvas
                ref="heroCanvas"
                width="160"
                height="168"
                class="launch-canvas"
                aria-label="Room picture hero position"
                @mousedown="handleCanvasDrag"
                @mousemove="handleCanvasDrag"
                @click="handleCanvasDrag"
              ></canvas>
            </div>
          </div>
          <UiIconButton
            icon="trash"
            size="sm"
            label="Remove hero position row"
            data-testid="launch-remove-hero"
            :disabled="readOnly"
            :title="readOnly ? 'Project is read-only' : 'Remove hero position row'"
            @click="removeRow('hero')"
          />
        </div>

        <p
          v-if="
            !activeLaunch.cameFrom &&
            (!activeLaunch.flags || Object.keys(activeLaunch.flags).length === 0) &&
            (!activeLaunch.variables || Object.keys(activeLaunch.variables).length === 0) &&
            (!activeLaunch.items || Object.keys(activeLaunch.items).length === 0) &&
            activeLaunch.seed === undefined &&
            !activeLaunch.hero
          "
          class="launch-empty-rows"
        >
          This launch is empty. Everything carries over from the running game.
        </p>
      </div>

      <div class="launch-editor__footer">
        <ActionMenu label="+ Add row" test-id="launch-add-row-menu" size="sm" :disabled="readOnly">
          <button
            type="button"
            role="menuitem"
            :disabled="Boolean(activeLaunch.cameFrom)"
            :title="activeLaunch.cameFrom ? 'Came from is already set' : ''"
            @click="addCameFrom"
          >
            Came from
          </button>
          <button type="button" role="menuitem" @click="addFlag">Flag</button>
          <button type="button" role="menuitem" @click="addVariable">Variable</button>
          <button
            type="button"
            role="menuitem"
            :disabled="inventory.length === 0"
            :title="inventory.length === 0 ? 'No items in game' : ''"
            @click="addItem"
          >
            Item
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="activeLaunch.seed !== undefined"
            :title="activeLaunch.seed !== undefined ? 'Seed is already set' : ''"
            @click="addSeed"
          >
            Same random each time
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="Boolean(activeLaunch.hero)"
            :title="activeLaunch.hero ? 'Hero position is already set' : ''"
            @click="addHero"
          >
            Hero position
          </button>
        </ActionMenu>
      </div>
    </div>

    <!-- Confirm remove dialog -->
    <UiDialog
      v-model:open="confirmRemoveOpen"
      title="Remove launch"
      :description="`Remove “${activeLaunch?.name || 'this launch'}”? This cannot be undone.`"
    >
      <template #footer>
        <UiButton variant="ghost" @click="confirmRemoveOpen = false">Cancel</UiButton>
        <UiButton
          data-testid="launch-confirm-remove"
          :disabled="readOnly"
          :title="readOnly ? 'Project is read-only' : ''"
          @click="removeCurrentLaunch"
          >Remove launch</UiButton
        >
      </template>
    </UiDialog>
  </div>
</template>

<style scoped>
.launch-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: var(--surface-0);
  color: var(--ink);
  font: var(--text-sm) / 1.5 var(--font-sans);
  padding: var(--space-4) var(--space-5);
  box-sizing: border-box;
}

.launch-editor__header {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--hairline);
}

.launch-editor__title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.launch-editor__title {
  margin: 0;
  font: var(--weight-bold) var(--text-md) / 1.2 var(--font-sans);
  color: var(--ink);
}

.launch-editor__tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.launch-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: var(--surface-1);
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-xs) var(--font-sans);
  cursor: pointer;
  transition: all 0.15s ease;
}

.launch-pill:hover {
  background: var(--surface-2);
  color: var(--ink);
}

.launch-pill--active {
  background: var(--surface-3);
  border-color: var(--color-focus, var(--teal-6));
  color: var(--ink);
  font-weight: var(--weight-semibold);
}

.launch-pill__check {
  color: var(--teal-4, #2dd4bf);
  font-weight: var(--weight-bold);
}

.launch-editor__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8) var(--space-4);
  text-align: center;
  gap: var(--space-3);
}

.launch-editor__empty-title {
  font: var(--weight-semibold) var(--text-md) var(--font-sans);
  color: var(--ink);
  margin: 0;
}

.launch-editor__empty-hint {
  max-width: 480px;
  color: var(--ink-3);
  margin: 0;
}

.launch-editor__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-4);
}

.launch-editor__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.launch-name-input {
  font: var(--weight-bold) var(--text-md) var(--font-sans);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
  min-width: 200px;
}

.launch-name-input:hover,
.launch-name-input:focus {
  border-color: var(--hairline);
  background: var(--surface-1);
}

.launch-editor__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.launch-selected-badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--teal-4, #2dd4bf);
  font: var(--weight-semibold) var(--text-xs) var(--font-sans);
}

.launch-note-input {
  width: 100%;
  font: var(--text-sm) var(--font-sans);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  padding: var(--space-1) var(--space-2);
  box-sizing: border-box;
}

.launch-note-input:hover,
.launch-note-input:focus {
  border-color: var(--hairline);
  background: var(--surface-1);
  color: var(--ink);
}

.launch-editor__rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.launch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}

.launch-row--hero {
  align-items: flex-start;
}

.launch-row__label {
  display: flex;
  flex-direction: column;
  min-width: 160px;
}

.launch-row__label strong {
  font: var(--weight-semibold) var(--text-sm) var(--font-sans);
  color: var(--ink);
}

.launch-row__label small {
  color: var(--ink-3);
  font-size: var(--text-xs);
}

.launch-row__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
}

.launch-row__controls--hero {
  flex-direction: column;
  align-items: flex-start;
}

.launch-select,
.launch-number-input {
  font: var(--text-sm) var(--font-sans);
  background: var(--surface-0);
  color: var(--ink);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
}

.launch-coord-input {
  width: 60px;
  font: var(--text-sm) var(--font-mono, monospace);
  background: var(--surface-0);
  color: var(--ink);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  margin-left: var(--space-1);
}

.launch-hero-inputs {
  display: flex;
  gap: var(--space-4);
}

.launch-hero-inputs label {
  display: inline-flex;
  align-items: center;
  font: var(--weight-medium) var(--text-xs) var(--font-sans);
  color: var(--ink-2);
}

.launch-canvas-wrapper {
  margin-top: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #000;
  display: inline-block;
  cursor: crosshair;
}

.launch-canvas {
  display: block;
  width: 320px;
  height: 336px;
  image-rendering: pixelated;
}

.launch-empty-rows {
  margin: 0;
  padding: var(--space-4);
  color: var(--ink-3);
  font-style: italic;
  text-align: center;
}

.launch-editor__footer {
  display: flex;
  align-items: center;
  padding-top: var(--space-2);
}
</style>
