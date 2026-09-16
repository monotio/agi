import type { HistoryBatch } from "../../src/agent/history.ts";
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
          "Recent history batches are preserved in HISTORY-RECOVERY.JSON as raw recovery data. They are not automatically restored as replay history. Keep this original ZIP.",
        );
    } catch {
      report.notes.push("The live worker's history recovery data could not be captured.");
    }
  }
  let history: ProjectHistory | null = null;
  try {
    history = await load();
  } catch {
    report.notes.push("Stored session history could not be read and is missing from this backup.");
  }
  report.complete = report.notes.length === 0;
  return { history, report };
}
