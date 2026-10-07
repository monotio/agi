/** Actual provider spending for agent requests and image generation in the current task. */
export interface ProviderBudget {
  spent: number;
  reportedSpent: number;
  usageIncomplete: boolean;
  limit: number;
  allowance: number;
}
const listeners = new WeakMap<ProviderBudget, Set<() => void>>();
export function subscribeProviderBudget(account: ProviderBudget, listener: () => void): () => void {
  let subscriptions = listeners.get(account);
  if (!subscriptions) {
    subscriptions = new Set();
    listeners.set(account, subscriptions);
  }
  subscriptions.add(listener);
  return () => {
    subscriptions.delete(listener);
  };
}
let current: ProviderBudget = {
  spent: 0,
  reportedSpent: 0,
  usageIncomplete: false,
  limit: 5,
  allowance: 5,
};
/** A person's new task starts a fresh account; pending requests settle their original account. */
export function beginProviderTask(allowance: number): ProviderBudget {
  current = {
    spent: 0,
    reportedSpent: 0,
    usageIncomplete: false,
    limit: allowance,
    allowance,
  };
  return current;
}
/** Provider activity joins the current task, including completed image requests. */
export function beginProviderBudget(allowance: number): ProviderBudget {
  configureImageBudget(allowance);
  return current;
}
function configureImageBudget(allowance: number) {
  if (Number.isFinite(allowance) && allowance > 0 && current.spent === 0) {
    current.limit = allowance;
    current.allowance = allowance;
  }
}
/** Requests keep their task account even when a new task starts before they finish. */
export function trackImageSpend(
  account = current,
): (actual: number | null, minimum?: number) => number {
  let settled = false;
  return (actual, minimum = 0) => {
    if (settled) return account.limit;
    settled = true;
    recordProviderSpend(account, actual ?? minimum, actual === null);
    return account.limit;
  };
}
export function recordProviderSpend(
  account: ProviderBudget,
  amount: number,
  incomplete = false,
): void {
  account.spent += amount;
  account.reportedSpent += amount;
  account.usageIncomplete ||= incomplete;
  for (const listener of listeners.get(account) ?? []) listener();
}
export function providerBudgetReached(account: ProviderBudget): boolean {
  return account.spent >= account.limit;
}
export function extendProviderBudget(account: ProviderBudget): void {
  account.limit += account.allowance;
}
