/**
 * config.yaml and .env in the agent's home, judged by main before anything runs on them. The runtime's sandbox reads its
 * home and nothing else, and a link's target is never added to its read rules: a compromised runtime could plant that
 * link and read anything. So a link out of the home, a link to nothing, a special file or a file that cannot be read is
 * refused here, by name and with the command that fixes it, instead of failing inside the runtime with the wrong reason.
 * Nothing here opens the file: a planted FIFO cannot stall main.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  HOME_SETTINGS_FILES,
  HOME_SETTINGS_INSTALL_STOPPED,
  HOME_SETTINGS_NOT_STARTED,
  HOME_SETTINGS_REFUSED,
  HOME_SETTINGS_RETRY,
  type HomeSettingsFile,
  type HomeSettingsFinding,
  type HomeSettingsFindingKind,
  type HomeSettingsRefusal,
  type HomeSettingsReplaceResult
} from '../src/iclone-shared/home-settings'

import { isRefusedPath, lstatInRoot, pinRoot, readPlainFileNoLinks, replaceFileInRoot } from './lib/no-follow-fs'

const SHELL_SAFE = /^[\w@%+=:,./-]+$/

/** Far past any real settings file, and short of what main should hold in memory for a link it did not create. */
const COPY_CAP_BYTES = 16 * 1024 * 1024

const shellQuote = (value: string) => (SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

/**
 * A private plain copy of what the link points at, taking the link's place. `cp` alone would write through the link, and
 * so would a fixed temp name: the runtime can plant a link there, and the owner runs this outside the sandbox.
 */
function plainCopyCommand(file: string): string {
  const quoted = shellQuote(file)
  const template = shellQuote(`${file}.XXXXXX`)

  return `(umask 077 && t=$(mktemp ${template}) && cp -L ${quoted} "$t" && mv "$t" ${quoted})`
}

/** Where a settings link may never lead while confined. `*` matches inside one path segment. Real paths, see the guard's builder. */
export interface HomeSettingsCopyGuard {
  neverCopied: string[]
  runtimeWritable: string[]
}

let copyGuard: (() => HomeSettingsCopyGuard) | null = null

/**
 * Module state, on purpose: every judgement must answer the same, and the start's own judgement sits in prepareHermesSpawn,
 * which passes only the three facts of HomeSettingsCheck. Set once by registerHomeSettingsIpc, before the first spawn.
 */
export function setHomeSettingsCopyGuard(guard: (() => HomeSettingsCopyGuard) | null): void {
  copyGuard = guard
}

/** APFS by default compares without case: a link to `~/.SSH/x` opens `~/.ssh/x`. Over-refusing on a case-sensitive volume is harmless. */
const foldedPath = (value: string) => (process.platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value)

function matchesGuarded(target: string, pattern: string): boolean {
  const wanted = foldedPath(pattern).split(path.sep)
  const parts = foldedPath(target).split(path.sep)

  return (
    parts.length >= wanted.length &&
    wanted.every((segment, index) =>
      segment.includes('*')
        ? new RegExp(`^${segment.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(parts[index] ?? '')
        : segment === parts[index]
    )
  )
}

/** A guard that cannot answer guards everything: the copy is the one way these bytes reach the agent. */
function guardedAs(target: string): 'never' | 'writable' | null {
  try {
    const guard = copyGuard?.()

    if (guard?.neverCopied.some(item => matchesGuarded(target, item))) {
      return 'never'
    }

    return guard?.runtimeWritable.some(item => matchesGuarded(target, item)) ? 'writable' : null
  } catch {
    return 'never'
  }
}

interface HomeSettingsCheck {
  /** What the refusal stops, in the sentence the user reads. */
  doing: 'install' | 'start' | 'update'
  /** True while the runtime is confined: its sandbox cannot read outside its home. Unconfined, such a link works. */
  linksOutsideRefused: boolean
  /** The folder the sandbox can read. A profile's own home sits inside it. */
  root: string
}

interface HomeSettingsJudgement {
  refused: HomeSettingsFinding[]
  /** Unconfined, the runtime copes with these: it starts, and the owner is told once. */
  warned: HomeSettingsFinding[]
}

const STOPPED: Record<HomeSettingsCheck['doing'], string> = {
  install: HOME_SETTINGS_INSTALL_STOPPED,
  start: HOME_SETTINGS_NOT_STARTED,
  update: 'so the runtime update did not run.'
}

const KEYS_NOT_LOADED = 'so no key from it is loaded.'
const DEFAULTS_USED = 'so the agent runs without these settings.'

/** Only a sandbox makes these fatal: an unconfined runtime warns and carries on. An unreadable config.yaml stays fatal, its fail-open fallback would hide every setting. */
function blocksWhileUnconfined(name: HomeSettingsFile, kind: HomeSettingsFindingKind): boolean {
  if (kind === 'link-dangling') {
    return false
  }

  return kind === 'special' || name === 'config.yaml'
}

/** The stages stay strict while the pinned installer predates its no-follow seeding: it would write through a dangling link. */
const blocks = (name: HomeSettingsFile, kind: HomeSettingsFindingKind, check: HomeSettingsCheck): boolean =>
  check.linksOutsideRefused || check.doing !== 'start' || blocksWhileUnconfined(name, kind)

function findingOf(home: string, name: HomeSettingsFile, check: HomeSettingsCheck): HomeSettingsFinding | null {
  const file = path.join(home, name)
  const quoted = shellQuote(file)

  const build = (
    kind: HomeSettingsFindingKind,
    words: (consequence: string) => string,
    fix: string,
    command: string,
    target: null | string = null
  ): HomeSettingsFinding => {
    const consequence = blocks(name, kind, check) ? STOPPED[check.doing] : name === 'config.yaml' ? DEFAULTS_USED : KEYS_NOT_LOADED
    const reason = words(consequence)

    return { command, file: name, kind, message: `${reason} ${fix}, ${HOME_SETTINGS_RETRY} ${command}`, path: file, reason, target }
  }

  const unreadable = () =>
    build(
      'unreadable',
      stopped => `Your ${name} (${file}) exists but this app cannot read it, ${stopped}`,
      'Let your account read it',
      `chmod 600 ${quoted}`
    )

  const special = (target: null | string = null) =>
    build(
      'special',
      stopped => `Your ${name} (${file}) is not a plain file, ${stopped}`,
      'Move it aside',
      `mv ${quoted} ${shellQuote(`${file}.aside`)}`,
      target
    )

  const folderLocked = (folder: string) =>
    build(
      'folder-locked',
      stopped => `Your ${name} (${file}) sits behind a folder this app cannot open (${folder}), ${stopped}`,
      'Let your account open that folder',
      `chmod u+rwx ${shellQuote(folder)}`
    )

  const dangling = (points: string) =>
    build(
      'link-dangling',
      stopped => `Your ${name} is a link to a file that does not exist (${points}), ${stopped}`,
      'Remove the link',
      `rm ${quoted}`
    )

  /** No button and no command: copying these bytes is the very thing being refused, and only the owner can say what replaces them. */
  const guarded = (target: string, why: string): HomeSettingsFinding => {
    const stopped = STOPPED[check.doing]
    const reason = `Your ${name} is a link to ${target}, ${why}, ${stopped} Move this file yourself: put only the settings the agent should have in a plain file at ${file}, then try again.`

    return { command: '', file: name, kind: 'link-guarded', message: reason, path: file, reason, target }
  }

  let stat: fs.Stats | null

  try {
    // The root, never the profile's own home: a profile name that is itself a link must not lead outside it.
    stat = lstatInRoot(check.root, file)
  } catch (error) {
    if (isLockedError(error)) {
      return folderLocked(home)
    }

    throw error
  }

  if (stat === null) {
    return null
  }

  if (stat.isFile()) {
    return readable(file) ? null : unreadable()
  }

  if (!stat.isSymbolicLink()) {
    return special()
  }

  let target: string

  try {
    // Native: the spelling on disk, so a link that spells a folder in other letters is judged as the folder it is.
    target = fs.realpathSync.native(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'ENOENT' || code === 'ELOOP') {
      return dangling(linkText(file))
    }

    if (isLockedError(error)) {
      // chmod on the link would follow it into the same locked folder, and fail: name the folder, not the link.
      return folderLocked(path.dirname(path.resolve(home, fs.readlinkSync(file))))
    }

    return unreadable()
  }

  let targetStat: fs.Stats

  try {
    targetStat = fs.statSync(target)
  } catch (error) {
    // Gone, or locked, since realpath answered: the same refusals as if it had happened a moment earlier.
    return isLockedError(error) ? unreadable() : dangling(target)
  }

  if (!targetStat.isFile()) {
    return special(target)
  }

  if (!isInside(pinRoot(check.root), target) && check.linksOutsideRefused) {
    const guard = guardedAs(target)

    if (guard !== null) {
      return guarded(
        target,
        guard === 'never' ? 'a file the agent must never read' : 'in a folder the agent can write, so what is there is not what you were shown'
      )
    }

    return build(
      'link-outside',
      stopped =>
        `Your ${name} is a link to a file outside the agent's home (${target}), and the agent's sandbox cannot read outside its home, ${stopped}`,
      'Replace the link with a plain file',
      plainCopyCommand(file),
      target
    )
  }

  return readable(target) ? null : unreadable()
}

const isLockedError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code

  return code === 'EACCES' || code === 'EPERM'
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)

  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function linkText(file: string): string {
  try {
    return fs.readlinkSync(file)
  } catch {
    return file
  }
}

function readable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK)

    return true
  } catch {
    return false
  }
}

function plantedName(home: string, name: HomeSettingsFile, message: string): HomeSettingsFinding {
  return { command: '', file: name, kind: 'special', message, path: path.join(home, name), reason: message, target: null }
}

/** Every file judged. Refused and warned are apart because only refused stops anything. */
export function judgeHomeSettings(home: string, check: HomeSettingsCheck): HomeSettingsJudgement {
  const refused: HomeSettingsFinding[] = []
  const warned: HomeSettingsFinding[] = []

  for (const name of HOME_SETTINGS_FILES) {
    try {
      const finding = findingOf(home, name, check)

      if (finding) {
        ;(blocks(name, finding.kind, check) ? refused : warned).push(finding)
      }
    } catch (error) {
      // The home itself, or a folder on the way, is the planted name: the same sentence for every file, shown once.
      if (!isRefusedPath(error)) {
        throw error
      }

      if (!refused.some(item => item.message === error.message)) {
        refused.push(plantedName(home, name, error.message))
      }
    }
  }

  return { refused, warned }
}

/** Null when the runtime can start on what the home holds. Otherwise one line: every file that is wrong, each with its fix. */
export function homeSettingsRefusal(home: string, check: HomeSettingsCheck): null | string {
  const { refused } = judgeHomeSettings(home, check)

  return refused.length > 0 ? refused.map(finding => finding.message).join(' ') : null
}

export function homeSettingsRefusalView(home: string, check: HomeSettingsCheck): HomeSettingsRefusal | null {
  const { refused } = judgeHomeSettings(home, check)

  return refused.length > 0 ? { code: HOME_SETTINGS_REFUSED, findings: refused } : null
}

/**
 * The owner's "Replace with a copy", and nothing else calls it: the bytes of a file outside the home become readable by
 * the agent, which is why a planted link can never get here by itself. `expectedTarget` is the path the owner was shown;
 * a link that changed since then is not what they agreed to copy.
 */
export function replaceLinkWithCopy(
  home: string,
  name: HomeSettingsFile,
  expectedTarget: string,
  check: HomeSettingsCheck
): HomeSettingsReplaceResult {
  const after = () => {
    try {
      return homeSettingsRefusalView(home, check)
    } catch {
      return null
    }
  }

  const failed = (reason: Extract<HomeSettingsReplaceResult, { ok: false }>['reason']): HomeSettingsReplaceResult => ({
    ok: false,
    reason,
    refusal: after()
  })

  const file = path.join(home, name)

  try {
    if (!lstatInRoot(check.root, file)?.isSymbolicLink()) {
      return failed('not-a-link')
    }
  } catch {
    return failed('not-eligible')
  }

  const finding = judgeHomeSettings(home, check).refused.find(item => item.file === name)

  if (finding?.kind !== 'link-outside') {
    return failed('not-eligible')
  }

  if (finding.target !== expectedTarget) {
    return failed('changed')
  }

  const bytes = readPlainFileNoLinks(expectedTarget, COPY_CAP_BYTES)

  if (!Buffer.isBuffer(bytes)) {
    return failed(bytes)
  }

  try {
    replaceFileInRoot(check.root, file, bytes, 0o600)
  } catch {
    return failed('not-written')
  }

  return { ok: true, refusal: after() }
}
