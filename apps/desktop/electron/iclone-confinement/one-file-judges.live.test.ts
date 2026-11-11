/**
 * G23, the owner's ruling: the launcher's judge, read in Python against the real spec main generates, and the kernel profile
 * that spec comes from, which the ruling leaves as it was for commands no one allowed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { pluginSpec } from './backend-seatbelt'
import { isThrowawayHome } from './live-guards'
import { createLiveWorld } from './live-harness'
import { realOrSelf } from './profiles'
import { launcherLedgerDir } from './runtime-profile'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const PY = process.env.V3G_PY ?? path.join(REPO, 'venv/bin/python')

const JUDGE = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("c", sys.argv[1])
core = importlib.util.module_from_spec(spec)
sys.modules["c"] = core
spec.loader.exec_module(core)
index = core.parse_spec(sys.argv[2])
print(json.dumps([core.one_file_refusal(index, p) for p in json.loads(sys.argv[3])]))`

describe.runIf(process.platform === 'darwin' && existsSync(PY) && isThrowawayHome(realOrSelf(os.homedir())))('G23: both sides of one Allow', () => {
  const world = createLiveWorld()
  const home = realOrSelf(os.homedir())

  afterAll(() => world.dispose())

  const refusals = (rels: string[]): (string | null)[] =>
    JSON.parse(
      execFileSync(
        PY,
        [
          '-c',
          JUDGE,
          path.join(REPO, 'plugins/iclone-confinement/core.py'),
          pluginSpec(world.paths, world.profiles),
          JSON.stringify(rels.map(rel => path.join(home, rel)))
        ],
        { encoding: 'utf8' }
      )
    )

  const refusalAt = (absolute: string) => refusals([path.relative(home, absolute)])[0]

  it('the owner: the launcher takes every held kind on the real spec, and refuses this app\'s own files', () => {
    const open = [
      '.zshrc',
      '.gitconfig',
      '.ssh/config',
      '.aws/credentials',
      '.pgpass',
      'Library/LaunchAgents/x.plist',
      'Library/Application Support/Google/Chrome/Default/Login Data',
      'Library/Safari/Bookmarks.plist',
      'Library/Caches/pip/d/x',
      'notes.txt'
    ]

    expect(refusals(open)).toEqual(open.map(() => null))
    expect(refusalAt(path.join(realOrSelf(world.paths.userDataDir), 'consent.json'))).toBeTruthy()
    expect(refusalAt(path.join(realOrSelf(world.paths.hermesHome), 'plugins/x.py'))).toBeTruthy()
  })

  it('a confined command cannot forge a row or the runtime\'s acknowledgement', async () => {
    const ledger = launcherLedgerDir(world.paths.userDataDir)

    mkdirSync(ledger, { recursive: true })

    const rows = path.join(ledger, 'oneshots.jsonl')
    const ack = path.join(world.paths.userDataDir, 'confinement', 'hermes-ack.1.json')
    const forged = await world.runConfined(`printf forged >> "${rows}"`, { cls: 'build' })
    const forgedAck = await world.runConfined(`printf forged > "${ack}"`, { cls: 'build' })

    expect(forged.code).not.toBe(0)
    expect(existsSync(rows)).toBe(false)
    expect(forgedAck.code).not.toBe(0)
    expect(existsSync(ack)).toBe(false)
  })

  it('G23-W2, measured: every class of confined command is refused a read anywhere in the home outside its project, .zshrc too', async () => {
    const rels = ['.zshrc', 'notes.txt', 'Documents/x', '.ssh/config']

    for (const rel of rels) {
      mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
      writeFileSync(path.join(home, rel), 'real')
    }

    for (const cls of ['research', 'project', 'build', 'offline', 'media'] as const) {
      for (const rel of rels) {
        expect((await world.runConfined(`/usr/bin/base64 < "${path.join(home, rel)}"`, { cls })).code).toBe(1)
      }
    }
  })

  it('the kernel profile is as it was: a build command never writes a held file, and keeps its cache and its project', async () => {
    const chrome = path.join(home, 'Library/Application Support/Google/Chrome/Default')
    const pip = path.join(home, 'Library/Caches/pip')
    const zshrc = path.join(home, '.zshrc')

    mkdirSync(chrome, { recursive: true })
    mkdirSync(pip, { recursive: true })
    writeFileSync(path.join(chrome, 'Login Data'), 'real')
    writeFileSync(zshrc, 'real')

    const refused = await world.runConfined(`printf owned > "${chrome}/Login Data"`, { cls: 'build' })
    const shell = await world.runConfined(`printf owned > "${zshrc}"`, { cls: 'build' })
    const cache = await world.runConfined(`printf ok > "${pip}/from-build"`, { cls: 'build' })
    const project = await world.runConfined('printf ok > from-build', { cls: 'build' })

    expect(refused.code).not.toBe(0)
    expect(shell.code).not.toBe(0)
    expect(readFileSync(path.join(chrome, 'Login Data'), 'utf8')).toBe('real')
    expect(readFileSync(zshrc, 'utf8')).toBe('real')
    expect(cache.code).toBe(0)
    expect(project.code).toBe(0)
    expect(readFileSync(path.join(world.project, 'from-build'), 'utf8')).toBe('ok')
  })
})
