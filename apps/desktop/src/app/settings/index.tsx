import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { KbdCombo } from '@/components/ui/kbd'
import { Tip } from '@/components/ui/tooltip'
import { getHermesConfigDefaults, getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Download, RefreshCw, Search, Upload } from '@/lib/icons'
import { isEditableTarget } from '@/lib/keybinds/combo'
import { typeToFocusChar } from '@/lib/keybinds/composer-focus-keys'
import { cn } from '@/lib/utils'
import { $commandPaletteOpen, openCommandPalettePage } from '@/store/command-palette'
import { confirm } from '@/store/confirm'
import { bindingsFor } from '@/store/keybinds'
import { notifyError } from '@/store/notifications'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { OverlayIconButton } from '../overlays/overlay-chrome'
import { OverlayMain, OverlayNav, OverlaySplitLayout } from '../overlays/overlay-split-layout'

import { useSettingsGroups } from './group-disclosure'
import { KEYS_VIEWS, type KeysView } from './keys-settings'
import {
  buildSettingsNavRows,
  CAPABILITIES_TAB_PARAM,
  renderSettingsPane,
  SETTINGS_VIEW_ALIASES,
  SETTINGS_VIEWS,
  settingsGroupDoors,
  type SettingsPaneContext,
  type SettingsPaneId
} from './panes'
import { PROVIDER_VIEWS, type ProviderView } from './providers-settings'
import { SettingsLanding } from './settings-landing'
import {
  DEFAULT_SETTINGS_TAB,
  focusCurrentRailRowAfterPalette,
  settingsReloadPending,
  SettingsShell,
  settingsTabSearch
} from './settings-window'
import type { SettingsPageProps, SettingsView as SettingsViewId } from './types'

// True until the first Settings mount after a reload OF SETTINGS consumes it.
// A reload on another route is not one: the next deliberate deep link into
// Settings (a palette row, a door, a bookmark) opens its pane (UF3A-r1-T1).
let reloadLandingPending = settingsReloadPending()

export function SettingsView({ onClose, onConfigSaved, onMainModelChanged }: SettingsPageProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { hash, pathname, search } = useLocation()
  const paletteOpen = useStore($commandPaletteOpen)

  // MCP lives in the Capabilities pane, and Capabilities is a Settings topic
  // again (front K2): an old `/settings?tab=mcp` bookmark is rewritten to that
  // pane's MCP tab instead of being sent OUT of Settings to `/skills?tab=mcp`.
  // `useRouteEnumParam` would silently coerce the unknown tab to the default
  // view otherwise. `server=` rides along, so the bookmark still lands on (and
  // highlights) the selected server.
  useEffect(() => {
    const params = new URLSearchParams(search)

    if (params.get('tab') !== 'mcp') {
      return
    }

    params.set('tab', 'skills')
    params.set(CAPABILITIES_TAB_PARAM, 'mcp')
    navigate({ pathname, search: `?${params.toString()}` }, { replace: true })
  }, [navigate, pathname, search])

  const [activeView] = useRouteEnumParam('tab', SETTINGS_VIEWS, DEFAULT_SETTINGS_TAB)

  // Opening Settings with no destination (no query at all) is the landing
  // (S8.5): no pane, no current row, the four groups as doors. Picking a pane,
  // or any navigation that changes the query (a palette row), ends it. A
  // renderer reload keeps the previous pane's `?tab=` in the hash; the first
  // Settings mount after one strips it and paints the landing (U2-p2b-05).
  // Read, not consumed, here: StrictMode calls state initializers twice.
  const [reloaded] = useState(() => reloadLandingPending)
  const [landing, setLanding] = useState(() => search === '' || reloaded)
  const [landingSearch, setLandingSearch] = useState(search)

  if (search !== landingSearch) {
    setLandingSearch(search)
    setLanding(search === '')
  }

  useEffect(() => {
    if (!reloaded) {
      return
    }

    reloadLandingPending = false

    if (search !== '') {
      navigate({ hash, pathname, search: '' }, { replace: true })
    }
    // Once, on mount: later query changes are the person's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A palette row (Enter on a search hit) navigates and closes the palette,
  // leaving the keyboard on <body> (U3-p2b-11). Hand it to the rail row that
  // is now current — once the palette has left the document, never while its
  // fading sheet still holds focus (UF3A-r1-T2). A pane that focuses its own
  // deep-linked field (use-deep-link-highlight) keeps it: the row is focused
  // only when nothing else holds the keyboard.
  useEffect(() => {
    if (paletteOpen) {
      return
    }

    return focusCurrentRailRowAfterPalette()
  }, [paletteOpen, search])

  // A tab owns its sub-view param: switching tabs drops the other tabs' pview/kview instead of carrying them along.
  // The cast is the single place `SettingsPaneId` meets `SettingsView`: only
  // panes with a sub-view param are looked up there (TAB_SUB_VIEW), and
  // `profiles` has none, so narrowing cannot change what this returns.
  const setActiveView = useCallback(
    (tab: SettingsPaneId) => {
      setLanding(false)
      navigate({ hash, pathname, search: settingsTabSearch(search, tab as SettingsViewId) }, { replace: true })
    },
    [hash, navigate, pathname, search]
  )

  // A legacy tab id (`?tab=connections`, `?tab=app-atualisation`) lands on
  // the pane that replaced it instead of a dead entry.
  useEffect(() => {
    const target = SETTINGS_VIEW_ALIASES[activeView]

    if (target) {
      setActiveView(target)
    }
  }, [activeView, setActiveView])
  // Providers subnav (Accounts vs API keys) lives in its own param so each
  // sub-view is deep-linkable and survives a refresh.
  const [providerView, setProviderView] = useRouteEnumParam<ProviderView>('pview', PROVIDER_VIEWS, 'accounts')
  const [keysView] = useRouteEnumParam<KeysView>('kview', KEYS_VIEWS, 'tools')

  // Jump to a section + its sub-view in one navigate. Two sequential setters
  // would each read the same stale `search` and the second would clobber the
  // first's `tab` — so the sub-view never opened on narrow screens.
  const openSubView = useCallback(
    (tab: SettingsViewId, param: string, value: string, fallback: string) => {
      const params = new URLSearchParams(search)
      params.set('tab', tab)

      if (value === fallback) {
        params.delete(param)
      } else {
        params.set(param, value)
      }

      const qs = params.toString()
      navigate({ hash, pathname, search: qs ? `?${qs}` : '' }, { replace: true })
    },
    [hash, navigate, pathname, search]
  )

  const openProviderView = useCallback(
    (view: ProviderView) => openSubView('providers', 'pview', view, 'accounts'),
    [openSubView]
  )

  const openKeysView = useCallback((view: KeysView) => openSubView('keys', 'kview', view, 'tools'), [openSubView])

  const importInputRef = useRef<HTMLInputElement | null>(null)

  const exportConfig = async () => {
    try {
      const cfg = await getHermesConfigRecord()
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'hermes-config.json'
      a.click()
      URL.revokeObjectURL(url)
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, t.settings.exportFailed)
    }
  }

  const resetConfig = async () => {
    const ok = await confirm({
      confirmLabel: t.settings.resetToDefaults,
      destructive: true,
      title: t.settings.resetConfirm
    })

    if (!ok) {
      return
    }

    try {
      await saveHermesConfig(await getHermesConfigDefaults())
      triggerHaptic('success')
      onConfigSaved?.()
    } catch (err) {
      notifyError(err, t.settings.resetFailed)
    }
  }

  // Everything the pane registry (panes.tsx) needs to compute nav rows + the
  // active pane's content — one object instead of threading a dozen props
  // through a hand-written switch. See SettingsPaneContext.
  const paneContext: SettingsPaneContext = useMemo(
    () => ({
      activeView,
      importInputRef,
      keysView,
      navigate,
      onClose,
      onConfigSaved,
      onKeysViewChange: openKeysView,
      onMainModelChanged,
      onNavigateView: setActiveView,
      onProviderViewChange: openProviderView,
      providerView,
      t
    }),
    [
      activeView,
      importInputRef,
      keysView,
      navigate,
      onClose,
      onConfigSaved,
      onMainModelChanged,
      openKeysView,
      openProviderView,
      providerView,
      setActiveView,
      t
    ]
  )

  // A destination in the URL when Settings mounts (`?tab=`, a palette row,
  // another surface's door) reveals its group; the landing reveals none, and
  // leaving it for a pane (a door, a rail row) reveals that pane's group.
  const [openedOnPane] = useState(() => !landing)
  const groupDisclosure = useSettingsGroups(landing ? '' : activeView, openedOnPane)

  const navGroups = useMemo(
    () => buildSettingsNavRows(paneContext, groupDisclosure, landing),
    [groupDisclosure, landing, paneContext]
  )

  const landingDoors = useMemo(() => settingsGroupDoors(t), [t])

  const activeSettingsContent = landing ? (
    <SettingsLanding doors={landingDoors} onOpen={setActiveView} />
  ) : (
    renderSettingsPane(paneContext)
  )

  // Type-to-search: printable keystrokes on the Settings surface (outside any
  // field) open the settings-scoped palette, seeded with the character — same
  // reflex as the chat surface's type-to-focus, pointed at search instead.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ($commandPaletteOpen.get() || isEditableTarget(event.target)) {
        return
      }

      const char = typeToFocusChar(event)

      if (char === null || char === ' ') {
        return
      }

      event.preventDefault()
      openCommandPalettePage('settings', char)
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Fake search pill: in the Dock window's header band, or riding the card's top edge.
  // Clicking (or just typing) opens the ⌘K palette scoped to settings; while
  // the palette is up the pill hands over to it — grows slightly and fades,
  // then fades back when the palette closes. It renders as chrome, not an
  // input — no border, recessed fill, live ⌘K hint.
  const searchCombo = bindingsFor('nav.commandPalette')[0]

  const searchPill = (
    <button
      className={cn(
        'flex h-(--titlebar-control-height) items-center gap-1.5 rounded-full border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-2.5 text-(--ui-text-tertiary) shadow-sm transition-all duration-200 ease-out hover:text-foreground motion-reduce:transition-none',
        paletteOpen && 'pointer-events-none scale-110 opacity-0'
      )}
      onClick={() => {
        triggerHaptic('open')
        openCommandPalettePage('settings')
      }}
      tabIndex={paletteOpen ? -1 : undefined}
      type="button"
    >
      <Search aria-hidden className="size-3" />
      <span className="text-xs">{t.settings.search.pill}</span>
      {searchCombo && <KbdCombo combo={searchCombo} size="sm" variant="ghost" />}
    </button>
  )

  const navFooter = (
    <>
      <Tip label={t.settings.exportConfig}>
        <OverlayIconButton aria-label={t.settings.exportConfig} onClick={() => void exportConfig()}>
          <Download />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.importConfig}>
        <OverlayIconButton
          aria-label={t.settings.importConfig}
          onClick={() => {
            triggerHaptic('open')
            importInputRef.current?.click()
          }}
        >
          <Upload />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.resetToDefaults}>
        <OverlayIconButton
          aria-label={t.settings.resetToDefaults}
          className="hover:text-destructive"
          onClick={() => {
            triggerHaptic('warning')
            void resetConfig()
          }}
        >
          <RefreshCw />
        </OverlayIconButton>
      </Tip>
    </>
  )

  return (
    <SettingsShell
      closeLabel={t.settings.closeSettings}
      onClose={onClose}
      search={searchPill}
      title={t.commandCenter.nav.settings.title}
    >
      <OverlaySplitLayout>
        <OverlayNav footer={navFooter} groups={navGroups} />

        <OverlayMain className="px-0 pb-0">{activeSettingsContent}</OverlayMain>
      </OverlaySplitLayout>
    </SettingsShell>
  )
}
