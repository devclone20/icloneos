// V3-F §6 — the critic's four actions and the twenty expected outcomes, shared by the unit, authority and plugin
// tests (the plugin reads them from plugins/iclone-permissions/tests/fixtures/table.json, held equal by modes.test.ts).
import type { ActionClass, ActionFacts, Outcome, PermissionMode } from './modes'

/** The critic's four actions (§6), as the classifier reports them. */
export const MATRIX_ACTIONS: Record<'A1' | 'A2' | 'A3' | 'A4', { cls: ActionClass; facts: ActionFacts }> = {
  A1: { cls: 'Wp', facts: { inProject: true } },
  A2: { cls: 'Wo', facts: { inProject: false } },
  A3: { cls: 'X', facts: { dangerous: false, privileged: false } },
  A4: { cls: '$', facts: {} }
}

/** §6, transcribed: A allow · Q ask · R! refuse. */
export const MATRIX_EXPECTED: Record<PermissionMode, Record<keyof typeof MATRIX_ACTIONS, Outcome>> = {
  ignore: { A1: 'allow', A2: 'allow', A3: 'allow', A4: 'ask' },
  manual: { A1: 'ask', A2: 'ask', A3: 'ask', A4: 'ask' },
  automatic: { A1: 'allow', A2: 'ask', A3: 'allow', A4: 'ask' },
  plan: { A1: 'refuse', A2: 'refuse', A3: 'refuse', A4: 'refuse' },
  acceptEdits: { A1: 'allow', A2: 'ask', A3: 'ask', A4: 'ask' }
}
