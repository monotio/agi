import { createApp, h, nextTick, shallowRef, type App } from "vue";
import StudioDockHost from "../../src/studio/creative/StudioDockHost.vue";
import { openEditableProject } from "../../src/project/editableProject.ts";
import { clearCachedGame, serializeWrite } from "../../src/project/gameStorage.ts";
import type { ProjectId } from "../../src/project/gameTypes.ts";
import type { StudioRequest } from "../../src/shell/useCreateWorkspace.ts";
import { openProjectResourceEditor } from "../../src/studio/project/projectResourceEdits.ts";

let app: App | undefined;
let root: HTMLElement | undefined;
let changeStudio: (() => void) | undefined;
let release: (() => void) | undefined;
let held: Promise<void> | undefined;
let pendingOpen: Promise<void> | undefined;
let project: ProjectId | undefined;

/** Mount the real dock over a stored project's real resource, with a controlled parent. */
export async function mount(projectId: ProjectId): Promise<void> {
  const workspace = await openEditableProject(projectId);
  const resource = openProjectResourceEditor(workspace, "picture:1");
  const studio = shallowRef<StudioRequest>({
    kind: "picture",
    room: 1,
    pictureNumber: resource.number,
    bytes: resource.bytes,
    profile: resource.profile,
    title: "Dock review",
    baseRevision: resource.baseRevision,
    baseAuthoring: resource.baseAuthoring,
    files: resource.files,
    reload: () => null,
    reloadFromStorage: async () => null,
  });
  project = projectId;
  changeStudio = () => {
    studio.value = { ...studio.value, title: "Reopened studio" };
  };
  root = document.createElement("div");
  root.style.cssText = "position:fixed;inset:0;z-index:999;background:black";
  document.body.append(root);
  app = createApp({
    render: () =>
      h(
        StudioDockHost,
        { studio: studio.value, projectId, style: "height:100%" },
        {
          default: ({ launch }: { launch?: () => Promise<void> }) =>
            h(
              "button",
              {
                "data-testid": "review-open-dock",
                onClick: () => {
                  pendingOpen = launch?.();
                },
              },
              "Import image",
            ),
        },
      ),
  });
  app.mount(root);
  await nextTick();
}

/** Defer the actual storage queue the dock's open must read. */
export async function holdWrites(): Promise<void> {
  if (project === undefined) throw new Error("Dock fixture is not mounted");
  await new Promise<void>((started) => {
    held = serializeWrite(
      project!,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          started();
        }),
    );
  });
}

export async function replaceStudio(): Promise<void> {
  changeStudio?.();
  await nextTick();
}

export async function settleOpen(): Promise<void> {
  release?.();
  await held;
  await pendingOpen;
  await nextTick();
}

export function unmount(): void {
  app?.unmount();
  app = undefined;
  root?.remove();
  root = undefined;
}

/** Remove the saved body after mount so a real dock open reports its refusal. */
export async function removeSavedProject(): Promise<void> {
  if (project === undefined) throw new Error("Dock fixture is not mounted");
  await clearCachedGame(project);
}

/** Count real project body reads during the refused-open observation window. */
export async function countRefusedOpenReads(): Promise<number> {
  if (project === undefined) throw new Error("Dock fixture is not mounted");
  const original = IDBObjectStore.prototype.get;
  let reads = 0;
  IDBObjectStore.prototype.get = function (key: IDBValidKey): IDBRequest {
    if (key === project) reads++;
    return original.call(this, key);
  };
  try {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([0])], "missing.png", { type: "image/png" }));
    root
      ?.querySelector(".studio-host")
      ?.dispatchEvent(
        new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    // Give the actual IDB refusal and UI several painted frames to settle.
    for (let i = 0; i < 12; i++)
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    return reads;
  } finally {
    IDBObjectStore.prototype.get = original;
  }
}
