import type { MandateTermsProblem, PaymentsNotReady, PaymentsRefusal } from '@/iclone-shared/payments'

/** V3-J — Settings › Economy › Payments: the per-user caps, the hard stop, who agents may pay, and the mandates. */
export type PaymentsTranslations = {
  navLabel: string
  keywords: string[]
  intro: string
  desktopOnly: string
  status: {
    title: string
    ready: string
    off: string
    readyHint: string
    pocket: string
    pocketHint: string
    noPocket: string
    today: string
    todayValue: (amount: string, cap: string) => string
    ledgerBroken: string
    /** Fix m-r2-2: profiles whose folder is outside the Hermes home (their spawns cannot pay). */
    unprotected: string
    unprotectedHint: string
    /** Why payments are not ready (J4-5): main sends a code, never its own words. */
    notReady: Record<PaymentsNotReady, string>
  }
  caps: {
    title: string
    perTx: string
    perTxHint: string
    perDay: string
    perDayHint: string
    perAgentDay: string
    perAgentDayHint: string
    save: string
    invalid: string
    note: string
  }
  stop: {
    title: string
    label: string
    hint: string
  }
  allowlist: {
    title: string
    payees: string
    payeesHint: string
    origins: string
    originsHint: string
    add: string
    remove: string
    invalidPayee: string
    invalidOrigin: string
    /** The list already holds ALLOWLIST_MAX entries (fix Jm1). */
    full: (max: number) => string
    /** The entry is already on the list. */
    listed: string
    empty: string
    /** An allowlist change main refused (J4-5): `list` is that list's name here; `entries` main's quoted entries. */
    problems: {
      notList: (list: string) => string
      tooMany: (list: string, count: number, max: number) => string
      entries: (list: string, entries: string, more: number) => string
    }
  }
  /** Signing a new open mandate: the terms, a review in plain words, then the permission sheet. */
  issue: {
    title: string
    intro: string
    agent: string
    agentHint: string
    budget: string
    budgetHint: string
    min: string
    max: string
    rangeHint: string
    payees: string
    payeesHint: string
    noPayees: string
    starts: string
    ends: string
    expires: string
    datesHint: string
    review: string
    payee: string
    summary: {
      agent: (agent: string) => string
      budget: (budget: string) => string
      range: (min: string, max: string) => string
      payees: (count: number) => string
      window: (from: string, to: string) => string
      expires: (at: string) => string
      caps: (perTx: string, perDay: string, perAgentDay: string) => string
    }
    problems: Record<MandateTermsProblem, string>
    sign: string
    signHint: string
    signed: string
  }
  mandates: {
    title: string
    empty: string
    forAgent: (agent: string) => string
    terms: (budget: string, expires: string) => string
    revoked: string
    revoke: string
  }
  saved: string
  refusals: Record<PaymentsRefusal, string>
}
