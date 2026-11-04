import { describe, expect, it, vi } from 'vitest'

import {
  applyConnectionChange,
  commitConnectionFailure,
  REMOTE_REAP_CAP_MS,
  resolveTerminalConnection,
  teardownSshState,
  type TerminalSshTarget
} from './connection-apply'

function deferred() {
  let resolve!: () => void

  const promise = new Promise<void>(done => {
    resolve = done
  })

  return { promise, resolve }
}

describe('applyConnectionChange', () => {
  it.each([['SSH A to SSH B'], ['SSH to Cloud'], ['Cloud to SSH']])(
    'serializes %s behind bootstrap rollback before teardown and apply',
    async () => {
      const gate = deferred()
      const events: string[] = []

      const run = applyConnectionChange({
        cancelAndWait: async () => {
          events.push('cancel')
          await gate.promise
          events.push('drained')
        },
        isPrimary: true,
        scope: '',
        sendApplied: () => events.push('applied'),
        stopPool: vi.fn(),
        teardownPrimary: async () => {
          events.push('primary')
        },
        teardownSsh: async () => {
          events.push('ssh')
        }
      })

      await Promise.resolve()
      expect(events).toEqual(['cancel'])
      gate.resolve()
      await run
      expect(events).toEqual(['cancel', 'drained', 'ssh', 'primary', 'applied'])
    }
  )

  it('tears down only a non-primary scope without applying the primary connection', async () => {
    const events: string[] = []
    await applyConnectionChange({
      cancelAndWait: async scope => {
        events.push(`cancel:${scope}`)
      },
      isPrimary: false,
      scope: 'worker',
      sendApplied: () => events.push('applied'),
      stopPool: scope => events.push(`pool:${scope}`),
      teardownPrimary: async () => {
        events.push('primary')
      },
      teardownSsh: async scope => {
        events.push(`ssh:${scope}`)
      }
    })
    expect(events).toEqual(['cancel:worker', 'ssh:worker', 'pool:worker'])
  })
})

describe('resolveTerminalConnection', () => {
  it('joins an in-flight backend before resolving the SSH terminal target', async () => {
    const target: TerminalSshTarget = { ssh: { host: 'gpu-box', user: 'ops' }, scope: 'ssh:ops@gpu-box' }
    const getTarget = vi.fn().mockReturnValueOnce('pending').mockReturnValueOnce(target)
    const ensureBackend = vi.fn(async () => undefined)

    await expect(resolveTerminalConnection(getTarget, ensureBackend)).resolves.toBe(target)
    expect(ensureBackend).toHaveBeenCalledOnce()
  })

  it('does not start a local terminal while configured SSH remains unavailable', async () => {
    await expect(
      resolveTerminalConnection(
        () => 'pending',
        async () => undefined
      )
    ).rejects.toThrow('not ready')
  })
})

describe('teardownSshState', () => {
  it('terminates the owned remote backend before closing its tunnel and SSH transport', async () => {
    const events: string[] = []

    const ssh = {
      exec: async () => '',
      cancelForward: async () => events.push('forward'),
      close: async () => events.push('ssh')
    }

    await teardownSshState(
      { ssh, ownershipId: 'owner', localPort: 1234, remotePort: 5678 },
      { cleanupRemote: async () => events.push('remote') }
    )

    expect(events).toEqual(['remote', 'forward', 'ssh'])
  })

  it('still closes the SSH transport when remote cleanup fails', async () => {
    const close = vi.fn(async () => undefined)

    await teardownSshState(
      { ssh: { exec: async () => '', cancelForward: vi.fn(async () => undefined), close }, ownershipId: 'owner' },
      {
        cleanupRemote: async () => {
          throw new Error('remote unavailable')
        }
      }
    )

    expect(close).toHaveBeenCalledOnce()
  })

  it('m3: a failing cancel-forward or close is logged by its class only, never silent', async () => {
    const lines: string[] = []

    await teardownSshState(
      {
        ssh: {
          exec: async () => '',
          cancelForward: async () => {
            throw new RangeError('ssh -O cancel user@secret-host failed')
          },
          close: async () => {
            throw new TypeError('ssh -O exit /Users/someone/.ssh/cm failed')
          }
        },
        ownershipId: 'owner',
        localPort: 1234,
        remotePort: 5678
      },
      { cleanupRemote: async () => 'killed', log: line => lines.push(line) }
    )

    expect(lines).toEqual([
      '[ssh] remote serve reap: killed',
      '[ssh] cancel forward failed: RangeError',
      '[ssh] closing the connection failed: TypeError'
    ])
  })

  it('m5: a reap past its own cap (5.5 s) is cut, so the forward and the transport close inside the 6 s quit race', async () => {
    vi.useFakeTimers()

    try {
      const events: string[] = []
      const lines: string[] = []

      const done = teardownSshState(
        {
          ssh: {
            exec: async () => '',
            cancelForward: async () => events.push('forward'),
            close: async () => events.push('ssh')
          },
          ownershipId: 'owner',
          localPort: 1234,
          remotePort: 5678
        },
        // A serve that rides out SIGTERM: TERM wait, SIGKILL wait and the probe never settle inside the race.
        { cleanupRemote: () => new Promise(() => undefined), log: line => lines.push(line) }
      )

      await vi.advanceTimersByTimeAsync(REMOTE_REAP_CAP_MS - 1)
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(REMOTE_REAP_CAP_MS).toBeLessThan(6_000)
      expect(events).toEqual(['forward', 'ssh'])
      expect(lines).toEqual(['[ssh] remote serve reap: timed out'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('commitConnectionFailure', () => {
  it('prevents a stale bootstrap from publishing failure state', () => {
    const stale = Promise.resolve('stale')
    const current = Promise.resolve('current')
    const commit = vi.fn()

    expect(commitConnectionFailure(current, stale, commit)).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(commitConnectionFailure(current, current, commit)).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
  })
})
