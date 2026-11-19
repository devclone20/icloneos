/**
 * v0.0.9 e2e harness (owner condition, e2e triage "11 false passes"): what the running test claims about the app it
 * drives, and whether that claim held. E2E-ONLY: nothing here is read by the app, and no marker of it may appear
 * outside apps/desktop/e2e/ (scripts/e2e-markers.test.mjs).
 *
 * - `booted`: the test drives a booted app. It FAILS (test.ts afterEach) unless `waitForAppReady` reached ready during
 *   or before it; when it did, the test carries a `reached-ready` annotation (machine-countable after a run).
 * - `non-ready`: the test deliberately drives an app that is not ready (boot failure, onboarding, the fail-closed
 *   gate, a token-at-rest check with the backend intentionally down). It carries a `non-ready-by-design` annotation
 *   with its reason, and it must assert its own expected state.
 * A launch with no claim fails too: every launch says which it is.
 */
export type ReadyClaim = { kind: 'booted'; ready: boolean } | { kind: 'non-ready'; reason: string }

/**
 * v0.0.9 eng G2-m1: a worker runs many spec files, and claims are made in a file's beforeAll, so state from one file
 * must never answer for the next. Each claim and each unclaimed launch remembers the spec file that made it; a test
 * in another file sees none. test.ts supplies the file (test.info().file), which keeps this module free of Playwright.
 */
let specFile: () => string = () => ''

export function setSpecFileSource(source: () => string): void {
  specFile = source
}

let claim: (ReadyClaim & { file: string }) | null = null
let launchedWithoutClaim: string | null = null

export const READY_ANNOTATION = 'reached-ready'
export const NON_READY_ANNOTATION = 'non-ready-by-design'
export const BOOTED_ANNOTATION = 'booted-claim'
export const UNCLAIMED_ANNOTATION = 'unclaimed-launch'

/** The app being driven must reach ready (waitForAppReady) before the test ends. */
export function claimBooted(): void {
  claim = { file: specFile(), kind: 'booted', ready: false }
  launchedWithoutClaim = null
}

/** The app being driven is not ready on purpose; the test asserts that state itself. */
export function claimNonReady(reason: string): void {
  claim = { file: specFile(), kind: 'non-ready', reason }
  launchedWithoutClaim = null
}

/** Called by waitForAppReady once ready is reached. */
export function markReady(): void {
  const own = currentClaim()

  if (own?.kind === 'booted') {
    own.ready = true
  }
}

/** Called by launchDesktop: a launch the test has not classified yet (cleared by the next claim). */
export function noteLaunch(): void {
  if (currentClaim() === null) {
    launchedWithoutClaim = specFile()
  }
}

/** The claim made in the running test's own spec file, or null. */
export function currentClaim(): ReadyClaim | null {
  return claim && claim.file === specFile() ? claim : null
}

export function launchWasUnclaimed(): boolean {
  return launchedWithoutClaim !== null && launchedWithoutClaim === specFile()
}

/**
 * G-m5: readiness is per TEST. At the start of each test a booted claim goes back to not-ready, so a test can never
 * inherit "ready" from an earlier one in a serial describe; it is ready only if the app is ready during it (test.ts
 * re-checks at the start, or the test waits itself).
 */
export function startTest(): void {
  const own = currentClaim()

  if (own?.kind === 'booted') {
    own.ready = false
  }
}

/** Clears every claim and launch note (the unit tests start from this). Per-file isolation needs no reset. */
export function resetClaims(): void {
  claim = null
  launchedWithoutClaim = null
}
