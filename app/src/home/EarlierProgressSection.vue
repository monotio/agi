<script setup lang="ts">
/**
 * The "Earlier progress" section inside the shared Details dialog: the
 * sources the read adapter discovers, the selected one's pinned read, and
 * the download the exporter proved exact. All storage work is the
 * controller's — this file renders state and forwards clicks.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import type { EarlierDetailsContext } from "./cardDetails.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useNow } from "./useNow.ts";
import {
  describeEarlierSelection,
  earlierEntrySource,
  earlierSourceTag,
  useEarlierProgress,
} from "./useEarlierProgress.ts";
import type { EarlierEntry } from "../project/earlierProgress.ts";

const props = defineProps<{ context: EarlierDetailsContext }>();

/**
 * A saved game's own context keeps its earlier spelling scoped; Browse
 * earlier progress widens the same section to every source.
 */
const browsingAll = ref(false);
const activeContext = computed<EarlierDetailsContext>(() =>
  browsingAll.value ? { kind: "all" } : props.context,
);

const {
  entries,
  listing,
  listError,
  hasMore,
  selected,
  notice,
  retryList,
  loadMore,
  selectEntry,
  refreshSelected,
  downloadSelection,
  downloadLocalSelection,
} = useEarlierProgress(() => activeContext.value);

const now = useNow();

const intro = computed(() => {
  if (browsingAll.value || props.context.kind === "all")
    return "Earlier progress stored in this browser.";
  if (props.context.kind === "capture") return "Progress kept when a game was removed.";
  return "Progress saved under this name.";
});

const showList = computed(() => browsingAll.value || props.context.kind !== "capture");

const view = computed(() =>
  selected.value
    ? describeEarlierSelection(selected.value, (at) => {
        const when = formatRelativeTime(Date.parse(at), now.value);
        return when || at;
      })
    : undefined,
);

const isSelected = (entry: EarlierEntry): boolean =>
  selected.value !== undefined &&
  earlierSourceTag(selected.value.source) === earlierSourceTag(earlierEntrySource(entry));

function rowKey(entry: EarlierEntry): string {
  return earlierSourceTag(earlierEntrySource(entry));
}

function rowLabel(entry: EarlierEntry): string {
  switch (entry.kind) {
    case "capture":
      return entry.state === "available"
        ? "Saved when removed"
        : entry.state === "unsupported"
          ? "From another version"
          : "Stored data";
    case "live":
      return "Earlier progress";
    case "local":
      return "Stored data";
  }
}

function rowSub(entry: EarlierEntry): string {
  switch (entry.kind) {
    case "capture": {
      const parsed = entry.capturedAt === null ? NaN : Date.parse(entry.capturedAt);
      const when = Number.isFinite(parsed) ? formatRelativeTime(parsed, now.value) : "";
      return `${entry.source ?? entry.key}${when ? ` · ${when}` : ""}`;
    }
    case "live":
      return entry.source;
    case "local":
      return entry.keys.join(", ");
  }
}

const showRefresh = computed(
  () => selected.value?.source.kind === "live" || selected.value?.source.kind === "local",
);

/**
 * A ready selection's actions can open below the fold: bring them into view
 * without moving focus off the row the viewer picked.
 */
const actions = useTemplateRef("actions");
watch(
  () => selected.value?.state,
  async (state) => {
    if (state !== "ready") return;
    await nextTick();
    actions.value?.scrollIntoView({ block: "nearest" });
  },
);
</script>

<template>
  <section
    class="earlier"
    data-testid="earlier-progress"
    :aria-labelledby="context.kind === 'all' ? undefined : 'earlier-heading'"
  >
    <div v-if="context.kind !== 'all'" class="earlier__head">
      <h3 id="earlier-heading" class="earlier__title">Earlier progress</h3>
      <UiButton
        v-if="context.kind === 'candidates' && !browsingAll"
        size="sm"
        variant="ghost"
        data-testid="earlier-browse-all"
        @click="browsingAll = true"
      >
        Browse earlier progress
      </UiButton>
    </div>
    <p class="earlier__intro">{{ intro }}</p>

    <div v-if="showList" class="earlier__list">
      <div v-if="listError" class="earlier__error" data-testid="earlier-list-error">
        <p role="alert">{{ listError }}</p>
        <UiButton size="sm" data-testid="earlier-list-retry" @click="retryList">Retry</UiButton>
      </div>
      <p v-else-if="listing && entries.length === 0" class="earlier__muted">
        Checking earlier sources…
      </p>
      <ul v-else-if="entries.length" class="earlier__rows" data-testid="earlier-rows">
        <li v-for="entry in entries" :key="rowKey(entry)">
          <button
            type="button"
            class="earlier__row"
            :data-active="isSelected(entry) || undefined"
            :aria-pressed="isSelected(entry)"
            :data-source="rowKey(entry)"
            data-testid="earlier-row"
            @click="selectEntry(entry)"
          >
            <span class="earlier__row-label">{{ rowLabel(entry) }}</span>
            <span class="earlier__row-sub">{{ rowSub(entry) }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="earlier__muted" data-testid="earlier-empty">
        No earlier progress saved in this browser.
      </p>
      <p v-if="hasMore" class="earlier__more">
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="listing"
          data-testid="earlier-more"
          @click="loadMore"
        >
          {{ listing ? "Checking…" : "Show more" }}
        </UiButton>
      </p>
    </div>

    <div v-if="selected" class="earlier__selected" data-testid="earlier-selected">
      <p v-if="selected.state === 'reading'" role="status" class="earlier__muted">
        Reading stored data…
      </p>
      <div
        v-else-if="selected.state === 'failed'"
        class="earlier__error"
        data-testid="earlier-read-error"
      >
        <p role="alert">{{ selected.error }}</p>
        <UiButton size="sm" data-testid="earlier-read-retry" @click="refreshSelected">
          Retry
        </UiButton>
      </div>
      <template v-else-if="view">
        <h4 class="earlier__read-title" data-testid="earlier-read-title">{{ view.heading }}</h4>
        <p class="earlier__muted" data-testid="earlier-summary">{{ view.summary }}</p>
        <dl v-if="view.facts.length" class="earlier__facts" data-testid="earlier-facts">
          <template v-for="[term, value, mono] in view.facts" :key="term">
            <dt>{{ term }}</dt>
            <dd>
              <code v-if="mono">{{ value }}</code>
              <template v-else>{{ value }}</template>
            </dd>
          </template>
        </dl>
        <p v-for="key in view.missing" :key="key" class="earlier__muted">
          Missing item: <code>{{ key }}</code>
        </p>
        <div ref="actions" class="earlier__actions">
          <UiButton
            v-if="view.canDownload"
            size="sm"
            data-testid="earlier-download"
            @click="downloadSelection"
          >
            Download a copy
          </UiButton>
          <UiButton
            v-if="view.canDownloadLocal"
            size="sm"
            data-testid="earlier-download-local"
            @click="downloadLocalSelection"
          >
            Download part
          </UiButton>
          <UiButton
            v-if="showRefresh"
            size="sm"
            variant="ghost"
            data-testid="earlier-refresh"
            @click="refreshSelected"
          >
            Refresh
          </UiButton>
        </div>
        <p v-if="view.exportNote" class="earlier__muted" data-testid="earlier-export-note">
          {{ view.exportNote }}
        </p>
        <UiDisclosure
          v-if="view.exportDetail !== undefined || view.retained.length"
          id="earlier-stored-items"
          class="earlier__stored"
          label="Stored items"
          hint="Keys and diagnostics"
          test-id="earlier-stored"
        >
          <p v-if="view.exportDetail" class="earlier__muted" data-testid="earlier-export-detail">
            {{ view.exportDetail }}
          </p>
          <ul v-if="view.retained.length" class="earlier__retained" data-testid="earlier-retained">
            <li v-for="key in view.retained" :key="key">
              <code>{{ key }}</code>
            </li>
          </ul>
        </UiDisclosure>
      </template>
    </div>
    <p v-if="notice" role="status" class="earlier__notice" data-testid="earlier-notice">
      {{ notice }}
    </p>
  </section>
</template>

<style scoped>
.earlier {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--hairline);
}
/* When the section opens the dialog body (the all-sources view) its own
   heading is hidden and the separator band sits empty under the title. */
.earlier:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.earlier__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  margin: 0 0 var(--space-2);
}
.earlier__title {
  margin: 0;
  color: var(--ink);
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
}
.earlier__intro {
  margin: 0 0 var(--space-3);
  color: var(--ink-2);
  font-size: var(--text-sm);
  line-height: var(--leading);
}
.earlier__muted {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-sm);
  line-height: var(--leading);
}
.earlier__error {
  margin: 0 0 var(--space-3);
  color: var(--danger);
  font-size: var(--text-sm);
}
.earlier__error p {
  margin: 0 0 var(--space-2);
}
.earlier__rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  padding: 0;
  list-style: none;
}
.earlier__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.earlier__row:hover {
  background: var(--surface-3);
}
.earlier__row[data-active] {
  border-color: var(--action-line);
  background: var(--surface-3);
}
.earlier__row-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.earlier__row-sub {
  color: var(--ink-3);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
.earlier__more {
  margin: 0 0 var(--space-3);
}
.earlier__selected {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--hairline);
}
.earlier__read-title {
  margin: 0 0 var(--space-1);
  color: var(--ink);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.earlier__selected > .earlier__muted {
  margin: 0 0 var(--space-2);
}
.earlier__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-2) var(--space-5);
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
}
.earlier__facts dt {
  color: var(--ink-3);
}
.earlier__facts dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  overflow-wrap: anywhere;
}
.earlier__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: var(--space-3) 0;
}
.earlier__facts code {
  font-size: var(--text-xs);
}
.earlier__stored {
  margin-top: var(--space-2);
}
.earlier__stored :deep(.ui-disclosure__toggle) {
  min-height: 0;
  padding: var(--space-2) 0;
}
.earlier__stored :deep(.ui-disclosure__body) {
  padding-bottom: var(--space-2);
}
.earlier__retained {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.earlier__retained code {
  overflow-wrap: anywhere;
}
.earlier__notice {
  margin: var(--space-3) 0 0;
  color: var(--ok);
  font-size: var(--text-sm);
}
.earlier__muted code {
  font-size: var(--text-2xs);
  overflow-wrap: anywhere;
}
@media (max-width: 520px) {
  .earlier__head {
    align-items: flex-start;
    flex-direction: column;
  }
  .earlier__facts {
    grid-template-columns: 1fr;
    gap: 0 var(--space-3);
  }
}
</style>
