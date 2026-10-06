export const CRT_STEPS = ["Off", "25%", "50%", "75%", "Full"] as const;

/** Keep the released switch preference until an amount has been chosen. */
export function readCrtAmount(
  storage: Pick<Storage, "getItem" | "setItem">,
  defaultAmount: 0 | 1 = 1,
): number {
  const stored = storage.getItem("monotio_agi.crtAmount");
  if (stored !== null && stored.trim() !== "") {
    const amount = Number(stored);
    if (Number.isFinite(amount) && amount >= 0 && amount <= 1) return Math.round(amount * 4) / 4;
  }
  const legacy = storage.getItem("monotio_agi.crt");
  const amount = legacy === "on" ? 1 : legacy === "off" ? 0 : defaultAmount;
  storage.setItem("monotio_agi.crtAmount", String(amount));
  return amount;
}
