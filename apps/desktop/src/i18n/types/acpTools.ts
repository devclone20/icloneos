import type { AcpToolsReason } from '@/iclone-shared/acp-tools'

/** REL-6 (ruling 26) — the ACP tools (the Virtuals ACP CLI the app installs at first use from npm). */
export type AcpToolsTranslations = {
  /** The panel's heading per state. */
  title: {
    checking: string
    absent: string
    stale: string
    installing: string
    unverified: string
    unavailable: string
  }
  /** Under "not installed": what they are and where they come from. */
  hint: string
  /** The one sentence about licences, and the link to the app's third-party notices. */
  thirdParty: string
  thirdPartyLink: string
  install: string
  update: string
  reinstall: string
  cancel: string
  progress: (done: number, total: number, megabytes: string) => string
  verifying: string
  installed: (version: string) => string
  /** Frames a reason (already in this language). */
  reason: (reason: string) => string
  unavailable: (reason: string) => string
  /**
   * Main sends a reason CODE, never a sentence (critic m4). Each code's words here; `subject` (a package and version,
   * or a path inside the installed tree) is data, placed by `withSubject`.
   */
  reasons: Record<AcpToolsReason, string>
  withSubject: (reason: string, subject: string) => string
  licences: string
  errors: {
    gesture: string
    busy: string
    audit: string
    cancelled: string
    failed: (detail: string) => string
  }
}
