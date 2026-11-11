/**
 * The membership probe, live against the real kernel (macOS only): it finds the run a confined process belongs to, and
 * it asks without a report, so the Sandbox log — the same stream the refusal reader listens to — carries nothing of
 * its questions. Before this, every denied check (the decoy, the runtime mark, the other runs' tokens) was logged as a
 * tagged denial of the checked process, about ten rows a second for one idle command.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLiveWorld, type LiveWorld } from './live-harness'
import { createMemberProbe } from './members'
import { SANDBOX_EXEC } from './probe'
import { parseSandboxMessage } from './refusals'
import { RUNTIME_PYTHON } from './runtime-live-harness'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && existsSync(RUNTIME_PYTHON)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let world: LiveWorld

beforeAll(() => {
  if (LIVE) {
    world = createLiveWorld()
  }
})

afterAll(() => {
  world?.dispose()
})

describe.runIf(LIVE)('the membership probe asks the kernel without a report', () => {
  it('finds the run of a confined command, and the Sandbox log carries none of its questions', async () => {
    const { membersDir } = world.paths
    const seen: string[] = []
    let buffer = ''

    // The raw log, before any reader's filter: every Sandbox line whose target lies in the members folder.
    const log = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', 'sender == "Sandbox"'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    log.stdout.setEncoding('utf8')
    log.stdout.on('data', (chunk: string) => {
      buffer += chunk

      const lines = buffer.split('\n')

      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('{')) {
          continue
        }

        try {
          const event = JSON.parse(line) as { eventMessage?: unknown }
          const denial = typeof event.eventMessage === 'string' ? parseSandboxMessage(event.eventMessage) : null

          if (denial && (denial.target === membersDir || denial.target.startsWith(`${membersDir}/`))) {
            seen.push(`${denial.process}(${denial.pid}) ${denial.operation} ${denial.target}`)
          }
        } catch {
          // not an event line
        }
      }
    })

    try {
      await sleep(1_500)

      const spawned = await world.backend.spawn({
        cls: 'project',
        argv: ['/bin/sleep', '30'],
        cwd: world.project,
        env: { PATH: '/usr/bin:/bin', HOME: world.paths.home, LANG: 'C' },
        projectRoot: world.project,
        network: false,
        writeProject: false,
        sessionId: 'probe-live',
        outputDir: null
      })

      expect(spawned.ok).toBe(true)

      if (!spawned.ok) {
        return
      }

      const pid = spawned.child.pid as number
      const probe = createMemberProbe(membersDir, RUNTIME_PYTHON)

      try {
        await sleep(500)

        // The pane asks every second; ten rounds here.
        for (let round = 0; round < 10; round += 1) {
          const members = await probe([pid])

          expect(members.get(pid), `round ${round}`).toMatch(/^project\+/)
        }

        // The log delivers a denial within about a second; three is generous.
        await sleep(3_000)
      } finally {
        spawned.child.kill('SIGKILL')
      }

      expect(seen).toEqual([])
    } finally {
      log.kill('SIGTERM')
    }
  }, 60_000)
})
