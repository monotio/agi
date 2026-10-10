# Extension recipes

Start with the [working agreements](../AGENTS.md) and run the affected tests plus
`npm run check` before integration. See each new regression fail before fixing it.

## Adding a profile

1. Read the common AGI behavior contract and the target build's variants. For
   uncertain behavior, inspect an original interpreter you supply locally and
   record build, binary hash, addresses, controlled inputs and findings in
   [fidelity](fidelity.md).
2. Extend `ProfileId`, `AgiProfile` where needed, and `PROFILES` in
   [profile.ts](../src/runtime/profile.ts). Preserve released profile IDs. Add
   equivalent builds to `EQUIVALENT_BUILDS` only with evidence of equivalence.
3. Update detection in the same module and any release fingerprints in
   [knownGames.ts](../src/games/knownGames.ts). Add exact detection and observable
   behavior assertions in the profile and engine tests. Fixture-dependent
   evidence uses the explicit skips in `test/fixtures.ts`.
4. Select the profile in the app's interpreter settings and through the
   language server's `--profile ID`. The server reads `PROFILES` at startup.
   Regenerate the [command reference](logic-language.md#commands) if its
   vocabulary changes. Check imported game boot and the affected runtime path.

## Adding an agent tool

Define the operation and schema in its tool family under `src/agent/`, then
register it in `AGENT_TOOLS` in [tools.ts](../src/agent/tools.ts). Add access only
to the session allowlists that need it. For Create, inspect
[workspaceAgentTools.ts](../app/src/agent/workspaceAgentTools.ts):
`WORKSPACE_AGENT_TOOLS` combines project assistance, Notes and image operations.
Proposed resource edits go through coordinated candidate validation and the
shared ProjectSession submit path. Review and Auto-approve use that same path.

Add action help to `VOCABULARY_ACTIONS` in
[vocabulary.ts](../src/vocabulary.ts) and obtain descriptions through
`toolDescription`. Test valid output and refusals in the family's tests. A
recurring failure becomes a JSON case under `evals/fixtures/bad-cases/`, with
[offline replay](../evals/README.md#offline-verification). Visible review changes
need a real browser scenario and screenshots.

## Hosting an engine

Create an `Engine` with an `EngineHost` adapter from
[engine.ts](../src/runtime/engine.ts). Inject input, presentation, sound and host
interactions; keep platform APIs in the adapter. The browser implementation in
[worker/host.ts](../app/src/worker/host.ts) shows how asynchronous prompts,
save/restore and key waits park a continuation while commands remain serviceable.
Answer the matching host request to resume it.

The optional `prepareRoom` hook lets authored games supply a missing room during
`new.room`. Validate and install the complete resource transaction before
resuming room entry. The browser enables this hook through the project's
room-generation setting. Create with AI defaults on; imported, fixture and local
template games default off. The creator can change it in game Details. Follow the profile's native
room-entry behavior and test the host interaction with a real Engine and fake
ports, as described in the [test method](../AGENTS.md#tests-and-evals).
