export type BankTranslations = {
  card: {
    cardholder: string
    tapToFlip: string
    spendLimit: string
    lastSpendLimit: string
    spent: string
    status: string
    funding: string
    active: string
    locked: string
    notSignedUp: string
    signedOut: string
    showFront: string
    showBack: string
  }
  gate: {
    notSetUpLabel: string
    signedOutLabel: string
    signInRequiredLabel: string
    noCardTitle: string
    noCardHint: (agentName: string) => string
    stepSignUp: string
    stepSignUpHint: string
    stepVerify: string
    stepVerifyHint: string
    stepPayment: string
    stepPaymentHint: string
    stepLimit: string
    stepLimitHint: string
    openSetup: string
    signInRequired: string
    useCardAgain: string
    readCardAgain: string
    signInAgain: string
    /** `linkSentAgo('12 min ago')` — when the link waiting in the inbox was sent. */
    linkSentAgo: (ago: string) => string
    resendLink: string
    /** Resend is held for a minute after a send; `resendIn(42)`. */
    resendIn: (seconds: number) => string
    agentInbox: (agentName: string) => string
    linkSentCardKnown: string
    linkSent: string
    askFetchLink: (agentName: string) => string
    /** The second path: the owner's own agentcard.ai account on the `agentcard` CLI (a separate account). */
    otherPath: string
    /** The owner's own AgentCard account (the `agentcard` CLI), read-only: one sentence per state. */
    agentcardAccount: { signedOut: string; kycRequired: string; ready: string }
    /** The send was refused before it left: the pre-send record could not be written. */
    linkNotRecorded: string
  }
  notice: {
    tryAgain: string
  }
  account: {
    label: string
    unavailable: (reason: string) => string
    onFileHidden: string
    noName: string
    noPhone: string
    needsNamePhone: string
    changeInSetup: string
  }
  stats: {
    reading: string
    notSet: string
    limitLeft: (left: string, total: string) => string
    openRequests: string
    reviewFirst: string
    nothingWaiting: string
    codesWaiting: string
    codesLive: string
  }
  toolbar: {
    changeLimit: string
    issueCard: string
    readOnly: (agentName: string) => string
  }
  requests: {
    title: string
    tabOpen: string
    tabAll: string
    showAll: string
    nothingOpenTitle: string
    nothingOpenHint: (agentName: string) => string
    emptyTitle: string
    emptyHint: (agentName: string, action: string) => string
    colRequest: string
    colCaptured: string
    colStatus: string
    colIssued: string
    colExpires: string
    expires: (ago: string) => string
    updated: (ago: string) => string
  }
  detail: {
    title: string
    close: string
    request: string
    amount: string
    status: string
    created: string
    issued: string
    captured: string
    capturedAt: string
    expires: string
    card: string
  }
  codes: {
    title: string
    active: (count: number) => string
    none: string
    left: (time: string) => string
    expired: string
    amountNotGiven: string
  }
  checking: string
  agentFallback: string
}
