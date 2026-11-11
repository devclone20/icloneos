/**
 * fx18 (F3): the two values of the user's own git config a confined `git commit` is allowed to carry — `user.name`
 * and `user.email` — read by main, which is not confined, and handed to the runtime in its spawn env
 * (`ICLONE_GIT_USER_NAME`, `ICLONE_GIT_USER_EMAIL`, popped at the plugin's import). Nothing else of `~/.gitconfig`
 * reaches the agent: that file may hold credential helpers, tokens in URLs and `[include]`s, and the sandbox keeps
 * refusing it. The read is main's own, with no git process: `/usr/bin/git` without the developer tools opens a
 * system dialog, and a `git` on PATH is a program the user's shell chose. Includes are not followed, on purpose: a
 * value the user set through one is simply not carried.
 *
 * Reads, in git's own order (later wins): `$XDG_CONFIG_HOME/git/config` (default `~/.config/git/config`), then
 * `~/.gitconfig`. Values follow git's rules: a `#` or `;` outside quotes starts a comment, quotes group, `\"` and
 * `\\` escape, surrounding blanks are dropped.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface GitIdentity {
  name: string
  email: string
}

export const EMPTY_GIT_IDENTITY: GitIdentity = Object.freeze({ name: '', email: '' })

/** fx20 (lens5 m2): the most of a name or an e-mail that travels, and the largest config file main reads. */
const IDENTITY_VALUE_MAX = 256
const CONFIG_FILE_MAX = 1024 * 1024

/** A spawn env value: no control character (a NUL makes Node refuse the whole spawn), and a bounded length. */
const identityValue = (raw: string): string => raw.replace(/\p{Cc}/gu, '').slice(0, IDENTITY_VALUE_MAX).trim()

/** The `[user]` name and e-mail of one config text; keys outside `[user]` are never read. */
export function gitIdentityFromText(text: string, into: GitIdentity = EMPTY_GIT_IDENTITY): GitIdentity {
  let inUser = false
  let name = into.name
  let email = into.email

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()

    if (!line || line.startsWith('#') || line.startsWith(';')) {continue}

    if (line.startsWith('[')) {
      // `[user]` only: `[user "x"]` is a subsection git does not use for identity, and `[users]` is another key.
      inUser = /^\[user\s*\]/i.test(line)

      continue
    }

    if (!inUser) {continue}
    const eq = line.indexOf('=')

    if (eq === -1) {continue}
    const key = line.slice(0, eq).trim().toLowerCase()

    if (key !== 'name' && key !== 'email') {continue}
    const value = identityValue(unquoteGitValue(line.slice(eq + 1)))

    if (key === 'name') {name = value}
    else {email = value}
  }

  return { name, email }
}

/** Git's value rules: comments outside quotes, quoted groups, backslash escapes, outer blanks dropped. */
export function unquoteGitValue(raw: string): string {
  let out = ''
  let quoted = false

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]

    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      i += 1

      continue
    }

    if (ch === '"') {
      quoted = !quoted

      continue
    }

    if (!quoted && (ch === '#' || ch === ';')) {break}
    out += ch
  }

  return out.trim().replace(/[\r\n]+/g, ' ')
}

/** The files git itself reads for the global scope, in its order. */
export function globalGitConfigFiles(home: string, xdgConfigHome?: string): string[] {
  const xdg = xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(home, '.config')

  return [path.join(xdg, 'git', 'config'), path.join(home, '.gitconfig')]
}

/** The identity main carries to the runtime: read from disk now (a user who edits the config gets the new values
 *  at the next runtime start), never cached, never failing: an unreadable file is a file with no identity. */
export function readGlobalGitIdentity(home: string, xdgConfigHome?: string): GitIdentity {
  let identity: GitIdentity = EMPTY_GIT_IDENTITY

  for (const file of globalGitConfigFiles(home, xdgConfigHome)) {
    let text: string

    try {
      // A link is followed, since dotfile managers make them. Non-blocking, so a FIFO cannot hang main at startup, and
      // judged on the open file itself: a regular file of this size or nothing. A link into a project only sets a name
      // the agent could set anyway.
      const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)

      try {
        const stat = fstatSync(fd)

        if (!stat.isFile() || stat.size > CONFIG_FILE_MAX) {
          continue
        }

        text = readFileSync(fd, 'utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      continue
    }

    identity = gitIdentityFromText(text, identity)
  }

  return identity
}

/** The spawn env entries for an identity; none for an empty one (the plugin then seeds nothing). */
export function gitIdentityEnv(identity: GitIdentity): Record<string, string> {
  const env: Record<string, string> = {}

  if (identity.name) {env.ICLONE_GIT_USER_NAME = identity.name}

  if (identity.email) {env.ICLONE_GIT_USER_EMAIL = identity.email}

  return env
}
