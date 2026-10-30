import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_WALLET_VIEW, readWalletView, writeWalletView } from './wallet-view'

describe('wallet view prefs', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to all assets with empties hidden', () => {
    expect(readWalletView('slug')).toEqual(DEFAULT_WALLET_VIEW)
  })

  it('round-trips per iNFT', () => {
    writeWalletView('one', { selectedChain: 'base-mainnet', showEmpty: true })

    expect(readWalletView('one')).toEqual({ selectedChain: 'base-mainnet', showEmpty: true })
    expect(readWalletView('two')).toEqual(DEFAULT_WALLET_VIEW)
  })

  it('tolerates garbage and wrong types', () => {
    window.localStorage.setItem('iclone.econ.wallet.view.bad', '{not json')
    window.localStorage.setItem('iclone.econ.wallet.view.typed', JSON.stringify({ selectedChain: 7, showEmpty: 'yes' }))

    expect(readWalletView('bad')).toEqual(DEFAULT_WALLET_VIEW)
    expect(readWalletView('typed')).toEqual(DEFAULT_WALLET_VIEW)
  })
})
