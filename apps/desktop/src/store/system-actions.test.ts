import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getActionStatus = vi.fn()
const restartGateway = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', () => ({
  getActionStatus: (...args: unknown[]) => getActionStatus(...args),
  restartGateway: (...args: unknown[]) => restartGateway(...args)
}))

vi.mock('@/i18n', () => ({
  translateNow: (key: string) => key
}))

vi.mock('@/store/notifications', () => ({
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

const { $gatewayRestarting, runGatewayRestart } = await import('./system-actions')

describe('runGatewayRestart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getActionStatus.mockReset()
    restartGateway.mockReset().mockResolvedValue({ name: 'gateway-restart' })
    notifyError.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits one poll interval before each status read and stops when the action ends', async () => {
    getActionStatus.mockResolvedValueOnce({ running: true }).mockResolvedValueOnce({ exit_code: 0, running: false })

    const done = runGatewayRestart()

    expect($gatewayRestarting.get()).toBe(true)
    await vi.advanceTimersByTimeAsync(1199)
    expect(getActionStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(getActionStatus).toHaveBeenCalledTimes(1)
    expect(getActionStatus).toHaveBeenCalledWith('gateway-restart', 180)
    await vi.advanceTimersByTimeAsync(1200)
    await done

    expect(getActionStatus).toHaveBeenCalledTimes(2)
    expect(notifyError).not.toHaveBeenCalled()
    expect($gatewayRestarting.get()).toBe(false)
  })

  it('toasts a non-zero exit and clears the restarting flag', async () => {
    getActionStatus.mockResolvedValueOnce({ exit_code: 1, running: false })

    const done = runGatewayRestart()

    await vi.advanceTimersByTimeAsync(1200)
    await done

    expect(notifyError).toHaveBeenCalledTimes(1)
    expect((notifyError.mock.calls[0][0] as Error).message).toBe('commandCenter.gatewayRestartFailed')
    expect($gatewayRestarting.get()).toBe(false)
  })

  it('gives up silently after the bounded poll window', async () => {
    getActionStatus.mockResolvedValue({ running: true })

    const done = runGatewayRestart()

    await vi.advanceTimersByTimeAsync(18 * 1200)
    await done

    expect(getActionStatus).toHaveBeenCalledTimes(18)
    expect(notifyError).not.toHaveBeenCalled()
    expect($gatewayRestarting.get()).toBe(false)
  })
})
