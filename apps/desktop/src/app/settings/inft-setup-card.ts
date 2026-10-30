/**
 * iclone os — the wizard's virtual-card steps: signup with the agent email,
 * the cardholder profile, the payment method and the spend limit. `card
 * issue` is never here — live card numbers belong in the owner's terminal.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { slugForInft } from '@/iclone-shared/inft-slug'

import { type InftAcpStatus, inftKvDelete, inftKvGet, inftKvSet, refreshAcpStatus, runAcp } from '../home/acp-setup'
import { invalidateAcp } from '../home/econ/cli'
import { openExternal } from '../home/lib/external'

import {
  claimSignup,
  hasCardError,
  lateAnswersFor,
  lateHold,
  recordLateAnswer,
  releaseSignup,
  SIGNUP_IN_FLIGHT_GATE,
  signupAnswer,
  signupInFlight,
  subscribeCardFlight
} from './inft-setup-card-flight'
import { sendSignInLink, type SignInLinkSend } from './inft-setup-card-resend'
import {
  beforeMarker,
  type CardErrorInfo,
  cardErrorInfo,
  type CardSignupState,
  hydrateSignup,
  IDLE_SIGNUP,
  pickNewestMessageId,
  pickSigninLink,
  reduceSignup,
  RESEND_WAIT_MS,
  sendingMarker,
  serializeSignup,
  shouldFetchLink,
  type SignupEvent,
  type SignupGate,
  signupGate
} from './inft-setup-card-signup'
import { cliJson, pickString, type StepRunner } from './inft-setup-runner'
import { cardErrorSentence, cardRefusalSentence, useInftWizardCopy } from './inft-setup-wizard-copy'

interface CardStepsParams {
  runner: StepRunner
  status: InftAcpStatus | undefined
  inftId: string | null
}

interface CardSteps {
  cardFirst: string
  setCardFirst: (value: string) => void
  cardLast: string
  setCardLast: (value: string) => void
  cardPhone: string
  setCardPhone: (value: string) => void
  cardLimitUsd: string
  setCardLimitUsd: (value: string) => void
  signup: CardSignupState
  gate: SignupGate
  /** "send a new link" was pressed once; the next press sends. */
  confirmArmed: boolean
  /** Seconds to the next poll / the end of a cooldown (0 when none). */
  nextCheckSecs: number
  cooldownSecs: number
  /** The card service holds this account (cooldown or blocked): every card call waits. */
  cooldownHeld: boolean
  cardSignup: () => Promise<void>
  /** Re-reads `card whoami` (the way out of an unconfirmed signup). */
  rereadCard: () => void
  /** A card read (`card profile`, `card limit`) under the same hold. */
  cardRead: (argv: string[]) => Promise<void>
  resumeSignup: () => void
  openSigninLink: () => void
  cardProfile: () => Promise<void>
  cardPaymentMethod: () => Promise<void>
  cardLimit: () => Promise<void>
}

/** A call the runner could not make (no iNFT, a thrown bridge): it may still have left, so never "nothing sent". */
const NO_ANSWER: Awaited<ReturnType<typeof runAcp>> = {
  ok: false,
  code: null,
  stdout: '',
  stderr: '',
  error: 'no answer'
}

/** How long an armed "send a new link" waits for its second press. */
export const CONFIRM_WINDOW_MS = 60_000

export function useCardSteps({ runner, status, inftId }: CardStepsParams): CardSteps {
  const copy = useInftWizardCopy().card
  const { exec, refresh, setStep } = runner
  const [cardPhone, setCardPhone] = useState('')
  const [cardFirst, setCardFirst] = useState('')
  const [cardLast, setCardLast] = useState('')
  const [cardLimitUsd, setCardLimitUsd] = useState('100')
  const [signup, setSignup] = useState<CardSignupState>(IDLE_SIGNUP)
  const [confirmArmed, setConfirmArmed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const machine = useRef<CardSignupState>(IDLE_SIGNUP)
  const timer = useRef<number | null>(null)
  const forInft = useRef<string | null>(inftId)
  const hydratedFor = useRef<string | null>(null)
  // Bumped on every iNFT switch and on unmount: an await that resumes under an older epoch is dropped.
  const epoch = useRef(0)
  const rereadAfterHold = useRef(false)
  // The late-answer count this machine last hydrated from: a newer one means the kv changed behind it.
  const hydratedAt = useRef(-1)
  const flying = useSyncExternalStore(subscribeCardFlight, () => signupInFlight(inftId))
  const lateAnswers = useSyncExternalStore(subscribeCardFlight, () => lateAnswersFor(inftId))

  /** A liveness check for the iNFT shown now; false once the wizard unmounts or switches iNFT. */
  const liveToken = useCallback(() => {
    const at = epoch.current

    return () => epoch.current === at
  }, [])

  const apply = useCallback((event: SignupEvent): CardSignupState => {
    const next = reduceSignup(machine.current, event)

    machine.current = next
    setSignup(next)

    const id = forInft.current

    if (id) {
      void (next.phase === 'idle' || next.phase === 'done'
        ? inftKvDelete(id, 'card-signup')
        : inftKvSet(id, 'card-signup', serializeSignup(next)))
    }

    return next
  }, [])

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const fetchLink = useCallback(
    async (id: string, alive: () => boolean) => {
      const found = pickNewestMessageId(
        cliJson(await runAcp(id, ['email', 'search', '--query', 'agentcard', '--json']))
      )

      if (!alive()) {
        return
      }

      const url = found
        ? pickSigninLink(cliJson(await runAcp(id, ['email', 'extract-links', '--message-id', found, '--json'])))
        : undefined

      if (!alive() || forInft.current !== id) {
        return
      }

      const next = apply({ type: 'fetched', url })

      // Once per state token; the button re-opens it.
      if (next.linkUrl && !next.linkOpened) {
        openExternal(next.linkUrl)
        apply({ type: 'opened' })
      }
    },
    [apply]
  )

  const schedule = useCallback(() => {
    clearTimer()

    const s = machine.current
    const id = forInft.current

    if (s.phase !== 'polling' || !s.state || !id) {
      return
    }

    const alive = liveToken()

    timer.current = window.setTimeout(
      () => {
        timer.current = null

        void (async () => {
          const state = machine.current.state

          if (!alive() || !state || machine.current.phase !== 'polling' || forInft.current !== id) {
            return
          }

          const result = await runAcp(id, ['card', 'signup-poll', '--state', state, '--json']).catch(() => null)

          if (!alive() || forInft.current !== id) {
            return
          }

          const next = hasCardError(result)
            ? apply({ type: 'poll-error', info: cardErrorInfo(result), now: Date.now() })
            : apply({ type: 'poll', json: cliJson(result), now: Date.now() })

          if (next.phase === 'done') {
            setStep('card', { running: false, note: 'card signed in ✓', error: undefined })
            invalidateAcp(slugForInft(id), ['card'])
            void refreshAcpStatus(id, { card: true })

            return
          }

          if (next.phase === 'expired') {
            setStep('card', { running: false, note: copy.expired })
          }

          if (next.phase === 'cooldown' && next.lastError) {
            setStep('card', { running: false, error: cardErrorSentence(copy, next.lastError) })
          }

          if (shouldFetchLink(next)) {
            await fetchLink(id, alive)
          }

          if (alive()) {
            schedule()
          }
        })()
      },
      Math.max(0, (s.nextPollAt ?? Date.now()) - Date.now())
    )
  }, [copy, apply, clearTimer, fetchLink, liveToken, setStep])

  const resetMachine = useCallback((id: string | null) => {
    epoch.current += 1
    forInft.current = id
    hydratedFor.current = null
    machine.current = IDLE_SIGNUP
    rereadAfterHold.current = false
  }, [])

  const retire = useCallback(() => {
    epoch.current += 1
  }, [])

  /** True once per deferred re-read: the caller runs it. */
  const takeDeferredReread = useCallback((phase: CardSignupState['phase']) => {
    const due = rereadAfterHold.current || phase === 'unconfirmed'

    rereadAfterHold.current = false

    return due
  }, [])

  const install = useCallback((s: CardSignupState, hydrated?: string, lateSeen?: number) => {
    machine.current = s

    if (hydrated) {
      hydratedFor.current = hydrated
      hydratedAt.current = lateSeen ?? hydratedAt.current
    }
  }, [])

  // A new iNFT: drop the old machine, then hydrate from the service + the persisted copy.
  useEffect(() => {
    resetMachine(inftId)
    clearTimer()
    setSignup(IDLE_SIGNUP)
    setConfirmArmed(false)

    return () => {
      retire()
      clearTimer()
    }
  }, [clearTimer, inftId, resetMachine, retire])

  useEffect(() => {
    const id = inftId

    if (!id || !status || (hydratedFor.current === id && hydratedAt.current === lateAnswers)) {
      return
    }

    const alive = liveToken()

    install(machine.current, id, lateAnswers)
    void inftKvGet(id, 'card-signup').then(persisted => {
      if (!alive() || forInft.current !== id) {
        return
      }

      const s = hydrateSignup(persisted.ok ? persisted.value : null, status, Date.now())

      install(s)
      setSignup(s)

      if (s.phase === 'polling') {
        setStep('card', {
          running: false,
          note: `resuming the signup sent at ${new Date(s.sentAt ?? Date.now()).toTimeString().slice(0, 5)}…`
        })
        schedule()
      }
    })
  }, [inftId, install, lateAnswers, liveToken, schedule, setStep, status])

  // The service says ready (e.g. after a re-probe): the machine is finished.
  useEffect(() => {
    const m = machine.current

    if (
      status?.cardState === 'ready' &&
      m.phase !== 'idle' &&
      m.phase !== 'done' &&
      !((m.cooldownUntil ?? 0) > Date.now())
    ) {
      clearTimer()
      apply({ type: 'done' })
    }
  }, [apply, clearTimer, status?.cardState])

  const heldAt = useCallback(
    (t: number) => (machine.current.cooldownUntil ?? 0) > t || status?.cardState === 'blocked',
    [status?.cardState]
  )

  // The Resend button of a signed-up account counts its minute down too.
  const resendCounting =
    status?.cardState === 'signin-pending' &&
    signup.sentAt !== undefined &&
    signup.sentAt <= now &&
    signup.sentAt + RESEND_WAIT_MS > now

  // A visible countdown only while something is counting; a card re-read deferred by the hold runs when it ends.
  useEffect(() => {
    if (
      signup.phase !== 'polling' &&
      signup.phase !== 'cooldown' &&
      signup.cooldownUntil === undefined &&
      !resendCounting
    ) {
      return
    }

    const clockTimer = window.setInterval(() => {
      const t = Date.now()

      setNow(t)

      if (machine.current.cooldownUntil !== undefined && machine.current.cooldownUntil <= t) {
        const next = apply({ type: 'tick', now: t })

        if (!heldAt(t) && takeDeferredReread(next.phase)) {
          refresh({ card: true })
        }
      }
    }, 1_000)

    return () => window.clearInterval(clockTimer)
  }, [apply, heldAt, refresh, resendCounting, signup.cooldownUntil, signup.phase, takeDeferredReread])

  // An armed "send a new link" lasts one minute; a later click asks again.
  useEffect(() => {
    if (!confirmArmed) {
      return
    }

    const disarm = window.setTimeout(() => setConfirmArmed(false), CONFIRM_WINDOW_MS)

    return () => window.clearTimeout(disarm)
  }, [confirmArmed])

  // An unconfirmed signup waits for a card re-read newer than it; the service's answer decides.
  useEffect(() => {
    if (machine.current.phase === 'unconfirmed' && hydratedFor.current === inftId) {
      apply({ type: 'reread', status })
    }
  }, [apply, inftId, status])

  /** Every card CLI call goes through the one hold. */
  const cardExec = useCallback(
    async (argv: string[]) => {
      if (heldAt(Date.now())) {
        const info = machine.current.lastError

        setStep('card', {
          note: cardRefusalSentence(copy, { gate: 'refused', reason: 'cooling', error: info }),
          error: undefined
        })

        return null
      }

      return exec('card', argv, 90_000)
    },
    [copy, exec, heldAt, setStep]
  )

  /** A 403/429 from ANY card call starts or extends the one persisted cooldown. */
  const holdOn = useCallback(
    (info: CardErrorInfo) => {
      if (info.cooldownMs) {
        apply({ type: 'poll-error', info, now: Date.now() })
      }
    },
    [apply]
  )

  const gate = flying ? SIGNUP_IN_FLIGHT_GATE : signupGate(signup, status, now)

  /** A card answer for a wizard that closed or switched: a 403/429 still becomes that iNFT's persisted hold. */
  const keepLateHold = useCallback((id: string | null, result: Awaited<ReturnType<typeof runAcp>> | null) => {
    const event = lateHold(cardErrorInfo(result), Date.now())

    if (id && result && event) {
      void recordLateAnswer(id, event, IDLE_SIGNUP)
    }
  }, [])

  const cardSignup = useCallback(async () => {
    const email = status?.email
    const id = forInft.current

    if (!email || !id) {
      setStep('card', { error: 'provision the agent email first — the card signs up with it' })

      return
    }

    // One signup in flight per iNFT, whatever wizard (or remount of it) calls.
    if (signupInFlight(id)) {
      setStep('card', { note: cardRefusalSentence(copy, SIGNUP_IN_FLIGHT_GATE), error: undefined })

      return
    }

    const current = signupGate(machine.current, status, Date.now())

    // The account exists and its link is unopened: the Bank's own Resend, through the same send.
    if (current.gate === 'resend') {
      const alive = liveToken()

      const sent: SignInLinkSend = await sendSignInLink(id, email, {
        run: async (_inft, argv, timeoutMs) => (await exec('card', argv, timeoutMs)) ?? NO_ANSWER,
        now: () => Date.now()
      })

      if (!alive()) {
        return
      }

      if (sent.kind === 'sent') {
        setStep('card', { running: false, note: copy.resent, error: undefined })
        refresh({ card: true })
      } else if (sent.kind === 'wait') {
        setStep('card', { note: cardRefusalSentence(copy, { gate: 'refused', reason: 'resend-wait', at: sent.until }) })
      } else if (sent.kind === 'held') {
        setStep('card', { error: cardErrorSentence(copy, { code: 'held', heldUntil: sent.until }) })
      } else if (sent.kind === 'busy') {
        setStep('card', { note: cardRefusalSentence(copy, SIGNUP_IN_FLIGHT_GATE), error: undefined })
      } else if (sent.kind === 'not-recorded') {
        setStep('card', { error: 'could not record the signup on disk before sending it — nothing was sent' })
      } else {
        setStep('card', { error: cardErrorSentence(copy, sent.info) })
      }

      return
    }

    if (current.gate === 'refused') {
      setStep('card', { note: cardRefusalSentence(copy, current), error: undefined })

      return
    }

    if (current.gate === 'confirm' && !confirmArmed) {
      setConfirmArmed(true)
      setStep('card', { note: cardRefusalSentence(copy, current), error: undefined })

      return
    }

    setConfirmArmed(false)

    if (!claimSignup(id)) {
      return
    }

    const alive = liveToken()
    const sentFrom = machine.current
    const sentAt = Date.now()
    let event: SignupEvent

    try {
      // On disk before the call leaves: a reload or crash mid-flight hydrates "unconfirmed", never "nothing sent".
      const marked = await inftKvSet(id, 'card-signup', serializeSignup(sendingMarker(sentFrom, email, sentAt))).catch(
        () => null
      )

      if (!marked?.ok) {
        if (alive()) {
          setStep('card', { error: 'could not record the signup on disk before sending it — nothing was sent' })
        }

        return
      }

      const result = await exec('card', ['card', 'signup', '--email', email, '--json'], 90_000)

      event = signupAnswer(result, email, Date.now())

      // The service got the call: its answer is kept for the iNFT it was sent for, but drives nothing here.
      if (!alive()) {
        await recordLateAnswer(id, event, sentFrom, sentAt)

        return
      }
    } finally {
      releaseSignup(id)
    }

    machine.current = beforeMarker(machine.current, sentFrom, sentAt)

    if (event.type === 'sent') {
      apply(event)
      setStep('card', { running: false, note: 'sign-in link sent to the agent inbox — waiting for the click…' })
      schedule()

      return
    }

    // Not a clean answer: the machine takes the service's REAUTH token, or holds the gate as
    // "unconfirmed" until one forced card re-read says what really happened.
    const next = apply(event)

    setStep('card', { error: cardErrorSentence(copy, event.info) })

    // The forced re-read is a card call too: under a 403/429 hold it waits for the hold to end.
    if (heldAt(Date.now())) {
      rereadAfterHold.current = true
    } else {
      refresh({ card: true })
    }

    if (next.phase === 'polling') {
      setStep('card', { running: false, note: 'the service says a sign-in link is waiting — checking it…' })
      schedule()
    }
  }, [copy, apply, confirmArmed, exec, heldAt, liveToken, refresh, schedule, setStep, status])

  const rereadCard = useCallback(() => {
    if (!heldAt(Date.now())) {
      refresh({ card: true })
    }
  }, [heldAt, refresh])

  const cardRead = useCallback(
    async (argv: string[]) => {
      const alive = liveToken()
      const id = forInft.current
      const result = await cardExec(argv)

      if (alive()) {
        holdOn(cardErrorInfo(result))
      } else {
        keepLateHold(id, result)
      }
    },
    [cardExec, holdOn, keepLateHold, liveToken]
  )

  const resumeSignup = useCallback(() => {
    if (!machine.current.state || heldAt(Date.now())) {
      return
    }

    apply({ type: 'resume', now: Date.now() })
    setStep('card', { note: 'resuming — waiting for the sign-in click…', error: undefined })
    schedule()
  }, [apply, heldAt, schedule, setStep])

  const openSigninLink = useCallback(() => {
    const url = machine.current.linkUrl

    if (url) {
      openExternal(url)
      apply({ type: 'opened' })
    }
  }, [apply])

  const cardProfile = useCallback(async () => {
    if (!cardFirst.trim() || !cardLast.trim() || !cardPhone.trim()) {
      setStep('card', { error: 'fill first name, last name and phone (+countrycode…)' })

      return
    }

    const alive = liveToken()
    const id = forInft.current

    const result = await cardExec([
      'card',
      'profile',
      'set',
      '--first-name',
      cardFirst.trim(),
      '--last-name',
      cardLast.trim(),
      '--phone-number',
      cardPhone.trim(),
      '--json'
    ])

    if (alive()) {
      holdOn(cardErrorInfo(result))
    } else {
      keepLateHold(id, result)
    }
  }, [cardExec, cardFirst, cardLast, cardPhone, holdOn, keepLateHold, liveToken, setStep])

  const cardPaymentMethod = useCallback(async () => {
    const alive = liveToken()
    const id = forInft.current
    const result = await cardExec(['card', 'payment-method', '--json'])
    const url = pickString(cliJson(result), ['url', 'paymentUrl', 'checkoutUrl'])

    if (!alive()) {
      keepLateHold(id, result)

      return
    }

    holdOn(cardErrorInfo(result))

    if (url) {
      openExternal(url)
      setStep('card', { note: 'finish adding the payment method in your browser, then re-probe' })
    }
  }, [cardExec, holdOn, keepLateHold, liveToken, setStep])

  const cardLimit = useCallback(async () => {
    const usd = Number(cardLimitUsd.replace(',', '.'))

    if (!Number.isFinite(usd) || usd < 1 || usd > 10_000) {
      setStep('card', { error: 'spend limit: a whole amount between 1 and 10 000 USD' })

      return
    }

    const alive = liveToken()
    const id = forInft.current
    const result = await cardExec(['card', 'limit', 'set', '--amount', String(Math.round(usd * 100)), '--json'])

    if (!alive()) {
      keepLateHold(id, result)

      return
    }

    holdOn(cardErrorInfo(result))

    if (result && !heldAt(Date.now())) {
      refresh({ card: true })
    }
  }, [cardExec, cardLimitUsd, heldAt, holdOn, keepLateHold, liveToken, refresh, setStep])

  return {
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
    nextCheckSecs: signup.nextPollAt ? Math.max(0, Math.ceil((signup.nextPollAt - now) / 1_000)) : 0,
    cooldownSecs: signup.cooldownUntil ? Math.max(0, Math.ceil((signup.cooldownUntil - now) / 1_000)) : 0,
    cooldownHeld: (signup.cooldownUntil ?? 0) > now || status?.cardState === 'blocked',
    cardSignup,
    rereadCard,
    cardRead,
    resumeSignup,
    openSigninLink,
    cardProfile,
    cardPaymentMethod,
    cardLimit
  }
}
