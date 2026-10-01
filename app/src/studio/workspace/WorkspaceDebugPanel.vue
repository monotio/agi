<script setup lang="ts">
import { computed, ref } from "vue";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import type { WorkspaceDebug } from "./workspaceDebug.ts";
import UiButton from "../../ui/UiButton.vue";
import { reservedValues } from "./debugValues.ts";
const props = defineProps<{ debug: WorkspaceDebug; problems: readonly { message: string }[] }>();
const emit = defineEmits<{ close: []; reveal: [logic: number, line: number] }>();
const tabs = ["Problems", "Variables", "Watch", "Call stack", "Breakpoints"] as const;
const tab = ref<(typeof tabs)[number]>(props.debug.stopped.value ? "Variables" : "Problems");
const expression = ref("");
const filter = ref("");
const slots = computed(() => {
  const names: Record<string, string[]> = {};
  for (const [name, binding] of Object.entries(props.debug.bindings.value)) {
    const key = `${binding.kind}:${binding.num}`;
    (names[key] ??= []).push(name);
  }
  return (["variable", "flag"] as const).flatMap((kind) =>
    Array.from({ length: 256 }, (_, slot) => {
      const used = props.debug.usedValues.value.find(
        (row) => row.kind === kind && row.slot === slot,
      );
      const reserved = reservedValues[kind][slot];
      const bindingNames = used?.names || (names[`${kind}:${slot}`] ?? []).join(", ");
      const label = `${kind === "variable" ? "v" : "f"}${slot}`;
      return {
        kind,
        slot,
        label,
        names: bindingNames,
        title: bindingNames || reserved || label,
        reserved,
        used: used !== undefined,
        value: props.debug.stopped.value?.state[kind === "variable" ? "vars" : "flags"][slot] ?? 0,
      };
    }),
  );
});
const groups = computed(() => {
  if (filter.value.trim()) {
    const query = filter.value.trim().toLowerCase();
    return [
      {
        title: "Search results",
        rows: slots.value.filter((row) =>
          `${row.label} ${row.slot} ${row.names} ${row.reserved ?? ""}`
            .toLowerCase()
            .includes(query),
        ),
      },
    ];
  }
  return [
    { title: "Used here", rows: slots.value.filter((row) => row.used) },
    {
      title: "Game",
      rows: slots.value
        .filter((row) => row.reserved !== undefined && !row.used)
        .map((row) => ({ ...row, title: row.reserved! })),
    },
  ];
});
const allGroups = computed(() =>
  (["variable", "flag"] as const).map((kind) => ({
    title: kind === "variable" ? "All variables" : "All flags",
    rows: slots.value.filter((row) => row.kind === kind),
  })),
);
function editValue(kind: "variable" | "flag", slot: number, event: Event): void {
  const element = event.target as HTMLInputElement;
  const value = kind === "flag" ? Number(element.checked) : Number(element.value);
  void props.debug.run(() => props.debug.setValue(kind, slot, value));
}
function tabKey(event: KeyboardEvent): void {
  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  tab.value = tabs[(tabs.indexOf(tab.value) + direction + tabs.length) % tabs.length]!;
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLButtonElement>(`[data-tab="${tab.value}"]`)
    ?.focus();
}
</script>
<template>
  <div class="workspace-debug-panel" data-testid="workspace-debug-panel">
    <header>
      <div role="tablist" aria-label="Debug panels" @keydown="tabKey">
        <button
          v-for="name in tabs"
          :key="name"
          role="tab"
          :data-tab="name"
          :aria-selected="tab === name"
          :tabindex="tab === name ? 0 : -1"
          @click="tab = name"
        >
          {{ name }}
        </button>
      </div>
      <UiButton size="sm" variant="ghost" aria-label="Close panel" @click="emit('close')"
        >×</UiButton
      >
    </header>
    <p v-if="debug.state.error" role="alert">{{ debug.state.error }}</p>
    <div role="tabpanel" :aria-label="tab" class="workspace-debug-content">
      <template v-if="tab === 'Problems'">
        <p v-if="problems.length === 0">Everything builds.</p>
        <p v-for="(problem, index) in problems" :key="index">{{ problem.message }}</p>
      </template>
      <template v-else-if="tab === 'Variables'">
        <label class="workspace-debug-filter"
          >Find a value <input v-model="filter" aria-label="Find a value"
        /></label>
        <p v-if="!debug.stopped.value">Pause the game to inspect and edit values.</p>
        <component
          :is="group.expand ? 'details' : 'section'"
          v-for="group in [
            ...groups.map((group) => ({ ...group, expand: false })),
            ...(filter.trim() ? [] : allGroups.map((group) => ({ ...group, expand: true }))),
          ]"
          :key="group.title"
          class="workspace-debug-group"
          :aria-label="group.title"
        >
          <summary v-if="group.expand">{{ group.title }}</summary>
          <h3 v-else>{{ group.title }}</h3>
          <p v-if="!group.rows.length">
            {{ debug.stopped.value ? "No values referenced." : "Pause to inspect this LOGIC." }}
          </p>
          <div class="workspace-debug-values">
            <label v-for="row in group.rows" :key="`${row.kind}:${row.slot}`">
              <span
                >{{ row.title }} <small v-if="row.title !== row.label">{{ row.label }}</small></span
              >
              <input
                v-if="row.kind === 'flag'"
                type="checkbox"
                :aria-label="`${row.label} ${row.names || row.reserved || ''}`.trim()"
                :checked="!!row.value"
                :disabled="!debug.stopped.value || debug.state.busy"
                @change="editValue(row.kind, row.slot, $event)"
              />
              <input
                v-else
                type="number"
                min="0"
                max="255"
                :aria-label="`${row.label} ${row.names || row.reserved || ''}`.trim()"
                :value="row.value"
                :disabled="!debug.stopped.value || row.slot === 0 || debug.state.busy"
                @change="editValue(row.kind, row.slot, $event)"
              />
            </label>
          </div>
        </component>
      </template>
      <template v-else-if="tab === 'Watch'">
        <form
          @submit.prevent="
            debug.run(async () => {
              await debug.addWatch(expression);
              expression = '';
            })
          "
        >
          <input
            v-model="expression"
            aria-label="Watch expression"
            placeholder="v40 or a binding name"
          /><UiButton size="sm" type="submit" :disabled="debug.state.busy">Add watch</UiButton>
        </form>
        <p>{{ VOCABULARY.watch.help }}</p>
        <p v-if="!debug.stopped.value">Pause to refresh values.</p>
        <div v-for="watch in debug.state.watches" :key="watch.id" class="workspace-debug-row">
          <span>{{ watch.expression }}</span
          ><output>{{ watch.value }}</output
          ><UiButton
            size="sm"
            variant="ghost"
            :aria-label="`Remove watch ${watch.expression}`"
            @click="debug.removeWatch(watch.id)"
            >×</UiButton
          >
        </div>
      </template>
      <template v-else-if="tab === 'Call stack'">
        <p v-if="!debug.stopped.value">Pause the game to inspect calls.</p>
        <button
          v-for="frame in [...(debug.stopped.value?.location?.frames ?? [])].reverse()"
          :key="frame.invocationId"
          class="workspace-debug-frame"
          @click="emit('reveal', frame.logic, debug.framePosition(frame)?.line ?? 1)"
        >
          LOGIC {{ frame.logic
          }}<span v-if="debug.framePosition(frame)"
            >, line {{ debug.framePosition(frame)?.line }}</span
          ><span v-else>, byte {{ frame.pc }}</span>
        </button>
      </template>
      <template v-else>
        <p>{{ VOCABULARY.breakpoint.help }}</p>
        <div v-for="point in debug.state.breakpoints" :key="point.id" class="workspace-debug-row">
          <button @click="emit('reveal', point.logic, point.line)">
            LOGIC {{ point.logic }}, line {{ point.line }}
          </button>
          <span>{{
            debug.state.statuses.find((row) => row.id === point.id)?.binding.bound === false
              ? "Choose an executable line."
              : debug.state.epoch
                ? "Bound"
                : "Ready"
          }}</span>
          <UiButton
            size="sm"
            variant="ghost"
            :aria-label="`Remove breakpoint ${point.id}`"
            @click="debug.run(() => debug.toggle(point.logic, point.line))"
            >×</UiButton
          >
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.workspace-debug-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
[role="tablist"] {
  display: flex;
  gap: var(--space-2);
}
button {
  color: var(--ink-3);
  background: transparent;
  border: 0;
  padding: var(--space-2);
  cursor: pointer;
  font: inherit;
}
[role="tab"][aria-selected="true"] {
  color: var(--ink);
  border-bottom: 2px solid var(--action);
}
.workspace-debug-content {
  overflow: auto;
  max-height: 210px;
}
.workspace-debug-filter,
.workspace-debug-content form {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-2) 0;
}
input {
  background: var(--surface-0);
  color: var(--ink);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1);
}
.workspace-debug-values {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-2) var(--space-5);
}
.workspace-debug-values label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
}
.workspace-debug-values input[type="number"] {
  width: 64px;
}
small {
  font-family: var(--font-mono);
  margin-left: var(--space-2);
  color: var(--ink-3);
}
.workspace-debug-group {
  margin-bottom: var(--space-3);
}
h3,
summary {
  font-size: var(--text-sm);
  margin: var(--space-2) 0;
}
summary {
  cursor: pointer;
  color: var(--ink-3);
}
.workspace-debug-row {
  display: flex;
  gap: var(--space-4);
  align-items: center;
}
.workspace-debug-frame {
  display: block;
}
</style>
