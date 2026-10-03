import type { HistoryBatch } from "../../../src/agent/history.ts";
import type { ProjectHistory } from "./historyArchive.ts";

/** Completeness is explicit even when only a forensic recovery tail is available. */
export interface BackupReport {
  format: "monotio.agi.backup";
  version: 1;
  complete: boolean;
  notes: string[];
  recoveryBatches: HistoryBatch[];
}

export async function collectHistoryBackup(
  load: () => Promise<ProjectHistory | null>,
  recover: (() => Promise<HistoryBatch[]>) | null,
): Promise<{ history: ProjectHistory | null; report: BackupReport }> {
  const report: BackupReport = {
    format: "monotio.agi.backup",
    version: 1,
    complete: true,
    notes: [],
    recoveryBatches: [],
  };
  // Capture the worker before reading storage: commits may complete between
  // the two, but no acknowledgement can remove our copied recovery bytes.
  if (recover) {
    try {
      report.recoveryBatches = await recover();
      if (report.recoveryBatches.length)
        report.notes.push(
          "The ZIP has a recovery file for recent play history. Reopening the game will not restore that history.",
        );
    } catch {
      report.notes.push(
        "Recent play history could not be downloaded. Keep this tab open and try downloading again.",
      );
    }
  }
  let history: ProjectHistory | null = null;
  try {
    history = await load();
  } catch {
    report.notes.push("Saved play history could not be read. Try downloading again to keep it.");
  }
  report.complete = report.notes.length === 0;
  return { history, report };
}
