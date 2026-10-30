/**
 * The diagnostics catalogue: `iclone/diagnostics/<pack>/pack.json` (no code in JSON — `impl` names a function in
 * iclone-doctor-checks.ts / iclone-doctor-fixes.ts). Validated by hand like the other stores; an invalid manifest is
 * dropped whole, never half-loaded.
 */
import fs from 'node:fs'
import path from 'node:path'

import { isNonBlankString, isRecord } from '../src/iclone-shared/guards'

import { CONSENT_PERMISSION_KEYS, type ConsentPermissionKey } from './iclone-consent'

export type CheckStatus = 'fail' | 'pass' | 'skip' | 'warn'
export type FixRisk = 'high' | 'low' | 'medium'
type DoctorPlatform = 'darwin' | 'linux'

export interface CheckDef {
  id: string
  title: string
  severity: 'fail' | 'warn'
  timeoutMs: number
  network: boolean
  impl: string
  fix?: string
  platforms?: DoctorPlatform[]
}

export interface FixDef {
  id: string
  title: string
  risk: FixRisk
  consent: ConsentPermissionKey | null
  dryRun: true
  backup: true
  undo: string
  impl: string
}

export interface PackDef {
  schema: 1
  id: string
  title: string
  order: number
  platforms: DoctorPlatform[]
  checks: CheckDef[]
  fixes: FixDef[]
}

export const PACK_IDS = ['runtime', 'gateway', 'acp', 'wallet', 'permissions', 'storage', 'native', 'network'] as const
export const NETWORK_PACK = 'network'

const ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/
const IMPL = /^[a-zA-Z][a-zA-Z0-9]*$/
const PLATFORMS = new Set(['darwin', 'linux'])
const RISKS = new Set(['low', 'medium', 'high'])
const CONSENT_KEYS = new Set<string>(CONSENT_PERMISSION_KEYS)

function platformsOk(v: unknown): v is DoctorPlatform[] {
  return Array.isArray(v) && v.length > 0 && v.every(p => typeof p === 'string' && PLATFORMS.has(p))
}

interface DefHeader extends Record<string, unknown> {
  id: string
  impl: string
  title: string
}

/** The header checks and fixes share: an id namespaced by its pack, a title, and a known impl name. */
function validDefHeader(v: unknown, pack: string): v is DefHeader {
  return (
    isRecord(v) &&
    isNonBlankString(v.id, 200) &&
    ID.test(v.id) &&
    v.id.startsWith(`${pack}.`) &&
    isNonBlankString(v.title, 200) &&
    isNonBlankString(v.impl, 200) &&
    IMPL.test(v.impl)
  )
}

function validCheck(v: unknown, pack: string): v is CheckDef {
  if (!validDefHeader(v, pack) || (v.severity !== 'fail' && v.severity !== 'warn') || typeof v.network !== 'boolean') {
    return false
  }

  if (typeof v.timeoutMs !== 'number' || !Number.isInteger(v.timeoutMs) || v.timeoutMs < 100 || v.timeoutMs > 60_000) {
    return false
  }

  // Only the opt-in network pack may touch the network (policy: diagnostics stay on device).
  if (v.network && pack !== NETWORK_PACK) {
    return false
  }

  return (
    (v.fix === undefined || isNonBlankString(v.fix, 200)) && (v.platforms === undefined || platformsOk(v.platforms))
  )
}

function validFix(v: unknown, pack: string): v is FixDef {
  if (!validDefHeader(v, pack) || typeof v.risk !== 'string' || !RISKS.has(v.risk)) {
    return false
  }

  if (v.consent !== null && (typeof v.consent !== 'string' || !CONSENT_KEYS.has(v.consent))) {
    return false
  }

  return v.dryRun === true && v.backup === true && isNonBlankString(v.undo, 400)
}

/** Pure: one parsed manifest → a pack, or the reason it is refused. */
export function validatePack(v: unknown): { ok: true; pack: PackDef } | { ok: false; error: string } {
  if (
    !isRecord(v) ||
    v.schema !== 1 ||
    !isNonBlankString(v.id, 200) ||
    !(PACK_IDS as readonly string[]).includes(v.id)
  ) {
    return { ok: false, error: 'unknown pack id or schema' }
  }

  const id = v.id

  if (!isNonBlankString(v.title, 200) || typeof v.order !== 'number' || !platformsOk(v.platforms)) {
    return { ok: false, error: `${id}: title/order/platforms` }
  }

  if (!Array.isArray(v.checks) || v.checks.length === 0 || !Array.isArray(v.fixes)) {
    return { ok: false, error: `${id}: checks/fixes` }
  }

  const badCheck = v.checks.find(c => !validCheck(c, id))

  if (badCheck !== undefined) {
    return { ok: false, error: `${id}: invalid check ${JSON.stringify(isRecord(badCheck) ? badCheck.id : badCheck)}` }
  }

  const badFix = v.fixes.find(f => !validFix(f, id))

  if (badFix !== undefined) {
    return { ok: false, error: `${id}: invalid fix ${JSON.stringify(isRecord(badFix) ? badFix.id : badFix)}` }
  }

  const fixIds = new Set((v.fixes as FixDef[]).map(f => f.id))
  const dangling = (v.checks as CheckDef[]).find(c => c.fix !== undefined && !fixIds.has(c.fix))

  if (dangling) {
    return { ok: false, error: `${id}: ${dangling.id} names a missing fix ${dangling.fix}` }
  }

  return { ok: true, pack: v as unknown as PackDef }
}

export interface Catalogue {
  packs: PackDef[]
  errors: string[]
}

/** Reads every `<dir>/<pack>/pack.json` in pack order. */
export function loadCatalogue(dir: string): Catalogue {
  const packs: PackDef[] = []
  const errors: string[] = []

  for (const id of PACK_IDS) {
    const file = path.join(dir, id, 'pack.json')

    try {
      const result = validatePack(JSON.parse(fs.readFileSync(file, 'utf8')))

      if ('error' in result) {
        errors.push(result.error)
      } else {
        packs.push(result.pack)
      }
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  packs.sort((a, b) => a.order - b.order)

  return { packs, errors }
}

export function findFix(catalogue: Catalogue, fixId: string): { pack: PackDef; fix: FixDef } | null {
  for (const pack of catalogue.packs) {
    const fix = pack.fixes.find(f => f.id === fixId)

    if (fix) {
      return { pack, fix }
    }
  }

  return null
}

/** First existing catalogue dir: packaged resources, then the repo checkout (dev). */
export function resolveCatalogueDir(candidates: readonly string[]): string | null {
  return candidates.find(dir => fs.existsSync(path.join(dir, 'runtime', 'pack.json'))) ?? null
}
