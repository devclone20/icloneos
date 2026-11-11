/**
 * F44: the G-98 proof matrix as tests, next to the real-app proof in R6/work/proof10. The floor text comes from
 * f44-floor-cases.json, which both read; no test here executes a command from it, the gate only reads the text.
 *
 * PENDING names the fronts not merged at this sha. A pending group holds its real body behind it.skipIf. The given
 * permission rows (b, c) live in R6/work/proof10 and the one-shot tests. It cannot stay pending by accident: the guards at the end go red as soon as the
 * behaviour exists and the mark is still there, so the merge has to lift it. F44_UNPEND=F40,floors lifts marks by hand.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { CONFINEMENT_ON_BY_DEFAULT } from '../../src/iclone-shared/confinement'
import { DEFAULT_STANDING_MODE, MODE_TABLE } from '../iclone-permissions/modes'

const LIFTED = (process.env.F44_UNPEND ?? '').split(',')
const pending = (front: string): boolean => !LIFTED.includes(front)

/** The fronts this file waits for, and what each must bring. The lead lifts a mark at merge by deleting its line. */
const PENDING = {
  F41: false // ./isolation-switch createIsolationSwitch + confirmIsolationOffNatively (draft 2aed2145f2)
}

interface FloorCase {
  class: string
  cmd: string
  id: string
  words: string[]
}

const CASES = JSON.parse(readFileSync(path.join(import.meta.dirname, 'f44-floor-cases.json'), 'utf8')) as {
  floors: FloorCase[]
  lifted: FloorCase[]
  nearMisses: { cmd: string; id: string }[]
}

const REPO = path.resolve(import.meta.dirname, '../../../..')
const PYTHON = path.join(REPO, 'venv/bin/python')
const FILL = { '{NET}': '1', '{R}': '/private/tmp/ip10.none', '{UD}': '/private/tmp/ip10.none/ud' }
const fill = (text: string): string => Object.entries(FILL).reduce((out, [key, value]) => out.replaceAll(key, value), text)

/** Asks the runtime's real gate about bare text. Nothing is executed. Null: no venv here. */
function gateVerdicts(texts: string[]): null | Record<string, { message: null | string; refused: boolean }> {
  if (!existsSync(PYTHON)) {
    return null
  }

  const code = `import json,sys
from tools.approval_detection import detect_floor_command as g
print(json.dumps({t:(lambda r:{"refused":bool(r[0]),"message":r[1]})(g(t)) for t in json.load(sys.stdin)}))`

  const run = spawnSync(PYTHON, ['-c', code], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', HOME: '/private/tmp/ip10.none', HERMES_HOME: '/private/tmp/ip10.none/.hermes' },
    input: JSON.stringify(texts),
    timeout: 60_000
  })

  if (run.status !== 0) {
    throw new Error(`gate did not answer: ${run.stderr}`)
  }

  return JSON.parse(run.stdout.trim().split('\n').pop() as string)
}

const FLOOR_TEXTS = CASES.floors.map(item => fill(item.cmd))
const NEAR_TEXTS = CASES.nearMisses.map(item => fill(item.cmd))
const VERDICTS = gateVerdicts([...FLOOR_TEXTS, ...CASES.lifted.map(item => fill(item.cmd)), ...NEAR_TEXTS])
const noVenv = VERDICTS === null
/** Refused by the gate at the base of this front, and so not waiting for anyone. */

describe('(e) the default path does not change', () => {
  it('a new install is Manual, writes, commands and network ask, and the Seatbelt is on', () => {
    expect(DEFAULT_STANDING_MODE).toBe('manual')
    expect(CONFINEMENT_ON_BY_DEFAULT).toBe(true)

    for (const cell of ['Wp', 'Wo', 'X', 'N'] as const) {
      expect(MODE_TABLE.manual[cell], cell).toBe('Q')
    }
  })

  it('Automatic and Plan keep their limits: Plan refuses writes, Automatic still asks for what is not safe', () => {
    expect(MODE_TABLE.plan.Wp).toBe('R!')
    expect(MODE_TABLE.plan.X).toBe('R!')
    expect(MODE_TABLE.automatic.X).toBe('A:safe')
    expect(MODE_TABLE.automatic.Wo).toBe('Q')
  })
})

describe('(d) floors', () => {
  it('the table covers every floor the owner named, and the lifted classes are no floor', () => {
    expect(new Set(CASES.floors.map(item => item.class))).toEqual(new Set(['destruction', 'disk', 'kernel']))
    expect(new Set(CASES.lifted.map(item => item.class))).toEqual(new Set(['inft', 'keys', 'admin', 'own-permissions']))
  })

  it('every command word of a floor or a lifted row is listed, so proof10 can shadow it before it leaves', () => {
    for (const item of [...CASES.floors, ...CASES.lifted]) {
      const heads = [...fill(item.cmd).matchAll(/(?:^|[|;&]\s*)([a-zA-Z_][\w.-]*)/g)].map(match => match[1])

      expect(heads.filter(word => !item.words.includes(word) && word !== 'printf'), item.id).toEqual([])
    }
  })

  it.skipIf(noVenv).each(CASES.floors)('the gate refuses $id with a clear message', item => {
    const seen = VERDICTS?.[fill(item.cmd)]

    expect(seen?.refused, item.cmd).toBe(true)
    expect(seen?.message?.length ?? 0).toBeGreaterThan(8)
  })

  it.skipIf(noVenv).each(CASES.lifted)('the owner lifted $id: it is no floor, it runs in Ignore on stand-ins only', item => {
    expect(VERDICTS?.[fill(item.cmd)]?.refused, item.cmd).toBe(false)
  })

  it.skipIf(noVenv).each(CASES.nearMisses)('nothing else: $id is not a floor', item => {
    expect(VERDICTS?.[fill(item.cmd)]?.refused, item.cmd).toBe(false)
  })

})

describe('(a) Ignore, Seatbelt off', () => {
  it('no action class asks in Ignore', () => {
    expect(Object.entries(MODE_TABLE.ignore).filter(([, cell]) => cell !== 'A')).toEqual([])
  })
})

describe('(a, e) the switch', () => {
  const load = async () => {
    const name = './isolation-switch'

    return (await import(/* @vite-ignore */ name)) as {
      createIsolationSwitch: (deps: unknown) => (event: unknown, input: unknown) => Promise<{ ok: boolean; on: boolean; reason?: string }>
      confirmIsolationOffNatively: (dialog: unknown, parent: null, persists: boolean) => Promise<boolean>
    }
  }

  const world = (enabled: boolean, confirmOff: () => Promise<boolean>) => {
    const state = { enabled }
    const restartAgent = vi.fn(async () => 'done')
    const record = vi.fn()

    return {
      restartAgent,
      record,
      state,
      deps: {
        layer: { settings: () => state, setEnabled: (next: boolean) => void (state.enabled = next), settingsPersist: () => true },
        platform: 'darwin',
        lastInputAt: () => 1_000,
        now: () => 1_100,
        confirmOff,
        restartAgent,
        record,
        changed: () => undefined
      }
    }
  }

  const GESTURE = { activation: true, confirm: true }

  it.skipIf(PENDING.F41)('off needs the native alert: Cancel changes nothing and restarts nothing', async () => {
    const { createIsolationSwitch } = await load()
    const w = world(true, async () => false)
    const seen = await createIsolationSwitch(w.deps)({}, { enabled: false, gesture: GESTURE })

    expect(seen).toMatchObject({ ok: false, on: true, reason: 'cancelled' })
    expect(w.state.enabled).toBe(true)
    expect(w.restartAgent).not.toHaveBeenCalled()
  })

  it.skipIf(PENDING.F41)('off after the alert takes effect, restarts the agent and leaves a line in the audit chain', async () => {
    const { createIsolationSwitch } = await load()
    const w = world(true, async () => true)
    const seen = await createIsolationSwitch(w.deps)({}, { enabled: false, gesture: GESTURE })

    expect(seen).toMatchObject({ ok: true, on: false })
    expect(w.state.enabled).toBe(false)
    expect(w.restartAgent).toHaveBeenCalledOnce()
    expect(w.record).toHaveBeenCalledOnce()
  })

  it.skipIf(PENDING.F41)('on is one click: no alert', async () => {
    const { createIsolationSwitch } = await load()
    const confirmOff = vi.fn(async () => false)
    const w = world(false, confirmOff)
    const seen = await createIsolationSwitch(w.deps)({}, { enabled: true, gesture: GESTURE })

    expect(seen).toMatchObject({ ok: true, on: true })
    expect(confirmOff).not.toHaveBeenCalled()
  })

  it.skipIf(PENDING.F41)('a call with no real click turns nothing off', async () => {
    const { createIsolationSwitch } = await load()
    const w = world(true, async () => true)
    const seen = await createIsolationSwitch(w.deps)({}, { enabled: false })

    expect(seen.ok).toBe(false)
    expect(w.state.enabled).toBe(true)
  })

  it.skipIf(PENDING.F41)('the alert says plainly what is lost, other processes reading included (R19), and Cancel is the default', async () => {
    const { confirmIsolationOffNatively } = await load()
    let options: { buttons?: string[]; cancelId?: number; defaultId?: number; detail?: string; message?: string } = {}

    const dialog = {
      showMessageBox: async (first: unknown, second?: unknown) => {
        options = (second ?? first) as typeof options

        return { response: 0, checkboxChecked: false }
      }
    }

    expect(await confirmIsolationOffNatively(dialog, null, true)).toBe(false)

    const text = `${options.message} ${options.detail}`

    expect(text).toContain('Other processes on this Mac can read what they write')
    expect(text).toContain('they can read other apps\u2019')
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
  })
})

describe('a pending mark cannot outlive the wait', () => {
  it('F41: pending only while the switch is not in this folder', () => {
    expect(existsSync(path.join(import.meta.dirname, 'isolation-switch.ts'))).toBe(!PENDING.F41)
  })
})

describe('(c) the doors to an iNFT session, which proof10 drives', () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dirname, '../..', rel), 'utf8')

  it('/profile swaps the gateway through main before the next new chat: the routed row drives this door', () => {
    const slash = read('src/app/session/hooks/use-prompt-actions/slash.ts')
    expect(slash).toContain('$newChatProfile.set(key)\n            await ensureGatewayProfile(key)')
  })
})

// f57, d.lifted.perm-mode-tool: a tool can overwrite the permission files, and main does not take an edit it cannot verify.
describe('the Ignore alert on the permission files', () => {
  it('says what a write really does', async () => {
    const { ignoreConfirmCopy } = await import('../../src/iclone-shared/permission-ignore-copy')
    const text = JSON.stringify(ignoreConfirmCopy())

    expect(text).toContain('overwrite its own permission files')
    expect(text).toContain('cannot verify')
    expect(text).not.toContain('change its own permissions')
  })
})
