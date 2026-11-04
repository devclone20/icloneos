// A quit with no signal, on the first-run screen (no backend), must reach will-quit and quit. Electron is modelled
// where it matters: Browser::Quit() runs the before-quit listeners and a microtask checkpoint, THEN records whether
// it is quitting (is_quitting_ = HandleBeforeQuit()), and a quit whose windows all closed while it is not quitting
// only emits window-all-closed (macOS: the app stays alive).
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRequit } from './main/shutdown-signals-app'
import { installShutdownSignals } from './shutdown-signals'

type Listener = Parameters<EventEmitter['on']>[1]

interface QuitEvent {
  defaultPrevented: boolean
  preventDefault(): void
}

function quitEvent(): QuitEvent {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    }
  }
}

function electron(options: { windows?: number } = {}) {
  const events = new EventEmitter()
  const trace: string[] = []
  let quitting = false
  let windows = options.windows ?? 1
  let exitCode: null | number = null
  // Quit passes whose listeners ran and whose decision is still to come: innermost decides first, outer last.
  let passes: QuitEvent[] = []

  const shutdown = () => {
    const willQuit = quitEvent()

    trace.push('will-quit')
    events.emit('will-quit', willQuit)

    if (willQuit.defaultPrevented) {
      quitting = false

      return
    }

    trace.push('quit')
    exitCode = 0
    events.emit('quit')
  }

  const closeAllWindows = () => {
    for (let index = windows; index > 0; index -= 1) {
      setTimeout(() => {
        windows -= 1

        if (windows === 0) {
          if (quitting) {
            shutdown()
          } else {
            trace.push('window-all-closed')
            events.emit('window-all-closed')
          }
        }
      }, 0)
    }
  }

  // The decision of every pass dispatched in this turn, after its microtasks (Electron's checkpoint) ran.
  const decide = () => {
    const queued = passes

    passes = []

    for (const event of queued.reverse()) {
      quitting = !event.defaultPrevented

      if (quitting) {
        if (windows === 0) {
          shutdown()
        } else {
          closeAllWindows()
        }
      }
    }
  }

  const app = {
    on: (event: string, listener: Listener) => events.on(event, listener),
    prependListener: (event: string, listener: Listener) => events.prependListener(event, listener),
    quit() {
      if (quitting || exitCode !== null) {
        return
      }

      trace.push('before-quit')
      const event = quitEvent()

      if (passes.length === 0) {
        setImmediate(decide)
      }

      passes.push(event)
      events.emit('before-quit', event)
    },
    exit(code: number) {
      if (exitCode !== null) {
        return
      }

      exitCode = code
      trace.push(`exit ${code}`)
      events.emit('quit')
    }
  }

  return { app, events, trace, exitCode: () => exitCode }
}

/** main.ts's before-quit in the first-run state: the backend teardown is prevented, then the app quits again. */
function firstRunMain(app: ReturnType<typeof electron>['app'], requit: (after: string) => void) {
  let backendQuitTeardownDone = false
  // No backend: the stop settles at once.
  const stopBackends = async () => undefined

  app.on('before-quit', (event: QuitEvent) => {
    if (!backendQuitTeardownDone) {
      event.preventDefault()
      void stopBackends().finally(() => {
        backendQuitTeardownDone = true
        requit('backends')
      })
    }

    void stopBackends()
  })
  // macOS: the last window closing does not quit (no hand-off).
  app.on('window-all-closed', () => undefined)
}

describe('a quit on the first-run screen (no backend) reaches will-quit and quit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('the cause: re-quitting from the settled teardown inside the prevented pass loses the quit', async () => {
    const e = electron()

    firstRunMain(e.app, () => e.app.quit())
    e.app.quit()
    await vi.advanceTimersByTimeAsync(60_000)

    // Both passes ran (the log's two 'before-quit seen' lines 1 ms apart), the window closed, and nothing quit.
    expect(e.trace).toEqual(['before-quit', 'before-quit', 'window-all-closed'])
    expect(e.exitCode()).toBeNull()
  })

  it('a quit without any signal reaches will-quit and quit within 5 s', async () => {
    const e = electron()
    const lines: string[] = []

    firstRunMain(e.app, createRequit({ quit: () => e.app.quit(), log: line => lines.push(line), defer: setImmediate }))
    e.app.quit()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(e.trace).toEqual(['before-quit', 'before-quit', 'will-quit', 'quit'])
    expect(e.exitCode()).toBe(0)
    expect(lines).toEqual([
      '[shutdown] backends settled: quitting again on the next turn',
      '[shutdown] re-quit after backends'
    ])
  })

  it('with the shutdown handlers installed: a clean quit line, status 0, no forced line; the old re-quit is forced at 12 s', async () => {
    const run = async (requitOf: (app: ReturnType<typeof electron>['app']) => (after: string) => void) => {
      const e = electron()
      const lines: string[] = []

      installShutdownSignals({
        app: e.app,
        process: new EventEmitter() as never,
        quitState: { isQuittingForHandoff: false },
        log: line => lines.push(line),
        beginTeardown: () => undefined,
        saveMinimumState: () => undefined,
        stopOwnedChildren: () => [],
        pendingTeardown: () => ['windows 0'],
        now: () => Date.now()
      })
      firstRunMain(e.app, requitOf(e.app))
      e.app.quit()
      await vi.advanceTimersByTimeAsync(20_000)

      return { e, lines }
    }

    const fixed = await run(app => createRequit({ quit: () => app.quit(), log: () => undefined, defer: setImmediate }))

    expect(fixed.e.exitCode()).toBe(0)
    expect(fixed.lines.at(-1)).toMatch(/^\[shutdown\] quit: clean quit after \d+ ms \(signal=no\)$/)
    expect(fixed.lines.some(line => line.includes('forcing exit'))).toBe(false)

    const old = await run(app => () => app.quit())

    expect(old.e.exitCode()).toBe(1)
    expect(old.lines.filter(line => line.includes('forcing exit'))).toEqual([
      '[shutdown] quit cap: forcing exit after 12000 ms; not finished: windows 0; stopped: none'
    ])
  })
})

describe('main.ts: every re-quit of the before-quit path goes through requitAfter()', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
  const start = main.indexOf('function heldQuitForActiveWork(')
  const end = main.indexOf("app.on('window-all-closed'")
  const quitPath = main.slice(start, end)

  it('no app.quit() runs from inside the before-quit dispatch', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(quitPath).not.toContain('app.quit()')

    for (const step of ['backends', 'ssh', 'remote updates', 'quit confirmation', 'quit confirmation (no dialog)']) {
      expect(quitPath).toContain(`requitAfter('${step}')`)
    }
  })

  it('the cap knows the active-work choice and the app-update install', () => {
    expect(quitPath).toMatch(/event\.preventDefault\(\)\s*quitPromptOpen = true\s*holdQuitForChoice\(\)/)
    expect(quitPath).toMatch(
      /consumeInstallLatch\(\)\) \{\s*quitConfirmedWithActiveWork = true\s*capQuitForInstall\(\)\s*\}/
    )
  })

  it('the remote-update wait has its own long cap, and the 12 s cap starts again only once it is joined', () => {
    expect(quitPath).toMatch(
      /quitTrace\('before-quit: prevented, waiting for remote updates'\)\s*(?:\/\/[^\n]*\s*)*capQuitForRemoteUpdates\(\)/
    )
    expect(quitPath).toMatch(
      /\.finally\(\(\) => \{\s*managedUpdateQuitWaitDone = true\s*quitRemoteUpdatesJoined\(\)\s*requitAfter\('remote updates'\)/
    )
  })
})
