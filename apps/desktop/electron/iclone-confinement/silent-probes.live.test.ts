/**
 * The OS logging probes are refused without a report (profiles.ts SILENT_DENY_*). Live against /usr/bin/sandbox-exec,
 * with a log stream attached as main's refusal stream always is — the attachment is what makes every process ask
 * diagnosticd and read its filter. A confined command that reaches for nothing else leaves no refusal row; a read of a
 * never-list path still lands as that run's own refusal, tagged with its token.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLiveWorld, type LiveWorld } from './live-harness'
import { SANDBOX_EXEC } from './probe'
import { parseSandboxMessage } from './refusals'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface Tagged {
  operation: string
  target: string
  member: string
}

/** The kernel's denials tagged with THIS world's members folder (its run tokens), while `body` runs, plus a settle. */
async function denialsOf(world: LiveWorld, body: () => Promise<unknown>, settleMs: number): Promise<Tagged[]> {
  const stream = spawn(
    '/usr/bin/log',
    [
      'stream',
      '--style',
      'ndjson',
      '--predicate',
      `sender == "Sandbox" AND eventMessage CONTAINS "${world.paths.membersDir}"`
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )

  let buffer = ''

  stream.stdout.on('data', chunk => (buffer += String(chunk)))
  await sleep(1_500)
  await body()
  await sleep(settleMs)
  stream.kill('SIGTERM')

  const out: Tagged[] = []

  for (const line of buffer.split('\n')) {
    let message: unknown

    try {
      message = (JSON.parse(line) as { eventMessage?: unknown }).eventMessage
    } catch {
      continue
    }

    const denial = typeof message === 'string' ? parseSandboxMessage(message) : null

    if (denial?.member && path.dirname(denial.member) === world.paths.membersDir) {
      out.push({ operation: denial.operation, target: denial.target, member: denial.member })
    }
  }

  return out
}

let world: LiveWorld

beforeAll(() => {
  world = createLiveWorld()
})

afterAll(() => {
  world?.dispose()
})

describe.runIf(LIVE)('the OS logging probes are refused in silence; a real refusal is still the run’s own', () => {
  it('a confined `bash -c true` leaves zero refusal rows', async () => {
    let code: number | null = null

    const denials = await denialsOf(
      world,
      async () => {
        code = (await world.runConfined('bash -c true')).code
      },
      3_000
    )

    expect(code).toBe(0)
    expect(denials, denials.map(denial => `${denial.operation} ${denial.target}`).join('\n')).toEqual([])
  }, 20_000)

  it('a confined read of a never-list decoy is refused, and the refusal names the run', async () => {
    const decoy = path.join(world.paths.userDataDir, 'consent.json')
    let code: number | null = null

    const denials = await denialsOf(
      world,
      async () => {
        code = (await world.runConfined(`cat ${decoy}`)).code
      },
      3_000
    )

    expect(code).not.toBe(0)

    const own = denials.filter(denial => denial.target === decoy)

    expect(own.length).toBeGreaterThan(0)
    expect(own.every(denial => denial.operation.startsWith('file-read'))).toBe(true)
    // The probes stay silent on this run too: nothing but the decoy is in its rows.
    expect(denials.filter(denial => /diagnosticd|Preferences\/Logging/.test(denial.target))).toEqual([])
  }, 20_000)
})
