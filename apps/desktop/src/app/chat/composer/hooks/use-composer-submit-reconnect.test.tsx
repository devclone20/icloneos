import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearSessionDraft } from '@/store/composer'

import { useComposerSubmit } from './use-composer-submit'

vi.mock('@/components/pane-shell/pane-visibility', () => ({ usePaneVisible: () => true }))
vi.mock('../scope', () => ({
  useComposerScope: () => ({ attachments: { clear: () => undefined }, target: 'main' }),
  useComposerSurfaceId: () => null
}))
vi.mock('@/store/composer', async importOriginal => ({
  ...(await importOriginal<object>()),
  clearSessionDraft: vi.fn()
}))

function setup(flags: { disabled: boolean; sendHolds: boolean }) {
  const draftRef = { current: 'sent during the restart' }
  const onSubmit = vi.fn(async () => true)

  const args = {
    activeQueueSessionKey: 'stored-1',
    activeQueueSessionKeyRef: { current: 'stored-1' },
    attachments: [],
    busy: false,
    clearDraft: () => {
      draftRef.current = ''
    },
    compacting: false,
    draftRef,
    drainNextQueued: async () => false,
    editorRef: { current: null },
    exitQueuedEdit: () => false,
    focusInput: () => undefined,
    inputDisabled: false,
    loadIntoComposer: () => undefined,
    onCancel: () => undefined,
    onSubmit,
    queueCurrentDraft: () => false,
    queueEdit: null,
    queuedPrompts: [],
    sessionId: 'rt-1',
    setComposerText: () => undefined,
    stashAt: () => undefined,
    ...flags
  }

  return { onSubmit, result: renderHook(() => useComposerSubmit(args as never)).result }
}

afterEach(() => {
  cleanup()
  vi.mocked(clearSessionDraft).mockClear()
})

describe('Enter while the gateway reconnects', () => {
  it('hands the words to the send path once, instead of ignoring the key', async () => {
    const { onSubmit, result } = setup({ disabled: true, sendHolds: true })
    await act(async () => result.current.submitDraft())
    await act(async () => result.current.submitDraft())
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('drops the stashed copy at once, so the reconnect cannot load it back beside the held send', async () => {
    const { result } = setup({ disabled: true, sendHolds: true })
    let order = 0
    vi.mocked(clearSessionDraft).mockImplementation(() => void (order = 1))
    act(() => result.current.submitDraft())
    expect(order).toBe(1)
  })

  it('still ignores the key when the composer is disabled for any other reason', async () => {
    const { onSubmit, result } = setup({ disabled: true, sendHolds: false })
    await act(async () => result.current.submitDraft())
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
