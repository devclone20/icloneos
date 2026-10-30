/**
 * iCLONE OS — the ONE registry of every `iclone.*` localStorage key in the
 * renderer. Key strings are user data already on disk: never rename one
 * (there is no migration). Reads and writes go through upstream `@/lib/storage`.
 *
 * A key ending in `.` is a prefix: `perInft` prefixes are completed with the
 * iNFT slug (`slugForInft`), the others with the suffix named in `shape`.
 */
interface StorageKeySpec {
  readonly key: string
  /** The stored text, as its readers parse it. */
  readonly shape: string
  readonly perInft: boolean
  /** The file(s) that read and write it. */
  readonly owner: string
}

export const ICLONE_STORAGE = {
  collectionsOrder: {
    key: 'iclone.collections.order',
    shape: 'JSON string[] of card ids',
    perInft: false,
    owner: 'home/home-view.tsx, settings/inft-settings.tsx (reset)'
  },
  filesRoots: {
    key: 'iclone.files.roots',
    shape: 'JSON string[] of paths',
    perInft: false,
    owner: 'home/files-island.tsx'
  },
  inftBookChecked: {
    key: 'iclone.inftBook.checked.v1',
    shape: 'JSON { [wallet address, lowercase]: { ids: card id[], kept: number | null } }',
    perInft: false,
    owner: 'settings/inft-book/book-store.ts'
  },
  inftDeletedProfiles: {
    key: 'iclone.inft.deletedProfiles',
    shape: 'JSON string[] of profile slugs',
    perInft: false,
    owner: 'home/inft-profile.ts'
  },
  msgView: { key: 'iclone.msg.view', shape: "'chat' | 'it'", perInft: false, owner: 'home/it-store.ts' },
  itLayout: {
    key: 'iclone.it.layout.v3',
    shape: 'JSON {activeId, workspaces} — the one iT surface and its pane layouts',
    perInft: false,
    owner: 'home/it-store.ts'
  },
  /** Legacy (read-only): a multi-window file, merged into the one surface when v3 is absent. */
  itLayoutV2: {
    key: 'iclone.it.layout.v2',
    shape: 'JSON iT instances + pane layouts (legacy)',
    perInft: false,
    owner: 'home/it-store.ts'
  },
  /** Legacy (read-only): loaded when v3 and v2 are absent, never rewritten. */
  itLayoutV1: {
    key: 'iclone.it.layout.v1',
    shape: 'JSON pane layout (legacy)',
    perInft: false,
    owner: 'home/it-store.ts'
  },

  gpuAcceleration: {
    key: 'iclone.gpu.acceleration',
    shape: "'auto' | 'on' | 'off'",
    perInft: false,
    owner: 'home/gpu-lease.ts'
  },
  itCwd: {
    key: 'iclone.it.cwd',
    shape: 'path',
    perInft: false,
    owner: 'settings/it-terminal-settings.tsx'
  },
  backgroundTasksLedger: {
    key: 'iclone.bgTasks.ledger',
    shape: 'JSON [{task, at}] of died/stopped background tasks, newest last, at most 50',
    perInft: false,
    owner: 'store/background-tasks.ts'
  },
  msgOpacity: { key: 'iclone.msgOpacity', shape: 'number', perInft: false, owner: 'home/opacity-slider.tsx' },
  inftLastSession: {
    // v2 (2026-10-17): v1 pointers could name a chat born under ANOTHER persona
    // (a switch adopted the chat on screen); they are ignored, never deleted.
    key: 'iclone.inft.lastSession.v2.',
    shape: '+ persona slug: stored session id',
    perInft: true,
    owner: 'home/inft-switch.ts'
  },
  privyLastSession: {
    key: 'iclone.privy.lastSession',
    shape: 'JSON { address, label } — public wallet identity, never a token',
    perInft: false,
    owner: 'home/privy-session.ts'
  },
  stageLastInft: {
    key: 'iclone.stage.lastInft',
    shape: "card id | 'hermes'",
    perInft: false,
    owner: 'home/stage-store.ts'
  },
  dockWindow: {
    key: 'iclone.dock.window',
    shape: 'EconKind — sessionStorage: survives a renderer reload, dies with the window',
    perInft: false,
    owner: 'settings/settings-window.tsx'
  },
  econSnapshot: { key: 'iclone.econ.snap.', shape: 'JSON snapshot', perInft: true, owner: 'home/econ/snapshot.ts' },
  econWalletView: {
    key: 'iclone.econ.wallet.view.',
    shape: 'JSON view state',
    perInft: true,
    owner: 'home/econ/wallet/wallet-view.ts'
  },
  economyLiveEnabled: {
    key: 'iclone.economyos.liveEnabled',
    shape: 'JSON boolean',
    perInft: false,
    owner: 'home/econ/prefs.ts'
  },
  economyLiveIntervalSecs: {
    key: 'iclone.economyos.liveIntervalSecs',
    shape: 'JSON number',
    perInft: false,
    owner: 'home/econ/prefs.ts'
  },
  emailState: {
    key: 'iclone.email.state.',
    shape: 'JSON mailbox state',
    perInft: true,
    owner: 'home/econ/email/email-state.ts'
  },
  hyperliquidFavourites: {
    key: 'iclone.hl.favs.',
    shape: 'JSON string[] of symbols',
    perInft: true,
    owner: 'home/econ/hyperliquid/hyperliquid-data.ts'
  },
  marketRecent: { key: 'iclone.market.recent.', shape: 'JSON recent list', perInft: true, owner: 'home/econ/market' },
  marketParams: { key: 'iclone.market.params.', shape: 'JSON params', perInft: true, owner: 'home/econ/market' },
  marketJobsTab: { key: 'iclone.market.jobs-tab.', shape: 'jobs tab id', perInft: true, owner: 'home/econ/market' },
  hudHoldMs: { key: 'iclone.hud.holdMs', shape: 'number', perInft: false, owner: 'hud/prefs.ts' },
  hudFrost: { key: 'iclone.hud.frost', shape: "'1' | '0'", perInft: false, owner: 'hud/prefs.ts' },
  hudClickThrough: { key: 'iclone.hud.clickThrough', shape: "'1' | '0'", perInft: false, owner: 'hud/prefs.ts' },
  // R12 — Claude Code engine (Settings → Engine, chat fallback banner)
  engineNousModel: {
    key: 'iclone.engine.nousModel',
    shape: 'model id string (the Nous model to restore on round trip)',
    perInft: false,
    owner: 'settings/engine-settings-model.ts'
  },
  engineFallbackSeen: {
    key: 'iclone.engine.fallbackSeen',
    shape: 'ISO timestamp of the last fallback banner dismissed',
    perInft: false,
    owner: 'chat/engine-fallback-banner.tsx'
  },
  // E3 wave 2 — the rebuilt Messaging and Profiles pages keep work in progress
  // across a reload. Secret VALUES are never stored; `droppedSecrets` holds the
  // KEY NAMES the draft refused to keep, which is public platform schema.
  messagingEnvDrafts: {
    key: 'iclone.messaging.envDrafts',
    shape: 'JSON {"<profile>:<platform>": {at, fields, droppedSecrets?}} of non-secret setup edits',
    perInft: false,
    owner: 'messaging/env-draft.ts'
  },
  profilesSoulDrafts: {
    key: 'iclone.profiles.soulDrafts',
    shape: 'JSON {profile: {at, base, text}} of unsaved soul-editor text',
    perInft: false,
    owner: 'profiles/soul-draft.ts'
  }
} as const satisfies Record<string, StorageKeySpec>
