// Desktop i18n type contract.
//
// `Translations` is the single source of truth for every translatable string
// surface. Fully translated locale files may satisfy this interface directly;
// partial locales should use `defineLocale()` so missing desktop-only strings
// fall back to English while new keys remain type-checked.

import type { AcpToolsTranslations } from './types/acpTools'
import type { AgentsTranslations } from './types/agents'
import type { ArtifactCardTranslations } from './types/artifactCard'
import type { ArtifactPreviewTranslations } from './types/artifactPreview'
import type { ArtifactsTranslations } from './types/artifacts'
import type { AssistantTranslations } from './types/assistant'
import type { BackgroundTasksTranslations } from './types/backgroundTasks'
import type { BankTranslations } from './types/bank'
import type { BillingBlockTranslations } from './types/billingBlock'
import type { BootTranslations } from './types/boot'
import type { CommandCenterTranslations } from './types/commandCenter'
import type { CommonTranslations } from './types/common'
import type { ComposerTranslations } from './types/composer'
import type { ContextMenuTranslations } from './types/contextMenu'
import type { CronTranslations } from './types/cron'
import type { DesktopTranslations } from './types/desktop'
import type { ErrorsTranslations } from './types/errors'
import type { FileMenuTranslations } from './types/fileMenu'
import type { FindInPageTranslations } from './types/findInPage'
import type { InftBookTranslations } from './types/inftBook'
import type { InstallTranslations } from './types/install'
import type { KeybindsTranslations } from './types/keybinds'
import type { LanguageTranslations } from './types/language'
import type { MessagingTranslations } from './types/messaging'
import type { ModelPickerTranslations } from './types/modelPicker'
import type { ModelVisibilityTranslations } from './types/modelVisibility'
import type { NotificationsTranslations } from './types/notifications'
import type { OnboardingTranslations } from './types/onboarding'
import type { PaymentsTranslations } from './types/payments'
import type { PreviewTranslations } from './types/preview'
import type { ProfilesTranslations } from './types/profiles'
import type { PromptsTranslations } from './types/prompts'
import type { RemoteDisplayBannerTranslations } from './types/remoteDisplayBanner'
import type { RightSidebarTranslations } from './types/rightSidebar'
import type { SendDiagnosticsTranslations } from './types/sendDiagnostics'
import type { SettingsTranslations } from './types/settings'
import type { ShellTranslations } from './types/shell'
import type { SidebarTranslations } from './types/sidebar'
import type { SkillsTranslations } from './types/skills'
import type { SlashTranslations } from './types/slash'
import type { StarmapTranslations } from './types/starmap'
import type { StatusStackTranslations } from './types/statusStack'
import type { TitlebarTranslations } from './types/titlebar'
import type { UiTranslations } from './types/ui'
import type { UpdatesTranslations } from './types/updates'
import type { WebhooksTranslations } from './types/webhooks'
import type { ZonesTranslations } from './types/zones'

export type Locale = 'en' | 'zh' | 'zh-hant' | 'ja' | 'ar' | 'pt-PT'

export type { ToolTitleKey } from './types/assistant'

export interface Translations {
  common: CommonTranslations
  fileMenu: FileMenuTranslations
  boot: BootTranslations
  notifications: NotificationsTranslations
  remoteDisplayBanner: RemoteDisplayBannerTranslations
  billingBlock: BillingBlockTranslations
  sendDiagnostics: SendDiagnosticsTranslations
  titlebar: TitlebarTranslations
  keybinds: KeybindsTranslations
  findInPage: FindInPageTranslations
  language: LanguageTranslations
  settings: SettingsTranslations
  skills: SkillsTranslations
  starmap: StarmapTranslations
  agents: AgentsTranslations
  commandCenter: CommandCenterTranslations
  messaging: MessagingTranslations
  webhooks: WebhooksTranslations
  profiles: ProfilesTranslations
  cron: CronTranslations
  artifacts: ArtifactsTranslations
  artifactCard: ArtifactCardTranslations
  artifactPreview: ArtifactPreviewTranslations
  sidebar: SidebarTranslations
  composer: ComposerTranslations
  statusStack: StatusStackTranslations
  backgroundTasks: BackgroundTasksTranslations
  updates: UpdatesTranslations
  install: InstallTranslations
  onboarding: OnboardingTranslations
  modelPicker: ModelPickerTranslations
  modelVisibility: ModelVisibilityTranslations
  shell: ShellTranslations
  rightSidebar: RightSidebarTranslations
  preview: PreviewTranslations
  zones: ZonesTranslations
  slash: SlashTranslations
  contextMenu: ContextMenuTranslations
  assistant: AssistantTranslations
  prompts: PromptsTranslations
  desktop: DesktopTranslations
  errors: ErrorsTranslations
  bank: BankTranslations
  inftBook: InftBookTranslations
  payments: PaymentsTranslations
  acpTools: AcpToolsTranslations
  ui: UiTranslations
}
