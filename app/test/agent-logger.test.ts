import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentLogger,
  type AgentLoggerState,
  type AgentLogEntry,
} from "../src/agent/agentLog.ts";

test("createAgentLogger maintains monotonically increasing seq and appends entries", () => {
  const state: AgentLoggerState = { agentLog: [], agentTask: null };
  const logger = createAgentLogger(state);

  logger.logAgent("log", "First message");
  logger.logAgent("input", "open door");
  logger.logAgent("response", "Door opened");

  assert.equal(state.agentLog.length, 3);
  assert.equal(state.agentLog[0]?.seq, 1);
  assert.equal(state.agentLog[1]?.seq, 2);
  assert.equal(state.agentLog[2]?.seq, 3);
  assert.equal(state.agentLog[0]?.detail, "First message");
  assert.equal(state.agentLog[1]?.detail, "open door");
  assert.equal(state.agentLog[2]?.detail, "Door opened");
});

test("createAgentLogger bounds entries by maxEntries and updates omittedEntries and feedStart", () => {
  const state: AgentLoggerState = {
    agentLog: [],
    agentTask: null,
    omittedEntries: 0,
    powerUp: { feedStart: 2, feedStartSeq: 3 },
  };
  const logger = createAgentLogger(state, { maxEntries: 3, maxBytes: 1_000_000 });

  logger.logAgent("log", "Msg 1");
  logger.logAgent("log", "Msg 2");
  logger.logAgent("log", "Msg 3");
  assert.equal(state.agentLog.length, 3);
  assert.equal(state.omittedEntries, 0);
  assert.equal(state.powerUp?.feedStart, 2);

  // Appending 4th entry causes eviction of the 1st entry
  logger.logAgent("log", "Msg 4");
  assert.equal(state.agentLog.length, 3);
  assert.equal(state.omittedEntries, 1);
  assert.equal(state.agentLog[0]?.detail, "Msg 2");
  assert.equal(state.agentLog[2]?.detail, "Msg 4");
  // feedStart adjusted from 2 down to 1
  assert.equal(state.powerUp?.feedStart, 1);

  // Appending 5th entry causes eviction of 2nd entry
  logger.logAgent("log", "Msg 5");
  assert.equal(state.agentLog.length, 3);
  assert.equal(state.omittedEntries, 2);
  assert.equal(state.powerUp?.feedStart, 0);
});

test("createAgentLogger bounds entries by byte cap", () => {
  const state: AgentLoggerState = { agentLog: [], agentTask: null };
  // Byte cap of 500 bytes (each 150 char entry is ~198 bytes)
  const logger = createAgentLogger(state, { maxEntries: 100, maxBytes: 500 });

  const largeString = "A".repeat(150);
  logger.logAgent("log", largeString);
  logger.logAgent("log", largeString);

  assert.equal(state.agentLog.length, 2);

  // Third large entry pushes total bytes over 300
  logger.logAgent("log", largeString);
  assert.equal(state.agentLog.length, 2);
  assert.equal(state.omittedEntries, 1);
});

test("createAgentLogger clearAgentLog resets log, omittedEntries, and powerUp cursor", () => {
  const state: AgentLoggerState = {
    agentLog: [],
    agentTask: null,
    omittedEntries: 0,
    powerUp: { feedStart: 2, feedStartSeq: 3 },
  };
  const logger = createAgentLogger(state, { maxEntries: 2 });

  logger.logAgent("log", "Entry 1");
  logger.logAgent("log", "Entry 2");
  logger.logAgent("log", "Entry 3");
  assert.equal(state.omittedEntries, 1);

  logger.clearAgentLog();
  assert.equal(state.agentLog.length, 0);
  assert.equal(state.omittedEntries, 0);
  assert.equal(state.powerUp?.feedStart, 0);
  assert.equal(state.powerUp?.feedStartSeq, 4);
});

test("traceAgentLog and __AGI_TRACE__ produce snapshots on demand without mutating state", () => {
  const state: AgentLoggerState = { agentLog: [], agentTask: null };
  const logger = createAgentLogger(state);

  logger.logAgent("input", "look tree");
  logger.logAgent("response", "A tall pine tree.");

  const trace = logger.traceAgentLog();
  assert.equal(trace.length, 2);
  assert.equal(trace[0]?.detail, "look tree");
  assert.equal(trace[1]?.detail, "A tall pine tree.");

  // Modifying trace does not affect state.agentLog
  (trace as AgentLogEntry[])[0]!.detail = "modified";
  assert.equal(state.agentLog[0]?.detail, "look tree");
});
