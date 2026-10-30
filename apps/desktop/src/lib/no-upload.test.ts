/**
 * Ruling 47 (V3-FX M3): no path from the desktop uploads diagnostics, logs or pastes to a third party. The runtime's
 * `/debug` (paste.rs, or Nous storage with `nous`) is the local report on desktop, every exec route refuses a command
 * that would upload, and no shipped renderer or main source names an upload endpoint.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NO_UPLOAD_SLASH_TEXT, uploadsDiagnostics } from '@/iclone-shared/no-upload'

import { resolveDesktopCommand } from './desktop-slash-commands'

const DESKTOP = join(__dirname, '..', '..')

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : /\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : []
  )

describe('ruling 47: no diagnostics upload from the desktop', () => {
  it('/debug in any form is the local report action, never the runtime exec', () => {
    expect(resolveDesktopCommand('/debug')?.surface).toEqual({ kind: 'action', action: 'diagnostics' })
    expect(resolveDesktopCommand('/debug')?.description).toMatch(/nothing is uploaded/)
  })

  it('a command that would upload is recognised in every spelling; /debug local and other commands are not', () => {
    for (const [name, arg] of [
      ['debug', ''],
      ['/debug', 'nous'],
      ['DEBUG', 'share'],
      ['debug', 'NOUS please']
    ]) {
      expect(uploadsDiagnostics(name, arg), `${name} ${arg}`).toBe(true)
    }

    expect(uploadsDiagnostics('debug', 'local')).toBe(false)
    expect(uploadsDiagnostics('version', '')).toBe(false)
    expect(NO_UPLOAD_SLASH_TEXT).toMatch(/Save report/)
  })

  it('the exec route refuses an uploading command before any slash.exec or command.dispatch', () => {
    const slash = readFileSync(join(DESKTOP, 'src/app/session/hooks/use-prompt-actions/slash.ts'), 'utf8')
    const runExec = slash.slice(slash.indexOf('async function runExec('))
    const guard = runExec.indexOf('if (uploadsDiagnostics(name, arg)) {')

    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(runExec.indexOf("'slash.exec'"))
    expect(guard).toBeLessThan(runExec.indexOf("'command.dispatch'"))

    // slash.ts is the only renderer module that talks to slash.exec / command.dispatch.
    // Every renderer request to slash.exec / command.dispatch: slash.ts (guarded above) and the goal store's fixed
    // `goal status` read. A new caller fails here until it is guarded too.
    const talkers = files(join(DESKTOP, 'src'))
      .filter(file => !file.endsWith('.generated.ts'))
      .filter(file =>
        /request(?:Gateway)?(?:<[^>]*>)?\(\s*['"](slash\.exec|command\.dispatch)['"]/.test(readFileSync(file, 'utf8'))
      )
      .map(file => relative(DESKTOP, file))
      .sort()

    expect(talkers).toEqual(['src/app/session/hooks/use-prompt-actions/slash.ts', 'src/store/goals.ts'])
    expect(readFileSync(join(DESKTOP, 'src/store/goals.ts'), 'utf8')).toMatch(
      /'slash\.exec', \{ command: 'goal status'/
    )
  })

  it('no renderer, main or script source names a paste service or a diagnostics upload endpoint', () => {
    const pattern =
      /paste\.rs|dpaste\.com|diagnostics\.share_nous|share_to_nous|\/api\/ops\/debug-share|upload_to_pastebin/

    const offenders = [...files(join(DESKTOP, 'src')), ...files(join(DESKTOP, 'electron'))]
      .filter(file => !file.endsWith('runtime-contract.generated.ts'))
      .filter(file => pattern.test(readFileSync(file, 'utf8')))
      .map(file => relative(DESKTOP, file))

    expect(offenders).toEqual([])
  })
})
