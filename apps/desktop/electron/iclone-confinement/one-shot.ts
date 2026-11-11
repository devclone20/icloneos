/**
 * G-98 F42, the lead's ruling: an approved shell command, which is opaque and which a human just read, runs once
 * outside the Seatbelt for that command and its children. Main is the only authority: this file writes the record the
 * launcher reads, `oneshots.jsonl` in the launcher's ledger folder, which the runtime profile denies whole. A row holds
 * the sha256 of the exact text the sheet showed, the folder it runs in and an expiry; never the text. The launcher
 * spends a row by id, once. A runtime that asks without a row, with an edited text or in another folder gets nothing.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { ONE_SHOT_MAX_TEXT, oneShotReadable } from '../../src/iclone-shared/one-shot-text'
import { writeFileAtomicSync } from '../lib/atomic-write'

import { diskFold } from './disk-name'
import { projectRootRefusal } from './profiles'

export { ONE_SHOT_MAX_TEXT }

export const LAUNCHER_ONE_SHOT_FILE = 'oneshots.jsonl'
/** Long enough for the run that follows the answer, or the retry of a call whose wait ended first. */
export const ONE_SHOT_TTL_MS = 120 * 1000

export interface OneShotRow {
  v: 1
  id: string
  /** G2 A5: absent for a shell command. The launcher never spends one kind as the other. G23-W2: `read` returns the bytes. */
  kind?: 'file' | 'read'
  /** G23-W2: the link the owner's answer named, whose real target this row is for. */
  link?: string
  /** G23: main issued this row because the mode in force is Ignore, with no sheet. What Activity says. */
  by?: 'ignore'
  sha: string
  cwd: string
  ts: number
  exp: number
}

export const commandDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The folder a one-shot may run in: an absolute folder in its own real spelling, nothing else. */
export function oneShotFolder(cwd: string | null | undefined): string | null {
  if (!cwd || !path.isAbsolute(cwd)) {
    return null
  }

  try {
    return realpathSync(cwd) === cwd && statSync(cwd).isDirectory() ? cwd : null
  } catch {
    return null
  }
}

/** The real spelling of a folder that may not exist yet: its nearest existing parent's, and the rest as written. */
function realFolder(folder: string): string | null {
  const rest: string[] = []

  for (let at = folder; ; at = path.dirname(at)) {
    try {
      return path.join(realpathSync(at), ...rest)
    } catch {
      if (path.dirname(at) === at) {
        return null
      }

      rest.unshift(path.basename(at))
    }
  }
}

export interface OneFileRules {
  /** What stays shut: `appOwnFiles`. */
  appFiles?: readonly string[]
  /** The facts that decide whether a grant for its folder could open it: `projectRootRefusal`. */
  denied?: readonly string[]
  protectedWrites?: readonly string[]
  storeRoots?: readonly string[]
}

/**
 * G2 A5, G23 (the owner's ruling: the user has total freedom and takes the responsibility): the one file main may record
 * for a write outside the Seatbelt: any exact file under the home that a grant for its folder cannot open, in its own real
 * spelling. Keys, shell startup files, browser profiles and `.git` included. Only this app's own files stay shut, by case
 * too. The launcher judges it again.
 */
export function oneShotFile(file: string | null | undefined, home: string, rules: OneFileRules = {}, opened = false): string | null {
  if (!file || !path.isAbsolute(file) || path.normalize(file) !== file || !oneShotReadable(file)) {
    return null
  }

  const folder = path.dirname(file)
  let realHome: string

  try {
    realHome = realpathSync(home)

    if (realFolder(folder) !== folder || !(folder === realHome || folder.startsWith(realHome + path.sep))) {
      return null
    }
  } catch {
    return null
  }

  const lowered = diskFold(file)

  const own = (rules.appFiles ?? []).some(item => {
    const other = diskFold(item)

    return lowered === other || lowered.startsWith(other.replace(/\/+$/, '') + path.sep) || other.startsWith(lowered + path.sep)
  })

  if (own) {
    return null
  }

  const spec = { denied: [...(rules.denied ?? [])], protectedWrites: [...(rules.protectedWrites ?? [])] }

  return opened || projectRootRefusal(folder, spec, realHome, rules.storeRoots ?? []) !== null ? file : null
}

export interface OneFileAnswer {
  /** G23-W2: Ignore: a file a grant could open takes the route too, with no sheet. */
  by?: 'ignore'
  /** G23-W2: the link the sheet names; the row is for its real target, wherever that sits under the home. */
  link?: string | null
}

/** G23-W2: `file` may take a row. A link is judged with its target: both this app's or neither under the home, no row. */
export function oneShotRoute(file: string, home: string, rules: OneFileRules = {}, { by, link }: OneFileAnswer = {}): boolean {
  if (oneShotFile(file, home, rules, by === 'ignore' || !!link) !== file) {
    return false
  }

  if (!link) {
    return true
  }

  try {
    return lstatSync(link).isSymbolicLink() && realpathSync(link) === file && oneShotFile(link, home, rules, by === 'ignore') === link
  } catch {
    return false
  }
}

/** G26: the real file behind a link. The runtime's profile refuses it the stat, so main, which sees the disk, tells. Null: not a link, or one that leads nowhere. */
export function oneFileLinkTarget(file: string): string | null {
  try {
    return lstatSync(file).isSymbolicLink() ? realpathSync(file) : null
  } catch {
    return null
  }
}

export interface OneShotLedger {
  /** Records one approved command. False, and nothing recorded, when it cannot hold: the command then stays confined. */
  issue(command: string, cwd: string): boolean
  /** G2 A5: records one approved file, by its exact path. Same answer when it cannot hold. */
  issueFile(file: string, home: string, rules?: OneFileRules, by?: 'ignore', link?: string | null): boolean
  /** G23-W2: records one approved read of one file. Its own kind of row. */
  issueRead(file: string, home: string, rules?: OneFileRules, by?: 'ignore', link?: string | null): boolean
}

export function createOneShotLedger(ledgerDir: string, now: () => number = Date.now): OneShotLedger {
  const file = path.join(ledgerDir, LAUNCHER_ONE_SHOT_FILE)

  const rows = (at: number): OneShotRow[] => {
    if (!existsSync(file)) {
      return []
    }

    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as OneShotRow)
      .filter(row => row.exp * 1000 > at)
  }

  const record = (text: string, cwd: string, kind?: 'file' | 'read', by?: 'ignore', link?: string | null): boolean => {
    const at = now()

    const row: OneShotRow = {
      v: 1,
      id: randomUUID().replaceAll('-', ''),
      ...(kind ? { kind } : {}),
      ...(by ? { by } : {}),
      ...(link ? { link } : {}),
      sha: commandDigest(text),
      cwd,
      ts: at / 1000,
      exp: (at + ONE_SHOT_TTL_MS) / 1000
    }

    try {
      const kept = rows(at)
      writeFileAtomicSync(file, [...kept, row].map(item => JSON.stringify(item)).join('\n') + '\n', {
        mode: 0o600,
        dirMode: 0o700
      })

      return true
    } catch {
      return false
    }
  }

  return {
    issue(command, cwd) {
      // S1: the row is the hash of what the sheet showed, so a text the sheet cannot show as it runs holds no row.
      if (!oneShotReadable(command) || !oneShotFolder(cwd)) {
        return false
      }

      return record(command, cwd)
    },
    issueFile(target, home, rules = {}, by, link) {
      return oneShotRoute(target, home, rules, { by, link }) ? record(target, path.dirname(target), 'file', by, link) : false
    },
    issueRead(target, home, rules = {}, by, link) {
      return oneShotRoute(target, home, rules, { by, link }) ? record(target, path.dirname(target), 'read', by, link) : false
    }
  }
}
