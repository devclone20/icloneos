/**
 * REL-6 (lead ruling on critic m7) — "this app installed this tree": the record of the last verified install, kept in
 * V3-F's protected state (`userData/permissions/`, a floor-2 path no agent write is ever allowed into), not beside the
 * tree in `userData/acp-cli/`. A check accepts a tree only when its MAC-verified manifest is the one recorded here, so
 * a tree that appears without the owner's audited click — even one signed with the right key — is refused.
 */
import { readFileSync } from 'node:fs'

import { writeFileAtomicSync } from '../lib/atomic-write'

import type { AcpManifest } from './manifest'

export interface InstallRecord {
  v: 1
  lockSha256: string
  treeSha256: string
  mac: string
  /** The app's add-on list digest the install used (critic r2 m4). */
  addons: string
  installedAt: string
}

export interface InstallRecordStore {
  read(): InstallRecord | null
  /** Throws when it cannot write (the install is then refused: `record-unwritable`). */
  write(record: InstallRecord): void
}

const HEX64 = /^[0-9a-f]{64}$/

function parse(value: unknown): InstallRecord | null {
  const r = value as Partial<InstallRecord> | null

  return r &&
    r.v === 1 &&
    typeof r.lockSha256 === 'string' &&
    HEX64.test(r.lockSha256) &&
    typeof r.treeSha256 === 'string' &&
    HEX64.test(r.treeSha256) &&
    typeof r.mac === 'string' &&
    HEX64.test(r.mac) &&
    typeof r.addons === 'string' &&
    typeof r.installedAt === 'string'
    ? {
        v: 1,
        lockSha256: r.lockSha256,
        treeSha256: r.treeSha256,
        mac: r.mac,
        addons: r.addons,
        installedAt: r.installedAt
      }
    : null
}

/** The record as a file (main: `userData/permissions/acp-tools-install.json`). */
export function fileRecordStore(file: string): InstallRecordStore {
  return {
    read: () => {
      try {
        return parse(JSON.parse(readFileSync(file, 'utf8')))
      } catch {
        return null
      }
    },
    write: record => writeFileAtomicSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}

export function recordOf(manifest: AcpManifest, installedAt: string): InstallRecord {
  return {
    v: 1,
    lockSha256: manifest.lockSha256,
    treeSha256: manifest.treeSha256,
    mac: manifest.mac,
    addons: manifest.addons,
    installedAt
  }
}

export function recordMatches(record: InstallRecord | null, manifest: AcpManifest): boolean {
  return (
    record !== null &&
    record.lockSha256 === manifest.lockSha256 &&
    record.treeSha256 === manifest.treeSha256 &&
    record.mac === manifest.mac &&
    record.addons === manifest.addons
  )
}
