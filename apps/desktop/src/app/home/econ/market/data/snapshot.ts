/** The market data module's `snapshot` section — its public names are re-exported by ../market-data.ts. */
import { asArray, asRecord, bool, isString, type Json, num, str } from '../../cli'
import { readSnapshot, type Snapshot, SNAPSHOT_MAX_BYTES } from '../../snapshot'

import { shapeChains } from './chains'
import {
  ACP_ID,
  SNAPSHOT_JOBS_MAX,
  SNAPSHOT_OFFERINGS_MAX,
  SNAPSHOT_SLACK_BYTES,
  SNAPSHOT_VERSION,
  TOP_K
} from './constants'
import { normalizeStatus } from './jobs'
import {
  cheapestOffering,
  isAlwaysOn,
  isChainId,
  isOnline,
  priceLabel,
  safeImage,
  safeLink,
  uniqueById
} from './offerings'
import { finiteOrNull, records } from './primitives'
import { fieldsModel } from './schemas'
import type {
  AcpChain,
  MarketAgent,
  MarketJob,
  MarketOffering,
  MarketResource,
  OwnOffering,
  SchemaField,
  SchemaModel
} from './types'

// ── the snapshot (last answers, on disk) ────────────────────────────────────

export interface Stamped<T> {
  data: T
  at: number
}

/** What an open paints before the first CLI answer. Public marketplace data
 *  and this agent's own job/offering lists — never a job room, a typed
 *  search, an error or anything a sign-in state rides on. */
export interface MarketSnapshot {
  /** The Virtuals agent these lists belong to (`agent whoami` id). */
  agentId: string
  /** The featured feed only — DEFAULT_PARAMS, never a typed search. */
  featured: null | Stamped<MarketAgent[]>
  jobs: null | Stamped<MarketJob[]>
  offerings: null | Stamped<OwnOffering[]>
  chains: AcpChain[]
}

interface SnapshotInput {
  agentId: string
  featured: null | Stamped<MarketAgent[]>
  jobs: null | Stamped<MarketJob[]>
  offerings: null | Stamped<OwnOffering[]>
  chains: AcpChain[]
}

const measured = new WeakMap<object, { max: number; bytes: number }>()

/** The JSON length of a list's first `max` items, measured once per list: a
 *  cached answer keeps its identity, so a list is sized once per CLI read,
 *  never on every render that rebuilds the snapshot. */
function listBytes(list: readonly unknown[], max: number): number {
  const known = measured.get(list)

  if (known && known.max === max) {
    return known.bytes
  }

  let bytes: number

  try {
    bytes = JSON.stringify(list.length > max ? list.slice(0, max) : list).length
  } catch {
    bytes = Infinity
  }

  measured.set(list, { max, bytes })

  return bytes
}

function bounded<T>(stamped: null | Stamped<T[]>, max: number): null | Stamped<T[]> {
  if (!stamped) {
    return null
  }

  return stamped.data.length > max ? { data: stamped.data.slice(0, max), at: stamped.at } : stamped
}

/** The snapshot to write, bounded, with the newest read's time — or null when
 *  there is nothing worth keeping. When the lists overflow the cap the
 *  featured feed (re-readable, and prefetched) is dropped first. The size is
 *  an upper bound from the lists' memoized lengths: the one serialisation is
 *  writeSnapshot's own, which still enforces the exact cap. */
export function buildSnapshot(input: SnapshotInput): null | Stamped<MarketSnapshot> {
  if (!input.agentId) {
    return null
  }

  const at = Math.max(input.featured?.at ?? 0, input.jobs?.at ?? 0, input.offerings?.at ?? 0)

  if (at === 0) {
    return null
  }

  const featuredBytes = input.featured ? listBytes(input.featured.data, TOP_K) : 0

  const restBytes =
    SNAPSHOT_SLACK_BYTES +
    input.agentId.length * 6 +
    (input.jobs ? listBytes(input.jobs.data, SNAPSHOT_JOBS_MAX) : 0) +
    (input.offerings ? listBytes(input.offerings.data, SNAPSHOT_OFFERINGS_MAX) : 0) +
    listBytes(input.chains, Infinity)

  if (restBytes > SNAPSHOT_MAX_BYTES) {
    return null
  }

  const snapshot: MarketSnapshot = {
    agentId: input.agentId,
    featured: featuredBytes + restBytes <= SNAPSHOT_MAX_BYTES ? bounded(input.featured, TOP_K) : null,
    jobs: bounded(input.jobs, SNAPSHOT_JOBS_MAX),
    offerings: bounded(input.offerings, SNAPSHOT_OFFERINGS_MAX),
    chains: input.chains
  }

  return { data: snapshot, at }
}

function stampedList<T>(
  value: unknown,
  valid: (item: Json) => boolean,
  restore: (item: Json) => T
): null | Stamped<T[]> {
  const record = asRecord(value)

  if (!record || !Array.isArray(record.data) || typeof record.at !== 'number' || !Number.isFinite(record.at)) {
    return null
  }

  return { data: records(record.data).filter(valid).map(restore), at: record.at }
}

const isAgentLike = (item: Json) =>
  typeof item.id === 'string' &&
  item.id !== '' &&
  typeof item.name === 'string' &&
  typeof item.lastActiveAt === 'string' &&
  Array.isArray(item.offerings) &&
  Array.isArray(item.chainIds)

const isJobLike = (item: Json) =>
  typeof item.key === 'string' && typeof item.id === 'string' && item.id !== '' && typeof item.status === 'string'

const isOfferingLike = (item: Json) =>
  typeof item.name === 'string' && asRecord(item.deliverable) !== null && asRecord(item.requirements) !== null

function restoreField(item: Json): SchemaField {
  const hasDefault = bool(item, 'hasDefault')

  return {
    name: str(item, 'name'),
    required: bool(item, 'required'),
    type: str(item, 'type'),
    label: str(item, 'label') || 'text',
    description: str(item, 'description'),
    enumValues: asArray(item.enumValues).filter(isString),
    example: str(item, 'example'),
    hasDefault,
    defaultValue: hasDefault ? item.defaultValue : undefined,
    constraints: asArray(item.constraints).filter(isString)
  }
}

function restoreModel(value: unknown): SchemaModel {
  const record = asRecord(value)

  if (record?.kind === 'text' && typeof record.text === 'string' && record.text) {
    return { kind: 'text', text: record.text }
  }

  if (record?.kind === 'fields') {
    return fieldsModel(
      records(record.fields)
        .filter(field => str(field, 'name'))
        .map(restoreField)
    )
  }

  return { kind: 'none' }
}

const isResourceLike = (item: Json) => typeof item.name === 'string' && asRecord(item.params) !== null

function restoreResource(item: Json): MarketResource {
  return {
    id: str(item, 'id'),
    agentId: str(item, 'agentId'),
    name: str(item, 'name') || 'Untitled resource',
    description: str(item, 'description'),
    url: safeLink(str(item, 'url')),
    params: restoreModel(item.params),
    isHidden: bool(item, 'isHidden')
  }
}

function restoreOffering(item: Json): MarketOffering {
  return {
    id: str(item, 'id'),
    agentId: str(item, 'agentId'),
    name: str(item, 'name') || 'Untitled offering',
    description: str(item, 'description'),
    deliverable: restoreModel(item.deliverable),
    requirements: restoreModel(item.requirements),
    slaMinutes: finiteOrNull(item.slaMinutes),
    priceType: str(item, 'priceType') || 'fixed',
    priceValue: finiteOrNull(item.priceValue),
    requiredFunds: bool(item, 'requiredFunds'),
    isHidden: bool(item, 'isHidden'),
    isPrivate: bool(item, 'isPrivate')
  }
}

/** An own offering from disk. A snapshot written before sources were kept
 *  restores them as '' — the editor then rebuilds them from the schema model. */
function restoreOwnOffering(item: Json): OwnOffering {
  const source = asRecord(item.source)

  return {
    ...restoreOffering(item),
    source: {
      requirements: str(source, 'requirements'),
      deliverable: str(source, 'deliverable'),
      subscriptionIds: asArray(source?.subscriptionIds).filter(
        (value): value is string => isString(value) && ACP_ID.test(value)
      )
    }
  }
}

/** A stored agent, re-shaped field by field: presence is recomputed (a
 *  stored `online` is hours stale) and the avatar rule applies again. */
function restoreAgent(item: Json, now: number): MarketAgent {
  const lastActiveAt = str(item, 'lastActiveAt')
  const offerings = records(item.offerings).filter(isOfferingLike).map(restoreOffering)
  const resources = records(item.resources).filter(isResourceLike).map(restoreResource)
  const cheapest = cheapestOffering(offerings)

  return {
    id: str(item, 'id'),
    name: str(item, 'name'),
    description: str(item, 'description'),
    imageUrl: safeImage(str(item, 'imageUrl')),
    walletAddress: str(item, 'walletAddress'),
    solWalletAddress: str(item, 'solWalletAddress'),
    role: str(item, 'role'),
    cluster: str(item, 'cluster'),
    tag: str(item, 'tag'),
    lastActiveAt,
    online: isOnline(lastActiveAt, now),
    alwaysOn: isAlwaysOn(lastActiveAt),
    rating: finiteOrNull(item.rating),
    isNew: bool(item, 'isNew'),
    chainIds: [...new Set(asArray(item.chainIds).filter(isChainId))],
    offerings,
    resources,
    priceFrom: cheapest ? priceLabel(cheapest) : ''
  }
}

function restoreJob(item: Json): MarketJob {
  return {
    key: str(item, 'key'),
    id: str(item, 'id'),
    chainId: num(item, 'chainId'),
    legacy: bool(item, 'legacy'),
    status: normalizeStatus(str(item, 'status')),
    clientAddress: str(item, 'clientAddress'),
    providerAddress: str(item, 'providerAddress'),
    evaluatorAddress: str(item, 'evaluatorAddress'),
    providerName: str(item, 'providerName'),
    title: str(item, 'title'),
    budgetUsdc: finiteOrNull(item.budgetUsdc),
    createdAt: str(item, 'createdAt'),
    expiredAt: str(item, 'expiredAt')
  }
}

/**
 * A stored snapshot made safe to paint: every item re-shaped by a total
 * restorer (a hand-edited store cannot crash a view), and refused outright
 * when it belongs to another agent (the iNFT was re-provisioned). `agentId`
 * null means "not known yet" — the caller then holds back the agent's own
 * lists until it is.
 */
export function restoreSnapshot(
  snapshot: null | Snapshot<unknown>,
  agentId: null | string,
  now: number
): MarketSnapshot | null {
  const root = asRecord(snapshot?.data)

  if (!root || typeof root.agentId !== 'string' || !root.agentId) {
    return null
  }

  if (agentId && agentId !== root.agentId) {
    return null
  }

  const featured = stampedList(root.featured, isAgentLike, item => restoreAgent(item, now))
  const jobs = stampedList(root.jobs, isJobLike, restoreJob)

  return {
    agentId: root.agentId,
    featured: featured ? { ...featured, data: uniqueById(featured.data) } : null,
    jobs: jobs ? { ...jobs, data: [...new Map(jobs.data.map(job => [job.key, job])).values()] } : null,
    offerings: stampedList(root.offerings, isOfferingLike, restoreOwnOffering),
    chains: shapeChains(root.chains)
  }
}

export function readMarketSnapshot(slug: string, agentId: null | string, now = Date.now()): MarketSnapshot | null {
  return restoreSnapshot(readSnapshot<unknown>('acp', slug, SNAPSHOT_VERSION), agentId, now)
}
