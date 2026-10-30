// U.apply_safe — scripts/desktop-update/iclone-agent-update.sh runs for real against a throwaway HERMES_HOME under the
// temp dir, with stub `hermes`, `git` and `open` first on PATH. Never the owner's runtime: no real `hermes update` here.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'desktop-update', 'iclone-agent-update.sh')
const TIP = 'b'.repeat(40)
const AFTER = 'c'.repeat(40)
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function stub(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
}

function sandbox(hermesExit: number, opts: { runtimeCli?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'u1-script-')))
  dirs.push(root)
  const home = path.join(root, 'home')
  const install = path.join(home, 'hermes-agent')
  const bin = path.join(root, 'bin')
  const calls = path.join(root, 'calls')

  expect(install.startsWith(path.join(os.homedir(), '.hermes'))).toBe(false)
  fs.mkdirSync(path.join(install, 'hermes_cli'), { recursive: true })
  fs.writeFileSync(path.join(install, 'hermes_cli', '__init__.py'), '__version__ = "0.22.3"\n')

  const hermes = `echo "hermes $*" >> "${calls}"
mkdir -p "$HERMES_HOME/logs/update_receipts"
printf '{"schema":1,"outcome":"%s","pre_update":{"sha":"${'a'.repeat(40)}"},"post_update":{"sha":"${AFTER}"},"started_at":"s","finished_at":"f"}' "${hermesExit === 0 ? 'success' : 'failed'}" > "$HERMES_HOME/logs/update_receipts/latest.json"
exit ${hermesExit}`

  if (opts.runtimeCli !== false) {
    stub(path.join(install, 'venv', 'bin', 'hermes'), hermes)
  }

  stub(path.join(bin, 'hermes'), hermes.replace('echo "hermes', 'echo "path-hermes'))
  stub(path.join(bin, 'git'), `echo "git $*" >> "${calls}"; [ "$3" = "rev-parse" ] && echo ${AFTER}`)
  stub(path.join(bin, 'open'), `echo "open $*" >> "${calls}"`)
  stub(path.join(root, 'iclone os'), `echo "relaunch $*" >> "${calls}"`)

  return { bin, calls, home, install, relaunchApp: path.join(root, 'iclone os'), root }
}

function run(box: ReturnType<typeof sandbox>) {
  const choice = path.join(box.root, 'runtime-choice.json')

  const res = spawnSync(
    '/bin/bash',
    [
      SCRIPT,
      '--install-root',
      box.install,
      '--desktop-pid',
      '0',
      '--target-sha',
      TIP,
      '--choice-file',
      choice,
      '--relaunch-app',
      box.relaunchApp
    ],
    {
      encoding: 'utf8',
      env: { HERMES_HOME: box.home, HOME: box.root, PATH: `${box.bin}:/usr/bin:/bin`, TMPDIR: box.root },
      timeout: 30_000
    }
  )

  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  const calls = read(box.calls).trim().split('\n').filter(Boolean)
  const result = JSON.parse(read(path.join(box.home, '.hermes-update-result.json')) || 'null')

  return { calls, choice: read(choice) ? JSON.parse(read(choice)) : null, res, result }
}

const relaunched = (calls: string[], app: string) =>
  calls.includes(process.platform === 'darwin' ? `open ${app}` : 'relaunch ')

describe('iclone-agent-update.sh (U.apply_safe)', () => {
  it('runs `hermes update --yes --backup --branch main` once, writes the result + choice, clears the marker, reopens the app', () => {
    const box = sandbox(0)
    const { calls, choice, res, result } = run(box)

    expect(res.status).toBe(0)
    expect(calls.filter(c => c.startsWith('hermes '))).toEqual(['hermes update --yes --backup --branch main'])
    expect(result).toMatchObject({ door: 'agent-latest', exit_code: 0, manual: false, ok: true, target_sha: TIP })
    expect(Number.isInteger(result.duration_ms)).toBe(true)
    expect(choice).toMatchObject({ door: 'agent-latest', sha: AFTER, version: '0.22.3' })
    expect(fs.existsSync(path.join(box.home, '.hermes-update-in-progress'))).toBe(false)
    expect(relaunched(calls, box.relaunchApp)).toBe(true)
    expect(calls.some(c => /mac_swap|ditto|Hermes\.app/.test(c))).toBe(false)
  })

  it('a failure is retried once, reported, records no choice, and still reopens the app', () => {
    const box = sandbox(1)
    const { calls, choice, res, result } = run(box)

    expect(res.status).toBe(1)
    expect(calls.filter(c => c.startsWith('hermes '))).toHaveLength(2)
    expect(result).toMatchObject({ exit_code: 1, ok: false })
    expect(result.message).toMatch(/backups/)
    expect(choice).toBeNull()
    expect(relaunched(calls, box.relaunchApp)).toBe(true)
  })

  it('exit 2 (close every Hermes window) is not retried', () => {
    const { calls, result } = run(sandbox(2))

    expect(calls.filter(c => c.startsWith('hermes '))).toHaveLength(1)
    expect(result).toMatchObject({ exit_code: 2, ok: false })
  })

  it("never falls back to a hermes on PATH: without the runtime's own CLI it changes nothing (exit 3)", () => {
    const { calls, choice, res, result } = run(sandbox(0, { runtimeCli: false }))

    expect(res.status).toBe(3)
    expect(calls.some(c => /hermes /.test(c))).toBe(false)
    expect(result).toMatchObject({ exit_code: 3, ok: false })
    expect(result.message).toMatch(/Nothing was changed/)
    expect(choice).toBeNull()
  })

  it('refuses without --install-root and never touches an app bundle', () => {
    const res = spawnSync('/bin/bash', [SCRIPT], { encoding: 'utf8' })
    const src = fs.readFileSync(SCRIPT, 'utf8')

    expect(res.status).toBe(64)
    expect(src).not.toMatch(/mac_swap|ditto|rm -rf/)
    expect(src).toContain('update --yes --backup --branch "$BRANCH"')
  })

  it('is packaged into Resources/desktop-update/ and main runs that copy in a packaged build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'))
    const main = fs.readFileSync(path.join(__dirname, 'main', 'agent-update.ts'), 'utf8')

    expect(pkg.build.extraResources).toContainEqual({
      from: '../../scripts/desktop-update/iclone-agent-update.sh',
      to: 'desktop-update/iclone-agent-update.sh'
    })
    expect(main).toMatch(/path\.join\(process\.resourcesPath, 'desktop-update', SCRIPT_NAME\)/)
  })
})
