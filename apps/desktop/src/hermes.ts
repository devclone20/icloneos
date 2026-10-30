// The desktop REST/WS client, split by domain under src/api/. This module is
// the compatibility barrel: every helper keeps its historical `@/hermes`
// import path while the implementations live in focused files.
// client is the one module with internals: profileScoped / connectionScoped /
// capabilityScoped are shared across api/ but must not reach call sites, or
// request scoping stops having a single owner.
export {
  getApiRequestConnection,
  getApiRequestProfile,
  hermesApi,
  HermesGateway,
  profileScopeKey,
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS,
  setApiRequestConnection,
  setApiRequestProfile,
  STARTUP_REQUEST_TIMEOUT_MS
} from './api/client'
export type { ProfileScope } from './api/client'
export * from './api/config'
export * from './api/cron'
export * from './api/mcp'
export * from './api/messaging'
export * from './api/models'
export * from './api/plugins'
export * from './api/profiles'
export * from './api/sessions'
export * from './api/skills'
export * from './api/system'
export * from './api/toolsets'

export type {
  ActionResponse,
  ActionStatusResponse,
  AnalyticsResponse,
  AutomationBlueprint,
  AutomationBlueprintField,
  AuxiliaryModelsResponse,
  CronDeliveryTarget,
  CronJob,
  CuratorStatusResponse,
  HermesConfigRecord,
  McpCatalogEntry,
  MemoryStatusResponse,
  MessagingEnvVarInfo,
  MessagingPlatformInfo,
  MoaConfigResponse,
  MoaModelSlot,
  ModelOptionProvider,
  ModelOptionsResponse,
  PairingUser,
  ProfileInfo,
  ProjectInfo,
  SessionInfo,
  SessionMessage,
  SessionResumeResponse,
  SessionSearchResult,
  StaleAuxAssignment,
  StatusResponse,
  WebhookRoute,
  WebhooksResponse
} from '@/types/hermes'
