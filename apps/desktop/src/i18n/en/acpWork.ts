// iclone os — V3-I ACP Market › Work. Main decides every step; these words only say what it did and why.
import type { AcpWorkTranslations } from '../types/acpWork'

export const acpWork: AcpWorkTranslations = {
  tab: 'Work',
  states: {
    offline: 'Offline',
    starting: 'Starting',
    online: 'Online',
    draining: 'Going offline safely',
    'offline-safe': 'Offline, every job settled',
    failed: 'Needs you'
  },
  onlineMeaning:
    'Online means its job listener is connected from this Mac. Whether the marketplace shows it online is not verified yet.',
  desktopOnly: 'Work runs in the desktop app, which keeps the agent online from your Mac.',
  awakeOnly: 'It stays online with this window closed, while this Mac is awake.',
  actions: { online: 'Put online', offline: 'Take offline', reboot: 'Reboot listener', refresh: 'Read jobs now' },
  autonomy: {
    title: 'Autonomy',
    levels: {
      L0: { name: 'Observe', summary: 'Finds and ranks work. You do everything.' },
      L1: { name: 'Approve each job', summary: 'Offers inside your policy wait here for your Approve.' },
      L2: {
        name: 'Act within policy',
        summary: 'Quotes offers inside your policy by itself. Only your own click turns it on.'
      }
    },
    downgrade: {
      'chain-broken': 'The work ledger does not verify, so it only observes until that is looked at.',
      'spend-trade-off': 'Spend and trade is off in Settings › Privacy, so it only observes.'
    },
    earnOnly: 'Earn-only: it never spends, hires or tops up.'
  },
  writesOff: 'In this build an approval is recorded and the quote is held, never sent.',
  offers: {
    title: 'Offers',
    empty: 'No offers yet',
    emptyHint: 'Jobs requested from this iNFT appear here with the policy’s verdict.',
    approve: 'Approve',
    decline: 'Decline',
    standing: {
      pending: 'Waiting for you',
      approved: 'Approved',
      declined: 'Declined',
      refused: 'Refused by policy',
      seen: 'Seen'
    },
    rules: {
      spend: 'it asks this iNFT to put up money',
      token: 'paid in a token the policy does not take',
      chain: 'on a chain the policy does not take',
      'requester-denied': 'the requester is on the deny list',
      'requester-unknown': 'the requester is not on the allow list',
      class: 'a kind of work the policy does not take',
      'price-floor': 'the fee is below the floor, or not stated',
      'open-cap': 'too many jobs already open',
      oversize: 'the request is larger than the limit'
    },
    price: amount => `Fee ${amount}`,
    requester: address => `From ${address}`
  },
  groups: { 'in-flight': 'In flight', completed: 'Completed', payments: 'Payments', history: 'History' },
  groupsEmpty: 'Nothing here yet.',
  trace: { offer: 'Offer', job: 'Job', budget: 'Budget', deliverable: 'Delivered', payment: 'Paid', gap: 'missing' },
  totals: { earned: 'Earned', spent: 'Spent', escrow: 'In escrow' },
  fixes: {
    title: 'Fixes',
    empty: 'Nothing has failed.',
    causes: {
      'listener-exited': 'The listener exited',
      'needs-sign-in': 'The agent needs to sign in again',
      'owner-reboot': 'You asked for a reboot',
      'read-failed': 'The job list could not be read',
      'tools-missing': 'The ACP tools are not installed or do not verify'
    },
    actions: {
      'restart-backoff': 'Restarting it, waiting longer each time (up to a minute)',
      restarted: 'Restarted the listener',
      'stopped-for-sign-in': 'Stopped retrying — sign in from Setup, then put it online',
      'retry-next-poll': 'Reading again on the next check',
      'stopped-for-tools': 'Stopped — install the ACP tools in ACP Market, then put it online'
    },
    now: state => `Now: ${state}`
  },
  draining: jobs => `Waiting on job ${jobs} before the listener stops.`,
  drainUnknown: 'Waiting for a job list it can trust before the listener stops.',
  stopReport: (open, escrow) =>
    open === 0 ? 'No job is open.' : `${open} ${open === 1 ? 'job is' : 'jobs are'} still open, ${escrow} in escrow.`,
  readError: detail => `The last read failed: ${detail}`,
  holds: {
    'signed-out': 'Offline: you signed out, so every listener stopped. Sign in, then put it online.',
    'wallet-switch':
      'Offline: the wallet changed, so every listener stopped. Only the wallet that holds this iNFT can put it online.',
    'ownership-lost': 'Offline: this iNFT is no longer in your wallet, so its listener stopped.',
    'ownership-unverified': 'Checking that this iNFT is still in your wallet before it comes back online.'
  },
  repair: {
    action: 'Repair ledger',
    hint: 'Repair keeps every record that verifies, sets the damaged file aside and records the gap. Act within policy has to be chosen again.'
  },
  chainGaps: count =>
    count === 1
      ? 'One write was interrupted or repaired. The ledger records the gap.'
      : `${count} writes were interrupted or repaired. The ledger records each gap.`,
  chainBroken: 'The work ledger does not verify.',
  errors: {
    gesture: 'This needs your own click.',
    invalid: 'That job is no longer an open offer.',
    policy: 'The policy refuses this offer.',
    state: 'Not now — the agent is observing only or going offline.',
    ownership: 'This iNFT could not be proven to be in your wallet right now.',
    'sign-in': 'Sign in with the wallet that holds this iNFT first.',
    busy: 'Still working on the last request.',
    tools: 'Install the ACP tools first (ACP Market › Install).'
  },
  refusedBy: rule => `Refused: ${rule}`
}
