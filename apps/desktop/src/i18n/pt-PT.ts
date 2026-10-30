// European Portuguese (pt-PT), the sixth catalogue (decision 11, front V3-T). Every key of the English catalogue is
// written here; `defineLocale` keeps the English fallback only for keys a later front adds before its pt-PT top-up,
// and the locale parity gate (src/i18n/parity) names each of those.
import { defineLocale } from './define-locale'
import { acpTools } from './pt-PT/acpTools'
import { agents } from './pt-PT/agents'
import { artifactCard } from './pt-PT/artifactCard'
import { artifactPreview } from './pt-PT/artifactPreview'
import { artifacts } from './pt-PT/artifacts'
import { assistant } from './pt-PT/assistant'
import { backgroundTasks } from './pt-PT/backgroundTasks'
import { bank } from './pt-PT/bank'
import { billingBlock } from './pt-PT/billingBlock'
import { boot } from './pt-PT/boot'
import { commandCenter } from './pt-PT/commandCenter'
import { common } from './pt-PT/common'
import { composer } from './pt-PT/composer'
import { contextMenu } from './pt-PT/contextMenu'
import { cron } from './pt-PT/cron'
import { desktop } from './pt-PT/desktop'
import { errors } from './pt-PT/errors'
import { fileMenu } from './pt-PT/fileMenu'
import { findInPage } from './pt-PT/findInPage'
import { inftBook } from './pt-PT/inftBook'
import { install } from './pt-PT/install'
import { keybinds } from './pt-PT/keybinds'
import { language } from './pt-PT/language'
import { messaging } from './pt-PT/messaging'
import { modelPicker } from './pt-PT/modelPicker'
import { modelVisibility } from './pt-PT/modelVisibility'
import { notifications } from './pt-PT/notifications'
import { onboarding } from './pt-PT/onboarding'
import { payments } from './pt-PT/payments'
import { preview } from './pt-PT/preview'
import { profiles } from './pt-PT/profiles'
import { prompts } from './pt-PT/prompts'
import { ptPtAgentUpdate } from './pt-PT/ptPtAgentUpdate'
import { remoteDisplayBanner } from './pt-PT/remoteDisplayBanner'
import { rightSidebar } from './pt-PT/rightSidebar'
import { sendDiagnostics } from './pt-PT/sendDiagnostics'
import { settings } from './pt-PT/settings'
import { shell } from './pt-PT/shell'
import { sidebar } from './pt-PT/sidebar'
import { skills } from './pt-PT/skills'
import { slash } from './pt-PT/slash'
import { starmap } from './pt-PT/starmap'
import { statusStack } from './pt-PT/statusStack'
import { titlebar } from './pt-PT/titlebar'
import { ui } from './pt-PT/ui'
import { updates } from './pt-PT/updates'
import { webhooks } from './pt-PT/webhooks'
import { zones } from './pt-PT/zones'

export const ptPt = defineLocale({
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
  updates,
  install,
  onboarding,
  modelPicker,
  modelVisibility,
  shell,
  rightSidebar,
  preview,
  zones,
  contextMenu,
  assistant,
  prompts,
  desktop,
  errors,
  bank,
  inftBook,
  payments,
  acpTools,
  ui,
  backgroundTasks,
  slash
})

export { ptPtAgentUpdate }
