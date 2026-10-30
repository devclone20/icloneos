export type AgentsTranslations = {
  close: string
  title: string
  subtitle: string
  emptyTitle: string
  emptyDesc: string
  running: string
  failed: string
  done: string
  streaming: string
  files: string
  moreFiles: (count: number) => string
  delegation: (index: number) => string
  workers: (count: number) => string
  workersActive: (count: number) => string
  agentsCount: (count: number) => string
  activeCount: (count: number) => string
  failedCount: (count: number) => string
  toolsCount: (count: number) => string
  filesCount: (count: number) => string
  updatedAgo: (age: string) => string
  ageNow: string
  ageSeconds: (seconds: number) => string
  ageMinutes: (minutes: number) => string
  ageHours: (hours: number) => string
  ageDays: (days: number) => string
  durationSeconds: (seconds: string) => string
  durationMinutes: (minutes: number, seconds: number) => string
  tokens: (value: number | string) => string
}
