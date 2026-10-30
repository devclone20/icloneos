export type WebhooksTranslations = {
  search: string
  loading: string
  loadFailed: string
  subscriptions: (count: number) => string
  hint: string
  empty: string
  disabledTitle: string
  disabledBody: string
  enable: string
  enabling: string
  enabled: (name: string) => string
  disabled: (name: string) => string
  enableRow: string
  disableRow: string
  delete: string
  deleting: string
  deleted: string
  deleteTitle: string
  deleteDescPrefix: string
  deleteDescSuffix: string
  deleteFailed: (name: string) => string
  toggleFailed: (name: string, enabled: boolean) => string
  newSubscription: string
  restarting: string
  restartNeeded: string
  restartGateway: string
  restartingGateway: string
  restartFailed: (detail: string) => string
  enabledRestarting: string
  all: string
  deliverOnly: string
  createdTitle: string
  createdSecretHint: string
  webhookUrl: string
  secretOnce: string
  done: string
  fieldName: string
  fieldNamePlaceholder: string
  fieldDescription: string
  fieldDescriptionPlaceholder: string
  fieldEvents: string
  fieldEventsPlaceholder: string
  fieldSkills: string
  fieldSkillsPlaceholder: string
  fieldDeliver: string
  fieldDeliverOnly: string
  fieldPrompt: string
  fieldPromptPlaceholder: string
  nameRequired: string
  create: string
  creating: string
  created: string
  createFailed: (detail: string) => string
  copy: string
  deliverOptions: Record<string, string>
}
