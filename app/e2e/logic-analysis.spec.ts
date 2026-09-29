import { expect, test } from "./test.ts";

test("Logic Studio analysis loads on demand and resolves source through a real worker", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await page.getByRole("heading", { name: "Your games" }).waitFor();
  expect(requests.some((url) => url.includes("/studio/logic/"))).toBe(false);
  const result = await page.evaluate(async () => {
    const { LogicAnalysisClient } = await import("/src/studio/logic/analysisClient.ts");
    const client = new LogicAnalysisClient();
    try {
      const source = '// 🎮\nif (said("op';
      const context = {
        revision: 1,
        profileId: "2.936" as const,
        words: [["open", 100] as const],
        bindings: { door: { num: 50 } },
      };
      client.setProject({ ...context, documents: { "logic:1": { version: 1, source } } });
      const completions = await client.request("logic:1", {
        method: "completeAt",
        offset: source.length,
      });
      const signature = await client.request("logic:1", {
        method: "signatureAt",
        offset: source.length,
      });
      const incomplete = await client.request("logic:1", { method: "diagnostics" });
      const repaired = "set(door); return;";
      client.setProject({
        ...context,
        revision: 2,
        documents: { "logic:1": { version: 2, source: repaired } },
      });
      const definition = await client.request("logic:1", { method: "definitionAt", offset: 4 });
      const valid = await client.request("logic:1", { method: "diagnostics" });
      return { completions, signature, incomplete, definition, valid };
    } finally {
      client.dispose();
    }
  });
  expect(requests.some((url) => url.includes("analysis.worker.ts"))).toBe(true);
  expect(result.completions).toContainEqual({
    label: "open",
    detail: "Word group 100",
    start: 15,
    end: 18,
    text: '"open"',
  });
  expect(result.signature?.label).toBe("said(word, ...)");
  expect(result.incomplete.diagnostics[0]?.line).toBe(2);
  expect(result.definition).toEqual({ kind: "binding", name: "door", document: "bindings" });
  expect(result.valid).toEqual({ diagnostics: [], generatedDiagnostics: [] });
});
