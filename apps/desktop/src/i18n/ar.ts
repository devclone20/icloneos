import { acpTools } from './ar/acpTools'
import { agents } from './ar/agents'
import { arAgentUpdate } from './ar/arAgentUpdate'
import { artifactCard } from './ar/artifactCard'
import { artifactPreview } from './ar/artifactPreview'
import { artifacts } from './ar/artifacts'
import { assistant } from './ar/assistant'
import { backgroundTasks } from './ar/backgroundTasks'
import { bank } from './ar/bank'
import { boot } from './ar/boot'
import { commandCenter } from './ar/commandCenter'
import { common } from './ar/common'
import { composer } from './ar/composer'
import { contextMenu } from './ar/contextMenu'
import { cron } from './ar/cron'
import { desktop } from './ar/desktop'
import { errors } from './ar/errors'
import { fileMenu } from './ar/fileMenu'
import { inftBook } from './ar/inftBook'
import { install } from './ar/install'
import { keybinds } from './ar/keybinds'
import { language } from './ar/language'
import { messaging } from './ar/messaging'
import { modelPicker } from './ar/modelPicker'
import { modelVisibility } from './ar/modelVisibility'
import { notifications } from './ar/notifications'
import { onboarding } from './ar/onboarding'
import { payments } from './ar/payments'
import { preview } from './ar/preview'
import { profiles } from './ar/profiles'
import { prompts } from './ar/prompts'
import { remoteDisplayBanner } from './ar/remoteDisplayBanner'
import { rightSidebar } from './ar/rightSidebar'
import { sendDiagnostics } from './ar/sendDiagnostics'
import { settings } from './ar/settings'
import { shell } from './ar/shell'
import { sidebar } from './ar/sidebar'
import { skills } from './ar/skills'
import { slash } from './ar/slash'
import { statusStack } from './ar/statusStack'
import { titlebar } from './ar/titlebar'
import { ui } from './ar/ui'
import { updates } from './ar/updates'
import { zones } from './ar/zones'
import { defineLocale } from './define-locale'

export const ar = defineLocale({
  sendDiagnostics,
  common,
  fileMenu,
  boot,
  notifications,
  remoteDisplayBanner,
  titlebar,
  keybinds,
  language,
  settings,
  skills,
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

export { arAgentUpdate }
