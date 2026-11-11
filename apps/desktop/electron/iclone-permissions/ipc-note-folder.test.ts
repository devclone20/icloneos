/** fx26b: the named sources, each through its real route; every other source lists nothing. fx27: a trailing slash or
 *  a `..` is the user's spelling of the folder it names; another case or Unicode form, a link, are not (F1 medium 1, 4). */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import type { LauncherPolicyBody } from '../iclone-confinement/launcher-policy'
import { acceptableProjectRoot, execOnBehalfWrites, projectRootRefusal } from '../iclone-confinement/profiles'

import { askedFolder, listDefaultFolder, NAMED_FOLDER_SOURCES } from './ipc'
import { CLICK, launchMain } from './ipc.test-helpers'

const launcherBodies = vi.hoisted((): LauncherPolicyBody[] => [])

vi.mock('../iclone-confinement', async importOriginal => ({
  ...(await importOriginal<object>()),
  currentConfinement: () => ({
    publishLauncherPolicy: (body: LauncherPolicyBody) => launcherBodies.push(body)
  })
}))

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-note-folder-')))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

let dialogAnswer: string[] = []
let dialogsOpened = 0
// How long ago main saw real input reach the window, the time the gesture check of the real handlers reads.
let inputAgoMs = 0

const main = launchMain(
  dir,
  launcherBodies,
  () => {
    dialogsOpened += 1

    return dialogAnswer
  },
  () => Date.now() - inputAgoMs
)

const never = { home: main.home, userDataDir: main.userDataDir }
const NOTE = 'hermes:confinement:note-folder'

mkdirSync(main.home, { recursive: true })
mkdirSync(main.userDataDir, { recursive: true })

const made = (...parts: string[]) => {
  const folder = path.join(dir, ...parts)

  mkdirSync(folder, { recursive: true })

  return folder
}

const listed = (folder: unknown) => main.authority.state().mode.folders?.includes(String(folder)) === true

/** Each source through its real route; the answer is whether the route took the folder. */
const SOURCES: Record<string, (folder: string) => Promise<boolean>> = {
  picker: async folder => {
    dialogAnswer = [folder]
    await main.invoke('hermes:confinement:pick-project-folder', { gesture: CLICK })

    return listed(folder)
  },
  typed: async folder => (await main.invoke(NOTE, { folder, source: 'typed', gesture: CLICK })).ok === true,
  drag: async folder => (await main.invoke(NOTE, { folder, source: 'drag', gesture: CLICK })).ok === true,
  allow: async folder => (await main.invoke('hermes:confinement:allow-folder', { folder, gesture: CLICK })).ok === true,
  ask: async folder => askedFolder(folder, never) !== null,
  'default-folder': async folder => listDefaultFolder(folder, never) !== null
}

const swapCase = (name: string) => name.replace(/[a-z]/i, letter => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()))

/** The last segment in another case: on APFS the same folder (same dev/ino), never its own spelling. */
const otherCase = (folder: string) => path.join(path.dirname(folder), swapCase(path.basename(folder)))

const SPELLINGS: Record<string, (name: string) => string> = {
  'another spelling, a link': name => {
    const link = path.join(dir, `link-${name}`)

    symlinkSync(made('target', name), link)

    return link
  },
  'a relative path': name => `relative/${name}`,
  'a missing folder': name => path.join(dir, 'missing', name),
  'another case of a folder': name => otherCase(made('case', name)),
  'the NFD form of a folder': name => made('nfd', `${name}-caf\u00e9`).normalize('NFD'),
  'the home folder': () => main.home,
  'the home folder in another case': () => otherCase(main.home),
  'under ~/Library in another case': name => path.join(otherCase(made('home', 'Library')), name),
  'above the home folder': () => dir,
  'the root': () => '/',
  'under ~/Library': name => made('home', 'Library', name),
  'the app data': () => main.userDataDir,
  'a .git': name => made('repo', name, '.git')
}

/** fx27: spellings that name the folder itself; each is taken as the folder's own path (what tab completion types). */
const OWN_SPELLINGS: Record<string, (folder: string) => string> = {
  'a trailing slash': folder => `${folder}/`,
  'a dot-dot': folder => `${folder}/../${path.basename(folder)}`,
  'a double separator': folder => folder.replace(path.sep, `${path.sep}${path.sep}`)
}

describe('the named sources, by spelling, at main', () => {
  it('the table names every source main has, and no route lists a folder outside it', () => {
    expect(Object.keys(SOURCES).sort()).toEqual(['allow', 'ask', 'default-folder', 'picker', ...NAMED_FOLDER_SOURCES].sort())
  })

  for (const [source, name] of Object.entries(SOURCES)) {
    it(`${source}: a folder by its own path is taken`, async () => {
      expect(await name(made('own', source))).toBe(true)
    })

    // The picker carries main's own dialog answer, never a spelling; an ask lists a pass, so it is pinned below.
    for (const [spelling, spell] of Object.entries(OWN_SPELLINGS)) {
      if (source === 'picker' || source === 'ask') {
        continue
      }

      it(`${source}: ${spelling} is taken as the folder it names`, async () => {
        const folder = made('ownspell', source, spelling.replace(/\W/g, ''))

        expect(await name(spell(folder))).toBe(true)
        expect(main.listedForLauncher()).toContain(folder)
      })
    }

    for (const [spelling, spell] of Object.entries(SPELLINGS)) {
      it(`${source}: ${spelling} is refused and listed nowhere`, async () => {
        const value = spell(source)

        // The default folder is re-judged at each start: a refused setting also drops the one listed before.
        if (source === 'default-folder') {
          listDefaultFolder(path.join(dir, 'missing', 'reset'), never)
        }

        const before = main.listedForLauncher()

        expect(await name(value)).toBe(false)
        expect(main.listedForLauncher()).toEqual(before)
        expect(main.listedForLauncher()).not.toContain(value)
      })
    }
  }
})

describe('an ask names the folder the sheet shows, by its own path', () => {
  for (const [spelling, spell] of Object.entries(OWN_SPELLINGS)) {
    it(`ask: ${spelling} names the folder it spells`, () => {
      const folder = made('askspell', spelling.replace(/\W/g, ''))

      expect(askedFolder(spell(folder), never)?.project).toBe(folder)
    })
  }
})

describe('every other source lists nothing', () => {
  for (const source of ['session-row', 'gateway', 'stored-cwd', 'project', 'default-folder', 'picker', 'allow', 'ask', '', 7, undefined]) {
    it(`note-folder from ${String(source) || 'an empty name'} is refused`, async () => {
      const folder = made('other', String(source) || 'empty')

      expect(await main.invoke(NOTE, { folder, source, gesture: CLICK })).toMatchObject({ ok: false, error: 'source' })
      expect(listed(folder)).toBe(false)
    })
  }

  it('without a gesture a typed path is not listed', async () => {
    const folder = made('no-gesture')

    for (const gesture of [{ activation: false, confirm: false }, { activation: true, confirm: false }]) {
      expect(await main.invoke(NOTE, { folder, source: 'typed', gesture })).toMatchObject({ ok: false, error: 'gesture' })
    }

    expect(listed(folder)).toBe(false)
  })

  it('a cancelled dialog lists nothing, and the renderer cannot name the path of a pick', async () => {
    const before = main.listedForLauncher()
    const folder = made('renderer-names')

    dialogAnswer = []
    expect(await main.invoke('hermes:confinement:pick-project-folder', { folder, path: folder, gesture: CLICK })).toEqual({
      path: null,
      listed: false
    })
    expect(main.listedForLauncher()).toEqual(before)
  })

  it('a folder inside a repo goes in with the repo root, which is the project a command runs under', async () => {
    const root = made('home', 'code', 'repo')

    mkdirSync(path.join(root, '.git'))

    const inner = made('home', 'code', 'repo', 'pkg')

    expect((await main.invoke(NOTE, { folder: inner, source: 'typed', gesture: CLICK })).ok).toBe(true)
    expect(listed(inner)).toBe(true)
    expect(listed(root)).toBe(true)
  })
})

describe('only the named routes reach a listing, in the source itself', () => {
  const electronRoot = path.resolve(__dirname, '..')
  const sources: [string, string][] = []

  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.ts$/.test(entry.name) && !/\.test(-helpers)?\.ts$/.test(entry.name)) {
        sources.push([path.relative(electronRoot, full), readFileSync(full, 'utf8')])
      }
    }
  }

  walk(electronRoot)

  const callers = (call: RegExp) => sources.filter(([, text]) => call.test(text)).map(([name]) => name).sort()

  it('noteProject is called only by the live harness; setFolder only in ipc.ts; the spawn folder only from start-hermes', () => {
    expect(callers(/\.noteProject\??\.?\(/)).toEqual(['iclone-confinement/launcher-live-harness.ts'])
    expect(callers(/\.setFolder\??\.?\(/)).toEqual(['iclone-permissions/ipc.ts'])
    expect(callers(/\blistDefaultFolder\(/)).toEqual(['iclone-permissions/ipc.ts', 'main/start-hermes.ts'])
  })
})

describe('the default folder: main\'s own setting, re-judged at each start (fx27)', () => {
  it('the never list refuses it at main and policy.json never carries it', () => {
    const before = main.listedForLauncher()

    for (const refused of [main.home, path.dirname(main.home), main.userDataDir, '/']) {
      expect(listDefaultFolder(refused, never)).toBeNull()
      expect(listed(refused)).toBe(false)
    }

    expect(main.listedForLauncher()).toEqual(before)
  })

  it('a start lists it in the record, Remove takes it off, the next start with another setting lists only the other', async () => {
    const first = made('home', 'projects-a')
    const second = made('home', 'projects-b')

    expect(listDefaultFolder(first, never)).toBe(first)
    expect(listed(first)).toBe(true)
    expect(main.listedForLauncher()).toContain(first)

    expect(await main.invoke('iclone:permissions:remove-folder', { folder: first, gesture: CLICK })).toMatchObject({ ok: true })
    expect(listed(first)).toBe(false)

    expect(listDefaultFolder(first, never)).toBe(first)
    expect(listDefaultFolder(second, never)).toBe(second)
    expect(listed(first)).toBe(false)
    expect(listed(second)).toBe(true)
    expect(listDefaultFolder(main.home, never)).toBeNull()
    expect(listed(second)).toBe(false)
  })
})


describe('fx29 — the default folder and the picker', () => {
  const defaultOf = (folder: string) => listDefaultFolder(folder, never)

  it('moving the default takes off only what the default itself put there: a folder the user picked stays', async () => {
    const picked = made('fx29', 'picked')
    const onlyDefault = made('fx29', 'only-default')

    expect(await SOURCES.picker(picked)).toBe(true)
    expect(defaultOf(picked)).toBe(picked)
    expect(defaultOf(onlyDefault)).toBe(onlyDefault)
    expect(listed(picked)).toBe(true)
    expect(listed(onlyDefault)).toBe(true)
    expect(defaultOf(made('fx29', 'third'))).not.toBeNull()
    expect(listed(onlyDefault)).toBe(false)
    expect(listed(picked)).toBe(true)
  })

  it('a default inside a repository lists the root by the same step as a named folder, and moving it takes the root off too', () => {
    const repo = made('home', 'fx29', 'repo')
    const inner = made('home', 'fx29', 'repo', 'apps', 'web')

    mkdirSync(path.join(repo, '.git'), { recursive: true })
    expect(defaultOf(inner)).toBe(inner)
    expect(listed(inner)).toBe(true)
    expect(listed(repo)).toBe(true)
    expect(main.listedForLauncher()).toEqual(expect.arrayContaining([inner, repo]))
    expect(defaultOf(made('home', 'fx29', 'elsewhere'))).not.toBeNull()
    expect(listed(inner)).toBe(false)
    expect(listed(repo)).toBe(false)
  })

  it('the picker: main refuses the home folder with its message, and lists nothing without a gesture', async () => {
    dialogAnswer = [main.home]
    const refused = await main.invoke('hermes:confinement:pick-project-folder', { gesture: CLICK })

    expect(refused).toMatchObject({ path: main.home, listed: false })
    expect(typeof refused.message === 'string' && refused.message.length > 0).toBe(true)
    expect(listed(main.home)).toBe(false)
    const folder = made('fx29', 'no-gesture')

    const noGesture = [
      { inputAgo: 60_000, input: { gesture: CLICK } },
      { inputAgo: 0, input: {} },
      { inputAgo: 0, input: { gesture: { activation: true, confirm: false } } },
      { inputAgo: 0, input: { gesture: { activation: false, confirm: true } } }
    ]

    dialogAnswer = [folder]
    dialogsOpened = 0

    for (const row of noGesture) {
      inputAgoMs = row.inputAgo

      try {
        const answer = await main.invoke('hermes:confinement:pick-project-folder', row.input)

        expect(answer, JSON.stringify(row)).toMatchObject({ path: null, listed: false })
      } finally {
        inputAgoMs = 0
      }

      expect(dialogsOpened, JSON.stringify(row)).toBe(0)
      expect(listed(folder), JSON.stringify(row)).toBe(false)
    }

    // The same pick with the click just made: only the gesture stood between it and the list.
    expect(await main.invoke('hermes:confinement:pick-project-folder', { gesture: CLICK })).toEqual({ path: folder, listed: true })
    expect(dialogsOpened).toBe(1)
    expect(listed(folder)).toBe(true)
  })
})

describe('fx32p: Allow this folder and an ask list the root too; the default takes off only what it alone added', () => {
  const ALLOW = 'hermes:confinement:allow-folder'

  const repo = (name: string) => {
    const root = made('home', 'code', name)

    mkdirSync(path.join(root, '.git'))

    return { inner: made('home', 'code', name, 'pkg'), root }
  }

  it('Allow this folder lists the repository root with the folder; the home folder is never that root', async () => {
    const { inner, root } = repo('allow-root')

    expect(await main.invoke(ALLOW, { folder: inner, gesture: CLICK })).toMatchObject({ ok: true })
    expect(listed(inner)).toBe(true)
    expect(listed(root)).toBe(true)

    mkdirSync(path.join(main.home, '.git'))

    try {
      const plain = made('home', 'not-a-repo', 'pkg')

      expect(await main.invoke(ALLOW, { folder: plain, gesture: CLICK })).toMatchObject({ ok: true })
      expect(listed(plain)).toBe(true)
      expect(listed(main.home)).toBe(false)
      expect(listed(path.dirname(plain))).toBe(false)
      expect(askedFolder(plain, never)?.project).toBe(plain)
    } finally {
      rmdirSync(path.join(main.home, '.git'))
    }
  })

  it('an ask inside a repository names its root, by identity; the never list still names nothing', () => {
    const { inner, root } = repo('ask-root')
    const asked = askedFolder(inner, never)

    expect(asked?.project).toBe(root)
    expect(asked?.same()).toBe(true)
    expect(listed(root)).toBe(false)
    renameSync(root, `${root}-moved`)
    mkdirSync(root)
    expect(asked?.same()).toBe(false)
    expect(askedFolder(path.join(root, '.git'), never)).toBeNull()
    expect(askedFolder(main.userDataDir, never)).toBeNull()
  })

  it('a folder the default added and the user then named stays when the default moves, by each route', async () => {
    for (const [name, nameIt] of [
      ['typed', (folder: string) => main.invoke(NOTE, { folder, source: 'typed', gesture: CLICK })],
      ['allowed', (folder: string) => main.invoke(ALLOW, { folder, gesture: CLICK })]
    ] as const) {
      const first = made('home', 'default-memo', name)
      const second = made('home', 'default-memo', `${name}-next`)
      const third = made('home', 'default-memo', `${name}-last`)

      expect(listDefaultFolder(first, never)).toBe(first)
      expect((await nameIt(first)).ok).toBe(true)
      expect(listDefaultFolder(second, never)).toBe(second)
      expect(listed(first), `${name}: the user named it`).toBe(true)
      // What the default alone added still goes.
      expect(listDefaultFolder(third, never)).toBe(third)
      expect(listed(second), `${name}: only the default named it`).toBe(false)
    }
  })

  it('the picker says why a package store or a folder the shell runs from is no project, and lists neither', async () => {
    const bin = made('home', '.local', 'bin')
    const holder = path.dirname(bin)
    const inside = made('home', '.local', 'bin', 'tools')
    const store = made('home', 'a-store')
    const inStore = made('home', 'a-store', 'v3')
    const shell = 'This folder is, holds or sits inside a folder your own shell or tools run from, so it cannot be a project.'

    vi.stubEnv('PNPM_HOME', store)

    try {
      for (const [folder, message] of [
        [bin, shell],
        [holder, shell],
        [inside, shell],
        [store, 'A package store cannot be a project.'],
        [inStore, 'A package store cannot be a project.']
      ] as const) {
        expect(await main.invoke(ALLOW, { folder, gesture: CLICK }), folder).toMatchObject({ ok: false, message })
        expect(listed(folder), folder).toBe(false)
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('main and the launcher refuse the same folders, by the rule set main hands the launcher', () => {
    const protectedWrites = execOnBehalfWrites(never.home)

    expect(projectRootRefusal(path.join(never.home, '.local', 'bin'), { denied: [], protectedWrites }, never.home)).toBe('shell')
    expect(projectRootRefusal(path.join(never.home, 'store', 'x'), { denied: [], protectedWrites }, never.home, [path.join(never.home, 'store')])).toBe('store')
    expect(acceptableProjectRoot(path.join(never.home, 'store', 'x'), { denied: [], protectedWrites }, never.home, [path.join(never.home, 'store')])).toBe(false)
    expect(acceptableProjectRoot(path.join(never.home, 'code'), { denied: [], protectedWrites }, never.home)).toBe(true)
  })
})
