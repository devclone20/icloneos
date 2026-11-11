/**
 * The real scripts/install.sh config stage, as the app runs it (HERMES_HOME_NO_LINKS=1), with main's check already passed:
 * the runtime swaps a link in after that check. The stage is outside the sandbox and must not write through it, change
 * its target's mode, or create anything through a dangling one. A clean home still gets its files.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '..', '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'install.sh')

describe('install.sh config stage under the app', () => {
  let base: string
  let home: string
  let victim: string

  const stage = (env: Record<string, string> = { HERMES_HOME_NO_LINKS: '1' }) =>
    spawnSync(
      'bash',
      [SCRIPT, '--stage', 'config', '--non-interactive', '--json', '--dir', REPO, '--hermes-home', home],
      { encoding: 'utf8', env: { ...process.env, HERMES_HOME: home, ...env }, timeout: 30_000 }
    )

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ics-')))
    home = path.join(base, 'home')
    victim = path.join(base, 'victim')
    fs.mkdirSync(home)
    fs.writeFileSync(victim, 'mine\n', { mode: 0o644 })
    fs.chmodSync(victim, 0o644)
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('a clean home is seeded, .env private', () => {
    const run = stage()

    expect(run.status, run.stderr).toBe(0)
    expect(fs.lstatSync(path.join(home, '.env')).isFile()).toBe(true)
    expect(fs.statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600)
    expect(fs.lstatSync(path.join(home, 'config.yaml')).isFile()).toBe(true)
    expect(fs.readdirSync(home).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('an existing plain .env of mode 644 becomes private, its bytes kept', () => {
    fs.writeFileSync(path.join(home, '.env'), 'KEY=1\n')
    fs.chmodSync(path.join(home, '.env'), 0o644)
    expect(stage().status).toBe(0)
    expect(fs.statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe('KEY=1\n')
  })

  it('a home that is itself reached through a link above it still works', () => {
    const alias = path.join(base, 'alias')

    fs.symlinkSync(home, alias)
    home = alias
    expect(stage().status).toBe(0)
    expect(fs.lstatSync(path.join(base, 'home', '.env')).isFile()).toBe(true)
  })

  it('.env linked to a file of the user: its mode and bytes stay, the link stays', () => {
    fs.symlinkSync(victim, path.join(home, '.env'))

    const run = stage()

    expect(run.status, run.stderr).toBe(0)
    expect(fs.statSync(victim).mode & 0o777).toBe(0o644)
    expect(fs.readFileSync(victim, 'utf8')).toBe('mine\n')
    expect(fs.lstatSync(path.join(home, '.env')).isSymbolicLink()).toBe(true)
  })

  it.each(['.env', 'config.yaml'])('%s dangling: nothing is created through it', name => {
    const made = path.join(base, 'made')

    fs.symlinkSync(made, path.join(home, name))
    stage()
    expect(fs.existsSync(made)).toBe(false)
  })

  it('a FIFO at .env never hangs the stage', () => {
    execFileSync('/usr/bin/mkfifo', [path.join(home, '.env')])
    expect(stage().error).toBeUndefined()
  })

  it('the receipt walks nothing under the app: a planted telemetry link gets no file', () => {
    const elsewhere = path.join(base, 'elsewhere')

    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(home, 'telemetry'))
    // Only a full run has a run id, and a full run needs the network: the script's own function, called with one.
    const receipt = /^write_install_receipt\(\) \{[\s\S]*?^\}$/m.exec(fs.readFileSync(SCRIPT, 'utf8'))?.[0] ?? ''
    const call = `${receipt}\nINSTALL_RUN_ID=abc INSTALL_STARTED=1 write_install_receipt success none none`

    expect(receipt).toContain('pending_installs')
    spawnSync('bash', ['-c', call], { env: { ...process.env, HERMES_HOME: home, HERMES_HOME_NO_LINKS: '1' } })
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('the control: outside the app the same call does write the receipt', () => {
    const receipt = /^write_install_receipt\(\) \{[\s\S]*?^\}$/m.exec(fs.readFileSync(SCRIPT, 'utf8'))?.[0] ?? ''
    const env: NodeJS.ProcessEnv = { ...process.env, HERMES_HOME: home }

    delete env.HERMES_HOME_NO_LINKS
    spawnSync('bash', ['-c', `${receipt}\nINSTALL_RUN_ID=abc INSTALL_STARTED=1 write_install_receipt success none none`], { env })
    expect(fs.existsSync(path.join(home, 'telemetry', 'shared_metrics', 'pending_installs', 'abc.json'))).toBe(true)
  })

  it('from the command line a linked .env still behaves as it always did', () => {
    fs.symlinkSync(victim, path.join(home, '.env'))
    const env: NodeJS.ProcessEnv = { ...process.env, HERMES_HOME: home }

    delete env.HERMES_HOME_NO_LINKS
    expect(
      spawnSync('bash', [SCRIPT, '--stage', 'config', '--non-interactive', '--json', '--dir', REPO, '--hermes-home', home], { env }).status
    ).toBe(0)
    expect(fs.statSync(victim).mode & 0o777).toBe(0o600)
  })
})
