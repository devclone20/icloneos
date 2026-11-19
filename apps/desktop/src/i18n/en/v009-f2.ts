/**
 * v0.0.9 F2 — the words for the agent starting, restarting and reconnecting by itself.
 *
 * English only (the app ships English); imported directly by src/store/backend-restart.ts and
 * src/app/home/inft-switch.ts. Calm on purpose: a restart in progress is not an error.
 */

export const f2Restart = {
  /** The agent stopped or did not start; main is restarting it (attempt n of max). */
  restarting: (attempt: number, max: number): string => `Restarting the agent (attempt ${attempt} of ${max})…`,
  /** Main gave up after its automatic attempts; the user's Retry is next. */
  // r4d (design r4 F2-1): one voice — no second verb for the action the button already names.
  stoppedLimit: "It stopped and didn't come back after several tries.",
  /** A cause a restart cannot cure; the failure screen names it. */
  stoppedDeterministic: 'The agent cannot start until the problem shown is fixed.'
} as const

/**
 * v0.0.9 design 10/11: the crash entry says what happened, why (from the exit main reported) and what to do, in the
 * owner's words ("the agent", never "backend").
 */
export const f2Crash = {
  /** Why, from the exit: a signal (the system or memory pressure ended it), an error code, or a plain quit. */
  // r4d (design r4 F2-1): the signal name is engineer text — it goes to the entry's detail (crashDetail), never here.
  causeSignal: (_signal: string): string =>
    'The system ended its background process. This usually means the Mac was short of memory.',
  causeCode: (code: number): string => `Its background process quit with error code ${code}.`,
  causeClean: 'Its background process quit on its own.',
  causeUnknown: 'Its background process quit.',
  /** What to do. */
  // G-7 (design G): active, and it names who restarts it.
  nextStep: 'icloneOS restarts it automatically. If it stays stopped, choose Restart agent.',
  /** The exit as main reported it, for the entry's Details (engineer words live there, not in the body). */
  detail: (signal: null | string, code: null | number): string =>
    signal ? `Exit signal: ${signal}` : code !== null ? `Exit code: ${code}` : 'No exit status was reported.',
  restart: 'Restart agent',
  restartFailed: 'The agent did not start'
} as const

export const f2Inft = {
  /** A restored iNFT waiting for the agent to be ready (app reopen). */
  waitingForStart: (name: string): string => `${name}: waiting for the agent to start — connecting when it is ready`,
  /** The same while main restarts the agent. */
  waitingForRestart: (name: string, attempt: number, max: number): string =>
    `${name}: the agent is restarting (attempt ${attempt} of ${max}) — connecting when it is back`,
  /** Between automatic retries of a restore. */
  retrying: (name: string): string => `${name}: connecting to the agent…`
} as const
