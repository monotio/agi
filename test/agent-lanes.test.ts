import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

const scripts =
  process.env["AGI_TEST_LANE_SCRIPTS"] ??
  fileURLToPath(new URL("../scripts/agent-lanes/", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

let sandbox = "";
let bin = "";
let repo = "";
let lanes = "";
let argv = "";
let hold = "";

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH: `${bin}:${process.env["PATH"]}`,
  AGI_LANES_DIR: lanes,
  FAKE_ARGV_FILE: argv,
  FAKE_HOLD_FILE: hold,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  ...extra,
});

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: env() }).trim();
}

function runLane(args: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("sh", [join(scripts, "run-lane.sh"), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: env(extra),
  });
}

const brief = () => join(repo, ".local", "agent-lanes", "briefs", "b.md");
const notes = () => join(repo, ".local", "agent-lanes");

// A fake agent CLI records its argv, then the directory it ran in. With a hold file it stays
// alive until the file is removed, with a deadline so a failed test cannot hang.
function fake(name: string): void {
  const file = join(bin, name);
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'for a in "$@"; do printf "%s\\n" "$a"; done > "$FAKE_ARGV_FILE"',
      'pwd -P >> "$FAKE_ARGV_FILE"',
      'n=0; while [ -e "$FAKE_HOLD_FILE" ] && [ "$n" -lt 150 ]; do sleep 0.2; n=$((n+1)); done',
      'printf "agent output\\n"',
      'exit "${FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "agi lanes ")));
  bin = join(sandbox, "bin");
  mkdirSync(bin);
  for (const name of ["codex", "devin", "agy", "omp"]) fake(name);
  argv = join(sandbox, "argv.txt");
  hold = join(sandbox, "hold");
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

beforeEach(() => {
  repo = join(sandbox, "repo");
  lanes = join(sandbox, "lanes");
  rmSync(repo, { recursive: true, force: true });
  rmSync(lanes, { recursive: true, force: true });
  rmSync(argv, { force: true });
  rmSync(hold, { force: true });
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Initial",
  );
  mkdirSync(join(notes(), "briefs"), { recursive: true });
  writeFileSync(brief(), "Implement the assigned change.\n");
});

const prompt = () => `Read and follow the brief at ${brief()} exactly.`;
const recorded = () => readFileSync(argv, "utf8").split("\n").slice(0, -1);

test("each preset starts its fixed command with the brief path as the prompt, in the worktree", () => {
  const codex = (model: string, effort: string) => [
    "exec",
    "-m",
    model,
    "-c",
    `model_reasoning_effort="${effort}"`,
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    repo,
    prompt(),
    repo,
  ];
  const cases: Record<string, string[]> = {
    "sol-low": codex("gpt-6.1-sol", "low"),
    "sol-medium": codex("gpt-6.1-sol", "medium"),
    "sol-high": codex("gpt-6.1-sol", "high"),
    "astra-high": codex("gpt-6-astra", "high"),
    "swe2-high": [
      "-p",
      prompt(),
      "--model",
      "swe-2-high",
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
      repo,
    ],
    "argon-high": [
      "-p",
      prompt(),
      "--model",
      "gemini-4-argon-high",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      "--add-dir",
      join(repo, ".local"),
      "--add-dir",
      repo,
      repo,
    ],
    "kimi-high": [
      "-p",
      "--model",
      "kimi-code/k3.1-pro",
      "--thinking",
      "high",
      "--no-session",
      "--cwd",
      repo,
      "--add-dir",
      join(repo, ".local"),
      prompt(),
      repo,
    ],
  };
  for (const [preset, expected] of Object.entries(cases)) {
    const result = runLane(["--wait", `lane-${preset}`, preset, brief(), repo]);
    assert.equal(result.status, 0, `${preset}: ${result.stderr}`);
    assert.deepEqual(recorded(), expected, preset);
    const log = readFileSync(join(notes(), "reports", `lane-${preset}.log`), "utf8");
    assert.equal(log, "agent output\n\nexit 0\n");
    assert.equal(readFileSync(join(notes(), "pids", `lane-${preset}.exit`), "utf8"), "0\n");
  }
});

test("an unknown preset and free-form commands are refused", () => {
  const result = runLane(["a", "gpt-9", brief(), repo]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown preset: gpt-9/);
  // Other Devin models bill API spend, so only swe2-high exists.
  assert.match(runLane(["a", "swe2-low", brief(), repo]).stderr, /Unknown preset/);
  const usage = runLane(["a", "sol-high"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: npm run lane:run/);
  assert.equal(existsSync(argv), false);
});

test("a brief outside .local is refused", () => {
  const outside = join(sandbox, "outside.md");
  writeFileSync(outside, "brief\n");
  const result = runLane(["a", "sol-high", outside, repo]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Brief must be under/);
  writeFileSync(join(repo, "tracked.md"), "brief\n");
  assert.match(
    runLane(["a", "sol-high", join(repo, "tracked.md"), repo]).stderr,
    /Brief must be under/,
  );
  assert.equal(existsSync(argv), false);
});

test("an explicit worktree is accepted on any branch, the main checkout included, and a default lane worktree needs lane/<name>", () => {
  assert.equal(git("branch", "--show-current"), "main");
  assert.equal(runLane(["--wait", "main-lane", "sol-high", brief(), repo]).status, 0);
  assert.equal(recorded().at(-1), repo);
  // Without a worktree argument the lane must live in <lanes>/<name> on lane/<name>.
  mkdirSync(lanes);
  assert.match(runLane(["other", "sol-high", brief()]).stderr, /Worktree directory missing/);
  git("worktree", "add", "-q", "-b", "wrong", join(lanes, "other"));
  assert.match(runLane(["other", "sol-high", brief()]).stderr, /Expected branch lane\/other/);
  git("worktree", "add", "-q", "-b", "lane/fine", join(lanes, "fine"));
  assert.equal(runLane(["--wait", "fine", "sol-high", brief()]).status, 0);
  assert.equal(recorded().at(-1), join(lanes, "fine"));
});

test("a lane cannot be relaunched while its previous run lives, and other lanes may share its worktree", () => {
  // The recorded incident: a detached agent kept working after its runner returned, so a
  // relaunch would have put two copies of one lane side by side. Different lanes in one
  // worktree are the orchestrator's choice (read-only probes, for example).
  writeFileSync(hold, "");
  const first = runLane(["first", "sol-high", brief(), repo]);
  assert.equal(first.status, 0, first.stderr);
  const pid = Number(readFileSync(join(notes(), "pids", "first.pid"), "utf8"));
  process.kill(pid, 0);
  const relaunch = runLane(["--rerun", "first", "sol-high", brief(), repo]);
  assert.equal(relaunch.status, 1);
  assert.match(relaunch.stderr, /Lane pid still exists/);
  assert.equal(
    runLane(["--wait", "second", "astra-high", brief(), repo], {
      FAKE_HOLD_FILE: join(sandbox, "no-hold"),
    }).status,
    0,
  );
  rmSync(hold);
  for (let i = 0; i < 100 && !existsSync(join(notes(), "pids", "first.exit")); i++) {
    spawnSync("sleep", ["0.1"]);
  }
  assert.equal(runLane(["--wait", "--rerun", "first", "sol-high", brief(), repo]).status, 0);
});

test("--rerun archives the stopped run's log, pid, identity, exit and worktree files", () => {
  assert.equal(runLane(["--wait", "again", "sol-high", brief(), repo]).status, 0);
  const refused = runLane(["--wait", "again", "sol-high", brief(), repo]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Lane log already exists/);
  const failing = runLane(["--wait", "--rerun", "again", "sol-high", brief(), repo], {
    FAKE_EXIT: "7",
  });
  assert.equal(failing.status, 7);
  const reports = readdirSync(join(notes(), "reports")).sort();
  assert.equal(reports.length, 2, reports.join());
  const archived = reports.find((file) => file !== "again.log");
  assert.match(archived ?? "", /^again\.\d{8}T\d{6}Z\.log$/);
  assert.equal(
    readFileSync(join(notes(), "reports", archived ?? ""), "utf8"),
    "agent output\n\nexit 0\n",
  );
  assert.equal(
    readFileSync(join(notes(), "reports", "again.log"), "utf8"),
    "agent output\n\nexit 7\n",
  );
  const pids = readdirSync(join(notes(), "pids"));
  for (const kind of ["pid", "identity", "exit", "worktree"]) {
    assert.equal(
      pids.filter((file) => file.endsWith(`.${kind}`)).length,
      2,
      `${kind}: ${pids.join()}`,
    );
  }
  assert.equal(readFileSync(join(notes(), "pids", "again.exit"), "utf8"), "7\n");
});

test("PATH loses node_modules/.bin so the lane runs the operator's own agent CLI", () => {
  const shadow = join(sandbox, "node_modules", ".bin");
  mkdirSync(shadow, { recursive: true });
  writeFileSync(join(shadow, "codex"), '#!/bin/sh\necho shadow > "$FAKE_ARGV_FILE"\n', {
    mode: 0o755,
  });
  const result = runLane(["--wait", "path", "sol-high", brief(), repo], {
    PATH: `${shadow}:${bin}:${process.env["PATH"]}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(recorded()[0], "exec");
});

test("lane:status shows pid, state and last log line for running, exited and stale lanes", () => {
  assert.equal(runLane(["--wait", "done", "swe2-high", brief(), join(sandbox)]).status, 0);
  writeFileSync(hold, "");
  assert.equal(runLane(["running", "sol-high", brief(), repo]).status, 0);
  // A lane whose process vanished without an exit file.
  const reports = join(notes(), "reports");
  const pids = join(notes(), "pids");
  writeFileSync(join(reports, "gone.log"), "Working on it\n");
  writeFileSync(join(pids, "gone.pid"), "999999\n");
  writeFileSync(join(pids, "gone.identity"), "Thu Jan  1 00:00:00 1970 codex\n");
  const livePid = readFileSync(join(pids, "running.pid"), "utf8").trim();
  try {
    const output = execFileSync("node", [join(scripts, "status.mjs")], {
      cwd: repo,
      encoding: "utf8",
      env: env(),
    });
    const rows = Object.fromEntries(
      output
        .trim()
        .split("\n")
        .map((line) => {
          const [name = "", pid = "", state = "", last = ""] = line.split("\t");
          return [name, { pid, state, last }];
        }),
    );
    assert.deepEqual(rows["running"], {
      pid: `pid ${livePid}`,
      state: "running",
      last: "(no log output)",
    });
    assert.deepEqual(rows["done"]?.state, "exited 0");
    assert.equal(rows["done"]?.last, "agent output");
    assert.deepEqual(rows["gone"], { pid: "pid 999999", state: "stale", last: "Working on it" });
  } finally {
    rmSync(hold);
  }
});

test("new-lane.sh still creates an isolated branch with the local game fixtures and one install", () => {
  mkdirSync(join(repo, "games", "local-fixture"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "games/*\n!games/README.md\n.local\n");
  writeFileSync(join(repo, "games", "README.md"), "Fixtures\n");
  writeFileSync(join(repo, "games", "local-fixture", "WORDS.TOK"), "words\n");
  git("add", ".gitignore", "games/README.md");
  git(
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "-m",
    "Ignore fixtures",
  );
  const installs = join(sandbox, "installs.txt");
  rmSync(installs, { force: true });
  writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s:%s\\n" "$PWD" "$*" >> "$INSTALL_LOG"\n', {
    mode: 0o755,
  });
  const run = (...args: string[]) =>
    execFileSync(join(scripts, "new-lane.sh"), args, {
      cwd: repo,
      encoding: "utf8",
      env: env({ INSTALL_LOG: installs }),
    });
  const worktree = join(lanes, "example");
  assert.equal(run("example").trim(), worktree);
  assert.equal(
    execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(),
    "lane/example",
  );
  assert.equal(readFileSync(installs, "utf8"), `${worktree}:ci\n`);
  assert.equal(
    realpathSync(join(worktree, "games", "local-fixture")),
    join(repo, "games", "local-fixture"),
  );
  assert.throws(() => run("example"), /branch already exists/);
  assert.throws(() => run("../escape"), /Invalid lane name/);
});

test("the lane guide and CLAUDE.md describe presets, with no free-form agent command", () => {
  const docs = readFileSync(join(root, "docs", "agent-lanes.md"), "utf8");
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  for (const text of [docs, claude]) assert.doesNotMatch(text, /AGI_AGENT_CMD/);
  for (const heading of ["Model roster", "Escalation ladder", "Standard brief", "Every lane"]) {
    assert.match(docs, new RegExp(`^#+ ${heading}`, "m"), heading);
  }
  for (const preset of ["sol-high", "astra-high", "swe2-high", "argon-high", "kimi-high"]) {
    assert.ok(docs.includes(`\`${preset}\``), preset);
  }
  assert.match(docs, /pgrep -fl devin/);
});
