/**
 * iclone os — the wizard's step runner: one state row per step key, CLI
 * calls reflected into those rows, and the single poll loop the browser-side
 * steps (split login, signer approval, card signup) wait on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { parseCliJson } from '@/iclone-shared/cli-json'
import { errorMessage } from '@/iclone-shared/errors'
import { asRecord } from '@/iclone-shared/guards'
import { redactSecrets } from '@/iclone-shared/redact'

import { type AcpRunResult, type AcpStatusOptions, refreshAcpStatus, runAcp } from '../home/acp-setup'

export interface StepState {
  running: boolean
  note?: string
  output?: string
  error?: string
  /** The step's last CLI answer, redacted — "ask Hermes" carries it. */
  last?: { stdout: string; stderr: string; error?: string; at: number }
  /** A browser-side poll ran out of time: the step offers "resume", never a new start. */
  stalled?: boolean
}

export type SetStep = (key: string, patch: Partial<StepState>) => void

/** Run one CLI call for the selected iNFT and reflect it in a step row. */
type ExecStep = (key: string, argv: string[], timeoutMs?: number) => Promise<AcpRunResult | null>

interface PollOptions {
  /** Delay before poll `tick` (1-based); default a flat POLL_MS. */
  delayMs?: (tick: number) => number
  /** Polls before the step stalls; default POLL_MAX. */
  maxTicks?: number
}

/** Poll one CLI call until `isDone(output)`, then run `onDone`. */
type PollUntil = (
  key: string,
  argv: string[],
  isDone: (json: Record<string, unknown> | null, raw: string) => boolean,
  onDone: () => void,
  options?: PollOptions
) => void

export interface StepRunner {
  steps: Record<string, StepState>
  setStep: SetStep
  exec: ExecStep
  pollUntil: PollUntil
  /** Continue a stalled poll with a fresh budget (same command, same state). */
  resumePoll: (key: string) => void
  /** Re-read the selected iNFT's ACP status. */
  refresh: (opts?: AcpStatusOptions) => void
}

const POLL_MS = 3_500
const POLL_MAX = 90
const OUTPUT_SHOWN = 4_000
const STALLED_NOTE = 'still waiting — finish in your browser, then press resume'

/** The first key holding a non-empty string (or a finite number, as text). */
export function pickString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj?.[key]

    if (typeof value === 'string' && value) {
      return value
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }

  return undefined
}

/** CLI JSON output as a record, or null. */
export function cliJson(result: AcpRunResult | null): Record<string, unknown> | null {
  return result ? asRecord(parseCliJson(result.stdout)) : null
}

export function useStepRunner(inftId: string | null): StepRunner {
  const [steps, setSteps] = useState<Record<string, StepState>>({})
  const pollTimer = useRef<number | null>(null)
  const pollGen = useRef(0)
  const lastPoll = useRef<Record<string, Parameters<PollUntil>>>({})

  const setStep = useCallback<SetStep>((key, patch) => {
    setSteps(current => {
      const existing: StepState = current[key] ?? { running: false }

      return { ...current, [key]: { ...existing, ...patch } }
    })
  }, [])

  const stopPolling = useCallback(() => {
    pollGen.current += 1

    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const forgetPolls = useCallback(() => {
    lastPoll.current = {}
  }, [])

  // Every iNFT starts the wizard clean: another token's step results (and a
  // poll still running for it) must not appear under this one's rows.
  useEffect(() => {
    stopPolling()
    setSteps({})
    forgetPolls()

    if (inftId) {
      void refreshAcpStatus(inftId)
    }
  }, [forgetPolls, inftId, stopPolling])

  const exec = useCallback<ExecStep>(
    async (key, argv, timeoutMs) => {
      if (!inftId) {
        return null
      }

      setStep(key, { running: true, error: undefined })

      let result: AcpRunResult

      try {
        result = await runAcp(inftId, argv, timeoutMs)
      } catch (error) {
        setStep(key, { running: false, error: errorMessage(error) })

        return null
      }

      const shown = (result.stdout || result.stderr || result.error || '').trim().slice(0, OUTPUT_SHOWN)

      setStep(key, {
        running: false,
        output: shown || undefined,
        error: result.ok ? undefined : (result.error ?? `exit ${result.code}`),
        last: {
          stdout: redactSecrets(result.stdout.slice(0, OUTPUT_SHOWN)),
          stderr: redactSecrets(result.stderr.slice(0, OUTPUT_SHOWN)),
          error: result.error ? redactSecrets(result.error) : undefined,
          at: Date.now()
        }
      })

      return result
    },
    [inftId, setStep]
  )

  // The split login and signer approval both finish in the owner's browser,
  // not here.
  // One call in flight; the next delay starts after the answer (a cold CLI
  // takes longer than a poll period).
  const pollUntil = useCallback<PollUntil>(
    (key, argv, isDone, onDone, options) => {
      stopPolling()
      lastPoll.current[key] = [key, argv, isDone, onDone, options]

      const gen = pollGen.current
      const pollFor = inftId
      const delayMs = options?.delayMs ?? (() => POLL_MS)
      const maxTicks = options?.maxTicks ?? POLL_MAX
      let ticks = 0

      const next = () => {
        pollTimer.current = window.setTimeout(() => void tick(), delayMs(ticks + 1))
      }

      const tick = async () => {
        if (gen !== pollGen.current) {
          return
        }

        ticks += 1

        const result = pollFor ? await runAcp(pollFor, argv).catch(() => null) : null

        if (gen !== pollGen.current) {
          return
        }

        if (result && isDone(asRecord(parseCliJson(result.stdout)), result.stdout)) {
          pollTimer.current = null
          setStep(key, { running: false, stalled: false, note: 'done ✓', output: undefined })
          onDone()

          return
        }

        if (ticks >= maxTicks) {
          pollTimer.current = null
          setStep(key, { running: false, stalled: true, note: STALLED_NOTE, error: undefined })

          return
        }

        next()
      }

      next()
    },
    [inftId, setStep, stopPolling]
  )

  const resumePoll = useCallback(
    (key: string) => {
      const spec = lastPoll.current[key]

      if (spec) {
        setStep(key, { running: true, stalled: false, note: 'resuming…', error: undefined })
        pollUntil(...spec)
      }
    },
    [pollUntil, setStep]
  )

  const refresh = useCallback(
    (opts?: AcpStatusOptions) => {
      if (inftId) {
        void (opts ? refreshAcpStatus(inftId, opts) : refreshAcpStatus(inftId))
      }
    },
    [inftId]
  )

  return { steps, setStep, exec, pollUntil, resumePoll, refresh }
}
