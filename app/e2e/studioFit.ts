import type { Locator } from "@playwright/test";

/** The element and its descendants whose text runs past a box that clips it. */
export function clipped(target: Locator): Promise<string[]> {
  return target.evaluate((root) => {
    const found: string[] = [];
    for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
      const style = getComputedStyle(element);
      if (style.overflowX === "visible" && style.textOverflow !== "ellipsis") continue;
      if (element.scrollWidth > element.clientWidth + 1)
        found.push(`${element.className || element.tagName}: ${element.textContent?.trim()}`);
    }
    return found;
  });
}
