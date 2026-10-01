import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import type { Locator } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 720 } });

async function expectControlsFit(panel: Locator): Promise<void> {
  const clipped = await panel.evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const left = Math.max(0, panel.left);
    const right = Math.min(innerWidth, panel.right);
    return [...element.querySelectorAll<HTMLElement>("button,input,select,textarea")]
      .filter((control) => control.getClientRects().length !== 0)
      .flatMap((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && (rect.left < left - 1 || rect.right > right + 1)
          ? [
              {
                name:
                  control.getAttribute("aria-label") ??
                  control.textContent?.trim() ??
                  control.tagName,
                left: Math.round(rect.left),
                right: Math.round(rect.right),
              },
            ]
          : [];
      });
  });
  expect(clipped, "all imported-art controls must fit the visible creative panel").toEqual([]);
}

for (const kind of ["picture", "view"] as const) {
  test(`imported ${kind} preparation keeps controls inside the laptop panel @webkit-desktop`, async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => route.abort());
    await page.goto("/");
    await page.evaluate(async () => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      await prepareLocalProject({ title: "Reference layout", kind: "starter" }).save();
    });
    await page.reload();
    await openLibraryActions(page, savedGameCard(page, "Reference layout"));
    await page.getByTestId("edit-library-game").click();
    await expect(page.getByTestId("logic-studio")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("logic-explorer").getByTestId(`logic-doc-${kind}:1`).click();
    await page.getByTestId("logic-resource-edit").click();
    const panel = page.getByTestId("creative-workspace");
    await panel.getByTestId("creative-choose").setInputFiles({
      name: "reference.png",
      mimeType: "image/png",
      buffer: Buffer.from(encodePngRgb(48, 32, new Uint8Array(48 * 32 * 3).fill(77))),
    });
    await expect(panel.locator(".source-preview").getByText("reference.png")).toBeVisible();
    await reviewShot(page, `creative-${kind}-import-controls`);
    await expectControlsFit(panel);
    await panel
      .getByRole("button", {
        name: kind === "picture" ? "Trace in room" : "Use as a character or object",
        exact: true,
      })
      .click();
    await expect(
      page.getByTestId(kind === "picture" ? "underlay-job" : "frame-editor"),
    ).toBeVisible();
    await reviewShot(page, `creative-${kind}-preparation-controls`);
    await expectControlsFit(panel);
  });
}
