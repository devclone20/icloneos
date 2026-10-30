import { lazy, type ReactNode, type RefObject, Suspense } from 'react'

import { PermissionsPane } from '@/components/permissions/permissions-pane'
import { codiconIcon } from '@/components/ui/codicon'
import type { Translations } from '@/i18n'
import {
  Archive,
  BarChart3,
  Bell,
  Bookmark,
  Command,
  Cpu,
  CreditCard,
  Globe,
  type IconComponent,
  Info,
  Keyboard,
  KeyRound,
  MessageSquareText,
  Package,
  PanelLeftIcon,
  PawPrint,
  Settings2,
  Terminal,
  Users,
  Wrench,
  Zap
} from '@/lib/icons'

import type { OverlayNavGroup, OverlayNavHeading, OverlayNavLink } from '../overlays/overlay-split-layout'

import { AboutSettings } from './about-settings'
import { AppAtualisationSettings } from './app-atualisation'
import { UpdatesNavIcon } from './app-atualisation/updates-nav-icon'
import { AppearanceSettings } from './appearance-settings'
import { BillingSettings } from './billing'
import { ConfigSettings } from './config-settings'
import { SECTIONS } from './constants'
import { DiagnosticsSettings } from './diagnostics-settings'
import { paymentsCopyFor } from './economy/payments-copy'
import { PaymentsPane } from './economy/payments-pane'
import { EngineSettings } from './engine-settings'
import { GatewaySettings } from './gateway-settings'
import type { GroupDisclosure } from './group-disclosure'
import { HudSettings } from './hud-settings'
import { InftSettings } from './inft-settings'
import { InftSetupPane } from './inft-setup'
import { ItTerminalSettings } from './it-terminal-settings'
import { KeybindSettings } from './keybind-settings'
import { KeysSettings, type KeysView } from './keys-settings'
import { NotificationsSettings } from './notifications-settings'
import { revealPetSettings } from './pet-settings'
import { PluginsSettings } from './plugins-settings'
import { ListRow, SettingsContent } from './primitives'
import { PrivacySettings } from './privacy-settings'
import { ProvidersSettings, type ProviderView } from './providers-settings'
import { SessionsBotsSettings } from './sessions-bots'
import { SessionsSettings } from './sessions-settings'
import type { SettingsView as SettingsViewId } from './types'

// Opening Settings must not pay for the Capabilities surface: the page (three
// tabs, the MCP tab, its own stylesheet) loads when the rail row is clicked,
// the way `chat/route-tile.tsx` and `contrib/wiring.tsx` load the same module.
const SkillsView = lazy(async () => ({ default: (await import('../skills')).SkillsView }))
// Same bargain for Profiles (front K3): 15 files, three dialogs and a SOUL.md editor.
const ProfilesView = lazy(async () => ({ default: (await import('../profiles')).ProfilesView }))

// And for the last two surfaces that still opened OVER Settings (front K5):
// Messaging (the platform pairing page) and Command Center, which the owner
// ordered moved WHOLE on 2026-10-20 — its usage dashboard included.
const MessagingView = lazy(async () => ({ default: (await import('../messaging')).MessagingView }))
const CommandCenterPane = lazy(async () => ({ default: (await import('../command-center/pane')).CommandCenterPane }))
// And for the iNFT Book (front V3-H): a virtualised wallet grid Settings must not load until its row is clicked.
const InftBookView = lazy(async () => ({ default: (await import('./inft-book')).InftBookView }))
// And for Set up (V3-ON): its live rows read macOS and the packages only when the row is clicked.
const SetupSettings = lazy(async () => ({ default: (await import('./setup-settings')).SetupSettings }))

// ── The four groups the owner approved, in his order: who you
// are, your agent, your money, the machine it runs on (S8.4: OS-neutral names). Every pane below declares exactly one
// as its `groupId`; `buildSettingsNavRows` renders one heading per group ahead
// of its panes, and each heading is a disclosure that starts collapsed. ─────
export type SettingsGroupId = 'profile' | 'agent' | 'economy' | 'machine'

interface SettingsGroupMeta {
  id: SettingsGroupId
  /** Used only if a locale is missing `t.settings.groups[id]` — mirrors the
   *  `t.settings.sections[id] ?? s.label` fallback already used for panes. */
  fallbackLabel: string
}

const SETTINGS_GROUPS: readonly SettingsGroupMeta[] = [
  { id: 'profile', fallbackLabel: 'Profile' },
  { id: 'agent', fallbackLabel: 'Agent' },
  { id: 'economy', fallbackLabel: 'Economy' },
  { id: 'machine', fallbackLabel: 'Machine' }
]

const SETTINGS_GROUP_BY_ID = new Map(SETTINGS_GROUPS.map(group => [group.id, group]))

/** A Settings rail pane id: the `SettingsView` union plus the three surfaces
 *  that moved in, whose members cannot go in `settings/types.ts` (fronts K3
 *  and K5 do not own it). */
export type SettingsPaneId = SettingsViewId | 'command-center' | 'messaging' | 'payments' | 'profiles'

// The Capabilities pane hosts a page that has tabs of its own, and `?tab=`
// already belongs to the Settings rail — so the page's tab rides its own param,
// exactly like Providers' `pview` and Keys' `kview` (front K2).
export const CAPABILITIES_TAB_PARAM = 'cview'
const SECTION_BY_ID = new Map(SECTIONS.map(section => [section.id, section]))

// Appearance is curated in SECTIONS (nav icon/label) like every other config
// section, but its content is a bespoke page — not schema-driven fields
// (its `keys: []` is deliberate) — so it needs its own pane below instead of
// going through the generic `configPane` helper.
const APPEARANCE_SECTION = SECTION_BY_ID.get('appearance')

if (!APPEARANCE_SECTION) {
  throw new Error('Unknown settings section: appearance')
}

// Everything a pane's `label` / `children` / `render` needs. Built once per
// SettingsView render and threaded through — panes stay pure data + closures
// over this, instead of each one re-deriving its own piece of app state.
export interface SettingsPaneContext {
  activeView: SettingsPaneId
  importInputRef: RefObject<HTMLInputElement | null>
  keysView: KeysView
  navigate: (route: string) => void
  onClose: () => void
  onConfigSaved?: () => void
  onKeysViewChange: (view: KeysView) => void
  onMainModelChanged?: (provider: string, model: string) => void
  onNavigateView: (view: SettingsPaneId) => void
  onProviderViewChange: (view: ProviderView) => void
  providerView: ProviderView
  t: Translations
}

interface SettingsPaneDef {
  /** Nav-rail sub-links, expanded under the pane while it's active (Providers'
   *  Accounts/Keys/Custom Endpoints, Keys' Tools/Settings). */
  children?: (ctx: SettingsPaneContext) => OverlayNavLink[]
  groupId: SettingsGroupId
  icon: IconComponent
  id: SettingsPaneId
  label: (t: Translations) => string
  /** Words (besides the pane's name) that reach it in Settings search, from the catalogue. */
  keywords?: (t: Translations) => readonly string[]
  render: (ctx: SettingsPaneContext) => ReactNode
}

/** A pane hosting one of OUR full pages inside the Settings body (K2's shape,
 *  reused by K3, so a third surface is one row). `page` is lazy: opening
 *  Settings never pays for a surface it may not show. The box is definite
 *  because the page chassis is `height: 100%` and would collapse here. */
function pagePane(pane: Omit<SettingsPaneDef, 'render'>, page: ReactNode): SettingsPaneDef {
  return {
    ...pane,
    // Owner rule S8.4: a guest page sits on the Settings background like every
    // other pane — its own head band loses the glint gradient here (only here:
    // the same chassis keeps it where it is a window of its own).
    render: () => (
      <div className="flex min-h-0 flex-1 flex-col [&_.icpg\_\_head]:bg-none!" data-settings-guest="">
        <Suspense fallback={null}>{page}</Suspense>
      </div>
    )
  }
}

/** A config: section pane — icon/label come from the curated SECTIONS table
 *  (constants.ts); `extra` appends cross-link rows below ConfigSettings. */
function configPane(
  sectionId: string,
  groupId: SettingsGroupId,
  extra?: (ctx: SettingsPaneContext) => ReactNode
): SettingsPaneDef {
  const section = SECTION_BY_ID.get(sectionId)

  if (!section) {
    throw new Error(`Unknown settings section: ${sectionId}`)
  }

  return {
    groupId,
    icon: section.icon,
    id: `config:${sectionId}` as SettingsPaneId,
    label: t => t.settings.sections[sectionId] ?? section.label,
    render: ctx => (
      <>
        <ConfigSettings
          activeSectionId={sectionId}
          importInputRef={ctx.importInputRef}
          onConfigSaved={ctx.onConfigSaved}
          onMainModelChanged={ctx.onMainModelChanged}
        />
        {extra?.(ctx)}
      </>
    )
  }
}

// ── The 32 panes, listed group by group in the order of inventory §3. This
// is the single source of truth `buildSettingsNavRows` and `renderSettingsPane`
// both derive from — no tab/pview/kview id below was renamed, so every old
// `?tab=` deep link (config:*, providers, gateway, keys, …) still resolves. ─
const SETTINGS_PANES: SettingsPaneDef[] = [
  // Profile
  // Profiles — OUR page, INSIDE this pane instead of behind the cross-link that
  // threw you out of Settings. Every door lands on `PROFILES_PANE` now.
  pagePane({ groupId: 'profile', icon: Users, id: 'profiles', label: t => t.profiles.title }, <ProfilesView />),
  // Messaging — OUR page, INSIDE Settings instead of behind the cross-link at
  // the bottom of Gateways that threw you out of it. It keeps its own
  // `frame="bare"` chassis, so the Settings card is the only card.
  pagePane(
    {
      groupId: 'profile',
      icon: MessageSquareText,
      id: 'messaging',
      label: t => t.commandCenter.nav.messaging.title
    },
    <MessagingView />
  ),
  {
    children: ctx => [
      {
        active: ctx.activeView === 'providers' && ctx.providerView === 'accounts',
        icon: codiconIcon('account'),
        id: 'pview:accounts',
        label: ctx.t.settings.nav.providerAccounts,
        onSelect: () => ctx.onProviderViewChange('accounts')
      },
      {
        active: ctx.activeView === 'providers' && ctx.providerView === 'keys',
        icon: KeyRound,
        id: 'pview:keys',
        label: ctx.t.settings.nav.providerApiKeys,
        onSelect: () => ctx.onProviderViewChange('keys')
      },
      {
        active: ctx.activeView === 'providers' && ctx.providerView === 'custom-endpoints',
        icon: Globe,
        id: 'pview:custom-endpoints',
        label: ctx.t.settings.nav.providerCustomEndpoints,
        onSelect: () => ctx.onProviderViewChange('custom-endpoints')
      }
    ],
    groupId: 'profile',
    icon: Zap,
    id: 'providers',
    label: t => t.settings.nav.providers,
    render: ctx => (
      <ProvidersSettings
        onClose={ctx.onClose}
        onConfigSaved={ctx.onConfigSaved}
        onMainModelChanged={ctx.onMainModelChanged}
        onViewChange={ctx.onProviderViewChange}
        view={ctx.providerView}
      />
    )
  },
  {
    children: ctx => [
      {
        active: ctx.activeView === 'keys' && ctx.keysView === 'tools',
        icon: Wrench,
        id: 'kview:tools',
        label: ctx.t.settings.nav.keysTools,
        onSelect: () => ctx.onKeysViewChange('tools')
      },
      {
        active: ctx.activeView === 'keys' && ctx.keysView === 'settings',
        icon: Settings2,
        id: 'kview:settings',
        label: ctx.t.settings.nav.keysSettings,
        onSelect: () => ctx.onKeysViewChange('settings')
      }
    ],
    groupId: 'profile',
    icon: KeyRound,
    id: 'keys',
    label: t => t.settings.nav.apiKeys,
    render: ctx => <KeysSettings view={ctx.keysView} />
  },
  {
    groupId: 'profile',
    icon: codiconIcon('shield'),
    id: 'privacy',
    label: t => t.settings.nav.privacy,
    render: ctx => <PrivacySettings navigate={ctx.navigate} />
  },

  // Agent
  configPane('model', 'agent'),
  {
    groupId: 'agent',
    icon: Cpu,
    id: 'engine',
    label: t => t.settings.nav.engine,
    render: () => <EngineSettings />
  },
  configPane('memory', 'agent'),
  configPane('voice', 'agent'),
  // Capabilities — skills, tools and MCP servers. OUR page (`app/skills`),
  // rendered INSIDE this pane: the owner asked for one topic in Settings
  // instead of the two buried doors front K1 measured (the Tools & Keys
  // cross-link and the legacy sidebar's unlabelled icon), and for the thinner
  // `Skills` pane that duplicated it to go. The pane id stays `skills`, so
  // every `?tab=skills` bookmark still lands here; the page's own Skills ·
  // Tools · MCP strip rides `?cview=` because `?tab=` is the rail's.
  pagePane(
    { groupId: 'agent', icon: Wrench, id: 'skills', label: t => t.commandCenter.nav.skills.title },
    <SkillsView tabParam={CAPABILITIES_TAB_PARAM} />
  ),
  // Owner rule: the pane is called 'message' (the window it configures).
  { ...configPane('chat', 'agent'), label: t => t.settings.nav.message },
  // V3-F: the five permission modes, the grants and the audit trail — main is the authority, this is its view.
  {
    groupId: 'agent',
    icon: codiconIcon('shield'),
    id: 'permissions',
    keywords: t => [t.settings.permissions.modes.ignore.name, t.settings.permissions.modes.plan.name, 'yolo'],
    label: t => t.settings.nav.permissions,
    render: () => <PermissionsPane />
  },
  configPane('safety', 'agent'),
  configPane('workspace', 'agent'),
  configPane('browser', 'agent'),
  {
    groupId: 'agent',
    icon: PanelLeftIcon,
    id: 'sessions-bots',
    // Owner rule: the old left sidebar (sessions + bots) lives here now.
    label: t => t.settings.nav.sessionsBots,
    render: () => <SessionsBotsSettings />
  },
  {
    groupId: 'agent',
    icon: Archive,
    id: 'sessions',
    label: t => t.settings.nav.archivedChats,
    render: () => <SessionsSettings />
  },
  // Command Center — moved WHOLE by the owner's order,
  // dashboard included. It sits immediately below `sessions` ("Archived
  // chats") on purpose: the two surfaces touch the same noun from opposite
  // ends — live sessions here, archived sessions and the retention config
  // there — and the rail has to show that at a glance rather than hide one of
  // them in another group. Neither loses a control (front K5's before/after
  // count: 5 live-session controls here, 6 archive/config controls there, one
  // overlapping verb on two disjoint sets).
  pagePane(
    {
      groupId: 'agent',
      icon: Command,
      id: 'command-center',
      label: t => t.commandCenter.commandCenter
    },
    <CommandCenterPane />
  ),
  configPane('advanced', 'agent'),

  // Economy
  {
    groupId: 'economy',
    icon: Package,
    id: 'inft',
    // Owner's proper noun.
    label: () => 'iNFT',
    render: () => <InftSettings />
  },
  pagePane(
    {
      groupId: 'economy',
      icon: Bookmark,
      id: 'inft-book',
      keywords: t => t.inftBook.keywords,
      label: t => t.inftBook.navLabel
    },
    <InftBookView />
  ),
  {
    groupId: 'economy',
    icon: Cpu,
    id: 'economyos',
    label: t => t.settings.economyOS.navLabel,
    render: ctx => (
      <SettingsContent>
        <ListRow description={ctx.t.settings.economyOS.description} title={ctx.t.settings.economyOS.title} />
        <InftSetupPane navigate={ctx.navigate} onClose={ctx.onClose} />
      </SettingsContent>
    )
  },
  // V3-J: the per-user payment caps, the hard stop, who agents may pay, and the mandates (main is the authority).
  {
    groupId: 'economy',
    icon: CreditCard,
    id: 'payments',
    keywords: t => paymentsCopyFor(t).keywords,
    label: t => paymentsCopyFor(t).navLabel,
    render: () => <PaymentsPane />
  },
  {
    groupId: 'economy',
    icon: BarChart3,
    id: 'billing',
    label: t => t.settings.nav.billing,
    render: () => <BillingSettings />
  },

  // Machine
  {
    // V3-P: the pet library lives in Appearance; this link lands on it.
    children: ctx => [
      {
        active: false,
        icon: PawPrint,
        id: 'aview:pet',
        label: ctx.t.settings.appearance.pet.title,
        onSelect: () => {
          ctx.onNavigateView('config:appearance')
          revealPetSettings()
        }
      }
    ],
    groupId: 'machine',
    icon: APPEARANCE_SECTION.icon,
    id: 'config:appearance',
    label: t => t.settings.sections.appearance ?? APPEARANCE_SECTION.label,
    render: () => <AppearanceSettings />
  },
  {
    groupId: 'machine',
    icon: Zap,
    id: 'hud',
    // Owner's proper noun — the floating HUD window and its knobs.
    label: () => 'HUD',
    render: ctx => <HudSettings navigate={ctx.navigate} />
  },
  {
    groupId: 'machine',
    icon: Bell,
    id: 'notifications',
    label: t => t.settings.nav.notifications,
    render: () => <NotificationsSettings />
  },
  {
    groupId: 'machine',
    icon: Keyboard,
    id: 'keybinds',
    keywords: t => t.settings.search.keybindWords,
    label: t => t.settings.nav.keybinds,
    render: () => <KeybindSettings />
  },
  {
    groupId: 'machine',
    icon: Terminal,
    id: 'it-terminal',
    label: () => 'iT',
    render: () => (
      <SettingsContent>
        <ItTerminalSettings />
      </SettingsContent>
    )
  },
  {
    groupId: 'machine',
    icon: Globe,
    id: 'gateway',
    label: t => t.settings.nav.gateway,
    render: () => <GatewaySettings />
  },
  {
    groupId: 'machine',
    icon: Package,
    id: 'plugins',
    label: t => t.settings.nav.plugins,
    render: () => <PluginsSettings />
  },
  {
    groupId: 'machine',
    icon: UpdatesNavIcon,
    id: 'updates',
    label: t => t.settings.nav.updates,
    render: ctx => <AppAtualisationSettings navigate={ctx.navigate} onClose={ctx.onClose} />
  },
  // V3-ON: the first-launch Set up choices (packages, system permissions, agent levels), any time.
  {
    groupId: 'machine',
    icon: codiconIcon('checklist'),
    id: 'setup',
    label: t => t.settings.nav.setup,
    render: ctx => (
      <Suspense fallback={null}>
        <SetupSettings navigate={ctx.navigate} />
      </Suspense>
    )
  },
  {
    groupId: 'machine',
    icon: codiconIcon('pulse'),
    id: 'diagnostics',
    label: t => t.settings.nav.diagnostics,
    render: ctx => <DiagnosticsSettings navigate={ctx.navigate} />
  },
  {
    groupId: 'machine',
    icon: Info,
    id: 'about',
    label: t => t.settings.nav.about,
    render: () => <AboutSettings />
  }
]

// Legacy tab ids kept alive for old deep links/bookmarks, resolved to a real
// pane instead of appearing as their own nav row (redirected in index.tsx):
//  - `connections` merged into `gateway`;
//  - `app-atualisation` was the Updates pane's id (U4-p2b-09).
//  - `?tab=mcp` is rewritten to the Capabilities pane with its MCP tab
//    (`?tab=skills&cview=mcp`) before routing ever reaches this list (see the
//    effect in index.tsx) — it no longer leaves Settings (front K2).
export const SETTINGS_VIEW_ALIASES: Readonly<Partial<Record<string, SettingsPaneId>>> = {
  'app-atualisation': 'updates',
  connections: 'gateway'
}

export const SETTINGS_VIEWS: readonly SettingsPaneId[] = [
  ...SETTINGS_PANES.map(pane => pane.id),
  ...(Object.keys(SETTINGS_VIEW_ALIASES) as SettingsPaneId[])
]

/** The pane a legacy alias stands for; a real pane id is itself. */
function resolveSettingsPaneId(id: string): string {
  return SETTINGS_VIEW_ALIASES[id] ?? id
}

/** The group a pane (or a legacy alias of one) lives in. */
export function settingsGroupOf(id: string): SettingsGroupId | undefined {
  const effectiveId = resolveSettingsPaneId(id)

  return SETTINGS_PANES.find(pane => pane.id === effectiveId)?.groupId
}

/** One door of the Settings landing: a group, its label, and the pane the
 *  door opens (the group's first, in rail order). */
export interface SettingsGroupDoor {
  id: SettingsGroupId
  label: string
  sentence: string
  firstPane: SettingsPaneId
}

export function settingsGroupDoors(t: Translations): SettingsGroupDoor[] {
  return SETTINGS_GROUPS.flatMap(group => {
    const first = SETTINGS_PANES.find(pane => pane.groupId === group.id)

    return first
      ? [
          {
            firstPane: first.id,
            id: group.id,
            label: t.settings.groups[group.id] ?? group.fallbackLabel,
            sentence: t.settings.landing[group.id]
          }
        ]
      : []
  })
}

/** One row per pane for the Settings search (tester U2-p2b-03): its name,
 *  its group's name and its door (`?tab=`), in rail order. */
interface SettingsPaneSearchRow {
  group: string
  icon: IconComponent
  id: SettingsPaneId
  keywords?: readonly string[]
  label: string
}

export function settingsPaneSearchRows(t: Translations): SettingsPaneSearchRow[] {
  return SETTINGS_PANES.map(pane => ({
    group: t.settings.groups[pane.groupId] ?? SETTINGS_GROUP_BY_ID.get(pane.groupId)?.fallbackLabel ?? pane.groupId,
    icon: pane.icon,
    id: pane.id,
    keywords: pane.keywords?.(t),
    label: pane.label(t)
  }))
}

/** Builds the OverlayNav rows: one disclosure heading per group, followed by
 *  its panes, in SETTINGS_PANES order. On the landing (`landing`) no row is
 *  active: no pane is painted, so none is current. */
export function buildSettingsNavRows(
  ctx: SettingsPaneContext,
  disclosure: GroupDisclosure<SettingsGroupId>,
  landing = false
): (OverlayNavGroup | OverlayNavHeading)[] {
  const rows: (OverlayNavGroup | OverlayNavHeading)[] = []
  let lastGroup: SettingsGroupId | null = null

  for (const pane of SETTINGS_PANES) {
    if (pane.groupId !== lastGroup) {
      lastGroup = pane.groupId

      const group = SETTINGS_GROUP_BY_ID.get(pane.groupId)

      if (group) {
        rows.push({
          disclosure: {
            expanded: disclosure.expanded.has(group.id),
            onToggle: () => disclosure.toggle(group.id)
          },
          id: `group:${group.id}`,
          kind: 'heading',
          label: ctx.t.settings.groups[group.id] ?? group.fallbackLabel
        })
      }
    }

    rows.push({
      active: !landing && ctx.activeView === pane.id,
      children: pane.children?.(ctx),
      icon: pane.icon,
      id: pane.id,
      label: pane.label(ctx.t),
      onSelect: () => ctx.onNavigateView(pane.id)
    })
  }

  return rows
}

/** The view switch, data-driven from SETTINGS_PANES. A legacy alias is resolved
 *  here too (not a nav row) so the frame before its redirect effect lands
 *  doesn't flash the wrong pane. */
export function renderSettingsPane(ctx: SettingsPaneContext): ReactNode {
  const effectiveId = resolveSettingsPaneId(ctx.activeView)
  const pane = SETTINGS_PANES.find(p => p.id === effectiveId)

  return pane ? pane.render(ctx) : <SessionsSettings />
}
