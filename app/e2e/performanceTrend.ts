import { writeFile } from "node:fs/promises";
import { test } from "./test.ts";

let reportedMissingBaseline = false;

/** Keep timing evidence on successful runs as well as failures; timings never gate a run. */
export async function recordPerformance(
  name: string,
  metrics: Readonly<Record<string, number | readonly number[] | null>>,
): Promise<void> {
  const info = test.info();
  const sample = { name, project: info.project.name, test: info.title, metrics };
  const path = info.outputPath(`performance-${name}.json`);
  await writeFile(path, JSON.stringify(sample, null, 2));
  await info.attach(`performance-${name}`, { path, contentType: "application/json" });
  console.log(`[performance trend] ${JSON.stringify(sample)}`);
  if (!reportedMissingBaseline) {
    console.info(
      "[performance trend] No same-job main baseline; samples are retained without a regression comparison.",
    );
    reportedMissingBaseline = true;
  }
}
