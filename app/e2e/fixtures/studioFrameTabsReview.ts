import { createApp, h, nextTick, shallowRef } from "vue";
import ProjectTabs from "../../src/studio/host/ProjectTabs.vue";

/** Mount the actual tab strip with a controlled parent using its public events. */
export async function mount(): Promise<void> {
  const state = shallowRef({
    tabs: ["logic:1", "picture:1", "sound:1"],
    selected: "picture:1" as string | null,
  });
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;z-index:999;background:var(--surface)";
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(ProjectTabs, {
        tabs: state.value.tabs.map((key) => ({
          key,
          label: key,
          dirty: key === "picture:1",
          missing: false,
        })),
        selectedKey: state.value.selected,
        onSelect: (key: string) => {
          state.value = { ...state.value, selected: key };
        },
        onClose: (key: string) => {
          const tabs = state.value.tabs.filter((tab) => tab !== key);
          const selected =
            state.value.selected === key
              ? (tabs[Math.min(state.value.tabs.indexOf(key), tabs.length - 1)] ?? null)
              : state.value.selected;
          state.value = { tabs, selected };
        },
      }),
  });
  app.mount(container);
  await nextTick();
}
