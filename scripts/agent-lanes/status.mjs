// Lists each lane's pid, state (running, exited N, stale) and last log line.
// Process identity is start time plus executable, never argv, which can hold credentials.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C" },
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function laneState({ pid, identity, exit }, inspect = processIdentity) {
  if (Number.isInteger(exit)) return `exited ${exit}`;
  if (!Number.isSafeInteger(pid) || pid < 1) return "stale";
  const current = inspect(pid);
  if (!current) return "stale";
  return !identity || current === identity ? "running" : "stale";
}

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim() : undefined);

export function laneStatus({ notes, inspect = processIdentity }) {
  const reports = path.join(notes, "reports");
  const pids = path.join(notes, "pids");
  const names = new Set(
    [reports, pids].flatMap((dir) =>
      existsSync(dir)
        ? readdirSync(dir).flatMap(
            (file) => /^([A-Za-z0-9][\w-]*)\.(?:log|pid)$/u.exec(file)?.[1] ?? [],
          )
        : [],
    ),
  );
  return [...names].sort().flatMap((name) => {
    // Archived runs are named <name>.<timestamp>.log and never match the pattern above.
    const pid = Number(read(path.join(pids, `${name}.pid`))) || undefined;
    const exitText = read(path.join(pids, `${name}.exit`));
    const exit = exitText !== undefined && /^\d+$/u.test(exitText) ? Number(exitText) : undefined;
    const state = laneState(
      { pid, identity: read(path.join(pids, `${name}.identity`)), exit },
      inspect,
    );
    const text = (read(path.join(reports, `${name}.log`)) ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    const lastLine =
      text
        .split(/\r?\n/u)
        .filter((line) => line.trim() && !/^exit \d+$/u.test(line.trim()))
        .at(-1)
        ?.trim()
        .slice(0, 200) ?? "(no log output)";
    return [{ name, pid, state, lastLine }];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
      },
    ).trim();
    const notes =
      process.env["AGI_LANE_NOTES_DIR"] || path.join(path.dirname(common), ".local/agent-lanes");
    const rows = laneStatus({ notes });
    console.log(
      rows.length
        ? rows.map((r) => `${r.name}\tpid ${r.pid ?? "-"}\t${r.state}\t${r.lastLine}`).join("\n")
        : "No lanes found.",
    );
  } catch {
    console.error("Lane status unavailable; check the repository and notes paths.");
    process.exitCode = 1;
  }
}
