/**
 * Cmd-K "Install theme…" page.
 *
 * Browses the VS Code Marketplace for color themes: an empty query shows the
 * most-installed themes, typing runs a live (debounced) search against the
 * Marketplace. Selecting a row downloads + converts + installs it via the same
 * pipeline as the settings importer, then activates it — and stays open so the
 * user can grab several.
 */

import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useDebounced } from '@/app/hooks/use-debounced'
import type { DesktopMarketplaceSearchItem } from '@/global'
import { useI18n } from '@/i18n'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'
import { triggerHaptic } from '@/lib/haptics'
import { Check, Download, Loader2, Palette } from '@/lib/icons'
import { installVscodeThemeFromMarketplace } from '@/themes/install'
import { $marketplaceInstalls } from '@/themes/user-themes'

import { StatusRow } from './status-row'

const compactNumber = new Intl.NumberFormat(APP_INTL_LOCALE, { notation: 'compact', maximumFractionDigits: 1 })

interface MarketplaceThemePageProps {
  search: string
  /** Activate a freshly installed theme by slug. */
  onPickTheme: (name: string) => void
}

export function MarketplaceThemePage({ search, onPickTheme }: MarketplaceThemePageProps) {
  const { t } = useI18n()
  const copy = t.commandCenter.installTheme
  const debouncedSearch = useDebounced(search.trim(), 300)
  const installs = useStore($marketplaceInstalls)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  // Absent in the web build (src/web-shim/bridge.ts ABSENT_IN_WEB): said in words, never an empty result list.
  const available = typeof window.hermesDesktop?.themes?.searchMarketplace === 'function'

  const query = useQuery({
    enabled: available,
    queryKey: ['marketplace-themes', debouncedSearch],
    queryFn: () => window.hermesDesktop?.themes?.searchMarketplace(debouncedSearch) ?? Promise.resolve([]),
    staleTime: 5 * 60 * 1000
  })

  // Already installed → just re-activate it; never re-download what we have.
  const select = (item: DesktopMarketplaceSearchItem) => {
    const owned = installs.get(item.extensionId)

    if (owned) {
      triggerHaptic('crisp')
      onPickTheme(owned.name)

      return
    }

    void install(item)
  }

  const install = async (item: DesktopMarketplaceSearchItem) => {
    if (installingId) {
      return
    }

    setInstallingId(item.extensionId)
    setInstallError(null)

    try {
      const theme = await installVscodeThemeFromMarketplace(item.extensionId)

      triggerHaptic('crisp')
      onPickTheme(theme.name)
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : copy.error)
    } finally {
      setInstallingId(null)
    }
  }

  if (!available) {
    return <StatusRow text={copy.unavailable} />
  }

  if (query.isLoading) {
    return <StatusRow icon={<Loader2 className="icp-status__icon" data-spin />} text={copy.loading} />
  }

  if (query.isError) {
    return <StatusRow text={copy.error} tone="error" />
  }

  const results = query.data ?? []

  if (results.length === 0) {
    return <StatusRow text={copy.empty} />
  }

  return (
    // A plain group, with no listbox role of its own: these rows already sit
    // INSIDE the sheet's listbox (the `status` slot of `.icp-list`), and a
    // second listbox there breaks the combobox popup contract a screen reader
    // reads.
    <div className="icp-group">
      {installError && <p className="icp-notice">{installError}</p>}
      {results.map(item => {
        const busy = installingId === item.extensionId
        const done = installs.has(item.extensionId)

        return (
          /* These rows load and install on their own, so they stay real
             buttons: they are the one page whose rows are not ranked palette
             items, and the sheet's Tab cycle picks them up (`data-icp-focus`).
             They are never hidden while focusable — gate G5. */
          <button
            className="icp-row"
            data-icp-focus
            disabled={Boolean(installingId) && !busy}
            key={item.extensionId}
            onClick={() => select(item)}
            onMouseDown={event => event.preventDefault()}
            type="button"
          >
            <Palette className="icp-row__icon" />
            <span className="icp-row__body">
              <span className="icp-row__label">{item.displayName}</span>
              <span className="icp-row__note">
                {item.publisher}
                {item.installs > 0 ? ` · ${copy.installs(compactNumber.format(item.installs))}` : ''}
              </span>
            </span>
            <span className="icp-row__trailing" data-tone={done ? 'success' : busy ? 'accent' : 'muted'}>
              {busy ? (
                <>
                  <Loader2 className="icp-row__trailing-icon" data-spin />
                  {copy.installing}
                </>
              ) : done ? (
                <>
                  <Check className="icp-row__trailing-icon" />
                  {copy.installed}
                </>
              ) : (
                <>
                  <Download className="icp-row__trailing-icon" />
                  {copy.install}
                </>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
