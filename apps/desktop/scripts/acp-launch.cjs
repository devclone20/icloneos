/**
 * acp-launch.cjs — starts the bundled Virtuals ACP CLI inside the app, in an
 * Electron utility process (electron/iclone-acp.ts `startCli`):
 *
 *   utilityProcess.fork(<acp-cli>/launch.cjs, [<acp.js>, …args])
 *
 * Why a launcher instead of forking acp.js: the CLI is built on commander,
 * which reads `process.versions.electron` and — unless `process.defaultApp`
 * is set — assumes a PACKAGED Electron app, where argv carries no script path
 * and argv[1] is already the first user argument. A utility process (like
 * plain Node) has argv `[exec, script, …args]`, so the CLI's own path became
 * the "unknown command" and every dock app failed while `--version` still
 * answered (2026-09-26). This launcher sets `defaultApp` and hands the CLI a
 * node-shaped argv. Staging runs the same file under plain Node.
 *
 * `ICLONE_ACP_PROBE=keyring` (set only by the app's `--iclone-selftest`)
 * loads the CLI's native keychain binding and exits WITHOUT any keychain
 * call: the packaged proof that the signed, hardened app can load it.
 *
 * CONFINEMENT (REL-6 round 2, critic M1). The CLI is installed at first use
 * into userData/acp-cli/<lock>/, and main verifies that tree before every
 * spawn — but Node's resolver would walk UP out of it (<lock>/node_modules,
 * userData/acp-cli/node_modules, ~/node_modules, NODE_PATH, the global
 * folders) for every bare name the tree does not satisfy, and the tree has
 * dozens (keyring tries `@napi-rs/keyring-darwin-universal` before the
 * installed binding). So this launcher, which is ours and ships inside the
 * signed app, is the enforcement point. Main passes the verified tree
 * (ICLONE_ACP_TREE) and its manifest digest (ICLONE_ACP_TREE_SHA256); then:
 *   - the manifest on disk must be that one (digest recomputed here);
 *   - require AND import (module.registerHooks, both loaders), every worker
 *     thread, and Node's own lookup lists (Module._nodeModulePaths filtered,
 *     Module.globalPaths emptied, NODE_PATH ignored): a bare name is looked up
 *     ONLY in node_modules folders inside runtime/node_modules — not found
 *     there is MODULE_NOT_FOUND, exactly what a clean `npm ci` machine gives —
 *     and any resolution that lands outside is refused the same way (and
 *     reported to main, which audits it);
 *   - every file loaded (source as compiled, JSON, native add-on at dlopen,
 *     an executable of the tree at spawn) must hash to its manifest entry,
 *     which closes the check-to-load window (critic m1): a mismatch exits 78.
 * Without the two variables the launcher refuses to start (exit 78).
 *
 * RESIDUE (critic r2 m1; recorded, none of the 346 packages does any of it). Confinement is about what Node RESOLVES
 * and LOADS from disk. Code that deliberately evaluates content it read itself is outside it: `vm.runInThisContext`,
 * `new Module()._compile(source)`, or a child Node started on another script. In the signed app the RunAsNode and
 * NODE_OPTIONS fuses are off, so `process.execPath` cannot become Node; the tree greps no vm / _compile module use.
 * A worker started with Node options that preload code (`--require`, `--import`, `--loader`) is refused here.
 *
 * Plain CommonJS with no dependencies: it runs before anything is resolved.
 * Shipped in the signed app as Resources/acp-pin/launch.cjs.
 */
'use strict'

const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL, fileURLToPath } = require('node:url')

const REFUSED = 78
const TREE_ENV = 'ICLONE_ACP_TREE'
const TREE_SHA_ENV = 'ICLONE_ACP_TREE_SHA256'
const ADDON_EXTENSIONS = ['', '.js', '.json', '.node', '.cjs', '.mjs']

/** To main (a utility process's port); plain Node has none. Never throws. */
function report(type, what) {
  try {
    if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
      process.parentPort.postMessage({ iclone: 'acp-launch', type, what })
    }
  } catch {
    // main is gone: nothing to tell
  }
}

function refuse(what) {
  process.stderr.write(`acp-launch: refused: ${what}\n`)
  report('integrity', what)
  process.exit(REFUSED)
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

/** electron/iclone-acp-tools/manifest.ts `treeDigest`, byte for byte. */
function treeDigest(files) {
  const hash = crypto.createHash('sha256')

  for (const key of Object.keys(files).sort()) {
    const entry = files[key]

    hash.update(
      `${key}\0${entry.sha256}\0${entry.size}\0${Number(entry.mode).toString(8)}${entry.source ? `\0${entry.source}` : ''}\n`
    )
  }

  return hash.digest('hex')
}

const homeShort = file => {
  const home = require('node:os').homedir()

  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file
}

let confined = null

/** Confine THIS thread to the verified tree (idempotent). The main thread and every worker thread call it. */
function confineThisThread() {
  if (confined) {
    return confined
  }

  const tree = process.env[TREE_ENV]
  const treeSha = process.env[TREE_SHA_ENV]

  if (!tree || !/^[0-9a-f]{64}$/.test(treeSha || '')) {
    refuse('started without a verified tree')
  }

  let manifest

  try {
    manifest = JSON.parse(fs.readFileSync(path.join(tree, 'MANIFEST.json'), 'utf8'))
  } catch {
    refuse('the manifest cannot be read')
  }

  if (
    !manifest ||
    typeof manifest.files !== 'object' ||
    manifest.treeSha256 !== treeSha ||
    treeDigest(manifest.files) !== treeSha
  ) {
    refuse('the manifest is not the verified one')
  }

  const realTree = fs.realpathSync(tree)
  const root = path.join(realTree, 'runtime', 'node_modules')
  const inside = file => file === root || file.startsWith(root + path.sep)
  const relOf = file => path.relative(realTree, file).split(path.sep).join('/')

  const verifyBytes = (file, data) => {
    const rel = relOf(file)
    const entry = manifest.files[rel]

    if (!entry || entry.size !== data.length || sha256(data) !== entry.sha256) {
      refuse(`${rel} is not the verified file`)
    }
  }

  const verifyFile = file => {
    let data

    try {
      data = fs.readFileSync(file)
    } catch {
      refuse(`${relOf(file)} cannot be read`)
    }

    verifyBytes(file, data)
  }

  const real = file => {
    try {
      return fs.realpathSync(file)
    } catch {
      return file
    }
  }

  const notFound = (specifier, context) => {
    const error = new Error(`Cannot find module '${specifier}'`)
    const conditions = (context && context.conditions) || []

    error.code = conditions.includes('require') ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND'

    return error
  }

  // Node's own lookup lists: only node_modules folders inside the tree; no global folders, no NODE_PATH.
  const nodeModulePaths = Module._nodeModulePaths

  Module._nodeModulePaths = function confinedPaths(from) {
    return nodeModulePaths.call(this, real(from)).filter(inside)
  }

  Module.globalPaths.length = 0
  delete process.env.NODE_PATH

  const isBare = specifier =>
    !(
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier === '.' ||
      specifier === '..' ||
      specifier.startsWith('/') ||
      specifier.startsWith('#') ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)
    )

  const packageName = specifier =>
    specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

  /** Is there ANY candidate for a bare name in a node_modules folder inside the tree, nearest first? */
  const insideCandidate = (specifier, parentFile) => {
    const name = packageName(specifier)

    for (const dir of nodeModulePaths(real(path.dirname(parentFile))).filter(inside)) {
      for (const extension of ADDON_EXTENSIONS) {
        if (fs.existsSync(path.join(dir, name + extension))) {
          return true
        }
      }
    }

    return false
  }

  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        isBare(specifier) &&
        !Module.isBuiltin(specifier) &&
        context.parentURL &&
        context.parentURL.startsWith('file:')
      ) {
        // Never consult a folder outside the tree: no candidate inside means not found, before Node walks up.
        if (!insideCandidate(specifier, fileURLToPath(context.parentURL))) {
          throw notFound(specifier, context)
        }
      }

      const resolved = nextResolve(specifier, context)
      const url = resolved && resolved.url

      if (typeof url === 'string' && url.startsWith('node:')) {
        return resolved
      }

      if (typeof url === 'string' && url.startsWith('file:') && inside(real(fileURLToPath(url)))) {
        return resolved
      }

      report(
        'escape',
        `${specifier} -> ${typeof url === 'string' && url.startsWith('file:') ? homeShort(fileURLToPath(url)) : String(url).slice(0, 60)}`
      )
      process.stderr.write(`acp-launch: refused ${specifier}: it resolves outside the verified tree\n`)

      throw notFound(specifier, context)
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)

      if (typeof url === 'string' && url.startsWith('file:')) {
        const file = real(fileURLToPath(url))

        if (!inside(file)) {
          refuse(`${homeShort(file)} is outside the verified tree`)
        }

        if (loaded.source == null) {
          verifyFile(file)
        } else {
          verifyBytes(
            file,
            typeof loaded.source === 'string' ? Buffer.from(loaded.source, 'utf8') : Buffer.from(loaded.source)
          )
        }
      } else if (typeof url === 'string' && !url.startsWith('node:')) {
        refuse(`${url.slice(0, 60)} is not a file of the verified tree`)
      }

      return loaded
    }
  })

  // Native add-ons never pass the load hook: check them at dlopen.
  const dlopen = process.dlopen

  process.dlopen = function confinedDlopen(module, filename, ...rest) {
    const file = real(String(filename))

    if (!inside(file)) {
      report('escape', `native add-on ${homeShort(file)}`)

      throw notFound(String(filename), { conditions: ['require'] })
    }

    verifyFile(file)

    return dlopen.call(this, module, filename, ...rest)
  }

  // Executables of the tree (the Go signer) are hashed again at spawn; system tools pass.
  const childProcess = require('node:child_process')

  for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
    const original = childProcess[name]

    childProcess[name] = function confinedSpawn(file, ...rest) {
      if (typeof file === 'string' && path.isAbsolute(file)) {
        const target = real(file)

        if (target === realTree || target.startsWith(realTree + path.sep)) {
          verifyFile(target)
        }
      }

      return original.call(this, file, ...rest)
    }
  }

  // Worker threads do not inherit this thread's hooks: each one confines itself first.
  const workerThreads = require('node:worker_threads')
  const Worker = workerThreads.Worker
  const prelude = `require(${JSON.stringify(__filename)}).confineThisThread();\n`

  workerThreads.Worker = class ConfinedWorker extends Worker {
    constructor(specifier, options) {
      const opts = { ...(options || {}) }
      const preload = (opts.execArgv || []).find(arg =>
        /^(-r|--require|--import|--loader|--experimental-loader)(=|$)/.test(String(arg))
      )

      if (preload) {
        throw new Error(`acp-launch: a worker may not preload code (${preload})`)
      }

      if (opts.eval) {
        super(prelude + String(specifier), opts)
      } else {
        const file =
          specifier instanceof URL || String(specifier).startsWith('file:')
            ? fileURLToPath(specifier)
            : path.resolve(String(specifier))

        super(
          `${prelude}import(${JSON.stringify(pathToFileURL(file).href)}).catch(e => process.nextTick(() => { throw e }))`,
          {
            ...opts,
            eval: true
          }
        )
      }
    }
  }

  Module.syncBuiltinESMExports()
  confined = { root, realTree }

  return confined
}

module.exports = { confineThisThread }

/** The CLI run (when this file is the process's main module; a worker thread's prelude only confines). */
function main() {
  const [exec, , entry, ...rest] = process.argv

  if (!entry) {
    process.stderr.write('acp-launch: usage: acp-launch.cjs <acp.js> [args…]\n')
    process.exit(64)
  }

  confineThisThread()

  if (process.env.ICLONE_ACP_PROBE === 'keyring') {
    try {
      const keyring = Module.createRequire(entry)('@napi-rs/keyring')

      if (typeof keyring.Entry !== 'function') {
        throw new Error('@napi-rs/keyring has no Entry export')
      }

      process.stdout.write('{"keyring":"loaded"}\n')
      process.exit(0)
    } catch (error) {
      process.stderr.write(`acp-launch: keyring probe: ${error && error.message ? error.message : String(error)}\n`)
      process.exit(1)
    }
  }

  // A script run: argv[1] is the script, user arguments start at argv[2].
  process.defaultApp = true
  process.argv = [exec, entry, ...rest]

  // Node exits when its loop drains; a utility process never does (measured on
  // Electron 40: a CLI action that returns without process.exit — `chain list` —
  // hung until the 30 s timeout). So, in a utility process only, exit once the
  // loop holds nothing but the stdio pipes it started with, twice in a row.
  // Pending writes and sockets are active resources, so output is never cut.
  // Thread-pool work (crypto, zlib, native async) is NOT listed as a resource,
  // so the check is armed only after commander's action promise settles: the CLI
  // calls the synchronous `program.parse()`, which drops that promise.
  const isUtility = typeof process.parentPort === 'object'
  // Touching the streams opens their pipes, so the baseline includes them.
  const streams = [process.stdout, process.stderr]
  const stdioBaseline = new Map()
  let actionSettled = null

  function armIdleExit() {
    const counts = () => {
      const byType = new Map()

      for (const type of process.getActiveResourcesInfo()) {
        byType.set(type, (byType.get(type) ?? 0) + 1)
      }

      return byType
    }
    let idleTicks = 0

    // Unref'd, so this interval is never one of the resources it counts.
    setInterval(() => {
      const idle =
        [...counts()].every(([type, n]) => n <= (stdioBaseline.get(type) ?? 0)) &&
        streams.every(stream => stream.writableLength === 0)

      idleTicks = idle ? idleTicks + 1 : 0

      if (idleTicks >= 2) {
        process.exit()
      }
    }, 50).unref()
  }

  if (isUtility) {
    for (const type of process.getActiveResourcesInfo()) {
      stdioBaseline.set(type, (stdioBaseline.get(type) ?? 0) + 1)
    }

    try {
      const { Command } = Module.createRequire(entry)('commander')
      const { parse, parseAsync } = Command.prototype
      let inParse = false

      // Older commanders implement parseAsync through parse: the guard keeps
      // that inner call on the original.
      Command.prototype.parse = function parseTracked(...args) {
        if (inParse) {
          return parse.apply(this, args)
        }

        inParse = true

        try {
          actionSettled = Promise.resolve(parseAsync.apply(this, args))
        } finally {
          inParse = false
        }

        // A rejected action stays an unhandled rejection, as with parse().
        actionSettled.then(armIdleExit, error => {
          armIdleExit()

          throw error
        })

        return this
      }
    } catch {
      // No commander beside the CLI: arm as soon as the entry has loaded.
    }
  }

  import(pathToFileURL(entry).href).then(
    () => {
      if (isUtility && !actionSettled) {
        armIdleExit()
      }
    },
    error => {
      process.stderr.write(`acp-launch: ${error && error.stack ? error.stack : String(error)}\n`)
      process.exit(1)
    }
  )
}

// Main-ness without trusting `require.main` alone: a utility process may load this file through the ESM loader,
// where `require.main` is unset. A worker thread's prelude (`require(__filename)`) never runs the CLI.
const isEntry = () => {
  if (require.main === module) {
    return true
  }

  try {
    return (
      require('node:worker_threads').isMainThread &&
      typeof process.argv[1] === 'string' &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)
    )
  } catch {
    return false
  }
}

if (isEntry()) {
  main()
}
