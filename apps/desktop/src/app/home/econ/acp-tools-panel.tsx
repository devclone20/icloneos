/**
 * v0.0.9 (owner decision 17 Nov, replaces ruling 26) — the Virtuals ACP CLI ships inside iclone os. This is its state
 * wherever an ACP surface would otherwise run the CLI: the ACP Market pane, its Work tab, and step 1 of the EconomyOS
 * setup. Main places and verifies the included copy (electron/iclone-acp-tools/); this only shows ONE status line —
 * "Virtuals ACP CLI 1.0.38 · included · verified" — and carries the owner's click on the one control left, **Repair**,
 * shown only when the copy does not verify. Install, Cancel, Check for updates and Update now are gone: there is
 * nothing to download (PLANO_V009 §F1 items 1–2; P0_ECONOMYOS_CONTROLS rows S1a–S1f, W0, M0).
 *
 * Repair carries `data-acp-tools-confirm`: the preload counts only a real click or key on it, and main refuses a repair
 * without that verdict (V3-F's gesture lock + audit, ipc.ts). `installAcpTools` (the IPC name is kept) is called
 * synchronously in its handler. Built from the Dock apps' own parts (econ/ui: Empty, Note, e-btn): no new chrome,
 * no new tones (design freeze S24).
 */
import { useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { f1bAcpBundled } from '@/i18n/en/v009-f1b'
import type { AcpToolsTranslations } from '@/i18n/types/acpTools'
import type { AcpToolsInstallResult, AcpToolsProblemInfo, AcpToolsView } from '@/iclone-shared/acp-tools'
import { ChevronRight } from '@/lib/icons'
import { installAcpTools, openAcpNotices } from '@/store/acp-tools'

import { Empty, Note } from './ui'

const words = f1bAcpBundled

/** The one status line: "Virtuals ACP CLI 1.0.38 · included · verified" (version from the build's pin). */
export function acpToolsStatus(view: AcpToolsView): string {
  switch (view.state) {
    case 'installed':
      return words.line(view.cliVersion, words.included, words.verified)

    case 'installing':
      return words.line(view.cliVersion, words.included, words.restoring)

    case 'unverified':
      return words.line(view.cliVersion, words.included, words.notVerified)

    case 'absent':
      return words.line(view.cliVersion, words.notIncluded)

    case 'unavailable':
      return words.line(view.cliVersion, words.cannotRun)

    default:
      return words.line(view.cliVersion, words.checking)
  }
}

/**
 * A reason main sent as a code (critic m4: main never sends a sentence), in the catalogue's words, with its subject (a
 * package and version, a path inside the tree) placed by the catalogue's frame.
 */
export function reasonText(copy: AcpToolsTranslations, problem: AcpToolsProblemInfo): string {
  const text = copy.reasons[problem.reason] ?? copy.reasons.internal

  return problem.subject ? copy.withSubject(text, problem.subject) : text
}

/** The status line, and the reason when the copy is not verified or cannot run. */
export function acpToolsLine(copy: AcpToolsTranslations, view: AcpToolsView): string {
  const status = acpToolsStatus(view)

  return view.state === 'unverified' || view.state === 'unavailable'
    ? `${status} — ${copy.reason(reasonText(copy, view))}`
    : status
}

/** What a refused or failed Repair says (null: it worked). */
export function installErrorText(copy: AcpToolsTranslations, result: AcpToolsInstallResult): string | null {
  if (result.ok) {
    return null
  }

  return result.error === 'failed' ? words.errors.failed(reasonText(copy, result)) : words.errors[result.error]
}

/**
 * The owner's one control: **Repair**, and only while the included copy does not verify (it restores that copy from
 * inside the app, offline). Nothing for any other state. `onResult` hears the outcome (main also keeps the last error).
 */
export function AcpToolsControl({
  className = 'e-btn e-btn--primary',
  onResult,
  view
}: {
  className?: string
  onResult?: (text: string | null) => void
  view: AcpToolsView
}) {
  const copy = useI18n().t.acpTools

  if (view.state !== 'unverified') {
    return null
  }

  return (
    <button
      className={className}
      data-acp-tools-confirm=""
      onClick={() => {
        // Synchronous in the handler: the preload's gesture lock reads this very click.
        const pending = installAcpTools()

        void pending.then(result => onResult?.(installErrorText(copy, result)))
      }}
      type="button"
    >
      {words.repair}
    </button>
  )
}

/**
 * The licence line: the included packages' own notices (the pin's table, then every licence file they carry) once the
 * copy verified; the app's third-party notices otherwise.
 */
export function AcpToolsLicences({ variant = 'button', view }: { variant?: 'button' | 'row'; view: AcpToolsView }) {
  // v0.0.9 r4 (design r3 N9): in the setup step the licences read as a disclosure row — what it opens, then a chevron.
  if (variant === 'row') {
    return (
      <button
        className="iws__disclosure"
        data-acp-licences=""
        onClick={() => openAcpNotices(view.state === 'installed' ? 'installed' : 'app')}
        type="button"
      >
        <span>{view.state === 'installed' ? words.licencesHint : words.thirdParty}</span>
        <ChevronRight aria-hidden="true" size={13} strokeWidth={1.8} />
      </button>
    )
  }

  return view.state === 'installed' ? (
    <Tip label={words.licencesHint}>
      <button className="e-btn e-btn--quiet" onClick={() => openAcpNotices('installed')} type="button">
        {words.licences}
      </button>
    </Tip>
  ) : (
    <button className="e-btn e-btn--quiet" onClick={() => openAcpNotices('app')} type="button">
      {words.thirdParty}
    </button>
  )
}

/** The pane: what an ACP surface shows instead of itself while the included CLI is not verified (or still checking). */
export function AcpToolsPanel({ view }: { view: AcpToolsView }) {
  const copy = useI18n().t.acpTools
  const [said, setSaid] = useState<string | null>(null)
  const error = said ?? (view.lastError ? words.errors.failed(reasonText(copy, view.lastError)) : null)

  const detail =
    view.state === 'unverified'
      ? `${copy.reason(reasonText(copy, view))} ${words.repairHint}`
      : view.state === 'unavailable'
        ? `${copy.reason(reasonText(copy, view))} ${words.reinstallHint}`
        : view.state === 'absent'
          ? words.reinstallHint
          : undefined

  return (
    <div className="e-scroll" data-acp-tools-state={view.state}>
      <Empty
        action={
          <>
            <AcpToolsControl onResult={setSaid} view={view} />
            {view.state === 'installed' || view.state === 'unverified' ? <AcpToolsLicences view={view} /> : null}
          </>
        }
        hint={detail}
        title={acpToolsStatus(view)}
      />
      {error && view.state !== 'installing' && view.state !== 'installed' ? <Note kind="error">{error}</Note> : null}
    </div>
  )
}
