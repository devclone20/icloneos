// Desktop log: in-memory buffer, rotation and flushing of desktop.log.
import { rename, unlink as unlinkAsync } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import { formatDesktopLogLine } from '../desktop-log-line'
import { writeFileAtomicSync } from '../lib/atomic-write'
import {
  appendFileInRoot,
  appendFileInRootAsync,
  isRefusedPath,
  lstatInRoot,
  mkdirsInRoot,
  pinRoot,
  renameInRoot,
  resolveInRoot,
  unlinkInRoot
} from '../lib/no-follow-fs'
import {
  describeUpdatePolicy,
  readUpdatePolicyOverride,
  resolveUpdatePolicy,
  type UpdatePolicy
} from '../update-policy'

import { HERMES_HOME, IS_PACKAGED, updatePolicyOverrideFile } from './env'
import { logBufferState } from './state'

// desktop.log lives under HERMES_HOME/logs/ so it sits next to agent.log,
// errors.log, gateway.log produced by hermes_logging.setup_logging — one log
// directory per user, regardless of which UI surface produced the line.
//
// The confined runtime can write that folder and this process is not confined, so every operation on the log goes
// through lib/no-follow-fs: a link, FIFO or folder planted at these names is refused, never followed.
export const DESKTOP_LOG_PATH = path.join(HERMES_HOME, 'logs', 'desktop.log')

pinRoot(HERMES_HOME)

const DESKTOP_LOG_FLUSH_MS = 120

const DESKTOP_LOG_BUFFER_MAX_CHARS = 64 * 1024

// Bound desktop.log on disk. It is an append-only forensic log, so a boot loop
// (version-skew crash -> backend exits instantly -> renderer keeps hitting
// Retry) appends the full bootstrap transcript every attempt and grows without
// bound — we have seen it reach ~326 GB and exhaust the disk, which then breaks
// update/install (no room for git/venv/npm temp files).
//
// Mirror the Python logs (hermes_logging.py RotatingFileHandler, maxBytes x
// backupCount): cascade live -> .1 -> .2 -> .3, drop the oldest. Steady-state
// stays bounded at ~(backupCount + 1) x cap however hard the app loops.
//
// Bounding alone never RECLAIMS an already-huge file: a plain rotation just
// renames the monster to .1 and strands it for a cycle a healthy app may never
// reach. A multi-GB boot-loop transcript has no diagnostic value, so anything
// past the discard ceiling is deleted outright — the updated app self-heals a
// disk a stale build filled, on the next launch.
const DESKTOP_LOG_MAX_BYTES = 10 * 1024 * 1024

const DESKTOP_LOG_BACKUP_COUNT = 3

const DESKTOP_LOG_DISCARD_BYTES = DESKTOP_LOG_MAX_BYTES * 4

// Under userData, outside every hole the runtime profile opens.
const DESKTOP_LOG_REFUSAL_RECORD = 'desktop-log-refused.json'

const desktopLogBackupPath = (n: number) => `${DESKTOP_LOG_PATH}.${n}`

export function recentHermesLog() {
  return hermesLog.slice(-20).join('\n')
}

// iclone-seam: r1-policy — resolved once from IS_PACKAGED (+ the typed operator override); main enforces it.
let updatePolicyMemo: null | UpdatePolicy = null

export function updatePolicy(): UpdatePolicy {
  if (!updatePolicyMemo) {
    const override = IS_PACKAGED ? readUpdatePolicyOverride(updatePolicyOverrideFile()) : null
    updatePolicyMemo = resolveUpdatePolicy({ isPackaged: IS_PACKAGED, env: process.env, override })
    rememberLog(describeUpdatePolicy(updatePolicyMemo, override))
  }

  return updatePolicyMemo
}

export const hermesLog: string[] = []
let desktopLogBuffer = ''
let desktopLogFlushPromise = Promise.resolve()

// Pure planner: ordered fs ops to bound a live log of `size`. [] = nothing.
// Each step is ['rm', path] or ['mv', src, dst]; executed best-effort so a
// missing chain link never aborts the rest.
function planDesktopLogRotation(size: number) {
  if (size < DESKTOP_LOG_MAX_BYTES) {
    return []
  }

  const backups = (n: number) => Array.from({ length: n }, (_, i) => desktopLogBackupPath(i + 1))

  // Pathological boot-loop log: reclaim live + every backup outright.
  if (size > DESKTOP_LOG_DISCARD_BYTES) {
    return [DESKTOP_LOG_PATH, ...backups(DESKTOP_LOG_BACKUP_COUNT)].map(p => ['rm', p])
  }

  // Cascade: drop oldest, shift each up, live -> .1.
  const ops = [['rm', desktopLogBackupPath(DESKTOP_LOG_BACKUP_COUNT)]]

  for (let i = DESKTOP_LOG_BACKUP_COUNT - 1; i >= 1; i--) {
    ops.push(['mv', desktopLogBackupPath(i), desktopLogBackupPath(i + 1)])
  }

  ops.push(['mv', DESKTOP_LOG_PATH, desktopLogBackupPath(1)])

  return ops
}

// The size comes from the entry itself: a link is not the log, so it plans nothing and the append refuses it.
function liveDesktopLogSize() {
  const stat = lstatInRoot(HERMES_HOME, DESKTOP_LOG_PATH)

  return stat?.isFile() ? stat.size : 0
}

function rotateDesktopLogIfNeededSync() {
  for (const [op, src, dst] of planDesktopLogRotation(liveDesktopLogSize())) {
    try {
      if (op === 'rm') {
        unlinkInRoot(HERMES_HOME, src)
      } else {
        renameInRoot(HERMES_HOME, src, dst)
      }
    } catch {
      // Best-effort — logging must never block startup/shutdown.
    }
  }
}

async function rotateDesktopLogIfNeededAsync() {
  for (const [op, src, dst] of planDesktopLogRotation(liveDesktopLogSize())) {
    try {
      if (op === 'rm') {
        await unlinkAsync(resolveInRoot(HERMES_HOME, src))
      } else {
        await rename(resolveInRoot(HERMES_HOME, src), resolveInRoot(HERMES_HOME, dst))
      }
    } catch {
      // Best-effort — logging must never crash the shell.
    }
  }
}

let desktopLogRefusalRecorded = false

// Refused: the lines stay in the in-memory `hermesLog`, and one record goes under userData, which the runtime's
// profile denies. Once per launch: a runtime that keeps a link planted must not grow any file by doing so.
function noteDesktopLogFailure(error: unknown) {
  if (!isRefusedPath(error) || desktopLogRefusalRecorded) {
    return
  }

  desktopLogRefusalRecorded = true

  try {
    writeFileAtomicSync(
      path.join(app.getPath('userData'), DESKTOP_LOG_REFUSAL_RECORD),
      `${JSON.stringify({ at: new Date().toISOString(), refused: error.message })}\n`
    )
  } catch {
    // Logging must never block app startup/shutdown.
  }
}

/** Creates the empty log for a surface that shows it; a refusal reaches the caller, which reports it to the user. */
export function ensureDesktopLogFile() {
  mkdirsInRoot(HERMES_HOME, path.dirname(DESKTOP_LOG_PATH))
  appendFileInRoot(HERMES_HOME, DESKTOP_LOG_PATH, '')
}

export function flushDesktopLogBufferSync() {
  if (!desktopLogBuffer) {
    return
  }

  const chunk = desktopLogBuffer
  desktopLogBuffer = ''

  try {
    mkdirsInRoot(HERMES_HOME, path.dirname(DESKTOP_LOG_PATH))
    rotateDesktopLogIfNeededSync()
    appendFileInRoot(HERMES_HOME, DESKTOP_LOG_PATH, chunk)
  } catch (error) {
    // Logging must never block app startup/shutdown.
    noteDesktopLogFailure(error)
  }
}

function flushDesktopLogBufferAsync() {
  if (!desktopLogBuffer) {
    return desktopLogFlushPromise
  }

  const chunk = desktopLogBuffer
  desktopLogBuffer = ''

  desktopLogFlushPromise = desktopLogFlushPromise
    .then(async () => {
      mkdirsInRoot(HERMES_HOME, path.dirname(DESKTOP_LOG_PATH))
      await rotateDesktopLogIfNeededAsync()
      await appendFileInRootAsync(HERMES_HOME, DESKTOP_LOG_PATH, chunk)
    })
    .catch(noteDesktopLogFailure)

  return desktopLogFlushPromise
}

function scheduleDesktopLogFlush() {
  if (logBufferState.desktopLogFlushTimer) {
    return
  }

  logBufferState.desktopLogFlushTimer = setTimeout(() => {
    logBufferState.desktopLogFlushTimer = null
    void flushDesktopLogBufferAsync()
  }, DESKTOP_LOG_FLUSH_MS)
}

export function rememberLog(chunk: string) {
  const text = String(chunk || '').trim()

  if (!text) {
    return
  }

  // One timestamp per chunk: lines arriving in the same event happened
  // at the same moment.  ISO-8601 UTC, matching agent.log/gateway.log.
  const stamp = new Date().toISOString()
  const lines = text.split(/\r?\n/).map(line => formatDesktopLogLine(line, stamp))
  hermesLog.push(...lines)

  if (hermesLog.length > 300) {
    hermesLog.splice(0, hermesLog.length - 300)
  }

  desktopLogBuffer += `${lines.join('\n')}\n`

  if (desktopLogBuffer.length >= DESKTOP_LOG_BUFFER_MAX_CHARS) {
    if (logBufferState.desktopLogFlushTimer) {
      clearTimeout(logBufferState.desktopLogFlushTimer)
      logBufferState.desktopLogFlushTimer = null
    }

    void flushDesktopLogBufferAsync()

    return
  }

  scheduleDesktopLogFlush()
}
