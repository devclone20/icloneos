import * as fs from 'node:fs'
import * as path from 'node:path'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * v0.0.9 e2e harness (triage B2): the first-launch policy dialog ("Before you begin", Step 1 of 3) covers the window
 * until the policy is accepted, so every sandbox starts as a user who already made the first run: `<userData>/
 * consent.json` exactly as the app's own accept + Set up steps write it (electron/iclone-consent.ts `accept`, the
 * three SETUP_SECTIONS decided). The version is the bundled policy's, so a policy bump keeps the seed current; the
 * `e2eSeed` field is ignored by the app (isConsentRecord checks known fields only) and lets the e2e-markers gate prove
 * the seed never leaves e2e/. `consent: false` keeps the true first run (the policy dialog itself).
 */
export const E2E_CONSENT_SEED_MARKER = 'iclone-e2e-consent-seed'

/**
 * The bundled policy's version and effective date, read from electron/policy-version.generated.ts as text (an import
 * would pull electron/ into tsconfig.e2e), so a policy bump keeps the seed current.
 */
export function bundledPolicy(): { version: string; effective: string } {
  const text = fs.readFileSync(path.join(DESKTOP_ROOT, 'electron', 'policy-version.generated.ts'), 'utf8')
  const version = /\n {2}version: '([\d.]+)',/.exec(text)?.[1]
  const effective = /\n {2}effective: '(\d{4}-\d{2}-\d{2})',/.exec(text)?.[1]

  if (!version || !effective) {
    throw new Error('e2e: cannot read the bundled policy version from electron/policy-version.generated.ts')
  }

  return { version, effective }
}

export function consentSeed(at: Date = new Date()) {
  const iso = at.toISOString()
  const BUNDLED_POLICY = bundledPolicy()

  return {
    schema: 1,
    policyVersion: BUNDLED_POLICY.version,
    policyEffective: BUNDLED_POLICY.effective,
    acceptedAt: iso,
    permissions: {},
    permissionsDecidedAt: iso,
    skipped: false,
    aiProviderConsent: { accepted: true, at: iso },
    setup: {
      packages: { state: 'skipped', at: iso },
      system: { state: 'skipped', at: iso },
      agent: { state: 'skipped', at: iso }
    },
    e2eSeed: E2E_CONSENT_SEED_MARKER
  }
}

