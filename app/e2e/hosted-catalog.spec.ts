import { expect, test } from "@playwright/test";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { buildPublicGameZip } from "../src/projectArchive.ts";
import { readGameZip } from "../src/gameZip.ts";

// A hosted catalog serves the public game, not the author's project files.
const game = await readGameZip(buildPublicGameZip(buildTutorial()));
const manifest = {
  format: "monotio.agi.catalog",
  version: 1,
  games: [
    {
      id: "constructor",
      version: "1.0.0",
      title: "The Hosted Workshop",
      description: "An adventure supplied by this site.",
      author: "Monotio",
      license: "MIT",
      path: "games/workshop/",
      files: Object.keys(game.files),
    },
  ],
};

test("hosted games preview, play and resume in the same library without a provider", async ({
  page,
}) => {
  await isolateStorage(page);
  const requests: string[] = [];
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.route("**/catalog.json", (route) => route.fulfill({ json: manifest }));
  await page.route("**/games/workshop/**", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    requests.push(name);
    const bytes = game.files[name];
    return bytes ? route.fulfill({ body: Buffer.from(bytes) }) : route.fulfill({ status: 404 });
  });
  const external: string[] = [];
  page.on("request", (request) => {
    if (/api\.(openai|anthropic)\.com|\/api\//.test(request.url())) external.push(request.url());
  });
  await page.goto("/");
  const card = page.getByTestId("hosted-game-card-constructor");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(card).toContainText("The Hosted Workshop");
  expect(requests.sort()).toEqual(Object.keys(game.files).sort());
  await card.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-eject").click();
  const saved = page.getByTestId("saved-game-card-catalog-constructor-1.0.0");
  await expect(saved.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(saved).not.toContainText("Tutorial 1.0.0");
  await expect(saved.getByTestId("library-thumbnail")).toHaveAttribute(
    "data-preview-kind",
    "progress",
  );
  await page.reload();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-eject").click();
  await expect(saved).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(requests.length).toBe(Object.keys(game.files).length);
  expect(external).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("hosted-library.png"), fullPage: true });
});

test("catalog and opening failures explain the problem before play and allow retry", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  let valid = false;
  let fileReady = false;
  await page.route("**/catalog.json", (route) =>
    route.fulfill({ json: valid ? manifest : { ...manifest, version: 9 } }),
  );
  await page.route("**/games/workshop/**", (route) => {
    const bytes = game.files[new URL(route.request().url()).pathname.split("/").at(-1)!];
    return fileReady && bytes
      ? route.fulfill({ body: Buffer.from(bytes) })
      : route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByTestId("hosted-catalog-error")).toContainText("not supported");
  valid = true;
  const catalogResponse = page.waitForResponse("**/catalog.json");
  await page.getByRole("button", { name: "Retry game list", exact: true }).click();
  expect(await (await catalogResponse).json()).toEqual(manifest);
  await expect(page.getByTestId("hosted-catalog-error")).toBeHidden();
  const card = page.getByTestId("hosted-game-card-constructor");
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("alert")).toContainText("404");
  await expect(card.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
  fileReady = true;
  await card.getByRole("button", { name: "Retry preview", exact: true }).click();
  await expect(card.getByRole("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(card.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
});
