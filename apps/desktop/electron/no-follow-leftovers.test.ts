import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { bootstrapCacheDir, openRunLog, spawnBash } from './bootstrap-runner'
import { HERMES_HOME_NEVER_WRITTEN } from './iclone-confinement/runtime-profile'
import type { DoctorEnv } from './iclone-doctor-checks'
import { applySteps, FIXES, type FixStep } from './iclone-doctor-fixes'
import { ensureCuratedRuntimeConfig } from './update-runtime-align'

const CANARY = 'a file of the user\n'
let world: string
let home: string
let outside: string
let canary: string

// The config stage refuses a link out of the home while the runtime is confined, as the launch does (home-settings-files.ts).
vi.mock('./iclone-confinement/ipc', () => ({ confinementSpawnEnv: () => ({ ICLONE_RUNTIME_CONFINED: '1' }) }))

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-left-')))
  home = path.join(world, 'home')
  outside = path.join(world, 'outside')
  canary = path.join(outside, 'canary')
  fs.mkdirSync(home)
  fs.mkdirSync(outside)
  fs.writeFileSync(canary, CANARY, { mode: 0o644 })
})

afterEach(() => fs.rmSync(world, { force: true, recursive: true }))

const doctorEnv = (): DoctorEnv => ({ hermesHome: home, now: () => Date.now() }) as unknown as DoctorEnv
const apply = (steps: FixStep[]) => applySteps(doctorEnv(), 'test.fix', steps, path.join(world, 'backups'))

const closed = (stream: fs.WriteStream) => new Promise<void>(resolve => stream.once('close', () => resolve()))

function plant(kind: 'dangling' | 'fifo' | 'link', at: string): string {
  const target = kind === 'link' ? canary : path.join(outside, 'created-by-a-follow')

  if (kind === 'fifo') {
    execFileSync('/usr/bin/mkfifo', [at])
  } else {
    fs.symlinkSync(target, at)
  }

  return target
}

function expectOutsideUntouched(): void {
  expect(fs.readdirSync(outside)).toEqual(['canary'])
  expect(fs.readFileSync(canary, 'utf8')).toBe(CANARY)
  expect(fs.statSync(canary).mode & 0o777).toBe(0o644)
}

describe('doctor steps on a home the runtime can write', () => {
  test.each(['link', 'dangling'] as const)('write replaces a planted %s, never follows it', async kind => {
    const file = path.join(home, 'config.yaml')
    plant(kind, file)

    const outcome = await apply([{ kind: 'write', path: file, content: 'mine\n', mode: 0o600 }])

    expectOutsideUntouched()
    expect(outcome.error).toBeUndefined()
    expect(fs.lstatSync(file).isFile()).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('mine\n')
  })

  test('write still creates the folders it needs', async () => {
    const file = path.join(home, 'new', 'sub', 'x.yaml')

    const outcome = await apply([{ kind: 'write', path: file, content: 'mine\n', mode: 0o600 }])

    expect(outcome.error).toBeUndefined()
    expect(fs.readFileSync(file, 'utf8')).toBe('mine\n')
  })

  test.each(['link', 'dangling'] as const)('write refuses a %s folder on the way', async kind => {
    const folder = path.join(home, 'sub')
    fs.symlinkSync(kind === 'link' ? outside : path.join(outside, 'gone'), folder)

    const outcome = await apply([{ kind: 'write', path: path.join(folder, 'x.yaml'), content: 'mine\n', mode: 0o600 }])

    expect(outcome.error).toMatch(/refused/)
    expectOutsideUntouched()
  })

  // The pre-image backup comes first and a FIFO has none to give: the fix stops, and neither hangs nor changes anything.
  test.each([
    ['write', (file: string): FixStep => ({ kind: 'write', path: file, content: 'mine\n', mode: 0o600 })],
    ['quarantine', (file: string): FixStep => ({ kind: 'quarantine', path: file })],
    ['symlink', (file: string): FixStep => ({ kind: 'symlink', path: file, target: '/usr/bin/true' })]
  ] as const)('%s stops at a planted FIFO without hanging', async (_name, step) => {
    const file = path.join(home, 'planted')
    plant('fifo', file)

    const outcome = await apply([step(file)])

    expect(outcome.error).toMatch(/refused/)
    expect(fs.lstatSync(file).isFIFO()).toBe(true)
    expectOutsideUntouched()
  })

  test('quarantine through a linked folder moves nothing of the user', async () => {
    fs.symlinkSync(outside, path.join(home, 'sub'))

    const outcome = await apply([{ kind: 'quarantine', path: path.join(home, 'sub', 'canary') }])

    expect(outcome.error).toMatch(/refused/)
    expectOutsideUntouched()
  })

  // A link at the far end has no pre-image to copy, so the backup does not stop this one: the step itself has to.
  test('quarantine through a linked folder does not move a link of the user', async () => {
    const owners = path.join(outside, 'owners-link')
    fs.symlinkSync(canary, owners)
    fs.symlinkSync(outside, path.join(home, 'sub'))

    const outcome = await apply([{ kind: 'quarantine', path: path.join(home, 'sub', 'owners-link') }])

    expect(outcome.error).toMatch(/refused/)
    expect(fs.readlinkSync(owners)).toBe(canary)
    expect(fs.readdirSync(outside).sort()).toEqual(['canary', 'owners-link'])
  })

  // An absent name has no pre-image either.
  test('symlink through a linked folder plants no new name there', async () => {
    fs.symlinkSync(outside, path.join(home, 'venv'))

    const outcome = await apply([{ kind: 'symlink', path: path.join(home, 'venv', 'python'), target: '/usr/bin/true' }])

    expect(outcome.error).toMatch(/refused/)
    expectOutsideUntouched()
  })

  test.each(['link', 'dangling'] as const)('quarantine moves a planted %s by its own name', async kind => {
    const file = path.join(home, 'state.db')
    plant(kind, file)

    const outcome = await apply([{ kind: 'quarantine', path: file }])

    expect(outcome.error).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
    expectOutsideUntouched()
  })

  test('symlink through a linked folder neither removes nor links anything of the user', async () => {
    fs.symlinkSync(outside, path.join(home, 'venv'))

    const outcome = await apply([{ kind: 'symlink', path: path.join(home, 'venv', 'canary'), target: '/usr/bin/true' }])

    expect(outcome.error).toMatch(/refused/)
    expect(fs.lstatSync(canary).isFile()).toBe(true)
    expectOutsideUntouched()
  })

  test.each(['link', 'dangling'] as const)('symlink replaces a planted %s', async kind => {
    const file = path.join(home, 'python')
    plant(kind, file)

    const outcome = await apply([{ kind: 'symlink', path: file, target: '/usr/bin/true' }])

    expect(outcome.error).toBeUndefined()
    expect(fs.readlinkSync(file)).toBe('/usr/bin/true')
    expectOutsideUntouched()
  })

  test.each(['link', 'dangling', 'fifo'] as const)('copy refuses a planted %s as its source', async kind => {
    const from = path.join(home, 'source')
    const to = path.join(home, 'copied')
    plant(kind, from)

    const outcome = await apply([{ kind: 'copy', from, to, mode: 0o600 }])

    expect(outcome.error).toMatch(/refused/)
    expect(fs.existsSync(to)).toBe(false)
    expectOutsideUntouched()
  })
})

describe('bootstrap paths', () => {
  test.each(['link', 'dangling'] as const)('the run log writes nothing through a %s logs folder', async kind => {
    fs.symlinkSync(kind === 'link' ? outside : path.join(outside, 'gone'), path.join(home, 'logs'))

    const { stream } = openRunLog(path.join(home, 'logs'), home)
    stream.end('secret line\n')
    await closed(stream)

    expectOutsideUntouched()
  })

  test('a FIFO named logs neither hangs the run log nor takes its lines', async () => {
    plant('fifo', path.join(home, 'logs'))

    const { stream } = openRunLog(path.join(home, 'logs'), home)
    stream.end('secret line\n')
    await closed(stream)

    expect(fs.lstatSync(path.join(home, 'logs')).isFIFO()).toBe(true)
  })

  test('a clean home gets its run log', async () => {
    const { path: logPath, stream } = openRunLog(path.join(home, 'logs'), home)
    stream.end('a line\n')
    await closed(stream)

    expect(fs.readFileSync(logPath, 'utf8')).toBe('a line\n')
  })

  test('the installer cache lives where the runtime is denied writes', () => {
    const [first] = path.relative(home, bootstrapCacheDir(home)).split(path.sep)

    expect(HERMES_HOME_NEVER_WRITTEN).toContain(first)
  })

  const installerScript = () => {
    const script = path.join(world, 'installer.sh')
    fs.writeFileSync(script, `: > "${path.join(world, 'installer-ran')}"\n`)

    return script
  }

  const installerRan = () => fs.existsSync(path.join(world, 'installer-ran'))

  test.each([
    ['link', '.env', ['--stage', 'config']],
    ['dangling', 'config.yaml', ['--stage', 'config']],
    ['fifo', '.env', ['--stage', 'config']],
    ['link', 'config.yaml', ['--skip-setup', '--non-interactive']]
  ] as const)('the installer never starts on a planted %s at %s (args %j)', async (kind, name, args) => {
    plant(kind, path.join(home, name))
    const lines: unknown[] = []

    const result = await spawnBash(installerScript(), [...args], { emit: ev => lines.push(ev), hermesHome: home })

    expect(result.code).toBe(78)
    expect(installerRan()).toBe(false)
    expect(JSON.stringify(lines)).toContain(name)
    expectOutsideUntouched()
  })

  test('the installer runs on plain seeds, and other stages are not judged', async () => {
    fs.writeFileSync(path.join(home, '.env'), 'A=1\n')
    expect((await spawnBash(installerScript(), ['--stage', 'config'], { hermesHome: home })).code).toBe(0)
    expect(installerRan()).toBe(true)
    fs.rmSync(path.join(world, 'installer-ran'))

    fs.rmSync(path.join(home, '.env'))
    plant('link', path.join(home, 'config.yaml'))
    expect((await spawnBash(installerScript(), ['--stage', 'python-deps'], { hermesHome: home })).code).toBe(0)
    expect(installerRan()).toBe(true)
    fs.rmSync(path.join(world, 'installer-ran'))
    expect((await spawnBash(installerScript(), ['--manifest'], { hermesHome: home })).code).toBe(0)
    expect(installerRan()).toBe(true)
  })

  test('a home that is itself a dangling link is refused like a planted seed, never thrown', async () => {
    const linkedHome = path.join(world, 'linked-home')
    fs.symlinkSync(path.join(outside, 'gone'), linkedHome)
    const lines: unknown[] = []

    const result = await spawnBash(installerScript(), ['--stage', 'config'], {
      emit: ev => lines.push(ev),
      hermesHome: linkedHome
    })

    expect(result.code).toBe(78)
    expect(installerRan()).toBe(false)
    expect(JSON.stringify(lines)).toContain('is a link or not a folder')
    expect(fs.existsSync(path.join(outside, 'gone'))).toBe(false)
  })

  test('the installer stage gets the arming variable', async () => {
    const script = path.join(world, 'print-env.sh')
    fs.writeFileSync(script, 'printf %s "$HERMES_HOME_NO_LINKS"\n')

    expect((await spawnBash(script, ['--stage', 'python-deps'], { hermesHome: home })).stdout).toBe('1')
  })
})

describe('unconfined Python helpers', () => {
  test('the doctor runs hermes config set armed against links', async () => {
    const venvDir = path.join(world, 'venv')
    fs.mkdirSync(path.join(venvDir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(venvDir, 'bin', 'python'), '', { mode: 0o755 })
    fs.writeFileSync(path.join(home, 'config.yaml'), 'updates:\n  check: true\n')

    const steps = await FIXES.updatesCheckOff({ ...doctorEnv(), venvDir })
    const exec = steps.find(step => step.kind === 'exec')

    expect(exec?.kind === 'exec' ? exec.env?.HERMES_HOME_NO_LINKS : undefined).toBe('1')
  })

  test('hermes config set is armed against links, sealed or not', async () => {
    const seen: NodeJS.ProcessEnv[] = []

    const run = async (_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      seen.push(opts.env)

      return { code: 0 }
    }

    const base = {
      exists: () => true,
      hermesBin: '/fake/hermes',
      hermesHome: home,
      log: () => {},
      markerFile: path.join(world, 'marker.json'),
      policy: 'curated',
      run,
      runtimeSha: 'a'.repeat(40),
      sha: 'a'.repeat(40)
    }

    await ensureCuratedRuntimeConfig(base as never)
    fs.rmSync(base.markerFile, { force: true })
    await ensureCuratedRuntimeConfig({
      ...base,
      sealed: { python: '/fake/py', sealEnv: (env: NodeJS.ProcessEnv) => env }
    } as never)

    expect(seen.map(env => env.HERMES_HOME_NO_LINKS)).toEqual(['1', '1'])
  })
})
