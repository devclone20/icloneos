/**
 * V3-G live gates against the real `/usr/bin/sandbox-exec` (macOS only). Every refusal is paired with its control:
 * the same command run unconfined must succeed (or the path must exist), so a probe that "fails" because its target
 * is missing proves nothing and fails the test instead. A refusal is the kernel's denial, observed: see probeVerdict.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, chai, describe, expect, it } from 'vitest'

import { PERF, PERF_TAG, skipUnderLoad } from '../perf-gate.test-helpers'

import { confinementMarker, parseMarker } from './backend'
import { knownProfile, profilesOnDisk, profileView } from './backend-seatbelt'
import { createLiveWorld, type LiveWorld } from './live-harness'
import { plantHomeDecoys, probeVerdict } from './live-verdict.test-helpers'
import { probeSeatbelt, SANDBOX_EXEC } from './probe'
import { realOrSelf } from './profiles'
import { createRefusalLog, startRefusalStream } from './refusals'
import { foldState, readPs, type Snapshot } from './state'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
const HOME = os.homedir()
// A verdict carries its cause in the string; the default threshold cuts it out of the failure message.
chai.config.truncateThreshold = 0

const CONTROL_FAILED = 'control failed: target missing, probe did not run'

let world: LiveWorld

beforeAll(() => {
  if (LIVE) {
    plantHomeDecoys()
  }

  world = createLiveWorld()
})

afterAll(() => {
  world?.dispose()
})

describe('probeVerdict — an exit code alone is not a refusal', () => {
  it.each([
    ['the kernel denial', { code: 1, out: 'cat: x: Operation not permitted\n', pid: 7 }, 'refused'],
    ['exit 0', { code: 0, out: 'secret\n', pid: 7 }, 'allowed: secret'],
    [
      'a missing target',
      { code: 1, out: 'cat: x: No such file or directory\n', pid: 7 },
      'did-not-run: exit 1 with no kernel denial: cat: x: No such file or directory'
    ],
    [
      'a missing binary',
      { code: 127, out: 'sh: x: command not found\n', pid: 7 },
      'did-not-run: exit 127 with no kernel denial: sh: x: command not found'
    ],
    ['a killed probe', { code: null, out: '', pid: 7 }, 'did-not-run: killed before it exited: '],
    [
      'a failed spawn',
      { code: null, out: 'confinement refused to start', pid: 0 },
      'did-not-run: spawn failed: confinement refused to start'
    ]
  ])('%s', (_name, outcome, verdict) => {
    expect(probeVerdict(outcome)).toBe(verdict)
  })

  it('a silent row still needs an exit: killed stays did-not-run, exit 0 stays allowed', () => {
    expect(probeVerdict({ code: 1, out: '' }, 'silent')).toBe('refused')
    expect(probeVerdict({ code: null, out: '', pid: 7 }, 'silent')).toBe('did-not-run: killed before it exited: ')
    expect(probeVerdict({ code: 0, out: '' }, 'silent')).toBe('allowed: ')
  })
})

describe.runIf(LIVE)('probe — the negative control on this Mac', () => {
  it('Seatbelt is present and a profile that must deny does deny', async () => {
    const view = await probeSeatbelt()

    expect(view.status).toBe('ready')
    expect(view.enforcing).toBe(true)
  })
})

describe.runIf(LIVE)('G1 — 20 planted probes, 20/20 refused, each with an unconfined control', () => {
  const reads = () => [
    `cat ${world.outside}/secret.txt`,
    `ls ${world.outside}`,
    `cat ${world.paths.userDataDir}/consent.json`,
    `cat ${world.paths.userDataDir}/permissions/planted.json`,
    `cat ${world.paths.hermesHome}/.env`,
    `cat ${world.paths.hermesHome}/auth.json`,
    `ls ${HOME}`,
    `cat ${HOME}/.zshrc || cat ${HOME}/.bash_profile || cat ${HOME}/.profile`,
    `ls ${HOME}/Library/Keychains`,
    `ls ${HOME}/Desktop`
  ]

  it.each(Array.from({ length: 10 }, (_, index) => index))(
    'read outside #%i is refused (and readable unconfined)',
    async index => {
      const command = reads()[index]

      expect((await world.runPlain(command)).code, CONTROL_FAILED).toBe(0)
      expect(probeVerdict(await world.runConfined(command))).toBe('refused')
    }
  )

  const writes = () => [
    { command: `touch ${world.outside}/w1`, file: `${world.outside}/w1` },
    { command: `echo x > ${world.paths.userDataDir}/consent.json`, file: null },
    {
      command: `touch ${world.paths.userDataDir}/permissions/forged.json`,
      file: `${world.paths.userDataDir}/permissions/forged.json`
    },
    { command: `echo 'terminal: {backend: local}' > ${world.paths.hermesHome}/config.yaml`, file: null },
    { command: `touch ${HOME}/.iclone-v3g-probe`, file: `${HOME}/.iclone-v3g-probe` },
    { command: `touch ${world.paths.profilesDir}/project.sb`, file: null }
  ]

  it.each(Array.from({ length: 6 }, (_, index) => index))(
    'write outside #%i is refused and leaves no file',
    async index => {
      const { command, file } = writes()[index]
      const before = file === null ? readFileSnapshot(world) : null

      expect(probeVerdict(await world.runConfined(command))).toBe('refused')

      if (file) {
        expect(existsSync(file)).toBe(false)
      } else {
        expect(readFileSnapshot(world)).toEqual(before)
      }
    }
  )

  it('network without a grant is refused (and reachable unconfined)', async () => {
    const server = await listenTcp()

    try {
      expect((await world.runPlain(`nc -zv -G 2 127.0.0.1 ${server.port}`)).code, CONTROL_FAILED).toBe(0)
      expect(probeVerdict(await world.runConfined(`nc -zv -G 2 127.0.0.1 ${server.port}`, { network: false }))).toBe(
        'refused'
      )
    } finally {
      server.close()
    }
  })

  it('a unix socket is refused even with the network granted, inside the project', async () => {
    const socket = path.join(world.project, 's.sock')
    const server = await listenUnix(socket)

    try {
      expect((await world.runPlain(`nc -U ${socket} < /dev/null`)).out).toContain('pong')

      const confined = await world.runConfined(`nc -U ${socket} < /dev/null`, { network: true, cls: 'research' })

      expect(confined.out).not.toContain('pong')
      expect(probeVerdict(confined, 'silent')).toBe('refused')
    } finally {
      server.close()
    }
  })

  it('exec of a binary outside every readable root is refused (and runs unconfined)', async () => {
    expect((await world.runPlain(`${world.outside}/run.sh`)).out).toContain('ran-outside')
    expect(probeVerdict(await world.runConfined(`${world.outside}/run.sh`))).toBe('refused')
  })

  it('the TCC tool cannot reach tccd from inside', async () => {
    expect(probeVerdict(await world.runConfined('tccutil reset All com.iclone.v3g.none'))).toBe('refused')
  })

  it('launchd, Apple Events and the keychain CLI are refused by name', async () => {
    for (const command of [
      '/bin/launchctl print gui/$(id -u)',
      "/usr/bin/osascript -e 'return 1'",
      '/usr/bin/security list-keychains'
    ]) {
      const outcome = await world.runConfined(command)

      expect(outcome.code).toBe(126)
    }
  })
})

describe.runIf(LIVE)('keychain — never, in any class, with or without the network', () => {
  it('the login keychain file and the keychain services are refused', async () => {
    const db = `${HOME}/Library/Keychains/login.keychain-db`

    expect((await world.runPlain(`head -c 4 ${db} > /dev/null`)).code, CONTROL_FAILED).toBe(0)

    for (const cls of ['research', 'project', 'build', 'offline', 'media'] as const) {
      expect(probeVerdict(await world.runConfined(`head -c 4 ${db}`, { cls, network: true }))).toBe('refused')
    }
  })
})

describe.runIf(LIVE)('G5 — 30 unnamed capabilities, 30/30 refused', () => {
  const CASES = [
    `cat ${HOME}/.zsh_history`,
    `ls ${HOME}/.ssh`,
    `ls ${HOME}/.aws`,
    `ls ${HOME}/.gnupg`,
    `ls ${HOME}/.config`,
    `cat ${HOME}/.gitconfig`,
    `cat ${HOME}/.npmrc`,
    `ls ${HOME}/.docker`,
    `ls ${HOME}/.kube`,
    `ls ${HOME}/Library/Keychains`,
    'ls /Library/Keychains',
    'ls /Volumes',
    `ls ${HOME}/Documents`,
    `ls ${HOME}/Downloads`,
    `ls ${HOME}/Library/Mail`,
    `ls ${HOME}/Library/Messages`,
    'ls /Users/Shared',
    'ls /Applications',
    'ls /private/var/folders',
    `touch ${HOME}/Library/LaunchAgents/iclone-v3g.plist`,
    'touch /Users/Shared/iclone-v3g',
    'touch /private/tmp/iclone-v3g',
    'launchctl list',
    'osascript -e \'tell application "Finder" to get name\'',
    'open -g -a TextEdit',
    '/usr/bin/sudo -n true',
    'crontab -l',
    'pbpaste',
    'kill -0 <peer>',
    'nc -zv -G 2 127.0.0.1 <listener>'
  ]

  // A row with no entry here is its own control. These would act on the owner's machine if run unconfined (write
  // outside, drive Finder, open an app), so the control proves only that the target is there.
  const CONTROLS: Record<string, string> = {
    [`touch ${HOME}/Library/LaunchAgents/iclone-v3g.plist`]: `test -d ${HOME}/Library/LaunchAgents`,
    'touch /Users/Shared/iclone-v3g': 'test -d /Users/Shared',
    'touch /private/tmp/iclone-v3g': 'test -d /private/tmp',
    'launchctl list': 'test -x /bin/launchctl',
    'osascript -e \'tell application "Finder" to get name\'': 'test -x /usr/bin/osascript',
    'open -g -a TextEdit': 'test -x /usr/bin/open',
    '/usr/bin/sudo -n true': 'test -x /usr/bin/sudo',
    'crontab -l': 'test -x /usr/bin/crontab',
    pbpaste: 'pbpaste > /dev/null'
  }

  let peer: ChildProcess
  let listener: Awaited<ReturnType<typeof listenTcp>>

  beforeAll(async () => {
    // Not pid 1: signalling that is EPERM for any non-root process, sandboxed or not, so it proves nothing.
    peer = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
    listener = await listenTcp()
  })

  afterAll(() => {
    peer?.kill('SIGKILL')
    listener?.close()
  })

  const resolved = (row: string) => row.replace('<peer>', String(peer.pid)).replace('<listener>', String(listener.port))

  it('has 30 cases', () => {
    expect(CASES).toHaveLength(30)
  })

  it.each(CASES)('refused: %s', async row => {
    const command = resolved(row)

    expect((await world.runPlain(CONTROLS[row] ?? command)).code, CONTROL_FAILED).toBe(0)
    expect(probeVerdict(await world.runConfined(command), row === 'pbpaste' ? 'silent' : 'observed')).toBe('refused')
  })

  it('left nothing behind', () => {
    for (const file of [
      `${HOME}/Library/LaunchAgents/iclone-v3g.plist`,
      '/Users/Shared/iclone-v3g',
      '/private/tmp/iclone-v3g'
    ]) {
      expect(existsSync(file)).toBe(false)
    }
  })
})

describe.runIf(LIVE)('positive controls — the confinement still lets the work happen', () => {
  it('reads and writes the project, runs git and the shell builtins', async () => {
    const outcome = await world.runConfined(
      'echo ok > made.txt && cat made.txt && cat README.md && pwd && git --version'
    )

    expect(outcome.code).toBe(0)
    expect(outcome.out).toContain('ok')
    expect(outcome.out).toContain('inside')
    expect(outcome.out).toContain(world.project)
    expect(readFileSync(path.join(world.project, 'made.txt'), 'utf8')).toBe('ok\n')
  })

  it('Plan mode (WRITE_PROJECT=0) reads the project but cannot write it', async () => {
    expect((await world.runConfined('cat README.md', { writeProject: false })).code).toBe(0)
    expect(probeVerdict(await world.runConfined('touch plan.txt', { writeProject: false }))).toBe('refused')
  })

  it('research reads the project, writes only its scratch', async () => {
    expect((await world.runConfined('cat README.md', { cls: 'research' })).code).toBe(0)
    expect(probeVerdict(await world.runConfined('touch research.txt', { cls: 'research' }))).toBe('refused')
    expect((await world.runConfined('touch "$TMPDIR/r.txt"', { cls: 'research' })).code).toBe(0)
  })

  it('media writes its one output dir and not the project', async () => {
    const output = path.join(world.root, 'media-out')

    mkdirSync(output, { recursive: true })
    expect((await world.runConfined(`cp README.md ${output}/copy.md`, { cls: 'media', outputDir: output })).code).toBe(
      0
    )
    expect(probeVerdict(await world.runConfined('touch media.txt', { cls: 'media', outputDir: output }))).toBe(
      'refused'
    )
  })

  it('the network opens with a grant for research/project/build, never for offline', async () => {
    const server = await listenTcp()

    try {
      // The grant is the internet (the machine's own addresses are loopback to Seatbelt, F4): a public resolver.
      const internet = 'nc -zv -G 3 1.1.1.1 443'

      expect((await world.runPlain(internet)).code, 'this Mac must reach the internet for the control').toBe(0)

      for (const cls of ['research', 'project', 'build'] as const) {
        expect((await world.runConfined(internet, { cls, network: true })).code, cls).toBe(0)
      }

      expect(probeVerdict(await world.runConfined(internet, { cls: 'offline', network: true }))).toBe('refused')
      expect(
        probeVerdict(
          await world.runConfined(`nc -zv -G 2 127.0.0.1 ${server.port}`, { cls: 'project', network: false })
        )
      ).toBe('refused')
    } finally {
      server.close()
    }
  })

  it('a project root the layer refuses (the home) falls back to the scratch dir', async () => {
    const outcome = await world.runConfined('pwd; touch here.txt', { projectRoot: HOME, cwd: world.root })

    expect(probeVerdict(outcome)).toBe('refused')
    expect(existsSync(path.join(HOME, 'here.txt'))).toBe(false)
  })
})

describe.runIf(LIVE)('F4 — a network grant is the internet: loopback and local services stay shut', () => {
  it.each(['research', 'project', 'build'] as const)(
    '%s with NET=1 cannot reach 127.0.0.1, ::1 or its own LAN address',
    async cls => {
      const v4 = await listenTcp('0.0.0.0')
      const v6 = await listenTcp('::1')

      try {
        for (const target of [`127.0.0.1 ${v4.port}`, `::1 ${v6.port}`, `${lanAddress()} ${v4.port}`]) {
          expect((await world.runPlain(`nc -zv -G 2 ${target}`)).code, target).toBe(0)
          expect(probeVerdict(await world.runConfined(`nc -zv -G 2 ${target}`, { cls, network: true })), target).toBe(
            'refused'
          )
        }
      } finally {
        v4.close()
        v6.close()
      }
    }
  )
})

describe.runIf(LIVE)('F3 — no write hole outside the per-run scratch (the xcrun cache allowance is gone)', () => {
  it('/private/tmp/xcrun_db-* and the per-user temp xcrun_db* are refused; git still runs', async () => {
    const tag = `v3g-${process.pid}-${Date.now()}`
    const userTemp = realOrSelf(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim())

    const targets = [
      `/private/tmp/xcrun_db-${tag}`,
      path.join(userTemp, `xcrun_db-${tag}`),
      path.join(userTemp, `xcrun_dbANY${tag}`)
    ]

    try {
      for (const target of targets) {
        for (const network of [false, true]) {
          expect(probeVerdict(await world.runConfined(`echo p > ${target}`, { network })), target).toBe('refused')
          expect(existsSync(target), target).toBe(false)
        }
      }

      expect((await world.runConfined('/usr/bin/git --version')).code).toBe(0)
    } finally {
      targets.forEach(target => rmSync(target, { force: true }))
    }
  })
})

describe.runIf(LIVE)('G3 — the pane count is derived from ps, never cached', () => {
  it('3 confined commands appear as 3 roots, and 0 after they are killed', async () => {
    const spawned = await Promise.all(
      [1, 2, 3].map(() =>
        world.backend.spawn({
          cls: 'project',
          argv: ['/bin/sleep', '30'],
          cwd: world.project,
          env: { PATH: '/usr/bin:/bin' },
          projectRoot: world.project,
          network: false,
          writeProject: true,
          sessionId: 'v3g-g3'
        })
      )
    )

    const pids = spawned.map(item => (item.ok ? item.pid : 0))

    expect(pids.every(Boolean)).toBe(true)
    await waitFor(async () => roots(await world.scan(), pids).length === 3, 2_000)

    for (const pid of pids) {
      const result = await world.backend.kill(pid)

      expect(result.ok).toBe(true)
    }

    await waitFor(async () => roots(await world.scan(), pids).length === 0, 2_000)
  })
})

describe.runIf(LIVE)('G2 — Kill ends the whole confined tree (PID proof), 10/10', () => {
  it.each(Array.from({ length: 10 }, (_, index) => index))('trial %i', async () => {
    const result = await world.backend.spawn({
      cls: 'project',
      argv: ['/bin/sh', '-c', '/bin/sleep 60 & /bin/sleep 60 & wait'],
      cwd: world.project,
      env: { PATH: '/usr/bin:/bin' },
      projectRoot: world.project,
      network: false,
      writeProject: true,
      sessionId: 'v3g-g2'
    })

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    let tree: number[] = []

    await waitFor(async () => {
      tree = world.backend
        .list(await world.scan())
        .filter(item => item.root === result.pid)
        .map(item => item.pid)

      return tree.length >= 4
    }, 2_000)

    const started = Date.now()
    const killed = await world.backend.kill(result.pid)

    expect(killed.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(3_000)

    for (const pid of tree) {
      expect(() => process.kill(pid, 0)).toThrow()
    }

    const orphans = (await readPs()).filter(row => tree.includes(row.ppid))

    expect(orphans).toEqual([])
  })
})

describe.runIf(LIVE)('G4 — negative control: a widened profile turns the state RED, the restore turns it GREEN', () => {
  it('both directions, with the escape proven real', async () => {
    const project = world.profiles.find(item => item.spec.cls === 'project')

    if (!project) {
      throw new Error('no project profile')
    }

    const fold = async () => {
      const disk = profilesOnDisk(world.profiles)
      const snapshot = await world.scan()

      // Sibling live test files run their own worlds at the same time: a marked process under a profile this world
      // never generated (nor widened on disk) is another world's, not this one's.
      const known = [...world.profiles.map(knownProfile), ...disk.variants]
      const shas = new Set(known.map(item => item.sha256.slice(0, 12)))

      const rows = snapshot.rows.filter(row => {
        const marker = parseMarker(row.command)

        return !marker || shas.has(marker.sha12)
      })

      return foldState({
        now: new Date(),
        backend: 'seatbelt',
        enabled: true,
        notes: [],
        defaultClass: 'project',
        backends: [
          {
            id: 'seatbelt',
            status: 'ready',
            enforcing: true,
            version: null,
            detail: 'enforcing',
            evidence: '',
            ownerStep: null
          }
        ],
        profiles: world.profiles.map(profileView),
        known,
        tampered: disk.tampered,
        rows,
        verified: snapshot.verified,
        hermesPids: [],
        pluginAckPids: [],
        audit: [],
        refusals: [],
        hardlinks: [],
        // The command sandboxes alone: this world starts no runtime, whose confinement is folded on macOS only.
        darwin: false
      })
    }

    expect((await fold()).verdict).toBe('green')

    // Widen the file on disk, as a compromised spawner would, and run under it with an honest marker.
    const widenedText = `${project.text}(allow default)\n`
    const widenedSha = createHash('sha256').update(widenedText).digest('hex')

    writeFileSync(project.file, widenedText)

    // The backend never re-reads the file: it runs the text it generated, so the widened file confines nothing extra.
    expect(probeVerdict(await world.runConfined(`cat ${world.outside}/secret.txt`))).toBe('refused')

    const marker = confinementMarker('project', widenedSha, 'v3g-g4')

    const child = spawn(
      SANDBOX_EXEC,
      [
        '-f',
        project.file,
        '-D',
        `PROJECT_ROOT=${world.project}`,
        '-D',
        `SCRATCH=${world.root}/scratch/v3g-g4`,
        '-D',
        `MEMBER=${world.paths.membersDir}/none`,
        '/bin/bash',
        '-c',
        `cat ${world.outside}/secret.txt; /bin/sleep 20; exit $?`,
        marker
      ],
      { cwd: world.project, stdio: ['ignore', 'pipe', 'ignore'], detached: true }
    )

    let leaked = ''

    child.stdout?.on('data', chunk => (leaked += String(chunk)))

    try {
      await waitFor(async () => leaked.includes('outside-secret'), 3_000)

      const started = Date.now()
      const red = await fold()

      expect(Date.now() - started).toBeLessThan(2_000)
      expect(red.verdict).toBe('red')
      expect(red.reasons).toContainEqual({ code: 'profile-changed', cls: 'project' })
      // `(allow default)` lets it read the decoy, so the kernel says no icloneOS sandbox holds it: the marker lies.
      expect(red.reasons).toContainEqual({ code: 'forged-marker', pid: child.pid })
      expect(red.inside.some(item => item.pid === child.pid)).toBe(false)
    } finally {
      child.kill('SIGKILL')
      writeFileSync(project.file, project.text)
    }

    await waitFor(async () => (await fold()).verdict === 'green', 2_000)
    expect(probeVerdict(await world.runConfined(`cat ${world.outside}/secret.txt`))).toBe('refused')
  })
})

describe.runIf(LIVE)('R2 — refusals reach the log within 1 s (p95, G1), tagged as ours', () => {
  it(`5 planted denials are recorded${PERF_TAG}`, async ctx => {
    const log = createRefusalLog(path.join(world.root, 'refusals'))
    // Keyed by target: the log carries every confined run on the Mac, including other test files' running in
    // parallel, so "one more refusal arrived" is not "this one arrived" (it went red in a 6-worker full run).
    const arrived = new Map<string, number>()
    const arrivalOf = (name: string) => [...arrived].find(([target]) => target.includes(name))?.[1]

    const stream = startRefusalStream({
      log,
      membersDir: world.paths.membersDir,
      confined: async () => new Map(),
      onRefusal: refusal => arrived.set(refusal.target, Date.now())
    })

    try {
      await sleep(1_500)

      const latencies: number[] = []

      for (let index = 0; index < 5; index += 1) {
        const target = `${world.outside}/latency-${index}.txt`

        writeFileSync(target, 'planted\n')

        const started = Date.now()

        await world.runConfined(`cat ${target}`)
        await waitFor(async () => arrivalOf(`latency-${index}.txt`) !== undefined, 5_000)
        latencies.push((arrivalOf(`latency-${index}.txt`) ?? Date.now()) - started)
      }

      const recent = log.recent(500)

      expect(recent.some(item => item.target.includes('latency-0.txt'))).toBe(true)
      expect(recent.every(item => item.operation.length > 0)).toBe(true)

      // K105: the 1 s budget is the perf project's; the default run keeps the recording checks above.
      if (!PERF) {
        return
      }

      skipUnderLoad(ctx)
      latencies.sort((a, b) => a - b)
      expect(
        latencies[Math.ceil(latencies.length * 0.95) - 1],
        `latencies ${latencies.join(',')} ms`
      ).toBeLessThanOrEqual(1_000)
    } finally {
      stream.stop()
    }
  }, 30_000)
})

// K105: a wall-clock budget, so it runs in the perf project only (`npm run test:perf`), guarded against load.
describe.runIf(LIVE && PERF)('G7 — Seatbelt spawn overhead (baseline, n=40 here; the gate runs n=100)', () => {
  it(`p95 overhead stays within 50 ms${PERF_TAG}`, async ctx => {
    const n = Number(process.env.V3G_OVERHEAD_N ?? 40)
    const plain: number[] = []
    const confined: number[] = []

    for (let index = 0; index < n; index += 1) {
      let started = performance.now()

      await world.runPlain('true')
      plain.push(performance.now() - started)
      started = performance.now()
      await world.runConfined('true')
      confined.push(performance.now() - started)
    }

    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]

    skipUnderLoad(ctx)
    expect(p95(confined) - p95(plain)).toBeLessThanOrEqual(50)
  }, 60_000)
})

function roots(snapshot: Snapshot, pids: number[]) {
  return world.backend.list(snapshot).filter(item => item.pid === item.root && pids.includes(item.pid))
}

function readFileSnapshot(target: LiveWorld): Record<string, string> {
  const files = [
    path.join(target.paths.userDataDir, 'consent.json'),
    path.join(target.paths.hermesHome, 'config.yaml'),
    path.join(target.paths.profilesDir, 'project.sb')
  ]

  return Object.fromEntries(files.map(file => [file, readFileSync(file, 'utf8')]))
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await check()) {
      return
    }

    await sleep(50)
  }

  throw new Error(`condition not met within ${timeoutMs} ms`)
}

function lanAddress(): string {
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find(item => item && item.family === 'IPv4' && !item.internal)?.address

  if (!address) {
    throw new Error('this Mac has no LAN IPv4 address: the network positive control cannot run')
  }

  return address
}

// The probes are `nc -z` (connect, then hang up at once) and `nc -U`. When the peer is gone before this process reads
// the accepted socket, macOS reports `read ENOTCONN` (or a reset) on OUR side of the connection; with no listener that
// became an uncaught exception that failed the file after every test had passed. The proof is the nc exit code and
// output, never this side of the socket, so a peer hang-up is expected here; any other socket error still throws.
const PEER_HANGUP = new Set(['ENOTCONN', 'ECONNRESET', 'EPIPE'])
const LISTEN_TIMEOUT_MS = 5_000

function answer(reply: (socket: net.Socket) => void): (socket: net.Socket) => void {
  return socket => {
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!PEER_HANGUP.has(error.code ?? '')) {
        throw error
      }
    })
    reply(socket)
  }
}

// Resolves only once the server is listening, and rejects (closing it) on a listen error or after LISTEN_TIMEOUT_MS:
// a probe never runs against a server that is not there, and a server that never listens fails the test.
function listening(server: net.Server, start: (ready: () => void) => void, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer)
      server.close()
      reject(error)
    }

    const timer = setTimeout(
      () => fail(new Error(`${what} did not listen within ${LISTEN_TIMEOUT_MS} ms`)),
      LISTEN_TIMEOUT_MS
    )

    server.once('error', fail)
    start(() => {
      clearTimeout(timer)
      server.off('error', fail)
      resolve()
    })
  })
}

async function listenTcp(host = '0.0.0.0'): Promise<{ port: number; close: () => void }> {
  const server = net.createServer(answer(socket => socket.end()))

  await listening(server, ready => server.listen(0, host, ready), `the TCP control server on ${host}`)

  const address = server.address()

  if (typeof address !== 'object' || !address || !address.port) {
    server.close()

    throw new Error(`the TCP control server on ${host} has no port`)
  }

  return { port: address.port, close: () => server.close() }
}

async function listenUnix(file: string): Promise<{ close: () => void }> {
  rmSync(file, { force: true })

  const server = net.createServer(answer(socket => socket.end('pong\n')))

  await listening(server, ready => server.listen(file, ready), `the unix control server at ${file}`)

  return { close: () => server.close() }
}
