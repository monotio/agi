import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";
import { testProjectId } from "../test/identity.ts";

test("workspace drafts survive reload and coordinate writes between real browser tabs", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const input = await page.evaluate(async (projectId) => {
    const storage = await import("/src/project/gameStorage.ts");
    const { saveProjectDraft } = await import("/src/project/projectDrafts.ts");
    const { receipt } = await storage.commitProject({
      projectId,
      commitId: "first",
      workspaceId: "tab-a",
      buildId: "a".repeat(64),
      expected: null,
      documents: [],
      data: {
        title: "Unfinished adventure",
        provider: "",
        model: "",
        files: { "WORDS.TOK": new Uint8Array(52) },
        words: [],
      },
    });
    const input = {
      projectId,
      workspaceId: "tab-a",
      expectedReceipt: null,
      expected: { generation: receipt.saved.generation, lifetime: receipt.saved.lifetime },
      recovery: {
        format: "monotio.agi.recovery-draft",
        version: 1,
        base: {
          revision: receipt.saved.revision,
          authoring: receipt.saved.authoring,
          profileId: "2.936",
        },
        documents: [{ key: "logic:0", version: 1, content: { type: "text", text: "if (" } }],
        operations: [],
      },
    };
    const expectedReceipt = await saveProjectDraft(input);
    return { ...input, expectedReceipt };
  }, testProjectId("browser-recovery"));
  await page.reload();
  const other = await context.newPage();
  await other.goto("/");
  try {
    const recovered = await other.evaluate(async (id) => {
      const { listProjectDrafts } = await import("/src/project/projectDrafts.ts");
      return listProjectDrafts(id);
    }, input.projectId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      workspaceId: "tab-a",
      receipt: { sequence: 1 },
      status: "current",
    });
    expect(recovered[0]!.recovery.documents[0]!.content).toEqual({ type: "text", text: "if (" });
    const results = await Promise.all(
      [page, other].map((tab) =>
        tab.evaluate(async (input) => {
          const { saveProjectDraft } = await import("/src/project/projectDrafts.ts");
          try {
            return await saveProjectDraft(input);
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }, input),
      ),
    );
    expect(
      results.filter((value) => typeof value !== "string" && value.sequence === 2),
    ).toHaveLength(1);
    expect(
      results.filter((value) => typeof value === "string" && /changed/.test(value)),
    ).toHaveLength(1);
    const otherReceipt = await other.evaluate(async (input) => {
      const { saveProjectDraft } = await import("/src/project/projectDrafts.ts");
      return saveProjectDraft({ ...input, workspaceId: "tab-b", expectedReceipt: null });
    }, input);
    const remaining = await page.evaluate(async (id) => {
      const storage = await import("/src/project/gameStorage.ts");
      const { listProjectDrafts } = await import("/src/project/projectDrafts.ts");
      const saved = await storage.loadAuthoredGame(id);
      if (saved?.generation !== 1 || saved.authoringState !== undefined)
        throw new Error("Autosave changed the kept project");
      await storage.clearCachedGame(id);
      return listProjectDrafts(id);
    }, input.projectId);
    expect(remaining).toEqual([]);
    const refused = await other.evaluate(
      async (input) => {
        const { saveProjectDraft } = await import("/src/project/projectDrafts.ts");
        try {
          await saveProjectDraft(input);
          return false;
        } catch {
          return true;
        }
      },
      { ...input, workspaceId: "tab-b", expectedReceipt: otherReceipt },
    );
    expect(refused).toBe(true);
  } finally {
    await other.close();
  }
});
