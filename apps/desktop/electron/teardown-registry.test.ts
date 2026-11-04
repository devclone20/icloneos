// The ONE teardown registry (teardown-registry.ts) and its STRUCTURAL GATE.
//
// The gate reads every non-test source under electron/ with the TypeScript compiler API and enumerates:
// - every app.on / app.once / prependListener handler for 'will-quit', 'before-quit' and 'quit';
// - every long-lived resource the main process creates: spawn/fork (child_process, utilityProcess), fs.watch /
//   chokidar watchers, createServer (http/net/https), setInterval timers and the Market window's ACP watch
//   (initAcpWatch).
// Each must match an entry below: either registered in the teardown registry (the named registerTeardown call must be
// in that file AND reached: at statement level in its function or module body, with nothing conditional on the way;
// a try block is allowed, a branch is not), or on the commented allow-list with its reason. A new quit handler or a new
// resource changes a count and turns the gate red until it is registered or reviewed onto the list.
import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createTeardownRegistry } from './teardown-registry'

const ROOT = __dirname

// --- The registry itself ----------------------------------------------------------------------------------------------

describe('the teardown registry', () => {
  it('runs each stop at most once, in order; a stop that throws is logged by class and the rest still run', () => {
    const registry = createTeardownRegistry()
    const ran: string[] = []
    const lines: string[] = []

    registry.register('a', () => ran.push('a'))
    registry.register('b', () => {
      throw new TypeError('/private/owner/path')
    })
    registry.register('c', () => ran.push('c'))
    expect(registry.run(line => lines.push(line))).toEqual(['a', 'b (failed)', 'c'])
    expect(lines).toEqual(['[shutdown] stopping b failed: TypeError'])
    expect(registry.run()).toEqual([])
    expect(ran).toEqual(['a', 'c'])
  })

  it('a re-registered name (a new resource) is armed again; a stop that re-enters the teardown runs once', () => {
    const registry = createTeardownRegistry()
    let runs = 0

    registry.register('x', () => {
      runs += 1
      registry.run()
    })
    registry.run()
    expect(runs).toBe(1)
    registry.register('x', () => (runs += 10))
    expect(registry.run()).toEqual(['x'])
    expect(runs).toBe(11)
  })
})

// --- The structural gate ----------------------------------------------------------------------------------------------

type Kind = 'acp-watch' | 'interval' | 'server' | 'spawn' | 'watch'

interface Entry {
  n: number
  /** registerTeardown names this file must reach. */
  teardown?: string[]
  /** Why it is not (or need not be) in the registry. */
  why?: string
}

// Quit handlers: file → event → count, each with why it is not a resource stop (those live in the registry now).
const QUIT_HANDLERS: Record<string, { n: number; why: string }> = {
  // The quit orchestrator: the translucency write, the active-work confirmation, the SSH teardown and the seal.
  // Covered by behaviour tests (quit-restore-dial, quit-refusals-*, main-quit-order) and stops nothing itself.
  'main.ts before-quit': { n: 2, why: 'main quit orchestration (C2 m2: listed and counted here)' },
  // The relaunch is not a resource: armed on will-quit; a quit-cap forced exit runs it through relaunchOnForcedQuit.
  'iclone-relaunch.ts will-quit': { n: 1, why: '"Restart now" relaunch; forced path = relaunchOnForcedQuit' },
  // An early stop on an unprevented pass only; the backstop is registerTeardown('acp market watch').
  'iclone-acp-watch.ts before-quit': { n: 1, why: 'early stop; the registry entry is the backstop' },
  // The diagnostics trace line.
  'main/shutdown-signals-wiring.ts will-quit': { n: 1, why: "quitTrace('will-quit') only" },
  // The shutdown module itself: runs the registry on will-quit, the cap on before-quit, the clean-quit line on quit.
  'shutdown-signals.ts will-quit': { n: 1, why: 'runs the ONE teardown' },
  'shutdown-signals.ts before-quit': { n: 1, why: 'arms the cap, starts a signal flush' },
  'shutdown-signals.ts quit': { n: 1, why: 'clean-quit line and the post-quit exit' }
}

// RESOURCES:BEGIN (generated from the scan, then reviewed: every entry is a decision)
const RESOURCES: Record<string, Partial<Record<Kind, Entry>>> = {
  'backend-ready.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'bootstrap-runner.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' },
    spawn: { n: 3, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'iclone-acp-ipc.ts': {
    server: { n: 1, teardown: ['iclone-acp.ts#acp agent door'] }
  },
  'iclone-acp-watch.ts': {
    interval: { n: 1, teardown: ['iclone-acp-watch.ts#acp market watch'] },
    spawn: {
      n: 2,
      teardown: ['iclone-acp-watch.ts#acp market watch'],
      why: 'command child awaited for its result (bounded); dies with its command'
    }
  },
  'iclone-acp-work/ipc.ts': {
    interval: { n: 1, teardown: ['main.ts#acp work'] }
  },
  'iclone-acp.ts': {
    'acp-watch': { n: 1, teardown: ['iclone-acp-watch.ts#acp market watch'] },
    spawn: {
      n: 4,
      teardown: ['iclone-acp-watch.ts#acp market watch'],
      why: 'command child awaited for its result (bounded); dies with its command'
    }
  },
  'iclone-app-update.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'iclone-compat/watch.ts': {
    interval: { n: 1, teardown: ['iclone-compat.ts#compat'] }
  },
  'iclone-confinement/live-harness.ts': {
    spawn: { n: 2, why: 'confinement: the log stream is stopped by main.ts#confinement; the rest are bounded probes' }
  },
  'iclone-confinement/probe.ts': {
    spawn: { n: 1, why: 'confinement: the log stream is stopped by main.ts#confinement; the rest are bounded probes' }
  },
  'iclone-confinement/refusal-gate.ts': {
    watch: { n: 1, teardown: ['main.ts#confinement'] }
  },
  'iclone-confinement/refusals.ts': {
    spawn: { n: 2, why: 'confinement: the log stream is stopped by main.ts#confinement; the rest are bounded probes' }
  },
  'iclone-it.ts': {
    server: { n: 1, teardown: ['iclone-it.ts#it server'] }
  },
  'iclone-ownership.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'iclone-pane-bus/ipc.ts': {
    server: { n: 1, teardown: ['iclone-pane-bus/ipc.ts#pane bus'] }
  },
  'iclone-permissions/ipc.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'iclone-privy.ts': {
    server: { n: 1, teardown: ['iclone-privy.ts#privy server'] }
  },
  'iclone-x402/ipc.ts': {
    server: { n: 1, teardown: ['main.ts#payments'] }
  },
  'iclone-x402/skill-defaults.ts': {
    watch: {
      n: 1,
      why: 'in-process fs watcher (persistent:false or closed by its owner); holds no OS resource past the process'
    }
  },
  'iclone-x402/stub.ts': {
    server: { n: 2, why: 'loopback server scoped to one flow (closed when the flow ends) or a test stub' }
  },
  'lib/git.ts': {
    spawn: { n: 1, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'main/backend-boot-watch.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'main/backend-pool.ts': {
    interval: {
      n: 1,
      why: 'backend child or its pool timer: stopped by stopOwnedChildren/backendShutdown on every way out'
    }
  },
  'main/connections-ipc.ts': {
    spawn: { n: 1, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'main/hud.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'main/link-metadata.ts': {
    spawn: { n: 1, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'main/managed-ssh-update.ts': {
    spawn: {
      n: 1,
      why: 'backend child or its pool timer: stopped by stopOwnedChildren/backendShutdown on every way out'
    }
  },
  'main/oauth.ts': {
    interval: { n: 1, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'main/portal.ts': {
    interval: { n: 2, why: 'in-process timer (unref or cleared by its owner); holds no OS resource past the process' }
  },
  'main/preview.ts': {
    watch: {
      n: 2,
      why: 'in-process fs watcher (persistent:false or closed by its owner); holds no OS resource past the process'
    }
  },
  'main/shell-open.ts': {
    spawn: { n: 2, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'main/start-hermes.ts': {
    spawn: {
      n: 1,
      why: 'backend child or its pool timer: stopped by stopOwnedChildren/backendShutdown on every way out'
    }
  },
  'main/updates-ipc.ts': {
    spawn: { n: 2, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'main/window-ipc.ts': {
    spawn: { n: 1, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'native-oauth-login.ts': {
    server: { n: 1, why: 'loopback server scoped to one flow (closed when the flow ends) or a test stub' }
  },
  'ssh-connection.ts': {
    server: { n: 1, why: 'loopback server scoped to one flow (closed when the flow ends) or a test stub' }
  },
  'terminal-ipc.ts': {
    spawn: { n: 3, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'updater-process.ts': {
    spawn: { n: 1, why: 'command child awaited for its result (bounded); dies with its command' }
  },
  'wake-indicator-window.ts': {
    spawn: { n: 1, why: 'command child awaited for its result (bounded); dies with its command' }
  }
}
// RESOURCES:END

const isTest = (file: string) => /\.test\.tsx?$|\.d\.ts$/.test(file)

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sources(full)
    }

    return entry.name.endsWith('.ts') && !isTest(entry.name) ? [full] : []
  })
}

const calleeName = (call: ts.CallExpression): { object: string; name: string } => {
  const callee = call.expression

  if (ts.isIdentifier(callee)) {
    return { object: '', name: callee.text }
  }

  if (ts.isPropertyAccessExpression(callee)) {
    return { object: callee.expression.getText(), name: callee.name.text }
  }

  return { object: '', name: '' }
}

/** Reached: the call's statement sits in its function or module body through blocks and try blocks only. */
function reached(call: ts.Node): boolean {
  let node: ts.Node = call.parent

  if (!ts.isExpressionStatement(node)) {
    return false
  }

  for (;;) {
    const parent: ts.Node = node.parent

    if (ts.isSourceFile(parent) || ts.isFunctionLike(parent)) {
      return true
    }

    if (ts.isBlock(parent) || (ts.isTryStatement(parent) && parent.tryBlock === node)) {
      node = parent

      continue
    }

    return false
  }
}

interface Scan {
  quit: Record<string, number>
  resources: Record<string, Partial<Record<Kind, number>>>
  /** file → registerTeardown names, and whether each is reached. */
  registrations: Record<string, Array<{ name: string; reached: boolean }>>
}

function scan(): Scan {
  const out: Scan = { quit: {}, resources: {}, registrations: {} }

  for (const full of sources(ROOT)) {
    const file = path.relative(ROOT, full).split(path.sep).join('/')
    const text = fs.readFileSync(full, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const fsWatchImported = /import \{[^}]*\bwatch\b[^}]*\} from '(node:)?fs'|from 'chokidar'/.test(text)

    const add = (kind: Kind) => {
      const counts = (out.resources[file] ??= {})

      counts[kind] = (counts[kind] ?? 0) + 1
    }

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const { object, name } = calleeName(node)
        const first = node.arguments[0]

        if (
          ['on', 'once', 'prependListener'].includes(name) &&
          /(^|\.)app$/.test(object) &&
          first &&
          ts.isStringLiteralLike(first) &&
          ['will-quit', 'before-quit', 'quit'].includes(first.text)
        ) {
          const key = `${file} ${first.text}`

          out.quit[key] = (out.quit[key] ?? 0) + 1
        }

        if (name === 'registerTeardown' && first && ts.isStringLiteralLike(first)) {
          ;(out.registrations[file] ??= []).push({ name: first.text, reached: reached(node) })
        }

        if (name === 'spawn' || name === 'fork') {
          add('spawn')
        } else if (
          name === 'watch' &&
          (object === 'fs' || object === 'chokidar' || (object === '' && fsWatchImported))
        ) {
          add('watch')
        } else if (name === 'createServer') {
          add('server')
        } else if (name === 'setInterval') {
          add('interval')
        } else if (name === 'initAcpWatch') {
          add('acp-watch')
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return out
}

describe('the structural gate: every quit handler and long-lived resource is in the registry or on the allow-list', () => {
  const found = scan()

  if (process.env.TEARDOWN_GATE_DUMP) {
    fs.writeFileSync(process.env.TEARDOWN_GATE_DUMP, JSON.stringify(found, null, 1))
  }

  it('every app quit handler is on the commented allow-list (resource stops live in the registry)', () => {
    expect(found.quit).toEqual(Object.fromEntries(Object.entries(QUIT_HANDLERS).map(([key, { n }]) => [key, n])))
  })

  it('every long-lived resource the main process creates is registered or allow-listed, by file and kind', () => {
    const expected = Object.fromEntries(
      Object.entries(RESOURCES).map(([file, kinds]) => [
        file,
        Object.fromEntries(Object.entries(kinds).map(([kind, entry]) => [kind, entry!.n]))
      ])
    )

    expect(found.resources).toEqual(expected)

    for (const kinds of Object.values(RESOURCES)) {
      for (const entry of Object.values(kinds)) {
        expect(Boolean(entry!.teardown?.length) || Boolean(entry!.why), JSON.stringify(entry)).toBe(true)
      }
    }
  })

  it('each registration a resource relies on is in its file and reached (no dead branch, no condition)', () => {
    // An entry names "<file>#<name>": the file that registers the stop (the owner of the resource, which may wire a
    // module's child from main.ts).
    const required = Object.values(RESOURCES).flatMap(kinds =>
      Object.values(kinds).flatMap(entry => entry!.teardown ?? [])
    )

    expect(required.length).toBeGreaterThan(0)

    for (const ref of required) {
      const [file, name] = ref.split('#')

      expect(found.registrations[file] ?? [], `${file}: registerTeardown('${name}')`).toContainEqual({
        name,
        reached: true
      })
    }

    // Every registration anywhere is reached, and each name is registered once.
    const all = Object.values(found.registrations).flat()

    expect(all.filter(entry => !entry.reached)).toEqual([])
    expect(new Set(all.map(entry => entry.name)).size).toBe(all.length)
  })
})
