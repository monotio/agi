import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";

// The actual glyph sources matter: a font-family string alone still passes
// when an absent keyboard glyph silently comes from an OS font.
test("UI symbols and Monaco use the bundled fonts", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium reports glyph sources through CDP.");
  await isolateStorage(page);
  await page.goto("/");
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const [id, token, text] of [
      [
        "font-sans-probe",
        "--font-sans",
        "Create · … – ⌘ ⇧ ⌥ ↵ ← ↑ → ↓ ↖ ↗ ↘ ↙ ⇋ ⋯ ▸ ▾ ◂ ⚡ ⛓ ✦ ➜ ⠿",
      ],
      ["font-mono-probe", "--font-mono", "LOGIC 123 · ⌘ ⇧ ⌥ ↵ ← ↑ → ↓"],
    ]) {
      const probe = document.createElement("span");
      probe.id = id!;
      probe.textContent = text!;
      probe.style.font = `14px var(${token})`;
      document.body.append(probe);
    }
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;top:0;left:0;width:500px;height:180px;z-index:9999";
    document.body.append(host);
    monaco.editor.create(host, { value: "return;", language: "agi-logic" });
  });
  await expect(page.locator(".monaco-editor .view-line").first()).toHaveText("return;");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  for (const selector of [
    "#font-sans-probe",
    "#font-mono-probe",
    ".monaco-editor .view-line > span > span",
  ]) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.length, selector).toBeGreaterThan(0);
    expect(
      fonts.every((font) => font.isCustomFont),
      `${selector}: ${JSON.stringify(fonts)}`,
    ).toBe(true);
    if (selector.startsWith(".monaco-editor"))
      expect(fonts.map((font) => font.familyName)).toEqual(["Geist Mono"]);
  }
  const requested = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.endsWith(".woff2") && !path.includes("codicon")),
  );
  expect(new Set(requested).size).toBe(2);
});
