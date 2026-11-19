/**
 * v0.0.9 F1-B — the Virtuals ACP CLI ships inside iclone os (owner decision 17 Nov, replaces ruling 26). The words of
 * its status line (EconomyOS setup step 1, the ACP Market and WORK panels) and of its one control, Repair.
 *
 * English only (the app ships English); imported directly by econ/acp-tools-panel.tsx and settings/inft-setup.tsx.
 * The reason words stay in acpTools.ts (`reasons`), keyed by the code main sends.
 */

export const f1bAcpBundled = {
  name: 'Virtuals ACP CLI',
  /** The status line: name and version, then where it comes from and what the check found. */
  line: (version: string | null, ...parts: string[]) =>
    [version ? `Virtuals ACP CLI ${version}` : 'Virtuals ACP CLI', ...parts].join(' · '),
  included: 'included',
  verified: 'verified',
  checking: 'checking…',
  restoring: 'restoring from the included copy…',
  notVerified: 'not verified',
  notIncluded: 'not included in this build',
  cannotRun: 'cannot run in this build',
  /** Step 1 of the EconomyOS setup. */
  stepTitle: 'The Virtuals connector',
  stepHint: 'It comes with iclone os and is checked against the app’s own signed copy every time it starts.',
  /** Under a copy that does not verify: what Repair does. */
  repairHint:
    'Repair puts back the copy that came with iclone os, from inside the app. No download, and nothing else changes.',
  /** Under a build that cannot run it (Repair cannot help there). */
  reinstallHint: 'Reinstall iclone os to put the Virtuals ACP CLI back.',
  repair: 'Repair',
  repairing: 'Repairing…',
  repaired: (version: string) => `Repaired. Virtuals ACP CLI ${version} is included and verified.`,
  licences: 'Licences',
  licencesHint: 'The included packages and their licences',
  thirdParty: 'Third-party notices',
  errors: {
    gesture: 'Nothing was changed. Repair needs your own click on its button.',
    busy: 'A repair is already running.',
    audit: 'The permission record is not available, so nothing was changed.',
    cancelled: 'Repair stopped. Nothing was changed.',
    failed: (detail: string) => `Repair did not finish: ${detail}. If it keeps failing, reinstall iclone os.`
  }
} as const
