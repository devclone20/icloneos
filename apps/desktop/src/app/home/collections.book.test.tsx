// G4 k = 0: signed in, iNFTs in the wallet, none checked — Home says the rule
// and offers the Book, instead of a broken or silent grid.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'

import { CollectionsPanel } from './collections'

afterEach(cleanup)

const copy = en.inftBook

describe('the Home collection under the iNFT Book rule', () => {
  it('nothing checked: the stated empty state, with the door to Settings › iNFT Book', () => {
    const onOpen = vi.fn()
    const errors = vi.spyOn(console, 'error')

    const { container } = render(
      <CollectionsPanel
        bookEmpty={{ action: copy.openBook, line: copy.homeEmpty, onOpen, rule: copy.rule }}
        cards={[]}
        onClose={() => undefined}
        onSelect={() => undefined}
        scanStatus="ready"
        signedIn
      />
    )

    expect(screen.getByText('Home shows only the iNFTs you check in the iNFT Book.')).toBeTruthy()
    expect(screen.getByText(copy.homeEmpty)).toBeTruthy()
    expect(container.ownerDocument.querySelector('.inft-panel__body')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: copy.openBook }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })

  it('a wallet with no iNFTs at all keeps its own line', () => {
    render(
      <CollectionsPanel cards={[]} onClose={() => undefined} onSelect={() => undefined} scanStatus="ready" signedIn />
    )

    expect(screen.getByText('No iNFTs in this wallet yet.')).toBeTruthy()
  })
})
