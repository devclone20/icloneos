import { describe, expect, it, vi } from 'vitest'

import { inftGate } from './inft-gate'

type InftGateState = Parameters<typeof inftGate>[0]
type InftGateActions = Parameters<typeof inftGate>[1]

const READY: InftGateState = {
  configured: true,
  hasInft: true,
  inftName: 'iCLONE #7',
  label: 'ACP Market',
  liveEnabled: true,
  restoring: false,
  signedIn: true
}

function actions(): InftGateActions {
  return { connectWallet: vi.fn(), openInfts: vi.fn(), openLiveSettings: vi.fn(), openSetup: vi.fn() }
}

describe('inftGate', () => {
  it('a fresh, signed-out user is asked to connect a wallet, and the action does it', () => {
    const on = actions()
    const gate = inftGate({ ...READY, hasInft: false, signedIn: false }, on)

    expect(gate?.title).toBe('Connect a wallet')
    expect(gate?.hint).toMatch(/^Connect a wallet to summon your iNFT\. ACP Market then opens/)
    expect(gate?.action?.label).toBe('Connect wallet')
    gate?.action?.onClick()
    expect(on.connectWallet).toHaveBeenCalledOnce()
  })

  it('signed out with an iNFT still on stage: signed out, with the same connect action', () => {
    const on = actions()
    const gate = inftGate({ ...READY, signedIn: false }, on)

    expect(gate?.title).toBe('Signed out')
    gate?.action?.onClick()
    expect(on.connectWallet).toHaveBeenCalledOnce()
  })

  it('while a remembered session restores it never tells the owner to connect', () => {
    const gate = inftGate({ ...READY, hasInft: false, restoring: true, signedIn: false }, actions())

    expect(gate?.title).toBe('Signing you in…')
    expect(gate?.action).toBeUndefined()
  })

  it('signed in with no iNFT on stage: summon one, and the action opens the iNFT island', () => {
    const on = actions()
    const gate = inftGate({ ...READY, hasInft: false }, on)

    expect(gate?.title).toBe('Summon an iNFT')
    expect(gate?.hint).toMatch(/^ACP Market belongs to an iNFT\./)
    expect(gate?.action?.label).toBe('Open iNFTs')
    gate?.action?.onClick()
    expect(on.openInfts).toHaveBeenCalledOnce()
  })

  it('an iNFT not bound to its agent yet opens Setup', () => {
    const on = actions()
    const gate = inftGate({ ...READY, configured: false }, on)

    expect(gate?.title).toBe('Setup needed')
    expect(gate?.hint).toMatch(/^iCLONE #7 is not bound/)
    gate?.action?.onClick()
    expect(on.openSetup).toHaveBeenCalledOnce()
  })

  it('the live engine off opens its setting', () => {
    const on = actions()
    const gate = inftGate({ ...READY, liveEnabled: false }, on)

    expect(gate?.title).toBe('Live engine is off')
    gate?.action?.onClick()
    expect(on.openLiveSettings).toHaveBeenCalledOnce()
  })

  it('a configured iNFT with the engine on renders the app (no gate)', () => {
    expect(inftGate(READY, actions())).toBeNull()
  })
})
