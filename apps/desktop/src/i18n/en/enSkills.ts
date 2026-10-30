// R14 — Settings → Skills (the app's playbook catalog and every other skill the agent can open).
export const enSkills = {
  navLabel: 'Skills',
  title: 'Skills',
  description: 'Every agent sees one line per skill and opens a skill only when the task matches it.',
  groups: { iclone: 'icloneOS', upstream: 'Upstream', learned: 'Learned', hub: 'Hub' },
  badges: { iclone: 'icloneOS', upstream: 'upstream', learned: 'learned', hub: 'hub' },
  counts: (iclone: number, upstream: number, learned: number, hub: number) =>
    `${iclone} icloneOS · ${upstream} upstream · ${learned} learned · ${hub} hub`,
  lastSync: (when: string) => `Last sync ${when}`,
  neverSynced: 'Not synced yet',
  justNow: 'just now',
  minutesAgo: (n: number) => `${n} min ago`,
  hoursAgo: (n: number) => `${n} h ago`,
  resync: 'Re-sync',
  resyncing: 'Syncing…',
  resyncUnchanged: 'Every skills tree already holds this version.',
  resyncWritten: (n: number) =>
    `${n} ${n === 1 ? 'file' : 'files'} updated. The agent reads skills when its backend starts — restart it to apply.`,
  resyncFailed: (error: string) => `Sync failed: ${error}`,
  restart: 'Restart agent',
  restarting: 'Restarting…',
  restarted: 'Agent restarted with the new skills.',
  restartFailed: (error: string) => `Restart failed: ${error}`,
  search: 'Search skills',
  empty: 'No skill matches.',
  loadFailed: 'Skills could not be read from the agent.',
  notTaught: 'Not taught yet — Re-sync',
  hiddenOnHost: (host: string, only: string) => `Hidden on ${host} — ${only} only`,
  frontmatterUnreadable: (message: string) => `Frontmatter unreadable — ${message}`,
  open: 'Open',
  toggle: (name: string) => `Enable ${name}`,
  warnTitle: (name: string) => `Turn off ${name}?`,
  warnBody: (name: string) =>
    `The app's runtime instructions tell every iNFT to open ${name}. Off, the agent cannot follow them.`,
  warnConfirm: 'Turn off',
  warnCancel: 'Keep on',
  offRuntime: (name: string) =>
    `${name} is off, but the app's runtime instructions still tell every iNFT to open it. Turn it back on.`,
  offRelated: (name: string, neededBy: readonly string[]) =>
    `${name} is off, but ${neededBy.join(', ')} ${neededBy.length === 1 ? 'points' : 'point'} agents to it.`,
  offUntaught: (name: string) =>
    `${name} is not in the agents' skills yet, but the app's runtime instructions tell every iNFT to open it. Re-sync.`,
  offSummary: (names: readonly string[]) =>
    `${names.length === 1 ? 'A skill' : `${names.length} skills`} the agents rely on ${names.length === 1 ? 'is' : 'are'} off or missing: ${names.join(', ')}.`,
  sheetMeta: (path: string, bytes: number, version?: string) =>
    [path, `${bytes.toLocaleString('en-US')} B`, version ? `v${version}` : ''].filter(Boolean).join(' · '),
  sheetLoading: 'Loading…',
  sheetFailed: 'This skill could not be read.'
}
