import type { Page, Route } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { sha256Hex } from "../../src/crypto.ts";

/**
 * The mounted optional image-generation panel on the real creative dock.
 * Every provider request is mocked: the dev-proxy image endpoints record and
 * answer, and a sentinel route aborts any request aimed at api.openai.com
 * itself. A saved OpenAI profile key is seeded through the settings record
 * while the selected text provider stays stub, so the wire assertions also
 * prove the request never sends another provider's key. Mocked transport
 * proves the wire contract only — it says nothing about generated-image
 * quality, live CORS, account access or provider cost.
 */
test.use({ viewport: { width: 1280, height: 720 } });

/** The generated original the mock returns — a real PNG at the requested size. */
const GENERATED_1024 = encodePngRgb(
  1024,
  1024,
  (() => {
    const rgb = new Uint8Array(1024 * 1024 * 3);
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        const i = (y * 1024 + x) * 3;
        rgb[i] = (x * 255) / 1024;
        rgb[i + 1] = 40;
        rgb[i + 2] = (y * 255) / 1024;
      }
    return rgb;
  })(),
);

/** A 48x32 half-red/half-blue synthetic PNG, produced by the project's own encoder. */
function meadowPng(): Uint8Array {
  const rgb = new Uint8Array(48 * 32 * 3);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 48; x++) {
      const i = (y * 48 + x) * 3;
      if (x < 24) {
        rgb[i] = 200;
        rgb[i + 1] = 60;
        rgb[i + 2] = 40;
      } else {
        rgb[i] = 40;
        rgb[i + 1] = 80;
        rgb[i + 2] = 200;
      }
    }
  return encodePngRgb(48, 32, rgb);
}

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(page: Page, title: string): Promise<string> {
  const projectId = await page.evaluate(async (title) => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const prepared = prepareLocalProject({ title, kind: "starter" });
    await prepared.save();
    return prepared.projectId as string;
  }, title);
  await page.waitForLoadState("networkidle");
  return projectId;
}

/** Seed the saved settings record: an OpenAI profile key, the text provider left on stub. */
async function seedOpenAiKey(page: Page, key: string): Promise<void> {
  await page.addInitScript((key) => {
    localStorage.setItem(
      "monotio_agi.aiSettings",
      JSON.stringify({
        version: 1,
        provider: "stub",
        profiles: {
          openai: { apiKey: key },
          anthropic: { apiKey: "" },
          stub: { apiKey: "" },
        },
      }),
    );
  }, key);
}

/** The library's Edit verb: Logic Studio on the stored project, no engine. */
async function openLogicStudio(page: Page, title: string) {
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  return studio;
}

async function openResource(page: Page, key: "picture" | "view", n: number) {
  await page.getByTestId("logic-explorer").getByTestId(`logic-doc-${key}:${n}`).click();
  await page.getByTestId("logic-resource-edit").click();
}

/** Drop a real File through the editor surface's drop handler. */
async function dropPng(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  await page.evaluate(
    async ({ b64, name }) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([raw], name, { type: "image/png" }));
      const surface = document.querySelector(".pre");
      if (surface === null) throw new Error("resource editor surface is not mounted");
      surface.dispatchEvent(
        new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    },
    { b64: Buffer.from(bytes).toString("base64"), name },
  );
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const imageBody = (png: Uint8Array, extra?: Record<string, unknown>) => ({
  created: 1_700_000_000,
  data: [{ b64_json: b64(png) }],
  output_format: "png",
  ...extra,
});
const USAGE = {
  input_tokens: 12,
  output_tokens: 41,
  total_tokens: 53,
  output_tokens_details: { image_tokens: 41 },
};

/**
 * The image API under test control: `requests` records every send before the
 * queued responder answers (or never answers, for cancellation). `paid` counts
 * requests aimed at a real provider host — the answer must always be zero.
 */
async function mockImageApi(
  page: Page,
  responders: ((route: Route) => Promise<void> | void)[],
): Promise<{ requests: RecordedRequest[]; paid: () => number }> {
  const requests: RecordedRequest[] = [];
  let paid = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    paid++;
    return route.abort();
  });
  await page.route("**/api/openai/v1/images/**", async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: await request.headers(),
      body: request.postDataBuffer(),
    });
    const responder =
      responders.shift() ??
      ((route: Route) => route.fulfill({ json: imageBody(GENERATED_1024, { usage: USAGE }) }));
    await responder(route);
  });
  return { requests, paid: () => paid };
}

const fulfillImage =
  (png: Uint8Array = GENERATED_1024) =>
  (route: Route) =>
    route.fulfill({ json: imageBody(png, { usage: USAGE }) });

test("without a key the dock still composes, refuses plainly, opens settings and imports by hand", async ({
  page,
}) => {
  await isolateStorage(page);
  const api = await mockImageApi(page, []);
  await page.goto("/");
  await seedLocalProject(page, "Unkeyed meadow");
  await page.reload();

  await openLogicStudio(page, "Unkeyed meadow");
  await openResource(page, "picture", 1);
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();

  // The folded disclosure opens on a keyboard journey: focus, Enter.
  const toggle = creative.getByTestId("generate-disclosure");
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(creative.getByTestId("generate-disclosure-body")).toBeVisible();
  await expect(creative.getByTestId("generate-key")).toContainText(
    "Add an OpenAI key in AI settings",
  );

  // Compose and review still work fully disconnected.
  await creative.getByTestId("generate-prompt").fill("A quiet meadow at dawn");
  await creative.getByTestId("generate-review").click();
  const sheet = creative.getByTestId("generate-review-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("openai");
  await expect(sheet).toContainText("1024x1024");
  await reviewShot(page, "generate-review-no-key");

  // Submit refuses with the named reason; the key action opens real settings.
  await creative.getByTestId("generate-submit").click();
  await expect(creative.getByTestId("generate-error")).toContainText("OpenAI API key");
  await creative.getByTestId("generate-settings").click();
  await expect(page.getByTestId("ai-settings-dialog")).toBeVisible();
  await page.getByTestId("ai-settings-cancel").click();
  expect(api.requests).toHaveLength(0);

  // Manual import stays the complete path while generation is disconnected.
  await dropPng(page, meadowPng(), "hand.png");
  await expect(creative.locator(".source-preview").getByText("hand.png")).toBeVisible({
    timeout: 15_000,
  });
  await reviewShot(page, "generate-disconnected-manual-import");
  expect(api.paid()).toBe(0);
});

test("generate reviews, sends one keyed request, previews the offer and Use stages the original @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await seedOpenAiKey(page, "sk-e2e-mock");
  const api = await mockImageApi(page, [fulfillImage()]);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Generated meadow");
  await page.reload();

  await openLogicStudio(page, "Generated meadow");
  await openResource(page, "picture", 1);
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();
  await creative.getByTestId("generate-disclosure").click();

  // Nothing leaves the browser until the reviewed request is sent.
  await creative.getByTestId("generate-prompt").fill("A quiet meadow at dawn");
  await creative.getByTestId("generate-review").click();
  const sheet = creative.getByTestId("generate-review-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("generate · openai · gpt-image-2.5-sunburst");
  await expect(sheet).toContainText("/v1/images/generations");
  await expect(sheet).toContainText("1024x1024 · low · opaque");
  await expect(sheet).toContainText("1 image");
  expect(api.requests).toHaveLength(0);
  await reviewShot(page, "generate-review-sheet");

  // One explicit submit is exactly one request, carrying the OpenAI key the
  // profile saved — not the selected stub provider's.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="generate-submit"]')!;
    button.click();
    button.click();
  });
  const offer = creative.getByTestId("generate-offer");
  await expect(offer).toBeVisible({ timeout: 15_000 });
  expect(api.requests).toHaveLength(1);
  const request = api.requests[0]!;
  expect(request.url).toMatch(/\/api\/openai\/v1\/images\/generations$/);
  expect(request.headers["authorization"]).toBe("Bearer sk-e2e-mock");
  expect(JSON.parse(request.body!.toString("utf8"))).toEqual({
    model: "gpt-image-2.5-sunburst",
    prompt: "A quiet meadow at dawn",
    n: 1,
    size: "1024x1024",
    quality: "low",
    background: "opaque",
    output_format: "png",
  });

  // The detached offer previews the provider's exact bytes and reported usage.
  await expect(creative.getByTestId("generate-preview")).toBeVisible();
  await expect(offer).toContainText("53 total · 41 image");
  await expect(offer).toContainText(sha256Hex(GENERATED_1024).slice(0, 12));
  await reviewShot(page, "generate-offer");

  // Use stages through the same intake as uploads: a `generated` original.
  await creative.getByTestId("generate-use").click();
  await expect(creative.getByTestId("generate-notice")).toContainText("staged");
  const staged = creative.locator(".source-preview").getByText("GPT Image 2.5 Sunburst generation");
  await expect(staged).toBeVisible();

  // The staged original then takes the ordinary path: underlay + Keep.
  await creative.locator(".source-preview").filter({ hasText: "generation" }).click();
  await creative.getByRole("button", { name: "Trace in room" }).click();
  await expect(page.getByTestId("underlay-job")).toBeVisible();
  await reviewShot(page, "generate-staged-underlay");
  await creative.getByTestId("creative-keep").click();
  await expect(creative.locator(".creative__status")).toContainText("Creative work kept");

  // The kept catalog holds the generated original's exact bytes.
  const manifest = await page.evaluate(async (id) => {
    const { loadCreativeCatalog, readCreativeBlob } = await import("/src/project/creativeStore.ts");
    const { catalog } = await loadCreativeCatalog(id as never);
    const source = catalog?.sources.find((entry) => entry.origin.kind === "generated");
    if (!catalog || !source) return null;
    const blob = await readCreativeBlob(id as never, source.encoded.hash);
    const digest = await crypto.subtle.digest("SHA-256", blob.bytes.slice().buffer);
    return {
      title: source.origin.title,
      hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      recipes: catalog.recipes.length,
    };
  }, projectId);
  expect(manifest).not.toBeNull();
  expect(manifest!.title).toBe("GPT Image 2.5 Sunburst generation");
  expect(manifest!.hash).toBe(sha256Hex(GENERATED_1024));
  expect(manifest!.recipes).toBe(1);

  // A cold reopen keeps the kept original in the catalog.
  await page.reload();
  await openLogicStudio(page, "Generated meadow");
  const kept = await page.evaluate(async (id) => {
    const { loadCreativeCatalog } = await import("/src/project/creativeStore.ts");
    const { catalog } = await loadCreativeCatalog(id as never);
    return catalog?.sources.length ?? 0;
  }, projectId);
  expect(kept).toBe(1);
  expect(api.paid()).toBe(0);
});

test("variation and edit selection leave through the edits endpoint; edit Use stages the composite pair @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await seedOpenAiKey(page, "sk-e2e-mock");
  const api = await mockImageApi(page, [fulfillImage(), fulfillImage()]);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Edited meadow");
  await page.reload();

  await openLogicStudio(page, "Edited meadow");
  await openResource(page, "picture", 1);
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();
  await dropPng(page, meadowPng(), "meadow.png");
  await expect(creative.locator(".source-preview").getByText("meadow.png")).toBeVisible({
    timeout: 15_000,
  });
  await creative.getByTestId("generate-disclosure").click();

  // Variation: the asset is the departing image; the request goes to edits.
  await creative.getByTestId("generate-kind-variation").click();
  await creative.getByTestId("generate-prompt").fill("Softer dusk palette");
  await creative.getByTestId("generate-asset").selectOption({ index: 1 });
  await creative.getByTestId("generate-review").click();
  const sheet = creative.getByTestId("generate-review-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("variation · openai");
  await expect(sheet).toContainText("meadow.png");
  await expect(sheet).toContainText("exact-source");
  await expect(sheet).toContainText("/v1/images/edits");
  await reviewShot(page, "generate-variation-review");
  await creative.getByTestId("generate-submit").click();
  await expect(creative.getByTestId("generate-offer")).toBeVisible({ timeout: 15_000 });
  expect(api.requests[0]!.url).toMatch(/\/api\/openai\/v1\/images\/edits$/);
  expect(api.requests[0]!.headers["content-type"]).toMatch(/^multipart\/form-data/);
  await creative.getByTestId("generate-use").click();
  await expect(creative.getByTestId("generate-notice")).toContainText("staged");
  await expect(
    creative.locator(".source-preview").getByText("GPT Image 2.5 Sunburst variation"),
  ).toBeVisible();

  // Edit selection: the authorized rectangle is typed, previewed and frozen.
  await creative.getByTestId("generate-kind-edit").click();
  await creative.getByTestId("generate-asset").selectOption({ index: 1 });
  await creative.getByTestId("generate-prompt").fill("Repaint the left half as water");
  await expect(creative.getByTestId("generate-selection")).toBeVisible();
  await creative.getByTestId("generate-selection-x").fill("0");
  await creative.getByTestId("generate-selection-y").fill("0");
  await creative.getByTestId("generate-selection-width").fill("24");
  await creative.getByTestId("generate-selection-height").fill("16");
  await creative.getByTestId("generate-review").click();
  const editSheet = creative.getByTestId("generate-review-sheet");
  await expect(editSheet).toBeVisible();
  await expect(editSheet).toContainText("edit · openai");
  await expect(editSheet).toContainText("24×16 at 0,0 · mask");
  await reviewShot(page, "generate-edit-review");
  await creative.getByTestId("generate-submit").click();
  await expect(creative.getByTestId("generate-offer")).toBeVisible({ timeout: 15_000 });
  expect(api.requests[1]!.url).toMatch(/\/api\/openai\/v1\/images\/edits$/);

  // The offer previews the deterministic composite over the frozen base;
  // Use stages the provider original and the composite through the mounted
  // material seam as a strict two-parent derivation.
  await expect(creative.getByTestId("generate-composite-preview")).toBeVisible();
  await expect(creative.getByTestId("generate-composite")).toContainText("protected pixels");
  await reviewShot(page, "generate-edit-composite");
  await creative.getByTestId("generate-use").click();
  await expect(creative.getByTestId("generate-notice")).toContainText("staged");
  await expect(
    creative.locator(".source-preview").getByText("GPT Image 2.5 Sunburst edit source"),
  ).toBeVisible();
  await expect(
    creative.locator(".source-preview").getByText("GPT Image 2.5 Sunburst edit composite"),
  ).toBeVisible();

  // The staged composite carries its strict derivation; the provider
  // original and the base are separate ordinary sources.
  const derivation = await page.evaluate(async (id) => {
    const { loadCreativeCatalog } = await import("/src/project/creativeStore.ts");
    const { catalog } = await loadCreativeCatalog(id as never);
    const lease = catalog?.leases[0];
    const composite = lease?.staged.sources.find((entry) => entry.origin.kind === "composite");
    const ref = composite?.derivation?.provider;
    const provider = lease?.staged.sources.find(
      (entry) =>
        ref !== undefined &&
        entry.identity.id === ref.id &&
        entry.identity.incarnation === ref.incarnation &&
        entry.identity.revision === ref.revision,
    );
    return composite === undefined
      ? null
      : {
          derivation: composite.derivation,
          providerKey:
            provider === undefined
              ? null
              : `${provider.identity.id} ${provider.identity.incarnation} ${provider.identity.revision}`,
          staged: lease?.staged.sources.length ?? 0,
        };
  }, projectId);
  expect(derivation).not.toBeNull();
  expect(derivation!.derivation).toMatchObject({
    kind: "selection-composite",
    version: 1,
    algorithm: "agi.edit-selection-composite-v1",
    selection: { x: 0, y: 0, width: 24, height: 16 },
  });
  expect(
    `${derivation!.derivation!.provider.id} ${derivation!.derivation!.provider.incarnation} ${derivation!.derivation!.provider.revision}`,
  ).toBe(derivation!.providerKey);
  expect(derivation!.staged).toBe(4); // meadow + variation + provider + composite

  // The composite then takes the ordinary path: underlay + Keep, and the
  // reopened catalog preserves the full ancestry.
  await creative.locator(".source-preview").filter({ hasText: "edit composite" }).click();
  await creative.getByRole("button", { name: "Trace in room" }).click();
  await expect(page.getByTestId("underlay-job")).toBeVisible();
  await creative.getByTestId("creative-keep").click();
  await expect(creative.locator(".creative__status")).toContainText("Creative work kept");

  await page.reload();
  await openLogicStudio(page, "Edited meadow");
  const kept = await page.evaluate(async (id) => {
    const { loadCreativeCatalog } = await import("/src/project/creativeStore.ts");
    const { catalog } = await loadCreativeCatalog(id as never);
    const composite = catalog?.sources.find((entry) => entry.origin.kind === "composite");
    const byKey = (ref: { id: string; incarnation: string; revision: number }) =>
      catalog?.sources.some(
        (entry) =>
          entry.identity.id === ref.id &&
          entry.identity.incarnation === ref.incarnation &&
          entry.identity.revision === ref.revision,
      ) ?? false;
    return {
      kept: catalog?.sources.length ?? 0,
      derivation: composite?.derivation,
      baseKept: composite?.derivation === undefined ? false : byKey(composite.derivation.base),
      providerKept:
        composite?.derivation === undefined ? false : byKey(composite.derivation.provider),
    };
  }, projectId);
  expect(kept.kept).toBe(4);
  expect(kept.derivation).toMatchObject({
    kind: "selection-composite",
    version: 1,
    algorithm: "agi.edit-selection-composite-v1",
  });
  expect(kept.baseKept).toBe(true);
  expect(kept.providerKept).toBe(true);
  expect(api.requests).toHaveLength(2);
  expect(api.paid()).toBe(0);
});

test("cancellation aborts locally and a provider refusal surfaces its named reason", async ({
  page,
}) => {
  await isolateStorage(page);
  await seedOpenAiKey(page, "sk-e2e-mock");
  const api = await mockImageApi(page, [
    // Never answers: the request hangs until the local abort wins.
    () => new Promise<void>(() => {}),
    (route) =>
      route.fulfill({
        status: 429,
        json: { error: { code: "rate_limit_exceeded", message: "slow down" } },
      }),
  ]);
  await page.goto("/");
  await seedLocalProject(page, "Cancelled meadow");
  await page.reload();

  await openLogicStudio(page, "Cancelled meadow");
  await openResource(page, "picture", 1);
  const creative = page.getByTestId("creative-workspace");
  await creative.getByTestId("generate-disclosure").click();
  await creative.getByTestId("generate-prompt").fill("A long request");
  await creative.getByTestId("generate-review").click();
  await creative.getByTestId("generate-submit").click();
  await expect(creative.getByTestId("generate-flight")).toBeVisible();
  await creative.getByTestId("generate-cancel").click();
  await expect(creative.getByTestId("generate-form")).toBeVisible();
  await expect(creative.getByTestId("generate-notice")).toContainText("cancelled");
  await expect(creative.getByTestId("generate-offer")).toHaveCount(0);

  // A provider refusal lands as a named reason, then the composer returns.
  await creative.getByTestId("generate-prompt").fill("Try again plainly");
  await creative.getByTestId("generate-review").click();
  await creative.getByTestId("generate-submit").click();
  await expect(creative.getByTestId("generate-error")).toContainText("rate-limiting");
  await expect(creative.getByTestId("generate-form")).toBeVisible();
  expect(api.requests).toHaveLength(2);
  expect(api.paid()).toBe(0);
});
