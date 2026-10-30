/**
 * Ruling 54.4 / 57: main.ts's FIRST import. Seals main's own env and every child-process primitive before any other
 * module runs (iclone-telemetry-seal.ts; Electron's utilityProcess too), and blocks analytics endpoints on every
 * session the app will create (iclone-analytics-block.ts).
 */
import { app, session, utilityProcess } from 'electron'

import { type AppLike, installAnalyticsBlock, type SessionLike } from './iclone-analytics-block'
import { installTelemetrySeal } from './iclone-telemetry-seal'

installTelemetrySeal({ utilityProcess: utilityProcess as unknown as { fork: (...args: unknown[]) => unknown } })
void installAnalyticsBlock(app as unknown as AppLike, () => session.defaultSession as unknown as SessionLike)
