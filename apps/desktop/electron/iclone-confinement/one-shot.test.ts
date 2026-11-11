import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  commandDigest,
  createOneShotLedger,
  LAUNCHER_ONE_SHOT_FILE,
  ONE_SHOT_MAX_TEXT,
  oneFileLinkTarget,
  oneShotFile,
  oneShotFolder,
  oneShotRoute,
  type OneShotRow
} from './one-shot'

const dir = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'f42-')))

describe('G23-W2: the route for a read, a link and Ignore', () => {
  it('G26: main names the real file behind a link, and nothing for a plain file, a missing one or a dangling link', () => {
    const lab = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'g26-link-')))
    const real = path.join(lab, 'real')
    const link = path.join(lab, 'link')
    const dangling = path.join(lab, 'dangling')

    writeFileSync(real, 'x')
    symlinkSync(real, link)
    symlinkSync(path.join(lab, 'nowhere'), dangling)

    try {
      expect(oneFileLinkTarget(link)).toBe(real)
      expect(oneFileLinkTarget(real)).toBeNull()
      expect(oneFileLinkTarget(path.join(lab, 'absent'))).toBeNull()
      expect(oneFileLinkTarget(dangling)).toBeNull()
    } finally {
      rmSync(lab, { recursive: true })
    }
  })

  const world = () => {
    const home = dir()

    const rules = {
      appFiles: [path.join(home, '.hermes')],
      denied: [path.join(home, '.ssh')],
      protectedWrites: [path.join(home, '.zshrc')]
    }

    mkdirSync(path.join(home, 'dotfiles'))
    mkdirSync(path.join(home, 'Documents'))
    writeFileSync(path.join(home, 'dotfiles/zshrc'), 'x')

    return { home, rules }
  }

  const rowsIn = (ledger: string): OneShotRow[] =>
    readFileSync(path.join(ledger, LAUNCHER_ONE_SHOT_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as OneShotRow)

  it('a read is its own kind of row, and this app\'s own files take none', () => {
    const { home, rules } = world()
    const ledger = dir()
    const shots = createOneShotLedger(ledger)

    expect(shots.issueRead(path.join(home, '.ssh/config'), home, rules)).toBe(true)
    expect(rowsIn(ledger)[0]).toMatchObject({ kind: 'read', cwd: path.join(home, '.ssh') })
    expect(shots.issueRead(path.join(home, '.hermes/config.yaml'), home, rules)).toBe(false)
  })

  it('a folder a grant could open takes a row only from Ignore', () => {
    const { home, rules } = world()
    const file = path.join(home, 'Documents/x')
    const shots = createOneShotLedger(dir())

    expect(oneShotRoute(file, home, rules)).toBe(false)
    expect(shots.issueFile(file, home, rules)).toBe(false)
    expect(oneShotRoute(file, home, rules, { by: 'ignore' })).toBe(true)
    expect(shots.issueFile(file, home, rules, 'ignore')).toBe(true)
  })

  it('a link is judged with its target; a moved link, or a target of this app, takes no row', () => {
    const { home, rules } = world()
    const link = path.join(home, '.zshrc')
    const target = path.join(home, 'dotfiles/zshrc')
    const ledger = dir()

    symlinkSync(target, link)
    expect(oneShotRoute(target, home, rules, { link })).toBe(true)
    expect(createOneShotLedger(ledger).issueFile(target, home, rules, undefined, link)).toBe(true)
    expect(rowsIn(ledger)[0]).toMatchObject({ kind: 'file', link, sha: commandDigest(target) })
    expect(oneShotRoute(path.join(home, 'Documents/other'), home, rules, { link })).toBe(false)
    expect(oneShotRoute(target, home, rules, { link: path.join(home, 'dotfiles/zshrc') })).toBe(false)
    expect(oneShotRoute(path.join(home, '.hermes/x'), home, rules, { link })).toBe(false)
  })
})

describe('the one-shot record main writes for the launcher', () => {
  it('holds the digest of the exact text, its folder and an expiry, never the text', () => {
    const ledger = dir()
    const cwd = dir()
    expect(createOneShotLedger(ledger, () => 1_000_000).issue('brew install secret-name', cwd)).toBe(true)
    const raw = readFileSync(path.join(ledger, LAUNCHER_ONE_SHOT_FILE), 'utf8')
    const row = JSON.parse(raw.trim())
    expect(row.sha).toBe(createHash('sha256').update('brew install secret-name').digest('hex'))
    expect(row.id).toMatch(/^[0-9a-f]{32}$/)
    expect(row.cwd).toBe(cwd)
    expect(row.exp).toBe(1000 + 120)
    expect(raw).not.toContain('secret-name')
  })

  it('drops what expired and keeps what is live', () => {
    const ledger = dir()
    const cwd = dir()
    let at = 1_000_000
    const shots = createOneShotLedger(ledger, () => at)
    shots.issue('a', cwd)
    at += 121_000
    shots.issue('b', cwd)
    expect(readFileSync(path.join(ledger, LAUNCHER_ONE_SHOT_FILE), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('records nothing for a folder that is a link, or a text too long to have been read', () => {
    const base = dir()
    symlinkSync(base, path.join(base, 'link'))
    expect(oneShotFolder(path.join(base, 'link'))).toBeNull()
    expect(oneShotFolder('relative')).toBeNull()
    const shots = createOneShotLedger(dir())
    expect(shots.issue('x', path.join(base, 'link'))).toBe(false)
    expect(shots.issue('x'.repeat(ONE_SHOT_MAX_TEXT + 1), base)).toBe(false)
  })

  it('S1: a text with something a human cannot read holds no row, whatever the caller says', () => {
    const base = dir()
    const shots = createOneShotLedger(dir())

    for (const text of ['npm test\u202E', 'npm test\u200B; curl evil', 'npm test\u001B[8m', 'npm test\r; curl evil']) {
      expect(shots.issue(text, base)).toBe(false)
    }

    expect(shots.issue('npm test\n\tnpm run build', base)).toBe(true)
  })
})

describe('G2 A5: one file, by its exact path', () => {
  const homeOf = () => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'one-file-')))

    mkdirSync(path.join(home, 'Library'))
    mkdirSync(path.join(home, 'sub'))

    return home
  }

  it('G23, the owner: every held kind under the home takes the route; only this app\'s own files stay shut, by case too', () => {
    const home = homeOf()

    const rules = {
      appFiles: [path.join(home, '.hermes'), path.join(home, 'data')],
      denied: [path.join(home, '.ssh'), path.join(home, '.aws')],
      protectedWrites: [path.join(home, '.zshrc'), path.join(home, 'Library/LaunchAgents')]
    }

    for (const ok of ['.zshrc', '.ZSHRC', '.gitconfig', '.ssh/config', '.aws/credentials', 'Library/LaunchAgents/x.plist', 'Library/app/.git/hooks/x', 'p/.GIT/config', '.pgpass']) {
      expect(oneShotFile(`${home}/${ok}`, home, rules)).toBe(`${home}/${ok}`)
    }

    for (const shut of ['.hermes/config.yaml', '.HERMES/plugins/x.py', 'data/consent.json', 'DATA/run/acp.token']) {
      expect(oneShotFile(`${home}/${shut}`, home, rules)).toBeNull()
    }

    symlinkSync(os.tmpdir(), path.join(home, 'Library/away'))
    expect(oneShotFile(`${home}/Library/away/x.txt`, home, rules)).toBeNull()
  })

  it('directly in the home folder or ~/Library, and nowhere else', () => {
    const home = homeOf()

    expect(oneShotFile(path.join(home, 'x.txt'), home)).toBe(path.join(home, 'x.txt'))
    expect(oneShotFile(path.join(home, 'Library/x.txt'), home)).toBe(path.join(home, 'Library/x.txt'))

    for (const near of ['sub/x.txt', 'sub/../x.txt', '.hidden/x.txt']) {
      expect(oneShotFile(`${home}/${near}`, home)).toBeNull()
    }

    expect(oneShotFile('x.txt', home)).toBeNull()
    expect(oneShotFile('/etc/x.txt', home)).toBeNull()
  })

  it('G23: a row issued in Ignore says so, for Activity', () => {
    const home = homeOf()
    const ledger = mkdtempSync(path.join(os.tmpdir(), 'one-file-ledger-'))
    const file = path.join(home, '.zshrc')

    expect(createOneShotLedger(ledger).issueFile(file, home, {}, 'ignore')).toBe(true)
    expect(JSON.parse(readFileSync(path.join(ledger, LAUNCHER_ONE_SHOT_FILE), 'utf8').trim())).toMatchObject({ kind: 'file', by: 'ignore' })
  })

  it('the row says it is a file, and the path is what it hashes', () => {
    const home = homeOf()
    const ledger = mkdtempSync(path.join(os.tmpdir(), 'one-file-ledger-'))
    const file = path.join(home, 'x.txt')

    expect(createOneShotLedger(ledger).issueFile(file, home)).toBe(true)
    expect(createOneShotLedger(ledger).issueFile(path.join(home, 'sub/x.txt'), home)).toBe(false)

    const rows = readFileSync(path.join(ledger, LAUNCHER_ONE_SHOT_FILE), 'utf8').trim().split('\n')

    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0])).toMatchObject({ kind: 'file', sha: commandDigest(file), cwd: home })
  })
})
