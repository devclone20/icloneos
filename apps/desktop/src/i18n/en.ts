import { acpTools } from './en/acpTools'
import { agents } from './en/agents'
import { artifactCard } from './en/artifactCard'
import { artifactPreview } from './en/artifactPreview'
import { artifacts } from './en/artifacts'
import { assistant } from './en/assistant'
import { backgroundTasks } from './en/backgroundTasks'
import { bank } from './en/bank'
import { billingBlock } from './en/billingBlock'
import { boot } from './en/boot'
import { commandCenter } from './en/commandCenter'
import { common } from './en/common'
import { composer } from './en/composer'
import { contextMenu } from './en/contextMenu'
import { cron } from './en/cron'
import { desktop } from './en/desktop'
import { enAgentUpdate } from './en/enAgentUpdate'
import { enConsent } from './en/enConsent'
import { enCredentialRemoval } from './en/enCredentialRemoval'
import { enCustomEndpoints } from './en/enCustomEndpoints'
import { enDiagnostics } from './en/enDiagnostics'
import { enEngine } from './en/enEngine'
import { enProviderKeyPaths } from './en/enProviderKeyPaths'
import { enSkills } from './en/enSkills'
import { errors } from './en/errors'
import { fileMenu } from './en/fileMenu'
import { findInPage } from './en/findInPage'
import { inftBook } from './en/inftBook'
import { install } from './en/install'
import { keybinds } from './en/keybinds'
import { language } from './en/language'
import { messaging } from './en/messaging'
import { modelPicker } from './en/modelPicker'
import { modelVisibility } from './en/modelVisibility'
import { notifications } from './en/notifications'
import { onboarding } from './en/onboarding'
import { payments } from './en/payments'
import { preview } from './en/preview'
import { profiles } from './en/profiles'
import { prompts } from './en/prompts'
import { remoteDisplayBanner } from './en/remoteDisplayBanner'
import { rightSidebar } from './en/rightSidebar'
import { sendDiagnostics } from './en/sendDiagnostics'
import { settings } from './en/settings'
import { shell } from './en/shell'
import { sidebar } from './en/sidebar'
import { skills } from './en/skills'
import { slash } from './en/slash'
import { starmap } from './en/starmap'
import { statusStack } from './en/statusStack'
import { titlebar } from './en/titlebar'
import { ui } from './en/ui'
import { updates } from './en/updates'
import { webhooks } from './en/webhooks'
import { zones } from './en/zones'
import type { Translations } from './types'

export const en: Translations = {
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

export {
  enAgentUpdate,
  enConsent,
  enCredentialRemoval,
  enCustomEndpoints,
  enDiagnostics,
  enEngine,
  enProviderKeyPaths,
  enSkills
}

export type AgentUpdateCopy = typeof enAgentUpdate
