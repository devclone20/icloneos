/**
 * V3-FX FX-7 — main's half of "Save a diagnostics report" (src/iclone-shared/diagnostics-file.ts). Main composes the
 * text itself (the renderer only hands the short "what failed" context, which is redacted like everything else),
 * shows the same text in the preview and writes it, 0600, only to the file the owner chose. Nothing here touches the
 * network: icloneOS 0.0.3 never uploads diagnostics.
 */
import path from 'node:path'

import {
  DIAGNOSTICS_CONTEXT_MAX,
  type DiagnosticsFileView,
  type DiagnosticsPartId,
  type DiagnosticsSaveResult
} from '../src/iclone-shared/diagnostics-file'

import { redactReportText } from './iclone-doctor'
import { writeFileAtomicSync } from './lib/atomic-write'

/** The most recent app-log lines the report carries. */
const LOG_LINES = 200

export interface DiagnosticsFileDeps {
  home: string
  /** m4 / r3: this Mac's names (host name, short name, ComputerName, LocalHostName, user name — they often carry the
   *  owner's name); each is replaced, any case. */
  machineNames?: () => readonly string[]
  appVersion: string
  /** The doctor's last report lines (already redacted by the doctor), or null when it never ran. */
  report(): readonly string[] | null
  /** The app's recent log lines (main's in-memory buffer). */
  logs(): readonly string[]
  now(): Date
  /** The owner's choice of file (a native save dialog), or null when they cancelled. */
  chooseFile(suggestedName: string): Promise<string | null>
  write?(file: string, text: string): void
}

const stamp = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function contextOf(input: unknown): string {
  const raw = input && typeof input === 'object' ? (input as { errorContext?: unknown }).errorContext : undefined

  return typeof raw === 'string' ? raw.slice(0, DIAGNOSTICS_CONTEXT_MAX).trim() : ''
}

const WALLET = /\b0x[a-fA-F0-9]{40}\b/g
const PRIVY_DID = /\bdid:privy:[A-Za-z0-9]+/g
/** r3: a bare hex key or digest (no 0x), 32 hex characters or more. */
const BARE_HEX = /\b[0-9a-fA-F]{32,}\b/g
/** r3: a Solana (base58) address: 32 to 44 characters of the base58 alphabet, with a digit and a letter in it. */
const SOLANA = /\b(?=[1-9A-HJ-NP-Za-km-z]*\d)(?=[1-9A-HJ-NP-Za-km-z]*[A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
/** r3: MAC addresses (before IPv6: a colon MAC also looks like an address). */
const MAC = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g
/** r3: IPv6 — four or more groups, or any compressed (`::`) form. Times (12:30:45, three groups) are left alone. */
const IPV6_FULL = /\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b/g

const IPV6_COMPRESSED =
  /(?<![\w:])(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?(?![\w:])/g

/** r4: an IPv4-mapped / -compatible IPv6 (`::ffff:192.168.1.5`): removed whole, before the plain IPv6 forms. */
const IPV4_MAPPED = /(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,6}\d{1,3}(?:\.\d{1,3}){3}\b/g

/** r4/r5: a Privy user id without its `did:privy:` prefix — exactly Privy's cuid shape, "c" and 24 lowercase letters
 *  and digits with both in it, standing alone (not inside a longer identifier, a path or a checksum). */
const PRIVY_BARE =
  /(?<![A-Za-z0-9_./-])c(?=[a-z0-9]{24}(?![A-Za-z0-9_-]))(?=[a-z0-9]*\d)(?=[0-9]*[a-z])[a-z0-9]{24}(?![A-Za-z0-9_-])/g

/** RFC1918, Tailscale/CGNAT (100.64.0.0/10) and link-local (169.254/16) IPv4. */
const LAN_IP =
  /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|169\.254)\.\d{1,3}\.\d{1,3}\b/g

export interface MacNameSources {
  hostname: string
  username: string
  platform: NodeJS.Platform
  /** One `scutil --get <key>` / `id -F` read, async; null when it is not there. Never synchronous on main. */
  read(file: string, args: readonly string[]): Promise<string | null>
}

const APOSTROPHES = /['\u2018\u2019\u02bc`]/g

/**
 * r3 / r4: every name this Mac goes by, for the report's redaction — the host name and its short form, the user name,
 * the owner's full name and first name (`id -F`), and on macOS ComputerName, LocalHostName and HostName — each also as
 * it is written with a straight, curly or no apostrophe, and the name before "'s" ("Zorba's MacBook Pro" → "Zorba").
 * Read at the first preview or save and kept in memory only for the session; never written anywhere.
 */
/** r5: the names are read once per session (a memo around collectMacNames); the result stays in memory only. */
export function macNamesOnce(collect: () => Promise<string[]>): () => Promise<string[]> {
  let once: Promise<string[]> | null = null

  return () => (once ??= collect())
}

export async function collectMacNames(sources: MacNameSources): Promise<string[]> {
  const read = (file: string, args: readonly string[]) => sources.read(file, args).catch(() => null)

  const macOnly =
    sources.platform === 'darwin'
      ? await Promise.all(
          ['ComputerName', 'LocalHostName', 'HostName'].map(key => read('/usr/sbin/scutil', ['--get', key]))
        )
      : []

  const fullName = await read('/usr/bin/id', ['-F'])

  const names = [
    sources.hostname,
    sources.hostname.replace(/\.local$/i, ''),
    sources.username,
    ...macOnly,
    fullName,
    fullName?.trim().split(/\s+/)[0],
    // r5: the last name alone too.
    fullName?.trim().split(/\s+/).at(-1)
  ].filter((name): name is string => typeof name === 'string' && name.trim().length > 0)

  const variants = names.flatMap(name => {
    const trimmed = name.trim()
    const owner = /^(.+?)['\u2018\u2019\u02bc`]?s\s/i.exec(trimmed)?.[1]

    return [
      trimmed,
      trimmed.replace(APOSTROPHES, "'"),
      trimmed.replace(APOSTROPHES, '\u2019'),
      trimmed.replace(APOSTROPHES, ''),
      trimmed.replace(/\s+/g, '-'),
      trimmed.replace(APOSTROPHES, '').replace(/\s+/g, '-'),
      ...(owner && /['\u2018\u2019\u02bc`]s\s/.test(trimmed) ? [owner] : [])
    ]
  })

  return [...new Set(variants)].filter(name => name.length >= 3)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * m4 / r3: what the doctor's redaction leaves that still names the owner — wallets (EVM and Solana), Privy ids, bare
 * hex keys, LAN / Tailscale / link-local / IPv6 / MAC addresses, and the Mac's names (host name, its short form,
 * ComputerName, LocalHostName, the user name), any case.
 */
export function redactIdentity(text: string, names: readonly string[] = []): string {
  let out = text
    .replace(WALLET, '[wallet]')
    .replace(PRIVY_DID, '[privy-id]')
    .replace(MAC, '[mac-address]')
    .replace(IPV4_MAPPED, '[ipv6]')
    // r4: a run of colon groups is an address only with a hex letter or a 4-digit group: 12:30:45:678 stays a time.
    .replace(IPV6_FULL, found => (/[a-fA-F]/.test(found) || /(?:^|:)\d{4}(?::|$)/.test(found) ? '[ipv6]' : found))
    .replace(IPV6_COMPRESSED, '[ipv6]')
    .replace(LAN_IP, '[lan-ip]')
    .replace(BARE_HEX, '[hex]')
    .replace(SOLANA, '[address]')
    .replace(PRIVY_BARE, '[privy-id]')

  const words = [...new Set(names.map(name => name.trim()).filter(name => name.length >= 3))].sort(
    (a, b) => b.length - a.length
  )

  // r5: whole words only (Unicode letters and digits around a name are part of another word): "Rob" never garbles
  // "problem" or "robot", which would also reveal the name by inference.
  for (const word of words) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu'), '[this-mac]')
  }

  return out
}

/** Pure: the file's text and its parts. Every line goes through the doctor's redaction. */
export function composeDiagnosticsFile(
  deps: Pick<DiagnosticsFileDeps, 'appVersion' | 'home' | 'logs' | 'machineNames' | 'now' | 'report'>,
  input: unknown
): DiagnosticsFileView {
  const redact = (lines: readonly string[]) =>
    redactIdentity(redactReportText(lines.join('\n'), deps.home), deps.machineNames?.() ?? [])
      .split('\n')
      .filter(line => line.trim() !== '')

  const now = deps.now()

  const sections: { id: DiagnosticsPartId; title: string; lines: string[] }[] = [
    { id: 'report' as const, title: 'Diagnostics report', lines: redact(deps.report() ?? []) },
    { id: 'context' as const, title: 'What failed', lines: redact(contextOf(input) ? [contextOf(input)] : []) },
    { id: 'logs' as const, title: 'Recent app log', lines: redact(deps.logs().slice(-LOG_LINES)) }
  ].filter(section => section.lines.length > 0)

  const text = [
    `icloneOS ${deps.appVersion} diagnostics, ${now.toISOString()}`,
    'Secrets, keys, tokens, e-mail addresses and the home folder were removed. Nothing was uploaded.',
    ...sections.flatMap(section => ['', `## ${section.title}`, ...section.lines])
  ].join('\n')

  return {
    parts: sections.map(section => ({ id: section.id, lines: section.lines.length })),
    text: `${text}\n`,
    suggestedName: `icloneos-diagnostics-${stamp(now)}.txt`
  }
}

export function diagnosticsFileHandlers(deps: DiagnosticsFileDeps) {
  const write = deps.write ?? ((file: string, text: string) => writeFileAtomicSync(file, text, { mode: 0o600 }))

  return {
    preview: (input: unknown): DiagnosticsFileView => composeDiagnosticsFile(deps, input),
    save: async (input: unknown): Promise<DiagnosticsSaveResult> => {
      const view = composeDiagnosticsFile(deps, input)
      const file = await deps.chooseFile(view.suggestedName)

      if (!file) {
        return { ok: false, canceled: true }
      }

      try {
        write(file, view.text)

        return { ok: true, name: path.basename(file) }
      } catch (error) {
        return { ok: false, error: redactReportText(error instanceof Error ? error.message : String(error), deps.home) }
      }
    }
  }
}
