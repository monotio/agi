import assert from "node:assert/strict";
import { test } from "node:test";
import { isApplePlatform, keyLabel } from "../src/ui/keyLabel.ts";

test("Apple platforms are told apart from the rest by what the browser reports", () => {
  // userAgentData (Chromium) wins over the legacy platform string.
  assert.equal(isApplePlatform({ userAgentData: { platform: "macOS" }, platform: "Linux" }), true);
  assert.equal(isApplePlatform({ userAgentData: { platform: "Windows" } }), false);
  // Safari and Firefox report only navigator.platform.
  for (const platform of ["MacIntel", "iPhone", "iPad"])
    assert.equal(isApplePlatform({ platform }), true, platform);
  for (const platform of ["Win32", "Linux x86_64", "Linux armv8l", ""])
    assert.equal(isApplePlatform({ platform }), false, platform);
  // An empty userAgentData platform falls back to the legacy string.
  assert.equal(isApplePlatform({ userAgentData: { platform: "" }, platform: "MacIntel" }), true);
  assert.equal(isApplePlatform(undefined), false);
});

test("a shortcut reads ⇧⌥⌘ glyphs on Apple platforms and Ctrl, Alt, Shift words elsewhere", () => {
  const cases: [combo: string, apple: string, other: string][] = [
    ["Mod+G", "⌘G", "Ctrl+G"],
    ["Mod+Shift+G", "⇧⌘G", "Ctrl+Shift+G"],
    // Written order does not matter: each platform lists modifiers its own way.
    ["Shift+Mod+Z", "⇧⌘Z", "Ctrl+Shift+Z"],
    ["Mod+\\", "⌘\\", "Ctrl+\\"],
    ["Alt+←", "⌥←", "Alt+←"],
    ["Shift+Alt+←↑→↓", "⌥⇧←↑→↓", "Alt+Shift+←↑→↓"],
    ["Shift+F10", "⇧F10", "Shift+F10"],
    // Pointer words take a hyphen after Apple glyphs.
    ["Shift+click", "⇧-click", "Shift+click"],
    ["Alt+drag", "⌥-drag", "Alt+drag"],
    // A modifier alone names the key.
    ["Shift", "⇧", "Shift"],
    ["Alt", "⌥", "Alt"],
  ];
  for (const [combo, apple, other] of cases) {
    assert.equal(keyLabel(combo, true), apple, `${combo} on Apple`);
    assert.equal(keyLabel(combo, false), other, `${combo} elsewhere`);
  }
});

test("workspace labels keep literal Control on Apple and show the Enter glyph", () => {
  assert.equal(keyLabel("Ctrl+`", true), "⌃`");
  assert.equal(keyLabel("Ctrl+`", false), "Ctrl+`");
  assert.equal(keyLabel("Mod+Enter", true), "⌘↵");
  assert.equal(keyLabel("Mod+Enter", false), "Ctrl+Enter");
});
