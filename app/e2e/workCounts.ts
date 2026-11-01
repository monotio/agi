import type { Page } from "@playwright/test";
import { expect } from "./test.ts";

/** Count actual work in served modules, including successful runs, without a production test API. */
export async function countWork(
  page: Page,
  module: RegExp,
  statement: string,
  name: string,
): Promise<() => Promise<number>> {
  await page.route(module, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    expect(source.split(statement)).toHaveLength(2);
    await route.fulfill({
      response,
      body: source.replace(
        statement,
        statement.endsWith("{")
          ? `${statement}\nperformance.mark(${JSON.stringify(name)});`
          : `performance.mark(${JSON.stringify(name)});\n${statement}`,
      ),
    });
  });
  return () => page.evaluate((name) => performance.getEntriesByName(name).length, name);
}
