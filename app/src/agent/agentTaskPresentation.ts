import { formatDollars, formatSpent } from "./reportedSpend.ts";
import type { AgentRunState } from "./agentRun.ts";

export function taskSpendLabel(
  task: Pick<
    AgentRunState,
    "spent" | "budget" | "priceKnown" | "usageIncomplete" | "requests" | "status"
  >,
): string {
  const budget = formatDollars(task.budget);
  if (task.requests === 0) return `${budget} budget`;
  if (!task.priceKnown) return `${budget} budget · usage unavailable`;
  if ((task.usageIncomplete || task.status === "running") && task.spent === 0)
    return `${budget} budget · usage pending`;
  return formatSpent(
    {
      amount: task.spent,
      budget: task.budget,
      priceKnown: task.priceKnown,
      incomplete: task.usageIncomplete,
    },
    "compact",
  );
}
