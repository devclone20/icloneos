import type {
  AutonomyLevel,
  OfferStanding,
  PolicyRule,
  SupervisorState,
  WorkActionError,
  WorkFixAction,
  WorkFixCause,
  WorkHold,
  WorkRowGroup
} from '@/iclone-shared/acp-work'

/** V3-I — ACP Market › Work: lifecycle, autonomy, the offer inbox, the traced rows and the fixes. */
export type AcpWorkTranslations = {
  tab: string
  states: Record<SupervisorState, string>
  /** What "online" means on this build: the listener, not yet the marketplace's own presence. */
  onlineMeaning: string
  /** The web build has no main process to hold the listener. */
  desktopOnly: string
  awakeOnly: string
  actions: { online: string; offline: string; reboot: string; refresh: string }
  autonomy: {
    title: string
    levels: Record<AutonomyLevel, { name: string; summary: string }>
    /** Under the level picker when the effective level is lower than the owner's. */
    downgrade: Record<'chain-broken' | 'spend-trade-off', string>
    earnOnly: string
  }
  writesOff: string
  offers: {
    title: string
    empty: string
    emptyHint: string
    approve: string
    decline: string
    standing: Record<OfferStanding, string>
    rules: Record<PolicyRule, string>
    price: (amount: string) => string
    requester: (address: string) => string
  }
  groups: Record<WorkRowGroup, string>
  groupsEmpty: string
  trace: { offer: string; job: string; budget: string; deliverable: string; payment: string; gap: string }
  totals: { earned: string; spent: string; escrow: string }
  fixes: {
    title: string
    empty: string
    causes: Record<WorkFixCause, string>
    actions: Record<WorkFixAction, string>
    now: (state: string) => string
  }
  draining: (jobs: string) => string
  drainUnknown: string
  stopReport: (open: number, escrow: string) => string
  readError: (detail: string) => string
  /** Why WORK holds the iNFT offline (sign-out, wallet switch, a sale, a resume waiting on its proof). */
  holds: Record<WorkHold, string>
  /** The owner's way out of a broken ledger: it never stays blocked. */
  repair: { action: string; hint: string }
  chainGaps: (count: number) => string
  chainBroken: string
  errors: Record<WorkActionError, string>
  refusedBy: (rule: string) => string
}
