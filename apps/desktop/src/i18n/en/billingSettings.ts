/** The words of the Billing Settings pane (front I-C, 2026-10-20). */
export const enBillingSettings = {
  sections: {
    plan: 'Your plan',
    payment: 'How you pay, and your credits',
    usage: 'What you have, and what you are spending',
    invoices: 'Invoices'
  },
  providerBilling: {
    title: 'Billing happens with the model provider you connected',
    hint: 'This app runs on the keys you added, so usage and costs stay with that provider. A Nous Portal subscription shows its plan and usage here once it is signed in.',
    openProviders: 'Open Providers'
  },
  empty: {
    title: 'This connection has nothing to bill',
    hint: 'Billing belongs to an account hosted by Nous Portal. This app runs on your own keys, so there is nothing to meter or charge here; usage and costs stay with your model provider.'
  },
  summary: {
    balance: 'Balance',
    plan: 'Plan',
    refill: 'Auto-refill',
    enabled: 'Enabled',
    off: 'Off'
  },
  notice: {
    openPortal: 'Open portal ↗',
    noCardTitle: 'No payment method on file',
    noCardMessage:
      'Buying top-up credits and auto-refill stay disabled until a card is on file. Add one on the portal.',
    addCard: 'Add card ↗'
  },
  payment: {
    title: 'The card you pay with',
    hint: 'Used for top-ups and subscription renewals.',
    noneHint: 'No card is on file yet.',
    add: 'Add payment method',
    update: 'Update'
  },
  buy: {
    title: 'Buy credits now',
    hint: 'A single charge on your card, added to your balance today.',
    action: 'Buy',
    customAmount: 'Custom credit amount'
  },
  refill: {
    title: 'Top up automatically when you run low',
    generic: 'Keep your balance topped up when it drops below your threshold.',
    manage: 'Manage',
    manageOnPortal: 'Manage auto-refill from the portal.',
    turnOnPortal: 'Turn on auto-refill from the portal',
    reconcile: 'Reconcile ↗',
    differentCard: 'a different card',
    threshold: 'Auto-refill threshold',
    reloadTo: 'Auto-refill reload-to amount',
    distinctCaption: (card: string) => `Auto-refill charges ${card} — reconcile on the portal`,
    charges: (reloadTo: string, threshold: string) =>
      `Charges ${reloadTo} automatically when your balance falls below ${threshold}.`
  },
  plan: {
    currentTitle: (tier: string) => `You are on the ${tier} plan`,
    free: 'Free',
    unavailable: 'Subscription details are unavailable; opening the portal is still available.',
    noSubscription: 'No active subscription — paid models draw down top-up credits.',
    change: 'Change plan',
    view: 'View plans',
    adjust: 'Adjust plan ↗',
    choose: 'Choose ↗',
    back: 'Back to billing',
    changesTo: (tier: string, when: string) => `Changes to ${tier} on ${when}.`,
    cancels: (when: string) => `Cancels on ${when}.`,
    renews: (date: string) => `Renews ${date}`
  },
  usage: {
    left: (left: string, total: string) => `${left} of ${total} left`,
    over: (amount: string) => `${amount} over`,
    used: (spent: string, limit: string) => `${spent} of ${limit} used`,
    subscriptionRemaining: 'Subscription credits remaining',
    subscription: 'Credits left from your subscription',
    noExpiry: 'They never expire.',
    topup: 'Credits you bought yourself',
    capUsed: 'Monthly spend cap used',
    defaultCeiling: 'This is the default limit for your account.',
    monthlyRemote: 'Counts what you spend from this app each month.',
    cap: 'How much of your monthly limit you have spent',
    resets: (date: string) => `Resets ${date}`
  },
  header: 'Billing',
  actions: {
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    undo: 'Undo',
    undoing: 'Undoing…',
    tryAgain: 'Try again',
    dismiss: 'Dismiss',
    openPortal: 'Open portal',
    verify: 'Verify to continue',
    openVerification: 'Open the verification page',
    turnOff: 'Turn off'
  },
  status: {
    processing: 'Processing your charge…',
    added: (amount: string) => `${amount} was added. Your balance is refreshing.`,
    waitingLink: 'Waiting for the verification link…'
  },
  autoRefill: {
    thresholdShort: 'Below',
    reloadToShort: 'Top up to',
    confirmOff: 'Turn off automatic top-ups?',
    updated: 'Automatic top-ups are updated.',
    turnedOff: 'Automatic top-ups are off.',
    thresholdName: 'The threshold',
    reloadToName: 'The top-up amount',
    badFormat: (name: string) => `${name} needs a dollar amount with up to two decimals.`,
    notPositive: (name: string) => `${name} must be more than $0.`,
    belowMin: (name: string, min: string) => `${name} must be at least ${min}.`,
    aboveMax: (name: string, max: string) => `${name} can be at most ${max}.`,
    order: 'The top-up amount must be higher than the threshold.'
  },
  provenance: {
    autoRefill: 'used for automatic top-ups',
    customerDefault: 'your default card',
    subPin: 'used for your subscription'
  },
  plans: {
    titleUpgrade: (tier: string) => `Move up to the ${tier} plan`,
    titleDowngrade: (tier: string) => `Move down to the ${tier} plan`,
    titleScheduled: (tier: string) => `You move to the ${tier} plan when this period ends`,
    title: 'Plans',
    empty: 'No other plan is available right now.',
    current: 'Current plan',
    scheduled: 'Scheduled',
    downgrade: 'Downgrade',
    checking: 'Checking this change…',
    blocked: 'This change cannot be made here.',
    noOp: (tier: string) => `You are already on ${tier}, so there is nothing to change.`,
    scheduledChange: (tier: string, when: string) =>
      `You move to ${tier} on ${when}. Nothing is charged now, and you keep your current plan until then.`,
    creditsChange: (delta: string) => `Your monthly credits change by ${delta}.`,
    cannotSchedule: 'This change cannot be scheduled here.',
    confirm: 'Confirm downgrade',
    scheduling: 'Scheduling…',
    perMonth: (amount: string) => `${amount}/mo`,
    creditsPerMonth: (amount: string) => `${amount} in credits each month`
  },
  refusal: {
    consentTitle: 'Confirm this card on the portal',
    consentMessage: 'The portal needs your approval before this app can charge the card.',
    scopeTitle: 'Allow this device to spend first',
    scopeMessage: 'Start a top-up to allow spending from this device, then try again.',
    stoppedTitle: 'Spending from this device was stopped',
    stoppedByAdmin: 'An admin stopped spending from this device. Sign in again to allow it.',
    stoppedByYou: 'You stopped spending from this device. Sign in again to allow it.',
    sessionTitle: 'You were signed out',
    sessionMessage: 'Sign in again to keep using billing.',
    disabledTitle: 'Spending from this app is turned off',
    disabledMessage: 'A billing admin can turn it on from the portal.',
    roleTitle: 'Only an admin can add funds',
    roleMessage: 'Ask an admin or owner of your organisation, or manage billing on the portal.',
    conflictTitle: 'Start a new top-up',
    conflictMessage: 'This top-up was already used for a different amount. Start a new one.',
    noCardTitle: 'Save a card on the portal first',
    noCardMessage: 'Buying credits once does not save a card you can reuse. Add one on the portal.',
    orgTitle: 'You cannot manage this organisation',
    orgMessage: 'This sign-in is not linked to an organisation you manage.',
    capTitle: 'You reached your monthly spending limit',
    capMessage: 'Raise the limit on the portal, or wait until it resets.',
    capRemaining: (amount: string) => `${amount} is left under your monthly limit.`,
    busyTitle: 'Too many charges at once',
    busyMessage: 'This is not a payment failure. Wait a moment and try again.',
    retryIn: (minutes: number) => `Try again in about ${minutes} min.`,
    paymentServiceTitle: 'The payment service is having trouble',
    paymentServiceMessage: 'Wait a moment and try again.',
    planLimitTitle: 'You changed plans too often today',
    planLimitMessage: 'Try again tomorrow.',
    unavailableTitle: 'Billing is not available here',
    unavailableMessage: 'This connection does not offer billing. Try again later.',
    timeoutTitle: 'Billing took too long to answer',
    timeoutMessage: 'Check your connection and try again.',
    offlineTitle: 'Billing could not be reached',
    offlineMessage: 'Check your connection and try again.',
    failedTitle: 'Billing could not finish this request',
    failedMessage: 'Try again in a moment.'
  },
  charge: {
    added: (amount: string) => `${amount} was added to your balance.`,
    addedGeneric: 'Credits were added to your balance.',
    failedTitle: 'The charge did not go through',
    bankCheck: 'Your bank needs to verify this payment. Finish it on the portal.',
    expired: 'Your card has expired. Update it on the portal.',
    declined: 'Your card was declined. Try another card on the portal.',
    failedGeneric: 'Try again, or use another card on the portal.',
    unconfirmedTitle: 'Your last charge is not confirmed yet',
    unconfirmed: 'Check your balance on the portal before you try again.',
    checkFailedTitle: 'The charge could not be checked',
    untrackedTitle: 'This charge cannot be followed',
    untrackedMessage: 'The charge was accepted but cannot be tracked. Check your balance on the portal.',
    slowTitle: 'The charge is still processing',
    slowMessage: 'It may still go through. Check the portal before you try again.'
  },
  stepUp: {
    deniedTitle: 'Verification was not approved',
    deniedMessage: 'Spending from this device is still not allowed.',
    doneTitle: 'Verification is complete',
    doneMessage: 'This device can now spend from your account.'
  },
  devFixture: 'Billing preview fixture (dev only)'
}

export type BillingSettingsCopy = typeof enBillingSettings
