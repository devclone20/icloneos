/**
 * V3-RT M2 (critic r1, ruling 36): a packaged app describes and watches ITS OWN runtime (`<userData>/hermes-runtime/
 * <sha>`) and never runs git — or reads git state — in the user's `~/.hermes/hermes-agent`. Fixture: a temp home whose
 * `.hermes/hermes-agent` is a real git checkout with an untracked file; every entry is snapshotted before and after.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runtimeHead } from './iclone-compat/runtime-git'
import { managedStampFor, writeManagedStamp } from './iclone-managed-runtime'
import { readRuntimeStatus } from './iclone-updates'

let tmp = ''
let home = ''
let legacy = ''
let managed = ''

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name)
    const st = fs.lstatSync(file)

    out[path.relative(dir, file)] =
      `${st.mode} ${st.size} ${st.mtimeMs} ${entry.isFile() ? fs.readFileSync(file).toString('base64') : ''}`
  }

  out['.'] = String(fs.lstatSync(dir).mtimeMs)

  return out
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-m2-')))
  home = path.join(tmp, '.hermes')
  legacy = path.join(home, 'hermes-agent')
  fs.mkdirSync(path.join(legacy, 'hermes_cli'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'hermes_cli', '__init__.py'), '# 0.0.2\n')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', legacy, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
      env,
      stdio: 'ignore'
    })

  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'legacy')
  fs.writeFileSync(path.join(legacy, '.env.owner'), 'untracked\n')
  managed = path.join(tmp, 'ud', 'hermes-runtime', 'abc')
  fs.mkdirSync(managed, { recursive: true })
  writeManagedStamp(
    managed,
    managedStampFor({ appVersion: '0.0.3', lockHash: 'f'.repeat(64), runtimeSha: 'a'.repeat(40) })
  )
})

afterAll(() => fs.rmSync(tmp, { force: true, recursive: true }))

describe('M2: Updates and About describe the app runtime, never the user checkout', () => {
  it('readRuntimeStatus (packaged): the managed root from its stamp; the checkout byte-for-byte as it was', async () => {
    const before = snapshot(legacy)
    const status = await readRuntimeStatus({ home, managedRoot: managed, packaged: true, sourceRoot: '/nowhere' })

    expect(status).toMatchObject({
      available: true,
      dirty: false,
      head: { sha: 'a'.repeat(40) },
      runtimeRoot: managed,
      unmanaged: false,
      updaterRoot: managed,
      updaterRootIsRuntime: true
    })
    expect(snapshot(legacy)).toEqual(before)
    expect(fs.existsSync(path.join(legacy, '.git', 'index.lock'))).toBe(false)
  })

  it('the compat guard reads the managed head from the stamp (no .git there)', () => {
    expect(runtimeHead(managed)).toBe('a'.repeat(40))
  })

  it('main wires the managed root into Settings, About, the agent pane and the compat engine; update git is bounded', () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8')

    expect(read('iclone-updates.ts')).toContain(
      "...(packaged ? { managedRoot: appRuntimeRoot(app.getPath('userData')) } : {}),"
    )
    expect(read('main/agent-update.ts')).toContain(
      "...(IS_PACKAGED ? { managedRoot: appRuntimeRoot(app.getPath('userData')) } : {}),"
    )
    expect(read('iclone-compat.ts')).toContain(
      "runtimeDir: app.isPackaged ? appRuntimeRoot(app.getPath('userData')) : path.join(runtimeHome(), 'hermes-agent'),"
    )

    const updates = read('main/updates.ts')

    expect(updates).not.toContain('{ cwd: updateRoot }')
    expect(updates).toContain("GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)), GIT_OPTIONAL_LOCKS: '0'")
  })
})
