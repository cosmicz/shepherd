// Demo persona: speech, history and family alerts on. Fictional
// names. Cloud consent is deliberately NOT pre-set: granting it is a visible
// step in the demo setup that shows the scope statement.
import type { Persona } from './templates.ts';

export const demoPersona: Persona & { preferences: { speech: boolean; history: boolean; family: boolean } } = {
  person: 'June',
  family_name: 'Danny',
  preferences: { speech: true, history: true, family: true },
};
