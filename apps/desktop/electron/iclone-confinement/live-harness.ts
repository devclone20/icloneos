/**
 * V3-G — the live harness the Seatbelt tests and the gate share: a throwaway world (home stand-ins under a temp
 * dir, the real home for the real secrets), the generated profiles, and `runConfined` / `runPlain` so every probe
 * is paired with its unconfined control. Test-only: nothing in the app imports it.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ActivityClass } from '../../src/iclone-shared/confinement'

import type { SpawnRequest } from './backend'
import {
  createSeatbeltBackend,
  type GeneratedProfile,
  generateProfiles,
  type HardlinkAppearedEvent
} from './backend-seatbelt'
import { createHardlinkGuard, hardlinkFiles, type HardlinkGuard } from './hardlinks'
import { createMemberProbe, ensureMembersDir } from './members'
import { type ConfinementPaths, realOrSelf } from './profiles'
import { readPs, type Snapshot, withMembership } from './state'

import { xcrunCacheFile } from './index'

/** The Python that asks the kernel (members.ts): the Hermes venv when present, as the app uses, else the system one.
 *  The venv is found from this checkout, never from a path typed in: a hard-coded home path would both break on any
 *  other machine and put the author's folder layout in a public repository. */
export const MEMBER_PYTHON = [
  process.env.V3G_PY,
  path.join(import.meta.dirname, '../../../..', 'venv/bin/python'),
  '/usr/bin/python3'
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string))

interface RunOutcome {
  code: number | null
  out: string
  pid: number
}

export interface LiveWorld {
  root: string
  project: string
  outside: string
  paths: ConfinementPaths
  profiles: GeneratedProfile[]
  backend: ReturnType<typeof createSeatbeltBackend>
  hardlinks: HardlinkGuard
  /** T2'': the one pnpm store root this world's guard resolves into. */
  pnpmStore: string
  /** T3: what the scan after each run's exit found (hard links planted during the run). */
  appeared: HardlinkAppearedEvent[]
  scan: () => Promise<Snapshot>
  runConfined: (command: string, options?: Partial<Omit<SpawnRequest, 'argv'>>) => Promise<RunOutcome>
  runPlain: (command: string, cwd?: string) => Promise<RunOutcome>
  dispose: () => void
}

function collect(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<RunOutcome> {
  return new Promise(resolve => {
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)

    child.stdout?.on('data', chunk => (out += String(chunk)))
    child.stderr?.on('data', chunk => (out += String(chunk)))
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, pid: child.pid ?? 0 })
    })
  })
}

export function createLiveWorld(): LiveWorld {
  const root = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'iclone-v3g-')))
  const project = path.join(root, 'project')
  const outside = path.join(root, 'outside')
  const userDataDir = path.join(root, 'userData')
  const hermesHome = path.join(root, 'hermes-home')

  for (const dir of [project, outside, path.join(userDataDir, 'permissions'), hermesHome]) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(path.join(project, 'README.md'), 'inside\n')
  writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret\n')
  writeFileSync(path.join(outside, 'run.sh'), '#!/bin/sh\necho ran-outside\n', { mode: 0o755 })
  writeFileSync(path.join(userDataDir, 'consent.json'), '{"consent":true}\n')
  writeFileSync(path.join(userDataDir, 'permissions', 'planted.json'), '{"planted":true}\n')
  writeFileSync(path.join(hermesHome, '.env'), 'OPENAI_API_KEY=sk-test-not-real\n')
  writeFileSync(path.join(hermesHome, 'auth.json'), '{"token":"not-real"}\n')
  writeFileSync(path.join(hermesHome, 'config.yaml'), 'terminal: {}\n')

  const paths: ConfinementPaths = {
    home: os.homedir(),
    hermesHome,
    userDataDir,
    hermesRoot: null,
    profilesDir: path.join(userDataDir, 'confinement', 'profiles'),
    scratchRoot: path.join(root, 'scratch'),
    membersDir: path.join(root, 'members'),
    xcrunCache: xcrunCacheFile()
  }

  ensureMembersDir(paths.membersDir)

  const profiles = generateProfiles(paths)
  const probe = MEMBER_PYTHON ? createMemberProbe(paths.membersDir, MEMBER_PYTHON) : null
  const scan = async () => withMembership(await readPs(), probe)
  // T2'': a world-local pnpm store root (never the real ~/Library/pnpm, which paths.home would name).
  const pnpmStore = path.join(root, 'pnpm-store')
  const hardlinks = createHardlinkGuard({ ackFile: hardlinkFiles(userDataDir).acks, storeRoots: [pnpmStore] })
  const appeared: HardlinkAppearedEvent[] = []

  const backend = createSeatbeltBackend({
    paths,
    profiles: () => profiles,
    scan,
    hardlinks,
    storeRoots: [pnpmStore],
    onHardlinkAppeared: event => appeared.push(event)
  })

  return {
    root,
    project,
    outside,
    paths,
    profiles,
    backend,
    hardlinks,
    pnpmStore,
    appeared,
    scan,
    async runConfined(command, options = {}) {
      const result = backend.spawn({
        cls: options.cls ?? ('project' satisfies ActivityClass),
        argv: ['/bin/sh', '-c', command],
        cwd: options.cwd ?? project,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', ...options.env },
        projectRoot: options.projectRoot === undefined ? project : options.projectRoot,
        network: options.network ?? false,
        writeProject: options.writeProject ?? true,
        sessionId: options.sessionId ?? 'v3g-test',
        outputDir: options.outputDir ?? null
      })

      if (!result.ok) {
        return { code: null, out: result.error, pid: 0 }
      }

      return collect(result.child, 15_000)
    },
    runPlain(command, cwd = project) {
      return collect(
        spawn('/bin/sh', ['-c', command], {
          cwd,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C' },
          stdio: ['ignore', 'pipe', 'pipe']
        }),
        15_000
      )
    },
    dispose() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}
