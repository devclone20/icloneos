/**
 * V3-FX FX-7: the diagnostics flow never uploads. It asks main for the redacted report, shows it, has main write it to
 * a file the owner chooses, and "Report an issue" opens the public repository's new-issue page with a title only.
 * No gateway request and no fetch happen anywhere in the flow.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import {
  $sendDiagnostics,
  dismissSendDiagnostics,
  reportIssue,
  requestSendDiagnostics,
  saveDiagnosticsReport
} from '@/store/send-diagnostics'

const VIEW = {
  parts: [
    { id: 'report' as const, lines: 12 },
    { id: 'context' as const, lines: 1 },
    { id: 'logs' as const, lines: 40 }
  ],
  text: 'icloneOS 0.0.3 diagnostics\n## Diagnostics report\n...',
  suggestedName: 'icloneos-diagnostics-20261022-1200.txt'
}

const original = window.hermesDesktop

function stubDoctor(save: () => Promise<unknown>) {
  const doctor = {
    diagnosticsPreview: vi.fn(async () => VIEW),
    diagnosticsSave: vi.fn(save)
  }

  const openExternal = vi.fn(async (_url: string) => undefined)

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { ...original, icloneDoctor: doctor, openExternal }
  })

  return { doctor, openExternal }
}

let gatewayRequest: ReturnType<typeof vi.fn>
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  gatewayRequest = vi.fn()
  $gateway.set({ request: gatewayRequest } as never)
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  // No network call from the diagnostics flow, in any test of this file.
  expect(gatewayRequest).not.toHaveBeenCalled()
  expect(fetchSpy).not.toHaveBeenCalled()
  dismissSendDiagnostics()
  $gateway.set(null as never)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
  vi.restoreAllMocks()
})

describe('FX-7: the diagnostics report is saved to a file, never uploaded', () => {
  it('opens with the parts main says the report holds (redacted by main), error context passed along', async () => {
    const { doctor } = stubDoctor(async () => ({ ok: true, name: VIEW.suggestedName }))

    requestSendDiagnostics('turn failed: provider 500')
    expect($sendDiagnostics.get()?.phase).toBe('loading')
    await vi.waitFor(() => expect($sendDiagnostics.get()?.phase).toBe('preview'))
    expect(doctor.diagnosticsPreview).toHaveBeenCalledWith({ errorContext: 'turn failed: provider 500' })
    expect($sendDiagnostics.get()?.view).toEqual(VIEW)
  })

  it('Save asks main (native save dialog) and shows the file name; nothing else happens', async () => {
    const { doctor } = stubDoctor(async () => ({ ok: true, name: VIEW.suggestedName }))

    requestSendDiagnostics()
    await vi.waitFor(() => expect($sendDiagnostics.get()?.phase).toBe('preview'))
    await saveDiagnosticsReport()
    expect(doctor.diagnosticsSave).toHaveBeenCalledWith({})
    expect($sendDiagnostics.get()).toMatchObject({ phase: 'saved', savedName: VIEW.suggestedName })
  })

  it('cancelling the save dialog keeps the preview; a failed write shows the error', async () => {
    stubDoctor(async () => ({ ok: false, canceled: true }))
    requestSendDiagnostics()
    await vi.waitFor(() => expect($sendDiagnostics.get()?.phase).toBe('preview'))
    await saveDiagnosticsReport()
    expect($sendDiagnostics.get()?.phase).toBe('preview')

    stubDoctor(async () => ({ ok: false, error: 'EACCES' }))
    await saveDiagnosticsReport()
    expect($sendDiagnostics.get()).toMatchObject({ phase: 'error', error: 'EACCES' })
  })

  it('a preview that lands after the dialog closed writes nothing', async () => {
    stubDoctor(async () => ({ ok: true, name: 'x' }))
    requestSendDiagnostics()
    dismissSendDiagnostics()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect($sendDiagnostics.get()).toBeNull()
  })

  it('Report an issue opens the public new-issue page with a title only', () => {
    const { openExternal } = stubDoctor(async () => ({ ok: true, name: 'x' }))

    reportIssue('Problem report from icloneOS')
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/devclone20/icloneos/issues/new?title=Problem%20report%20from%20icloneOS'
    )
    const url = new URL(openExternal.mock.calls[0][0] as string)

    expect([...url.searchParams.keys()]).toEqual(['title'])
  })
})

describe('FX-7: the upstream diagnostics upload is gone from shipped code', () => {
  const ROOT = join(__dirname, '..', '..')

  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : /\.(ts|tsx|mjs|js|cjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
          ? [join(dir, entry.name)]
          : []
    )

  it('no renderer or main source names the upload endpoints (the generated runtime type list is types only)', () => {
    const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'electron'))]
      .filter(file => !file.endsWith('runtime-contract.generated.ts'))
      .filter(file =>
        /diagnostics\.share_nous|\/api\/ops\/debug-share|debug_share|share_nous/.test(readFileSync(file, 'utf8'))
      )
      .map(file => relative(ROOT, file))

    expect(offenders).toEqual([])
  })
})
