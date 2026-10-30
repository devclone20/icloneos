import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// X1c (review R1-A round 2, residual a): a `file:` link the model wrote and the user really clicks reaches
// openExternalUrl (and an "open in browser" reaches openPreviewInBrowser). Launch Services RUNS a `.command`,
// `.terminal`, `.app` or an extensionless executable it is asked to open, so those are shown in the Finder and never
// opened; a passive document or media file still opens. Real files on disk, the real path resolver.

const h = vi.hoisted(() => ({
  log: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-user-data', isPackaged: false },
  shell: { openExternal: h.openExternal, openPath: h.openPath, showItemInFolder: h.showItemInFolder }
}))
vi.mock('./env', () => ({ IS_WSL: false }))
vi.mock('./log', () => ({ rememberLog: h.log }))

const { openExternalUrl, openPreviewInBrowser } = await import('./shell-open')

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'x1c-')))
const at = (name: string) => path.join(dir, name)

fs.writeFileSync(at('report.pdf'), '%PDF-1.4\n')
fs.writeFileSync(at('chart.PNG'), 'png')
fs.writeFileSync(at('notes.md'), '# notes\n')
fs.writeFileSync(at('page.html'), '<p>hi</p>')
fs.writeFileSync(at('run.command'), '#!/bin/sh\necho pwned\n', { mode: 0o755 })
fs.writeFileSync(at('run.terminal'), '<plist/>')
fs.writeFileSync(at('shortcut.fileloc'), '<plist/>')
fs.writeFileSync(at('payload'), '#!/bin/sh\necho pwned\n', { mode: 0o755 })
fs.mkdirSync(at('Fake.app/Contents'), { recursive: true })
fs.symlinkSync(at('run.command'), at('innocent.pdf'))

afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

beforeEach(() => {
  h.log.mockClear()
  h.openExternal.mockClear()
  h.openPath.mockClear()
  h.showItemInFolder.mockClear()
})

const url = (name: string) => pathToFileURL(at(name)).toString()

describe('openExternalUrl — a file: URL from content', () => {
  it.each(['report.pdf', 'chart.PNG', 'notes.md'])('opens the passive file %s', name => {
    expect(openExternalUrl(url(name))).toBe(true)
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(at(name))
    expect(h.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each([
    ['run.command', 'type .command'],
    ['run.terminal', 'type .terminal'],
    ['shortcut.fileloc', 'type .fileloc'],
    ['payload', 'type .(none)'],
    ['Fake.app', 'not a regular file'],
    ['page.html', 'type .html'],
    ['innocent.pdf', 'type .command'],
    ['missing.pdf', 'unreadable']
  ])('never opens %s: shows it in the Finder (%s)', (name, reason) => {
    expect(openExternalUrl(url(name))).toBe(true)
    expect(h.openPath).not.toHaveBeenCalled()
    expect(h.showItemInFolder).toHaveBeenCalledExactlyOnceWith(at(name))
    expect(h.log).toHaveBeenCalledWith(`[file] not opened (${reason}); revealed in folder instead`)
    expect(String(h.log.mock.calls[0]?.[0])).not.toContain(dir)
  })
})

describe('openPreviewInBrowser — a file: URL from a preview or an artifact', () => {
  it.each(['page.html', 'report.pdf'])('opens %s in the browser', async name => {
    await expect(openPreviewInBrowser(url(name))).resolves.toBe(true)
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(url(name))
    expect(h.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(['run.command', 'innocent.pdf', 'Fake.app', 'payload'])(
    'never opens %s: shows it in the Finder',
    async name => {
      await expect(openPreviewInBrowser(url(name))).resolves.toBe(true)
      expect(h.openExternal).not.toHaveBeenCalled()
      expect(h.showItemInFolder).toHaveBeenCalledExactlyOnceWith(at(name))
    }
  )
})
