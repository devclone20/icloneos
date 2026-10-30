#!/usr/bin/env node
// Copies the ONE policy source (the site's legal/icloneos-privacy.html) into iclone/legal/ and derives
// policy-version.json + electron/policy-version.generated.ts from it. The version and effective date are
// PARSED from the `p-meta` line, never typed. Usage:
//   node scripts/sync-legal.mjs [--from <site html>] [--check]
// --check writes nothing and exits 1 when the bundled copy or a derived file drifts from the source.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const REPO = path.resolve(DESKTOP, '..', '..')
const LEGAL_DIR = path.join(REPO, 'iclone', 'legal')
const HTML_NAME = 'icloneos-privacy.html'
const GENERATED = path.join(DESKTOP, 'electron', 'policy-version.generated.ts')
export const POLICY_URL = 'https://cloneframe.io/privacy/'
// The repo sits next to the site checkout in the owner's project tree; override with --from or ICLONE_SITE_LEGAL.
const DEFAULT_SOURCE = path.resolve(
  REPO,
  '..',
  '..',
  '021 - ALL_PROJECT_icloneOS_iNFT_2026',
  'CLONEFRAME_SITE',
  'legal',
  HTML_NAME
)

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

// The §9 table rows, in table order, mapped to the consent.json keys.
export const PERMISSION_KEYS = {
  Microphone: 'microphone',
  'Screen recording': 'screen',
  'Automation (Apple Events)': 'automation',
  'Local network': 'localNetwork',
  'Files and folders': 'files',
  Notifications: 'notifications',
  Clipboard: 'clipboard',
  Keychain: 'keychain'
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsaquo: '›', middot: '·' }

export function decodeText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)

        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }

      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseMeta(html) {
  const meta = /<p class="p-meta">([\s\S]*?)<\/p>/.exec(html)
  const match = meta && /Effective (\d{1,2}) ([A-Za-z]+) (\d{4}) · Version ([\d.]+)/.exec(decodeText(meta[1]))

  if (!match) {
    throw new Error('sync-legal: no `Effective <d> <Month> <yyyy> · Version <n>` in p-meta')
  }

  const [, day, monthName, year, version] = match
  const month = MONTHS.indexOf(monthName) + 1

  if (month < 1) {
    throw new Error(`sync-legal: unknown month "${monthName}" in p-meta`)
  }

  const title = /<h1 id="policyTitle">([\s\S]*?)<\/h1>/.exec(html)

  return {
    version,
    effective: `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`,
    effectiveLabel: `${Number(day)} ${monthName} ${year}`,
    title: title ? decodeText(title[1]) : 'icloneOS Policies & Privacy'
  }
}

function section(html, id) {
  const start = html.indexOf(`<h2 id="${id}">`)

  if (start < 0) {
    throw new Error(`sync-legal: section ${id} is missing`)
  }

  const next = html.indexOf('<h2 ', start + 1)

  return html.slice(start, next < 0 ? undefined : next)
}

export function parseShortVersion(html) {
  return [...section(html, 'pp-short').matchAll(/<li><b>([\s\S]*?)<\/b>([\s\S]*?)<\/li>/g)].map(m => ({
    lead: decodeText(m[1]),
    text: decodeText(m[2])
  }))
}

export function parsePermissions(html) {
  const body = section(html, 'pp-permissions')
  const intro = /<p>([\s\S]*?)<\/p>/.exec(body)

  const rows = [...body.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)].map(m => {
    const name = decodeText(m[1])
    const key = PERMISSION_KEYS[name]

    if (!key) {
      throw new Error(`sync-legal: §9 row "${name}" has no consent key — add it to PERMISSION_KEYS and the app`)
    }

    return { key, name, purpose: decodeText(m[2]) }
  })

  return { intro: intro ? decodeText(intro[1]) : '', rows }
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function policyIds(html) {
  return [...html.matchAll(/id="(pp-[a-z]+)"/g)].map(m => m[1])
}

export function derive(html) {
  if (/<script/i.test(html)) {
    throw new Error('sync-legal: the policy fragment must not contain <script>')
  }

  const meta = parseMeta(html)
  const permissions = parsePermissions(html)

  return {
    json: { ...meta, url: POLICY_URL, sha256: sha256(html) },
    generated: {
      ...meta,
      url: POLICY_URL,
      sha256: sha256(html),
      short: parseShortVersion(html),
      permissionsIntro: permissions.intro,
      permissions: permissions.rows
    }
  }
}

async function renderGenerated(policy) {
  const { default: prettier } = await import('prettier')
  const options = (await prettier.resolveConfig(GENERATED)) ?? {}

  const source =
    '// GENERATED by apps/desktop/scripts/sync-legal.mjs from iclone/legal/icloneos-privacy.html. Do not edit.\n' +
    `export const BUNDLED_POLICY = ${JSON.stringify(policy, null, 2)} as const\n`

  return prettier.format(source, { ...options, parser: 'typescript' })
}

async function main(argv) {
  const fromIndex = argv.indexOf('--from')
  const source = fromIndex >= 0 ? argv[fromIndex + 1] : process.env.ICLONE_SITE_LEGAL || DEFAULT_SOURCE
  const check = argv.includes('--check')

  if (!source || !existsSync(source)) {
    throw new Error(`sync-legal: policy source not found (${source || 'none'}); pass --from <site html>`)
  }

  const html = readFileSync(source, 'utf8')
  const { generated, json } = derive(html)

  const outputs = [
    [path.join(LEGAL_DIR, HTML_NAME), html],
    [path.join(LEGAL_DIR, 'policy-version.json'), `${JSON.stringify(json, null, 2)}\n`],
    [GENERATED, await renderGenerated(generated)]
  ]

  if (check) {
    const drift = outputs.filter(([file, data]) => !existsSync(file) || readFileSync(file, 'utf8') !== data)

    for (const [file] of drift) {
      console.error(`sync-legal: ${path.relative(REPO, file)} drifted from the policy source`)
    }

    return drift.length ? 1 : 0
  }

  mkdirSync(LEGAL_DIR, { recursive: true })

  for (const [file, data] of outputs) {
    writeFileSync(file, data)
  }

  console.log(`sync-legal: policy v${json.version} (${json.effective}) sha256 ${json.sha256.slice(0, 12)}`)

  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      console.error(error.message)
      process.exit(1)
    }
  )
}
