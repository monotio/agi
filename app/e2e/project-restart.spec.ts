import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook, openWorkspaceAgent } from "./engineProbe.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerQueryFn, WorkerOutbound } from "../src/worker/workerProtocol.ts";

interface ProjectProbe {
  getSession(): ProjectSession | null;
  getWorker(): Worker | null;
  query: WorkerQueryFn;
}

test("Create re-enters the current room with a loaded VIEW's new loop count", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const cel = { width: 8, height: 8, pixels: new Array<number>(64).fill(14) };
  const documents = {
    "logic:0":
      "if (isset(f5)) { load.pic(0); draw.pic(0); show.pic(); load.view(0); animate.obj(o0); set.view(o0,0); position(o0,40,100); draw(o0); stop.motion(o0); } return;",
    "picture:0": "vis 1\nfill 1,1\nend\n",
    "view:0": JSON.stringify({ loops: [{ cels: [cel] }] }),
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const projectId = requireProjectId("reentry-browser-proof");
  await page.evaluate(
    async ({ files, workspace, buildId, projectId }) => {
      const { commitProject } = await import("/src/project/gameStorage.ts");
      await commitProject({
        projectId,
        commitId: "initial",
        workspaceId: "initial",
        expected: null,
        buildId,
        documents: [],
        data: {
          title: "Room proof",
          files: Object.fromEntries(
            Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
          ),
          words: [],
          workspace,
        },
      });
    },
    {
      projectId,
      files: Object.fromEntries(
        [...compiled.files()].map(([name, bytes]) => [name, Array.from(bytes)]),
      ),
      workspace: writeProjectWorkspace(documents),
      buildId: compiled.build.identity.buildId,
    },
  );
  await page.goto(`/?proof#create/${projectId}`);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__.getSession() !==
          null,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[100 * 160 + 40]))
    .toBe(14);
  const token = await page.evaluate(async (cel) => {
    const session = (
      window as unknown as { __AGI_PROJECT__: ProjectProbe }
    ).__AGI_PROJECT__.getSession()!;
    const result = await session.submit({
      proposal: session.model.propose(session.model.capture(), "Add loop", [
        {
          key: "view:0",
          content: JSON.stringify({
            loops: [{ cels: [{ ...cel, pixels: new Array<number>(64).fill(4) }] }, { cels: [cel] }],
          }),
        },
      ]),
      label: "Add loop",
      origin: "view",
      author: "creator",
    });
    if (result.status !== "restartRequired") throw new Error(result.status);
    return session.runToken;
  }, cel);
  await expect(page.getByTestId("project-restart-notice")).toContainText(
    "This change needs a fresh start of the room.",
  );
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[100 * 160 + 40]))
    .toBe(14);
  await reviewShot(page, "project-reentry-offer");
  await page.getByRole("button", { name: "Re-enter room", exact: true }).click();
  await expect(page.getByTestId("project-restart-notice")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[100 * 160 + 40]))
    .toBe(4);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__.getSession()!
          .runToken,
    ),
  ).toBe(token);
  await reviewShot(page, "project-reentry-running");
});

test("Create saves OBJECT removal and restarts MAIN with the changed image", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const documents = {
    "logic:0":
      'if (isset(f5)) { load.pic(0); draw.pic(0); show.pic(); accept.input(); } if (said("look")) { print("Changed game runs"); } return;',
    "picture:0": "vis 1\nfill 1,1\nend\n",
    inventory: '[{"name":"key","startingRoom":1},{"name":"coin","startingRoom":2}]',
    words: '[["look",10]]',
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const projectId = requireProjectId("restart-browser-proof");
  await page.evaluate(
    async ({ files, workspace, buildId, projectId }) => {
      const { commitProject } = await import("/src/project/gameStorage.ts");
      await commitProject({
        projectId,
        commitId: "initial",
        workspaceId: "initial",
        expected: null,
        buildId,
        documents: [],
        data: {
          title: "Restart proof",
          files: Object.fromEntries(
            Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
          ),
          words: [["look", 10]],
          workspace,
        },
      });
    },
    {
      projectId,
      files: Object.fromEntries(
        [...compiled.files()].map(([name, bytes]) => [name, Array.from(bytes)]),
      ),
      workspace: writeProjectWorkspace(documents),
      buildId: compiled.build.identity.buildId,
    },
  );
  await page.goto(`/?proof#create/${projectId}`);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__.getSession() !==
          null,
      ),
    )
    .toBe(true);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);
  const token = await page.evaluate(async () => {
    const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
    const session = probe.getSession()!;
    const token = session.runToken;
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Paint room", [
        { key: "picture:0", content: "vis 4\nfill 1,1\nend\n" },
      ]),
      label: "Paint room",
      origin: "picture",
      author: "creator",
    });
    const result = await session.submit({
      proposal: session.model.propose(session.model.capture(), "Remove coin", [
        { key: "inventory", content: '[{"name":"key","startingRoom":1}]' },
      ]),
      label: "Remove coin",
      origin: "logic",
      author: "creator",
    });
    if (result.status !== "restartRequired") throw new Error(result.status);
    await session.flush();
    const worker = probe.getWorker()!;
    const carriedFiles = await new Promise<boolean>((resolve) => {
      let files = false;
      const receive = (event: MessageEvent<WorkerOutbound>) => {
        if (event.data.type === "autosave") files = event.data.files !== undefined;
        if (event.data.type === "flushed" && event.data.id === 77777) {
          worker.removeEventListener("message", receive);
          resolve(files);
        }
      };
      worker.addEventListener("message", receive);
      worker.postMessage({ type: "flush", id: 77777 });
    });
    if (carriedFiles) throw new Error("Progress autosave carried the previous project image.");
    return token;
  });
  await expect(page.getByTestId("project-restart-notice")).toContainText(
    "This change needs the game to restart.",
  );
  await expect(page.getByTestId("project-restart-notice")).toContainText("OBJECT");
  await openWorkspaceAgent(page);
  await page.getByTestId("btn-record-test").click();
  await expect(page.getByTestId("recording-bar")).toBeVisible();
  await reviewShot(page, "project-restart-offer");
  await page.getByRole("button", { name: "Restart with your changes", exact: true }).click();
  await expect(page.getByTestId("project-restart-notice")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__.getSession()!
            .runToken,
      ),
    )
    .not.toBe(token);
  await expect(page.getByTestId("recording-bar")).toHaveCount(0);
  await expect(page.getByTestId("record-error")).toContainText("Game restarted");
  await openWorkspaceAgent(page);
  await page.getByTestId("btn-record-test").click();
  await expect(page.getByTestId("recording-bar")).toBeVisible();
  await page.getByTestId("record-stop").click();
  await expect(page.getByTestId("record-dialog")).toBeVisible();
  await page.getByTestId("record-save-cancel").click();
  const running = await page.evaluate(
    async ({ inventoryPath, profilePath }) => {
      const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
      const files = (await probe.query("exportFiles", {}))!;
      const { readInventoryObjects } = await import(inventoryPath);
      const { PROFILES } = await import(profilePath);
      probe.getWorker()!.postMessage({ type: "input", text: "look" });
      return readInventoryObjects(files["OBJECT"], PROFILES["2.936"]!).map(
        (item: { name: string }) => item.name,
      );
    },
    {
      inventoryPath: `/@fs${new URL("../../src/authoring/inventory.ts", import.meta.url).pathname}`,
      profilePath: `/@fs${new URL("../../src/runtime/profile.ts", import.meta.url).pathname}`,
    },
  );
  expect(running).toEqual(["key"]);
  await expect
    .poll(() =>
      page.evaluate(
        async ({ projectId, inventoryPath, profilePath }) => {
          const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
          const { loadGameHistory } = await import("/src/history/historyStorage.ts");
          const { projectProgressTarget } = await import("/src/project/progressTarget.ts");
          const { base64ToBytes } = await import("/src/project/bytes.ts");
          const { readInventoryObjects } = await import(inventoryPath);
          const { PROFILES } = await import(profilePath);
          const session = probe.getSession()!;
          const target = projectProgressTarget(
            projectId,
            session.model.capture().lastAdmissibleBuild!.identity.revision,
            session.lifetime,
          )!;
          const history = await loadGameHistory(target.locator);
          return history?.segments.map((segment) =>
            readInventoryObjects(
              base64ToBytes(segment.boot.files["OBJECT"]!),
              PROFILES["2.936"]!,
            ).map((item: { name: string }) => item.name),
          );
        },
        {
          projectId,
          inventoryPath: `/@fs${new URL("../../src/authoring/inventory.ts", import.meta.url).pathname}`,
          profilePath: `/@fs${new URL("../../src/runtime/profile.ts", import.meta.url).pathname}`,
        },
      ),
    )
    .toEqual([["key", "coin"], ["key"]]);
  await expect
    .poll(async () => (await textHook(page)).rows.join("\n"))
    .toContain("Changed game runs");
  await reviewShot(page, "project-restart-running");
});
