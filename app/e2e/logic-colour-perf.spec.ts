import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { disassembleLogic } from "../../src/logic/disassembler.ts";
import { detectProfile, PROFILES } from "../../src/runtime/profile.ts";
import { readInventoryObjects } from "../../src/authoring/inventory.ts";
import { fixtureSkip } from "../../test/fixtures.ts";
import { loadGame } from "../../test/game-fixture.ts";
import { expect, test } from "./test.ts";
import type { mount } from "./fixtures/logicPerformanceHost.ts";

interface PerfWindow {
  logicPerf: Awaited<ReturnType<typeof mount>>;
}
const host = "/@fs" + fileURLToPath(new URL("./fixtures/logicPerformanceHost.ts", import.meta.url));
async function basic(page: Page) {
  await page.goto("/");
  await page.evaluate(async (module) => {
    (window as unknown as PerfWindow).logicPerf = await (
      await import(module)
    ).mount({
      documents: { "logic:1": 'print("Hello");\nreturn;\n', words: "[]", bindings: "{}" },
      key: "logic:1",
      profileId: "2.936",
    });
  }, host);
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
}

test("LOGIC superseding a semantic request keeps previous tokens", async ({ page }) => {
  await basic(page);
  const result = await page.evaluate(async () => {
    const h = (window as unknown as PerfWindow).logicPerf;
    await h.tokens();
    const pending = Promise.resolve(h.tokens()).then(
      (value) => (value === null ? "null" : "tokens"),
      () => "retained",
    );
    h.model.applyEdits([{ range: new h.monaco.Range(1, 1, 1, 1), text: "\n" }]);
    return pending;
  });
  expect(result).not.toBe("null");
});

test("LOGIC comment stays coloured when a save supersedes the last request", async ({ page }) => {
  await basic(page);
  const result = await page.evaluate(async () => {
    const h = (window as unknown as PerfWindow).logicPerf;
    h.model.applyEdits([{ range: new h.monaco.Range(1, 1, 1, 1), text: "// hello\n" }]);
    const pending = Promise.resolve(h.tokens()).catch(() => undefined);
    await h.save();
    await pending;
    // Lexical colour is available immediately, even while the checker is pending.
    return h.monaco.editor.tokenize(h.model.getValue(), "agi-logic")[0]!.map((token) => token.type);
  });
  const comment = page.locator(".view-line").filter({ hasText: "// hello" });
  await expect(comment).toBeVisible();
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(comment).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`logic-colour-${width}.png`),
    });
  }
  expect(result).toContain("comment.agi-logic");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as PerfWindow).logicPerf.semanticChanges()))
    .toBeGreaterThan(0);
  const latest = await page.evaluate(async () => {
    const tokens = await (window as unknown as PerfWindow).logicPerf.tokens();
    return tokens && "data" in tokens ? Array.from(tokens.data).slice(0, 5) : [];
  });
  expect(latest).toEqual([0, 0, 8, 6, 0]);
});

test("LOGIC lexical colours cover directives, commands, references and escaped strings", async ({
  page,
}) => {
  await basic(page);
  const tokens = await page.evaluate(() => {
    const h = (window as unknown as PerfWindow).logicPerf;
    const source =
      '#define door 1\n# old comment\nif (v1 == 25) { move.obj(o2, 3, 4, 5, f6); }\nprint("Hello\\n// string");\ni1 s2 m3 c4\nprint("unfinished\n// next line';
    return h.monaco.editor
      .tokenize(source, "agi-logic")
      .map((line) => line.map((token) => token.type));
  });
  expect(tokens[0]).toContain("keyword.agi-logic");
  expect(tokens[1]).toEqual(["comment.agi-logic"]);
  expect(tokens[2]).toContain("type.identifier.agi-logic");
  expect(tokens[2]).toContain("variable.agi-logic");
  expect(tokens[2]).toContain("number.agi-logic");
  expect(tokens[3]).toContain("string.escape.agi-logic");
  expect(tokens[3]).not.toContain("comment.agi-logic");
  expect(tokens[4]!.filter((type) => type === "variable.agi-logic")).toHaveLength(4);
  expect(tokens[6]).toEqual(["comment.agi-logic"]);
});

for (const [name, hash, key] of [
  ["SQ1 Amiga", "252c863e9d8e65f0c08f63ec8188a4956d056658032cd2e04a9588db838e695e", "logic:1"],
  [
    "Polyester Nights",
    "12545a66b311eac97f44c18551d189e075978481d824371366b61dc8202cfc16",
    "largest",
  ],
] as const) {
  test(`${name} LOGIC typing and colour @perf`, async ({ page }) => {
    const missing = fixtureSkip(hash);
    test.skip(Boolean(missing), missing || "");
    const game = loadGame(hash, { interpreterFiles: true });
    const profile = name === "SQ1 Amiga" ? PROFILES["amiga-2.082"] : detectProfile(game.files);
    const sources: Record<string, string> = {};
    for (let n = 0; n < 256; n++) {
      const payload = game.container.getResource("logic", n);
      if (payload)
        sources[`logic:${n}`] = disassembleLogic(payload, { profile, dictionary: game.dict });
    }
    const input = {
      sources,
      profile,
      dictionary: game.dict,
      bindings: {},
      objects: readInventoryObjects(game.files.get("OBJECT"), profile).map((item) => item.name),
    };
    const selected =
      key === "largest"
        ? Object.keys(input.sources).sort(
            (a, b) => input.sources[b]!.length - input.sources[a]!.length,
          )[0]!
        : key;
    await page.goto("/");
    await page.evaluate(
      async ({ host, input }) => {
        (window as unknown as PerfWindow).logicPerf = await (await import(host)).mount(input);
      },
      {
        host,
        input: {
          documents: {
            ...input.sources,
            words: JSON.stringify([...input.dictionary]),
            inventory: JSON.stringify(input.objects.map((name) => ({ name }))),
            bindings: JSON.stringify(input.bindings),
          },
          key: selected,
          profileId: input.profile.id,
        },
      },
    );
    await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
    const result = await page.evaluate(async () => {
      const h = (window as unknown as PerfWindow).logicPerf;
      await h.tokens();
      const costs: number[] = [];
      for (const text of ["/", "/", " ", "h", "e", "l", "l", "o"]) {
        const at = performance.now();
        h.editor.executeEdits("perf", [
          { range: new h.monaco.Range(1, costs.length + 1, 1, costs.length + 1), text },
        ]);
        await h.tick();
        costs.push(performance.now() - at);
      }
      const pause = performance.now();
      const lexical = h.monaco.editor
        .tokenize(h.model.getValue(), "agi-logic")[0]!
        .some((token) => token.type.startsWith("comment"));
      const lexicalMs = performance.now() - pause;
      let checked = 0;
      const checking = Promise.resolve(h.tokens()).then(() => {
        checked = performance.now() - pause;
      });
      let colourMs: number | null = null;
      for (let frame = 0; frame < 60; frame++) {
        await new Promise(requestAnimationFrame);
        const comment = [...document.querySelectorAll(".view-line span[class*=mtk]")].find((span) =>
          span.textContent?.replaceAll("\u00a0", " ").startsWith("// hello"),
        );
        if (comment && getComputedStyle(comment).color === "rgb(96, 139, 78)") {
          colourMs = performance.now() - pause;
          break;
        }
      }
      await checking;
      await new Promise(requestAnimationFrame);
      const comment = h.monaco.editor
        .tokenize(h.model.getValue(), "agi-logic")[0]!
        .some((token) => token.type.startsWith("comment"));
      return {
        costs,
        checked,
        comment,
        lexical,
        lexicalMs,
        colourMs,
        bytes: h.model.getValueLength(),
      };
    });
    console.log(`[logic-perf] ${name} ${selected} ${JSON.stringify(result)}`);
    expect(Math.max(...result.costs)).toBeLessThan(50);
    expect(result.checked).toBeLessThan(450);
    expect(result.comment).toBe(true);
    expect(result.colourMs).not.toBeNull();
    expect(result.colourMs!).toBeLessThan(450);
  });
}
