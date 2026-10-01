import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import { openLibraryActions, savedGameCard, screenText, textHook } from "./engineProbe.ts";
import { blockProviders, prepareIsolatedPage } from "./logicDebugShared.ts";
import { openContainer } from "../../src/container/container.ts";
import { parseWordsTok } from "../../src/logic/words.ts";

test.use({ viewport: { width: 1440, height: 900 } });

/** Read the user's actual project; this helper never seeds or edits it. */
async function storedProject(page: Page, title: string) {
  return page.evaluate(async (wanted) => {
    const { listStoredProjects, loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
    const entry = (await listStoredProjects()).find((item) => item.title === wanted);
    if (entry === undefined) throw new Error("The created project is missing.");
    const data = await loadAuthoredGame(entry.projectId);
    if (data === null) throw new Error("The created body is missing.");
    const documents = inspectEditableProject(data).documents;
    return {
      id: entry.projectId,
      revision: data.library?.revision,
      documents: Object.fromEntries(
        Object.entries(documents).filter(
          (item): item is [string, string] => typeof item[1] === "string",
        ),
      ),
      files: Object.fromEntries(
        Object.entries(data.files).map(([name, bytes]) => [name, [...bytes]]),
      ),
    };
  }, title);
}

/** Select with the keyboard and paste through the editor's DOM input. */
async function replaceDocument(page: Page, key: string, text: string): Promise<void> {
  await page.getByTestId("logic-explorer").getByTestId(`logic-doc-${key}`).click();
  await page.getByTestId("logic-editor").locator(".view-lines").click();
  const modifier = await page.evaluate(() =>
    navigator.userAgent.includes("Macintosh") ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+a`);
  const selection = await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.closest("[data-testid='logic-editor']"));
    const model = editor?.getModel();
    const selected = editor?.getSelection();
    return {
      userAgent: navigator.userAgent,
      value: model?.getValue(),
      selected: model && selected ? model.getValueInRange(selected) : null,
    };
  });
  await test.info().attach(`selection-${key}`, {
    body: JSON.stringify(selection),
    contentType: "application/json",
  });
  expect(selection.selected).toBe(selection.value);
  await page
    .getByTestId("logic-editor")
    .locator(".native-edit-context, textarea.inputarea")
    .first()
    .evaluate((surface, source) => {
      const data = new DataTransfer();
      data.setData("text/plain", source);
      surface.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(async (wanted) => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor
          .getModels()
          .find((model) => model.uri.toString().endsWith(`/${encodeURIComponent(wanted)}`))
          ?.getValue();
      }, key),
    )
    .toBe(text);
}

async function command(page: Page, text: string, reply: string): Promise<void> {
  const input = page.getByTestId("input-line");
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press("Enter");
  await expect
    .poll(async () => (await screenText(page)).replace(/#/g, " ").replace(/\s+/g, " "))
    .toContain(reply);
}

for (const kind of ["blank", "starter"] as const) {
  test(`${kind} supports a manually authored vocabulary and inventory puzzle @webkit-desktop`, async ({
    page,
  }) => {
    await prepareIsolatedPage(page);
    const providers = blockProviders(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const title = `The bronze gate ${kind}`;
    await page.goto("/");
    await page.getByTestId("create-adventure-toggle").click();
    await page.getByTestId("local-create-title").fill(title);
    await page.getByTestId(`local-create-kind-${kind}`).check();
    await page.getByTestId("local-create-submit").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await page.getByTestId("btn-exit").click();
    const before = await storedProject(page, title);
    const room = before.documents["logic:1"];
    const vocabulary = before.documents["words"];
    const inventory = before.documents["inventory"];
    expect(typeof room).toBe("string");
    expect(typeof vocabulary).toBe("string");
    expect(typeof inventory).toBe("string");
    expect(JSON.parse(inventory!)).toEqual([]);
    const words = JSON.parse(vocabulary!) as [string, number][];
    let nextGroup = Math.max(255, ...words.map((entry) => entry[1])) + 1;
    for (const word of ["collect", "relic", "open", "gate", "pockets"])
      if (!words.some((entry) => entry[0] === word)) words.push([word, nextGroup++]);
    const puzzle = `
if (said("collect", "relic")) {
  if (!has(0)) { get(0); print("You pick up the bronze relic."); }
  else { print("The bronze relic is already in your pocket."); }
}
if (said("open", "gate")) {
  if (has(0)) { set(f230); print("The gate opens. Your adventure is complete."); }
  else { print("Find the bronze relic to open the gate."); }
}
if (said("pockets")) { status(); }
return;
`;
    expect(room).toMatch(/return;\s*$/);
    const source = room!.replace(/return;\s*$/, puzzle);
    const card = savedGameCard(page, title);
    await openLibraryActions(page, card);
    await page.getByTestId("edit-library-game").click();
    await expect(page.getByTestId("logic-studio")).toBeVisible();
    await replaceDocument(page, "words", JSON.stringify(words, null, 2));
    await replaceDocument(
      page,
      "inventory",
      JSON.stringify([{ name: "bronze relic", startingRoom: 1 }], null, 2),
    );
    await replaceDocument(page, "logic:1", source);
    await expect(page.getByTestId("logic-studio-status")).toContainText("3 changes");
    await page.getByTestId("logic-review-build").click();
    await reviewShot(page, `manual-inventory-${kind}-review`);
    await expect(
      page.getByTestId("logic-keep-confirm"),
      (await page.getByTestId("logic-review-error").allTextContents()).join("\n"),
    ).toBeEnabled();
    await page.getByTestId("logic-keep-confirm").click();
    await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
    const kept = await storedProject(page, title);
    expect(kept.documents["logic:1"]).toBe(source);
    expect(JSON.parse(kept.documents["inventory"]!)).toEqual([
      { name: "bronze relic", startingRoom: 1 },
    ]);
    expect(kept.revision).not.toBe(before.revision);
    const container = openContainer(
      new Map(Object.entries(kept.files).map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
    );
    expect(container.getResource("logic", 1)).toBeDefined();
    const compiledWords = parseWordsTok(container.files.get("WORDS.TOK")!);
    expect(compiledWords.some((entry) => entry.word === "relic")).toBe(true);
    expect(kept.files["OBJECT"]).not.toEqual(before.files["OBJECT"]);
    await page.getByTestId("logic-close").click();
    await expect(page.getByTestId("logic-studio")).toBeHidden();
    // Playtest the newly kept bytes from the opening; earlier progress remains separate.
    await openLibraryActions(page, savedGameCard(page, title));
    await page.getByTestId("start-library-game-over").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await command(page, "open gate", "Find the bronze relic to open the gate.");
    await page.keyboard.press("Enter");
    await command(page, "collect relic", "You pick up the bronze relic.");
    await page.keyboard.press("Enter");
    await command(page, "pockets", "bronze relic");
    await expect.poll(async () => (await textHook(page)).modal).toBe("inventory");
    await reviewShot(page, `manual-inventory-${kind}-pockets`);
    await page.keyboard.press("Enter");
    await command(page, "open gate", "The gate opens. Your adventure is complete.");
    await reviewShot(page, `manual-inventory-${kind}-win`);
    expect(providers.count()).toBe(0);
    expect(errors).toEqual([]);
  });
}
