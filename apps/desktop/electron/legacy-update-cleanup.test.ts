import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LEGACY_CLEANUP_MARKER, legacyCleanupNotice, runLegacyUpdateCleanup } from './legacy-update-cleanup'

let root = ''
let home = ''
let hermes = ''
let userData = ''
let trashDir = ''

function write(file: string, body = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** The tree the old updater left behind, plus decoys that must survive byte for byte. */
function fixture() {
  for (let i = 0; i < 14; i += 1) {
    write(path.join(hermes, 'logs', 'update_receipts', `2026-10-${String(i + 1).padStart(2, '0')}.json`), '{}')
  }

  write(path.join(hermes, 'logs', 'update_receipts', 'latest.json'), '{}')

  for (let i = 0; i < 4; i += 1) {
    write(path.join(hermes, 'backups', `pre-update-2026101${i}-0900.zip`), 'z'.repeat(1000))
  }

  write(path.join(hermes, 'backups', 'config', 'keep.yaml'), 'mine')

  for (const sha of ['abc1234', 'def5678', '0123456789abcdef0123456789abcdef01234567']) {
    write(path.join(home, '.hermes-update-backups', `hermes-agent-${sha}`, 'README.md'), 'clone')
  }

  for (const stamp of ['20261001-0900', '20261002-1000']) {
    write(path.join(home, '.hermes-update-backups', `home-state-${stamp}`, 'state.db'), 'old')
  }

  fs.symlinkSync(path.join(hermes, 'sessions'), path.join(home, '.hermes-update-backups', 'hermes-agent-feedbee'))
  write(path.join(hermes, '.update_check'), '{}')
  write(path.join(hermes, 'source-checks', 'upstream.json'), '{}')
  // Decoys.
  write(path.join(hermes, 'sessions', 'chat.json'), 'conversation')
  write(path.join(hermes, 'state.db'), 'db')
  write(path.join(hermes, 'config.yaml'), 'updates: {}')
  write(path.join(hermes, 'auth.json'), '{"token":"t"}')
  write(path.join(hermes, '.env'), 'K=V')
  write(path.join(hermes, 'hermes-agent', 'hermes_cli', '__init__.py'), "__version__ = '0.20.6'")
  write(path.join(home, '.hermes-update-backups', 'notes.txt'), 'not a clone')
}

function treeHash(dir: string): string {
  const hash = createHash('sha256')

  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name)
      const stat = fs.lstatSync(full)
      hash.update(path.relative(dir, full))

      if (stat.isDirectory()) {
        walk(full)
      } else if (stat.isFile()) {
        hash.update(fs.readFileSync(full))
      }
    }
  }

  walk(dir)

  return hash.digest('hex')
}

function decoysHash(): string {
  return ['sessions', 'hermes-agent', 'backups/config']
    .map(rel => treeHash(path.join(hermes, rel)))
    .concat(['state.db', 'config.yaml', 'auth.json', '.env'].map(f => fs.readFileSync(path.join(hermes, f), 'utf8')))
    .join('|')
}

function deps(over: Partial<Parameters<typeof runLegacyUpdateCleanup>[0]> = {}) {
  const trashed: string[] = []

  const trash = vi.fn(async (target: string) => {
    trashed.push(target)
    fs.renameSync(target, path.join(trashDir, `${trashed.length}-${path.basename(target)}`))
  })

  const lines: string[] = []

  return {
    lines,
    trash,
    trashed,
    deps: {
      appVersion: '0.0.2',
      hermesHome: hermes,
      homeDir: home,
      isPackaged: true,
      log: (line: string) => lines.push(line),
      trash,
      userData,
      ...over
    }
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cleanup-')))
  home = path.join(root, 'home')
  hermes = path.join(home, '.hermes')
  userData = path.join(root, 'userData')
  trashDir = path.join(root, 'Trash')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(trashDir, { recursive: true })
  fs.mkdirSync(hermes, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true })
})

describe('runLegacyUpdateCleanup (H1b)', () => {
  it('run 1 moves exactly the allow-listed paths to the Trash; decoys and the symlink target are untouched', async () => {
    fixture()
    const before = decoysHash()
    const run = deps()
    const summary = await runLegacyUpdateCleanup(run.deps)
    const rel = run.trashed.map(p => path.relative(home, p)).sort()

    expect(rel).toEqual(
      [
        ...Array.from(
          { length: 14 },
          (_, i) => `.hermes/logs/update_receipts/2026-10-${String(i + 1).padStart(2, '0')}.json`
        ),
        '.hermes/logs/update_receipts/latest.json',
        '.hermes/logs/update_receipts',
        ...[0, 1, 2, 3].map(i => `.hermes/backups/pre-update-2026101${i}-0900.zip`),
        '.hermes-update-backups/hermes-agent-abc1234',
        '.hermes-update-backups/hermes-agent-def5678',
        '.hermes-update-backups/hermes-agent-0123456789abcdef0123456789abcdef01234567',
        '.hermes-update-backups/home-state-20261001-0900',
        '.hermes-update-backups/home-state-20261002-1000',
        '.hermes/.update_check',
        '.hermes/source-checks/upstream.json'
      ].sort()
    )
    expect(summary).toMatchObject({ failed: 0, moved: 27, result: 'moved' })
    expect(decoysHash()).toBe(before)
    expect(fs.lstatSync(path.join(home, '.hermes-update-backups', 'hermes-agent-feedbee')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(home, '.hermes-update-backups', 'notes.txt'))).toBe(true)
    expect(run.lines.some(line => /skipped symlink/.test(line))).toBe(true)
    expect(run.lines.some(line => /moved 27 items \(.+\) to the Trash/.test(line))).toBe(true)
    expect(legacyCleanupNotice(summary)).toMatch(/^Old update backups \(.+\) were moved to the Trash\.$/)

    const marker = JSON.parse(fs.readFileSync(path.join(userData, LEGACY_CLEANUP_MARKER), 'utf8'))
    expect(marker).toMatchObject({ attempts: 1, failed: [], v: 1, version: '0.0.2' })
    expect(marker.removed).toHaveLength(27)

    const again = deps()
    await expect(runLegacyUpdateCleanup(again.deps)).resolves.toMatchObject({ result: 'done' })
    expect(again.trash).not.toHaveBeenCalled()
  })

  it('an empty HOME: nothing moved, the marker still written, no toast', async () => {
    const run = deps()
    const summary = await runLegacyUpdateCleanup(run.deps)
    expect(summary).toEqual({ bytes: 0, failed: 0, moved: 0, result: 'nothing' })
    expect(run.trash).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(userData, LEGACY_CLEANUP_MARKER))).toBe(true)
    expect(legacyCleanupNotice(summary)).toBeNull()
  })

  it('never runs unpackaged (the lab) or while a runtime update runs', async () => {
    fixture()
    const dev = deps({ isPackaged: false })
    await expect(runLegacyUpdateCleanup(dev.deps)).resolves.toMatchObject({ result: 'skipped' })
    expect(dev.trash).not.toHaveBeenCalled()
    const busy = deps({ runtimeBusy: () => true })
    await expect(runLegacyUpdateCleanup(busy.deps)).resolves.toMatchObject({ result: 'skipped' })
    expect(busy.trash).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(userData, LEGACY_CLEANUP_MARKER))).toBe(false)
  })

  it('a trash failure leaves the marker not final and is retried on the next launch, at most 3 attempts', async () => {
    fixture()
    const failing = deps()
    failing.trash.mockImplementation(async (target: string) => {
      if (target.endsWith('.update_check')) {
        throw new Error('Operation not permitted')
      }

      fs.renameSync(target, path.join(trashDir, `${Math.random()}-${path.basename(target)}`))
    })
    await expect(runLegacyUpdateCleanup(failing.deps)).resolves.toMatchObject({ failed: 1, result: 'partial' })
    expect(JSON.parse(fs.readFileSync(path.join(userData, LEGACY_CLEANUP_MARKER), 'utf8')).failed).toHaveLength(1)

    const retry = deps()
    await expect(runLegacyUpdateCleanup(retry.deps)).resolves.toMatchObject({ failed: 0, moved: 1, result: 'moved' })
    expect(retry.trashed.map(p => path.basename(p))).toEqual(['.update_check'])
    const marker = JSON.parse(fs.readFileSync(path.join(userData, LEGACY_CLEANUP_MARKER), 'utf8'))
    expect(marker).toMatchObject({ attempts: 2, failed: [] })
    expect(marker.removed).toHaveLength(27)

    fs.writeFileSync(
      path.join(userData, LEGACY_CLEANUP_MARKER),
      JSON.stringify({ attempts: 3, failed: [{ path: 'x' }], v: 1 })
    )
    const capped = deps()
    await expect(runLegacyUpdateCleanup(capped.deps)).resolves.toMatchObject({ result: 'done' })
    expect(capped.trash).not.toHaveBeenCalled()
  })
})
