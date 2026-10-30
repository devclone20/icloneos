import './inft-setup.css'

/**
 * iclone os — the per-iNFT Virtuals CLI setup wizard (EconomyOS & iNFT).
 *
 * The complete flow the owner asked for: sign in to ACP, create THIS iNFT's
 * agent, arm its signer, read its wallet, provision its email, walk the
 * virtual-card state machine, check Hyperliquid — then summon the 3D iNFT
 * live on the home stage. Every step runs the real `acp` CLI through the
 * argv-allowlisted bridge (electron/iclone-acp.ts), inside the iNFT's OWN
 * ACP_CONFIG_DIR — one iNFT, one agent, one economy. Hermes helps at every
 * step: "ask hermes" drops a step-specific briefing into the Message
 * composer.
 *
 * What never happens here: reading secrets (auth lives in the CLI's keychain),
 * and `card issue` (live card numbers belong in the owner's own terminal —
 * the bridge refuses it by design).
 */
import { useStore } from '@nanostores/react'
import { ExternalLink, Play, RefreshCw } from 'lucide-react'
import { useCallback } from 'react'

import { HOME_ROUTE } from '@/app/routes'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { acpToolsReady } from '@/iclone-shared/acp-tools'
import { slugForInft } from '@/iclone-shared/inft-slug'
import { useAcpTools } from '@/store/acp-tools'
import { setSidebarOpen } from '@/store/layout'
import { $profiles } from '@/store/profile'

import { $acpConfigMap, type InftAcpStatus } from '../home/acp-setup'
import { AcpToolsControl, AcpToolsLicences, acpToolsLine } from '../home/econ/acp-tools-panel'
import { switchInft } from '../home/inft-switch'
import { $inftRoster, $inftRosterError, $inftRosterStatus, $privySession, openPrivyLogin } from '../home/privy-session'
import { $activeInft } from '../home/stage-store'

import { useAgentSteps } from './inft-setup-agent'
import { composeAskHermes, dropAskHermes } from './inft-setup-ask'
import { useCardSteps } from './inft-setup-card'
import { useAcpCliStep } from './inft-setup-cli'
import { useStepNotes } from './inft-setup-notes'
import { useProfileStep } from './inft-setup-profile'
import { useStepRunner } from './inft-setup-runner'
import { Step, type StepKit, stepRowId } from './inft-setup-step'
import { cardRefusalSentence, useInftWizardCopy } from './inft-setup-wizard-copy'
import { SettingRow } from './setting-row'
import { useDeepLinkHighlight } from './use-deep-link-highlight'
import { useLinkedSelection, useLinkedStep } from './use-linked-selection'

export function InftSetupPane({ navigate, onClose }: { navigate: (route: string) => void; onClose: () => void }) {
  const copy = useInftWizardCopy()
  const session = useStore($privySession)
  const roster = useStore($inftRoster)
  const rosterStatus = useStore($inftRosterStatus)
  const rosterError = useStore($inftRosterError)
  const configMap = useStore($acpConfigMap)
  const profiles = useStore($profiles)
  const activeInft = useStore($activeInft)

  // An econ app's "Open Setup" names its iNFT (?inft=), also while Settings is open; else the iNFT on
  // stage, whose head bands and iNFT pane already speak of it; else the roster's first card.
  const [selectedId, setSelectedId, linkedId] = useLinkedSelection({ param: 'inft' })

  const selected =
    roster.find(card => card.id === selectedId) ?? roster.find(card => card.id === activeInft?.id) ?? roster[0] ?? null

  const inftId = selected?.id ?? null
  const rosterIds = rosterStatus === 'ready' || rosterStatus === 'error' ? roster.map(card => card.id) : null
  // The Bank's "Open Setup" (?step=signin): the AgentCard sign-in link lives in the card row. Only
  // the linked iNFT's row lights up; a link to an iNFT the roster lacks falls back without it.
  const showLinkedStep = useLinkedStep({ linked: linkedId, options: rosterIds, param: 'step', selected: inftId })
  useDeepLinkHighlight({
    param: 'step',
    ready: step => step === 'signin' && showLinkedStep,
    elementId: () => stepRowId('card')
  })
  const status: InftAcpStatus | undefined = inftId ? configMap[slugForInft(inftId)] : undefined

  const { cli, cliInstall, cliUpdate, skills, skillsBusy, installCli, checkCliUpdate, teachAgent } = useAcpCliStep()
  // REL-6: the CLI installs from npm on the owner's click; the row shows the tools' own state while they are not ready.
  const tools = useAcpTools()
  const toolsCopy = useI18n().t.acpTools
  const toolsPending = tools !== null && !acpToolsReady(tools)
  const runner = useStepRunner(inftId)
  const { steps, exec, refresh } = runner
  const stepNotes = useStepNotes(inftId)
  const kit: StepKit = { notes: stepNotes, resume: runner.resumePoll }

  const { agentName, setAgentName, startSignIn, createAgent, armSigner, provisionEmail, registerErc8004 } =
    useAgentSteps({ runner, selected, status })

  const {
    cardFirst,
    setCardFirst,
    cardLast,
    setCardLast,
    cardPhone,
    setCardPhone,
    cardLimitUsd,
    setCardLimitUsd,
    signup,
    gate,
    confirmArmed,
    nextCheckSecs,
    cooldownSecs,
    cooldownHeld,
    cardSignup,
    rereadCard,
    cardRead,
    resumeSignup,
    openSigninLink,
    cardProfile,
    cardPaymentMethod,
    cardLimit
  } = useCardSteps({ runner, status, inftId })

  const gateReason = cardRefusalSentence(copy.card, gate)

  const { profileSlug, profileExists, buildProfileStep, activateProfileStep, deleteProfileStep } = useProfileStep({
    profiles,
    selected,
    setStep: runner.setStep
  })

  const askHermes = useCallback(
    (topic: string, key: string) => {
      setSidebarOpen(false)
      onClose()
      dropAskHermes(
        composeAskHermes({
          name: selected?.name ?? 'my agent',
          topic,
          notes: stepNotes.notes[key]?.text,
          step: steps[key]
        }),
        navigate
      )
    },
    [navigate, onClose, selected?.name, stepNotes.notes, steps]
  )

  const goLive = useCallback(() => {
    // Through the one door: the stage AND the persona, together.
    if (selected) {
      void switchInft(selected, { origin: 'go-live' })
    }

    onClose()
    navigate(HOME_ROUTE)
  }, [navigate, onClose, selected])

  // ── render ───────────────────────────────────────────────────────────────

  if (session.status !== 'in' || roster.length === 0) {
    // The gate must tell the truth about WHY it is closed. A signed-in user
    // whose scan was still running (or had failed) was told to "connect your
    // wallet first", with a button that reopened Privy OVER a live session.
    const signedIn = session.status === 'in'
    const gate = copy.gate

    return (
      <div className="iws">
        <SettingRow hint={gate.hint} title={gate.title} />
        {signedIn && rosterStatus === 'loading' ? (
          <SettingRow title={gate.scanning} />
        ) : signedIn && rosterStatus === 'error' ? (
          <SettingRow hint={gate.scanFailedHint(rosterError || gate.scanFailedReason)} title={gate.scanFailed} />
        ) : signedIn ? (
          <SettingRow hint={gate.noneHint} title={gate.none} />
        ) : (
          <SettingRow
            control={
              <button className="iws__btn iws__btn--primary" onClick={openPrivyLogin} type="button">
                {gate.connect}
              </button>
            }
            hint={gate.signedOutHint}
            title={gate.signedOut}
          />
        )}
      </div>
    )
  }

  const authenticated = Boolean(status?.authenticated)
  const hasAgent = Boolean(status?.agentId)
  const configured = Boolean(status?.configured)
  const cardOpen = status?.cardState !== 'ready'
  const cardBusy = Boolean(steps.card?.running) || cooldownHeld

  return (
    <div className="iws">
      <SettingRow
        below={
          <div className="iws__picker">
            {roster.map(card => (
              <button
                aria-pressed={card.id === selected?.id}
                className={card.id === selected?.id ? 'iws__pick iws__pick--on' : 'iws__pick'}
                key={card.id}
                onClick={() => setSelectedId(card.id)}
                type="button"
              >
                <b>{card.name.toLowerCase()}</b>
                <span>{card.chain}</span>
                <em
                  className={configMap[slugForInft(card.id)]?.configured ? 'iws__badge iws__badge--gold' : 'iws__badge'}
                >
                  {configMap[slugForInft(card.id)]?.configured ? copy.picker.ready : copy.picker.needed}
                </em>
              </button>
            ))}
          </div>
        }
        control={
          <Tip label={copy.picker.refresh}>
            <button
              aria-label={copy.picker.refresh}
              className="iws__refresh"
              onClick={() => refresh({ force: true })}
              type="button"
            >
              <RefreshCw size={13} strokeWidth={1.8} />
            </button>
          </Tip>
        }
        hint={copy.picker.hint}
        title={copy.picker.title}
      />

      <Step
        control={
          toolsPending ? (
            <AcpToolsControl cancelClassName="iws__btn" className="iws__btn iws__btn--primary" view={tools} />
          ) : cli?.ok ? (
            <button className="iws__btn" onClick={() => void checkCliUpdate()} type="button">
              {copy.cli.checkUpdate}
            </button>
          ) : (
            <button
              className="iws__btn iws__btn--primary"
              data-acp-tools-confirm=""
              disabled={cliInstall.running}
              onClick={() => void installCli()}
              type="button"
            >
              {copy.cli.install}
            </button>
          )
        }
        done={Boolean(cli?.ok) && !toolsPending}
        hint={
          toolsPending
            ? `${acpToolsLine(toolsCopy, tools)}. ${copy.cli.hint}`
            : tools?.state === 'installed'
              ? acpToolsLine(toolsCopy, tools)
              : cli?.ok
                ? copy.cli.ready(cli.version ?? '')
                : copy.cli.hint
        }
        index={1}
        kit={kit}
        notesKey="cli"
        onAskHermes={() => askHermes('installing the Virtuals ACP CLI', 'cli')}
        state={cliInstall}
        title={copy.cli.title}
      >
        {tools && tools.state !== 'checking' && tools.state !== 'unavailable' ? (
          <div className="iws__row">
            <AcpToolsLicences view={tools} />
          </div>
        ) : null}
        {cli?.ok && !toolsPending && (
          <>
            <p className="iws__note">
              {skills
                ? skills.ok
                  ? copy.cli.taught(skills.skills.length, skills.targets.length)
                  : copy.cli.notTaught(skills.errors[0] ?? copy.cli.unknownError)
                : copy.cli.checking}
            </p>
            <div className="iws__row">
              <button className="iws__btn" disabled={skillsBusy} onClick={() => void teachAgent()} type="button">
                {copy.cli.reteach}
              </button>
            </div>
            <p className="iws__note">{copy.cli.keychain}</p>
            {cliUpdate?.updateAvailable && (
              <div className="iws__row">
                <p className="iws__note">{copy.cli.updateAvailable(cliUpdate.latest ?? '')}</p>
                <button className="iws__btn iws__btn--primary" onClick={() => void installCli()} type="button">
                  {copy.cli.updateNow}
                </button>
              </div>
            )}
          </>
        )}
      </Step>

      <Step
        control={
          selected?.bootstrap ? (
            profileExists ? (
              <div className="iws__row">
                <button
                  className="iws__btn iws__btn--primary"
                  disabled={steps.profile?.running}
                  onClick={() => void activateProfileStep()}
                  type="button"
                >
                  {copy.profile.select}
                </button>
                <button
                  className="iws__btn"
                  disabled={steps.profile?.running}
                  onClick={() => void deleteProfileStep()}
                  type="button"
                >
                  {copy.profile.remove}
                </button>
              </div>
            ) : (
              <button
                className="iws__btn iws__btn--primary"
                disabled={steps.profile?.running}
                onClick={() => void buildProfileStep()}
                type="button"
              >
                {copy.profile.build}
              </button>
            )
          ) : undefined
        }
        done={profileExists}
        hint={selected?.bootstrap ? copy.profile.hint : copy.profile.noSoul}
        index={2}
        kit={kit}
        notesKey="profile"
        onAskHermes={() => askHermes('building this iNFT its own agent profile from the on-chain soul', 'profile')}
        state={steps.profile}
        title={copy.profile.title}
      >
        {selected?.bootstrap && <p className="iws__note iws__mono">{profileSlug}</p>}
      </Step>

      <Step
        control={
          // A session can expire while the cached status still says
          // "authenticated" — the owner must always be able to sign in again.
          <button
            className={authenticated ? 'iws__btn' : 'iws__btn iws__btn--primary'}
            disabled={steps.auth?.running}
            onClick={() => void startSignIn()}
            type="button"
          >
            <ExternalLink size={13} strokeWidth={1.8} /> {authenticated ? copy.auth.again : copy.auth.start}
          </button>
        }
        done={authenticated}
        hint={copy.auth.hint}
        index={3}
        kit={kit}
        notesKey="auth"
        onAskHermes={() => askHermes('signing in to the Virtuals ACP account (acp configure)', 'auth')}
        state={steps.auth}
        title={copy.auth.title}
      />

      <Step
        control={
          authenticated && !hasAgent ? (
            <button
              className="iws__btn iws__btn--primary"
              disabled={steps.agent?.running}
              onClick={() => void createAgent()}
              type="button"
            >
              <Play size={13} strokeWidth={1.8} /> {copy.agent.create}
            </button>
          ) : undefined
        }
        done={hasAgent}
        hint={hasAgent ? copy.agent.bound(status?.agentName ?? copy.agent.fallback) : copy.agent.hint}
        index={4}
        kit={kit}
        notesKey="agent"
        onAskHermes={() => askHermes('creating the ACP agent for this iNFT (acp agent create)', 'agent')}
        state={steps.agent}
        title={copy.agent.title}
      >
        {authenticated && !hasAgent && (
          <input
            aria-label={copy.agent.name}
            className="iws__input"
            onChange={e => setAgentName(e.target.value)}
            placeholder={copy.agent.name}
            value={agentName}
          />
        )}
      </Step>

      <Step
        control={
          hasAgent ? (
            <button
              className="iws__btn"
              disabled={steps.signer?.running}
              onClick={() => void armSigner()}
              type="button"
            >
              <ExternalLink size={13} strokeWidth={1.8} />{' '}
              {status?.signerReady ? copy.signer.addAnother : copy.signer.add}
            </button>
          ) : undefined
        }
        done={Boolean(status?.signerReady)}
        hint={status?.signerReady ? copy.signer.armed : copy.signer.hint}
        index={5}
        kit={kit}
        notesKey="signer"
        onAskHermes={() =>
          askHermes('arming the agent signer with a restricted policy (acp agent add-signer)', 'signer')
        }
        state={steps.signer ?? steps.erc8004}
        title={copy.signer.title}
      >
        {hasAgent && status?.signerReady && (
          <div className="iws__row">
            <Tip label={copy.signer.registerTip}>
              <button
                className="iws__btn"
                disabled={steps.erc8004?.running}
                onClick={() => void registerErc8004()}
                type="button"
              >
                {copy.signer.register}
              </button>
            </Tip>
          </div>
        )}
      </Step>

      <Step
        control={
          hasAgent ? (
            <button
              className="iws__btn"
              disabled={steps.wallet?.running}
              onClick={() => void exec('wallet', ['wallet', 'balance', '--json'])}
              type="button"
            >
              {copy.wallet.balance}
            </button>
          ) : undefined
        }
        done={Boolean(status?.walletAddress)}
        hint={copy.wallet.hint}
        index={6}
        kit={kit}
        notesKey="wallet"
        onAskHermes={() =>
          askHermes('the agent wallets (EVM + Solana), balances and topping them up (acp wallet)', 'wallet')
        }
        state={steps.wallet}
        title={copy.wallet.title}
      >
        {status?.walletAddress && <p className="iws__note iws__mono">{copy.wallet.evm(status.walletAddress)}</p>}
        {status?.solanaAddress && <p className="iws__note iws__mono">{copy.wallet.sol(status.solanaAddress)}</p>}
      </Step>

      <Step
        control={
          !status?.email && hasAgent ? (
            <button
              className="iws__btn iws__btn--primary"
              disabled={steps.email?.running}
              onClick={() => void provisionEmail()}
              type="button"
            >
              {copy.email.provision}
            </button>
          ) : undefined
        }
        done={Boolean(status?.email)}
        hint={copy.email.hint}
        index={7}
        kit={kit}
        notesKey="email"
        onAskHermes={() => askHermes('provisioning the agent email inbox (acp email provision)', 'email')}
        state={steps.email}
        title={copy.email.title}
      >
        {status?.email && <p className="iws__note iws__mono">{status.email}</p>}
      </Step>

      <Step
        control={
          hasAgent && cardOpen ? (
            // The tip is WHY the button is disabled (a refused gate, a held cooldown): a disabled button fires
            // no pointer events, so the span is the trigger and the button lets the pointer through to it.
            <Tip label={gateReason}>
              <span className="inline-flex">
                <button
                  className="iws__btn disabled:pointer-events-none"
                  disabled={cardBusy || gate.gate === 'refused'}
                  onClick={() => void cardSignup()}
                  type="button"
                >
                  {gate.gate === 'resend' || gate.reason === 'resend-wait'
                    ? copy.card.resend
                    : gate.gate === 'confirm'
                      ? confirmArmed
                        ? copy.card.confirmNew
                        : copy.card.sendNew
                      : copy.card.send}
                </button>
              </span>
            </Tip>
          ) : undefined
        }
        done={Boolean(status?.cardReady)}
        hint={copy.card.hint}
        index={8}
        kit={kit}
        notesKey="card"
        onAskHermes={() => askHermes('the virtual bank card signup, payment method and limits (acp card)', 'card')}
        state={steps.card}
        title={copy.card.title}
      >
        {hasAgent && (
          <>
            <div className="iws__row">
              {cardOpen && signup.phase === 'polling' && (
                <button className="iws__btn iws__btn--primary" disabled type="button">
                  {copy.card.waiting(String(nextCheckSecs))}
                </button>
              )}
              {cardOpen && signup.phase === 'cooldown' && (
                <button className="iws__btn" disabled type="button">
                  {copy.card.cooling(String(cooldownSecs))}
                </button>
              )}
              {cardOpen && signup.phase === 'unconfirmed' && (
                <button className="iws__btn iws__btn--primary" disabled={cardBusy} onClick={rereadCard} type="button">
                  {copy.card.unconfirmed}
                </button>
              )}
              {cardOpen && signup.phase === 'expired' && signup.state && (
                <button className="iws__btn iws__btn--primary" disabled={cardBusy} onClick={resumeSignup} type="button">
                  {copy.card.resume}
                </button>
              )}
              {signup.linkUrl && cardOpen && (
                <button className="iws__btn" onClick={openSigninLink} type="button">
                  <ExternalLink size={12} strokeWidth={1.8} /> {copy.card.openLink}
                </button>
              )}
              <button className="iws__btn" disabled={cardBusy} onClick={() => void cardPaymentMethod()} type="button">
                {copy.card.payment}
              </button>
              <button
                className="iws__btn"
                disabled={cardBusy}
                onClick={() => void cardRead(['card', 'profile', '--json'])}
                type="button"
              >
                {copy.card.probe}
              </button>
            </div>
            <div className="iws__row">
              <input
                aria-label={copy.card.first}
                className="iws__input"
                onChange={e => setCardFirst(e.target.value)}
                placeholder={copy.card.first}
                value={cardFirst}
              />
              <input
                aria-label={copy.card.last}
                className="iws__input"
                onChange={e => setCardLast(e.target.value)}
                placeholder={copy.card.last}
                value={cardLast}
              />
              <input
                aria-label={copy.card.phone}
                className="iws__input"
                onChange={e => setCardPhone(e.target.value)}
                placeholder="+351…"
                value={cardPhone}
              />
              <button className="iws__btn" disabled={cardBusy} onClick={() => void cardProfile()} type="button">
                {copy.card.profile}
              </button>
            </div>
            <div className="iws__row">
              <input
                aria-label={copy.card.limit}
                className="iws__input"
                inputMode="decimal"
                onChange={e => setCardLimitUsd(e.target.value)}
                placeholder={copy.card.limit}
                value={cardLimitUsd}
              />
              <button className="iws__btn" disabled={cardBusy} onClick={() => void cardLimit()} type="button">
                {copy.card.setLimit}
              </button>
              <button
                className="iws__btn"
                disabled={cardBusy}
                onClick={() => void cardRead(['card', 'limit', '--json'])}
                type="button"
              >
                {copy.card.readLimit}
              </button>
            </div>
            {cardOpen && gate.gate === 'refused' && gateReason && <p className="iws__note">{gateReason}</p>}
            {status?.cardHint && status.cardState === 'signin-pending' && (
              <p className="iws__note">{copy.card.service(status.cardHint)}</p>
            )}
            <p className="iws__note">{copy.card.issue}</p>
          </>
        )}
      </Step>

      <Step
        control={
          hasAgent ? (
            <button
              className="iws__btn"
              disabled={steps.hl?.running}
              onClick={() => void exec('hl', ['trade', 'hl-status', '--json'])}
              type="button"
            >
              {copy.hl.status}
            </button>
          ) : undefined
        }
        done={Boolean(steps.hl?.output) && !steps.hl?.error}
        hint={copy.hl.hint}
        index={9}
        kit={kit}
        notesKey="hl"
        onAskHermes={() => askHermes('funding the agent wallet on Hyperliquid and trading there', 'hl')}
        state={steps.hl}
        title={copy.hl.title}
      >
        <p className="iws__note">{copy.hl.deposit}</p>
      </Step>

      <Step
        control={
          hasAgent ? (
            <button
              className="iws__btn"
              disabled={steps.market?.running}
              onClick={() => void exec('market', ['browse', '--json'])}
              type="button"
            >
              {copy.market.browse}
            </button>
          ) : undefined
        }
        done={false}
        hint={copy.market.hint}
        index={10}
        kit={kit}
        notesKey="market"
        onAskHermes={() =>
          askHermes('the Virtuals ACP marketplace — browsing agents, offerings and jobs to trade with', 'market')
        }
        state={steps.market}
        title={copy.market.title}
      >
        {hasAgent && (
          <div className="iws__row">
            <button
              className="iws__btn"
              disabled={steps.market?.running}
              onClick={() => void exec('market', ['offering', 'list', '--json'])}
              type="button"
            >
              {copy.market.offerings}
            </button>
            <button
              className="iws__btn"
              disabled={steps.market?.running}
              onClick={() => void exec('market', ['job', 'list', '--json'])}
              type="button"
            >
              {copy.market.jobs}
            </button>
          </div>
        )}
      </Step>

      <Step
        control={
          <button className="iws__btn iws__btn--gold" disabled={!selected?.modelUrl} onClick={goLive} type="button">
            {copy.live.summon}
          </button>
        }
        done={configured}
        hint={selected?.modelUrl ? copy.live.hint : copy.live.noModel}
        index={11}
        kit={kit}
        notesKey="live"
        onAskHermes={() => askHermes('what a fully configured iNFT can do in iclone os', 'live')}
        title={copy.live.title}
      >
        {configured && (
          <p className="iws__note">{copy.live.configured(selected?.name.toLowerCase() ?? copy.live.yourInft)}</p>
        )}
      </Step>
    </div>
  )
}
