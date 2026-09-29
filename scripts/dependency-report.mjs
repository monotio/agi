// dependency-cruiser reporter for `npm run lint:deps`. The stock `err`
// reporter ends every run that has warnings with "x N dependency violations",
// which reads as a failure even when no rule at error severity fired. This one
// lists each violation the same way, then says plainly whether the run passed.
// The exit code is the number of errors, as with the stock reporter.
import { styleText } from "node:util";

const MARK = { error: styleText("red", "x"), warn: styleText("yellow", "‼"), info: "i" };

function path(violation) {
  if (violation.cycle) return [violation.from, ...violation.cycle.map(({ name }) => name)];
  if (violation.via) return [violation.from, ...violation.via.map(({ name }) => name)];
  return violation.from === violation.to ? [violation.from] : [violation.from, violation.to];
}

export default function report(result) {
  const { error, warn, totalCruised, totalDependenciesCruised = 0 } = result.summary;
  const lines = result.summary.violations
    .filter(({ rule }) => rule.severity !== "ignore")
    .map(
      (violation) =>
        `  ${MARK[violation.rule.severity] ?? "-"} ${violation.rule.severity} ${violation.rule.name}: ${path(violation).join(" → ")}`,
    );
  const counted = `${totalCruised} modules, ${totalDependenciesCruised} dependencies cruised`;
  const verdict =
    error > 0
      ? styleText("red", `x failed: ${error} errors, ${warn} warnings (${counted})`)
      : `${styleText("green", "✔")} passed: 0 errors${warn > 0 ? `, ${warn} warnings listed above` : ""} (${counted})`;
  return { output: [...lines, "", verdict, ""].join("\n"), exitCode: error };
}
