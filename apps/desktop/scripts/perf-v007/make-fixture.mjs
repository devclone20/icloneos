#!/usr/bin/env node
// v0.0.7 PERF gates: the throwaway fixtures the gates measure against (electron/perf-v007/*.perf.test.ts).
//
//   node scripts/perf-v007/make-fixture.mjs <dir> [--files 300000] [--dirs 30000]   a project tree
//   node scripts/perf-v007/make-fixture.mjs <dir> --audit 200000                    a permissions dir with a chain
//
// <dir> must resolve under /private/tmp and never under the real home (judged by getpwuid, not $HOME). It must not
// exist, or be a fixture this script made (marker file), which is then replaced.
//
// Tree: `--dirs` directories in a breadth-first tree of fanout 16 and `--files` small regular files spread over them
// round-robin, every name and byte derived from its index, so two runs give the same tree. Every 997th file gets a
// second name in another directory of the tree (an inside-only hard link: the guard's nlink path runs, and the root is
// still clean, so every check answers ok).
//
// Audit: `<dir>/permissions/` exactly as the app lays it out (keys.ts master + audit/ day files + head anchor), written
// by the app's own createAuditLog and loadPermissionKeys, bundled from the TypeScript sources with esbuild. The master
// is sealed by PERF_SEALER below (a test key: reversible base64, never the Keychain); the gate opens it with the same.
import { mkdirSync, linkSync, existsSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MARKER = '.perf-v007-fixture'
const FANOUT = 16
const LINK_EVERY = 997
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..', '..')

/** The test sealer the gates share: a fixture master is never a real secret, and must reopen in another process. */
export const PERF_SEALER = {
  seal: plain => `perfv007:${Buffer.from(plain, 'utf8').toString('base64')}`,
  unseal: sealed => {
    if (!sealed.startsWith('perfv007:')) {
      throw new Error('not sealed by the perf-v007 sealer')
    }

    return Buffer.from(sealed.slice('perfv007:'.length), 'base64').toString('utf8')
  }
}

function fail(message) {
  console.error(`make-fixture: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const [dir, ...rest] = argv
  const opts = { dir, files: 300_000, dirs: 30_000, audit: 0 }

  if (!dir || dir.startsWith('--')) {
    fail('usage: make-fixture.mjs <dir> [--files N --dirs M] | <dir> --audit N')
  }

  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].replace(/^--/, '')
    const value = Number.parseInt(rest[i + 1] ?? '', 10)

    if (!['files', 'dirs', 'audit'].includes(name) || !Number.isInteger(value) || value < 1 || value > 5_000_000) {
      fail(`bad option ${rest[i]} ${rest[i + 1] ?? ''}`)
    }

    opts[name] = value
  }

  return opts
}

/** Resolves <dir> through its existing parent and refuses anything outside /private/tmp or inside the real home. */
export function safeFixtureDir(dir) {
  const absolute = path.resolve(dir)
  const parent = realpathSync(path.dirname(absolute))
  const target = path.join(parent, path.basename(absolute))
  const realHome = realpathSync(os.userInfo().homedir)

  if (!target.startsWith('/private/tmp/') || target === '/private/tmp/') {
    fail(`refusing ${target}: fixtures live only under /private/tmp`)
  }

  if (target === realHome || target.startsWith(`${realHome}/`) || realHome.startsWith(`${target}/`)) {
    fail(`refusing ${target}: inside (or holding) the real home ${realHome}`)
  }

  if (existsSync(target)) {
    if (!existsSync(path.join(target, MARKER))) {
      fail(`refusing ${target}: exists and is not a perf-v007 fixture`)
    }

    rmSync(target, { recursive: true, force: true })
  }

  mkdirSync(target, { mode: 0o700 })
  writeFileSync(path.join(target, MARKER), 'perf-v007 throwaway fixture\n', { mode: 0o600 })

  return target
}

/** Directory i's path relative to the root: breadth-first, so its parent is floor((i - 1) / FANOUT). */
function dirPath(index) {
  const parts = []

  for (let i = index; i > 0; i = Math.floor((i - 1) / FANOUT)) {
    parts.push(`d${String(i).padStart(5, '0')}`)
  }

  return parts.reverse().join('/')
}

function makeTree(root, files, dirs) {
  const started = Date.now()
  const dirNames = Array.from({ length: dirs }, (_, i) => path.join(root, 'tree', dirPath(i)))

  for (const dir of dirNames) {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
  }

  let links = 0

  for (let i = 0; i < files; i += 1) {
    const dir = dirNames[i % dirs]
    const file = path.join(dir, `f${String(i).padStart(7, '0')}.txt`)

    writeFileSync(file, `perf-v007 file ${i}\n`)

    if (i % LINK_EVERY === 0) {
      linkSync(file, path.join(dirNames[(i * 7 + 3) % dirs], `l${String(i).padStart(7, '0')}.txt`))
      links += 1
    }
  }

  return { root, files, dirs, insideLinks: links, ms: Date.now() - started }
}

async function loadAuditModules(root) {
  const { build } = await import('esbuild')
  const outfile = path.join(root, '.bundle', 'audit-modules.mjs')
  const audit = path.join(DESKTOP, 'electron', 'iclone-permissions', 'audit.ts')
  const keys = path.join(DESKTOP, 'electron', 'iclone-permissions', 'keys.ts')

  await build({
    stdin: {
      contents: `export { createAuditLog, verifyAuditChain } from ${JSON.stringify(audit)}\nexport { loadPermissionKeys } from ${JSON.stringify(keys)}\n`,
      resolveDir: DESKTOP,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    logLevel: 'error'
  })

  return import(pathToFileURL(outfile).href)
}

const SAMPLE_KINDS = ['use', 'ask', 'answer', 'use', 'use', 'refuse', 'grant', 'use']

async function makeAudit(root, count) {
  const started = Date.now()
  const { createAuditLog, loadPermissionKeys, verifyAuditChain } = await loadAuditModules(root)
  const permissions = path.join(root, 'permissions')

  mkdirSync(permissions, { recursive: true, mode: 0o700 })

  const keys = loadPermissionKeys(permissions, PERF_SEALER)

  if (!keys.sealed) {
    fail('the permission master did not seal with the test sealer')
  }

  // One record a minute from 2026-01-01: ~139 day files for 200 000 records, the shape a long-lived install has.
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  const log = createAuditLog({
    dir: path.join(permissions, 'audit'),
    key: keys.auditKey,
    kid: keys.kid,
    durable: false,
    now: () => new Date(clock)
  })

  try {
    for (let i = 0; i < count; i += 1) {
      clock += 60_000

      const kind = SAMPLE_KINDS[i % SAMPLE_KINDS.length]

      log.append({
        src: 'main',
        kind,
        class: 'X',
        mode: 'manual',
        answer: kind === 'answer' ? 'once' : null,
        action: { tool: 'terminal', target: `echo perf-v007 ${i}`, project_root: '/private/tmp/perf-v007-project' },
        reason: kind === 'refuse' ? 'perf-v007 sample refusal' : null
      })
    }
  } finally {
    log.close()
  }

  const report = verifyAuditChain(path.join(permissions, 'audit'), { key: keys.auditKey, kid: keys.kid })

  if (!report.ok || report.records !== count) {
    fail(`the written chain does not verify: ${JSON.stringify({ ok: report.ok, records: report.records })}`)
  }

  const dayFiles = readdirSync(path.join(permissions, 'audit')).filter(name => name.endsWith('.jsonl')).length

  return { root, permissions, records: report.records, dayFiles, verified: report.ok, ms: Date.now() - started }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const root = safeFixtureDir(opts.dir)
  const result = opts.audit > 0 ? await makeAudit(root, opts.audit) : makeTree(root, opts.files, opts.dirs)

  console.log(`FIXTURE_JSON ${JSON.stringify(result)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
