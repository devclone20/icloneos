/**
 * Words a translated locale may keep exactly as English writes them (the locale parity gate's `untranslated` rule).
 *
 * Only brand, product, protocol and platform names, code, commands and units belong here — the owner's terms stay in
 * English in every language — plus words spelled the same in the locale ("Terminal", "Manual" in Portuguese). A value
 * every other translated locale (zh, zh-hant, ja, ar) also keeps in English is accepted without an entry. Anything
 * else copied from English is an oversight the gate names.
 */

/** Exact values (whole string, trimmed) that are names or terms, not sentences. */
export const KEPT_IN_ENGLISH: ReadonlySet<string> = new Set<string>([
  // Product, platform and feature names.
  'iclone os',
  'Dock',
  'Kanban',
  'YOLO',
  'Telegram',
  'Discord',
  'Slack',
  // Protocol and engineering terms the app keeps in every language.
  'URL',
  'URL…',
  'https://example.com/post',
  'Gateway',
  'Gateways',
  'Webhooks',
  // Spelled the same in European Portuguese.
  'Local',
  'Manual',
  'Terminal',
  'Web',
  'natural',
  'iclone natural',
  // Loanwords European Portuguese writes as they are (a state badge in ACP Market › Work).
  'Online',
  'Offline'
])

/** `bank:path` entries kept in English as a whole, each with its reason. */
export const KEPT_IN_ENGLISH_AT: ReadonlySet<string> = new Set<string>([
  // A version badge in the narrow status bar: the engineering term and the version argument.
  'catalog:shell.statusbar.backendVersion',
  'catalog:shell.statusbar.backendLabel',
  // A git term and the commit sha.
  'catalog:shell.statusbar.commit',
  // Two counts and the unit "tokens", the technical term European Portuguese keeps (found by the case-folded check).
  'catalog:shell.statusbar.contextUsagePanel.tokenSummary',
  // Prints only a number and the unit (s / min).
  'agentUpdate:tookSeconds',
  // A product name and its platform (the Containers pane's mechanism row).
  'confinement:backendName.seatbelt',
  // Prints only a number and the unit (s / m / h).
  'confinement:elapsed'
])

/** `bank:path` groups that are open maps: a locale may name more entries than English does. */
export const OPEN_GROUPS: ReadonlySet<string> = new Set<string>([
  // The consent sheet's switch names: English defers to the policy's §9 table, every translated bank names each row
  // itself (components/consent/rows.ts reads the bank's own name first).
  'consent:rows'
])
