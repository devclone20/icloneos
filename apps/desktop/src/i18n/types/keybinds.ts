export type KeybindsTranslations = {
  title: string
  subtitle: (open: string) => string
  search: string
  rebind: string
  reset: string
  resetAll: string
  pressKey: string
  set: string
  conflictWith: (label: string) => string
  categories: Record<string, string>
  actions: Record<string, string>
}
