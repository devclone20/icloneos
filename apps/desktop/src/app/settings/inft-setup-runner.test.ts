import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cliJson, pickString, useStepRunner } from './inft-setup-runner'

const acp = vi.hoisted(() => ({ refreshAcpStatus: vi.fn(), runAcp: vi.fn() }))

vi.mock('../home/acp-setup', () => acp)

const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })

describe('inft-setup runner helpers', () => {
  it('pickString returns the first non-empty key', () => {
    expect(pickString({ a: '', b: 'x', c: 'y' }, ['a', 'b', 'c'])).toBe('x')
    expect(pickString(null, ['a'])).toBeUndefined()
  })

  it('cliJson reads CLI stdout as a record', () => {
    expect(cliJson(ok('{"url":"https://x"}'))).toEqual({ url: 'https://x' })
    expect(cliJson(null)).toBeNull()
  })
})

describe('useStepRunner', () => {
  beforeEach(() => {
    acp.refreshAcpStatus.mockReset().mockResolvedValue(undefined)
    acp.runAcp.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  it('reflects a CLI call into its step row', async () => {
    acp.runAcp.mockResolvedValueOnce(ok(' balance 1 ')).mockResolvedValueOnce({ ...ok(''), ok: false, code: 2 })
    const { result } = renderHook(() => useStepRunner('inft-1'))

    await act(() => result.current.exec('wallet', ['wallet', 'balance', '--json']))
    expect(acp.runAcp).toHaveBeenCalledWith('inft-1', ['wallet', 'balance', '--json'], undefined)
    expect(result.current.steps.wallet).toMatchObject({ running: false, output: 'balance 1', error: undefined })

    await act(() => result.current.exec('wallet', ['wallet', 'balance', '--json']))
    expect(result.current.steps.wallet?.error).toBe('exit 2')
  })

  it('runs nothing without an iNFT', async () => {
    const { result } = renderHook(() => useStepRunner(null))

    await expect(result.current.exec('wallet', ['wallet', 'balance'])).resolves.toBeNull()
    expect(acp.runAcp).not.toHaveBeenCalled()
  })

  it('polls until done and starts clean for another iNFT', async () => {
    vi.useFakeTimers()
    acp.runAcp.mockResolvedValueOnce(ok('{"status":"pending"}')).mockResolvedValueOnce(ok('{"status":"authenticated"}'))
    const onDone = vi.fn()
    const { rerender, result } = renderHook(({ id }) => useStepRunner(id), { initialProps: { id: 'inft-1' } })

    act(() =>
      result.current.pollUntil('auth', ['configure', 'complete'], json => json?.status === 'authenticated', onDone)
    )
    await act(() => vi.advanceTimersByTimeAsync(3_500))
    expect(onDone).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(3_500))
    expect(onDone).toHaveBeenCalledOnce()
    expect(result.current.steps.auth?.note).toBe('done ✓')

    rerender({ id: 'inft-2' })
    expect(result.current.steps).toEqual({})
    expect(acp.refreshAcpStatus).toHaveBeenLastCalledWith('inft-2')
  })
})
