export const CRT_STEPS = ["Off", "25%", "50%", "75%", "Full"] as const;

/** Keep the released switch preference until an amount has been chosen. */
export function readCrtAmount(storage: Pick<Storage, "getItem" | "setItem">): number {
  const stored = storage.getItem("monotio_agi.crtAmount");
  if (stored !== null && stored.trim() !== "") {
    const amount = Number(stored);
    if (Number.isFinite(amount) && amount >= 0 && amount <= 1) return Math.round(amount * 4) / 4;
  }
  const amount = storage.getItem("monotio_agi.crt") === "off" ? 0 : 1;
  storage.setItem("monotio_agi.crtAmount", String(amount));
  return amount;
}
