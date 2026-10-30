/**
 * EconomyOS — Wallet.
 *
 * Paints from the last snapshot before any CLI answer, then reads through the
 * cache the dock prefetch warmed; the header says how old what you see is.
 * Balances alone gate the paint — compute follows behind it, the chain list
 * is read only when an aside that shows it opens, and the forms own their
 * fields so typing never touches the table.
 */
import './wallet.css'

import { Cpu, Layers, TrendingUp, Wallet as WalletIcon } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useEconPanelEscape } from '@/app/home/home-escape'

import { type AcpFailure, needsSetup } from '../cli'
import { failureNote } from '../failure-note'
import { explorerAddressUrl, signedUsd, timeAgo, tokenAmount, usd } from '../format'
import { useAskInft, useOpenSetup } from '../handoff'
import { reportEconStatus, useAutoRefresh } from '../live'
import { useSnapshot } from '../snapshot'
import type { EconAppProps } from '../types'
import {
  Action,
  AddressChip,
  AppFrame,
  Avatar,
  Cell,
  Empty,
  Money,
  Note,
  Pill,
  RailItem,
  RailSection,
  Row,
  Rows,
  SectionTitle,
  Signed,
  SkeletonRows,
  SkeletonStats,
  Stat,
  StatRow,
  Toolbar
} from '../ui'

import { ReceiveAside } from './receive-qr'
import {
  assetName,
  type ChainListResult,
  compactUsd,
  computeModelLabel,
  type ComputeStatus,
  countChains,
  failureLabel,
  groupHeldByChain,
  isWalletSnapshot,
  priceText,
  readBalances,
  readChains,
  readCompute,
  readWalletSnapshot,
  splitByBalance,
  toWalletSnapshot,
  valueKnown,
  WALLET_SNAPSHOT_VERSION,
  type WalletBalances,
  type WalletChain,
  type WalletChainGroup,
  type WalletChainTotal,
  type WalletStock,
  type WalletToken
} from './wallet-data'
import { ComputeTopUpForm, SendForm, TopUpForm } from './wallet-forms'
import { hrefOrUndefined, readWalletView, type WalletView, writeWalletView } from './wallet-view'

type MainView = 'assets' | 'compute' | 'stocks'
type AsideView = 'none' | 'receive' | 'send' | 'topup'

interface Latest {
  balances: WalletBalances | null
  compute: ComputeStatus | null
  chains: ChainListResult | null
  /** The balance read's own `at` — what the snapshot is stamped with. */
  at: number
}

const NARROW_BREAKPOINT = 900
const EMPTY_SPLIT: { held: WalletToken[]; empty: WalletToken[] } = { held: [], empty: [] }
const NO_CHAINS: WalletChain[] = []
const NO_CHAIN_TOTALS: WalletChainTotal[] = []
const NO_GROUPS: WalletChainGroup[] = []

// ── rows ────────────────────────────────────────────────────────────────────

/** `compact`: an aside is open beside the table, so the PRICE column steps out
 *  and the four that remain fit the narrower main column. */
const AssetRow = memo(function AssetRow({ compact, token }: { compact: boolean; token: WalletToken }) {
  const name = assetName(token)

  return (
    <Row>
      <Cell grow>
        <span className="wallet-asset">
          <Avatar name={token.symbol} size={22} src={token.logo} />
          <span className="wallet-asset__text">
            <span>{token.symbol}</span>
            {name ? <span className="wallet-asset__name">{name}</span> : null}
          </span>
        </span>
      </Cell>
      <Cell width={104}>
        <Pill tone="tone">{token.chainLabel}</Pill>
      </Cell>
      <Cell align="end" mono width={96}>
        {tokenAmount(token.amount)}
      </Cell>
      {compact ? null : (
        <Cell align="end" mono width={84}>
          {priceText(token)}
        </Cell>
      )}
      <Cell align="end" mono width={104}>
        {valueKnown(token) ? <Money value={token.usd} /> : '—'}
      </Cell>
    </Row>
  )
})

const StockRow = memo(function StockRow({ stock }: { stock: WalletStock }) {
  return (
    <Row>
      <Cell grow>
        <span className="wallet-asset">
          <Avatar name={stock.symbol} size={22} />
          <span className="wallet-asset__text">
            <span>{stock.symbol}</span>
            <span className="wallet-asset__name">{stock.name}</span>
          </span>
        </span>
      </Cell>
      <Cell align="end" mono width={90}>
        {tokenAmount(stock.amount)}
      </Cell>
      <Cell align="end" mono width={104}>
        <Money value={stock.usd} />
      </Cell>
      <Cell width={110}>
        <Pill tone="muted">{stock.chain}</Pill>
      </Cell>
    </Row>
  )
})

const ChainGroup = memo(function ChainGroup({ compact, group }: { compact: boolean; group: WalletChainGroup }) {
  const count = group.tokens.length

  return (
    <section className="wallet-group">
      <SectionTitle end={<Money value={group.total.usd} />}>
        {group.total.label}
        <span className="wallet-group__meta">
          {count} asset{count === 1 ? '' : 's'}
        </span>
      </SectionTitle>
      <Rows>
        {group.tokens.map(token => (
          <AssetRow compact={compact} key={token.key} token={token} />
        ))}
      </Rows>
    </section>
  )
})

function AssetsHead({ compact }: { compact: boolean }) {
  return (
    <div className="e-row wallet-table__head">
      <Cell grow>Asset</Cell>
      <Cell width={104}>Chain</Cell>
      <Cell align="end" width={96}>
        Amount
      </Cell>
      {compact ? null : (
        <Cell align="end" width={84}>
          Price
        </Cell>
      )}
      <Cell align="end" width={104}>
        Value
      </Cell>
    </div>
  )
}

function StocksHead() {
  return (
    <div className="e-row wallet-table__head">
      <Cell grow>Stock</Cell>
      <Cell align="end" width={90}>
        Shares
      </Cell>
      <Cell align="end" width={104}>
        Value
      </Cell>
      <Cell width={110}>Protocol</Cell>
    </div>
  )
}

function FailureNote({ failure, onRetry, onSetup }: { failure: AcpFailure; onRetry: () => void; onSetup: () => void }) {
  const note = failureNote(failure)

  return (
    <Note kind="error">
      {note.message}{' '}
      <Action kind="quiet" onClick={note.setup ? onSetup : onRetry}>
        {note.action}
      </Action>
    </Note>
  )
}

// ── rail ────────────────────────────────────────────────────────────────────

const WalletRail = memo(function WalletRail({
  chainTotals,
  heldCount,
  mainView,
  onSelect,
  selectedChain,
  stocksCount
}: {
  chainTotals: readonly WalletChainTotal[]
  heldCount: number
  mainView: MainView
  onSelect: (view: MainView, chain: string | null) => void
  selectedChain: string | null
  stocksCount: number
}) {
  return (
    <>
      <RailSection>
        <RailItem
          active={mainView === 'assets' && !selectedChain}
          count={heldCount}
          icon={<WalletIcon size={14} strokeWidth={1.7} />}
          label="All assets"
          onClick={() => onSelect('assets', null)}
        />
      </RailSection>
      {chainTotals.length > 0 ? (
        <RailSection title="By chain">
          {chainTotals.map(chain => (
            <RailItem
              active={mainView === 'assets' && selectedChain === chain.network}
              count={compactUsd(chain.usd)}
              icon={<Layers size={14} strokeWidth={1.7} />}
              key={chain.network}
              label={chain.label}
              onClick={() => onSelect('assets', chain.network)}
            />
          ))}
        </RailSection>
      ) : null}
      <RailSection>
        <RailItem
          active={mainView === 'stocks'}
          count={stocksCount}
          icon={<TrendingUp size={14} strokeWidth={1.7} />}
          label="Stocks"
          onClick={() => onSelect('stocks', null)}
        />
        <RailItem
          active={mainView === 'compute'}
          icon={<Cpu size={14} strokeWidth={1.7} />}
          label="Compute"
          onClick={() => onSelect('compute', null)}
        />
      </RailSection>
      <p className="wallet-rail__foot">read-only · signer policy set in Setup</p>
    </>
  )
})

// ── the app ─────────────────────────────────────────────────────────────────

export default function WalletApp({ identity, inftId, refreshKey, slug }: EconAppProps) {
  const ask = useAskInft()
  const openSetup = useOpenSetup()
  const agentName = identity?.name || 'your agent'

  // The last snapshot is read in the first render, not in an effect: effects
  // run after paint, and a one-frame skeleton before the figures is a flash.
  const [initial] = useState(() => readWalletSnapshot(slug))
  const [balances, setBalances] = useState<WalletBalances | null>(initial?.data.balances ?? null)
  const [balancesError, setBalancesError] = useState<AcpFailure | null>(null)
  const [compute, setCompute] = useState<ComputeStatus | null>(initial?.data.compute ?? null)
  const [computeError, setComputeError] = useState<AcpFailure | null>(null)
  const [chains, setChains] = useState<ChainListResult | null>(initial?.data.chains ?? null)
  const [chainsError, setChainsError] = useState<AcpFailure | null>(null)
  const [chainsPending, setChainsPending] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(initial?.at ?? 0)

  const [mainView, setMainView] = useState<MainView>('assets')
  const [view, setView] = useState<WalletView>(() => readWalletView(slug))
  const [asideView, setAsideView] = useState<AsideView>('none')
  const closeAside = useCallback(() => setAsideView('none'), [])

  useEconPanelEscape(asideView !== 'none', closeAside)

  // What the snapshot is built from; written only where the reads land.
  const latest = useRef<Latest>({
    balances: initial?.data.balances ?? null,
    compute: initial?.data.compute ?? null,
    chains: initial?.data.chains ?? null,
    at: initial?.at ?? 0
  })

  const rootRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const root = rootRef.current

    if (!root) {
      return
    }

    const observer = new ResizeObserver(entries => {
      setNarrow((entries[0]?.contentRect.width ?? 0) < NARROW_BREAKPOINT)
    })

    observer.observe(root)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    writeWalletView(slug, view)
  }, [slug, view])

  const snap = useSnapshot<unknown>('wallet', slug, WALLET_SNAPSHOT_VERSION, snapshot => {
    if (!isWalletSnapshot(snapshot.data)) {
      return
    }

    // The first render already painted this snapshot; the header still needs
    // its age, and a snapshot from elsewhere (not the one read above) wins.
    if (snapshot.at !== initial?.at) {
      Object.assign(latest.current, { ...snapshot.data, at: snapshot.at })
      setBalances(snapshot.data.balances)
      setCompute(snapshot.data.compute)
      setChains(snapshot.data.chains)
      setUpdatedAt(snapshot.at)
    }

    reportEconStatus('wallet', slug, { updatedAt: snapshot.at })
  })

  const persist = useCallback(() => {
    const current = latest.current

    if (current.balances && current.at) {
      snap.persist(toWalletSnapshot(current.balances, current.compute, current.chains), current.at)
    }
  }, [snap])

  // A cache hit hands back the same object graph (cli.ts), so identity is the
  // honest "nothing new" — the snapshot is rewritten only on a change.
  const loadCompute = useCallback(
    async (force: boolean) => {
      const result = await readCompute(inftId, slug, { force })

      setComputeError(result.ok ? null : result)

      if (result.ok && latest.current.compute !== result.data) {
        setCompute(result.data)
        latest.current.compute = result.data
        persist()
      }
    },
    [inftId, persist, slug]
  )

  // Doc 07 #10: the window's first read for an iNFT starts at paint, not behind the warm-up queue.
  const paintedFor = useRef<null | string>(null)

  const load = useCallback(
    async ({ force }: { force: boolean }) => {
      const atPaint = paintedFor.current !== inftId

      paintedFor.current = inftId

      const balancesResult = await readBalances(inftId, slug, { force, atPaint })

      if (balancesResult.ok) {
        const changed = latest.current.balances !== balancesResult.data

        setBalances(balancesResult.data)
        setBalancesError(null)
        setUpdatedAt(balancesResult.at)
        Object.assign(latest.current, { balances: balancesResult.data, at: balancesResult.at })

        if (changed) {
          persist()
        }
      } else {
        setBalancesError(balancesResult)

        // A STATE (sign-in, setup) answers every command the same way — the
        // compute read would only spend a spawn to learn it again.
        if (needsSetup(balancesResult)) {
          throw new Error(failureLabel(balancesResult.kind))
        }
      }

      // Not awaited (U2-p1-01/02): the run — the header's one age and its "refreshing…" — ends
      // with the balances; Compute reads "loading…" until this lands (readCompute never rejects).
      void loadCompute(force)

      if (!balancesResult.ok) {
        throw new Error(failureLabel(balancesResult.kind))
      }
    },
    [inftId, loadCompute, persist, slug]
  )

  const { reload } = useAutoRefresh('wallet', slug, load, [inftId], refreshKey)

  const loadChains = useCallback(
    async (force = false) => {
      setChainsPending(latest.current.chains === null)

      const result = await readChains(inftId, slug, { force })

      setChainsPending(false)

      if (!result.ok) {
        setChainsError(result)

        return
      }

      setChainsError(null)

      if (latest.current.chains !== result.data) {
        setChains(result.data)
        latest.current.chains = result.data
        persist()
      }
    },
    [inftId, persist, slug]
  )

  // The chain list feeds the Receive and Top up asides only — read when one opens.
  const wantsChains = asideView === 'receive' || asideView === 'topup'

  useEffect(() => {
    if (wantsChains) {
      void loadChains()
    }
  }, [loadChains, wantsChains])

  const split = useMemo(() => (balances ? splitByBalance(balances.tokens) : EMPTY_SPLIT), [balances])
  const chainTotals = balances?.chainTotals ?? null

  // A remembered chain that no longer holds anything falls back to all assets.
  const selectedChain =
    view.selectedChain && chainTotals?.some(chain => chain.network === view.selectedChain) ? view.selectedChain : null

  const heldTokens = useMemo(
    () => (selectedChain ? split.held.filter(token => token.network === selectedChain) : split.held),
    [selectedChain, split]
  )

  const emptyTokens = useMemo(
    () => (selectedChain ? split.empty.filter(token => token.network === selectedChain) : split.empty),
    [selectedChain, split]
  )

  const groups = useMemo(
    () => (chainTotals && !selectedChain ? groupHeldByChain(split.held, chainTotals) : NO_GROUPS),
    [chainTotals, selectedChain, split]
  )

  const selectedChainTotal = chainTotals?.find(chain => chain.network === selectedChain) ?? null
  const firstLoad = balances === null && !balancesError

  // The identity carries the same addresses `wallet balance` does — paint the
  // chips from it while the balances are still on their way.
  const evmAddress = balances?.address || identity?.walletAddress || ''
  const solanaAddress = balances?.solanaAddress || identity?.solWalletAddress || ''

  // The figures the window opened with, so the live answer can say how far it moved.
  const baseline = initial ? { at: initial.at, totalUsd: initial.data.balances.totalUsd } : null
  const delta = baseline && balances && updatedAt !== baseline.at ? balances.totalUsd - baseline.totalUsd : 0

  // Empty balances on screen widen the count to every chain in the table.
  const chainCount = balances
    ? view.showEmpty
      ? countChains([...split.held, ...split.empty])
      : balances.chainTotals.length
    : 0

  // The PRICE column leaves while an aside shares the window with the table.
  const compact = !narrow && asideView !== 'none'

  const heroSub = balances ? (
    <>
      {`across ${chainCount} chain${chainCount === 1 ? '' : 's'}${view.showEmpty ? '' : ' with a balance'}`}
      {baseline && Math.abs(delta) >= 0.01 ? (
        <>
          {' · '}
          <Signed text={`${signedUsd(delta)} vs ${timeAgo(baseline.at)}`} value={delta} />
        </>
      ) : null}
    </>
  ) : undefined

  const openAside = useCallback((next: AsideView) => {
    setAsideView(current => (current === next ? 'none' : next))
  }, [])

  const openTopUp = useCallback(() => openAside('topup'), [openAside])
  const retry = useCallback(() => void reload(true), [reload])
  const retryChains = useCallback(() => void loadChains(true), [loadChains])

  const selectRail = useCallback((next: MainView, chain: string | null) => {
    setMainView(next)

    if (next === 'assets') {
      setView(current => (current.selectedChain === chain ? current : { ...current, selectedChain: chain }))
    }
  }, [])

  const toggleEmpty = useCallback(() => {
    setView(current => ({ ...current, showEmpty: !current.showEmpty }))
  }, [])

  const toolbarEnd = (
    <>
      <Action kind={asideView === 'receive' ? 'primary' : 'default'} onClick={() => openAside('receive')}>
        Receive
      </Action>
      <Action kind={asideView === 'topup' ? 'primary' : 'default'} onClick={openTopUp}>
        Top up
      </Action>
      <Action kind={asideView === 'send' ? 'primary' : 'default'} onClick={() => openAside('send')}>
        Send
      </Action>
    </>
  )

  function renderAssets(): ReactNode {
    const note = balancesError ? <FailureNote failure={balancesError} onRetry={retry} onSetup={openSetup} /> : null

    if (!balances) {
      return note
    }

    if (heldTokens.length === 0 && emptyTokens.length === 0) {
      return (
        <>
          {note}
          <Empty
            action={
              <Action kind="primary" onClick={openTopUp}>
                Top up
              </Action>
            }
            hint={`Fund this wallet, or ask ${agentName} to receive a top-up.`}
            title="No assets yet"
          />
        </>
      )
    }

    return (
      <>
        {note}
        <AssetsHead compact={compact} />
        {groups.length > 1 ? (
          groups.map(group => <ChainGroup compact={compact} group={group} key={group.total.network} />)
        ) : (
          <Rows>
            {heldTokens.map(token => (
              <AssetRow compact={compact} key={token.key} token={token} />
            ))}
          </Rows>
        )}
        {emptyTokens.length > 0 ? (
          <div className="wallet-toggle">
            <Action kind="quiet" onClick={toggleEmpty}>
              {view.showEmpty
                ? 'Hide empty balances'
                : `Show ${emptyTokens.length} empty balance${emptyTokens.length === 1 ? '' : 's'}`}
            </Action>
          </div>
        ) : null}
        {view.showEmpty ? (
          <Rows>
            {emptyTokens.map(token => (
              <AssetRow compact={compact} key={token.key} token={token} />
            ))}
          </Rows>
        ) : null}
      </>
    )
  }

  function renderStocks(): ReactNode {
    if (!balances) {
      return <SkeletonRows rows={5} />
    }

    if (balances.stocks.length === 0) {
      return (
        <Empty hint={`When ${agentName} holds tokenized shares, they show up here.`} title="No tokenized stocks yet" />
      )
    }

    return (
      <>
        <StocksHead />
        <Rows>
          {balances.stocks.map(stock => (
            <StockRow key={stock.key} stock={stock} />
          ))}
        </Rows>
      </>
    )
  }

  function renderCompute(): ReactNode {
    if (computeError && !compute) {
      return <FailureNote failure={computeError} onRetry={retry} onSetup={openSetup} />
    }

    if (!compute) {
      return <SkeletonRows rows={4} />
    }

    const used = compute.limit > 0 ? Math.min(100, Math.round((compute.usage / compute.limit) * 100)) : 0

    return (
      <div className="wallet-compute">
        {computeError ? <FailureNote failure={computeError} onRetry={retry} onSetup={openSetup} /> : null}
        <div>
          <SectionTitle>Inference credit</SectionTitle>
          <div className="wallet-gauge">
            <div className="wallet-gauge__fill" style={{ width: `${used}%` }} />
          </div>
          <dl className="e-kv wallet-compute__facts">
            <dt>Remaining</dt>
            <dd>
              <Money value={compute.limitRemaining} /> of <Money value={compute.limit} />
            </dd>
            <dt>Preferred model</dt>
            <dd>{computeModelLabel(compute.preferredModel) || '—'}</dd>
            <dt>Fallback model</dt>
            <dd>{computeModelLabel(compute.fallbackModel) || '—'}</dd>
            <dt>Auto top-up</dt>
            <dd>
              {compute.autoTopUpEnabled
                ? `on · tops up ${usd(compute.autoTopUpAmount)} below ${usd(compute.autoTopUpThreshold)}`
                : 'off'}
            </dd>
          </dl>
        </div>
        <ComputeTopUpForm onSubmit={ask} />
      </div>
    )
  }

  const asideContent =
    asideView === 'receive' ? (
      <ReceiveAside
        agentName={agentName}
        chains={chains}
        chainsError={chainsError}
        chainsPending={chainsPending}
        evmAddress={evmAddress}
        onRetryChains={retryChains}
        solanaAddress={solanaAddress}
      />
    ) : asideView === 'topup' ? (
      <TopUpForm
        agentName={agentName}
        chains={chains?.chains ?? NO_CHAINS}
        chainsError={chainsError}
        onRetryChains={retryChains}
        onSubmit={ask}
      />
    ) : asideView === 'send' ? (
      <SendForm agentName={agentName} onSubmit={ask} onTopUp={openTopUp} tokens={split.held} />
    ) : null

  const mainBody = firstLoad ? (
    <SkeletonRows rows={7} />
  ) : mainView === 'assets' ? (
    renderAssets()
  ) : mainView === 'stocks' ? (
    renderStocks()
  ) : (
    renderCompute()
  )

  return (
    <div className="wallet-app" ref={rootRef}>
      <AppFrame
        aside={narrow ? undefined : (asideContent ?? undefined)}
        rail={
          <WalletRail
            chainTotals={chainTotals ?? NO_CHAIN_TOTALS}
            heldCount={split.held.length}
            mainView={mainView}
            onSelect={selectRail}
            selectedChain={selectedChain}
            stocksCount={balances?.stocks.length ?? 0}
          />
        }
      >
        {firstLoad ? (
          <SkeletonStats count={4} />
        ) : (
          <StatRow>
            {/* Nothing known prints an em dash — a wallet that could not be read is not a wallet holding nothing. */}
            <Stat
              hero
              label="Portfolio value"
              sub={heroSub}
              value={<Money value={balances ? balances.totalUsd : null} />}
            />
            <Stat
              label="Compute credit"
              sub={
                compute
                  ? `of ${usd(compute.limit)} · ${computeModelLabel(compute.preferredModel) || 'model —'}`
                  : computeError
                    ? 'unavailable'
                    : 'loading…'
              }
              value={compute ? usd(compute.limitRemaining) : '—'}
            />
            <Stat
              label="Hyperliquid"
              sub="balance"
              value={<Money value={balances ? balances.hyperliquid.balanceUsd : null} />}
            />
            <Stat
              label="Stocks"
              sub={balances ? `${balances.stocks.length} position${balances.stocks.length === 1 ? '' : 's'}` : '—'}
              value={<Money value={balances ? balances.stocksUsd : null} />}
            />
          </StatRow>
        )}

        {evmAddress || solanaAddress ? (
          <div className="wallet-addrs">
            {evmAddress ? (
              <AddressChip
                address={evmAddress}
                href={hrefOrUndefined(explorerAddressUrl('base-mainnet', evmAddress))}
                label="EVM"
              />
            ) : null}
            {solanaAddress ? (
              <AddressChip
                address={solanaAddress}
                href={hrefOrUndefined(explorerAddressUrl('solana-mainnet', solanaAddress))}
                label="Solana"
              />
            ) : null}
          </div>
        ) : null}

        <Toolbar end={toolbarEnd}>
          <span className="e-field__label">
            {mainView === 'assets'
              ? selectedChainTotal
                ? selectedChainTotal.label
                : 'All assets'
              : mainView === 'stocks'
                ? 'Stocks'
                : 'Compute'}
          </span>
        </Toolbar>

        <div className="e-scroll">{mainBody}</div>

        {narrow && asideContent ? <div className="wallet-inline-aside">{asideContent}</div> : null}
      </AppFrame>
    </div>
  )
}
