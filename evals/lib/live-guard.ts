/**
 * Consent for a paid run. Keys in the environment never start one: every
 * harness that can call a provider refuses unless the command line carries
 * both `--live` and `--budget-usd <cap>` (the promptfoo lanes, which take no
 * arguments, read `EVAL_LIVE=1` and a budget variable instead). A refusal
 * says what would have run and how to run it offline, and the harness exits
 * non-zero without a request.
 */

export class LiveRunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveRunRefused";
  }
}

export interface LiveRun {
  /** `--live` was given. */
  readonly live: boolean;
  /** `--budget-usd`, as parsed; the cap every request's usage is charged against. */
  readonly budgetUsd: number | undefined;
  /** What the run would do: "genesis on knights-trial with openai gpt-6-sol". */
  readonly plan: string;
  /** The harness's offline form: "--dry-run", "--provider stub", "--provider fake". */
  readonly offline: string;
}

/** The validated cap, or a LiveRunRefused naming the missing consent. */
export function assertLiveRun(run: LiveRun): number {
  const budget = run.budgetUsd;
  const budgetOk = budget !== undefined && Number.isFinite(budget) && budget > 0;
  if (run.live && budgetOk) return budget;
  const missing = [
    ...(run.live ? [] : ["--live"]),
    ...(budgetOk ? [] : ["--budget-usd <cap in USD>"]),
  ];
  throw new LiveRunRefused(
    `Refusing to call a paid provider: this would run ${run.plan}, billed to the key's account. ` +
      `Add ${missing.join(" and ")} to run it (the cap is enforced from provider usage), or use ${run.offline} for the offline form.`,
  );
}

/** The environment form for lanes promptfoo starts: `EVAL_LIVE=1` and a budget variable. */
export function assertLiveEnv(
  env: Record<string, string | undefined>,
  budgetVariable: string,
  plan: string,
): number {
  const budget = env[budgetVariable] === undefined ? undefined : Number(env[budgetVariable]);
  const budgetOk = budget !== undefined && Number.isFinite(budget) && budget > 0;
  if (env["EVAL_LIVE"] === "1" && budgetOk) return budget;
  const missing = [
    ...(env["EVAL_LIVE"] === "1" ? [] : ["EVAL_LIVE=1"]),
    ...(budgetOk ? [] : [`${budgetVariable}=<cap in USD>`]),
  ];
  throw new LiveRunRefused(
    `Refusing to call a paid provider: this would run ${plan}, billed to the key's account. ` +
      `Set ${missing.join(" and ")} to run it.`,
  );
}
