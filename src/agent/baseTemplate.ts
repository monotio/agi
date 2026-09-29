/**
 * Session adapter for the editable boilerplate in src/authoring/baseTemplate.ts.
 * The template text and its pure compile step live there so provider-free
 * project creation can use them; this module keeps the AgentSession install
 * path and the existing import surface.
 */

import {
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
  BASE_TEMPLATE_LOGIC0_SOURCE,
  compileBaseTemplate,
  TEMPLATE_DEATH_LOGIC,
  TEMPLATE_DEATH_SOUND,
} from "../authoring/baseTemplate.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { AgentSessionState } from "./agentState.ts";

export {
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
  BASE_TEMPLATE_DEATH_TRACKS,
  BASE_TEMPLATE_LOGIC0_SOURCE,
  TEMPLATE_DEATH_LOGIC,
  TEMPLATE_DEATH_SOUND,
} from "../authoring/baseTemplate.ts";

/**
 * Compile and install editable boilerplate into a fresh authoring session.
 * Genesis calls this before the first model turn; imported or older authored
 * games never pass through here and keep their own rituals.
 */
export function installBaseTemplate(state: AgentSessionState, profile: AgiProfile): void {
  const built = compileBaseTemplate({ dictionary: state.sources.words, profile });
  state.container.putResource("logic", 0, built.logic0.payload);
  state.sources.logics.set(0, BASE_TEMPLATE_LOGIC0_SOURCE);
  state.container.putResource("logic", TEMPLATE_DEATH_LOGIC, built.deathLogic.payload);
  state.sources.logics.set(TEMPLATE_DEATH_LOGIC, BASE_TEMPLATE_DEATH_LOGIC_SOURCE);
  state.container.putResource("sound", TEMPLATE_DEATH_SOUND, built.deathSound);
}
