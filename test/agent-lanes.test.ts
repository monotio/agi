import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  watchFile,
  unwatchFile,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = fileURLToPath(new URL("../scripts/agent-lanes/", import.meta.url));

test("lane contributors can pass the complete brief as a prompt argument with owner approval", () => {
  const docs = readFileSync(new URL("../docs/agent-lanes.md", import.meta.url), "utf8");
  const command = docs.match(/^export AGI_AGENT_CMD='(agy .+)'$/m)?.[1];
  assert.ok(command, "the lane guide includes an argument-based CLI example");
  assert.match(docs, /owner must approve running this command unsandboxed/);
  const brief = 'Implement the fix.\nPreserve "quotes", $variables and $(literal text).\n';
  const output = execFileSync(
    "sh",
    ["-c", `agy() { printf '%s\\0' "$@"; }\n${command.replace("<model>", "example-model")}`],
    { input: brief, encoding: "utf8" },
  );
  assert.deepEqual(output.split("\0"), [
    "--model",
    "example-model",
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    "-p",
    brief.trimEnd(),
    "",
  ]);
});

test("lane scripts create an isolated branch with the local game fixtures, install the workspaces once and wait for the agent", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agi lanes ")));
  try {
    const repo = join(directory, "repo");
    const lanes = join(directory, "lanes");
    const bin = join(directory, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    const installs = join(directory, "installs.txt");
    writeFileSync(
      join(bin, "npm"),
      '#!/bin/sh\nprintf "%s:%s\\n" "$PWD" "$*" >> "$INSTALL_LOG"\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      INSTALL_LOG: installs,
      AGI_LANES_DIR: "../lanes",
      AGI_AGENT_CMD: "cat > out.txt; echo done",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env });
    git("init", "-b", "base");
    mkdirSync(join(repo, "games", "local-fixture"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "games/*\n!games/README.md\n");
    writeFileSync(join(repo, "games", "README.md"), "Fixtures\n");
    writeFileSync(join(repo, "games", "local-fixture", "WORDS.TOK"), "words\n");
    writeFileSync(join(repo, "games", ".DS_Store"), "");
    git("add", ".gitignore", "games/README.md");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    );
    const run = (script: string, ...args: string[]) =>
      execFileSync(join(scripts, script), args, { cwd: repo, encoding: "utf8", env });

    const worktree = join(lanes, "example");
    assert.equal(run("new-lane.sh", "example").trim(), worktree);
    assert.equal(
      execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(),
      "lane/example",
    );
    assert.match(git("worktree", "list", "--porcelain"), /branch refs\/heads\/lane\/example/);
    assert.equal(readFileSync(installs, "utf8"), `${worktree}:ci\n`);
    // A lane runs the contributor's local game fixtures, which git leaves out of the worktree.
    assert.equal(
      realpathSync(join(worktree, "games", "local-fixture")),
      join(repo, "games", "local-fixture"),
    );
    assert.throws(() => readFileSync(join(worktree, "games", ".DS_Store")), { code: "ENOENT" });
    assert.throws(() => run("new-lane.sh", "example"), /branch already exists/);
    mkdirSync(join(lanes, "occupied"));
    assert.throws(() => run("new-lane.sh", "occupied"), /directory already exists/);
    assert.throws(() => run("new-lane.sh", "../escape"), /Invalid lane name/);

    const brief = join(directory, "brief.md");
    writeFileSync(brief, "Implement the assigned change.\n");
    run("run-lane.sh", "--wait", "example", brief);
    assert.equal(readFileSync(join(worktree, "out.txt"), "utf8"), readFileSync(brief, "utf8"));
    assert.equal(readFileSync(join(lanes, "logs", "example.log"), "utf8"), "done\n\nexit 0\n");
    const pid = readFileSync(join(lanes, "logs", "example.pid"), "utf8").trim();
    assert.match(pid, /^[1-9][0-9]*$/);
    assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
    assert.throws(() => run("run-lane.sh", "--wait", "example", brief), /log already exists/);

    const failure = run("new-lane.sh", "failure").trim();
    assert.throws(
      () =>
        execFileSync(join(scripts, "run-lane.sh"), ["--wait", "failure", brief, failure], {
          cwd: repo,
          env: { ...env, AGI_AGENT_CMD: "cat > failed.txt; echo failed >&2; exit 7" },
        }),
      { status: 7 },
    );
    assert.equal(readFileSync(join(lanes, "logs", "failure.log"), "utf8"), "failed\n\nexit 7\n");

    const explicit = join(lanes, "explicit");
    assert.equal(run("new-lane.sh", "explicit", "base").trim(), explicit);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: explicit, encoding: "utf8" }),
      git("rev-parse", "base"),
    );

    const server = createServer();
    const connection = new Promise<Socket>((resolve) => server.once("connection", resolve));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    execFileSync(join(scripts, "run-lane.sh"), ["explicit", brief, explicit], {
      cwd: repo,
      env: {
        ...env,
        AGENT_PORT: String(address.port),
        AGI_AGENT_CMD: `cat > out.txt; node -e 'const socket = require("node:net").connect(Number(process.env.AGENT_PORT), "127.0.0.1"); socket.on("data", () => { console.log("done"); socket.end(); });'`,
      },
    });
    const backgroundPid = Number(readFileSync(join(lanes, "logs", "explicit.pid"), "utf8"));
    process.kill(backgroundPid, 0);
    const backgroundLog = join(lanes, "logs", "explicit.log");
    const completed = new Promise<void>((resolve) => {
      watchFile(backgroundLog, { interval: 20 }, () => {
        if (readFileSync(backgroundLog, "utf8").endsWith("exit 0\n")) {
          unwatchFile(backgroundLog);
          resolve();
        }
      });
    });
    const socket = await connection;
    socket.end("release\n");
    await completed;
    server.close();
    assert.equal(readFileSync(join(explicit, "out.txt"), "utf8"), readFileSync(brief, "utf8"));
    assert.equal(readFileSync(backgroundLog, "utf8"), "done\n\nexit 0\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
