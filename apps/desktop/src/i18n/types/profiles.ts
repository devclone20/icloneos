export type ProfilesTranslations = {
  close: string
  nameHint: string
  title: string
  count: (count: number) => string
  search: string
  loading: string
  newProfile: string
  importProfile: string
  exportProfile: string
  imported: string
  exported: string
  failedImport: string
  failedExport: string
  allProfiles: string
  showAllProfiles: string
  switchToProfile: (name: string) => string
  switchToConnection: (name: string) => string
  switchConnectionFailed: (name: string) => string
  manageProfiles: string
  connectGateway: string
  fleet: {
    allOnGateway: string
    gateway: (gateway: string) => string
    gatewayUnreachable: (gateway: string) => string
    onGateway: (name: string, gateway: string) => string
    switchTo: (name: string, gateway: string) => string
    deleteOn: (gateway: string) => string
  }
  remoteOverride: {
    menuItem: string
    badge: (host: string) => string
    title: (profile: string) => string
    description: string
    urlLabel: string
    urlPlaceholder: string
    urlInvalid: string
    tokenLabel: string
    tokenPlaceholder: string
    tokenSavedHint: string
    plainTextOptIn: string
    collisionWarning: (label: string) => string
    confirmTitle: string
    confirmNote: (profile: string, host: string) => string
    confirmBack: string
    connect: string
    connecting: string
    disconnect: string
    savedTitle: string
    savedMessage: (profile: string, host: string) => string
    removedTitle: string
    removedMessage: (profile: string) => string
    removeFailed: string
    authFailedTitle: string
    authFailedMessage: (profile: string, host: string) => string
    updateToken: string
  }
  actions: string
  color: string
  colorFor: string
  setColor: (color: string) => string
  autoColor: string
  noProfiles: string
  selectPrompt: string
  refresh: string
  refreshing: string
  default: string
  skills: (count: number) => string
  env: string
  defaultBadge: string
  /** Pill: the profile keeps keys of its own. */
  ownKeysBadge: string
  /** Under the profile's name: what a profile is, in place of its folder path. */
  ownSpaceHint: string
  rename: string
  renameMenu: string
  editSoul: string
  copySetup: string
  copying: string
  modelLabel: string
  skillsLabel: string
  notSet: string
  soulDesc: string
  soulOptional: string
  soulLabel: string
  soulPlaceholder: (mode: string) => string
  soulPlaceholderCloned: string
  soulPlaceholderEmpty: string
  unsavedChanges: string
  loadingSoul: string
  emptySoul: string
  saving: string
  saveSoul: string
  deleteDescPrefix: string
  deleteDescMid: string
  deleteDescSuffix: string
  deleting: string
  createDesc: string
  nameLabel: string
  cloneFrom: string
  cloneFromNone: string
  cloneFromDesc: string
  cloneFromDefault: string
  cloneFromDefaultDesc: string
  invalidName: (hint: string) => string
  nameRequired: string
  creating: string
  createAction: string
  displayNameTitle: string
  displayNameDesc: string
  displayNameLabel: string
  renameDescPrefix: string
  renameDescSuffix: string
  newNameLabel: string
  renaming: string
  created: string
  renamed: string
  deleted: string
  setupCopied: string
  soulSaved: string
  failedLoad: string
  failedDelete: string
  failedCopy: string
  failedLoadSoul: string
  failedSaveSoul: string
  failedCreate: string
  failedRename: string
  noMatch: (query: string) => string
  renameOf: (name: string) => string
  deleteOf: (name: string) => string
}
