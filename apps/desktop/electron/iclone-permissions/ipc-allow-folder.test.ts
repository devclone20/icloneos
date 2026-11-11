/** fx16: "Allow this folder" through the real handler, the answer the Containers pane reads, and the store it writes. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { allowNext, registerPermissions } from './ipc'

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-allow-folder-')))
const home = path.join(dir, 'home')
const userDataDir = path.join(dir, 'ud')

for (const folder of [home, userDataDir]) {
  mkdirSync(folder, { recursive: true })
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Handler = (event: unknown, input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>

const handlers = new Map<string, Handler>()
const sealed = new Map<string, string>()
let lastInputAt = 0
let trusted = true

const authority = registerPermissions({
  ipcMain: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
  isTrustedSender: () => trusted,
  userDataDir,
  paths: { hermesHome: path.join(dir, 'hermes'), home, hermesRoot: null },
  door: null,
  consent: () => null,
  lastInputAt: () => lastInputAt,
  sealer: {
    seal: (plain: string) => {
      sealed.set('t', plain)

      return 't'
    },
    unseal: (token: string) => sealed.get(token) ?? ''
  },
  confirmIgnore: async () => false
} as unknown as Parameters<typeof registerPermissions>[0])

const CLICK = { activation: true, confirm: true }

/** What the preload sends, right after real input reached the window; `input` replaces any part of it. */
const allow = (folder: unknown, input: Record<string, unknown> = {}, inputAgoMs = 0) => {
  lastInputAt = Date.now() - inputAgoMs

  return handlers.get('hermes:confinement:allow-folder')!({}, { folder, gesture: CLICK, ...input })
}

const project = (name: string) => {
  const folder = path.join(dir, name)

  mkdirSync(folder, { recursive: true })

  return folder
}

/** fx20 (lens5 H1): the store's folder list, as a map from each folder to true; modes are `projects`, and stay apart. */
const listed = () =>
  Object.fromEntries((authority.state().mode.folders ?? []).map(folder => [folder, true])) as Record<string, boolean>

describe('hermes:confinement:allow-folder', () => {
  it('a valid folder, on a click: answers exactly what the pane reads as success, and the store lists that folder', async () => {
    const folder = project('valid')

    expect(listed()[folder]).toBeUndefined()

    const answer = await allow(folder)

    expect(answer.ok).toBe(true)
    expect(listed()[folder]).toBe(true)
    expect(authority.state().mode.projects[folder]).toBeUndefined()
  })

  it.each([
    ['not a string', 7],
    ['nothing', undefined],
    ['a relative path', 'some/folder'],
    ['a NUL byte', '/tmp/a\0b']
  ])('invalid input (%s): ok false, nothing listed', async (_name, value) => {
    const before = listed()
    const answer = await allow(value)

    expect(answer).toMatchObject({ ok: false, error: 'invalid' })
    expect(listed()).toEqual(before)
  })

  it('a folder that does not exist, a link to one, the home, the app data and a .git are refused and not listed', async () => {
    const real = project('real-target')
    const link = path.join(dir, 'a-link')

    symlinkSync(real, link)

    const before = listed()

    for (const value of [path.join(dir, 'gone'), link, home, '/', userDataDir, project('r/.git')]) {
      expect(await allow(value), String(value)).toMatchObject({ ok: false, error: 'invalid' })
    }

    expect(listed()).toEqual(before)
  })

  it.each([
    ['no gesture at all', { gesture: undefined }, 0],
    ['no user activation', { gesture: { activation: false, confirm: true } }, 0],
    ['no click on the marked control', { gesture: { activation: true, confirm: false } }, 0],
    ['a renderer that claims true', { gesture: true }, 0],
    ['flags right, but main saw no real input in the window', {}, 60_000]
  ])('%s: refused as a gesture refusal, nothing listed', async (_name, input, ago) => {
    const folder = project(`no-gesture-${Math.random().toString(36).slice(2)}`)
    const answer = await allow(folder, input, ago)

    expect(answer).toMatchObject({ ok: false, error: 'gesture' })
    expect(listed()[folder]).toBeUndefined()
  })

  it('with no click, a folder that does not exist gets the same answer as one that does', async () => {
    const answers = await Promise.all([
      allow(project('there'), { gesture: undefined }),
      allow(path.join(dir, 'not-there'), { gesture: undefined })
    ])

    expect(answers[0]).toEqual(answers[1])
  })

  it('a folder with a mode of its own keeps it: the button never widens what the user set', async () => {
    const folder = project('own-mode')

    lastInputAt = Date.now()
    await authority.setMode({ scope: 'project', key: folder, mode: 'plan' }, true)
    expect(authority.state().mode.projects[folder]).toBe('plan')

    const answer = (await allow(folder)) as { ok: boolean; next?: string }

    expect(answer.ok).toBe(true)
    expect(answer.next).toBe('plan')
    expect(authority.state().mode.projects[folder]).toBe('plan')
    expect(listed()[folder]).toBe(true)
  })

  it('fx19: main says the next step: Manual and any unsealed run ask, only a mode that writes says it writes', async () => {
    const answer = (await allow(project('next-manual'))) as { ok: boolean; next?: string }

    expect(answer.next).toBe('asks')
    expect(allowNext(true, 'manual')).toBe('asks')
    expect(allowNext(true, 'plan')).toBe('plan')
    expect(allowNext(true, 'automatic')).toBe('writes')
    expect(allowNext(true, 'acceptEdits')).toBe('writes')
    expect(allowNext(false, 'automatic')).toBe('asks')
    expect(allowNext(false, 'plan')).toBe('asks')
  })

  it('an untrusted sender is refused before the handler runs', async () => {
    const folder = project('untrusted')

    trusted = false

    try {
      await Promise.resolve(allow(folder)).catch(() => undefined)
    } finally {
      trusted = true
    }

    expect(listed()[folder]).toBeUndefined()
  })
})
