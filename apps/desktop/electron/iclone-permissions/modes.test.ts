import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ACTION_CLASSES,
  type ActionFacts,
  decide,
  DEFAULT_CEILING_KEY,
  effectiveMode,
  grantScopesFor,
  MODE_TABLE,
  modeAllowedAt,
  PERMISSION_MODES,
  type PermissionMode
} from './modes'
import { MATRIX_ACTIONS, MATRIX_EXPECTED } from './test-matrix'

describe('the 20-cell matrix (5 modes × 4 actions), switches ON', () => {
  for (const mode of PERMISSION_MODES) {
    for (const [action, { cls, facts }] of Object.entries(MATRIX_ACTIONS)) {
      const expected = MATRIX_EXPECTED[mode][action as keyof typeof MATRIX_ACTIONS]

      it(`${mode} · ${action} (${cls}) → ${expected}`, () => {
        expect(decide({ mode, cls, facts, ceiling: 'on' }).outcome).toBe(expected)
      })
    }
  }
})

describe('the full table (§1), 5 × 10', () => {
  // Every footnote measured in its strict reading (facts absent) and its lenient one.
  const strict: ActionFacts = {}
  const lenient: ActionFacts = { dangerous: false, getOnly: true, inProject: true, privileged: false }

  const row = (mode: PermissionMode, facts: ActionFacts) =>
    ACTION_CLASSES.map(cls => decide({ mode, cls, facts, ceiling: 'on' }).outcome)
      .map(o => ({ allow: 'a', ask: 'q', refuse: 'r' })[o])
      .join('')

  it('reads exactly as the contract table', () => {
    // order: R Wp Wo X N $ M S I D — a=allow q=ask r=refuse
    expect(row('ignore', lenient)).toBe('aaaaaqaqaa')
    expect(row('ignore', strict)).toBe('aaaaaqaqqq')
    expect(row('manual', lenient)).toBe('aqqqqqqqqq')
    expect(row('automatic', lenient)).toBe('aaqaaqqqqq')
    expect(row('automatic', strict)).toBe('aaqqaqqqqq')
    expect(row('plan', lenient)).toBe('arrrarrrrr')
    expect(row('plan', strict)).toBe('arrrrrrrrr')
    expect(row('acceptEdits', lenient)).toBe('aaqqqqqqqq')
  })

  it('spend and system permissions are never a plain allow in any mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(decide({ mode, cls: '$', facts: {}, ceiling: 'on' }).outcome).not.toBe('allow')
      expect(decide({ mode, cls: 'S', facts: {}, ceiling: 'on' }).outcome).not.toBe('allow')
    }
  })
})

describe('the floor and the ceilings', () => {
  it('a never-acceptable rule refuses in all five modes, Ignore included, even with a grant', () => {
    for (const mode of PERMISSION_MODES) {
      expect(
        decide({
          mode,
          cls: 'X',
          facts: { dangerous: false },
          floor: 'hardline: rm -rf ~',
          ceiling: 'on',
          granted: true
        })
      ).toMatchObject({
        outcome: 'refuse',
        rule: 'floor'
      })
    }
  })

  it('a switch OFF refuses its class in every mode; ON lets the mode decide', () => {
    for (const mode of PERMISSION_MODES) {
      expect(decide({ mode, cls: 'Wp', facts: { inProject: true }, ceiling: 'off', granted: true }).outcome).toBe(
        'refuse'
      )
    }

    expect(decide({ mode: 'ignore', cls: 'Wp', ceiling: 'on' }).outcome).toBe('allow')
  })

  it('undecided turns an allow into an ask (read stays an allow), and a grant still lifts it', () => {
    expect(decide({ mode: 'ignore', cls: 'X', facts: { dangerous: false }, ceiling: 'undecided' })).toMatchObject({
      outcome: 'ask',
      rule: 'ceiling'
    })
    expect(decide({ mode: 'ignore', cls: 'R', ceiling: 'undecided' }).outcome).toBe('allow')
    expect(
      decide({ mode: 'ignore', cls: 'X', facts: { dangerous: false }, ceiling: 'undecided', granted: true }).outcome
    ).toBe('allow')
  })

  it('a grant lifts an ask but never a refusal', () => {
    expect(decide({ mode: 'manual', cls: 'Wo', ceiling: 'on', granted: true })).toMatchObject({
      outcome: 'allow',
      rule: 'grant'
    })
    expect(decide({ mode: 'plan', cls: 'Wp', ceiling: 'on', granted: true }).outcome).toBe('refuse')
  })
})

describe('scope rules', () => {
  it('session > project > standing; fresh install is Manual; Ignore is never standing', () => {
    expect(effectiveMode({ standing: 'manual', project: 'automatic', session: 'plan' })).toBe('plan')
    expect(effectiveMode({ standing: 'manual', project: 'automatic', session: null })).toBe('automatic')
    expect(effectiveMode({ standing: 'manual' })).toBe('manual')
    expect(modeAllowedAt('ignore', 'standing')).toBe(false)
    expect(modeAllowedAt('ignore', 'session')).toBe(true)
  })

  it('spending is granted once only', () => {
    expect(grantScopesFor('$')).toEqual(['once'])
    expect(grantScopesFor('Wo')).toEqual(['once', 'session', 'project', 'standing'])
  })
})

describe('the plugin reads the same table', () => {
  it('the pytest fixture is the table this build ships (regenerate with the snippet in its README if this fails)', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(__dirname, '../../../../plugins/iclone-permissions/tests/fixtures/table.json'), 'utf8')
    ) as unknown

    expect(fixture).toEqual({
      table: MODE_TABLE,
      ceilingKey: DEFAULT_CEILING_KEY,
      matrix: MATRIX_EXPECTED,
      actions: MATRIX_ACTIONS
    })
  })
})
