import { expect, test } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";
import { encodePngRgb } from "../../src/picture/png.ts";

// A completed background preparation update must not replace the text the
// author is still editing before its ordinary change/blur commit.
test("a background view update preserves the focused numeric edit @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => route.abort());
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Numeric edit", kind: "starter" }).save();
  });
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Numeric edit"));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("logic-studio")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-view:1").click();
  await page.getByTestId("logic-resource-edit").click();
  const creative = page.getByTestId("creative-workspace");
  await creative.getByTestId("creative-choose").setInputFiles({
    name: "frames.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgb(48, 32, new Uint8Array(48 * 32 * 3).fill(77))),
  });
  await expect(creative.locator(".source-preview").getByText("frames.png")).toBeVisible();
  await creative.getByRole("button", { name: "Use as a character or object" }).click();
  const frames = page.getByTestId("frame-editor");
  const width = frames.getByLabel("Region width").first();
  await expect(width).toHaveValue("48");
  await width.fill("8");
  await expect(width).toBeFocused();
  // Exercise the real mounted workspace's public update path, as an
  // asynchronous preparation result does, without clicking or blurring.
  await creative.evaluate((element) => {
    interface Mounted {
      parent: Mounted | null;
      props: Record<string, unknown>;
    }
    let instance = (element as HTMLElement & { __vueParentComponent?: Mounted })
      .__vueParentComponent;
    while (instance) {
      const workspace = instance.props["workspace"] as
        { updateViewJob?: (patch: { description: string }) => void } | undefined;
      if (typeof workspace?.updateViewJob === "function") {
        workspace.updateViewJob({ description: "Background note" });
        return;
      }
      instance = instance.parent ?? undefined;
    }
    throw new Error("mounted creative workspace is unavailable");
  });
  await expect(frames.getByLabel("Description")).toHaveValue("Background note");
  await expect(width).toBeFocused();
  await expect(
    width,
    "a background update cannot replace the unfinished numeric value",
  ).toHaveValue("8");
  await width.press("Tab");
  await expect(width).toHaveValue("8");
});
