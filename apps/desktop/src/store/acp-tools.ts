/**
 * REL-6 (ruling 26) — the window's copy of main's ACP tools state (the Virtuals ACP CLI, installed at first use from
 * npm). Main owns every transition and pushes each one (`iclone:acp-tools:changed`); this store keeps the latest and
 * never decides anything itself.
 *
 * `installAcpTools` must run synchronously inside the click handler of a control carrying `data-acp-tools-confirm`:
 * the preload's gesture lock reads that click, and main refuses an install without it.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect } from 'react'

import { type AcpToolsInstallResult, type AcpToolsView, isAcpToolsView } from '@/iclone-shared/acp-tools'

/** @public the bridge shape `window.hermesDesktop.icloneAcpTools` is typed with (src/global.d.ts). */
export interface AcpToolsBridge {
  state: () => Promise<unknown>
  check: () => Promise<unknown>
  install: () => Promise<unknown>
  cancel: () => Promise<unknown>
  openNotices: (which: 'app' | 'installed') => Promise<unknown>
  onChanged: (callback: (view: unknown) => void) => () => void
}

const bridge = (): AcpToolsBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneAcpTools

/** The desktop app has the installer; the web build has no ACP surface that could run a CLI. */
export const hasAcpToolsBridge = (): boolean => Boolean(bridge())

/** null: not asked yet, or no desktop bridge (the web build). */
export const $acpTools = atom<AcpToolsView | null>(null)

let unsubscribe: (() => void) | null = null

const accept = (value: unknown) => {
  if (isAcpToolsView(value)) {
    $acpTools.set(value)
  }
}

/** Subscribe once to main's pushes and ask for the current state. */
export function watchAcpTools(): void {
  const door = bridge()

  if (!door) {
    return
  }

  unsubscribe ??= door.onChanged(accept)
  void door.state().then(accept, () => undefined)
}

/** Test seam. */
export function resetAcpToolsForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  $acpTools.set(null)
}

const UNAVAILABLE: AcpToolsInstallResult = { ok: false, error: 'failed', reason: 'installer-down' }

/** The owner's click. Call it synchronously in the handler of the `data-acp-tools-confirm` control. */
export function installAcpTools(): Promise<AcpToolsInstallResult> {
  const door = bridge()

  if (!door) {
    return Promise.resolve(UNAVAILABLE)
  }

  return door.install().then(
    result => {
      const answer = result as AcpToolsInstallResult

      if (answer && answer.ok) {
        accept(answer.view)
      }

      return answer ?? UNAVAILABLE
    },
    (): AcpToolsInstallResult => ({ ok: false, error: 'failed', reason: 'internal' })
  )
}

export function cancelAcpToolsInstall(): void {
  void bridge()?.cancel()
}

export function openAcpNotices(which: 'app' | 'installed'): void {
  void bridge()?.openNotices(which)
}

/** The state for a component: subscribes on mount. */
export function useAcpTools(): AcpToolsView | null {
  useEffect(() => {
    watchAcpTools()
  }, [])

  return useStore($acpTools)
}
