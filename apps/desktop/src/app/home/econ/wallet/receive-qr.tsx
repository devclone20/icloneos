/**
 * EconomyOS — Wallet · the Receive aside: one QR code per address (the EVM
 * address is the same on every EVM chain, Solana has its own), the address in
 * full beside a copy button, and the chains the agent can receive on.
 *
 * The encoder (`qrcode`) is fetched on first use, not with the wallet: only
 * this tile needs it, and the window's first paint never pays for it.
 */
import { memo, useEffect, useMemo, useState } from 'react'

import type { AcpFailure } from '../cli'
import { explorerAddressUrl } from '../format'
import { Action, AddressChip, CopyText, Empty, Pill, SectionTitle, Tabs } from '../ui'

import { chainsForFamily, RECEIVE_QR_OPTIONS, receiveCaption, type ReceiveFamily, receiveTargets } from './receive-data'
import type { ChainListResult, WalletChain } from './wallet-data'
import { hrefOrUndefined } from './wallet-view'

interface QrState {
  url: string | null
  failed: boolean
}

// Encoded once per address for the session: a tab switch shows its tile at once.
const encoded = new Map<string, string>()
const NO_CHAINS: WalletChain[] = []

function useQrDataUrl(address: string): QrState {
  const [state, setState] = useState<QrState>(() => ({ url: encoded.get(address) ?? null, failed: false }))

  useEffect(() => {
    const known = encoded.get(address)

    if (known) {
      setState(current => (current.url === known ? current : { url: known, failed: false }))

      return
    }

    let cancelled = false

    setState({ url: null, failed: false })

    import('qrcode')
      .then(QRCode => QRCode.toDataURL(address, RECEIVE_QR_OPTIONS))
      .then(url => {
        if (!cancelled) {
          encoded.set(address, url)
          setState({ url, failed: false })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ url: null, failed: true })
        }
      })

    return () => {
      cancelled = true
    }
  }, [address])

  return state
}

const QrTile = memo(function QrTile({ address, label }: { address: string; label: string }) {
  const { failed, url } = useQrDataUrl(address)

  return (
    <div aria-busy={!url && !failed} className={url ? 'wallet-qr' : 'wallet-qr wallet-qr--pending'}>
      {url ? (
        <img
          alt={`${label} address QR code`}
          className="wallet-qr__img"
          decoding="async"
          height={176}
          src={url}
          width={176}
        />
      ) : failed ? (
        <span className="wallet-qr__error" role="status">
          The code could not be drawn — copy the address instead.
        </span>
      ) : null}
    </div>
  )
})

interface ReceiveAsideProps {
  agentName: string
  chains: ChainListResult | null
  /** The chain list could not be read (and nothing is known yet): say so, offer a retry. */
  chainsError: AcpFailure | null
  /** The chain list is on its way and nothing is known yet. */
  chainsPending: boolean
  evmAddress: string
  onRetryChains: () => void
  solanaAddress: string
}

export const ReceiveAside = memo(function ReceiveAside({
  agentName,
  chains,
  chainsError,
  chainsPending,
  evmAddress,
  onRetryChains,
  solanaAddress
}: ReceiveAsideProps) {
  const targets = useMemo(() => receiveTargets(evmAddress, solanaAddress), [evmAddress, solanaAddress])
  const [family, setFamily] = useState<ReceiveFamily>('evm')
  const target = targets.find(candidate => candidate.family === family) ?? targets[0] ?? null

  const familyChains = useMemo(
    () => (target ? chainsForFamily(chains?.chains ?? NO_CHAINS, target.family) : []),
    [chains, target]
  )

  const tabs = useMemo(() => targets.map(candidate => ({ id: candidate.family, label: candidate.label })), [targets])

  if (!target) {
    return (
      <>
        <SectionTitle>Receive</SectionTitle>
        <Empty
          hint={`${agentName}'s addresses appear here as soon as the agent's wallet is provisioned.`}
          title="No address yet"
        />
      </>
    )
  }

  return (
    <>
      <SectionTitle end={targets.length > 1 ? <Tabs items={tabs} onChange={setFamily} value={target.family} /> : null}>
        Receive
      </SectionTitle>
      <div className="e-pad wallet-receive">
        <QrTile address={target.address} label={target.label} />
        <div className="wallet-receive__addr">
          <span className="e-field__label">{target.label} address</span>
          <div className="wallet-receive__row">
            <span className="wallet-receive__big">{target.address}</span>
            <CopyText text={target.address} />
          </div>
          <AddressChip
            address={target.address}
            href={hrefOrUndefined(explorerAddressUrl(target.explorerNetwork, target.address))}
          />
        </div>
        <p className="wallet-receive__caption">{receiveCaption(target.family, chains?.chains ?? NO_CHAINS)}</p>
        {familyChains.length > 0 ? (
          <div className="wallet-receive__chains">
            {familyChains.map(chain => (
              <Pill key={chain.id}>{chain.name}</Pill>
            ))}
          </div>
        ) : chainsPending ? (
          <span className="wallet-receive__pending">reading supported chains…</span>
        ) : chainsError ? (
          <span className="wallet-receive__pending" role="status">
            chain list unavailable ·{' '}
            <Action kind="quiet" onClick={onRetryChains}>
              try again
            </Action>
          </span>
        ) : null}
      </div>
    </>
  )
})
