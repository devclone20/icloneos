/**
 * v0.0.9 (#8, user input loss, traced in v009-trace2.md): typing right after the first Enter of a fresh chat could be
 * wiped. On that first send the composer's key goes null → the created session id; the [activeQueueSessionKey] layout
 * effect took the new key's (empty) draft and loaded it into the FOCUSED editor, erasing what was typed since Enter
 * (log: swap to=<id> editorText="E2E " stashed=""). Red before: the editor read ''.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearSessionDraft, stashSessionDraft } from '@/store/composer'

import type { QueueEditState } from '../composer-utils'

import { useComposerDraft } from './use-composer-draft'

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ composer: () => ({ setText: vi.fn() }) }),
  useAuiState: (selector: (s: { composer: { text: string } }) => unknown) => selector({ composer: { text: '' } }),
  useComposerRuntime: () => ({ getState: () => ({ text: '' }), subscribe: () => () => undefined })
}))

function Harness({ keyId }: { keyId: null | string }) {
  const { editorRef } = useComposerDraft({
    activeQueueSessionKey: keyId,
    focusKey: null,
    inputDisabled: false,
    queueEditRef: { current: null as QueueEditState | null },
    sessionId: keyId ?? ''
  })

  return (
    <div
      contentEditable
      data-testid="ed"
      ref={el => {
        editorRef.current = el
      }}
      suppressContentEditableWarning
    />
  )
}

afterEach(() => {
  cleanup()
  clearSessionDraft(null)
  clearSessionDraft('created-1')
  clearSessionDraft('other-1')
  clearSessionDraft('other-2')
})

describe('a fresh chat adopting its created session id keeps what was typed after Enter', () => {
  it('does not repaint the focused editor with the empty draft of the new key', () => {
    const { getByTestId, rerender } = render(<Harness keyId={null} />)
    const editor = getByTestId('ed')

    editor.focus()
    editor.textContent = 'E2E ' // typed between Enter and the session being created

    act(() => rerender(<Harness keyId="created-1" />))

    expect(editor.textContent).toBe('E2E ')
  })

  it('a real switch between two sessions still loads the incoming session draft', () => {
    stashSessionDraft('other-2', 'draft of two', [])
    const { getByTestId, rerender } = render(<Harness keyId="other-1" />)
    const editor = getByTestId('ed')

    editor.textContent = 'draft of one'
    act(() => rerender(<Harness keyId="other-2" />))

    expect(editor.textContent).toBe('draft of two')
  })
})
