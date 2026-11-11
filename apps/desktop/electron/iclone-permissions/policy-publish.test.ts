/**
 * V-3 — the signer re-signs only what changed, and its generation stays strictly increasing across restarts (F-5)
 * while `policy-gen` is flushed once per reserved block instead of once per publish.
 */
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadPermissionKeys } from './keys'
import { buildPolicyBody, createPolicySigner } from './policy-file'

let dir: string
let clock = Date.parse('2026-11-10T10:00:00.000Z')

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-publish-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const body = (standing: 'automatic' | 'manual', at = new Date(clock)) =>
  buildPolicyBody({
    mode: { v: 1, standing, projects: {}, sessions: {}, updatedAt: at.toISOString() } as never,
    grants: [],
    ceilings: {},
    protectedPaths: [],
    secretPaths: [],
    guardPids: [1],
    inftContracts: [],
    functions: {} as never,
    fnGrants: [],
    now: at
  })

function launch() {
  const keys = loadPermissionKeys(dir, null)
  const signer = createPolicySigner(dir, keys, () => clock)
  const minted = signer.mint()
  const signed = () => JSON.parse(readFileSync(minted.file, 'utf8')) as { body: string; sig: string }

  const verifies = () => {
    const file = signed()

    return createHmac('sha256', minted.key).update(file.body).digest('hex') === file.sig
  }

  return { signer, minted, signed, verifies }
}

const persisted = () => Number.parseInt(readFileSync(path.join(dir, 'policy-gen'), 'utf8'), 10)

describe('publish', () => {
  it('the same body again (a new issue time only) re-signs nothing and keeps the generation', () => {
    const { signer, minted, signed } = launch()
    const first = signer.publish(body('manual'))
    const stamp = statSync(minted.file).mtimeMs

    clock += 1_000
    expect(signer.publish(body('manual'))).toBe(first)
    expect(statSync(minted.file).mtimeMs).toBe(stamp)
    expect(JSON.parse(signed().body).gen).toBe(first)
  })

  it('a changed body always gets a strictly newer generation, signed for every live spawn', () => {
    const { signer, signed, verifies } = launch()
    const first = signer.publish(body('manual'))
    const second = signer.publish(body('automatic'))

    expect(second).toBeGreaterThan(first)
    expect(JSON.parse(signed().body)).toMatchObject({ gen: second, standing: 'automatic' })
    expect(verifies()).toBe(true)
  })

  it('NEGATIVE CONTROL: a live file changed on disk is re-signed by the next publish, even with the same body', () => {
    const { signer, minted, signed, verifies } = launch()
    const first = signer.publish(body('manual'))

    writeFileSync(minted.file, JSON.stringify({ ...signed(), body: signed().body.replace('"manual"', '"automatic"') }))
    expect(verifies()).toBe(false)

    const again = signer.publish(body('manual'))

    expect(again).toBeGreaterThan(first)
    expect(verifies()).toBe(true)
    expect(JSON.parse(signed().body)).toMatchObject({ gen: again, standing: 'manual' })
  })

  it('F-5: every generation used is below the flushed ceiling, so a restart (clock behind) starts past all of them', () => {
    const { signer } = launch()
    let last = 0

    for (let i = 0; i < 50; i += 1) {
      last = signer.publish(body(i % 2 === 0 ? 'manual' : 'automatic'))
      expect(persisted()).toBeGreaterThanOrEqual(last)
    }

    clock -= 86_400_000

    const restarted = launch()

    expect(restarted.signer.publish(body('manual'))).toBeGreaterThan(last)
  })

  it('the ceiling is flushed once per reserved block, not once per publish', () => {
    const { signer } = launch()

    signer.publish(body('manual'))

    const ceiling = persisted()

    for (let i = 0; i < 20; i += 1) {
      signer.publish(body(i % 2 === 0 ? 'automatic' : 'manual'))
    }

    expect(persisted()).toBe(ceiling)
  })
})
