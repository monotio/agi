import { test, expect } from "./test.ts";
import { isolateStorage, configureAi, textHook, workspaceUpdated } from "./engineProbe.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

test("agent image tools review PICTURE and VIEW previews before one saved commit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  let image = "";
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    const body = route.request().postDataJSON() as { tools: { name: string }[] };
    expect(body.tools.some((tool) => tool.name === "trace_an_image")).toBe(true);
    expect(body.tools.some((tool) => tool.name === "make_cels_from_an_image")).toBe(true);
    const id = `image-tools-${++requests}`;
    const output =
      requests === 1
        ? [
            {
              type: "function_call",
              call_id: `${id}-trace`,
              name: "trace_an_image",
              arguments: JSON.stringify({ target: "picture:1", image, opacity: 0.8 }),
            },
            {
              type: "function_call",
              call_id: `${id}-cels`,
              name: "make_cels_from_an_image",
              arguments: JSON.stringify({ target: "view:0", image, frames: null }),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Prepared tracing and cels." }],
            },
          ];
    await route.fulfill(providerReply("openai", { id, output }));
  });
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Agent image proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await workspaceUpdated(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "White paper", [
        { key: "picture:1", content: "end" },
      ]),
      label: "White paper",
      origin: "picture",
      author: "creator",
    });
  });
  await page.getByTestId("part-room:1:picture:1").click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  const pixels = new Uint8Array(6 * 4 * 4).fill(255);
  for (const y of [1, 2]) for (const x of [2, 3]) pixels.set([255, 0, 0, 255], (y * 6 + x) * 4);
  await page.getByTestId("image-file").setInputFiles({
    name: "red.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgba(6, 4, pixels)),
  });
  await expect(page.getByTestId("trace-opacity")).toBeVisible();
  await workspaceUpdated(page);
  const before = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const docs = session.model.capture().documents();
    return {
      count: session.history.capture().commits.length,
      images: docs["images"],
      view: docs["view:0"],
    };
  });
  image = Object.keys(JSON.parse(String(before.images)).images)[0]!;
  await page
    .getByTestId("image-reference")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByTestId("agent-message").fill("Reuse the image for tracing and cels");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const review = page.getByTestId("agent-review");
  await expect(review).toBeVisible();
  const art = review.getByTestId("agent-art-review");
  await expect(art).toHaveCount(2, { timeout: 3000 });
  const pictureBefore = review.getByAltText("images PICTURE 1 Before");
  const pictureAfter = review.getByAltText("images PICTURE 1 After");
  const viewBefore = review.getByAltText("view:0 VIEW 0 Before");
  const viewAfter = review.getByAltText("view:0 VIEW 0 After");
  for (const preview of [pictureBefore, pictureAfter, viewBefore, viewAfter])
    await expect(preview).toBeVisible();
  expect(await pictureAfter.getAttribute("src")).not.toBe(await pictureBefore.getAttribute("src"));
  expect(await viewAfter.getAttribute("src")).not.toBe(await viewBefore.getAttribute("src"));
  await page.screenshot({
    path: test.info().outputPath("agent-image-review.png"),
    animations: "disabled",
  });
  const count = () =>
    page.evaluate(
      () =>
        (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
          .getSession()
          .history.capture().commits.length,
    );
  expect(await count()).toBe(before.count);
  await page.getByTestId("agent-approve").click();
  await expect(review).toHaveCount(0);
  await expect.poll(count).toBe(before.count + 1);
  const after = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return {
      documents: session.model.capture().documents(),
      commit: session.history.capture().commits.at(-1),
    };
  });
  expect(JSON.parse(String(after.documents["images"])).traces["picture:1"].opacity).toBe(0.8);
  expect(after.documents["view:0"]).not.toEqual(before.view);
  expect(after.commit?.author).toBe("agent");
  expect(after.commit?.origin).toBe("agent");
  expect(requests).toBe(2);
});
