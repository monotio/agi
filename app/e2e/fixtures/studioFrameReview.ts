import { createApp, h, nextTick, shallowRef, type App } from "vue";
import type { ProjectStudioDestination } from "../../src/shell/projectStudioNav.ts";
import ProjectExplorer from "../../src/studio/host/ProjectExplorer.vue";
import ProjectOverview from "../../src/studio/host/ProjectOverview.vue";
import ProjectTabs from "../../src/studio/host/ProjectTabs.vue";
import {
  closeProjectStudioTab,
  createProjectStudioNavigation,
  openProjectStudioDocument,
  projectStudioTabs,
  selectProjectStudioDestination,
  type ProjectStudioAction,
} from "../../src/studio/host/projectStudioDocuments.ts";
import {
  workspaceDocuments,
  type LogicDocumentContent,
  type LogicWorkspaceDocument,
} from "../../src/studio/logic/logicWorkspace.ts";

/**
 * A component harness for the frame's stage-A pieces: the real tab strip,
 * explorer and overview mounted together under a controlled parent that
 * answers their events through the real navigation model. This is a review
 * layout, not the production frame — nothing here claims the mounted host.
 */

const DOCUMENTS: Readonly<Record<string, LogicDocumentContent>> = {
  "logic:0": "// boot\n",
  "logic:1": "// the clearing\nreturn;\n",
  "picture:1": "# clearing\nend\n",
  "view:1": "cel a\nrow 0 ..\nendcel\nloop 0 a\nendview\n",
  "sound:1": "cue",
  words: new Uint8Array([0, 0]),
  inventory: "{}",
  bindings: JSON.stringify({
    boot_logic: { kind: "logic", num: 0 },
    first_room: { kind: "logic", num: 1 },
    clearing_pic: { kind: "picture", num: 1 },
  }),
  world: JSON.stringify({
    rooms: { "1": { title: "Clearing", description: "", exits: {} } },
    facts: {},
    quests: {},
  }),
};

const ACTIONS: readonly ProjectStudioAction[] = [
  { id: "export", label: "Export", hint: "Write a game archive" },
  {
    id: "playtest",
    label: "Playtest",
    hint: "Run the game",
    unavailableReason: "A playtest is already running.",
  },
];

const REJECTED: readonly string[] = ["sound:9", "logic:1"];

let app: App | undefined;
let container: HTMLElement | undefined;
const emitted: { readonly type: string; readonly detail: string }[] = [];

/** The destination and action events the mounted components emitted, in order. */
export function emittedEvents(): readonly { type: string; detail: string }[] {
  return emitted;
}

/** Mount the harness with the real navigation model answering select/close. */
export async function mount(): Promise<void> {
  const documents: readonly LogicWorkspaceDocument[] = workspaceDocuments(DOCUMENTS, ["picture:1"]);
  let initial = createProjectStudioNavigation();
  for (const key of ["logic:1", "picture:1"]) {
    initial = openProjectStudioDocument(initial, key);
  }
  initial = selectProjectStudioDestination(initial, { kind: "overview" });
  const navigation = shallowRef(initial);
  container = document.createElement("div");
  container.style.cssText =
    "position:fixed;inset:0;z-index:999;display:flex;flex-direction:column;background:var(--surface-1);color:var(--ink)";
  document.body.append(container);
  app = createApp({
    render: () =>
      h("div", { style: "display:flex;flex-direction:column;height:100%" }, [
        h(ProjectTabs, {
          tabs: projectStudioTabs(navigation.value.tabs, documents),
          selectedKey:
            navigation.value.destination.kind === "document"
              ? navigation.value.destination.key
              : null,
          onSelect: (key: string) => {
            emitted.push({ type: "tab-select", detail: key });
            navigation.value = selectProjectStudioDestination(navigation.value, {
              kind: "document",
              key,
            });
          },
          onClose: (key: string) => {
            emitted.push({ type: "tab-close", detail: key });
            navigation.value = closeProjectStudioTab(navigation.value, key);
          },
        }),
        h("div", { style: "flex:1;display:flex;min-height:0" }, [
          h(
            "div",
            {
              style:
                "width:240px;flex:none;border-right:1px solid var(--hairline);overflow:hidden;display:flex",
            },
            [
              h(ProjectExplorer, {
                documents,
                destination: navigation.value.destination,
                rejectedKeys: REJECTED,
                style: "flex:1;min-width:0",
                onSelect: (destination: ProjectStudioDestination) => {
                  emitted.push({ type: "explorer-select", detail: JSON.stringify(destination) });
                  navigation.value = selectProjectStudioDestination(navigation.value, destination);
                },
              }),
            ],
          ),
          h("div", { style: "flex:1;min-width:0;overflow:hidden;display:flex" }, [
            navigation.value.destination.kind === "overview"
              ? h(ProjectOverview, {
                  title: "Frame review",
                  profile: "AGI 2.936",
                  documents,
                  actions: ACTIONS,
                  style: "flex:1;min-width:0",
                  onSelect: (destination: ProjectStudioDestination) => {
                    emitted.push({ type: "overview-select", detail: JSON.stringify(destination) });
                    navigation.value = selectProjectStudioDestination(
                      navigation.value,
                      destination,
                    );
                  },
                  onAction: (id: string) => {
                    emitted.push({ type: "action", detail: id });
                  },
                })
              : h(
                  "div",
                  {
                    "data-testid": "frame-review-document",
                    style: "flex:1;padding:24px;font:14px/1.4 sans-serif",
                  },
                  `Open document: ${
                    navigation.value.destination.kind === "document"
                      ? navigation.value.destination.key
                      : ""
                  }`,
                ),
          ]),
        ]),
      ]),
  });
  app.mount(container);
  await nextTick();
}

export function unmount(): void {
  app?.unmount();
  app = undefined;
  container?.remove();
  container = undefined;
}
