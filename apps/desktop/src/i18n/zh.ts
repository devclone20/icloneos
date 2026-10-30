import type { Translations } from './types'
import { acpTools } from './zh/acpTools'
import { agents } from './zh/agents'
import { artifactCard } from './zh/artifactCard'
import { artifactPreview } from './zh/artifactPreview'
import { artifacts } from './zh/artifacts'
import { assistant } from './zh/assistant'
import { backgroundTasks } from './zh/backgroundTasks'
import { bank } from './zh/bank'
import { billingBlock } from './zh/billingBlock'
import { boot } from './zh/boot'
import { commandCenter } from './zh/commandCenter'
import { common } from './zh/common'
import { composer } from './zh/composer'
import { contextMenu } from './zh/contextMenu'
import { cron } from './zh/cron'
import { desktop } from './zh/desktop'
import { errors } from './zh/errors'
import { fileMenu } from './zh/fileMenu'
import { findInPage } from './zh/findInPage'
import { inftBook } from './zh/inftBook'
import { install } from './zh/install'
import { keybinds } from './zh/keybinds'
import { language } from './zh/language'
import { messaging } from './zh/messaging'
import { modelPicker } from './zh/modelPicker'
import { modelVisibility } from './zh/modelVisibility'
import { notifications } from './zh/notifications'
import { onboarding } from './zh/onboarding'
import { payments } from './zh/payments'
import { preview } from './zh/preview'
import { profiles } from './zh/profiles'
import { prompts } from './zh/prompts'
import { remoteDisplayBanner } from './zh/remoteDisplayBanner'
import { rightSidebar } from './zh/rightSidebar'
import { sendDiagnostics } from './zh/sendDiagnostics'
import { settings } from './zh/settings'
import { shell } from './zh/shell'
import { sidebar } from './zh/sidebar'
import { skills } from './zh/skills'
import { slash } from './zh/slash'
import { starmap } from './zh/starmap'
import { statusStack } from './zh/statusStack'
import { titlebar } from './zh/titlebar'
import { ui } from './zh/ui'
import { updates } from './zh/updates'
import { webhooks } from './zh/webhooks'
import { zhAgentUpdate } from './zh/zhAgentUpdate'
import { zones } from './zh/zones'

export const zh: Translations = {
  common,
  fileMenu,
  boot,
  notifications,
  remoteDisplayBanner,
  billingBlock,
  sendDiagnostics,
  titlebar,
  keybinds,
  findInPage,
  language,
  settings,
  skills,
  starmap,
  agents,
  commandCenter,
  messaging,
  webhooks,
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
}

export { zhAgentUpdate }
