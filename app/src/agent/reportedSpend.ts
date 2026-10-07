/** Provider-reported usage priced with a known rate. */
export interface ReportedSpend {
  amount: number;
  priceKnown: boolean;
  incomplete: boolean;
  budget?: number;
}

export function formatSpent(spend: ReportedSpend): string {
  if (!spend.priceKnown) return "Spent: see your usage";
  const amount =
    spend.amount > 0 && spend.amount < 0.01 ? "less than $0.01" : `$${spend.amount.toFixed(2)}`;
  if (spend.incomplete) {
    const minimum = (Math.floor((spend.amount + Number.EPSILON) * 100) / 100).toFixed(2);
    const reported = spend.amount > 0 && spend.amount < 0.01 ? " (less than $0.01 reported)" : "";
    return `Spent at least $${minimum}${reported}; see your usage for the total`;
  }
  return `Spent ${amount}${spend.budget === undefined ? "" : ` of your $${spend.budget.toFixed(2)} budget`}`;
}
