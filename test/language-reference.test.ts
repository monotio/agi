// The shared opcode documentation in src/logic serves browser and external
// language clients, so it must work without the agent session stack behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROFILES } from "../src/runtime/profile.ts";
import { commandReference, relatedCommands } from "../src/logic/commandReference.ts";
import { ACTION_HELP, CONDITION_HELP } from "../src/logic/commandHelp.ts";
import * as agentReference from "../src/agent/commandReference.ts";
import * as agentHelp from "../src/agent/commandHelp.ts";

test("the pure language reference resolves commands without an agent session", () => {
  const refs = commandReference(PROFILES["2.936"]);
  const cycle: agentReference.CommandReference | undefined = refs.find(
    (entry) => entry.name === "cycle.time",
  );
  assert.equal(cycle?.kind, "action");
  assert.equal(cycle?.signature, "cycle.time(object, var)");
  assert.match(cycle?.help ?? "", /cel interval/);
  assert.equal(relatedCommands(PROFILES["2.936"], "relese.priorty")[0]?.name, "release.priority");
});

test("agent modules re-export the pure reference unchanged", () => {
  assert.equal(agentReference.commandReference, commandReference);
  assert.equal(agentReference.relatedCommands, relatedCommands);
  assert.equal(agentHelp.ACTION_HELP, ACTION_HELP);
  assert.equal(agentHelp.CONDITION_HELP, CONDITION_HELP);
  assert.equal(typeof agentReference.formatCommandCatalog, "function");
});

test("the pure language modules never reach into src/agent", () => {
  for (const file of [
    new URL("../src/logic/commandReference.ts", import.meta.url),
    new URL("../src/logic/commandHelp.ts", import.meta.url),
  ])
    assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+["'][^"']*agent/, file.pathname);
});
