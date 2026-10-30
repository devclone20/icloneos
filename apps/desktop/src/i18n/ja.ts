import { defineLocale } from './define-locale'
import { acpTools } from './ja/acpTools'
import { agents } from './ja/agents'
import { artifactCard } from './ja/artifactCard'
import { artifactPreview } from './ja/artifactPreview'
import { artifacts } from './ja/artifacts'
import { assistant } from './ja/assistant'
import { backgroundTasks } from './ja/backgroundTasks'
import { bank } from './ja/bank'
import { billingBlock } from './ja/billingBlock'
import { boot } from './ja/boot'
import { commandCenter } from './ja/commandCenter'
import { common } from './ja/common'
import { composer } from './ja/composer'
import { contextMenu } from './ja/contextMenu'
import { cron } from './ja/cron'
import { desktop } from './ja/desktop'
import { errors } from './ja/errors'
import { fileMenu } from './ja/fileMenu'
import { inftBook } from './ja/inftBook'
import { install } from './ja/install'
import { jaAgentUpdate } from './ja/jaAgentUpdate'
import { keybinds } from './ja/keybinds'
import { language } from './ja/language'
import { messaging } from './ja/messaging'
import { modelPicker } from './ja/modelPicker'
import { modelVisibility } from './ja/modelVisibility'
import { notifications } from './ja/notifications'
import { onboarding } from './ja/onboarding'
import { payments } from './ja/payments'
import { preview } from './ja/preview'
import { profiles } from './ja/profiles'
import { prompts } from './ja/prompts'
import { remoteDisplayBanner } from './ja/remoteDisplayBanner'
import { rightSidebar } from './ja/rightSidebar'
import { sendDiagnostics } from './ja/sendDiagnostics'
import { settings } from './ja/settings'
import { shell } from './ja/shell'
import { sidebar } from './ja/sidebar'
import { skills } from './ja/skills'
import { slash } from './ja/slash'
import { starmap } from './ja/starmap'
import { statusStack } from './ja/statusStack'
import { titlebar } from './ja/titlebar'
import { ui } from './ja/ui'
import { updates } from './ja/updates'
import { zones } from './ja/zones'

export const ja = defineLocale({
  common,
  fileMenu,
  boot,
  notifications,
  remoteDisplayBanner,
  billingBlock,
  sendDiagnostics,
  titlebar,
  language,
  keybinds,
  settings,
  skills,
  starmap,
  agents,
  commandCenter,
  messaging,
  profiles,
  cron,
  artifacts,
  artifactCard,
  artifactPreview,
  sidebar,
  composer,
  statusStack,
  backgroundTasks,
  updates,
  install,
  onboarding,
  modelPicker,
  modelVisibility,
  shell,
  rightSidebar,
  preview,
  zones,
  slash,
  contextMenu,
  assistant,
  prompts,
  desktop,
  errors,
  bank,
  inftBook,
  payments,
  acpTools,
  ui
})

export { jaAgentUpdate }
