import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { encodePngRgb } from "../../src/picture/png.ts";
import {
  createOpenAiImageProvider,
  OpenAiImageError,
  type OpenAiImageModel,
  type OpenAiImageRequest,
} from "../src/studio/creative/openaiImageProvider.ts";

const model: OpenAiImageModel = {
  id: "review-image",
  label: "Review image",
  edits: true,
  mask: false,
  inputFidelity: false,
  qualities: ["low"],
  sizes: ["1x1"],
  backgrounds: ["opaque"],
};
const request: OpenAiImageRequest = {
  kind: "generate",
  role: "room",
  model: model.id,
  size: "1x1",
  quality: "low",
  background: "opaque",
  prompt: "A red room",
};
const png = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
function reply(): Response {
  return new Response(
    JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString("base64") }] }),
    { headers: { "content-type": "application/json" } },
  );
}

test("the image request sends the exact prompt reviewed during preparation", async () => {
  let reads = 0;
  let sent = "";
  const provider = createOpenAiImageProvider({
    models: { [model.id]: model },
    credentials: () => "synthetic-key",
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body)).prompt;
      return reply();
    },
  });
  const prepared = provider.prepare({
    ...request,
    get prompt() {
      reads++;
      return reads <= 5 ? "A red room" : "A different departing prompt";
    },
  });
  await provider.submit(prepared);
  assert.equal(
    sent,
    prepared.summary.prompt,
    "review and paid transport must share one captured prompt",
  );
  assert.equal(reads, 1, "capture the offered prompt once before validation and review");
});

test("image quality cannot change between capability admission and review", async () => {
  let reads = 0;
  const provider = createOpenAiImageProvider({
    models: { [model.id]: model },
    credentials: () => "synthetic-key",
    fetch: async () => reply(),
  });
  const prepared = provider.prepare({
    ...request,
    get quality() {
      return ++reads === 1 ? "low" : "max";
    },
  });
  assert.equal(prepared.summary.quality, "low");
  assert.equal(reads, 1);
});

test("image transport errors never carry raw credentials in nested causes", async () => {
  const marker = "synthetic-private-key-marker";
  const provider = createOpenAiImageProvider({
    models: { [model.id]: model },
    credentials: () => marker,
    fetch: async () => {
      throw new TypeError(`Authorization: Bearer ${marker}`);
    },
  });
  const prepared = provider.prepare(request);
  await assert.rejects(provider.submit(prepared), (error: unknown) => {
    assert.doesNotMatch(inspect(error), /synthetic-private-key-marker/);
    return true;
  });
});

for (const boundary of ["credentials", "transport"] as const) {
  test(`a typed error from the ${boundary} callback still has its credentials removed`, async () => {
    const marker = "synthetic-private-key-marker";
    const fail = () => {
      throw new OpenAiImageError("transport", `Secret ${marker}`, {
        cause: { authorization: marker },
      });
    };
    const provider = createOpenAiImageProvider({
      models: { [model.id]: model },
      credentials: boundary === "credentials" ? fail : () => marker,
      fetch: boundary === "transport" ? fail : async () => reply(),
    });
    await assert.rejects(provider.submit(provider.prepare(request)), (error: unknown) => {
      assert.doesNotMatch(inspect(error), /synthetic-private-key-marker/);
      return true;
    });
  });
}
