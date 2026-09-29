import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Text tokens meet WCAG AA (4.5:1) on every surface they label, including a
 * selected row's action tint over a panel. The tokens are read from
 * tokens.css, so a colour change is checked where it is made.
 */
const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function token(name: string): [number, number, number] {
  const hex = new RegExp(`--${name}:\\s*#([0-9a-f]{6});`, "i").exec(css)?.[1];
  assert.ok(hex, `--${name} is a six-digit hex colour`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** The tint's `rgb(r g b / a)` over an opaque surface. */
function tinted(surface: [number, number, number], name: string): [number, number, number] {
  const match = new RegExp(`--${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+) / ([\\d.]+)\\);`).exec(css);
  assert.ok(match, `--${name} is an rgb() tint`);
  const alpha = Number(match[4]);
  return surface.map((channel, i) => channel * (1 - alpha) + Number(match[i + 1]) * alpha) as [
    number,
    number,
    number,
  ];
}

function luminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("secondary label ink reads at AA on every surface and on a selected row", () => {
  const backgrounds: Record<string, [number, number, number]> = {
    "surface-0": token("surface-0"),
    "surface-1": token("surface-1"),
    "surface-2": token("surface-2"),
    "surface-3": token("surface-3"),
    // A selected list row: the action tint over a panel (Studio scene list).
    "action-soft over surface-1": tinted(token("surface-1"), "action-soft"),
  };
  for (const ink of ["ink", "ink-2", "ink-3"]) {
    for (const [name, background] of Object.entries(backgrounds)) {
      const ratio = contrast(token(ink), background);
      assert.ok(ratio >= 4.5, `--${ink} on ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
});
