import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { PROVIDER_SETTINGS_LINK } from '@/app/chat/provider-block-banner'

import { stubThreadEnvironment } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()

afterEach(() => {
  cleanup()
})

const createdAt = new Date('2026-10-16T00:00:00.000Z')

function failedTurn(): ThreadMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'Reply with the single word OK' }],
      attachments: [],
      createdAt,
      metadata: { custom: {} }
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: [],
      status: { type: 'incomplete', reason: 'error', error: 'HTTP 401: invalid x-api-key' },
      createdAt,
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {
          errorSurface: {
            layer: 'provider',
            code: 'non_retryable_client_error',
            retryable: false,
            provider: 'anthropic'
          }
        }
      }
    }
  ] as unknown as ThreadMessage[]
}

function Where() {
  const { pathname, search } = useLocation()

  return <div data-testid="where">{pathname + search}</div>
}

function Harness() {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: failedTurn(),
    isRunning: false,
    onNew: async () => {}
  })

  return (
    <MemoryRouter initialEntries={['/']}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
      <Routes>
        <Route element={<Where />} path="*" />
      </Routes>
    </MemoryRouter>
  )
}

describe('failed card · Switch provider', () => {
  it('lands on Settings → Providers, not the Model page', async () => {
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: /switch provider/i }))

    expect(screen.getByTestId('where').textContent).toBe(PROVIDER_SETTINGS_LINK)
    expect(PROVIDER_SETTINGS_LINK).toMatch(/[?&]tab=providers\b/)
  })
})
