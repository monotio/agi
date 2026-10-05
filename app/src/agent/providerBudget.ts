/** One internal allowance for agent requests and image generation in the current task. */
export interface ProviderBudget {
  spent: number;
  reportedSpent: number;
  usageIncomplete: boolean;
  reserved: number;
  limit: number;
  allowance: number;
}
let current: ProviderBudget = {
  spent: 0,
  reportedSpent: 0,
  usageIncomplete: false,
  reserved: 0,
  limit: 5,
  allowance: 5,
};
export function beginProviderBudget(allowance: number): ProviderBudget {
  if (current.reserved > 0) {
    current.limit = allowance;
    current.allowance = allowance;
  } else {
    current = {
      spent: 0,
      reportedSpent: 0,
      usageIncomplete: false,
      reserved: 0,
      limit: allowance,
      allowance,
    };
  }
  return current;
}
export function configureImageBudget(allowance: number) {
  if (
    Number.isFinite(allowance) &&
    allowance > 0 &&
    current.spent === 0 &&
    current.reserved === 0
  ) {
    current.limit = allowance;
    current.allowance = allowance;
  }
}
export function reserveImageBudget(
  estimate: number | null,
  approved = false,
): (actual: number | null, minimum?: number) => number {
  const account = current;
  const reservation = estimate ?? account.allowance;
  if (estimate === null || account.spent + account.reserved + reservation > account.limit) {
    if (!approved)
      throw new Error("This request may pass your budget. Continue to allow this request.");
    account.limit =
      Math.max(account.limit, account.spent + account.reserved + reservation) + account.allowance;
  }
  account.reserved += reservation;
  let settled = false;
  return (actual, minimum = 0) => {
    if (settled) return account.limit;
    settled = true;
    account.reserved -= reservation;
    // A cancelled or interrupted provider may still bill; keep its reservation.
    account.spent += actual ?? Math.max(reservation, minimum);
    if (actual === null) account.usageIncomplete = true;
    account.reportedSpent += actual ?? minimum;
    return account.limit;
  };
}
