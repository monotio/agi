/** A project is considered for released progress once, including empty or unreadable stores. */
export function earlierProgressReceiptKey(project: string): string {
  return `monotio_agi.progress-adoption.${project}`;
}
