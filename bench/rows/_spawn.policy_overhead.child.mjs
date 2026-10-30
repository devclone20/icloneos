// Child process of the `spawn.policy_overhead` row: the app's real macOS spawn-policy backend with profiles made by
// the real generator, timed against a plain spawn of the same command. Prints one JSON line. Electron is replaced by
// an inert stub (nothing on the timed path imports it).
import '../lib/ts-hook.mjs'

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { writeResult } from '../lib/child_result.mjs'

const args = JSON.parse(process.argv[2] ?? '{}')
const C = new URL('../../apps/desktop/electron/iclone-confinement/', import.meta.url)
const { createSeatbeltBackend, generateProfiles } = await import(new URL('backend-seatbelt.ts', C).href)
const { scanTree } = await import(new URL('hardlinks.ts', C).href)

const root = fs.realpathSync(args.scratch)
const home = path.join(root, 'home')
const paths = {
  home,
  hermesHome: path.join(home, '.hermes'),
  userDataDir: path.join(root, 'userData'),
  hermesRoot: null,
  profilesDir: path.join(root, 'userData', 'confinement', 'profiles'),
  scratchRoot: path.join(root, 'runs'),
  membersDir: path.join(root, 'members')
}
for (const dir of [paths.hermesHome, paths.userDataDir, paths.scratchRoot, paths.membersDir, path.join(home, '.ssh')]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}
// Secrets the profiles must refuse (planted in the temp HOME only), and one file every class may read.
const MARK = 'BENCH-SECRET-MARK'
const secrets = [
  path.join(home, '.ssh', 'id_ed25519'),
  path.join(paths.hermesHome, '.env'),
  path.join(paths.userDataDir, 'master.sealed')
]
for (const file of secrets) fs.writeFileSync(file, `${MARK}\n`, { mode: 0o600 })

const profiles = generateProfiles(paths)
// The hardlink guard is replaced by its own walker (scanTree, timed separately below): the guard's sealed-key plumbing needs
// the Keychain. Everything else on the spawn path is the shipped code.
const backend = createSeatbeltBackend({
  paths,
  profiles: () => profiles,
  scan: async () => ({ rows: [], verified: false }),
  hardlinks: { check: () => ({ ok: true }) },
  sandboxExec: args.profileRunner || undefined
})
const hr = () => Number(process.hrtime.bigint()) / 1e6
const finish = child =>
  new Promise(resolve => {
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', () => {})
    child.once('close', code => resolve({ code, out }))
  })
const env = { PATH: '/usr/bin:/bin', HOME: home }
async function withPolicy(argv, cls = 'offline') {
  const t0 = hr()
  const res = backend.spawn({
    cls,
    argv,
    cwd: root,
    env,
    projectRoot: null,
    network: false,
    writeProject: false,
    sessionId: 'benchrun'
  })
  if (!res.ok) throw new Error(`spawn refused: ${res.error}`)
  const done = await finish(res.child)
  return { ms: hr() - t0, scratch: res.params.SCRATCH, ...done }
}
const quote = word => `'${word.replace(/'/g, `'\\''`)}'`
async function plain(argv) {
  const t0 = hr()
  // detached mirrors backend.spawn (it calls setsid) so both arms of a pair pay the same setsid cost; the
  // commands are /usr/bin/true and cat and exit in milliseconds.
  const child = spawn('/bin/bash', ['-c', `${argv.map(quote).join(' ')}; exit $?`, 'bench'], {
    cwd: root,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const done = await finish(child)
  return { ms: hr() - t0, ...done }
}

const n = Number(args.n ?? 30)
const pairs = []
let sessionScratch = null
for (let i = 0; i < n; i += 1) {
  // Alternate the order so neither side always runs on a warmer cache.
  const a = i % 2 ? await plain(['/usr/bin/true']) : null
  const c = await withPolicy(['/usr/bin/true'])
  const u = a ?? (await plain(['/usr/bin/true']))
  if (c.code !== 0 || u.code !== 0) throw new Error(`true exited ${c.code}/${u.code}`)
  sessionScratch = c.scratch
  pairs.push({ policy: c.ms, plain: u.ms })
}
// The positive control: a file in the run's own scratch (the profile's SCRATCH) must stay readable.
const allowed = path.join(sessionScratch, 'readable.txt')
fs.writeFileSync(allowed, 'public\n')
// Refusals: every class x every planted secret x reps must be refused; the readable file must be read.
const refusal = { attempts: 0, refused: 0, leaked: [], allowedOk: 0, allowedTries: 0 }
for (const cls of ['research', 'project', 'build', 'offline', 'media']) {
  for (let rep = 0; rep < Number(args.reps ?? 2); rep += 1) {
    for (const file of secrets) {
      const r = await withPolicy(['/bin/cat', file], cls)
      refusal.attempts += 1
      if (r.code !== 0 && !r.out.includes(MARK)) refusal.refused += 1
      else refusal.leaked.push(`${cls}:${path.relative(root, file)}`)
    }
    const ok = await withPolicy(['/bin/cat', allowed], cls)
    refusal.allowedTries += 1
    if (ok.code === 0 && ok.out.includes('public')) refusal.allowedOk += 1
  }
}
const plainLeak = (await plain(['/bin/cat', secrets[0]])).out.includes(MARK)
// The hard-link walker on a non-empty tree: 100 folders x 100 files, 10 of them hard links (what a project root holds).
const scanRoot = path.join(root, 'scan-tree')
for (let a = 0; a < 100; a += 1) {
  const dir = path.join(scanRoot, `d${a}`)
  fs.mkdirSync(dir, { recursive: true })
  for (let b = 0; b < 100; b += 1) fs.writeFileSync(path.join(dir, `f${b}.txt`), 'x')
}
for (let k = 0; k < 10; k += 1)
  fs.linkSync(path.join(scanRoot, `d${k}`, 'f0.txt'), path.join(scanRoot, `d${k}`, 'link.txt'))
const scan = []
for (let i = 0; i < 20; i += 1) {
  const t0 = hr()
  scanTree(scanRoot)
  scan.push(hr() - t0)
}
writeResult(args.result, { pairs, refusal, plainLeak, scan, profiles: profiles.length })
process.exit(0)
