import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MarkdownTextContent } from './markdown-text'

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

describe('MarkdownTextContent app links', () => {
  it('turns iclone://open/settings into an in-app route the user can click', async () => {
    render(<MarkdownTextContent isRunning={false} text="[Open Updates](iclone://open/settings?tab=app-atualisation)" />)

    const link = await screen.findByText('Open Updates')

    expect(link.closest('a')?.getAttribute('href')).toBe('#/settings?tab=app-atualisation')
    fireEvent.click(link)
    expect(window.location.hash).toBe('#/settings?tab=app-atualisation')
  })

  it('does not route an iclone:// link that is off the allow-list', async () => {
    render(<MarkdownTextContent isRunning={false} text="[bad](iclone://open/..%2F..%2Fetc)" />)

    await screen.findByText(/bad/)

    expect(screen.queryByRole('link')).toBeNull()
    expect(window.location.hash).toBe('')
  })
})
