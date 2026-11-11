/**
 * What the live Seatbelt tests decide before they touch anything, kept apart so it can be tested without a sandbox,
 * a browser or a HOME to risk. Used only by tests.
 */
import { copyFileSync } from 'node:fs'
import path from 'node:path'

/** The config a clean install really gets (`stage_config` in scripts/install.sh, and `seedAllShippedDisabled`). */
export const INSTALLER_TEMPLATE = path.resolve(import.meta.dirname, '../../../..', 'cli-config.yaml.example')

/** A live world's home starts from the real template: a stub such as `terminal: {}` is the one healthy case, and it
 *  hid a template whose `backend: "local"` refused every shell tool under confinement (FX35). */
export function writeInstallerConfig(hermesHome: string, name = 'config.yaml'): void {
  copyFileSync(INSTALLER_TEMPLATE, path.join(hermesHome, name))
}

/**
 * The title the gate looks up in its report to say whether the browser proof ran: it looks for "the browser runs inside
 * the agent", which is here as what stopped being true.
 */
export const BROWSER_PROOF_TITLE =
  'ruling R1, was V3-UP r5 N4 (the browser runs inside the agent’s Seatbelt) — it runs outside it, through the launcher’s door: file: refused, http and the web load, nothing left running'

/** A directory no one lives in. The live probes plant decoys and try to write in HOME, so only this kind will do. */
export const isThrowawayHome = (home: string): boolean => /^\/(private\/)?(tmp|var\/folders)\//.test(home)

export type BrowserProofPlan =
  | { state: 'run' }
  | { state: 'not-run'; why: string }
  /** The gate provides its fixture itself, so its absence is a broken gate, not a missing proof. */
  | { state: 'missing-in-gate'; why: string }

export function browserProofPlan(input: {
  fixture: string | null
  chrome: boolean
  inGate: boolean
}): BrowserProofPlan {
  if (!input.fixture) {
    const why = 'no agent-browser binary with its Chromium (V3UP_AGENT_BROWSER, or ~/.npm/_npx; V3UP_CHROMIUM or chromium-<revision> beside it)'

    return input.inGate ? { state: 'missing-in-gate', why } : { state: 'not-run', why }
  }

  return input.chrome ? { state: 'run' } : { state: 'not-run', why: 'Google Chrome is not installed' }
}
