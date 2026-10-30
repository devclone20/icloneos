import type { Translations } from '../types'

export const starmap: Translations['starmap'] = {
  title: 'Memory Graph',
  subtitle: (nodes, clusters) => `${nodes} skills across ${clusters} categories`,
  close: 'Close memory graph',
  refresh: 'Refresh',
  memory: 'Memory',
  filterAll: 'All',
  filterUsed: 'Used',
  filterLearned: 'Learned',
  viewGraph: 'Graph',
  loadFailed: 'Could not load memory graph',
  loading: 'Loading…',
  emptyTitle: 'Nothing learned yet',
  emptyDesc: 'As the agent builds skills and memories for your work, they appear here.',
  share: 'Share map',
  shareHint:
    'Copy the code to share this map, or paste one to load. It only includes the layout, not your memory or skill text.',
  shareTitle: 'Import / export map',
  sharePlaceholder: 'Paste a map code…',
  copy: 'Copy map code',
  copied: 'Copied!',
  importMap: 'Import a map',
  importBtn: 'Load',
  importEmpty: 'Paste a map code to load it.',
  importSuccess: nodes => `Loaded a map with ${nodes} ${nodes === 1 ? 'node' : 'nodes'}.`,
  importedBadge: 'imported map',
  resetToMine: 'Back to my map'
}
