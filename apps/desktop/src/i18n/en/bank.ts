import type { Translations } from '../types'

export const bank: Translations['bank'] = {
  card: {
    cardholder: 'Cardholder',
    tapToFlip: 'Tap to flip',
    spendLimit: 'Spend limit',
    lastSpendLimit: 'Last spend limit',
    spent: 'Spent',
    status: 'Status',
    funding: 'Funding',
    active: 'Active',
    locked: 'Locked',
    notSignedUp: 'Not signed up',
    signedOut: 'Signed out',
    showFront: 'Show card front',
    showBack: 'Show card back'
  },
  gate: {
    notSetUpLabel: 'AgentCard — not set up',
    signedOutLabel: 'AgentCard — signed out',
    signInRequiredLabel: 'AgentCard — sign-in required',
    noCardTitle: 'No card yet',
    noCardHint: agentName =>
      `Set up AgentCard once and ${agentName} can pay for its own purchases — you approve the limit, it handles the checkout.`,
    stepSignUp: 'Sign up',
    stepSignUpHint: 'creates the agent’s AgentCard account.',
    stepVerify: 'Verify',
    stepVerifyHint: 'a sign-in link lands in the agent’s own inbox.',
    stepPayment: 'Payment method',
    stepPaymentHint: 'link a card or wallet to fund it.',
    stepLimit: 'Limit',
    stepLimitHint: 'set how much it can spend without asking you.',
    openSetup: 'Open Setup',
    signInRequired: 'Sign-in required',
    useCardAgain: 'Sign in to Virtuals again to use the card',
    readCardAgain: 'Sign in to Virtuals again to read AgentCard',
    signInAgain: 'Sign in again',
    linkSentAgo: ago => `sent ${ago}`,
    resendLink: 'Resend link',
    resendIn: seconds => `Resend in ${seconds} s`,
    agentInbox: agentName => `${agentName}'s inbox`,
    linkSentCardKnown: 'Sign in to AgentCard again — a sign-in link was sent to {target}',
    linkSent: 'A sign-in link was sent to {target} — open the Email app, click the link, then continue setup.',
    askFetchLink: agentName => `Ask ${agentName} to fetch the link`,
    otherPath:
      'Two ways to set up AgentCard: Setup here, for this agent’s card through Virtuals (acp card); or your own AgentCard account in a terminal — agentcard signup, then agentcard setup and agentcard identity for KYC. They are separate accounts.',
    agentcardAccount: {
      signedOut: 'Your own AgentCard account is signed out.',
      kycRequired: 'Your own AgentCard account needs identity verification (KYC).',
      ready: 'Your own AgentCard account is ready.'
    },
    linkNotRecorded: 'nothing was sent — the send could not be recorded first'
  },
  notice: {
    tryAgain: 'Try again'
  },
  account: {
    label: 'Account',
    unavailable: reason => `Profile unavailable — ${reason}`,
    onFileHidden: 'Profile on file — details not shown.',
    noName: 'No name yet',
    noPhone: 'no phone yet',
    needsNamePhone: 'AgentCard needs a name and a phone before checkouts.',
    changeInSetup: 'Change in Setup'
  },
  stats: {
    reading: 'Reading…',
    notSet: 'Not set yet',
    limitLeft: (left, total) => `${left} of ${total} left`,
    openRequests: 'Open requests',
    reviewFirst: 'Review the first',
    nothingWaiting: 'Nothing waiting',
    codesWaiting: '3DS codes waiting',
    codesLive: 'Live — minutes left'
  },
  toolbar: {
    changeLimit: 'Change limit',
    issueCard: 'Issue a card for a purchase',
    readOnly: agentName => `AgentCard · read-only — issuing goes through ${agentName}`
  },
  requests: {
    title: 'Spend requests',
    tabOpen: 'Open',
    tabAll: 'All',
    showAll: 'Show all',
    nothingOpenTitle: 'Nothing open',
    nothingOpenHint: agentName => `Everything ${agentName} asked for has been settled — nothing waits on you.`,
    emptyTitle: 'No spend-requests yet',
    emptyHint: (agentName, action) =>
      `When ${agentName} pays for something, its request appears here. Start one with “${action}”.`,
    colRequest: 'Request',
    colCaptured: 'Captured',
    colStatus: 'Status',
    colIssued: 'Issued',
    colExpires: 'Expires',
    expires: ago => `exp ${ago}`,
    updated: ago => `Updated ${ago}`
  },
  detail: {
    title: 'Spend request',
    close: 'Close request',
    request: 'Request',
    amount: 'Amount',
    status: 'Status',
    created: 'Created',
    issued: 'Issued',
    captured: 'Captured',
    capturedAt: 'Captured at',
    expires: 'Expires',
    card: 'Card'
  },
  codes: {
    title: '3DS codes',
    active: count => `${count} active`,
    none: 'No 3DS codes right now — a code appears here for about five minutes after your agent triggers a checkout.',
    left: time => `${time} left`,
    expired: 'expired',
    amountNotGiven: 'Amount not given'
  },
  checking: 'Checking the card…',
  agentFallback: 'your agent'
}
