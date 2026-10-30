import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PaymentAuditEntry } from './client'
import { tmpProfile } from './harness.test-helpers'
import { createLedger } from './ledger'
import { DEFAULTS } from './limits'
import { createSettingsDoor } from './settings-door'
import { changeSettings, paymentPaths, readSettings } from './store'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const lab = (door: Parameters<typeof createSettingsDoor>[0]['door'], doorTimeoutMs?: number) => {
  const dir = tmpProfile()

  dirs.push(dir)

  const paths = paymentPaths(dir)
  const ledger = createLedger({ file: paths.ledger })
  const audit: PaymentAuditEntry[] = []

  const settingsDoor = createSettingsDoor({
    paths,
    ledger,
    door,
    audit: { record: entry => void audit.push(entry) },
    doorTimeoutMs
  })

  const settingRows = () =>
    ledger
      .read()
      .records.filter(row => row.kind === 'setting')
      .map(row => row.note)

  return { dir, paths, ledger, audit, settingsDoor, settingRows }
}

describe('merge-cas — the settings door applies the prev it showed (compare-and-set)', () => {
  it('merge-cas: a cap lowered in another window while the sheet is open is NOT re-raised by the stale form: refused settings_moved, nothing applied', async () => {
    const box: { lower: (() => void) | null } = { lower: null }

    const l = lab(async () => {
      box.lower?.()

      return true
    })

    // Another window, during the sheet: day cap 5.00 → 3.00 (a lowering: immediate, recorded).
    box.lower = () =>
      expect(
        changeSettings(l.paths, l.ledger, readSettings(l.paths), { ...readSettings(l.paths), perDayMicros: 3_000_000 })
      ).toMatchObject({ ok: true })

    // This window's form was read before that: it raises per-tx 1.00 → 2.00 and still says day = 5.00.
    const result = await l.settingsDoor.change({ ...readSettings(l.paths), perTxMicros: 2_000_000 })

    expect(result).toMatchObject({ ok: false, reason: 'settings_moved' })
    expect(readSettings(l.paths)).toMatchObject({ perTxMicros: 1_000_000, perDayMicros: 3_000_000 })
    expect(l.settingRows()).toEqual(['perDayMicros 5000000→3000000'])
    expect(l.audit).toEqual([{ kind: 'refuse', reason: 'setting settings_moved', agent: '' }])
  })

  it('merge-cas: control — nothing moved: the widening shown is the widening applied, recorded and audited', async () => {
    const asked: unknown[] = []

    const l = lab(async request => {
      asked.push(request)

      return true
    })

    const result = await l.settingsDoor.change({ ...readSettings(l.paths), perTxMicros: 2_000_000 })

    expect(result).toMatchObject({ ok: true, diff: { widens: true } })
    expect(asked).toEqual([{ changes: [{ axis: 'perTxMicros', from: 1_000_000, to: 2_000_000, widens: true }] }])
    expect(readSettings(l.paths).perTxMicros).toBe(2_000_000)
    expect(l.settingRows()).toEqual(['perTxMicros 1000000→2000000 (widens)'])
    expect(l.audit).toEqual([{ kind: 'use', reason: 'setting perTxMicros', agent: '' }])
  })

  it('merge-cas: a lowering needs no sheet and is applied at once; an unchanged form is a no-op with no row', async () => {
    let asked = 0

    const l = lab(async () => {
      asked += 1

      return true
    })

    expect(await l.settingsDoor.change({ ...DEFAULTS, perAgentDayMicros: 500_000 })).toMatchObject({ ok: true })
    expect(asked).toBe(0)
    expect(readSettings(l.paths).perAgentDayMicros).toBe(500_000)
    expect(await l.settingsDoor.change(readSettings(l.paths))).toMatchObject({ ok: true, diff: { changes: [] } })
    expect(l.settingRows()).toHaveLength(1)
  })

  it('merge-cas: only the boolean true opens the sheet — no door, a truthy non-true, a throw or the deadline is a refusal with nothing applied', async () => {
    const doors = [
      null,
      async () => 'yes' as unknown as boolean,
      async () => 1 as unknown as boolean,
      async () => {
        throw new Error('sheet crashed')
      },
      () => new Promise<boolean>(() => undefined)
    ]

    for (const door of doors) {
      const l = lab(door, 50)

      const result = await l.settingsDoor.change({
        ...readSettings(l.paths),
        payees: ['0x1111111111111111111111111111111111111111']
      })

      expect(result).toMatchObject({ ok: false, reason: door === null ? 'no_door' : 'door_denied' })
      expect(readSettings(l.paths).payees).toEqual([])
      expect(l.settingRows()).toEqual([])
      expect(l.audit).toHaveLength(1)
    }
  })

  it('merge-cas: what is applied comes from the request, not the sheet — a sheet that rewrites the change list it was shown cannot change it', async () => {
    const l = lab(async request => {
      for (const change of request.changes) {
        change.to = 999_000_000
      }

      return true
    })

    expect(await l.settingsDoor.change({ ...readSettings(l.paths), perTxMicros: 2_000_000 })).toMatchObject({
      ok: true
    })
    expect(readSettings(l.paths).perTxMicros).toBe(2_000_000)
    expect(fs.existsSync(path.join(l.dir, 'payments', 'settings.json'))).toBe(true)
  })
})

describe('merge-irys — local+irys has no mirror behind it in this build: refused as asked, never stored, read as local', () => {
  it('merge-irys: the door refuses it before any sheet, changeSettings refuses it, nothing is stored or recorded; the refusal is audited', async () => {
    let asked = 0

    const l = lab(async () => {
      asked += 1

      return true
    })

    // Alone, and riding along with a change that would otherwise be applied.
    for (const next of [
      { ...readSettings(l.paths), mandateStorage: 'local+irys' },
      { ...readSettings(l.paths), perTxMicros: 100_000, mandateStorage: 'local+irys' }
    ]) {
      expect(await l.settingsDoor.change(next)).toMatchObject({
        ok: false,
        reason: 'unavailable',
        detail: expect.stringContaining('not available in this build')
      })
    }

    expect(
      changeSettings(l.paths, l.ledger, readSettings(l.paths), {
        ...readSettings(l.paths),
        mandateStorage: 'local+irys'
      })
    ).toMatchObject({ ok: false, code: 'unavailable' })
    expect(asked).toBe(0)
    expect(readSettings(l.paths)).toMatchObject({ mandateStorage: 'local', perTxMicros: 1_000_000 })
    expect(l.settingRows()).toEqual([])
    expect(l.audit).toEqual([
      { kind: 'refuse', reason: 'setting unavailable', agent: '' },
      { kind: 'refuse', reason: 'setting unavailable', agent: '' }
    ])
  })

  it('merge-irys: a settings file that says local+irys (written by an older build or by hand) reads as local — nothing claims a mirror that does not exist', () => {
    const l = lab(null)

    fs.mkdirSync(l.paths.root, { recursive: true })
    fs.writeFileSync(l.paths.settings, JSON.stringify({ ...DEFAULTS, mandateStorage: 'local+irys' }))
    expect(readSettings(l.paths).mandateStorage).toBe('local')

    // Choosing local (the only storage there is) stays an ordinary, ungated choice.
    expect(
      changeSettings(l.paths, l.ledger, readSettings(l.paths), { ...readSettings(l.paths), mandateStorage: 'local' })
    ).toMatchObject({ ok: true })
  })
})

describe('Jm1 — the settings door and its store backstop refuse a malformed allowlist as asked', () => {
  it('Jm1: the door refuses before any sheet (audited); changeSettings refuses on its own; nothing written, no row', async () => {
    let sheets = 0

    const { paths, ledger, audit, settingsDoor, settingRows } = lab(() => {
      sheets += 1

      return Promise.resolve(true)
    })

    const odd = { ...DEFAULTS, payees: ['0x1111111111111111111111111111111111111111', 'vitalik.eth'] }

    expect(await settingsDoor.change(odd)).toEqual({ ok: false, reason: 'allowlist', detail: 'payees: "vitalik.eth"' })
    expect(sheets).toBe(0)
    expect(audit).toEqual([{ kind: 'refuse', reason: 'setting allowlist', agent: '' }])

    const direct = changeSettings(paths, ledger, readSettings(paths), odd)

    expect(direct).toEqual({ ok: false, code: 'allowlist', reason: 'payees: "vitalik.eth"' })
    expect(fs.existsSync(paths.settings)).toBe(false)
    expect(settingRows()).toEqual([])
  })
})
