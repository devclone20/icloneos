import { defineLocale } from './define-locale'
import { acpTools } from './zh-hant/acpTools'
import { agents } from './zh-hant/agents'
import { artifactCard } from './zh-hant/artifactCard'
import { artifactPreview } from './zh-hant/artifactPreview'
import { artifacts } from './zh-hant/artifacts'
import { assistant } from './zh-hant/assistant'
import { backgroundTasks } from './zh-hant/backgroundTasks'
import { bank } from './zh-hant/bank'
import { billingBlock } from './zh-hant/billingBlock'
import { boot } from './zh-hant/boot'
import { commandCenter } from './zh-hant/commandCenter'
import { common } from './zh-hant/common'
import { composer } from './zh-hant/composer'
import { contextMenu } from './zh-hant/contextMenu'
import { cron } from './zh-hant/cron'
import { desktop } from './zh-hant/desktop'
import { errors } from './zh-hant/errors'
import { fileMenu } from './zh-hant/fileMenu'
import { inftBook } from './zh-hant/inftBook'
import { install } from './zh-hant/install'
import { keybinds } from './zh-hant/keybinds'
import { language } from './zh-hant/language'
import { messaging } from './zh-hant/messaging'
import { modelPicker } from './zh-hant/modelPicker'
import { modelVisibility } from './zh-hant/modelVisibility'
import { notifications } from './zh-hant/notifications'
import { onboarding } from './zh-hant/onboarding'
import { payments } from './zh-hant/payments'
import { preview } from './zh-hant/preview'
import { profiles } from './zh-hant/profiles'
import { prompts } from './zh-hant/prompts'
import { remoteDisplayBanner } from './zh-hant/remoteDisplayBanner'
import { rightSidebar } from './zh-hant/rightSidebar'
import { sendDiagnostics } from './zh-hant/sendDiagnostics'
import { settings } from './zh-hant/settings'
import { shell } from './zh-hant/shell'
import { sidebar } from './zh-hant/sidebar'
import { skills } from './zh-hant/skills'
import { slash } from './zh-hant/slash'
import { starmap } from './zh-hant/starmap'
import { statusStack } from './zh-hant/statusStack'
import { titlebar } from './zh-hant/titlebar'
import { ui } from './zh-hant/ui'
import { updates } from './zh-hant/updates'
import { zhHantAgentUpdate } from './zh-hant/zhHantAgentUpdate'
import { zones } from './zh-hant/zones'

export const zhHant = defineLocale({
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

export { zhHantAgentUpdate }
