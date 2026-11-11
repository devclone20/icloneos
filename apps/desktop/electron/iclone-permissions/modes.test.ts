import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ACTION_CLASSES,
  type ActionFacts,
  CREDENTIAL_READ_FLOOR,
  decide,
  DEFAULT_CEILING_KEY,
  effectiveMode,
  grantScopesFor,
  MODE_TABLE,
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
    expect(row('ignore', lenient)).toBe('aaaaaaaaaa')
    expect(row('ignore', strict)).toBe('aaaaaaaaaa')
    expect(row('manual', lenient)).toBe('aqqqqqqqqq')
    expect(row('automatic', lenient)).toBe('aaqaaqqqqq')
    expect(row('automatic', strict)).toBe('aaqqaqqqqq')
    expect(row('plan', lenient)).toBe('arrrarrrrr')
    expect(row('plan', strict)).toBe('arrrrrrrrr')
    expect(row('acceptEdits', lenient)).toBe('aaqqqqqqqq')
  })

  it('spend and system permissions are never a plain allow in any mode but Ignore (F40, the owner)', () => {
    for (const mode of PERMISSION_MODES.filter(one => one !== 'ignore')) {
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
          floor: 'hardline: total destruction, rm -rf ~',
          ceiling: 'on',
          granted: true
        })
      ).toMatchObject({
        outcome: 'refuse',
        rule: 'floor'
      })
    }
  })

  it('a switch OFF refuses its class in every mode but Ignore (F40, the owner); ON lets the mode decide', () => {
    for (const mode of PERMISSION_MODES.filter(one => one !== 'ignore')) {
      expect(decide({ mode, cls: 'Wp', facts: { inProject: true }, ceiling: 'off', granted: true }).outcome).toBe(
        'refuse'
      )
    }

    expect(decide({ mode: 'ignore', cls: 'Wp', ceiling: 'on' }).outcome).toBe('allow')
  })

  it('undecided turns an allow into an ask (read stays an allow), and a grant still lifts it', () => {
    expect(decide({ mode: 'automatic', cls: 'X', facts: { dangerous: false }, ceiling: 'undecided' })).toMatchObject({
      outcome: 'ask',
      rule: 'ceiling'
    })
    expect(decide({ mode: 'ignore', cls: 'R', ceiling: 'undecided' }).outcome).toBe('allow')
    expect(
      decide({ mode: 'automatic', cls: 'X', facts: { dangerous: false }, ceiling: 'undecided', granted: true }).outcome
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

describe('G28: what asks outside total destruction', () => {
  it.each([
    'hardline: system shutdown/reboot',
    'hardline: kill all processes',
    'hardline: fork bomb',
    'privilege: system permissions are granted by you in System Settings',
    'confinement: this stops icloneOS, the agent runtime or your whole login session'
  ])('%s asks, Plan refuses, Ignore runs', floor => {
    for (const mode of ['manual', 'automatic', 'acceptEdits'] as const) {
      expect(decide({ mode, cls: 'X', floor, granted: true })).toMatchObject({ outcome: 'ask', rule: 'floor' })
    }

    expect(decide({ mode: 'plan', cls: 'X', floor })).toMatchObject({ outcome: 'refuse', rule: 'mode' })
    expect(decide({ mode: 'ignore', cls: 'X', floor })).toMatchObject({ outcome: 'allow' })
  })

  it('g28b: a command the gate cannot read beside a payment binary still refuses outside Ignore', () => {
    const floor = 'confinement: a command this gate cannot read sits beside a payment binary'

    for (const mode of ['manual', 'automatic', 'acceptEdits', 'plan'] as const) {
      expect(decide({ mode, cls: '$', floor, granted: true })).toMatchObject({ outcome: 'refuse', rule: 'floor' })
    }

    expect(decide({ mode: 'ignore', cls: '$', floor })).toMatchObject({ outcome: 'allow' })
  })

  it('total destruction refuses in all five', () => {
    for (const mode of ['manual', 'automatic', 'acceptEdits', 'plan', 'ignore'] as const) {
      expect(decide({ mode, cls: 'X', floor: 'hardline: total destruction, erasing a disk' })).toMatchObject({ outcome: 'refuse', rule: 'floor' })
    }
  })

  it('G102: a recursive delete of the disk by a program word it cannot read refuses in all five, as policy.py does', () => {
    const floor = 'hardline: total destruction, recursive delete of the whole disk, a home folder or the system, by a program this gate cannot read'

    for (const mode of ['manual', 'automatic', 'acceptEdits', 'plan', 'ignore'] as const) {
      expect(decide({ mode, cls: 'X', floor })).toMatchObject({ outcome: 'refuse', rule: 'floor' })
    }
  })

  it('a read of the credential list with the Seatbelt off asks, and Plan refuses a class it otherwise allows', () => {
    for (const mode of ['manual', 'automatic', 'acceptEdits'] as const) {
      expect(decide({ mode, cls: 'R', floor: CREDENTIAL_READ_FLOOR, granted: true })).toMatchObject({ outcome: 'ask', rule: 'floor' })
    }

    expect(decide({ mode: 'plan', cls: 'R', floor: CREDENTIAL_READ_FLOOR })).toMatchObject({ outcome: 'refuse', rule: 'mode' })
    expect(decide({ mode: 'plan', cls: 'R', floor: 'secrets: reading a key, token or keychain item' })).toMatchObject({ outcome: 'ask' })
    expect(decide({ mode: 'ignore', cls: 'R', floor: CREDENTIAL_READ_FLOOR })).toMatchObject({ outcome: 'allow' })
  })
})

describe('scope rules', () => {
  it('session > project > standing; fresh install is Manual', () => {
    expect(effectiveMode({ standing: 'manual', project: 'automatic', session: 'plan' })).toBe('plan')
    expect(effectiveMode({ standing: 'manual', project: 'automatic', session: null })).toBe('automatic')
    expect(effectiveMode({ standing: 'manual' })).toBe('manual')
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

describe('F53: a delete only known when it runs', () => {
  const floor = 'unresolved delete: recursive delete of a path only known when it runs'

  it('asks outside Ignore, and refuses in Ignore', () => {
    expect(decide({ mode: 'manual', cls: 'X', facts: {}, floor } as never).outcome).toBe('ask')
    expect(decide({ mode: 'ignore', cls: 'X', facts: {}, floor } as never)).toMatchObject({ outcome: 'refuse', rule: 'floor' })
  })
})
