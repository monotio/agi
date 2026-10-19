/** Production Update timing, with the worker resume/frame endpoint used by the latency probe. */
import { expect, test } from "@playwright/test";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { writeProjectHistory } from "../../src/authoring/projectHistoryCodec.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { inspectEditableProject } from "../src/project/projectWorkspaceSource.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

const starter = createStarterProject("starter");
const files = Object.fromEntries(starter.files());
const documents = {
  ...inspectEditableProject({
    files,
    words: [],
    title: "Synthetic",
    projectId: requireProjectId("synthetic"),
    authoredAt: "",
  }).documents,
};
// 315 original documents, with source payloads and full manifests at the measured game size.
for (let i = 0; i < 256; i++) documents[`picture:${i}`] = `vis ${i % 16}\nfill 1,1\nend\n`;
for (let i = 2; Object.keys(documents).length < 315; i++)
  if (!Object.hasOwn(documents, `logic:${i}`))
    documents[`logic:${i}`] = `// Synthetic ${i} ${"x".repeat(4096)}\nreturn;`;
const compiled = compileProjectDocuments({ files, documents, profileId: "2.936" });

interface UpdateProbe {
  active: boolean;
  click: number;
  resume: number;
  done: number;
}

for (const edits of [0, 200, 400]) {
  test(
    `Update returns to running with ${edits} retained edits`,
    { tag: "@perf" },
    async ({ page }) => {
      const projectId = requireProjectId(`synthetic-history-${edits}`);
      const history = new ProjectHistory(sha256Hex);
      history.record(documents, { label: "Start", origin: "template", author: "creator", time: 0 });
      for (let i = 1; i <= edits; i++)
        history.record(
          { ...documents, "logic:2": `// Edit ${i} ${"y".repeat(12 * 1024)}\nreturn;` },
          { label: "Edit", origin: "logic", author: "creator", time: i },
        );
      if (edits > 0)
        history.record(documents, {
          label: "Measured room",
          origin: "logic",
          author: "creator",
          time: edits + 1,
        });
      const portable = writeProjectHistory(history.capture(), sha256Hex);
      const data: CachedGameData = {
        projectId,
        title: "Synthetic history",
        authoredAt: "2000-01-01T00:00:00.000Z",
        generation: 1,
        files: Object.fromEntries(compiled.files()),
        words: [],
        workspace: writeProjectWorkspace(documents),
        library: {
          version: 1,
          revision: compiled.build.identity.revision,
          source: "authored",
          profile: "2.936",
          validation: { status: "ready", message: "" },
        },
      };
      await page.route(/api\.(openai|anthropic)\.com/, (route) => route.abort());
      await page.addInitScript(() => {
        const probe: UpdateProbe = { active: false, click: 0, resume: 0, done: 0 };
        (window as unknown as { historyUpdateProbe: UpdateProbe }).historyUpdateProbe = probe;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            if (String(url).includes("engine.worker"))
              this.addEventListener("message", ({ data }) => {
                if (
                  probe.active &&
                  probe.resume &&
                  !probe.done &&
                  (data.type === "frame" || data.type === "cycle")
                )
                  requestAnimationFrame(() => {
                    probe.done ||= performance.now();
                  });
              });
          }
          override postMessage(message: unknown, transfer: Transferable[]): void;
          override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
          override postMessage(
            message: unknown,
            options?: Transferable[] | StructuredSerializeOptions,
          ): void {
            const command = message as { type: string; paused?: boolean };
            if (probe.active && command.type === "pause" && command.paused === false)
              probe.resume = performance.now();
            if (Array.isArray(options)) super.postMessage(message, options);
            else super.postMessage(message, options);
          }
        };
        document.addEventListener(
          "click",
          (event) => {
            if ((event.target as Element).closest('[data-testid="workspace-update"]')) {
              probe.active = true;
              probe.click = performance.now();
            }
          },
          true,
        );
      });
      await page.goto("/");
      expect(await page.locator('script[type="module"]').getAttribute("src")).toMatch(
        /^\/assets\//,
      );
      await page.evaluate(
        async ({ data, portable }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("monotio-agi-projects", 2);
            request.onupgradeneeded = () => {
              if (!request.result.objectStoreNames.contains("projects"))
                request.result.createObjectStore("projects", { keyPath: "projectId" });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const body = {
            ...data,
            files: Object.fromEntries(
              Object.entries(data.files).map(([name, bytes]) => [
                name,
                Uint8Array.from(Object.values(bytes)),
              ]),
            ),
            format: "monotio.agi.stored-project",
            version: 1,
            editHistory: { ...portable, blobs: Object.keys(portable.blobs).sort() },
          };
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("projects", "readwrite");
            const store = tx.objectStore("projects");
            store.put(body);
            for (const [hash, blob] of Object.entries(portable.blobs))
              store.put({
                projectId: `project-history/${data.projectId}/blobs/${hash}`,
                format: "monotio.agi.project-history-blob",
                version: 1,
                content: blob.type === "text" ? blob.text : Uint8Array.from(blob.bytes),
              });
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
          db.close();
          localStorage.setItem(
            `monotio_agi.authored.${data.projectId}`,
            JSON.stringify({
              projectId: data.projectId,
              title: data.title,
              authoredAt: data.authoredAt,
              generation: 1,
              library: data.library,
              format: "monotio.agi.project-index",
              version: 1,
              storage: "indexeddb",
            }),
          );
        },
        { data, portable },
      );
      await page.goto(`/?history-perf#create/${projectId}`);
      // Opening the largest History is setup, not the measured Update: it reads
      // and verifies megabytes of edits, which takes seconds on a CI runner.
      await expect(page.getByTestId("parts-list")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("part-room:1:picture:1").click();
      const studio = page.getByTestId("room-studio");
      const pane = studio.locator(".studio-pane").last();
      await pane.evaluate(() => document.fonts.ready);
      await pane.click({ trial: true });
      const box = (await pane.boundingBox())!;
      await pane.click({
        position: { x: (137.5 * box.width) / 160, y: (60.5 * box.height) / 168 },
      });
      await studio
        .locator(".workspace-palette")
        .getByRole("radio", { name: /^Colour 4:/ })
        .click();
      await expect(page.getByTestId("workspace-pending")).toBeVisible();
      await expect(page.getByTestId("workspace-saved")).toHaveText(/^(Saved|Draft saved)$/);
      await page.getByTestId("workspace-update").click();
      await page.waitForFunction(
        () =>
          (window as unknown as { historyUpdateProbe: UpdateProbe }).historyUpdateProbe.done > 0,
      );
      const elapsed = await page.evaluate(() => {
        const probe = (window as unknown as { historyUpdateProbe: UpdateProbe }).historyUpdateProbe;
        return probe.done - probe.click;
      });
      console.log(`[history-update] edits=${edits} elapsed=${elapsed.toFixed(1)}ms`);
      await test.info().attach("timing", {
        body: JSON.stringify({ edits, elapsed }),
        contentType: "application/json",
      });
      await expect(page.getByTestId("workspace-updated")).toBeVisible();
      await expect(page.getByTestId("workspace-saved")).toHaveText("Saved");
      // Worst of five runs at each history size: 394 ms. Keep about three times that.
      expect(elapsed).toBeLessThan(1200);
    },
  );
}
