<script setup lang="ts">
/**
 * The debug workspace's inspection column: the held stop's cause and real
 * EngineStateReport (vars, flags, strings, parser, objects), the call stack
 * the worker captured, expression evaluation, set-values, watchpoints and
 * breakpoint configuration. Everything shown came from the worker's own
 * replies pinned to the published stop — nothing is simulated locally.
 */
import { computed, ref } from "vue";
import type { EngineStateReport, ScreenObjectState } from "../../../../../src/runtime/engine.ts";
import type { DebugWatchTarget } from "../../../../../src/runtime/debugWatchpoints.ts";
import type { DebugLogSegment } from "../../../../../src/runtime/debugBreakpoints.ts";
import UiButton from "../../../ui/UiButton.vue";
import UiChip from "../../../ui/UiChip.vue";
import type {
  DebugSpecVerdict,
  DebugWorkspace,
  DebugBreakpointRow,
  DebugWatchRow,
} from "./logicDebugWorkspace.ts";

const props = defineProps<{ workspace: DebugWorkspace }>();
const emit = defineEmits<{ navigate: [] }>();

const state = computed(() => props.workspace.state);

/* --- held stop ---------------------------------------------------------- */

const causeText = computed(() => {
  const stop = state.value.stop;
  if (!stop) return "";
  const cause = stop.cause;
  if (cause.type === "instruction") {
    return `logic ${cause.boundary.logic} pc ${cause.boundary.pc} (${cause.boundary.kind})`;
  }
  if (cause.type === "phase") return `engine phase: ${cause.phase}`;
  return `waiting: ${cause.wait}`;
});

const reasonText = computed(() => {
  const stop = state.value.stop;
  if (!stop) return "";
  return stop.reasons
    .map((r) => {
      if (r.kind === "breakpoint") return `breakpoint ${r.id} (hit ${r.hitCount})`;
      if (r.kind === "watch")
        return `watchpoint (${r.changes.length} change${r.changes.length === 1 ? "" : "s"})`;
      if (r.kind === "step") return `step ${r.mode}`;
      if (r.kind === "runTo") return "run to cursor";
      if (r.kind === "mutated") return "set values";
      return r.kind;
    })
    .join(", ");
});

/**
 * Plain-language headline for the held stop. The workspace always holds runs
 * with stopOnEntry, so the first stop of a run is provably the hold before
 * the first game cycle; every later stop gets the generic paused guidance —
 * a missing source position alone does not mean the game never started.
 */
const stopHeadline = computed(() => {
  const stop = state.value.stop;
  if (!stop) return "";
  if (stop.stopId === 1) return "Paused before the game starts. Continue runs the game.";
  return "Test paused. Continue resumes the game.";
});

/* --- inspection payload -------------------------------------------------- */

interface InspectionAll {
  readonly location?: {
    readonly frames?: readonly {
      readonly invocationId: number;
      readonly logic: number;
      readonly pc: number;
      readonly callsite: number | null;
    }[];
  } | null;
  readonly state?: EngineStateReport | null;
  readonly objects?: readonly ScreenObjectState[];
  readonly snapshot?: { readonly strings?: readonly string[] } | null;
}

const inspection = computed<InspectionAll | null>(() => {
  const data = state.value.inspection.data;
  return data !== null && typeof data === "object" ? (data as InspectionAll) : null;
});

const report = computed<EngineStateReport | null>(() => {
  const held = state.value.stop;
  if (held) return held.state;
  return inspection.value?.state ?? null;
});

/** Named value slots from the frozen build's bindings. */
const namedValues = computed(() => {
  const build = props.workspace.frozenBuild();
  const rep = report.value;
  if (!build || !rep) return [];
  const out: { name: string; slot: string; value: number | boolean | string }[] = [];
  for (const [name, binding] of Object.entries(build.sourceBindings)) {
    if (binding.kind === "variable") {
      out.push({ name, slot: `v${binding.num}`, value: rep.vars[binding.num] ?? 0 });
    } else if (binding.kind === "flag") {
      out.push({ name, slot: `f${binding.num}`, value: (rep.flags[binding.num] ?? 0) !== 0 });
    }
  }
  return out;
});

const nonzeroVars = computed(() => {
  const rep = report.value;
  if (!rep) return [];
  const out: string[] = [];
  rep.vars.forEach((value, index) => {
    if (value !== 0) out.push(`v${index}=${value}`);
  });
  return out;
});

const setFlags = computed(() => {
  const rep = report.value;
  if (!rep) return [];
  const out: string[] = [];
  rep.flags.forEach((value, index) => {
    if (value !== 0) out.push(`f${index}`);
  });
  return out;
});

const strings = computed(() => {
  const rep = report.value;
  if (!rep) return [];
  const out: { index: number; text: string }[] = [];
  rep.strings.forEach((text, index) => {
    if (text) out.push({ index, text });
  });
  return out;
});

const frames = computed(() => inspection.value?.location?.frames ?? []);
const objects = computed(() => inspection.value?.objects ?? []);

/* --- evaluate ------------------------------------------------------------ */

const evalExpression = ref("");
const evalError = ref<string>();

async function runEval(): Promise<void> {
  const expression = evalExpression.value.trim();
  if (!expression) return;
  evalError.value = undefined;
  try {
    await props.workspace.evaluate(expression);
    evalExpression.value = "";
  } catch (error) {
    evalError.value = error instanceof Error ? error.message : String(error);
  }
}

/* --- set values ----------------------------------------------------------- */

const setTarget = ref("");
const setValueField = ref("");
const setError = ref<string>();

async function applySetValues(): Promise<void> {
  const target = setTarget.value.trim().toLowerCase();
  const match = /^([vf])(\d{1,3})$/.exec(target);
  if (!match) {
    setError.value = "Name a slot like v42 or f7.";
    return;
  }
  const index = Number(match[2]);
  if (index > 255) {
    setError.value = "Slots run 0 to 255.";
    return;
  }
  const raw = setValueField.value.trim();
  setError.value = undefined;
  try {
    if (match[1] === "v") {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        setError.value = "A variable holds 0 to 255.";
        return;
      }
      await props.workspace.setValues({ vars: [[index, value]] });
    } else {
      const value = raw === "1" || raw === "true";
      if (!(raw === "0" || raw === "1" || raw === "true" || raw === "false")) {
        setError.value = "A flag is 0/1 or true/false.";
        return;
      }
      await props.workspace.setValues({ flags: [[index, value ? 1 : 0]] });
    }
    setTarget.value = "";
    setValueField.value = "";
  } catch (error) {
    setError.value = error instanceof Error ? error.message : String(error);
  }
}

/* --- watchpoints ------------------------------------------------------------ */

const watchTarget = ref("");
const watchCondition = ref("");
const watchVerdict = ref<DebugSpecVerdict>();

function addWatch(): void {
  const raw = watchTarget.value.trim();
  const slot = /^([vf])(\d{1,3})$/.exec(raw.toLowerCase());
  let target: DebugWatchTarget | null = null;
  if (slot) {
    target = { kind: slot[1] === "v" ? "variable" : "flag", index: Number(slot[2]) };
  } else {
    const binding = props.workspace.frozenBuild()?.sourceBindings[raw];
    if (binding && (binding.kind === "variable" || binding.kind === "flag")) {
      target = { kind: binding.kind, index: binding.num };
    }
  }
  if (!target) {
    watchVerdict.value = {
      ok: false,
      error: "Name a variable or flag like v42, f7 or a bound name.",
    };
    return;
  }
  watchVerdict.value = props.workspace.addWatch(target, watchCondition.value.trim() || undefined);
  if (watchVerdict.value.ok) {
    watchTarget.value = "";
    watchCondition.value = "";
  }
}

function watchLabel(row: DebugWatchRow): string {
  const prefix = row.spec.target.kind === "variable" ? "v" : "f";
  const build = props.workspace.frozenBuild();
  const named = build
    ? Object.entries(build.sourceBindings).find(
        ([, b]) =>
          (b.kind === "variable" ? "variable" : b.kind === "flag" ? "flag" : null) ===
            row.spec.target.kind && b.num === row.spec.target.index,
      )
    : undefined;
  return named
    ? `${named[0]} (${prefix}${row.spec.target.index})`
    : `${prefix}${row.spec.target.index}`;
}

/* --- breakpoints ------------------------------------------------------------ */

const bpEdits = ref<
  Record<string, { condition: string; hitKind: string; hitCount: string; log: string }>
>({});
const bpVerdicts = ref<Record<string, string>>({});
const openBp = ref<string>();

function bpFields(row: DebugBreakpointRow) {
  const held = bpEdits.value[row.id];
  if (held) return held;
  const spec = row.spec;
  const fields = {
    condition: spec.condition ?? "",
    hitKind: spec.hit?.kind ?? "",
    hitCount: spec.hit ? String(spec.hit.count) : "",
    log:
      spec.log?.segments.map((s) => (s.type === "literal" ? s.text : `{${s.source}}`)).join("") ??
      "",
  };
  bpEdits.value = { ...bpEdits.value, [row.id]: fields };
  return fields;
}

function applyBreakpoint(row: DebugBreakpointRow): void {
  const fields = bpFields(row);
  const condition = fields.condition.trim();
  const hitCount = Number(fields.hitCount);
  const segments: DebugLogSegment[] = [];
  let rest = fields.log;
  while (rest.length) {
    const open = rest.indexOf("{");
    const close = rest.indexOf("}", open + 1);
    if (open === -1 || close === -1) {
      segments.push({ type: "literal", text: rest });
      break;
    }
    if (open > 0) segments.push({ type: "literal", text: rest.slice(0, open) });
    segments.push({ type: "expression", source: rest.slice(open + 1, close).trim() });
    rest = rest.slice(close + 1);
  }
  const verdict = props.workspace.updateBreakpoint(row.id, {
    enabled: row.spec.enabled,
    mode: row.spec.mode,
    ...(row.spec.column !== undefined ? { column: row.spec.column } : {}),
    ...(condition ? { condition } : {}),
    ...(fields.hitKind && Number.isInteger(hitCount) && hitCount > 0
      ? {
          hit: {
            kind: fields.hitKind as "equal" | "atLeast" | "every",
            count: hitCount,
          },
        }
      : {}),
    ...(segments.length ? { log: { segments } } : {}),
  });
  bpVerdicts.value = { ...bpVerdicts.value, [row.id]: verdict.ok ? "" : verdict.error };
  if (verdict.ok) {
    const { [row.id]: _dropped, ...restEdits } = bpEdits.value;
    bpEdits.value = restEdits;
    openBp.value = undefined;
  }
}

function bpStatus(row: DebugBreakpointRow): string {
  if (row.fault) return `fault: ${row.fault}`;
  if (row.pending) return "pending";
  if (!row.binding) return "unverified";
  if (!row.binding.bound) return `unbound (${row.binding.reason})`;
  return `bound · line ${row.binding.line} · ${row.binding.pcs.length} pc${row.binding.pcs.length === 1 ? "" : "s"} · ${row.hits} hits`;
}

function removeBreakpoint(id: string): void {
  props.workspace.removeBreakpoint(id);
}
</script>

<template>
  <div class="debug-inspector" data-testid="debug-inspector">
    <!-- Held stop -->
    <details class="debug-inspector__section" open>
      <summary>Stop</summary>
      <div class="debug-inspector__body" data-testid="debug-stop-section">
        <template v-if="state.stop">
          <p class="debug-inspector__row" data-testid="debug-stop-headline">{{ stopHeadline }}</p>
          <p v-if="reasonText" class="debug-inspector__row" data-testid="debug-stop-reasons">
            {{ reasonText }}
          </p>
          <p
            v-if="state.answersReady"
            class="debug-inspector__row"
            data-testid="debug-answers-ready"
          >
            {{ state.answersReady }} answer{{ state.answersReady === 1 ? "" : "s" }} ready; they
            apply when you continue
          </p>
          <p v-if="state.stopLocation" class="debug-inspector__row">
            <UiButton
              variant="ghost"
              size="sm"
              data-testid="debug-goto-source"
              @click="emit('navigate')"
            >
              {{ state.stopLocation.key }}:{{ state.stopLocation.line }}
            </UiButton>
          </p>
          <p v-else class="debug-inspector__row debug-inspector__dim" data-testid="debug-no-source">
            No source line for this stop.
          </p>
        </template>
        <p v-else class="debug-inspector__row debug-inspector__dim">
          {{ state.phase === "idle" ? "No test run." : `The test run is ${state.phase}.` }}
        </p>
        <details
          v-if="state.stop || state.buildId"
          class="debug-inspector__detail"
          data-testid="debug-stop-details"
        >
          <summary>Details</summary>
          <p v-if="state.stop" class="debug-inspector__row debug-inspector__mono">
            stop #{{ state.stop.stopId }} · {{ causeText
            }}<template v-if="state.stop.wait"> · wait {{ state.stop.wait }}</template>
          </p>
          <p v-if="state.buildId" class="debug-inspector__row debug-inspector__dim">
            build {{ state.buildId.slice(0, 12) }} · epoch {{ state.epoch }} ·
            {{ state.profileId }}
          </p>
        </details>
        <p v-if="state.inspecting" class="debug-inspector__row debug-inspector__dim">Inspecting…</p>
        <p v-if="state.inspectionError" class="debug-inspector__row debug-inspector__error">
          {{ state.inspectionError }}
        </p>
      </div>
    </details>

    <!-- Stack -->
    <details class="debug-inspector__section" :open="frames.length > 0">
      <summary>Call stack</summary>
      <div class="debug-inspector__body" data-testid="debug-stack">
        <p v-if="frames.length === 0" class="debug-inspector__dim">No call stack at this stop.</p>
        <p
          v-for="frame in frames"
          :key="frame.invocationId"
          class="debug-inspector__row debug-inspector__mono"
        >
          logic {{ frame.logic }} · pc {{ frame.pc
          }}<template v-if="frame.callsite !== null"> · callsite {{ frame.callsite }}</template>
        </p>
      </div>
    </details>

    <!-- Values -->
    <details class="debug-inspector__section" open>
      <summary>Values</summary>
      <div class="debug-inspector__body" data-testid="debug-values">
        <template v-if="report">
          <p class="debug-inspector__row debug-inspector__dim">
            room {{ report.room }} · ego {{ report.egoX }},{{ report.egoY }} · cycle stop
          </p>
          <div v-if="namedValues.length" class="debug-inspector__grid">
            <p
              v-for="named in namedValues"
              :key="named.slot"
              class="debug-inspector__row debug-inspector__mono"
            >
              {{ named.name }} <span class="debug-inspector__dim">{{ named.slot }}</span> =
              {{ named.value }}
            </p>
          </div>
          <p v-if="nonzeroVars.length" class="debug-inspector__row debug-inspector__mono">
            {{ nonzeroVars.join("  ") }}
          </p>
          <p v-if="setFlags.length" class="debug-inspector__row debug-inspector__mono">
            {{ setFlags.join("  ") }}
          </p>
          <p v-for="s in strings" :key="s.index" class="debug-inspector__row debug-inspector__mono">
            s{{ s.index }} = "{{ s.text }}"
          </p>
        </template>
        <p v-else class="debug-inspector__dim">Stop the run to read values.</p>

        <form
          class="debug-inspector__form"
          data-testid="debug-setvalues"
          @submit.prevent="applySetValues"
        >
          <input
            v-model="setTarget"
            class="debug-inspector__input debug-inspector__input--slot"
            aria-label="Slot (v42 or f7)"
            placeholder="v42"
            data-testid="debug-set-target"
          />
          <input
            v-model="setValueField"
            class="debug-inspector__input"
            aria-label="New value"
            placeholder="value"
            data-testid="debug-set-value"
          />
          <UiButton
            variant="ghost"
            size="sm"
            :disabled="state.phase !== 'stopped'"
            title="Write this value into the test run"
            data-testid="debug-set-apply"
            @click="applySetValues"
          >
            Set
          </UiButton>
        </form>
        <p class="debug-inspector__row debug-inspector__dim">Set writes into this test run only.</p>
        <p v-if="setError" class="debug-inspector__error" role="alert">{{ setError }}</p>
        <UiChip v-if="state.modified" tone="warn" data-testid="debug-modified">
          Modified by set values
        </UiChip>
      </div>
    </details>

    <!-- Evaluate -->
    <details class="debug-inspector__section" open>
      <summary>Evaluate</summary>
      <div class="debug-inspector__body" data-testid="debug-evaluate">
        <form class="debug-inspector__form" @submit.prevent="runEval">
          <input
            v-model="evalExpression"
            class="debug-inspector__input"
            aria-label="Expression"
            placeholder="v42 + 1, count, f5"
            data-testid="debug-eval-input"
          />
          <UiButton
            variant="ghost"
            size="sm"
            :disabled="state.phase !== 'stopped'"
            :title="
              state.phase === 'stopped' ? 'Evaluate at the held stop' : 'Pause the run to evaluate'
            "
            data-testid="debug-eval-apply"
            @click="runEval"
          >
            Eval
          </UiButton>
        </form>
        <p v-if="evalError" class="debug-inspector__error" role="alert">{{ evalError }}</p>
        <p
          v-for="(row, index) in state.evaluations"
          :key="index"
          class="debug-inspector__row debug-inspector__mono"
          :class="{ 'debug-inspector__error': row.error }"
        >
          {{ row.expression }} = {{ row.error ?? row.value }}
        </p>
      </div>
    </details>

    <!-- Watchpoints -->
    <details class="debug-inspector__section">
      <summary>Watches</summary>
      <div class="debug-inspector__body" data-testid="debug-watches">
        <form class="debug-inspector__form" @submit.prevent="addWatch">
          <input
            v-model="watchTarget"
            class="debug-inspector__input debug-inspector__input--slot"
            aria-label="Watch slot"
            placeholder="v42, f7 or a bound name"
            data-testid="debug-watch-target"
          />
          <input
            v-model="watchCondition"
            class="debug-inspector__input"
            aria-label="Watch condition"
            placeholder="condition, e.g. new > 3"
            data-testid="debug-watch-condition"
          />
          <UiButton variant="ghost" size="sm" data-testid="debug-watch-add" @click="addWatch">
            Watch
          </UiButton>
        </form>
        <p v-if="watchVerdict && !watchVerdict.ok" class="debug-inspector__error" role="alert">
          {{ watchVerdict.error }}
        </p>
        <div
          v-for="row in state.watches"
          :key="row.id"
          class="debug-inspector__watch"
          :data-testid="`debug-watch-${row.id}`"
        >
          <label class="debug-inspector__row">
            <input
              type="checkbox"
              :checked="row.spec.enabled"
              @change="
                props.workspace.updateWatch(row.id, {
                  enabled: ($event.target as HTMLInputElement).checked,
                })
              "
            />
            <span class="debug-inspector__mono">{{ watchLabel(row) }}</span>
            <span class="debug-inspector__dim">
              baseline {{ row.baseline ?? "—" }} · {{ row.changes }} change{{
                row.changes === 1 ? "" : "s"
              }}
            </span>
          </label>
          <p v-if="row.spec.condition" class="debug-inspector__dim">
            when {{ row.spec.condition }}
          </p>
          <p v-if="row.fault" class="debug-inspector__error">{{ row.fault }}</p>
          <UiButton
            variant="ghost"
            size="sm"
            :data-testid="`debug-watch-remove-${row.id}`"
            @click="props.workspace.removeWatch(row.id)"
          >
            Remove
          </UiButton>
        </div>
      </div>
    </details>

    <!-- Breakpoints -->
    <details class="debug-inspector__section">
      <summary>Breakpoints</summary>
      <div class="debug-inspector__body" data-testid="debug-breakpoints">
        <p v-if="state.breakpoints.length === 0" class="debug-inspector__dim">
          Click a line number to set a breakpoint.
        </p>
        <div
          v-for="row in state.breakpoints"
          :key="row.id"
          class="debug-inspector__bp"
          :data-testid="`debug-bp-${row.id}`"
        >
          <label class="debug-inspector__row">
            <input
              type="checkbox"
              :checked="row.spec.enabled"
              :data-testid="`debug-bp-enable-${row.id}`"
              @change="
                props.workspace.setBreakpointEnabled(
                  row.id,
                  ($event.target as HTMLInputElement).checked,
                )
              "
            />
            <span class="debug-inspector__mono"
              >logic {{ row.spec.logic }}:{{ row.spec.line }}</span
            >
            <span class="debug-inspector__dim" :data-testid="`debug-bp-status-${row.id}`">{{
              bpStatus(row)
            }}</span>
          </label>
          <div class="debug-inspector__row">
            <UiButton
              variant="ghost"
              size="sm"
              :data-testid="`debug-bp-edit-${row.id}`"
              @click="
                openBp = openBp === row.id ? undefined : row.id;
                bpFields(row);
              "
            >
              {{ openBp === row.id ? "Close" : "Edit" }}
            </UiButton>
            <UiButton
              variant="ghost"
              size="sm"
              :data-testid="`debug-bp-remove-${row.id}`"
              @click="removeBreakpoint(row.id)"
            >
              Remove
            </UiButton>
          </div>
          <div v-if="openBp === row.id" class="debug-inspector__bpedit">
            <input
              v-model="bpEdits[row.id]!.condition"
              class="debug-inspector__input"
              aria-label="Condition"
              placeholder="condition, e.g. v42 > 3"
              :data-testid="`debug-bp-condition-${row.id}`"
            />
            <div class="debug-inspector__form">
              <select
                v-model="bpEdits[row.id]!.hitKind"
                class="debug-inspector__input debug-inspector__input--slot"
                aria-label="Hit policy"
                :data-testid="`debug-bp-hitkind-${row.id}`"
              >
                <option value="">every hit</option>
                <option value="equal">hit == N</option>
                <option value="atLeast">hit &gt;= N</option>
                <option value="every">every Nth</option>
              </select>
              <input
                v-model="bpEdits[row.id]!.hitCount"
                class="debug-inspector__input debug-inspector__input--slot"
                aria-label="Hit count"
                placeholder="N"
                :data-testid="`debug-bp-hitcount-${row.id}`"
              />
            </div>
            <input
              v-model="bpEdits[row.id]!.log"
              class="debug-inspector__input"
              aria-label="Logpoint text"
              placeholder="log: text with {expressions}"
              :data-testid="`debug-bp-log-${row.id}`"
            />
            <UiButton
              variant="ghost"
              size="sm"
              :data-testid="`debug-bp-apply-${row.id}`"
              @click="applyBreakpoint(row)"
            >
              Apply
            </UiButton>
            <p v-if="bpVerdicts[row.id]" class="debug-inspector__error" role="alert">
              {{ bpVerdicts[row.id] }}
            </p>
          </div>
        </div>
      </div>
    </details>

    <!-- Parser and objects -->
    <details class="debug-inspector__section">
      <summary>Parser and objects</summary>
      <div class="debug-inspector__body" data-testid="debug-parser">
        <template v-if="report">
          <p class="debug-inspector__row debug-inspector__mono">
            input: "{{ report.lastInputLine }}"
          </p>
          <p
            v-if="report.parsedWordTexts.length"
            class="debug-inspector__row debug-inspector__mono"
          >
            words: {{ report.parsedWordTexts.join(", ") }}
          </p>
          <p v-if="objects.length" class="debug-inspector__row debug-inspector__dim">
            {{ objects.length }} screen object{{ objects.length === 1 ? "" : "s" }}
          </p>
          <p
            v-for="obj in objects"
            :key="obj.num"
            class="debug-inspector__row debug-inspector__mono"
          >
            o{{ obj.num }} · view {{ obj.view }} loop {{ obj.loop }} cel {{ obj.cel }} ·
            {{ obj.x }},{{ obj.y }} · pri {{ obj.priority }} · dir {{ obj.direction }}
            {{ obj.update ? "· updating" : "" }}
          </p>
        </template>
        <p v-else class="debug-inspector__dim">Stop the run to read parser and objects.</p>
      </div>
    </details>

    <!-- Log -->
    <details class="debug-inspector__section" :open="state.logs.length > 0">
      <summary>Log</summary>
      <div class="debug-inspector__body" data-testid="debug-log">
        <p v-if="state.configError" class="debug-inspector__error" role="alert">
          {{ state.configError }}
        </p>
        <p v-if="state.error" class="debug-inspector__error" role="alert">{{ state.error }}</p>
        <p
          v-if="state.logs.length === 0 && !state.configError && !state.error"
          class="debug-inspector__dim"
        >
          No logpoint output yet.
        </p>
        <p
          v-for="entry in state.logs"
          :key="entry.sequence"
          class="debug-inspector__row debug-inspector__mono"
        >
          {{ entry.text }}
        </p>
      </div>
    </details>
  </div>
</template>

<style scoped>
.debug-inspector {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.debug-inspector__section {
  border-bottom: 1px solid var(--hairline-strong);
}
.debug-inspector__section > summary {
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
}
.debug-inspector__section > summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.debug-inspector__body {
  padding: var(--space-1) var(--space-3) var(--space-2);
}
.debug-inspector__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0 0 var(--space-1);
}
.debug-inspector__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0 var(--space-3);
}
.debug-inspector__mono {
  font-family: var(--font-mono);
}
.debug-inspector__dim {
  color: var(--ink-3);
}
.debug-inspector__error {
  color: var(--danger);
}
.debug-inspector__detail {
  margin: var(--space-1) 0;
}
.debug-inspector__detail > summary {
  color: var(--ink-3);
  cursor: pointer;
}
.debug-inspector__detail > summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.debug-inspector__form {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin: var(--space-1) 0;
}
.debug-inspector__input {
  flex: 1;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-0);
  font: var(--text-xs) / var(--leading) var(--font-mono);
}
.debug-inspector__input--slot {
  flex: 0 0 90px;
}
.debug-inspector__bp,
.debug-inspector__watch {
  margin-bottom: var(--space-2);
  padding-bottom: var(--space-1);
  border-bottom: 1px dashed var(--hairline-strong);
}
.debug-inspector__bpedit {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) 0;
}
</style>
