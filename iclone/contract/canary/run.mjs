#!/usr/bin/env node
// Sandboxed canary (contract decision 13, engine CLI E7): boots the CANDIDATE runtime from `git archive <rev>` of the
// app repo's upstream objects, with a throwaway HERMES_HOME and HOME, no network but a loopback stub LLM, and the
// runtime venv python run read-only. On that sandbox it runs the shipped probe plus a sandbox-only pass over the
// methods T1 no longer lists (the live probe never sends those), then drives every scenario in scenarios/ through
// one turn with a client that answers server requests exactly as the lock does.
//
//   node iclone/contract/canary/run.mjs --rev <sha> --out <dir> [--lock <lock.json>] [--python <venv python>]
//
// Writes <dir>/canary.json; exit 0 when the sandbox held (origin inside the archive, probe gone == M-GONE, 0 result
// frames, every scenario observed, <= 120 s), 1 when it did not, 2 on bad usage.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startStubLlm } from './stub-llm.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTRACT = path.dirname(HERE)
const REPO = path.resolve(CONTRACT, '..', '..')
const COMPAT = path.join(REPO, 'apps', 'desktop', 'electron', 'iclone-compat')
const LIMIT_MS = 120_000
const READY_MS = 60_000
const OUT_MARKER = '.iclone-canary'
// Packages whose resolution must land inside the archive before the gateway runs (fail closed).
const ORIGIN_PACKAGES = ['tui_gateway', 'hermes_cli', 'agent', 'tools', 'gateway', 'hermes_bootstrap', 'run_agent']

const BOOT = `
import importlib.util, json, os, runpy, sys
root = os.path.realpath(sys.argv[1])
origins = {}
for name in json.loads(sys.argv[2]):
    if not (os.path.isdir(os.path.join(root, name)) or os.path.isfile(os.path.join(root, name + ".py"))):
        continue
    spec = importlib.util.find_spec(name)
    origins[name] = os.path.realpath(spec.origin) if spec and spec.origin else None
sys.stderr.write("iclone-canary-origins " + json.dumps(origins) + "\\n")
sys.stderr.flush()
if not all(o and o.startswith(root + os.sep) for o in origins.values()) or "tui_gateway" not in origins:
    sys.exit(97)
sys.argv = [sys.argv[0]]
runpy.run_module("tui_gateway.entry", run_name="__main__", alter_sys=True)
`

function usage(message) {
  process.stderr.write(`canary: ${message}\nusage: run.mjs --rev <sha> --out <dir> [--lock <file>] [--python <file>]\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { lock: path.join(CONTRACT, 'runtime.lock.json'), python: path.join(REPO, 'venv', 'bin', 'python') }

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '')

    if (!['rev', 'out', 'lock', 'python'].includes(key) || argv[i + 1] === undefined) {
      usage(`unknown or incomplete argument ${argv[i]}`)
    }

    args[key] = argv[(i += 1)]
  }

  if (!args.rev || !/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(args.rev)) {
    usage('--rev must be a revision name')
  }

  if (!args.out) {
    usage('--out is required')
  }

  return args
}

function inside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

// The output tree is ours alone: a fresh or previously-canary directory, never anything under ~/.hermes.
function prepareOut(dir) {
  const out = path.resolve(dir)
  fs.mkdirSync(out, { recursive: true })
  const real = fs.realpathSync(out)
  const hermes = path.join(fs.realpathSync(os.homedir()), '.hermes')

  if (inside(real, hermes)) {
    usage(`--out ${real} is inside ${hermes}`)
  }

  const entries = fs.readdirSync(real)

  if (entries.length > 0 && !entries.includes(OUT_MARKER)) {
    usage(`--out ${real} is not empty and was not made by the canary`)
  }

  for (const sub of ['archive', 'home', 'user', 'tmp']) {
    fs.rmSync(path.join(real, sub), { recursive: true, force: true })
  }

  fs.writeFileSync(path.join(real, OUT_MARKER), '')

  return real
}

function runJson(cmd, argv, opts) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, ...opts })

  if (r.status !== 0) {
    throw new Error(`${path.basename(argv[0] ?? cmd)} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-400)}`)
  }

  return r.stdout
}

// probe.ts is the probe the app ships; its relative imports are extensionless (bundler style), so resolve them as .ts.
async function loadProbe() {
  registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier.startsWith('.') &&
        !path.extname(specifier) &&
        context.parentURL?.startsWith(pathToFileURL(COMPAT).href)
      ) {
        return next(`${specifier}.ts`, context)
      }

      return next(specifier, context)
    }
  })

  return import(pathToFileURL(path.join(COMPAT, 'probe.ts')).href)
}

function startGateway({ python, archive, home, user, tmp, stub }) {
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    HOME: user,
    HERMES_HOME: home,
    TMPDIR: tmp,
    PYTHONPATH: archive,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    // Everything but the loopback stub goes to a closed port: the sandbox has no network.
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    OPENAI_API_KEY: 'iclone-canary',
    OPENAI_BASE_URL: stub.baseUrl
  }

  const child = spawn(python, ['-B', '-c', BOOT, archive, JSON.stringify(ORIGIN_PACKAGES)], {
    cwd: archive,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  return child
}

function rpcClient(child, lock, stderrLog) {
  const pending = new Map()
  const waiters = []
  const log = { events: [], serverRequests: [], answered: [], resultFrames: 0, origins: null }
  let nextId = 0
  let exited = null

  const settleWaiters = () => {
    for (const w of [...waiters]) {
      if (w.test()) {
        waiters.splice(waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.resolve(true)
      }
    }
  }

  const write = frame => child.stdin.write(`${JSON.stringify(frame)}\n`)

  readline.createInterface({ input: child.stdout }).on('line', line => {
    let frame

    try {
      frame = JSON.parse(line)
    } catch {
      return
    }

    if (frame.method && frame.id !== undefined) {
      const handled = (lock.serverRequests?.handled ?? []).includes(frame.method)
      log.serverRequests.push({
        id: frame.id,
        method: frame.method,
        session: frame.params?.session_id ?? null,
        keys: Object.keys(frame.params ?? {}),
        handled
      })

      // The lock-emulating client answers only what the app's lock says it handles.
      if (handled) {
        log.answered.push(frame.id)
        write({ jsonrpc: '2.0', id: frame.id, result: log.answer?.(frame) ?? {} })
      }
    } else if (frame.method === 'event') {
      log.events.push({ type: frame.params?.type, session: frame.params?.session_id ?? null })
    } else if (frame.id !== undefined && pending.has(frame.id)) {
      const { resolve } = pending.get(frame.id)
      pending.delete(frame.id)
      resolve(frame)
    }

    settleWaiters()
  })

  readline.createInterface({ input: child.stderr }).on('line', line => {
    stderrLog.write(`${line}\n`)

    if (line.startsWith('iclone-canary-origins ')) {
      log.origins = JSON.parse(line.slice('iclone-canary-origins '.length))
    }
  })

  child.on('exit', (code, signal) => {
    exited = { code, signal }

    for (const { reject } of pending.values()) {
      reject(new Error(`gateway exited (${code ?? signal})`))
    }

    pending.clear()
    settleWaiters()
  })

  return {
    log,
    exited: () => exited,
    call(method, params) {
      if (exited) {
        return Promise.reject(new Error(`gateway exited (${exited.code ?? exited.signal})`))
      }

      const id = `canary-${(nextId += 1)}`

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    // Resolves true once test() holds, false on timeout or gateway exit.
    until(test, ms) {
      if (test()) {
        return Promise.resolve(true)
      }

      return new Promise(resolve => {
        const w = { test: () => test() || exited !== null, resolve }
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)

          if (i >= 0) {
            waiters.splice(i, 1)
          }

          resolve(false)
        }, ms)
        waiters.push(w)
      }).then(ok => ok && test())
    }
  }
}

// The shipped probe on its own terms, then (sandbox only) every locked method T1 no longer lists, with the same
// validation-only frame. -32601 there is the live proof of M-GONE; a result frame means a handler ran.
async function probeSandbox(rpc, probe, lock, spec) {
  const errors = {}
  const counted = async (method, params) => {
    const frame = await rpc.call(method, params)

    if (!frame.error) {
      rpc.log.resultFrames += 1
    } else {
      errors[method] = frame.error
    }

    return frame
  }

  const shipped = await probe.runProbe({
    lock,
    spec,
    call: counted,
    capabilities: caps => rpc.call('client.capabilities', caps)
  })

  const absent = shipped.names.skipped.filter(s => s.reason === 'absent-from-t1').map(s => s.method)
  const sandbox = { sent: 0, gone: [], servedOutsideT1: [], other: [] }

  for (const method of absent) {
    const params = {}

    for (const key of probe.sentKeys(lock.methods?.[method]?.params)) {
      params[key] = null
    }

    params[probe.PROBE_KEY] = 1
    sandbox.sent += 1
    const frame = await counted(method, params)

    if (frame.error?.code === probe.METHOD_NOT_FOUND) {
      sandbox.gone.push(method)
    } else if (frame.error?.code === probe.INVALID_PARAMS) {
      sandbox.servedOutsideT1.push(method)
    } else {
      sandbox.other.push({ method, code: frame.error?.code ?? 'result' })
    }
  }

  return {
    gone: shipped.gone + sandbox.gone.length,
    resultFrames: rpc.log.resultFrames,
    ok: shipped.ok,
    renamed: shipped.renamed,
    unsafe: shipped.unsafe,
    abortedAt: shipped.abortedAt,
    reason: shipped.reason,
    // The frame the shipped probe gave up on: evidence for its owner, not a sandbox failure.
    abortFrame: shipped.abortedAt ? (errors[shipped.abortedAt] ?? null) : null,
    shippedFrames: shipped.frames,
    skippedOpenParams: shipped.names.skipped.filter(s => s.reason !== 'absent-from-t1').length,
    goneNames: [...shipped.names.gone, ...sandbox.gone].sort(),
    renamedNames: shipped.names.renamed,
    sandbox: { sent: sandbox.sent, servedOutsideT1: sandbox.servedOutsideT1, other: sandbox.other },
    ms: shipped.ms
  }
}

async function runScenario(rpc, scenario, lock) {
  const t0 = performance.now()
  rpc.log.answer = () => scenario.answer
  const created = await rpc.call('session.create', {})
  const sid = created.result?.session_id
  const seen = () => rpc.log.serverRequests.find(r => r.method === scenario.serverRequest && r.session === sid)

  if (!sid) {
    return { observed: false, error: `session.create: ${JSON.stringify(created.error ?? created.result)}` }
  }

  const submitted = await rpc.call('prompt.submit', { session_id: sid, text: scenario.prompt })
  const turnEnded = () => rpc.log.events.some(e => e.session === sid && /^message\.complete$|^error$/.test(e.type))
  await rpc.until(() => Boolean(seen()) || turnEnded(), scenario.timeoutMs ?? 45_000)
  const req = seen()

  return {
    observed: Boolean(req) || turnEnded(),
    serverRequestSent: Boolean(req),
    appAnswered: req ? rpc.log.answered.includes(req.id) : false,
    lockHandles: (lock.serverRequests?.handled ?? []).includes(scenario.serverRequest),
    requestKeys: req?.keys ?? [],
    submitError: submitted.error ?? null,
    turnEnded: turnEnded(),
    ms: Math.round(performance.now() - t0)
  }
}

async function stopGateway(child, rpc) {
  if (rpc.exited()) {
    return
  }

  child.stdin.end()

  if (await rpc.until(() => rpc.exited() !== null, 5000)) {
    return
  }

  for (const [signal, ms] of [
    ['SIGTERM', 3000],
    ['SIGKILL', 2000]
  ]) {
    try {
      process.kill(-child.pid, signal)
    } catch {
      return
    }

    if (await rpc.until(() => rpc.exited() !== null, ms)) {
      return
    }
  }
}

async function main() {
  const t0 = performance.now()
  const args = parseArgs(process.argv.slice(2))
  const out = prepareOut(args.out)
  const paths = {
    archive: path.join(out, 'archive'),
    home: path.join(out, 'home'),
    user: path.join(out, 'user'),
    tmp: path.join(out, 'tmp'),
    spec: path.join(out, 'spec.json')
  }
  const failures = []
  const report = { canary: 1, rev: args.rev, archiveDir: paths.archive, hermesHome: paths.home }
  let child = null
  let rpc = null
  let stub = null
  const deadline = setTimeout(() => {
    failures.push(`over ${LIMIT_MS} ms`)

    if (child) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }, LIMIT_MS)

  try {
    // One git helper (served.py's guard + env) yields both the candidate's tree and its T1 spec.
    runJson(
      'python3',
      [
        '-B',
        path.join(CONTRACT, 'served.py'),
        '--repo',
        REPO,
        '--rev',
        args.rev,
        '--out',
        paths.spec,
        '--archive',
        paths.archive
      ],
      { cwd: REPO }
    )
    const spec = JSON.parse(fs.readFileSync(paths.spec, 'utf8'))
    const lock = JSON.parse(fs.readFileSync(args.lock, 'utf8'))
    Object.assign(report, {
      rev: spec.rev,
      describe: spec.describe,
      specTier: spec.specTier,
      openrpcSha256: spec.openrpcSha256
    })

    const verdict = JSON.parse(
      runJson(process.execPath, [
        path.join(COMPAT, 'verify.ts'),
        '--lock',
        args.lock,
        '--spec',
        paths.spec,
        '--kind',
        'today'
      ])
    )
    const expectedGone = (verdict.findings ?? [])
      .filter(f => f.rule === 'M-GONE')
      .map(f => f.name)
      .sort()

    const probe = await loadProbe()
    const scenarios = fs
      .readdirSync(path.join(HERE, 'scenarios'))
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios', f), 'utf8')))

    for (const dir of [paths.home, paths.user, paths.tmp]) {
      fs.mkdirSync(dir, { recursive: true })
    }

    stub = await startStubLlm(scenarios)
    fs.writeFileSync(
      path.join(paths.home, 'config.yaml'),
      `model:\n  default: ${stub.model}\n  provider: custom\n  base_url: ${stub.baseUrl}\n  api_key: iclone-canary\n`
    )

    const stderrLog = fs.createWriteStream(path.join(out, 'gateway.stderr.log'))
    child = startGateway({ python: args.python, ...paths, stub })
    rpc = rpcClient(child, lock, stderrLog)
    const ready = await rpc.until(() => rpc.log.events.some(e => e.type === 'gateway.ready'), READY_MS)
    const origins = rpc.log.origins ?? {}
    report.moduleOrigin = origins.tui_gateway ?? null
    report.origins = origins
    report.python = args.python

    if (!ready) {
      throw new Error(`gateway not ready (exit ${JSON.stringify(rpc.exited())}); see gateway.stderr.log`)
    }

    const archiveReal = fs.realpathSync(paths.archive)

    if (!Object.values(origins).every(o => o && inside(o, archiveReal)) || !report.moduleOrigin) {
      failures.push('module origin outside the archive')
    }

    report.probe = { ...(await probeSandbox(rpc, probe, lock, spec)), expectedGone: expectedGone.length }

    if (report.probe.gone !== expectedGone.length || report.probe.goneNames.join() !== expectedGone.join()) {
      failures.push(`probe gone ${report.probe.gone} != M-GONE ${expectedGone.length}`)
    }

    if (report.probe.resultFrames !== 0) {
      failures.push(`${report.probe.resultFrames} result frames`)
    }

    report.scenarios = {}

    for (const scenario of scenarios) {
      const r = await runScenario(rpc, scenario, lock)
      r.llmCalls = stub.calls.filter(c => c.scenario === scenario.id).length
      report.scenarios[scenario.id] = r

      if (!r.observed) {
        failures.push(`scenario ${scenario.id} not observed`)
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  } finally {
    if (child && rpc) {
      await stopGateway(child, rpc)
    }

    await stub?.close()
    clearTimeout(deadline)
  }

  report.stubCalls = stub?.calls.length ?? 0
  report.wallMs = Math.round(performance.now() - t0)

  if (report.wallMs > LIMIT_MS && !failures.some(f => f.startsWith('over'))) {
    failures.push(`over ${LIMIT_MS} ms`)
  }

  report.failures = failures
  report.pass = failures.length === 0
  fs.writeFileSync(path.join(out, 'canary.json'), `${JSON.stringify(report, null, 1)}\n`)
  process.stdout.write(
    `canary: ${report.pass ? 'PASS' : 'FAIL'} rev=${String(report.rev).slice(0, 12)} gone=${report.probe?.gone} ` +
      `expected=${report.probe?.expectedGone} resultFrames=${report.probe?.resultFrames} ` +
      `scenarios=${JSON.stringify(Object.fromEntries(Object.entries(report.scenarios ?? {}).map(([k, v]) => [k, { sent: v.serverRequestSent, answered: v.appAnswered }])))} ` +
      `wallMs=${report.wallMs}${failures.length ? ` failures=${JSON.stringify(failures)}` : ''}\n`
  )
  process.exit(report.pass ? 0 : 1)
}

await main()
