// Row "workspace indexing / search, time per 100 k files, incremental update". The app keeps no workspace
// index (no indexer, no search store), so there is nothing to time: the row stays UNMEASURABLE and the part that does
// exist, the project tree's folder reader, is measured by `fs.read_dir` with its own budget.
export default {
  id: 'index.workspace',
  part: 'Workspace indexing / search',
  what: 'not timed: the app keeps no workspace index; the folder reader that does exist is the fs.read_dir row',
  hot_path: 'none in the app (grep for an indexer / search store finds none); see fs.read_dir',
  unit: 'ms',
  lang: 'TypeScript',
  miss_class: 'io',
  budget: {
    value: 10000,
    op: '<=',
    stat: 'cold.p95',
    reason:
      'a search over a 100 k-file project needs its index built in under 10 s cold, or the first search waits on ' +
      'it; kept for the day an index exists'
  },
  risk: 'anything that needs the whole workspace (search, quick-open) has no index to use and would walk the tree',
  failure_mode: 'not applicable: no index exists',
  // Static: the runner takes no window and calls neither measure nor control, in every mode.
  unmeasurable: 'no workspace index exists in the app; see fs.read_dir',
  async measure() {
    return { unmeasurable: this.unmeasurable }
  },
  async control() {
    throw new Error('index.workspace has no control: the row is unmeasurable')
  }
}
