#!/usr/bin/env node
// verify-packaged-acp-tree.mjs — prove an `acp-cli` tree (staged `build/acp-cli`, or `Resources/acp-cli` inside a
// built bundle) still answers every command the app runs, WITHOUT launching the app: each verb of the app's
// own windows (electron/iclone-acp-argv.ts `RULES`) and of the agent's allowlist (electron/iclone-acp-ipc.ts
// `AGENT_COMMANDS`) must print its own `--help` usage, the shared self-test (`chain list --json`) must pass, and the
// read-only runs (`READ_ONLY_RUNS`: `--version`, `skill path|print|check`) must exit 0 with their data — a `--help`
// never opens a data file.
// The verbs run under the dev Electron as Node — the runtime of the app's utility process — so a pruned file any
// verb loads at startup fails here, not on a user's Mac.
//
//   node scripts/verify-packaged-acp-tree.mjs                 # build/acp-cli
//   node scripts/verify-packaged-acp-tree.mjs <dir | app.app>  # an acp-cli dir, or the one inside a bundle
//
// Complements verify-packaged-acp.mjs (the signed app's own `--iclone-selftest`), which a locally signed build
// cannot run on this Mac (RESUME/scout/R7_pack_hang_macos26.md).

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACP_CLI_VERSION } from './acp-cli-version.mjs'
import { acpLayout, selfTestAcp } from './acp-selftest.mjs'
import { isMain } from './utils.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const AGENT_SOURCE = path.join('electron', 'iclone-acp-ipc.ts')
const RULES_SOURCE = path.join('electron', 'iclone-acp-argv.ts')

const OPENERS = '{[('
const CLOSERS = '}])'
// After one of these, a `/` opens a regex literal (`re(/^[a-z]{1,20}$/)`, `v => /x/`), not a division.
const BEFORE_REGEX = '(,=:[!&|?{};>'
// ...and after one of these keywords (`return /x/`), where any other word before it makes it a division.
const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'instanceof',
  'void',
  'delete',
  'throw',
  'yield',
  'await'
])

/** A `/` right after the token that ends at `at` (the previous significant character) opens a regex literal. */
function regexMayFollow(source, at) {
  if (BEFORE_REGEX.includes(source[at])) {
    return true
  }

  let from = at

  while (from > 0 && /[\w$]/.test(source[from - 1])) {
    from--
  }

  return /[\w$]/.test(source[at]) && source[from - 1] !== '.' && KEYWORDS_BEFORE_REGEX.has(source.slice(from, at + 1))
}

/** Index of the quote that closes the string or template literal opened at `start`. */
function closingQuote(source, start) {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
    } else if (source[i] === source[start]) {
      return i
    }
  }

  throw new Error(`unterminated string at offset ${start}`)
}

/** Index of the `/` that closes the regex literal opened at `start` (one inside a character class does not). */
function closingSlash(source, start) {
  let inClass = false

  for (let i = start + 1; i < source.length && source[i] !== '\n'; i++) {
    if (source[i] === '\\') {
      i++
    } else if (source[i] === '[' || source[i] === ']') {
      inClass = source[i] === '['
    } else if (source[i] === '/' && !inClass) {
      return i
    }
  }

  throw new Error(`unterminated regex at offset ${start}`)
}

/** The top-level entries of the object literal declared by `marker`: `{ key, value, strings }`, where `value` is the
 *  entry's source text and `strings` the string literals one level inside it (a list's items). A depth scanner, not
 *  a line regex: quoted and bare keys alike, values over many lines, and quotes or brackets inside strings, regexes
 *  and comments never hide or invent an entry. A top-level member that is not `key: value` (spread, shorthand,
 *  computed key) is refused, so no verb is ever skipped in silence. */
export function topLevelEntries(source, marker) {
  const start = source.indexOf(marker)
  const open = start < 0 ? -1 : source.indexOf('{', source.indexOf('=', start))

  if (open < 0) {
    throw new Error(`${marker} literal not found`)
  }

  const entries = []
  let depth = 0
  let prevAt = -1
  let tokens = []
  let entry = null

  const refuse = at => {
    throw new Error(`${marker}: unsupported member before offset ${at}`)
  }

  const finish = at => {
    if (entry) {
      entries.push({ ...entry, value: source.slice(entry.from, at).trim() })
    } else if (tokens.length > 0) {
      refuse(at)
    }

    entry = null
    tokens = []
  }

  for (let i = open; i < source.length; i++) {
    const c = source[i]

    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const end = source[i + 1] === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2) + 1

      i = end <= 0 ? source.length : end
      continue
    }

    if (/\s/.test(c)) {
      continue
    }

    if (c === "'" || c === '"' || c === '`') {
      const end = closingQuote(source, i)
      const text = source.slice(i + 1, end)

      if (depth === 1 && !entry) {
        tokens.push({ text, quoted: true })
      } else if (depth === 2 && entry) {
        entry.strings.push(text)
      }

      i = end
    } else if (c === '/' && regexMayFollow(source, prevAt)) {
      i = closingSlash(source, i)
    } else if (OPENERS.includes(c)) {
      if (depth === 1 && !entry) {
        refuse(i)
      }

      depth++
    } else if (CLOSERS.includes(c)) {
      depth--

      if (depth === 0) {
        finish(i)

        return entries
      }
    } else if (depth === 1 && c === ',') {
      finish(i)
    } else if (depth === 1 && !entry && c === ':') {
      if (tokens.length !== 1) {
        refuse(i)
      }

      entry = { key: tokens[0].text, from: i + 1, strings: [] }
    } else if (depth === 1 && !entry) {
      const last = tokens.at(-1)

      if (!/[\w$]/.test(c) || (last && (last.quoted || !/[\w$]/.test(source[i - 1])))) {
        refuse(i)
      }

      if (last) {
        last.text += c
      } else {
        tokens.push({ text: c, quoted: false })
      }
    }

    prevAt = i
  }

  throw new Error(`${marker} literal not closed`)
}

/** Every argv the agent may run, as `[root]` and `[root, sub]`, read from the `AGENT_COMMANDS` literal. */
export function appAcpVerbs(source) {
  return topLevelEntries(source, 'export const AGENT_COMMANDS').flatMap(({ key, value, strings }) => {
    if (value !== 'null' && !value.startsWith('[')) {
      throw new Error(`AGENT_COMMANDS.${key}: expected null or a list literal`)
    }

    return [[key], ...strings.map(sub => [key, sub])]
  })
}

/** Every argv the app's own windows run: the keys of the `RULES` literal (`'card limit set': {…}` → 3 words). */
export function appRuleVerbs(source) {
  return topLevelEntries(source, 'const RULES').map(({ key }) => key.split(' '))
}

/** The dev Electron binary run as Node, else this Node. */
export function treeRunner(root = projectRoot) {
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

  return existsSync(electron)
    ? { exec: electron, env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { exec: process.execPath, env: {} }
}

/** `--help` answered for exactly this verb. Commander prints the PARENT's usage (exit 0) for a verb it does not know:
 *  that is `unknown` (the app's allowlist and the pinned CLI disagree), not `broken` (a crash, e.g. a pruned file). */
export function judgeHelp(argv, { code, stdout }) {
  const usage = stdout.split('\n').find(line => line.startsWith('Usage: ')) ?? ''
  const want = `Usage: acp ${argv.join(' ')}`

  if (code !== 0) {
    return { ok: false, unknown: false, error: `exit ${code}` }
  }

  return usage === want || usage.startsWith(`${want} `)
    ? { ok: true, unknown: false }
    : { ok: false, unknown: true, error: `usage "${usage}"` }
}

function runOnce(exec, args, options) {
  return new Promise(resolve => {
    const child = spawn(exec, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)

    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', error => err.push(Buffer.from(error.message)))
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** Run the tree's CLI once per argv (bounded concurrency) in a throwaway config dir; the raw `{ code, stdout, stderr }`
 *  per argv. `preload` is a CommonJS module the runtime loads first (`--require`), `env` extra variables. */
async function runAcpAll({
  root,
  argvs,
  runner = treeRunner(),
  concurrency = 8,
  timeoutMs = 60_000,
  preload,
  env = {}
}) {
  const layout = acpLayout(root)
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-run-'))

  const runEnv = {
    HOME: os.homedir(),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    ACP_CONFIG_DIR: configDir,
    DOTENV_CONFIG_PATH: path.join(configDir, 'no-dotenv'),
    DOTENV_CONFIG_QUIET: 'true',
    NODE_PATH: layout.nodeModules,
    ...runner.env,
    ...env
  }

  const lead = preload ? ['--require', preload] : []
  const results = new Array(argvs.length)
  let next = 0

  async function worker() {
    for (let index = next++; index < argvs.length; index = next++) {
      results[index] = await runOnce(runner.exec, [...lead, layout.launcher, layout.entry, ...argvs[index]], {
        cwd: configDir,
        env: runEnv,
        timeoutMs
      })
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, argvs.length) }, worker))
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }

  return results
}

/** Run `acp <verb> --help` for every verb (bounded concurrency); returns `{ argv, ok, error }` per verb. */
export async function helpAll({ root, verbs, runner, concurrency, timeoutMs }) {
  const runs = await runAcpAll({ root, argvs: verbs.map(argv => [...argv, '--help']), runner, concurrency, timeoutMs })

  return runs.map((run, index) => ({ argv: verbs[index], ...judgeHelp(verbs[index], run) }))
}

function parsedJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** '' when `file` is an existing file inside `root`, else why not. */
function fileInside(file, root) {
  const rel = typeof file === 'string' ? path.relative(root, file) : '..'

  if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel) || !existsSync(file) || !statSync(file).isFile()) {
    return `path ${file} is not a file of the tree`
  }

  return ''
}

/** Local commands that READ the CLI's package data at runtime, which no `--help` opens (FR r2: a pruned SKILL.md
 *  passed every `--help`); the agent's own skills tell it to run `acp skill print`. Each is judged by its data:
 *  `check(stdout, { root, version })` returns '' or why it failed. */
export const READ_ONLY_RUNS = [
  {
    argv: ['--version'],
    check: (out, { version }) => (out.trim() === version ? '' : `printed "${out.trim().slice(0, 60)}"`)
  },
  { argv: ['skill', 'path', '--json'], check: (out, { root }) => fileInside(parsedJson(out)?.path, root) },
  {
    argv: ['skill', 'print', '--json'],
    check: out => {
      const content = parsedJson(out)?.content

      return typeof content === 'string' && content.length > 10_000 ? '' : `printed ${out.length} bytes`
    }
  },
  {
    argv: ['skill', 'check', '--json'],
    check: out => (typeof parsedJson(out)?.skillHash === 'string' ? '' : 'no skillHash')
  }
]

/** One read-only run judged: exit 0 AND the data its check wants. */
export function judgeReadOnly({ argv, check }, { code, stdout, stderr }, context) {
  const error =
    code === 0 ? check(stdout, context) : `exit ${code}: ${(stderr || stdout).trim().split('\n')[0].slice(0, 160)}`

  return { argv, ok: !error, error }
}

/** Every `READ_ONLY_RUNS` entry against `root`: `{ argv, ok, error }` each. */
export async function readOnlyAll({ root, runner, version = ACP_CLI_VERSION, timeoutMs, preload, env }) {
  const argvs = READ_ONLY_RUNS.map(run => run.argv)
  const runs = await runAcpAll({ root, argvs, runner, concurrency: preload ? 1 : 4, timeoutMs, preload, env })

  return runs.map((run, index) => judgeReadOnly(READ_ONLY_RUNS[index], run, { root, version }))
}

/** Preload that records every path the CLI opens or probes through `node:fs` (synced into its ESM named imports) and
 *  appends them to `$ACP_TRACE_OUT` when the process exits. */
const READ_TRACE_HOOK = `'use strict'
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const { fileURLToPath } = require('node:url')
const seen = new Set()
const note = p => { try { seen.add(p instanceof URL ? fileURLToPath(p) : String(p)) } catch {} }
for (const name of ['readFileSync', 'openSync', 'existsSync', 'statSync', 'lstatSync', 'createReadStream']) {
  const original = fs[name]
  fs[name] = function (p, ...rest) { note(p); return original.call(this, p, ...rest) }
}
for (const name of ['readFile', 'open', 'stat']) {
  const original = fs.promises[name]
  fs.promises[name] = function (p, ...rest) { note(p); return original.call(this, p, ...rest) }
}
syncBuiltinESMExports()
process.on('exit', () => { fs.appendFileSync(process.env.ACP_TRACE_OUT, [...seen].join('\\n') + '\\n') })
`

/** The files under `root`'s node_modules that `READ_ONLY_RUNS` open or probe and that exist now. Run on the full tree
 *  before a prune: each must still exist after it (stage-acp-cli). Throws when a run fails or nothing was traced. */
export async function traceReads({ root, runner, version }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-trace-'))
  const hook = path.join(dir, 'trace.cjs')
  const out = path.join(dir, 'reads.txt')

  try {
    writeFileSync(hook, READ_TRACE_HOOK)

    const failed = (await readOnlyAll({ root, runner, version, preload: hook, env: { ACP_TRACE_OUT: out } })).filter(
      run => !run.ok
    )

    if (failed.length > 0) {
      throw new Error(
        `read-only runs failed on the full tree: ${failed.map(run => `acp ${run.argv.join(' ')}: ${run.error}`).join('; ')}`
      )
    }

    const top = `${realpathSync(acpLayout(root).nodeModules)}${path.sep}`
    const seen = existsSync(out) ? readFileSync(out, 'utf8').split('\n') : []

    const files = [...new Set(seen.filter(file => path.isAbsolute(file)).map(file => path.normalize(file)))]
      .filter(file => file.startsWith(top) && existsSync(file) && statSync(file).isFile())
      .sort()

    if (files.length === 0) {
      throw new Error('the read trace recorded no file of the tree')
    }

    return files
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `<app>.app` → its `Contents/Resources/acp-cli`; anything else is taken as an acp-cli dir. */
export function acpRootOf(target) {
  return target.endsWith('.app') ? path.join(target, 'Contents', 'Resources', 'acp-cli') : target
}

/** Failed `--help` results split: `stale` = an agent-allowlist verb the pinned CLI does not know (the parent's usage);
 *  a crash, or a verb of the app's own windows (`own`, joined argv) the CLI does not know, is `broken`. */
export function splitFailures(results, own) {
  const failed = results.filter(result => !result.ok)
  const isStale = result => result.unknown && !own.has(result.argv.join(' '))

  return { broken: failed.filter(result => !isStale(result)), stale: failed.filter(isStale) }
}

/** ok = the self-test passes, no verb is broken and the pinned CLI knows every verb the app's own windows run. An
 *  agent-allowlist verb the CLI does not know is `stale`: reported (the agent gets a usage error), not fatal. */
export async function verifyAcpTree({ root, agentSource, rulesSource, runner, expectVersion = ACP_CLI_VERSION }) {
  const selftest = selfTestAcp({ root, expectVersion })

  if (!selftest.ok) {
    return { ok: false, error: `self-test: ${selftest.error}`, broken: [], stale: [], readOnly: [] }
  }

  const own = new Set(appRuleVerbs(rulesSource).map(argv => argv.join(' ')))
  const keys = new Set([...own, ...appAcpVerbs(agentSource).map(argv => argv.join(' '))])
  const verbs = [...keys].map(key => key.split(' '))
  const { broken, stale } = splitFailures(await helpAll({ root, verbs, runner }), own)
  const readOnly = await readOnlyAll({ root, runner, version: expectVersion })
  const unread = readOnly.filter(run => !run.ok)
  const summary = {
    version: selftest.version,
    chains: selftest.chains,
    verbs: verbs.length,
    own: own.size,
    broken,
    stale,
    readOnly
  }

  if (broken.length > 0) {
    return { ok: false, error: `${broken.length}/${verbs.length} verbs are broken`, ...summary }
  }

  return unread.length === 0
    ? { ok: true, ...summary }
    : { ok: false, error: `${unread.length}/${readOnly.length} read-only runs failed`, ...summary }
}

/** Verify `root` against the app's argv tables under `sourceRoot` and print the verdict (stale verbs as a warning). */
export async function reportAcpTree(root, { sourceRoot = projectRoot } = {}) {
  const read = file => readFileSync(path.join(sourceRoot, file), 'utf8')
  const verdict = await verifyAcpTree({ root, agentSource: read(AGENT_SOURCE), rulesSource: read(RULES_SOURCE) })
  const stale = verdict.stale.map(result => result.argv.join(' '))

  if (stale.length > 0) {
    console.warn(
      `[verify-packaged-acp-tree] stale agent allowlist (${AGENT_SOURCE}), not in the pinned CLI: ${stale.join(', ')}`
    )
  }

  const passed = verdict.readOnly.filter(run => run.ok).length

  if (verdict.readOnly.length > 0) {
    console.log(
      `[verify-packaged-acp-tree] read-only runs ${passed}/${verdict.readOnly.length} (${READ_ONLY_RUNS.map(run => run.argv.filter(arg => arg !== '--json').join(' ')).join(', ')}) exit 0 with their data`
    )
  }

  if (verdict.ok) {
    console.log(
      `[verify-packaged-acp-tree] ok — ${root}: acp ${verdict.version}, ${verdict.chains} chains, ${verdict.verbs - stale.length}/${verdict.verbs} verbs answer --help (all ${verdict.own} the app's windows run), none broken`
    )
  } else {
    console.error(`[verify-packaged-acp-tree] FAILED — ${root}: ${verdict.error}`)

    for (const failure of verdict.broken.slice(0, 10)) {
      console.error(`  acp ${failure.argv.join(' ')} --help: ${failure.error}`)
    }

    for (const failure of verdict.readOnly.filter(run => !run.ok)) {
      console.error(`  acp ${failure.argv.join(' ')}: ${failure.error}`)
    }
  }

  return verdict
}

if (isMain(import.meta.url)) {
  const root = acpRootOf(path.resolve(process.argv[2] ?? path.join(projectRoot, 'build', 'acp-cli')))

  if (!(await reportAcpTree(root)).ok) {
    process.exit(1)
  }
}
