/**
 * V3-F §1 — the five permission modes as one pure table. Main is the only authority over the mode; this module owns
 * nothing but the meaning of a mode: given the action class of a tool call and the facts the classifier measured, what
 * happens. The Hermes plugin evaluates the same table, read from the signed policy file main writes (policy-file.ts),
 * so there is exactly one table and it lives here.
 */

import type { ActionClass, ModeScope, PermissionMode } from '../../src/iclone-shared/permissions'
import { ACTION_CLASSES, PERMISSION_MODES } from '../../src/iclone-shared/permissions'

export type { ActionClass, ModeScope, PermissionMode }
export { ACTION_CLASSES, PERMISSION_MODES }

/**
 * A cell of the table. `A`/`Q`/`R!` as in the contract; the qualified allows carry the footnotes:
 *   `A:safe`         allow unless the command is dangerous (Hermes smart semantics) → ask   (Automatic X, note 4)
 *   `A:get`          allow a GET with no body and no credentials, refuse anything else       (Plan N, note 5)
 *   `A:project`      allow within the project roots, ask outside                             (Ignore D, note 3)
 *   `A:unprivileged` allow an unprivileged installer, ask for anything privileged            (Ignore I, note 2)
 *   `A:clean`        allow unless the call was measured dangerous; a structured call is clean  (V3-F2 levels only)
 */
export type ModeCell = 'A' | 'A:clean' | 'A:get' | 'A:project' | 'A:safe' | 'A:unprivileged' | 'Q' | 'R!'

export type Outcome = 'allow' | 'ask' | 'refuse'

const ALL_ASK: Record<ActionClass, ModeCell> = {
  R: 'A',
  Wp: 'Q',
  Wo: 'Q',
  X: 'Q',
  N: 'Q',
  $: 'Q',
  M: 'Q',
  S: 'Q',
  I: 'Q',
  D: 'Q'
}

export const MODE_TABLE: Readonly<Record<PermissionMode, Readonly<Record<ActionClass, ModeCell>>>> = {
  ignore: { R: 'A', Wp: 'A', Wo: 'A', X: 'A', N: 'A', $: 'Q', M: 'A', S: 'Q', I: 'A:unprivileged', D: 'A:project' },
  manual: ALL_ASK,
  automatic: { ...ALL_ASK, Wp: 'A', X: 'A:safe', N: 'A' },
  plan: { R: 'A', Wp: 'R!', Wo: 'R!', X: 'R!', N: 'A:get', $: 'R!', M: 'R!', S: 'R!', I: 'R!', D: 'R!' },
  acceptEdits: { ...ALL_ASK, Wp: 'A' }
}

/** What the classifier measured about one call; absent = not measured = the strict reading. */
export interface ActionFacts {
  dangerous?: boolean
  getOnly?: boolean
  inProject?: boolean
  privileged?: boolean
}

/** A consent switch read as a ceiling (§1): OFF refuses the class in every mode, undecided turns every allow into ask. */
export type Ceiling = 'off' | 'on' | 'undecided'

type DecisionRule = 'ceiling' | 'floor' | 'function' | 'grant' | 'mode'

export interface Decision {
  outcome: Outcome
  rule: DecisionRule
  cell: ModeCell
}

export interface DecideInput {
  mode: PermissionMode
  cls: ActionClass
  facts?: ActionFacts
  ceiling?: Ceiling
  /** A never-acceptable rule matched (§1 list) — refused before the mode is read. */
  floor?: string | null
  /** A live grant covers this call. Lifts an ask, never a refusal. */
  granted?: boolean
}

export function cellOutcome(cell: ModeCell, facts: ActionFacts): Outcome {
  switch (cell) {
    case 'A':
      return 'allow'

    case 'Q':
      return 'ask'

    case 'R!':
      return 'refuse'

    case 'A:safe':
      return facts.dangerous === false ? 'allow' : 'ask'

    case 'A:clean':
      return facts.dangerous === true ? 'ask' : 'allow'

    case 'A:get':
      return facts.getOnly === true ? 'allow' : 'refuse'

    case 'A:project':
      return facts.inProject === true ? 'allow' : 'ask'

    case 'A:unprivileged':
      return facts.privileged === false ? 'allow' : 'ask'
  }
}

/** The whole decision for one call, in the contract's order: floor, ceiling OFF, mode, undecided ceiling, grant. */
export function decide(input: DecideInput): Decision {
  const cell = MODE_TABLE[input.mode][input.cls]

  if (input.floor) {
    return { outcome: 'refuse', rule: 'floor', cell }
  }

  if (input.ceiling === 'off') {
    return { outcome: 'refuse', rule: 'ceiling', cell }
  }

  const outcome = cellOutcome(cell, input.facts ?? {})

  if (outcome === 'allow' && input.ceiling === 'undecided' && input.cls !== 'R') {
    return { outcome: input.granted ? 'allow' : 'ask', rule: input.granted ? 'grant' : 'ceiling', cell }
  }

  if (outcome === 'ask' && input.granted) {
    return { outcome: 'allow', rule: 'grant', cell }
  }

  return { outcome, rule: 'mode', cell }
}

interface ModeLayers {
  standing: PermissionMode
  project?: PermissionMode | null
  session?: PermissionMode | null
}

/** §2 precedence: session > project > standing. */
export function effectiveMode(layers: ModeLayers): PermissionMode {
  return layers.session ?? layers.project ?? layers.standing
}

/** Fresh install = Manual; Ignore permissions may never be the standing default. */
export const DEFAULT_STANDING_MODE: PermissionMode = 'manual'

export function modeAllowedAt(mode: PermissionMode, scope: ModeScope): boolean {
  return !(mode === 'ignore' && scope === 'standing')
}

export const isPermissionMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)

export const isActionClass = (value: unknown): value is ActionClass =>
  typeof value === 'string' && (ACTION_CLASSES as readonly string[]).includes(value)

/** The consent switch that caps a class when the classifier names none (§1 "Consent switches"). */
export const DEFAULT_CEILING_KEY: Readonly<Record<ActionClass, string | null>> = {
  R: null,
  Wp: 'fileWriting',
  Wo: 'fileWriting',
  X: 'terminal',
  N: 'webBrowsing',
  $: 'spendTrade',
  M: 'sendMessages',
  S: 'automation',
  I: 'installSoftware',
  D: 'fileWriting'
}

/** Scopes a prompt may grant for a class: spending is once only (§3). */
export function grantScopesFor(cls: ActionClass): readonly ('once' | ModeScope)[] {
  return cls === '$' ? ['once'] : ['once', 'session', 'project', 'standing']
}
