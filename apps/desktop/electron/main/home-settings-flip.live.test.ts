/**
 * M2 under a real race: a second process flips a folder on the way to the shown target between a decoy and a link to a
 * secret. The shown path is an ordinary folder here, so the guard does not stop it: only the open can.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { replaceLinkWithCopy } from '../home-settings-files'

const RACE_MS = 8_000

describe.runIf(process.platform === 'darwin')('a folder flipping under the copy (live)', { timeout: 60_000 }, () => {
  it('never copies what lies behind the flip', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsf-')))
    const home = path.join(base, 'hh')
    const folder = path.join(base, 'dot')
    const secretDir = path.join(base, 'fakehome', '.aws')
    const shown = path.join(folder, 'decoy', 'credentials')

    fs.mkdirSync(home)
    fs.mkdirSync(path.join(folder, 'decoy'), { recursive: true })
    fs.mkdirSync(secretDir, { recursive: true })
    fs.writeFileSync(shown, 'DECOY\n')
    fs.writeFileSync(path.join(secretDir, 'credentials'), 'FAKE_REAL_SECRET\n', { mode: 0o600 })
    fs.symlinkSync(secretDir, path.join(folder, 'held-link'))

    const flip = `const fs=require('fs');process.chdir(${JSON.stringify(folder)});for(;;){try{fs.renameSync('decoy','held-dir');fs.renameSync('held-link','decoy');fs.renameSync('decoy','held-link');fs.renameSync('held-dir','decoy')}catch{}}`
    const child = spawn(process.execPath, ['-e', flip], { stdio: 'ignore' })
    const file = path.join(home, '.env')
    const check = { doing: 'start', linksOutsideRefused: true, root: home } as const
    const tally: Record<string, number> = {}
    let leaked = 0

    try {
      for (const end = Date.now() + RACE_MS; Date.now() < end && leaked === 0;) {
        fs.rmSync(file, { force: true })
        fs.symlinkSync(shown, file)

        const result = replaceLinkWithCopy(home, '.env', shown, check)
        const key = result.ok ? 'ok' : result.reason

        tally[key] = (tally[key] ?? 0) + 1
        leaked += result.ok && fs.readFileSync(file, 'utf8').includes('FAKE_REAL_SECRET') ? 1 : 0

        // Lets the loop's timers and the child breathe; the race itself needs no ordering.
        await new Promise(resolve => setImmediate(resolve))
      }
    } finally {
      const gone = new Promise(resolve => child.once('exit', resolve))

      child.kill('SIGKILL')
      // Its last rename must be over before the folder is removed.
      await gone
      fs.rmSync(base, { force: true, recursive: true })
    }

    expect({ leaked, tally: Object.keys(tally).length > 0 }).toEqual({ leaked: 0, tally: true })
  })
})
