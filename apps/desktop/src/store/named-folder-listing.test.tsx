/** fx26b: the real renderer path into main's real handlers. A path the runtime answered never reaches the listing; a
 *  folder picked in the app stays listed from main's own record across a quit, without a click. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { projectTreeCwd } from '@/app/chat/sidebar/projects/model'
import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { folderToOffer } from '@/app/home/containers/containers-data'
import { FIXTURE_NARROWED, FIXTURE_RUNS } from '@/app/home/containers/containers-fixtures'
import { applyStoredSessionPreviewRuntimeInfo } from '@/app/session/hooks/use-session-actions/utils'
import { confinement } from '@/i18n/en/confinement'
import { $notifications, clearNotifications } from '@/store/notifications'
import { openFolderAsProject, pickProjectFolder } from '@/store/projects'
import { setCurrentCwd, setCurrentCwdTransient } from '@/store/session'

import type { LauncherPolicyBody } from '../../electron/iclone-confinement/launcher-policy'
import { CLICK, launchMain } from '../../electron/iclone-permissions/ipc.test-helpers'

const launcherBodies = vi.hoisted((): LauncherPolicyBody[] => [])

vi.mock('../../electron/iclone-confinement', async importOriginal => ({
  ...(await importOriginal<object>()),
  currentConfinement: () => ({
    publishLauncherPolicy: (body: LauncherPolicyBody) => launcherBodies.push(body)
  })
}))

let dir = ''

const folder = (name: string) => {
  const made = path.join(dir, name)

  mkdirSync(made, { recursive: true })

  return made
}

/** What the preload exposes, onto main's handlers. The spies say whether the renderer asked at all. */
const wire = (main: ReturnType<typeof launchMain>) => {
  const noteFolder = vi.fn(async (folderPath: string, source: 'drag' | 'typed') => {
    const answer = await main.invoke('hermes:confinement:note-folder', { folder: folderPath, source, gesture: CLICK })

    return { ok: answer.ok === true, message: typeof answer.message === 'string' ? answer.message : undefined }
  })

  const pick = vi.fn(async (options?: { defaultPath?: string; profile?: string }) => {
    const answer = await main.invoke('hermes:confinement:pick-project-folder', { ...options, gesture: CLICK })

    return { path: typeof answer.path === 'string' ? answer.path : null, listed: answer.listed === true }
  })

  Object.assign(window, { hermesDesktop: { noteFolder, pickProjectFolder: pick } })

  return noteFolder
}

const launch = (answer: string[] = []) => {
  const main = launchMain(dir, launcherBodies, () => answer)

  return { main, noteFolder: wire(main) }
}

beforeEach(() => {
  launcherBodies.length = 0
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-named-folder-')))
  mkdirSync(path.join(dir, 'home'), { recursive: true })
})

afterEach(() => {
  Object.assign(window, { hermesDesktop: undefined })
  setCurrentCwdTransient('')
  clearNotifications()
  rmSync(dir, { recursive: true, force: true })
})

describe('a path the runtime answered', () => {
  it('a session row cwd asks main for nothing, on resume or at the next click or key', () => {
    const { main, noteFolder } = launch()
    const forged = folder('taxes')

    applyStoredSessionPreviewRuntimeInfo({ cwd: forged, model: 'x' }, 'forged-row')
    window.dispatchEvent(new MouseEvent('click'))
    window.dispatchEvent(new KeyboardEvent('keydown'))

    expect(noteFolder).not.toHaveBeenCalled()
    expect(main.authority.state().mode.folders ?? []).toEqual([])
  })

  it('moving the workspace, by either setter, lists nothing: sidebar sync, boot seed, workspace target', () => {
    const { noteFolder } = launch()

    setCurrentCwd(folder('from-the-tree'))
    setCurrentCwdTransient(folder('from-the-gateway'))

    expect(noteFolder).not.toHaveBeenCalled()
  })

  /** fx27 (F2 major 1): the sidebar's project entries are the gateway's `projects.tree` answer (store/projects.ts
   *  refreshProjectTreeOn), so a click on one is a move of the view through the real `syncProjectCwd` path:
   *  projectTreeCwd -> setCurrentCwd. Nothing reaches main, and main refuses a 'project' source by name. */
  it('a project clicked in the sidebar came from the gateway tree: the click moves the view and lists nothing', async () => {
    const { main, noteFolder } = launch()
    const entry: SidebarProjectTree = { id: 'p1', label: 'taxes', path: folder('tree-project'), repos: [], sessionCount: 0 }
    const target = projectTreeCwd(entry)

    expect(target).toBe(entry.path)
    setCurrentCwd(target ?? '')

    expect(noteFolder).not.toHaveBeenCalled()
    expect(main.listedForLauncher()).toEqual([])
    expect(
      await main.invoke('hermes:confinement:note-folder', { folder: entry.path, source: 'project', gesture: CLICK })
    ).toMatchObject({ ok: false, error: 'source' })

    const sidebar = ['chat/sidebar/use-sidebar-project-model.ts', 'session/hooks/use-session-actions/index.ts', 'session/hooks/use-cwd-actions.ts']

    for (const file of sidebar) {
      expect(readFileSync(path.join(__dirname, '..', 'app', file), 'utf8')).not.toMatch('noteNamedFolder')
    }
  })
})

describe('the ordinary day, on the real store', () => {
  it('open a folder, quit, reopen, resume: listed for the launcher with no new click', async () => {
    const opened = folder('project')

    const first = launch([opened])

    expect(await pickProjectFolder()).toBe(opened)
    expect(first.main.listedForLauncher()).toContain(opened)

    const second = launch()

    second.main.authority.publish()
    applyStoredSessionPreviewRuntimeInfo({ cwd: opened, model: 'x' }, 'resumed')

    expect(second.noteFolder).not.toHaveBeenCalled()
    expect(second.main.listedForLauncher()).toContain(opened)
  })

  it('a session from before this version is not listed on resume; its narrowed row offers Allow this folder; one click lists it, kept after a quit', async () => {
    const older = folder('older')

    const first = launch()

    first.main.authority.publish()
    applyStoredSessionPreviewRuntimeInfo({ cwd: older, model: 'x' }, 'older-session')
    expect(first.main.listedForLauncher()).not.toContain(older)

    // The row the launcher writes for a run in an unlisted folder (narrowedWhy 'unlisted-folder') is what offers the
    // button; the narrowing itself is the launcher's identity check (launcher.py, its own tests), not exercised here.
    const row = { ...FIXTURE_NARROWED.unlisted, cwd: older, projectRoot: older }

    expect(folderToOffer(row, [row])).toBe(older)

    expect(await first.main.invoke('hermes:confinement:allow-folder', { folder: older, gesture: CLICK })).toMatchObject({
      ok: true
    })

    const reopened = launch().main

    reopened.authority.publish()
    expect(reopened.listedForLauncher()).toContain(older)
  })

  it('a path typed in the palette is listed, with its source', async () => {
    const { main, noteFolder } = launch()
    const typed = folder('typed')

    await openFolderAsProject(typed).catch(() => undefined)

    expect(noteFolder).toHaveBeenCalledWith(typed, 'typed')
    await vi.waitFor(() => expect(main.listedForLauncher()).toContain(typed))
  })

  /** fx27 (F2 major 3): the daily spelling, with the trailing slash tab completion types, lists the folder it names. */
  it('a path typed with a trailing slash is listed as the folder it names, with no warning', async () => {
    const { main } = launch()
    const typed = folder('typed-slash')

    await openFolderAsProject(`${typed}/`).catch(() => undefined)

    await vi.waitFor(() => expect(main.listedForLauncher()).toContain(typed))
    expect($notifications.get().filter(item => item.title === `${typed}/`)).toEqual([])
  })

  it('a typed path main refuses opens all the same, and main\'s refusal is shown, in main\'s words', async () => {
    const { main } = launch()
    const refused = path.join(main.home, 'Library', 'Caches')

    mkdirSync(refused, { recursive: true })
    await openFolderAsProject(refused).catch(() => undefined)

    await vi.waitFor(() => expect($notifications.get().map(item => item.message)).toContain('Folders of the app and of macOS cannot be a project.'))
    expect(main.listedForLauncher()).not.toContain(refused)
  })
})

describe('the words', () => {
  it('the narrowed reason, word for word, states folderToOffer\'s condition: offered until a later command there had project writes', () => {
    expect(confinement.ledger.why['narrowed-unlisted-folder']('runtime')).toBe(
      'This command had no project writes: this folder is not listed now. It was not opened with Open folder…, typed in the palette or listed with Allow this folder, and no allow for it was in effect. Until a later command there has project writes, this command’s details offer Allow this folder.'
    )

    const older = FIXTURE_NARROWED.unlistedOlder
    const later = { ...FIXTURE_RUNS.exited, cwd: older.cwd, projectRoot: older.projectRoot, writeProject: true, startedAt: new Date(Date.parse(older.startedAt) + 1000).toISOString() }

    expect(folderToOffer(older, [older])).toBe(older.projectRoot)
    expect(folderToOffer(older, [older, later])).toBeNull()
  })
})
