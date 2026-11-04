// A quit with a live SSH connection (signal or not) waits for the SSH teardown: the owned remote serve is killed and
// the control master closed before the app quits, even when another step's re-quit (the backends) comes first.
// The SSH connection is a stand-in: no ssh runs.
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createRequit, type SshQuitTeardown, sshQuitTeardownStep } from './main/shutdown-signals-app'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => (resolve = r))

  return { promise, resolve }
}

/**
 * The SSH and backend part of main.ts's before-quit, in its order, over a stand-in SSH connection whose teardown
 * drops the connection from the live map at once (as teardownSshConnection does) and finishes later.
 */
function app(options: { cleanupThrows?: boolean } = {}) {
  const trace: string[] = []
  const connections = new Map([['shimhost', { owned: true }]])
  const sshDone = deferred()
  const ssh: SshQuitTeardown = { done: false, started: false }
  let backendsDone = false
  let teardowns = 0

  const teardownConnection = async (scope: string) => {
    teardowns += 1
    connections.delete(scope)
    await sshDone.promise
    trace.push('remote serve killed')
    trace.push('control master closed')
  }

  const requit = createRequit({
    defer: run => setImmediate(run),
    log: () => undefined,
    quit: () => beforeQuit()
  })

  function beforeQuit() {
    let prevented = false

    if (!backendsDone) {
      prevented = true
      void Promise.resolve().finally(() => {
        backendsDone = true
        requit('backends')
      })
    }

    const step = sshQuitTeardownStep(ssh, { bootstraps: 0, connections: connections.size })

    if (step === 'wait') {
      prevented = true
    }

    if (step === 'start') {
      ssh.started = true
      prevented = true
      const pending = Promise.allSettled([...connections.keys()].map(teardownConnection))

      void pending
        .then(async () => {
          try {
            if (options.cleanupThrows) {
              throw new Error('force cleanup failed')
            }
          } finally {
            ssh.done = true
            requit('ssh')
          }
        })
        .catch(() => undefined)
    }

    trace.push(prevented ? 'before-quit prevented' : 'quit')
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 5))

  return {
    beforeQuit,
    settle,
    sshDone,
    state: () => ({ connections: connections.size, teardowns }),
    trace
  }
}

describe('quit with a live SSH connection', () => {
  it('the backends re-quit first: the quit still waits until the remote serve is killed and the master closed', async () => {
    const a = app()

    a.beforeQuit()
    await a.settle()

    // The backends settled and quit again; the teardown already emptied the map but is not done.
    expect(a.state()).toEqual({ connections: 0, teardowns: 1 })
    expect(a.trace).toEqual(['before-quit prevented', 'before-quit prevented'])
    expect(a.trace).not.toContain('quit')

    a.sshDone.resolve()
    await a.settle()

    expect(a.trace).toEqual([
      'before-quit prevented',
      'before-quit prevented',
      'remote serve killed',
      'control master closed',
      'quit'
    ])
    // One teardown per quit, never a second one from a later pass.
    expect(a.state().teardowns).toBe(1)
  })

  it('a cleanup that throws still ends the wait and quits', async () => {
    const a = app({ cleanupThrows: true })

    a.beforeQuit()
    a.sshDone.resolve()
    await a.settle()
    await a.settle()

    expect(a.trace.at(-1)).toBe('quit')
  })
})

describe('sshQuitTeardownStep', () => {
  it.each([
    [{ done: false, started: false }, { bootstraps: 0, connections: 0 }, 'pass'],
    [{ done: false, started: false }, { bootstraps: 0, connections: 1 }, 'start'],
    [{ done: false, started: false }, { bootstraps: 1, connections: 0 }, 'start'],
    // Started: the live map is empty by now, and the pass still waits.
    [{ done: false, started: true }, { bootstraps: 0, connections: 0 }, 'wait'],
    [{ done: false, started: true }, { bootstraps: 0, connections: 1 }, 'wait'],
    [{ done: true, started: true }, { bootstraps: 0, connections: 0 }, 'pass'],
    [{ done: true, started: true }, { bootstraps: 1, connections: 1 }, 'pass']
  ] as const)('%o with %o: %s', (state, live, step) => {
    expect(sshQuitTeardownStep(state, live)).toBe(step)
  })
})

describe('main.ts: before-quit asks sshQuitTeardownStep and holds while the teardown runs', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('window-all-closed'"))

  it('one decision per pass, from the teardown state and the live counts', () => {
    expect(beforeQuit).toMatch(
      /const sshStep = sshQuitTeardownStep\(sshQuitTeardown, \{\s*bootstraps: sshBootstrapCoordinator\.promises\(\)\.length,\s*connections: sshConnections\.size\s*\}\)/
    )
    // The old re-read of the live map, which let a pass through mid-teardown, is gone.
    expect(beforeQuit).not.toMatch(/sshConnections\.size > 0 \|\|/)
  })

  it("'wait' prevents the quit; 'start' marks the teardown started before it prevents and starts it", () => {
    expect(beforeQuit).toMatch(/if \(sshStep === 'wait'\) \{[^}]*event\.preventDefault\(\)/)
    expect(beforeQuit).toMatch(
      /if \(sshStep === 'start'\) \{\s*sshQuitTeardown\.started = true\s*event\.preventDefault\(\)/
    )
  })

  it('the teardown is marked done in a finally, before its re-quit', () => {
    expect(beforeQuit).toMatch(
      /try \{\s*await sshBootstrapCoordinator\.forceCleanupAll\(\)\s*\} finally \{\s*sshQuitTeardown\.done = true\s*requitAfter\('ssh'\)/
    )
  })
})
