import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook, waitForAutosaveAfter } from "./engineProbe.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerQueryFn, WorkerInbound } from "../src/worker/workerProtocol.ts";

interface ProjectProbe {
  getSession(): ProjectSession | null;
  getWorker(): Worker | null;
  query: WorkerQueryFn;
}

test("MAIN Create edits, Undo and invalid source autosave survive reopen", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const source =
    'if (v40 == 0) { load.pic(0); draw.pic(0); show.pic(); accept.input(); assignn(v40,1); } if (said("look")) { print("Old room"); } return;';
  const documents = {
    "logic:0": source,
    "picture:0": "vis 1\nfill 1,1\nend\n",
    words: '[["look",10]]',
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
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
          title: "Browser proof",
          files: Object.fromEntries(
            Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
          ),
          words: [["look", 10]],
          workspace,
        },
      });
    },
    {
      projectId: requireProjectId("main-browser-proof"),
      files: Object.fromEntries(
        [...compiled.files()].map(([name, bytes]) => [name, Array.from(bytes)]),
      ),
      workspace: writeProjectWorkspace(documents),
      buildId: compiled.build.identity.buildId,
    },
  );
  await page.goto("/?proof#create/main-browser-proof");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
        const state = (
          window as unknown as { __AGI_STATE__: { phase: string; status: string; error: string } }
        ).__AGI_STATE__;
        return probe.getSession() === null
          ? `${state.phase}: ${state.status} ${state.error}`
          : "opened";
      }),
    )
    .toBe("opened");
  const result = await page.evaluate(async (source) => {
    const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
    const session = probe.getSession()!;
    const worker = probe.getWorker()!;
    const edit = (key: string, content: string, origin: "picture" | "logic" | "words") =>
      session.submit({
        proposal: session.model.propose(session.model.capture(), key, [{ key, content }]),
        origin,
        label: key,
        author: "creator",
      });
    const picture = await edit("picture:0", "vis 4\nfill 1,1\nend\n", "picture");
    const logic = await edit("logic:0", source.replace("Old room", "New room"), "logic");
    worker.postMessage({ type: "input", text: "look" } satisfies WorkerInbound);
    return {
      picture: picture.status,
      logic: logic.status,
      sameWorker: worker === probe.getWorker(),
      runToken: session.runToken,
    };
  }, source);
  expect(result).toMatchObject({ picture: "committed", logic: "committed", sameWorker: true });
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("New room");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = document.querySelector(".node-thumb")?.getAttribute("href");
        if (url === null || url === undefined) return [];
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(1, 1, 1, 1).data).slice(0, 3);
      }),
    )
    .toEqual([170, 0, 0]);
  await reviewShot(page, "main-project-live-message");
  await page.evaluate(() => {
    const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
    probe.getWorker()!.postMessage({ type: "dismissPrint" } satisfies WorkerInbound);
  });
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).not.toContain("New room");
  const words = await page.evaluate(async () => {
    const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
    const session = probe.getSession()!;
    const result = await session.submit({
      proposal: session.model.propose(session.model.capture(), "WORDS", [
        { key: "words", content: '[["look",10],["inspect",10]]' },
      ]),
      origin: "words",
      label: "WORDS",
      author: "creator",
    });
    probe.getWorker()!.postMessage({ type: "input", text: "inspect" } satisfies WorkerInbound);
    return result.status;
  });
  expect(words).toBe("committed");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("New room");
  const saved = await page.evaluate(async (projectId) => {
    const probe = (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__;
    probe.getWorker()!.postMessage({ type: "dismissPrint" } satisfies WorkerInbound);
    const session = probe.getSession()!;
    const edit = (key: string, content: string, origin: "logic" | "words") =>
      session.submit({
        proposal: session.model.propose(session.model.capture(), key, [{ key, content }]),
        origin,
        label: key,
        author: "creator",
      });
    const undo = await session.undo();
    const before = Object.fromEntries(session.model.capture().lastAdmissibleBuild!.files());
    const invalid = await edit("logic:0", "if (", "logic");
    await session.flush();
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = (await loadAuthoredGame(projectId))!;
    return {
      undo: undo?.status,
      invalid: invalid.status,
      state: session.saveStatus().state,
      commits: session.history.capture().commits.length,
      workspace: data.workspace,
      bytes: Object.entries(data.files).map(([name, bytes]) => [name, Array.from(bytes)]),
      before: Object.entries(before).map(([name, bytes]) => [name, Array.from(bytes)]),
      runToken: session.runToken,
    };
  }, requireProjectId("main-browser-proof"));
  expect(saved).toMatchObject({
    undo: "committed",
    invalid: "diagnostics",
    state: "saved",
    commits: 5,
    runToken: result.runToken,
  });
  expect(saved.bytes).toEqual(saved.before);
  expect(saved.workspace?.documents.find((doc) => doc.key === "logic:0")?.content).toEqual({
    type: "text",
    text: "if (",
  });
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await expect(page).toHaveURL(/#create\/main-browser-proof/);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __AGI_PROJECT__: ProjectProbe }).__AGI_PROJECT__
            .getSession()
            ?.model.capture()
            .read("logic:0")?.content,
      ),
    )
    .toBe("if (");
  const reopened = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: ProjectProbe }
    ).__AGI_PROJECT__.getSession()!;
    return {
      commits: session.history.capture().commits.length,
      bytes: [...session.model.capture().lastAdmissibleBuild!.files()].map(([name, bytes]) => [
        name,
        Array.from(bytes),
      ]),
    };
  });
  expect(reopened.commits).toBe(5);
  expect(reopened.bytes).toEqual(saved.bytes);
});
