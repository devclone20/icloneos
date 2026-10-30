import { atom } from 'nanostores'

import { setupDecisions } from '@/iclone-shared/setup-decisions'
import { isMacPlatform } from '@/lib/platform'

import type { ConsentRecord } from '../consent/types'

import { packageRowsOf, setupAgentRuntime } from './agent-runtime'
import { type IcloneSetupBridge, SETUP_SECTIONS, type SetupDecisions, type SetupSection } from './types'

/**
 * V3-ON — "Set up again" from Settings › Machine › Set up: the first-launch sheet shows the Set up step once more
 * (every available section), and drops the flag when the user presses Done or Skip all.
 */
export const $setupReentry = atom(false)

export const openSetupAgain = () => $setupReentry.set(true)

export function setupBridge(): IcloneSetupBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneSetup
}

/** The stored decisions, well-formed entries only — the SAME validator main uses (r2 minor 4). */
export const setupDecisionsOf: (record: ConsentRecord | null | undefined) => SetupDecisions = setupDecisions

/** Pure: which sections a run of the step shows — the relevant ones the user never decided (all of them on re-entry). */
export function sectionsToShow(
  decisions: SetupDecisions,
  available: Readonly<Record<SetupSection, boolean>>,
  reentry: boolean
): SetupSection[] {
  return SETUP_SECTIONS.filter(section => available[section] && (reentry || !decisions[section]))
}

/**
 * r2 minor 2 — the sections that exist on this install, known without asking main: Packages only once V3-RT-B's API is
 * wired (`setupAgentRuntime()`), System permissions only on macOS with the Set up bridge, Agent permissions only with
 * the V3-F bridge. A section that does not exist is never undecided (no probe, no "Not set up" pill).
 */
export function relevantSetupSections(): Record<SetupSection, boolean> {
  const desktop = typeof window === 'undefined' ? undefined : window.hermesDesktop

  return {
    packages: setupAgentRuntime() !== null,
    system: Boolean(desktop?.icloneSetup) && isMacPlatform(),
    agent: Boolean(desktop?.icloneConsent?.permissions)
  }
}

/** Every relevant section decided: no probe at all (the common launch pays nothing). */
export const allDecided = (
  decisions: SetupDecisions,
  relevant: Readonly<Record<SetupSection, boolean>> = relevantSetupSections()
) => SETUP_SECTIONS.every(section => !relevant[section] || Boolean(decisions[section]))

/** r2 minor 2: the startup check's budget. On timeout or error the workspace opens (fail open, never an endless mask). */
export const SETUP_PROBE_BUDGET_MS = 2_000

/** Resolves `fallback` when `work` does not settle within `ms` (or rejects). */
export function withinBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms)

    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

const NOTHING: Record<SetupSection, boolean> = { packages: false, system: false, agent: false }

/**
 * Which relevant sections have something to show: packages when RT-B reports at least one line, system permissions
 * when main lists rows. Bounded by SETUP_PROBE_BUDGET_MS: a slow or failing check shows nothing (the app opens).
 */
export function probeSetupAvailability(
  relevant: Readonly<Record<SetupSection, boolean>> = relevantSetupSections(),
  budgetMs: number = SETUP_PROBE_BUDGET_MS
): Promise<Record<SetupSection, boolean>> {
  const probe = async (): Promise<Record<SetupSection, boolean>> => {
    const runtime = relevant.packages ? setupAgentRuntime() : null
    const bridge = relevant.system ? setupBridge() : undefined

    const [status, system] = await Promise.all([
      runtime ? runtime.status() : Promise.resolve(null),
      bridge ? bridge.system() : Promise.resolve(null)
    ])

    return {
      packages: packageRowsOf(status).length > 0,
      system: Array.isArray(system) && system.length > 0,
      agent: relevant.agent
    }
  }

  return withinBudget(probe(), budgetMs, NOTHING)
}
