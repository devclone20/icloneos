/**
 * V3-G F7 live, against the real `/usr/bin/sandbox-exec`: a hard link is a second name for an inode, and Seatbelt
 * judges the name. Every refusal has its unconfined control, so a probe that "fails" for another reason fails the test.
 */
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ACTIVITY_CLASSES } from '../../src/iclone-shared/confinement'

import { createLiveWorld, type LiveWorld } from './live-harness'
import { SANDBOX_EXEC } from './probe'

import { createConfinement } from './index'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
const SECRET = 'outside-secret\n'

let world: LiveWorld

beforeAll(() => {
  world = createLiveWorld()
})

afterAll(() => {
  world?.dispose()
})

describe.runIf(LIVE)('F7 — no hard link is made from inside, in any class', () => {
  it.each(ACTIVITY_CLASSES)(
    '%s: a link between two files the class may write is refused (and made unconfined)',
    async cls => {
      const command =
        'echo a > "$TMPDIR/f7-src" && ln "$TMPDIR/f7-src" "$TMPDIR/f7-dst"; s=$?; [ -e "$TMPDIR/f7-dst" ] && echo LINKED; exit $s'

      const control = await world.runPlain(`TMPDIR=${world.root} && ${command}`)
      const confined = await world.runConfined(command, { cls })

      rmSync(path.join(world.root, 'f7-dst'), { force: true })
      expect(control.code).toBe(0)
      expect(control.out).toContain('LINKED')
      expect(confined.code).not.toBe(0)
      expect(confined.out).not.toContain('LINKED')
      expect(confined.out).toContain('Operation not permitted')
    }
  )

  it.each(['project', 'build', 'offline'] as const)(
    '%s: ln inside the project, to the project’s own file and to an outside canary, is refused',
    async cls => {
      const inside = `ln README.md f7-twin; ln ${path.join(world.outside, 'secret.txt')} f7-canary`
      const confined = await world.runConfined(inside, { cls, writeProject: true })

      expect(confined.out.match(/Operation not permitted/g)).toHaveLength(2)
      expect(existsSync(path.join(world.project, 'f7-twin'))).toBe(false)
      expect(existsSync(path.join(world.project, 'f7-canary'))).toBe(false)
      // The project is writable in this very run: the refusal is the link, not the write.
      expect((await world.runConfined('echo w > f7-write && cat f7-write', { cls })).out).toContain('w')
      rmSync(path.join(world.project, 'f7-write'), { force: true })
    }
  )

  it('git still commits: it falls back to a rename when link() is refused', async () => {
    const result = await world.runConfined(
      'git init -q f7-repo && cd f7-repo && echo x > a && git add a && git -c user.name=t -c user.email=t@t commit -qm m && git log --oneline | wc -l'
    )

    rmSync(path.join(world.project, 'f7-repo'), { recursive: true, force: true })
    expect(result.code).toBe(0)
    expect(result.out.trim().split('\n').at(-1)?.trim()).toBe('1')
  })
})

describe.runIf(LIVE)('F7 — the critic’s planted hard link: 5 classes × NET 0/1, 0 of 10 escape', () => {
  it('a link planted by an unconfined writer refuses the run; removing it lets the same run start', async () => {
    const secret = path.join(world.outside, 'secret.txt')
    const planted = path.join(world.project, 'planted-link')

    writeFileSync(secret, SECRET)
    expect((await world.runPlain(`ln ${secret} ${planted} && cat planted-link`)).out).toBe(SECRET)

    const cells = ACTIVITY_CLASSES.flatMap(cls => [false, true].map(network => ({ cls, network })))
    const escapes: string[] = []

    for (const cell of cells) {
      const read = await world.runConfined('cat planted-link', cell)
      const write = await world.runConfined('echo PWNED >> planted-link', cell)

      expect(read.code).toBeNull()
      expect(read.out).toContain('confinement refused to start in')
      expect(read.out).toContain(planted)

      if (read.out.includes(SECRET.trim()) || write.code === 0 || readFileSync(secret, 'utf8') !== SECRET) {
        escapes.push(`${cell.cls}/NET=${cell.network ? 1 : 0}`)
      }
    }

    expect(cells).toHaveLength(10)
    expect(escapes).toEqual([])

    rmSync(planted)

    for (const cell of cells) {
      expect((await world.runConfined('cat README.md', cell)).out).toBe('inside\n')
    }
  })

  it('an allowed group runs; only those inodes: a second planted link refuses again', async () => {
    const planted = path.join(world.project, 'acked-link')
    const second = path.join(world.project, 'second-link')

    linkSync(path.join(world.outside, 'secret.txt'), planted)

    const shown = world.hardlinks.check(world.project)

    expect((await world.runConfined('cat README.md')).code).toBeNull()

    if (shown.ok) {
      throw new Error('expected a refusal')
    }

    expect(world.hardlinks.acknowledgeGroup(world.project, world.project, shown.block.groups[0].digest).ok).toBe(true)
    expect((await world.runConfined('cat README.md')).out).toBe('inside\n')

    writeFileSync(path.join(world.outside, 'other.txt'), 'other\n')
    linkSync(path.join(world.outside, 'other.txt'), second)

    const refused = await world.runConfined('cat README.md')

    expect(refused.code).toBeNull()
    expect(refused.out).toContain(second)
    expect(refused.out).not.toContain(planted)
    rmSync(planted)
    rmSync(second)
  })
})

describe.runIf(LIVE)(
  'F7 r3 T1 — the critic’s chmod 311: an unlistable folder hiding a link is refused in 5 classes',
  () => {
    it('cannot scan ⇒ refused at spawn (read and write), the secret unread; listable again ⇒ the link itself refuses', async () => {
      const secret = path.join(world.outside, 'secret-t1.txt')
      const hidden = path.join(world.project, 'hidden')

      writeFileSync(secret, SECRET)
      mkdirSync(hidden)
      linkSync(secret, path.join(hidden, 'x'))
      chmodSync(hidden, 0o311)

      try {
        // The premise: traversal needs only x, so the file is readable through the unlistable folder, unconfined.
        expect((await world.runPlain('cat hidden/x')).out).toBe(SECRET)

        const escapes: string[] = []

        for (const cls of ACTIVITY_CLASSES) {
          const read = await world.runConfined('cat hidden/x', { cls })
          const write = await world.runConfined('echo PWNED >> hidden/x', { cls })

          expect(read.code).toBeNull()
          expect(read.out).toContain(`confinement refused to start in ${world.project}: cannot scan ${hidden}`)

          if (read.out.includes(SECRET.trim()) || write.code === 0 || readFileSync(secret, 'utf8') !== SECRET) {
            escapes.push(cls)
          }
        }

        expect(escapes).toEqual([])
      } finally {
        chmodSync(hidden, 0o755)
      }

      const refused = await world.runConfined('cat hidden/x')

      expect(refused.code).toBeNull()
      expect(refused.out).toContain(`${path.join(hidden, 'x')} is a hard link`)
      rmSync(hidden, { recursive: true })
      expect((await world.runConfined('cat README.md')).out).toBe('inside\n')
    })

    it('the scratch dir is scanned too: a link planted under it refuses the run, in every class', async () => {
      const secret = path.join(world.outside, 'secret-scratch.txt')
      const scratch = path.join(world.paths.scratchRoot, 'v3g-test')

      writeFileSync(secret, SECRET)
      mkdirSync(scratch, { recursive: true })

      const planted = path.join(scratch, 'planted-link')

      linkSync(secret, planted)

      for (const cls of ACTIVITY_CLASSES) {
        const read = await world.runConfined('cat "$TMPDIR/../planted-link"', { cls })

        expect(read.code).toBeNull()
        expect(read.out).toContain(`confinement refused to start in ${scratch}`)
        expect(read.out).not.toContain(SECRET.trim())
      }

      rmSync(planted)
      expect((await world.runConfined('cat README.md')).out).toBe('inside\n')
    })
  }
)

describe.runIf(LIVE)(
  'F7 r4 T1′ — the critic’s chmod 400 / 600: a folder that lists but hides its link counts is refused in 5 classes',
  () => {
    it.each([0o400, 0o600])(
      'mode %o: `chmod 711 hidden; cat hidden/x` from inside is refused at spawn (read and write), the mode untouched, the secret unread',
      async mode => {
        const secret = path.join(world.outside, `secret-t1p-${mode.toString(8)}.txt`)
        const hidden = path.join(world.project, 'hidden')

        writeFileSync(secret, SECRET)
        mkdirSync(hidden)
        linkSync(secret, path.join(hidden, 'x'))
        chmodSync(hidden, mode)

        try {
          // The premise: the folder lists, its children do not stat, and giving x back reads the outside secret
          // through the link — unconfined, and (MAJOR-1′) confined too, since file-write-mode is inside the
          // project's file-write*. The scan must refuse before any of that runs.
          expect(readdirSync(hidden)).toEqual(['x'])
          expect((await world.runPlain('cat hidden/x')).out).toContain('Permission denied')
          expect((await world.runPlain('chmod 711 hidden; cat hidden/x')).out).toBe(SECRET)
          chmodSync(hidden, mode)

          const escapes: string[] = []

          for (const cls of ACTIVITY_CLASSES) {
            const read = await world.runConfined('chmod 711 hidden; cat hidden/x', { cls, writeProject: true })

            const write = await world.runConfined('chmod 711 hidden; echo PWNED >> hidden/x', {
              cls,
              writeProject: true
            })

            expect(read.code).toBeNull()
            expect(read.out).toContain(`confinement refused to start in ${world.project}: cannot scan ${hidden}`)
            expect(write.code).toBeNull()

            if (
              read.out.includes(SECRET.trim()) ||
              write.code === 0 ||
              readFileSync(secret, 'utf8') !== SECRET ||
              (statSync(hidden).mode & 0o777) !== mode
            ) {
              escapes.push(cls)
            }
          }

          expect(escapes).toEqual([])
        } finally {
          chmodSync(hidden, 0o755)
        }

        const refused = await world.runConfined('cat hidden/x')

        expect(refused.code).toBeNull()
        expect(refused.out).toContain(`${path.join(hidden, 'x')} is a hard link`)
        rmSync(hidden, { recursive: true })
        expect((await world.runConfined('cat README.md')).out).toBe('inside\n')
      }
    )
  }
)

describe.runIf(LIVE)('F7 r4 T2′′ — a pnpm store in build runs with 0 gestures; every other class still asks', () => {
  it('links into the store root: build runs and reads the blob, 0 acks, no exit row; project/offline/research/media refused; a non-store link refuses build too', async () => {
    const files = path.join(world.pnpmStore, 'store', 'v3', 'files')
    const pnpm = path.join(world.project, 'node_modules', '.pnpm')

    mkdirSync(files, { recursive: true })

    for (let i = 0; i < 20; i += 1) {
      writeFileSync(path.join(files, `h${i}`), `blob ${i}\n`)
      mkdirSync(path.join(pnpm, `pkg${i}`), { recursive: true })
      linkSync(path.join(files, `h${i}`), path.join(pnpm, `pkg${i}`, 'index.js'))
    }

    // The world's record may already hold a group an earlier test allowed: what matters is that this adds nothing.
    const acksBefore = world.hardlinks.acks().length
    const appearedBefore = world.appeared.length

    try {
      const build = await world.runConfined('cat node_modules/.pnpm/pkg7/index.js', { cls: 'build' })

      expect(build.code).toBe(0)
      expect(build.out).toBe('blob 7\n')
      expect(world.hardlinks.acks()).toHaveLength(acksBefore)
      expect(world.appeared).toHaveLength(appearedBefore)

      for (const cls of ['project', 'offline', 'research', 'media'] as const) {
        const refused = await world.runConfined('cat node_modules/.pnpm/pkg7/index.js', { cls })

        expect(refused.code).toBeNull()
        expect(refused.out).toContain('are hard links to a file outside the project')
        expect(refused.out).not.toContain('blob 7')
      }

      // A link into a non-store root asks in build as well, named alone.
      const secret = path.join(world.outside, 'secret-t2pp.txt')
      const planted = path.join(pnpm, 'pkg0', 'secret.js')

      writeFileSync(secret, SECRET)
      linkSync(secret, planted)

      const mixed = await world.runConfined('cat node_modules/.pnpm/pkg0/secret.js', { cls: 'build' })

      expect(mixed.code).toBeNull()
      expect(mixed.out).toContain(`${planted} is a hard link`)
      expect(mixed.out).not.toContain(SECRET.trim())
      expect(world.hardlinks.acks()).toHaveLength(acksBefore)
    } finally {
      rmSync(path.join(world.project, 'node_modules'), { recursive: true, force: true })
    }

    expect((await world.runConfined('cat README.md', { cls: 'build' })).out).toBe('inside\n')
  })
})

describe.runIf(LIVE)(
  'F7 r5 MAJOR-1″ — a symlinked store root is not the store: build is refused, the secret unread',
  () => {
    it('pnpm-store → hermes-home and a project link to hermes-home/.env: refused in every class with 0 acks; the .env by its own path is denied too', async () => {
      const hermesEnv = path.join(world.root, 'hermes-home', '.env')
      const ENV = readFileSync(hermesEnv, 'utf8').trim()
      const evil = path.join(world.project, 'node_modules', '.pnpm', 'evil', 'index.js')
      const acksBefore = world.hardlinks.acks().length

      rmSync(world.pnpmStore, { recursive: true, force: true })
      symlinkSync(path.join(world.root, 'hermes-home'), world.pnpmStore)
      // The store's shape is one more mkdir for the same writer: it is not the boundary, the real root is.
      mkdirSync(path.join(world.root, 'hermes-home', 'store', 'v3'), { recursive: true })
      mkdirSync(path.dirname(evil), { recursive: true })
      linkSync(hermesEnv, evil)

      try {
        // The premise: the root main would walk lists the secret.
        expect(readdirSync(world.pnpmStore)).toContain('.env')

        for (const cls of ACTIVITY_CLASSES) {
          const run = await world.runConfined('cat node_modules/.pnpm/evil/index.js', { cls })

          expect(run.code, cls).toBeNull()
          expect(run.out, cls).toContain(`${evil} is a hard link`)
          expect(run.out, cls).not.toContain(ENV)
        }

        expect(world.hardlinks.acks()).toHaveLength(acksBefore)

        const direct = await world.runConfined(`cat ${hermesEnv}`, { cls: 'build' })

        expect(direct.code).not.toBe(0)
        expect(direct.out).not.toContain(ENV)
      } finally {
        unlinkSync(world.pnpmStore)
        rmSync(path.join(world.root, 'hermes-home', 'store'), { recursive: true, force: true })
        rmSync(path.join(world.project, 'node_modules'), { recursive: true, force: true })
      }

      expect((await world.runConfined('cat README.md', { cls: 'build' })).out).toBe('inside\n')
    })
  }
)

describe.runIf(LIVE)('F7 r6 MAJOR-1‴ — the agent cds into the store: the secret linked into it is never read', () => {
  it('project = the store root (or its store/v3), the secret hard-linked into the store: unread in every class; the guard asks on its own', async () => {
    const hermesEnv = path.join(world.root, 'hermes-home', '.env')
    const ENV = readFileSync(hermesEnv, 'utf8').trim()
    const files = path.join(world.pnpmStore, 'store', 'v3', 'files')
    const blob = path.join(files, 'evil-blob')

    mkdirSync(files, { recursive: true })
    linkSync(hermesEnv, blob)

    try {
      // The premise: unconfined, the store's name reads the secret.
      expect((await world.runPlain(`cat ${blob}`)).out).toContain(ENV)
      // The algorithm alone: the store name is one of two, the other (the secret's own) is outside — it asks.
      expect(world.hardlinks.check(world.pnpmStore, 'build')).toMatchObject({
        ok: false,
        block: { kind: 'hard-links', paths: [blob], count: 1 }
      })

      for (const project of [world.pnpmStore, path.join(world.pnpmStore, 'store', 'v3')]) {
        for (const cls of ACTIVITY_CLASSES) {
          const run = await world.runConfined(`cat ${blob}; cat store/v3/files/evil-blob files/evil-blob`, {
            cls,
            projectRoot: project,
            cwd: project
          })

          expect(run.out, `${project} ${cls}`).not.toContain(ENV)
        }
      }
    } finally {
      rmSync(path.join(world.pnpmStore, 'store'), { recursive: true, force: true })
    }

    expect((await world.runConfined('cat README.md', { cls: 'build' })).out).toBe('inside\n')
  })
})

describe.runIf(LIVE)('F7 r3 T2 — 500 pnpm-shaped links: one gesture runs the command; the 501st asks again', () => {
  it('500 links are one group; one acknowledgement, the command runs; a link planted after it is refused on its own', async () => {
    const store = path.join(world.outside, 'store')
    const pnpm = path.join(world.project, 'node_modules', '.pnpm')

    mkdirSync(store, { recursive: true })

    const plant = (i: number) => {
      const target = path.join(store, `blob${i}`)
      const pkg = path.join(pnpm, `pkg${i}`)

      mkdirSync(pkg, { recursive: true })
      writeFileSync(target, `blob ${i}\n`)
      linkSync(target, path.join(pkg, 'index.js'))

      return path.join(pkg, 'index.js')
    }

    for (let i = 0; i < 500; i += 1) {
      plant(i)
    }

    const refused = await world.runConfined('cat README.md')

    expect(refused.code).toBeNull()
    expect(refused.out).toContain('and 497 more are hard links')

    const shown = world.hardlinks.check(world.project)

    if (shown.ok) {
      throw new Error('expected a refusal')
    }

    expect(shown.block.count).toBe(500)
    expect(shown.block.groups).toHaveLength(1)
    expect(shown.block.groups[0]).toMatchObject({ dir: pnpm, count: 500 })

    let gestures = 0

    // What the pane does on the one click.
    const result = world.hardlinks.acknowledgeGroup(world.project, pnpm, shown.block.groups[0].digest)

    gestures += 1
    expect(result).toMatchObject({ ok: true, count: 500 })
    expect((await world.runConfined('cat README.md')).out).toBe('inside\n')
    expect(gestures).toBe(1)

    const late = plant(500)
    const again = await world.runConfined('cat README.md')

    expect(again.code).toBeNull()
    expect(again.out).toContain(`${late} is a hard link`)
    expect(world.hardlinks.check(world.project)).toMatchObject({ ok: false, block: { count: 1 } })

    rmSync(path.join(world.project, 'node_modules'), { recursive: true })
    rmSync(store, { recursive: true })
    expect((await world.runConfined('cat README.md')).out).toBe('inside\n')
  }, 30_000)
})

describe.runIf(LIVE)(
  'F7 r3 T3 — a link planted during the run is found when it exits: a refusal row and a pane note',
  () => {
    it('the critic’s 0.3 s plant: not prevented, detected; the next run in that root is refused', async () => {
      const secret = path.join(world.outside, 'secret-t3.txt')
      const planted = path.join(world.project, 'during-run')

      writeFileSync(secret, SECRET)

      const run = world.runConfined('sleep 0.7; cat during-run')

      await new Promise(resolve => setTimeout(resolve, 300))
      linkSync(secret, planted)

      const outcome = await run

      // Seatbelt has no inode filter: the run reached the file (the residual the ticket accepts) …
      expect(outcome.out).toContain(SECRET.trim())
      // … and the scan after its exit said so, naming the run and the path.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(world.appeared).toHaveLength(1)
      expect(world.appeared[0]).toMatchObject({
        root: world.project,
        pid: outcome.pid,
        sessionId: 'v3g-test',
        block: { kind: 'hard-links', paths: [planted], count: 1 }
      })

      const next = await world.runConfined('cat during-run')

      expect(next.code).toBeNull()
      expect(next.out).toContain(`${planted} is a hard link`)
      rmSync(planted)
      world.appeared.splice(0)
    })

    it('through the layer: the row lands in refusals/*.jsonl and the state carries the note, in that run’s name', async () => {
      const userDataDir = path.join(world.root, 'layer-userData')

      const layer = createConfinement({
        userDataDir,
        home: os.homedir(),
        hermesHome: world.paths.hermesHome,
        hermesRoot: null,
        hermesPids: () => [],
        audit: () => [],
        ps: async () => [],
        // `state()` probes both backends: no test runs the real Apple `container` binary (G3; this test is about
        // hard links, and a Mac with container installed would otherwise run `container --version` here).
        probes: {
          container: async () => ({
            id: 'container',
            status: 'not-installed',
            enforcing: false,
            version: null,
            detail: 'not-installed',
            evidence: 'stub',
            ownerStep: null
          })
        }
      })

      const secret = path.join(world.outside, 'secret-t3b.txt')
      const planted = path.join(world.project, 'during-layer-run')

      writeFileSync(secret, SECRET)

      const spawned = layer.backend('seatbelt').spawn({
        cls: 'project',
        argv: ['/bin/sh', '-c', 'sleep 0.7; cat during-layer-run'],
        cwd: world.project,
        env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
        projectRoot: world.project,
        network: false,
        writeProject: true,
        sessionId: 'v3g-layer'
      })

      if (!spawned.ok) {
        throw new Error(spawned.error)
      }

      await new Promise(resolve => setTimeout(resolve, 300))
      linkSync(secret, planted)
      await new Promise<void>(resolve => spawned.child.once('close', () => resolve()))
      await new Promise(resolve => setTimeout(resolve, 50))

      const rows = readdirSync(path.join(userDataDir, 'confinement', 'refusals')).flatMap(name =>
        readFileSync(path.join(userDataDir, 'confinement', 'refusals', name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, unknown>)
      )

      expect(rows).toContainEqual(
        expect.objectContaining({
          pid: spawned.pid,
          process: 'hard-link',
          operation: 'hard-link-appeared',
          target: planted,
          sessionId: 'v3g-layer',
          root: world.project
        })
      )

      const state = await layer.state()

      expect(state.reasons).toContainEqual({
        code: 'hardlink-appeared',
        pid: spawned.pid,
        root: world.project,
        path: planted
      })
      // Said, not red: the run is over; what turns the next one away is the scan before it.
      expect(state.reasons.filter(reason => reason.code === 'hardlink-appeared')).toHaveLength(1)
      rmSync(planted)
    })
  }
)
