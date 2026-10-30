// REL-6 item 5: installing the ACP tools is an `I` (install) action under V3-F. The owner's own click (main's gesture
// verdict) and a record in V3-F's audit come before anything is fetched; the agent has no path to it.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { AcpTools } from './installer'
import { requestInstall } from './ipc'

function fakeTools(state: 'absent' | 'installing' = 'absent') {
  const install = vi.fn(async () => ({
    ok: true as const,
    view: { state: 'installed' as const, cliVersion: '1.0.38', sealed: true, packages: 2, installedAt: 'now' }
  }))

  return {
    install,
    tools: { cliVersion: () => '1.0.38', view: () => ({ state, cliVersion: '1.0.38' }), install } as unknown as AcpTools
  }
}

describe('requestInstall — gesture, then audit, then install', () => {
  it('without the owner’s click: refused, recorded as refused, nothing installed', async () => {
    const { tools, install } = fakeTools()
    const audit = vi.fn(() => ({}))

    expect(await requestInstall({ tools, audit }, false)).toMatchObject({ ok: false, error: 'gesture' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refuse', gesture: false }))
    expect(install).not.toHaveBeenCalled()
  })

  it('with it: recorded (class I via recordInstall) BEFORE the install starts', async () => {
    const { tools, install } = fakeTools()
    const order: string[] = []
    const audit = vi.fn(() => (order.push('audit'), {}))

    install.mockImplementation(async () => {
      order.push('install')

      return {
        ok: true,
        view: { state: 'installed', cliVersion: '1.0.38', sealed: true, packages: 2, installedAt: 'now' }
      }
    })
    expect(await requestInstall({ tools, audit }, true)).toMatchObject({ ok: true })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'use', gesture: true }))
    expect(order).toEqual(['audit', 'install'])
  })

  it('no audit (the authority is not up): refused, nothing installed', async () => {
    const { tools, install } = fakeTools()

    expect(await requestInstall({ tools, audit: () => null }, true)).toMatchObject({ ok: false, error: 'audit' })
    expect(install).not.toHaveBeenCalled()
  })

  it('an install already running: busy', async () => {
    const { tools, install } = fakeTools('installing')

    expect(await requestInstall({ tools, audit: () => ({}) }, true)).toMatchObject({ ok: false, error: 'busy' })
    expect(install).not.toHaveBeenCalled()
  })
})

describe('the agent cannot trigger the install', () => {
  const electronDir = path.join(__dirname, '..')
  const source = (rel: string) => readFileSync(path.join(electronDir, rel), 'utf8')

  it('the agent’s socket (iclone-acp-ipc.ts) and the consent door never reach the installer', () => {
    for (const rel of ['iclone-acp-ipc.ts', 'iclone-consent-door.ts', 'iclone-permissions/socket-verb.ts']) {
      expect({
        rel,
        reaches: /iclone-acp-tools|requestInstall|acp-tools:install|installAcp/.test(source(rel))
      }).toEqual({
        rel,
        reaches: false
      })
    }
  })

  it('the only install entry points are the two window channels, both behind main’s gesture verdict', () => {
    const callers = readdirSync(electronDir, { recursive: true, encoding: 'utf8' })
      .filter(rel => rel.endsWith('.ts') && !rel.endsWith('.test.ts') && !rel.includes('fixture'))
      .filter(rel => /requestInstall\(|tools\.install\(\)|\.install\(\)\s*$/m.test(source(rel)))
      .sort()

    expect(callers).toEqual(['iclone-acp-tools/ipc.ts', 'iclone-acp.ts'])
    expect(source('iclone-acp-tools/ipc.ts')).toMatch(
      /handle\('iclone:acp-tools:install', \(event, input\) => requestInstall\(deps, deps\.gestureOk\(event, input\)\)\)/
    )
    expect(source('iclone-acp.ts')).toMatch(
      /handle\('iclone:acp-install', \(event, input\) => installAcp\(deps\.gestureOk\?\.\(event, input\) === true\)\)/
    )
  })
})
