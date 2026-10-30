// iclone os — V3-J Settings › Economy › Payments (en). Main decides every payment; these words say what it allows.
import type { PaymentsTranslations } from '../types/payments'

export const payments: PaymentsTranslations = {
  navLabel: 'Payments',
  keywords: ['x402', 'USDC', 'spend', 'cap', 'stop', 'mandate'],
  intro:
    'What your agents may pay, to whom, and how much per day. Raising a cap or adding a payee asks you first; lowering applies at once.',
  desktopOnly: 'Payments run in the desktop app, which holds the keys on this Mac.',
  status: {
    title: 'Status',
    ready: 'Ready',
    off: 'Off',
    readyHint: 'Agents can pay under a mandate you signed, within the caps below.',
    pocket: 'Pocket address',
    pocketHint: 'The agents’ wallet on this Mac. Fund it with no more than your daily cap.',
    noPocket: 'No pocket yet',
    today: 'Signed today (UTC)',
    todayValue: (amount, cap) => `${amount} of ${cap} USDC`,
    ledgerBroken: 'The payments record does not verify: every payment is refused until it is repaired.',
    unprotected: 'Unprotected profiles',
    unprotectedHint:
      'The app could not make sure the payment skills are off in these profiles (a folder or config.yaml outside the Hermes home, or one it could not read or write): agents in them cannot pay.',
    notReady: {
      sealing_off:
        'Payments are off: the Keychain setting is off, so the payment keys cannot be sealed. Turn on Keychain in Settings › Machine › Gateways › “Keep saved passwords in the system keychain” to use payments.',
      keys_unavailable: 'A sealed payment key cannot be used, so payments are off.',
      disabled: 'Payments are off.',
      socket_down: 'The connection agents pay through is not running.'
    }
  },
  caps: {
    title: 'Spending caps',
    perTx: 'Per payment',
    perTxHint: 'A single payment above this is refused.',
    perDay: 'Per day',
    perDayHint: 'All agents together, per UTC day.',
    perAgentDay: 'Per agent, per day',
    perAgentDayHint: 'One agent’s own ceiling: the most a compromised agent can spend in a day.',
    save: 'Save caps',
    invalid: 'Enter an amount in USDC, with up to 6 decimals.',
    note: 'Raising a cap asks you on the permission sheet. Lowering applies at once.'
  },
  stop: {
    title: 'Hard stop',
    label: 'Stop all payments',
    hint: 'Refuses every payment, including those in flight. Turning it off asks you on the permission sheet.'
  },
  allowlist: {
    title: 'Who agents may pay',
    payees: 'Payees',
    payeesHint: 'Addresses agents may pay. With none listed, nobody can be paid.',
    origins: 'Sites',
    originsHint: 'Sites whose payment requests agents may answer. With none listed, none can be answered.',
    add: 'Add',
    remove: 'Remove',
    invalidPayee: 'Not an address: 0x followed by 40 hexadecimal characters.',
    invalidOrigin: 'Not a site address: start with https:// or http://.',
    full: max => `The list is full (${max} entries). Remove one first.`,
    listed: 'Already on the list.',
    empty: 'None yet',
    problems: {
      notList: list => `${list}: not a list.`,
      tooMany: (list, count, max) => `${list}: ${count} entries, at most ${max}.`,
      entries: (list, entries, more) => `${list}: ${entries}${more > 0 ? ` (+${more} more)` : ''}`
    }
  },
  issue: {
    title: 'New mandate',
    intro:
      'A mandate is your signed permission for one agent to pay: how much in total, how much each time, to whom and until when. Agents cannot pay without one.',
    agent: 'Agent',
    agentHint: 'The agent’s profile name, for example inft-alpha.',
    budget: 'Budget',
    budgetHint: 'The most all its payments under this mandate may add up to. It starts at your per-agent daily cap.',
    min: 'Smallest payment',
    max: 'Largest payment',
    rangeHint: 'Each payment must fall between these. The largest starts at your per-payment cap.',
    payees: 'May pay',
    payeesHint: 'Only payees on your list above can be chosen.',
    noPayees: 'Add a payee to the list above first.',
    starts: 'Payments from',
    ends: 'Payments until',
    expires: 'Mandate expires',
    datesHint: 'In your local time. A mandate lasts at most 90 days.',
    review: 'What you are about to sign',
    payee: 'Payee',
    summary: {
      agent: agent => `For ${agent}`,
      budget: budget => `Up to ${budget} USDC in total`,
      range: (min, max) => `Each payment between ${min} and ${max} USDC`,
      payees: count => (count === 1 ? 'To 1 payee:' : `To ${count} payees:`),
      window: (from, to) => `Payments allowed from ${from} to ${to}`,
      expires: at => `The mandate expires ${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `Your caps still apply: ${perTx} USDC per payment, ${perDay} USDC per day, ${perAgentDay} USDC per agent per day.`
    },
    problems: {
      agent: 'Enter the agent’s profile name: lowercase letters, digits, - and _.',
      amount: 'Check the amounts: above zero, at most 6 decimals, and smallest ≤ largest ≤ budget.',
      dates:
        'Check the dates: payments start before they end and end no later than the expiry, which is in the future and within 90 days.',
      payees: 'Choose at least one payee from your list.'
    },
    sign: 'Sign mandate…',
    signHint: 'You confirm once more on the permission sheet, which shows every term. Revoking later is immediate.',
    signed: 'Mandate signed.'
  },
  mandates: {
    title: 'Mandates',
    empty: 'No mandates. An agent can only pay under a mandate you signed.',
    forAgent: agent => `For ${agent}`,
    terms: (budget, expires) => `Budget ${budget} USDC · expires ${expires}`,
    revoked: 'Revoked',
    revoke: 'Revoke'
  },
  saved: 'Saved',
  refusals: {
    allowlist: 'Not changed: each list holds up to 50 valid entries, none twice.',
    door_denied: 'Not changed: the permission sheet was declined or timed out.',
    gesture: 'Not changed: the change needs your own click.',
    invalid: 'Not changed: the request was not valid.',
    ledger: 'Not changed: the payments record could not be written.',
    no_door: 'Not changed: the permission sheet is not available.',
    not_ready: 'Payments are not available.',
    settings_moved: 'The settings changed meanwhile. Review them and try again.',
    unavailable: 'Not available in this version.',
    unknown: 'Something went wrong. Nothing was changed.'
  }
}
