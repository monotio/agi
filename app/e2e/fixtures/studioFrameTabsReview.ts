import { createApp, h, nextTick, shallowRef } from "vue";
import ProjectTabs from "../../src/studio/host/ProjectTabs.vue";
import {
  closeProjectStudioTab,
  createProjectStudioNavigation,
  openProjectStudioDocument,
  selectProjectStudioDestination,
} from "../../src/studio/host/projectStudioDocuments.ts";

/** Mount the actual tab strip with a controlled parent using its public events. */
export async function mount(): Promise<void> {
  let initial = createProjectStudioNavigation();
  for (const key of ["logic:1", "picture:1", "sound:1"])
    initial = openProjectStudioDocument(initial, key);
  initial = selectProjectStudioDestination(initial, { kind: "document", key: "picture:1" });
  const navigation = shallowRef(initial);
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;z-index:999;background:var(--surface)";
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(ProjectTabs, {
        tabs: navigation.value.tabs.map((key) => ({
          key,
          label: key,
          dirty: key === "picture:1",
          missing: false,
        })),
        selectedKey:
          navigation.value.destination.kind === "document"
            ? navigation.value.destination.key
            : null,
        onSelect: (key: string) => {
          navigation.value = openProjectStudioDocument(navigation.value, key);
        },
        onClose: (key: string) => {
          navigation.value = closeProjectStudioTab(navigation.value, key);
        },
      }),
  });
  app.mount(container);
  await nextTick();
}
