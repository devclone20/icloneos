export type UiTranslations = {
  search: {
    clear: string
  }
  pagination: {
    label: string
    previous: string
    previousAria: string
    next: string
    nextAria: string
  }
  sidebar: {
    title: string
    description: string
    toggle: (open: boolean) => string
  }
}
