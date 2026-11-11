/** fx20 (lens5 H1, H2, m5, m6): the folder list through the real handlers, and what an ask may name to the user. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createLauncherPolicyMirror, type LauncherPolicyBody } from '../iclone-confinement/launcher-policy'

import type * as authorityModule from './authority'
import { askedFolder, registerPermissions } from './ipc'

type AuthorityDeps = Parameters<typeof authorityModule.createPermissionAuthority>[0]

const seen = vi.hoisted(() => ({ deps: null as unknown, bodies: [] as unknown[] }))

vi.mock('./authority', async original => {
  const real = await original<typeof authorityModule>()

  return {
    ...real,
    createPermissionAuthority: (deps: AuthorityDeps) => {
      seen.deps = deps

      return real.createPermissionAuthority({
        ...deps,
        signer: {
          ...deps.signer,
          publish: (body: unknown) => {
            seen.bodies.push(body)

            return (deps.signer.publish as (b: unknown) => unknown)(body)
          }
        } as AuthorityDeps['signer']
      })
    }
  }
})

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-folders-')))
const home = path.join(dir, 'home')
const userDataDir = path.join(dir, 'ud')

for (const folder of [home, userDataDir]) {
  mkdirSync(folder, { recursive: true })
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Handler = (event: unknown, input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>

const sealed = new Map<string, string>()

function launch() {
  const handlers = new Map<string, Handler>()

  const authority = registerPermissions({
    ipcMain: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    isTrustedSender: () => true,
    userDataDir,
    paths: { hermesHome: path.join(dir, 'hermes'), home, hermesRoot: null },
    door: null,
    consent: () => null,
    lastInputAt: () => Date.now(),
    sealer: {
      seal: (plain: string) => {
        sealed.set('t', plain)

        return 't'
      },
      unseal: (token: string) => sealed.get(token) ?? ''
    },
    confirmIgnore: async () => false
  } as unknown as Parameters<typeof registerPermissions>[0])

  return { authority, handlers }
}

const { authority, handlers } = launch()
const CLICK = { activation: true, confirm: true }
const call = (channel: string, input: Record<string, unknown>) => handlers.get(channel)!({}, input)
const allow = (folder: unknown) => call('hermes:confinement:allow-folder', { folder, gesture: CLICK })
const remove = (folder: unknown, gesture: unknown = CLICK) => call('iclone:permissions:remove-folder', { folder, gesture })
const setStanding = (mode: string) => call('iclone:permissions:set-mode', { scope: 'standing', mode, gesture: CLICK })

const project = (name: string) => {
  const folder = path.join(dir, name)

  mkdirSync(folder, { recursive: true })

  return folder
}

const never = { home, userDataDir }

describe('H1: "Allow this folder" stores no mode', () => {
  it('automatic, allow, lower to plan: the folder has no mode row, and main still lists it for the launcher', async () => {
    const folder = project('h1')

    await setStanding('automatic')
    expect(authority.state().sealed).toBe(true)
    expect(await allow(folder)).toMatchObject({ ok: true, next: 'writes' })
    await setStanding('plan')

    const { mode } = authority.state()

    expect(mode.standing).toBe('plan')
    expect(mode.projects).toEqual({})
    expect(mode.folders).toContain(folder)

    // What the launcher reads: the widest mode is Plan, whatever the list holds.
    const ledger = project('h1-ledger')
    const mirror = createLauncherPolicyMirror(ledger, () => {})
    const body = seen.bodies.at(-1) as LauncherPolicyBody

    mirror.publish(body)

    const policy = JSON.parse(readFileSync(mirror.file, 'utf8')) as { projects: string[]; body: LauncherPolicyBody }

    expect(policy.projects).toContain(folder)
    expect(policy.body.standing).toBe('plan')
    expect(policy.body.projects).toEqual({})
    expect(policy.body.folders).toContain(folder)
    await setStanding('manual')
  })

  it('no click: the handler refuses by itself and never reaches setMode, with a click neither', async () => {
    const spy = vi.spyOn(authority, 'setMode')
    const folder = project('h1-no-gesture')

    expect(await call('hermes:confinement:allow-folder', { folder })).toMatchObject({ ok: false, error: 'gesture' })
    expect(authority.state().mode.folders ?? []).not.toContain(folder)
    expect(await allow(folder)).toMatchObject({ ok: true })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('the list persists across a restart; Remove takes it off, by a click, only what the list holds', async () => {
    const folder = project('h1-persist')

    await allow(folder)

    const again = launch()

    expect(again.authority.state().mode.folders).toContain(folder)
    expect(await remove(folder, null)).toMatchObject({ ok: false, error: 'gesture' })
    expect(authority.state().mode.folders).toContain(folder)
    expect(await remove(project('never-listed'))).toMatchObject({ ok: false, error: 'invalid' })
    expect(await remove(folder)).toEqual({ ok: true })
    expect(authority.state().mode.folders).not.toContain(folder)
    expect((seen.bodies.at(-1) as LauncherPolicyBody).folders).not.toContain(folder)
  })
})

describe('H2: the folder an ask may name', () => {
  it('its own spelling is named; a link, the home, the app data and a .git name nothing', () => {
    const real = project('h2-real')
    const link = path.join(dir, 'h2-link')

    symlinkSync(real, link)
    expect(askedFolder(real, never)?.project).toBe(real)
    expect(askedFolder(real, never)?.same()).toBe(true)

    for (const value of [link, home, userDataDir, project('h2/.git'), path.join(dir, 'gone'), null]) {
      expect(askedFolder(value, never), String(value)).toBeNull()
    }
  })

  it('a folder replaced while the sheet is up is not the folder it showed, by identity, at the same path', () => {
    const real = project('h2-replaced')
    const asked = askedFolder(real, never)!

    renameSync(real, `${real}-old`)
    mkdirSync(real)
    expect(asked.same()).toBe(false)
  })

  it('a link put in its place while the sheet is up is not the folder it showed', () => {
    const real = project('h2-swapped')
    const decoy = project('h2-decoy')
    const asked = askedFolder(real, never)!

    renameSync(real, `${real}-old`)
    symlinkSync(decoy, real)
    expect(asked.same()).toBe(false)
    unlinkSync(real)
  })

  it('registerPermissions gives the authority exactly this judge, with the app data in its never list', () => {
    const { askFolder } = seen.deps as Required<AuthorityDeps>

    expect(askFolder(project('h2-wired'))?.project).toBe(path.join(dir, 'h2-wired'))
    expect(askFolder(userDataDir)).toBeNull()
  })
})

describe('m5: the pane\'s project goes through main', () => {
  it('a project mode for a folder the rules refuse writes no row, and the state offers no such project', async () => {
    const real = project('m5-real')
    const link = path.join(dir, 'm5-link')

    symlinkSync(real, link)

    for (const key of [home, link, userDataDir, 'relative']) {
      const answer = await call('iclone:permissions:set-mode', { scope: 'project', key, mode: 'manual', gesture: CLICK })

      expect(answer, key).toMatchObject({ ok: false, error: 'invalid' })
    }

    expect(authority.state().mode.projects).toEqual({})
    expect(await call('iclone:permissions:state', { dir: userDataDir })).toMatchObject({ project: null })
    expect(await call('iclone:permissions:state', { dir: real })).toMatchObject({ project: real })
    expect(
      await call('iclone:permissions:set-mode', { scope: 'project', key: real, mode: 'manual', gesture: CLICK })
    ).toMatchObject({ ok: true })
    expect(authority.state().mode.projects[real]).toBe('manual')
  })
})
