import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

const sources = fs
  .readdirSync(here)
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'fake-cli.ts')
  .map(name => ({ name, text: fs.readFileSync(path.join(here, name), 'utf8') }))

describe('static scan (I10): no spend argv reachable from the WORK module', () => {
  it('reads every source file', () => {
    expect(sources.map(source => source.name).sort()).toEqual([
      'audit-sink.ts',
      'drain.ts',
      'fixes.ts',
      'ipc.ts',
      'ledger.ts',
      'policy.ts',
      'state.ts',
      'supervisor.ts',
      'watchdog.ts'
    ])
  })

  it('names value-moving verbs only in the earn-only refusal list', () => {
    // A verb literal, or an argv array that opens with a spend root (JSON field names like 'client' are not argv).
    const spend =
      /'(?:fund|create-job|create-custom-job|send-transaction|topup|set-budget-with-fund-request)'|\[\s*'(?:client|wallet|trade|card|subscription)'/

    for (const { name, text } of sources) {
      const hits = text.split('\n').filter(line => spend.test(line))

      expect({ name, hits: name === 'policy.ts' ? [] : hits }).toEqual({ name, hits: [] })
    }
  })

  it('every write goes through gatedWrite; no source spawns a process of its own', () => {
    for (const { name, text } of sources) {
      expect({ name, spawn: /child_process|utilityProcess|\bspawn\(/.test(text) }).toEqual({ name, spawn: false })
    }

    const watchdog = sources.find(source => source.name === 'watchdog.ts')?.text ?? ''

    expect(watchdog.match(/actor\.run\(/g)).toHaveLength(1)
    expect(watchdog.indexOf('earnOnlyArgv(argv)')).toBeLessThan(watchdog.indexOf('actor.run('))
  })
})
