// Desktop log: in-memory buffer, rotation and flushing of desktop.log.
import fs from 'node:fs'
import path from 'node:path'

import { formatDesktopLogLine } from '../desktop-log-line'
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
export const DESKTOP_LOG_PATH = path.join(HERMES_HOME, 'logs', 'desktop.log')

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

function rotateDesktopLogIfNeededSync() {
  let size

  try {
    size = fs.statSync(DESKTOP_LOG_PATH).size
  } catch {
    return // No live file yet — the append (re)creates it.
  }

  for (const [op, src, dst] of planDesktopLogRotation(size)) {
    try {
      if (op === 'rm') {
        fs.rmSync(src, { force: true })
      } else {
        fs.renameSync(src, dst)
      }
    } catch {
      // Best-effort — logging must never block startup/shutdown.
    }
  }
}

async function rotateDesktopLogIfNeededAsync() {
  let size

  try {
    size = (await fs.promises.stat(DESKTOP_LOG_PATH)).size
  } catch {
    return // No live file yet — the append (re)creates it.
  }

  for (const [op, src, dst] of planDesktopLogRotation(size)) {
    try {
      if (op === 'rm') {
        await fs.promises.rm(src, { force: true })
      } else {
        await fs.promises.rename(src, dst)
      }
    } catch {
      // Best-effort — logging must never crash the shell.
    }
  }
}

export function flushDesktopLogBufferSync() {
  if (!desktopLogBuffer) {
    return
  }

  const chunk = desktopLogBuffer
  desktopLogBuffer = ''

  try {
    fs.mkdirSync(path.dirname(DESKTOP_LOG_PATH), { recursive: true })
    rotateDesktopLogIfNeededSync()
    fs.appendFileSync(DESKTOP_LOG_PATH, chunk)
  } catch {
    // Logging must never block app startup/shutdown.
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
      await fs.promises.mkdir(path.dirname(DESKTOP_LOG_PATH), { recursive: true })
      await rotateDesktopLogIfNeededAsync()
      await fs.promises.appendFile(DESKTOP_LOG_PATH, chunk)
    })
    .catch(() => {
      // Logging must never crash the desktop shell.
    })

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
