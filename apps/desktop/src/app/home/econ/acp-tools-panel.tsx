/**
 * REL-6 (ruling 26) — the ACP tools state, wherever an ACP surface would otherwise run the CLI: the ACP Market pane,
 * its Work tab and the Settings row. Main installs and verifies (electron/iclone-acp-tools/); this only shows the
 * state and carries the owner's click. Built from the Dock apps' own parts (econ/ui: Empty, Note, e-btn): no new
 * chrome, no new tones (design freeze S24).
 *
 * The install button carries `data-acp-tools-confirm`: the preload counts only a real click or key on it, and main
 * refuses an install without that verdict. `installAcpTools` is called synchronously in its handler.
 */
import { useState } from 'react'

import { useI18n } from '@/i18n'
import type { AcpToolsTranslations } from '@/i18n/types/acpTools'
import type { AcpToolsInstallResult, AcpToolsProblemInfo, AcpToolsView } from '@/iclone-shared/acp-tools'
import { cancelAcpToolsInstall, installAcpTools, openAcpNotices } from '@/store/acp-tools'

import { Empty, Note } from './ui'

const MB = 1024 * 1024

export function acpToolsTitle(copy: AcpToolsTranslations, view: AcpToolsView): string {
  if (view.state === 'absent') {
    return view.stale ? copy.title.stale : copy.title.absent
  }

  return view.state === 'installed' ? copy.installed(view.cliVersion) : copy.title[view.state]
}

/**
 * A reason main sent as a code (critic m4: main never sends a sentence), in this locale's words, with its subject (a
 * package and version, a path inside the tree) placed by the locale's frame.
 */
export function reasonText(copy: AcpToolsTranslations, problem: AcpToolsProblemInfo): string {
  const words = copy.reasons[problem.reason] ?? copy.reasons.internal

  return problem.subject ? copy.withSubject(words, problem.subject) : words
}

/** The one line a row shows (Settings): the state, and the reason or progress when there is one. */
export function acpToolsLine(copy: AcpToolsTranslations, view: AcpToolsView): string {
  switch (view.state) {
    case 'installing':
      return view.phase === 'verify'
        ? copy.verifying
        : copy.progress(view.done, view.total, (view.bytes / MB).toFixed(1))

    case 'unverified':
      return `${copy.title.unverified} — ${copy.reason(reasonText(copy, view))}`

    case 'unavailable':
      return copy.unavailable(reasonText(copy, view))

    case 'absent':
      return `${acpToolsTitle(copy, view)} — ${view.stale ? copy.update : copy.install}`

    default:
      return acpToolsTitle(copy, view)
  }
}

export function installErrorText(copy: AcpToolsTranslations, result: AcpToolsInstallResult): string | null {
  if (result.ok) {
    return null
  }

  return result.error === 'failed' ? copy.errors.failed(reasonText(copy, result)) : copy.errors[result.error]
}

/**
 * The owner's control for the state: Install / Update / Reinstall (the gesture-locked button), Cancel while
 * installing, nothing once installed. `onResult` hears refusals and failures (main also keeps the last one).
 */
export function AcpToolsControl({
  cancelClassName = 'e-btn e-btn--quiet',
  className = 'e-btn e-btn--primary',
  onResult,
  view
}: {
  cancelClassName?: string
  className?: string
  onResult?: (text: string | null) => void
  view: AcpToolsView
}) {
  const copy = useI18n().t.acpTools

  if (view.state === 'installing') {
    return (
      <button className={cancelClassName} onClick={cancelAcpToolsInstall} type="button">
        {copy.cancel}
      </button>
    )
  }

  if (view.state !== 'absent' && view.state !== 'unverified') {
    return null
  }

  const label = view.state === 'unverified' ? copy.reinstall : view.stale ? copy.update : copy.install

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
      {label}
    </button>
  )
}

/** The licence line: the app's third-party notices before an install; the installed packages' own after. */
export function AcpToolsLicences({ view }: { view: AcpToolsView }) {
  const copy = useI18n().t.acpTools

  return view.state === 'installed' ? (
    <button className="e-btn e-btn--quiet" onClick={() => openAcpNotices('installed')} type="button">
      {copy.licences}
    </button>
  ) : (
    <span className="e-empty__hint">
      {copy.thirdParty}{' '}
      <button className="e-btn e-btn--quiet" onClick={() => openAcpNotices('app')} type="button">
        {copy.thirdPartyLink}
      </button>
    </span>
  )
}

/** The pane: what an ACP surface shows instead of itself while the tools are not installed and verified. */
export function AcpToolsPanel({ view }: { view: AcpToolsView }) {
  const copy = useI18n().t.acpTools
  const [said, setSaid] = useState<string | null>(null)
  const error = said ?? (view.lastError ? copy.errors.failed(reasonText(copy, view.lastError)) : null)

  const detail =
    view.state === 'installing' || view.state === 'unavailable'
      ? acpToolsLine(copy, view)
      : view.state === 'unverified'
        ? copy.reason(reasonText(copy, view))
        : view.state === 'checking'
          ? undefined
          : copy.hint

  return (
    <div className="e-scroll" data-acp-tools-state={view.state}>
      <Empty
        action={
          <>
            <AcpToolsControl onResult={setSaid} view={view} />
            {view.state !== 'checking' && view.state !== 'unavailable' ? <AcpToolsLicences view={view} /> : null}
          </>
        }
        hint={detail}
        title={acpToolsTitle(copy, view)}
      />
      {error && view.state !== 'installing' ? <Note kind="error">{error}</Note> : null}
    </div>
  )
}
