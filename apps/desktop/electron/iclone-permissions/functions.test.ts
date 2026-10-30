// V3-F2 — per-function levels: the pure rule (contract V3F2 §2, §5, §7). Gates F2-1 (vocabulary + fixture), F2-2
// (all rows `mode` ⇒ exactly V3-F), F2-3 (level semantics, the fixture the plugin replays), F2-4 (strictest wins,
// a candidate never loosens) and the raise/lower table of F2-9.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { F2_LOOSENING_ENABLED, FUNCTION_CEILING_KEYS, LOOSENING_LEVELS } from '../../src/iclone-shared/permissions'

import { parsePluginCall } from './authority'
import {
  clampUnsealed,
  coverFunctions,
  decideFunctions,
  DEFAULT_FUNCTION_LEVELS,
  FUNCTION_LEVELS,
  functionGrantScopes,
  type FunctionLevel,
  isRaise,
  LEVEL_CELLS,
  NO_FUNCTION_TOOLS,
  normalizeLevels,
  orderFunctions,
  partsUnreadFor,
  PERMISSION_FUNCTIONS,
  type PermissionFunction,
  SHELL_TEXT_TOOLS
} from './functions'
import {
  ACTION_CLASSES,
  type ActionClass,
  type ActionFacts,
  type Ceiling,
  decide,
  DEFAULT_CEILING_KEY,
  type Outcome,
  PERMISSION_MODES,
  type PermissionMode
} from './modes'

const FIXTURE_PATH = path.join(__dirname, '../../../../plugins/iclone-permissions/tests/fixtures/functions.json')

/** The fixture's fact sets: unmeasured, all false, and each footnote fact on its own. */
const FACT_SETS: ActionFacts[] = [
  {},
  { dangerous: false, getOnly: false, inProject: false, privileged: false },
  { dangerous: true },
  { dangerous: false, privileged: false },
  { inProject: true },
  { getOnly: true },
  { dangerous: false, privileged: true }
]

const CEILINGS: Ceiling[] = ['on', 'off', 'undecided']
const FLOORS = [null, 'floor: a placeholder floor'] as const

const GRANTS: [boolean, boolean][] = [
  [false, false],
  [true, false],
  [false, true],
  [true, true]
]

const CODES: Record<string, string> = {
  'allow/mode': 'a',
  'allow/function': 'b',
  'allow/grant': 'c',
  'ask/mode': 'd',
  'ask/function': 'e',
  'ask/ceiling': 'f',
  'refuse/floor': 'g',
  'refuse/ceiling': 'h',
  'refuse/mode': 'i',
  'refuse/function': 'j'
}

const ceilingOf = (cls: ActionClass, ceiling: Ceiling): Ceiling | undefined =>
  DEFAULT_CEILING_KEY[cls] ? ceiling : undefined

/** Every case of the F2-3 cross product, in the fixture's order, as one code letter each. */
function levelCodes(): string {
  let out = ''

  for (const level of FUNCTION_LEVELS) {
    for (const mode of PERMISSION_MODES) {
      for (const cls of ACTION_CLASSES) {
        for (const facts of FACT_SETS) {
          for (const ceiling of CEILINGS) {
            for (const floor of FLOORS) {
              for (const [classGrant, fnGrant] of GRANTS) {
                const decision = decideFunctions({
                  mode,
                  cls,
                  facts,
                  floor,
                  ceiling: ceilingOf(cls, ceiling),
                  classGranted: classGrant && cls !== '$',
                  fnGranted: () => fnGrant,
                  fns: ['shell'],
                  levels: { shell: level }
                })

                out += CODES[`${decision.outcome}/${decision.rule}`] ?? 'z'
              }
            }
          }
        }
      }
    }
  }

  return out
}

/** R3-MONO — the tools of the shared coverage table: three text tools, two structured, a no-function and an unknown. */
const COVER_TOOLS = [
  'terminal',
  'process',
  'execute_code',
  'send_message',
  'browser_click',
  'web_search',
  'mcp_placeholder_tool'
]

const maskOf = (fns: readonly PermissionFunction[]): number =>
  fns.reduce((mask, fn) => mask | (1 << PERMISSION_FUNCTIONS.indexOf(fn)), 0)

const fnsOf = (mask: number): PermissionFunction[] => PERMISSION_FUNCTIONS.filter((_fn, i) => mask & (1 << i))

/** `coverFunctions` over every tool × class × subset of the nine rows, as two base-36 characters per case. */
function coverCodes(): string {
  let out = ''

  for (const tool of COVER_TOOLS) {
    for (const cls of ACTION_CLASSES) {
      for (let mask = 0; mask < 512; mask += 1) {
        out += maskOf(coverFunctions(tool, cls, fnsOf(mask)))
          .toString(36)
          .padStart(2, '0')
      }
    }
  }

  return out
}

/**
 * xorshift32 — the shared, seeded case generator of the parts table (the plugin's test runs the same one, in the same
 * order, on the same seed, so the table holds only the expected codes).
 */
function xorshift32(seed: number): (n: number) => number {
  let x = seed >>> 0 || 1

  return (n: number) => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0

    return x % n
  }
}

const PARTS_SEED = 20261021
const PARTS_COUNT = 4000
const PARTS_CEILINGS: Ceiling[] = ['on', 'on', 'on', 'undecided', 'off']
const PARTS_FLOOR = 'floor: a placeholder floor'

interface PartsCase {
  mode: PermissionMode
  levels: Record<PermissionFunction, FunctionLevel>
  line: { cls: ActionClass; facts: ActionFacts; floor: string | null; ceiling: Ceiling; mask: number }
  parts: { cls: ActionClass; facts: ActionFacts; floor: string | null; ceiling: Ceiling; mask: number }[]
  grantedClasses: Set<ActionClass>
  grantedFns: Set<PermissionFunction>
  /** R4-UNREAD: the call was not fully read (its parts are then never consulted). */
  unread: boolean
}

/**
 * The parts table's cases (R3-MONO): a line term, 0–3 part terms, random levels, grants, switches and floors; one in
 * five is unread (R4-UNREAD).
 */
function partsCases(): PartsCase[] {
  const r = xorshift32(PARTS_SEED)

  const term = () => ({
    cls: ACTION_CLASSES[r(ACTION_CLASSES.length)],
    facts: FACT_SETS[r(FACT_SETS.length)],
    floor: r(10) === 0 ? PARTS_FLOOR : null,
    ceiling: PARTS_CEILINGS[r(PARTS_CEILINGS.length)],
    mask: r(512)
  })

  const out: PartsCase[] = []

  for (let i = 0; i < PARTS_COUNT; i += 1) {
    const mode = PERMISSION_MODES[r(PERMISSION_MODES.length)]

    const levels = Object.fromEntries(
      PERMISSION_FUNCTIONS.map(fn => [fn, FUNCTION_LEVELS[r(FUNCTION_LEVELS.length)]])
    ) as Record<PermissionFunction, FunctionLevel>

    const line = term()
    const parts = Array.from({ length: r(4) }, term)
    line.mask = parts.reduce((mask, part) => mask | part.mask, line.mask)
    const grantedClasses = new Set(ACTION_CLASSES.filter(() => r(6) === 0))
    const grantedFns = new Set(PERMISSION_FUNCTIONS.filter(() => r(6) === 0))
    const unread = r(5) === 0
    out.push({ mode, levels, line, parts, grantedClasses, grantedFns, unread })
  }

  return out
}

/** Main's decision on one parts case (what `ask` passes to `decideFunctions`). */
function decidePartsCase(c: PartsCase) {
  const granted = (cls: ActionClass) => c.grantedClasses.has(cls) && cls !== '$'

  return decideFunctions({
    mode: c.mode,
    cls: c.line.cls,
    facts: c.line.facts,
    floor: c.line.floor,
    ceiling: c.line.ceiling,
    classGranted: granted(c.line.cls),
    fnGranted: fn => c.grantedFns.has(fn),
    fns: fnsOf(c.line.mask),
    levels: c.levels,
    parts: c.parts.map(part => ({
      cls: part.cls,
      facts: part.facts,
      floor: part.floor,
      ceiling: part.ceiling,
      classGranted: granted(part.cls),
      fns: fnsOf(part.mask)
    })),
    partsUnread: c.unread,
    switchesOff: [c.line.ceiling, ...c.parts.map(part => part.ceiling)].includes('off')
  })
}

function partsCodes(): string {
  return partsCases()
    .map(c => {
      const decision = decidePartsCase(c)

      return `${CODES[`${decision.outcome}/${decision.rule}`] ?? 'z'}${decision.fn ? PERMISSION_FUNCTIONS.indexOf(decision.fn) : '-'}`
    })
    .join('')
}

function fixture() {
  return {
    v: 1,
    note: 'Generated by electron/iclone-permissions/functions.test.ts (V3F2_WRITE_FIXTURE=1). Do not edit by hand.',
    functions: PERMISSION_FUNCTIONS,
    levels: FUNCTION_LEVELS,
    levelCells: LEVEL_CELLS,
    order: {
      levels: FUNCTION_LEVELS,
      modes: PERMISSION_MODES,
      classes: ACTION_CLASSES,
      factSets: FACT_SETS,
      ceilings: CEILINGS,
      floors: FLOORS,
      grants: GRANTS,
      candidate: 'shell'
    },
    codeLegend: CODES,
    shellTextTools: SHELL_TEXT_TOOLS,
    noFunctionTools: NO_FUNCTION_TOOLS,
    ceilingKeys: FUNCTION_CEILING_KEYS,
    // r5 contingency: the one flag and the levels it hides, the same on both sides
    loosening: { enabled: F2_LOOSENING_ENABLED, levels: LOOSENING_LEVELS },
    codes: levelCodes(),
    // R3-MONO: the coverage rule both sides apply (tools × classes × every subset of the nine rows) …
    coverTools: COVER_TOOLS,
    coverCodes: coverCodes(),
    // … and the decision over a line and its parts, generated from a seed by the same xorshift32 on both sides.
    parts: {
      seed: PARTS_SEED,
      count: PARTS_COUNT,
      ceilings: PARTS_CEILINGS,
      floor: PARTS_FLOOR,
      codes: partsCodes()
    }
  }
}

const SEVERITY: Record<Outcome, number> = { allow: 0, ask: 1, refuse: 2 }

/** All 81 three-state fact combinations (absent / false / true for each of the four facts). */
function allFacts(): ActionFacts[] {
  const states = [undefined, false, true]
  const out: ActionFacts[] = []

  for (const dangerous of states) {
    for (const getOnly of states) {
      for (const inProject of states) {
        for (const privileged of states) {
          out.push({ dangerous, getOnly, inProject, privileged })
        }
      }
    }
  }

  return out
}

describe('V3-F2 F2-1 — the vocabulary the plugin replays', () => {
  it('nine functions, six levels, the level cells: the committed fixture is what this build computes', () => {
    if (process.env.V3F2_WRITE_FIXTURE === '1') {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture())}\n`)
    }

    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

    expect(PERMISSION_FUNCTIONS).toHaveLength(9)
    expect(FUNCTION_LEVELS).toEqual(['mode', 'ignore', 'automatic', 'askOnce', 'askAlways', 'manual'])
    expect(committed).toEqual(fixture())
    expect(committed.codes).toHaveLength(6 * 5 * 10 * FACT_SETS.length * 3 * 2 * 4)
    expect(committed.codes).not.toContain('z')
  })
})

describe('V3-F2 F2-2 — every row at its default is exactly V3-F', () => {
  it('decideFunctions with all levels `mode` equals decide() on every case and every candidate set', () => {
    const candidateSets: PermissionFunction[][] = [
      [],
      ...PERMISSION_FUNCTIONS.map(fn => [fn]),
      ['email', 'shell'],
      ['payments', 'trading', 'shopping', 'acp'],
      [...PERMISSION_FUNCTIONS]
    ]

    let cases = 0
    const diffs: string[] = []

    for (const mode of PERMISSION_MODES) {
      for (const cls of ACTION_CLASSES) {
        for (const facts of allFacts()) {
          for (const ceiling of [undefined, ...CEILINGS] as (Ceiling | undefined)[]) {
            for (const floor of FLOORS) {
              for (const granted of [false, true]) {
                const v3f = decide({ mode, cls, facts, floor, ceiling, granted })

                for (const fns of candidateSets) {
                  const f2 = decideFunctions({
                    mode,
                    cls,
                    facts,
                    floor,
                    ceiling,
                    classGranted: granted,
                    fnGranted: () => true,
                    fns,
                    levels: DEFAULT_FUNCTION_LEVELS
                  })

                  cases += 1

                  if (f2.outcome !== v3f.outcome || f2.rule !== v3f.rule || f2.cell !== v3f.cell) {
                    diffs.push(`${mode} ${cls} ${JSON.stringify(facts)} ${ceiling} ${floor} ${granted} ${fns}`)
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(diffs.slice(0, 5)).toEqual([])
    expect(cases).toBeGreaterThanOrEqual(38_000)
  })
})

describe('V3-F2 F2-3 — what each level means', () => {
  const one = (level: FunctionLevel, cls: ActionClass, facts: ActionFacts = {}, extra = {}) =>
    decideFunctions({
      mode: 'manual',
      cls,
      facts,
      floor: null,
      ceiling: 'on',
      classGranted: false,
      fns: ['shell'],
      levels: { shell: level },
      ...extra
    })

  it('Ignore allows every class (spending and messages too) — and a floor or an OFF switch still refuses', () => {
    for (const cls of ACTION_CLASSES) {
      expect(one('ignore', cls).outcome).toBe('allow')
      expect(one('ignore', cls, {}, { floor: 'floor: x' }).outcome).toBe('refuse')
      // An OFF Privacy switch refuses at Ignore too (R has no switch: main passes none).
      expect(one('ignore', cls, {}, { ceiling: ceilingOf(cls, 'off') }).outcome).toBe(cls === 'R' ? 'allow' : 'refuse')
    }
  })

  it('Automatic: routine acts, dangerous / outside the project / privileged asks', () => {
    expect(one('automatic', '$').outcome).toBe('allow')
    expect(one('automatic', '$', { dangerous: true }).outcome).toBe('ask')
    expect(one('automatic', 'M').outcome).toBe('allow')
    expect(one('automatic', 'X', { dangerous: false }).outcome).toBe('allow')
    expect(one('automatic', 'X').outcome).toBe('ask')
    expect(one('automatic', 'Wo').outcome).toBe('ask')
    expect(one('automatic', 'D', { inProject: true }).outcome).toBe('allow')
    expect(one('automatic', 'D', { inProject: false }).outcome).toBe('ask')
    expect(one('automatic', 'I', { privileged: true }).outcome).toBe('ask')
  })

  it('Ask once is lifted by a function grant, spending included; Ask always by nothing but the owner’s own once', () => {
    expect(one('askOnce', '$').outcome).toBe('ask')
    expect(one('askOnce', '$', {}, { fnGranted: () => true })).toMatchObject({ outcome: 'allow', by: 'fn' })
    expect(one('askAlways', 'X', {}, { fnGranted: () => true, classGranted: true }).outcome).toBe('ask')
    expect(one('askAlways', 'X', {}, { onceGranted: true })).toMatchObject({ outcome: 'allow', by: 'once' })
  })

  it('Manual is off: refused even with every grant, and the refusal names the function', () => {
    expect(one('manual', 'M', {}, { fnGranted: () => true, classGranted: true, onceGranted: true })).toMatchObject({
      outcome: 'refuse',
      rule: 'function',
      fn: 'shell',
      level: 'manual'
    })
    expect(one('manual', 'R').outcome).toBe('allow')
  })

  it('a level the body does not know is Ask always, never wider', () => {
    expect(one('nonsense' as FunctionLevel, '$', {}, { fnGranted: () => true, classGranted: true }).outcome).toBe('ask')
  })
})

describe('V3-F2 F2-4 — the strictest candidate decides; a candidate never loosens', () => {
  it('over every level assignment of three functions, adding a candidate never lowers the severity', () => {
    const trio: PermissionFunction[] = ['email', 'payments', 'shell']
    const subsets = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]]
    let checks = 0
    const violations: string[] = []

    for (const a of FUNCTION_LEVELS) {
      for (const b of FUNCTION_LEVELS) {
        for (const c of FUNCTION_LEVELS) {
          const levels = { email: a, payments: b, shell: c }

          for (const mode of PERMISSION_MODES) {
            for (const cls of ['$', 'M', 'X', 'D'] as ActionClass[]) {
              for (const facts of FACT_SETS) {
                for (const ceiling of CEILINGS) {
                  const sev = (fns: PermissionFunction[]) =>
                    SEVERITY[
                      decideFunctions({ mode, cls, facts, floor: null, ceiling, classGranted: false, fns, levels })
                        .outcome
                    ]

                  for (const subset of subsets) {
                    const base = subset.map(i => trio[i])

                    if (base.length === 0) {
                      continue
                    }

                    for (const extra of trio) {
                      checks += 1

                      if (sev([...base, extra]) < sev(base)) {
                        violations.push(`${a}/${b}/${c} ${mode} ${cls} ${base}+${extra}`)
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(violations.slice(0, 5)).toEqual([])
    expect(checks).toBeGreaterThan(100_000)
    // ~200 000 decisions: in isolation ~3 s, inside the full V3-F vitest run it can pass 5 s
  }, 60_000)

  it('ties go to the function order, never to the plugin’s order; unknown names are dropped', () => {
    expect(orderFunctions(['shell', 'nope', 'email', 'shell'])).toEqual(['email', 'shell'])

    const d = decideFunctions({
      mode: 'manual',
      cls: 'M',
      facts: {},
      floor: null,
      ceiling: 'on',
      classGranted: false,
      fns: ['shell', 'email'],
      levels: { email: 'askAlways', shell: 'askOnce' }
    })

    expect(d.fn).toBe('email')
  })

  it('R2-m4: an ask tie goes to the stricter level, whatever the function order', () => {
    const askers: FunctionLevel[] = ['mode', 'askOnce', 'askAlways']
    const rank = (level: FunctionLevel) => askers.indexOf(level)

    for (const first of askers) {
      for (const second of askers) {
        const d = decideFunctions({
          mode: 'manual',
          cls: 'M',
          facts: {},
          floor: null,
          ceiling: 'on',
          classGranted: false,
          fns: ['email', 'shell'],
          levels: { email: first, shell: second }
        })

        expect(d.outcome).toBe('ask')
        expect(d.level).toBe(rank(second) > rank(first) ? second : first)
        expect(d.fn).toBe(rank(second) > rank(first) ? 'shell' : 'email')
      }
    }
  })
})

describe('V3-F2 R3-MONO — the families close over the union; a row decides on the line and on every part', () => {
  const money: PermissionFunction[] = ['payments', 'trading', 'shopping', 'acp']

  it('C2-1 main: a spend line carrying a message part reaches both message rows (and the reverse)', () => {
    expect(coverFunctions('terminal', '$', [...money, 'messaging'])).toEqual(PERMISSION_FUNCTIONS.slice(0, 6))
    expect(coverFunctions('terminal', 'M', ['email', 'trading'])).toEqual(PERMISSION_FUNCTIONS.slice(0, 6))
    // whatever the line's class: a text line naming one row of a family is decided by the whole family
    expect(coverFunctions('terminal', 'X', ['payments'])).toEqual(money)
    expect(coverFunctions('process', 'D', ['email'])).toEqual(['email', 'messaging', 'files'])
    // a structured tool keeps the row its name pins
    expect(coverFunctions('send_message', 'M', ['email'])).toEqual(['email'])
    expect(coverFunctions('send_message', '$', ['email'])).toEqual(['email', ...money])
  })

  it('R3-U: an empty list from a tool no table names is every function; a no-function tool keeps its empty list', () => {
    expect(coverFunctions('mcp_placeholder_tool', 'X', [])).toEqual(PERMISSION_FUNCTIONS)
    expect(coverFunctions('placeholder_future_tool', 'N', [])).toEqual(PERMISSION_FUNCTIONS)
    expect(coverFunctions('web_search', 'N', [])).toEqual([])
    expect(coverFunctions('mcp_placeholder_tool', 'R', [])).toEqual([])
    expect(coverFunctions('mcp_placeholder_tool', 'X', ['publish'])).toEqual(['publish'])
  })

  it('a part with its own class decides beside the line; an unread text call never allows at a user level', () => {
    const base = {
      mode: 'manual' as PermissionMode,
      cls: '$' as ActionClass,
      facts: {},
      floor: null,
      ceiling: 'on' as Ceiling,
      classGranted: false,
      fns: ['shell', ...money] as PermissionFunction[],
      levels: { shell: 'automatic', payments: 'ignore', trading: 'ignore', shopping: 'ignore', acp: 'ignore' } as const
    }

    const code = {
      cls: 'X' as ActionClass,
      facts: { dangerous: true },
      floor: null,
      ceiling: 'on' as Ceiling,
      classGranted: false,
      fns: ['shell'] as PermissionFunction[]
    }

    expect(decideFunctions(base).outcome).toBe('allow')
    expect(decideFunctions({ ...base, parts: [code] })).toMatchObject({ outcome: 'ask', fn: 'shell', rule: 'function' })
    // a part a row does not touch decides nothing for it
    expect(decideFunctions({ ...base, parts: [{ ...code, fns: ['files'] }] }).outcome).toBe('allow')
    // a part's own floor and switch refuse; its class grant lifts its own ask
    expect(decideFunctions({ ...base, parts: [{ ...code, floor: 'floor: placeholder' }] }).outcome).toBe('refuse')
    expect(decideFunctions({ ...base, parts: [{ ...code, ceiling: 'off' }] }).outcome).toBe('refuse')
    expect(decideFunctions({ ...base, parts: [{ ...code, classGranted: true }] }).outcome).toBe('allow')
    // the plugin did not read the parts: a user level asks instead of allowing; Follow mode is V3-F
    expect(decideFunctions({ ...base, partsUnread: true }).outcome).toBe('ask')
    expect(decideFunctions({ ...base, partsUnread: true, levels: {} }).outcome).toBe(
      decide({ mode: 'manual', cls: '$', facts: {}, ceiling: 'on' }).outcome
    )
  })
})

describe('V3-F2 R4-UNREAD — main: what is not fully read fails closed', () => {
  const unread = {
    mode: 'ignore' as PermissionMode,
    cls: 'X' as ActionClass,
    facts: { dangerous: false, privileged: false, inProject: true, getOnly: true },
    floor: null,
    ceiling: 'on' as Ceiling,
    classGranted: true,
    fnGranted: () => true,
    fns: ['shell'] as PermissionFunction[],
    partsUnread: true
  }

  it('every user level asks (Manual refuses), even a row the call does not name; no standing grant lifts it', () => {
    for (const mode of PERMISSION_MODES) {
      for (const cls of ACTION_CLASSES.filter(c => c !== 'R')) {
        for (const level of FUNCTION_LEVELS.filter(l => l !== 'mode')) {
          for (const ceiling of ['on', 'undecided'] as Ceiling[]) {
            const input = { ...unread, mode, cls, ceiling, levels: { email: level } }
            const v3f = SEVERITY[decide({ mode, cls, facts: unread.facts, ceiling, granted: true }).outcome]
            const got = decideFunctions(input)

            expect(SEVERITY[got.outcome], `${mode} ${cls} ${level} ${ceiling}`).toBe(
              Math.max(level === 'manual' ? SEVERITY.refuse : SEVERITY.ask, v3f)
            )
            expect(got.unread).toBe(true)
            expect(got.rule === 'grant' && got.level !== 'mode').toBe(false)
            // a floor and the line's own OFF switch refuse first
            expect(decideFunctions({ ...input, floor: 'floor: placeholder' }).outcome).toBe('refuse')
          }

          expect(decideFunctions({ ...unread, mode, cls, ceiling: 'off', levels: { email: level } }).outcome).toBe(
            'refuse'
          )
        }
      }
    }
  })

  it('the owner’s own once for this very call still allows; reading stays free; no user level, no change', () => {
    expect(decideFunctions({ ...unread, onceGranted: true, levels: { shell: 'askOnce' } })).toMatchObject({
      outcome: 'allow',
      by: 'once'
    })
    expect(decideFunctions({ ...unread, cls: 'R', levels: { email: 'ignore' } }).outcome).toBe('allow')

    const plain = decideFunctions({ ...unread, partsUnread: false, levels: {} })
    expect(decideFunctions({ ...unread, levels: {} })).toEqual(plain)
    expect(plain.unread).toBeUndefined()
  })

  it('an empty list is never a reading: a text call sent [] or null is unread; a structured tool never is', () => {
    expect(partsUnreadFor('terminal', [])).toBe(true)
    expect(partsUnreadFor('process', null)).toBe(true)
    expect(partsUnreadFor('execute_code', undefined)).toBe(true)
    expect(partsUnreadFor('terminal', [{ cls: 'X' }])).toBe(false)
    expect(partsUnreadFor('write_file', [])).toBe(false)
    expect(partsUnreadFor('mcp_placeholder_tool', null)).toBe(false)
    // R5-G: the plugin's flag makes any call unread, whatever parts it carries
    expect(partsUnreadFor('terminal', [{ cls: 'X' }], true)).toBe(true)
    expect(partsUnreadFor('write_file', [], true)).toBe(true)
  })
})

/**
 * R4-GEN (main's half) — the plugin's reading of the gate's joined lines and their pieces, over three length ranges
 * (1–8, 9–24, 25–60 segments), six operators and eight environments (`functions_lines.json`, written and checked by
 * the plugin's pytest): each line's class, facts, floor, switch, functions and the PARTS the plugin sends ([] =
 * unread), and each environment's switches and the classes its grants cover. Main parses it (its own cover, union and
 * unread rule) and decides it under seeded modes, level matrices and function grants. A joined line read in full never
 * decides below a piece; an unread one never allows when a piece does not and keeps every refusal a piece gets from its
 * own whole reading (the plugin's gate, the same rule: a refusal that only a piece's sub-run gets out of context asks).
 */
const LINES_PATH = path.join(__dirname, '../../../../plugins/iclone-permissions/tests/fixtures/functions_lines.json')
const PROP_SEED = Number(process.env.V3F2_PROP_SEED ?? 20261021)
const PROP_SAMPLES = 50

type Term = [number, (boolean | null)[], boolean, string | null, number]

interface PropEnv {
  ceilings: Record<string, Ceiling>
  granted: ActionClass[]
}

type Payload = [Term, Term[], boolean?]

function mainDecides(
  payload: Payload,
  env: PropEnv,
  mode: PermissionMode,
  levels: Partial<Record<PermissionFunction, FunctionLevel>>,
  fnGrants: ReadonlySet<PermissionFunction>
) {
  const facts = (raw: (boolean | null)[]): ActionFacts => ({
    dangerous: raw[0] ?? undefined,
    getOnly: raw[1] ?? undefined,
    inProject: raw[2] ?? undefined,
    privileged: raw[3] ?? undefined
  })

  const wire = ([cls, rawFacts, floor, ceilingKey, mask]: Term) => ({
    cls: ACTION_CLASSES[cls],
    facts: facts(rawFacts),
    floor: floor ? PARTS_FLOOR : null,
    ceilingKey,
    fns: fnsOf(mask)
  })

  const call = parsePluginCall({
    pid: 1,
    seq: 1,
    tool: 'terminal',
    agent: {},
    ...wire(payload[0]),
    parts: payload[1].map(wire),
    unread: payload[2] === true
  })

  if (!call) {
    throw new Error('the plugin payload did not parse')
  }

  // authority.ts `ceilingFor`: the part's own switch key, else its class's; a switch the body does not name is undecided
  const ceiling = (cls: ActionClass, key: string | null): Ceiling | undefined => {
    const k = key ?? DEFAULT_CEILING_KEY[cls]

    return k ? (env.ceilings[k] ?? 'undecided') : undefined
  }

  const granted = (cls: ActionClass) => cls !== '$' && env.granted.includes(cls)

  return SEVERITY[
    decideFunctions({
      mode,
      cls: call.cls,
      facts: call.facts,
      floor: call.floor,
      ceiling: ceiling(call.cls, call.ceilingKey),
      classGranted: granted(call.cls),
      fnGranted: fn => fnGrants.has(fn),
      fns: call.fns,
      levels,
      parts: (call.parts ?? []).map(part => ({
        ...part,
        ceiling: ceiling(part.cls, part.ceilingKey),
        classGranted: granted(part.cls)
      })),
      partsUnread: partsUnreadFor(call.tool, call.parts, call.unread),
      switchesOff: Object.values(env.ceilings).includes('off')
    }).outcome
  ]
}

interface PropTable {
  ranges: [number, number][]
  envs: PropEnv[]
  payloads: Payload[]
  combos: number[][]
}

/**
 * R4-GEN / R5-GATE — one seeded run over the plugin's lines table. Every violation is counted (no cap: a count that
 * stops is not a count); `joined` decides the joined lines (main's own decision, or a broken one for the self-test).
 * `above` counts the combinations whose oracle wants more than an allow, so a decider that always allows must report
 * exactly that many violations.
 */
function propRun(table: PropTable, seed: number, joined = mainDecides) {
  const r = xorshift32(seed)
  const strict: FunctionLevel[] = ['manual', 'askAlways', 'askOnce', 'automatic', 'mode']
  const combos = table.ranges.map(() => 0)
  const unread = table.ranges.map(() => 0)
  let violations = 0
  let above = 0
  const examples: unknown[] = []

  // a piece decided on its own whole reading: part 0 only (an unread piece stays unread)
  const wholeOnly = (payload: Payload): Payload =>
    payload[1].length > 0 ? [payload[0], [payload[1][0]], payload[2]] : payload

  for (const combo of table.combos) {
    const [joinedAt, envIndex, range] = combo.slice(-3)
    const pieces = combo.slice(0, -3)
    const env = table.envs[envIndex]
    const joinedUnread = table.payloads[joinedAt][2] === true || table.payloads[joinedAt][1].length === 0
    unread[range] += joinedUnread ? 1 : 0

    for (let k = 0; k < PROP_SAMPLES; k += 1) {
      const mode = PERMISSION_MODES[r(PERMISSION_MODES.length)]
      let levels: Record<PermissionFunction, FunctionLevel>

      if (r(2) === 0) {
        levels = Object.fromEntries(
          PERMISSION_FUNCTIONS.map(fn => [fn, FUNCTION_LEVELS[r(FUNCTION_LEVELS.length)]])
        ) as Record<PermissionFunction, FunctionLevel>
      } else {
        const lax: FunctionLevel = r(2) === 0 ? 'ignore' : 'automatic'
        levels = Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, lax])) as Record<
          PermissionFunction,
          FunctionLevel
        >

        for (let n = 1 + r(2); n > 0; n -= 1) {
          levels[PERMISSION_FUNCTIONS[r(PERMISSION_FUNCTIONS.length)]] = strict[r(strict.length)]
        }
      }

      const fnGrants = new Set(PERMISSION_FUNCTIONS.filter(() => r(5) === 0))
      combos[range] += 1
      const alone = Math.max(...pieces.map(i => mainDecides(table.payloads[i], env, mode, levels, fnGrants)))

      const own = joinedUnread
        ? Math.max(...pieces.map(i => mainDecides(wholeOnly(table.payloads[i]), env, mode, levels, fnGrants)))
        : alone

      const want = joinedUnread ? Math.max(Math.min(alone, SEVERITY.ask), own) : alone
      above += want > SEVERITY.allow ? 1 : 0

      if (joined(table.payloads[joinedAt], env, mode, levels, fnGrants) < want) {
        violations += 1

        if (examples.length < 3) {
          examples.push({ combo, mode, levels, fnGrants: [...fnGrants] })
        }
      }
    }
  }

  return { combos, unread, violations, above, examples }
}

// R5-GATE: the gate points main at the plugin's table for any seed (V3F2_LINES_PATH); the committed one is the default's
const PROP_LINES_PATH = process.env.V3F2_LINES_PATH ?? LINES_PATH

describe('V3-F2 R4-GEN — main: decide(A op B …) is never below decide(A), decide(B), …', () => {
  it('≥ 40 000 seeded combinations over three length ranges and the opaque forms: 0 violations, every one counted', () => {
    const table = JSON.parse(readFileSync(PROP_LINES_PATH, 'utf8')) as PropTable & { seed: number }

    expect(table.seed).toBe(PROP_SEED)
    const run = propRun(table, PROP_SEED)

    console.log(
      `R4-PROP main seed=${PROP_SEED} combinations=${run.combos.reduce((a, b) => a + b, 0)} ` +
        `per_range=${run.combos.join('/')} unread_joined=${run.unread.join('/')} violations=${run.violations}`
    )
    expect(run.combos.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(40_000)
    expect(Math.min(...run.combos)).toBeGreaterThanOrEqual(10_000)
    expect(run.examples).toEqual([])
    expect(run.violations).toBe(0)
  })

  it('the count is a count: a joined decider that always allows is charged every combination it fails', () => {
    const table = JSON.parse(readFileSync(PROP_LINES_PATH, 'utf8')) as PropTable
    const broken = propRun(table, PROP_SEED, () => SEVERITY.allow)

    expect(broken.above).toBeGreaterThan(3)
    expect(broken.violations).toBe(broken.above)
  })

  it('critic r3 C3-1 S1 (long-pad) and S2 (middle-run), as the plugin reads them: the joined line asks', () => {
    const table = JSON.parse(readFileSync(LINES_PATH, 'utf8')) as {
      envs: PropEnv[]
      payloads: Payload[]
      probes: {
        id: string
        standing: PermissionMode
        functions: Record<PermissionFunction, FunctionLevel>
        pieces: number[]
        joined: number
      }[]
    }

    const r3 = table.probes.filter(probe => /^S[12]-/.test(probe.id))

    expect(r3.map(probe => probe.id.slice(0, 2))).toEqual(['S1', 'S1', 'S1', 'S2', 'S2', 'S2'])

    for (const probe of r3) {
      const decides = (i: number) =>
        mainDecides(table.payloads[i], table.envs[0], probe.standing, probe.functions, new Set())

      expect(Math.max(...probe.pieces.map(decides)), probe.id).toBe(SEVERITY.ask)
      expect(decides(probe.joined), probe.id).toBe(SEVERITY.ask)
    }
  })
})

describe('V3-F2 R5-D — main: every critic r4 probe, as the plugin reads it', () => {
  it('A1 and K1 refuse, a Follow-mode row keeps a part’s OFF switch, no opaque form decides below its pieces', () => {
    const table = JSON.parse(readFileSync(LINES_PATH, 'utf8')) as {
      envs: PropEnv[]
      payloads: Payload[]
      probes: {
        id: string
        standing: PermissionMode
        functions: Partial<Record<PermissionFunction, FunctionLevel>>
        env?: number
        want?: 'atLeast' | 'refuse'
        pieces: number[]
        joined: number
      }[]
    }

    const r4 = table.probes.filter(probe => probe.want)
    const ids = r4.map(probe => probe.id.split('-')[0])

    // the corpus: A1, K1 (3 bodies × 4 pads), the read-line case, W1–W10, G1–G12 (× 3 pairs), F1–F4 (× 4 rows)
    expect(ids.filter(id => id === 'K1')).toHaveLength(12)
    expect(new Set(ids)).toEqual(
      new Set([
        'A1',
        'K1',
        'RL',
        ...['W', 'G']
          .flatMap(w => Array.from({ length: 12 }, (_, i) => `${w}${i + 1}`))
          .filter(id => !['W11', 'W12'].includes(id)),
        'F1',
        'F2',
        'F3',
        'F4'
      ])
    )

    for (const probe of r4) {
      const decides = (i: number) =>
        mainDecides(table.payloads[i], table.envs[probe.env ?? 0], probe.standing, probe.functions, new Set())

      const alone = Math.max(SEVERITY.allow, ...probe.pieces.map(decides))
      const got = decides(probe.joined)

      expect(got, probe.id).toBeGreaterThanOrEqual(alone)

      if (probe.want === 'refuse') {
        expect(got, probe.id).toBe(SEVERITY.refuse)
      }
    }
  })

  it('decideFunctions: an unread call keeps its parts and meets every switch; a Follow-mode row takes a part’s OFF', () => {
    const base = {
      mode: 'ignore' as PermissionMode,
      cls: 'X' as ActionClass,
      facts: { dangerous: false },
      floor: null,
      ceiling: 'on' as Ceiling,
      classGranted: false,
      fns: ['shell'] as PermissionFunction[],
      levels: { shell: 'ignore' } as Partial<Record<PermissionFunction, FunctionLevel>>
    }

    const floored = { cls: 'X' as ActionClass, facts: {}, floor: PARTS_FLOOR, ceiling: 'on' as Ceiling }
    const part = { ...floored, floor: null, classGranted: false, fns: ['shell'] as PermissionFunction[] }

    expect(decideFunctions({ ...base, partsUnread: true }).outcome).toBe('ask')
    // (c) a part read beside the unread flag is a term
    expect(decideFunctions({ ...base, partsUnread: true, parts: [{ ...part, floor: PARTS_FLOOR }] })).toMatchObject({
      outcome: 'refuse',
      rule: 'floor'
    })
    // (d) any switch OFF refuses an unread call at a user level — never a read one, never with no user level
    expect(decideFunctions({ ...base, partsUnread: true, switchesOff: true })).toMatchObject({
      outcome: 'refuse',
      rule: 'ceiling'
    })
    expect(decideFunctions({ ...base, switchesOff: true }).outcome).toBe('allow')
    expect(decideFunctions({ ...base, levels: {}, partsUnread: true, switchesOff: true })).toEqual(
      decideFunctions({ ...base, levels: {} })
    )
    // a row at Follow mode, on a read line, takes the OFF switch of a part that touches it
    const followed = { ...base, levels: { shell: 'mode', email: 'ignore' } as typeof base.levels }

    expect(decideFunctions({ ...followed, parts: [{ ...part, ceiling: 'off' }] })).toMatchObject({
      outcome: 'refuse',
      rule: 'ceiling',
      fn: 'shell',
      level: 'mode'
    })
    // … and decides V3-F on it: an undecided switch asks where the whole line allows
    expect(decideFunctions({ ...followed, parts: [{ ...part, ceiling: 'undecided' }] })).toMatchObject({
      outcome: 'ask',
      rule: 'ceiling',
      fn: 'shell'
    })
    // … and not that of a part it does not touch
    expect(decideFunctions({ ...followed, parts: [{ ...part, fns: ['email'], ceiling: 'off' }] })).toMatchObject({
      outcome: 'allow',
      fn: 'shell'
    })
  })
})

describe('V3-F2 F2-9 — raise or lower', () => {
  // R2-m5: the 36 pairs under each global mode — a change skips the confirm only when it is as strict as the row is
  // today (Follow mode resolved against that mode) for every class and fact set.
  const ALWAYS_LOWER = [
    'askAlways>manual',
    'askOnce>askAlways',
    'askOnce>manual',
    'automatic>askAlways',
    'automatic>askOnce',
    'automatic>manual',
    'ignore>askAlways',
    'ignore>askOnce',
    'ignore>automatic',
    'ignore>manual',
    'ignore>mode',
    'mode>manual'
  ]

  const LOWERINGS: Record<PermissionMode, string[]> = {
    ignore: [...ALWAYS_LOWER, 'mode>askAlways', 'mode>askOnce'],
    manual: [...ALWAYS_LOWER, 'askOnce>mode', 'automatic>mode', 'mode>askAlways', 'mode>askOnce'],
    automatic: [...ALWAYS_LOWER, 'automatic>mode', 'mode>askAlways', 'mode>askOnce'],
    plan: [...ALWAYS_LOWER, 'automatic>mode'],
    acceptEdits: [...ALWAYS_LOWER, 'automatic>mode', 'mode>askAlways', 'mode>askOnce']
  }

  it('the 36-pair table under each mode: only changes as strict as today skip the confirm', () => {
    for (const mode of PERMISSION_MODES) {
      const lowerings = FUNCTION_LEVELS.flatMap(from =>
        FUNCTION_LEVELS.filter(to => from !== to && !isRaise(from, to, [mode])).map(to => `${from}>${to}`)
      )

      expect(lowerings.sort(), mode).toEqual([...LOWERINGS[mode]].sort())
    }

    for (const level of FUNCTION_LEVELS) {
      expect(isRaise(level, level, ['plan'])).toBe(false)
    }
  })

  it('every mode in effect counts: a change laxer under any one of them is a raise; none known reads as Plan', () => {
    expect(isRaise('mode', 'askOnce', ['manual'])).toBe(false)
    expect(isRaise('mode', 'askOnce', ['manual', 'plan'])).toBe(true)
    expect(isRaise('mode', 'askOnce', [])).toBe(true)
    expect(isRaise('askOnce', 'mode', ['manual', 'ignore'])).toBe(true)

    for (const mode of PERMISSION_MODES) {
      for (const from of FUNCTION_LEVELS) {
        expect(isRaise(from, 'manual', [mode])).toBe(false)
        expect(isRaise('manual', from, [mode])).toBe(from !== 'manual')
        expect(isRaise('ignore', from, [mode])).toBe(false)
      }
    }
  })

  it('unsealed: only rows that never allow survive; unknown levels read as the default', () => {
    const levels = normalizeLevels({ email: 'ignore', payments: 'manual', shell: 'askAlways', files: 'bogus', x: 1 })

    expect(levels.files).toBe('mode')
    expect(Object.keys(levels)).toEqual([...PERMISSION_FUNCTIONS])
    expect(clampUnsealed(levels)).toMatchObject({ email: 'mode', payments: 'manual', shell: 'askAlways' })
  })

  it('door scopes follow the winning level', () => {
    expect(functionGrantScopes('askAlways')).toEqual(['once'])
    expect(functionGrantScopes('askOnce')).toEqual(['once', 'session', 'project', 'standing'])
    expect(functionGrantScopes('mode')).toBeNull()
  })
})
