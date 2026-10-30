// V3-F2 F2-12 — Settings › Agent › Permissions › Functions: the 9 × 6 matrix, the gesture marker on every cell, the
// strings in every shipped catalogue, and the frozen design (no new colour, radius or shadow literal).
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IclonePermissionsBridge } from '@/components/consent/types'
import { arPermissions } from '@/i18n/ar/permissions'
import { enPermissions } from '@/i18n/en/enPermissions'
import { jaPermissions } from '@/i18n/ja/permissions'
import { ptPtPermissions } from '@/i18n/pt-PT/permissions'
import { zhHantPermissions } from '@/i18n/zh-hant/permissions'
import { zhPermissions } from '@/i18n/zh/permissions'
import { FUNCTION_COPY, functionCopyFor, raiseConfirmText } from '@/iclone-shared/permission-function-copy'
import {
  FUNCTION_LEVELS,
  type FunctionLevels,
  PERMISSION_FUNCTIONS,
  type PermissionStateView,
  type SetFunctionLevelResultView
} from '@/iclone-shared/permissions'
import { $permissions } from '@/store/permissions'

import { PermissionsPane } from './permissions-pane'

const LEVELS = Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, 'mode'])) as FunctionLevels

const STATE: PermissionStateView = {
  sealed: true,
  unconfirmed: [],
  mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-10-21T00:00:00.000Z' },
  grants: [],
  functions: { ...LEVELS, payments: 'ignore', email: 'manual' },
  fnGrants: [
    {
      id: 'fg-1',
      fn: 'shopping',
      scope: 'session',
      sessionId: 's1',
      project: null,
      createdAt: '2026-10-21T00:00:00.000Z'
    }
  ],
  ceilings: {
    terminal: 'on',
    fileWriting: 'on',
    webBrowsing: 'undecided',
    automation: 'on',
    screen: 'on',
    clipboard: 'on',
    installSoftware: 'on',
    scheduledTasks: 'on',
    sendMessages: 'on',
    spendTrade: 'off'
  },
  chain: { ok: true, records: 3, gaps: 0 },
  integrity: [],
  project: null,
  enforcement: 'enforced'
}

function fakeBridge(results: SetFunctionLevelResultView[] = [], state: PermissionStateView = STATE) {
  const bridge: IclonePermissionsBridge = {
    setMode: vi.fn(async () => ({ ok: true as const, mode: 'manual' as const, scope: 'standing' as const })),
    revoke: vi.fn(async () => true),
    setFunctionLevel: vi.fn(
      async () => results.shift() ?? { ok: true as const, fn: 'email' as const, level: 'mode' as const, raised: true }
    ),
    hermesApproval: vi.fn(async () => 'deny' as const),
    state: vi.fn(async () => state),
    tail: vi.fn(async () => []),
    onChanged: vi.fn(() => () => undefined)
  }

  Object.assign(window, {
    hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneConsent: { permissions: bridge } }
  })

  return bridge
}

afterEach(() => $permissions.set({ status: 'loading', state: null, records: [] }))

const copy = enPermissions.functions

describe('V3-F2 — the Functions matrix', () => {
  it('an unsealed policy says so and keeps every cell clickable; a sealed one says nothing', async () => {
    // Owner's decision (2026-10-25): the Keychain switch and the matrix are independent. The cells must stay usable
    // and the choice is kept — but the matrix has to say that nothing wider than Manual is in force yet, or a marked
    // level reads as a level that is doing something.
    fakeBridge([], { ...STATE, sealed: false })
    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(copy.functions.payments.name)).toBeTruthy())

    expect(window.document.querySelector('[data-permission-unsealed]')?.textContent).toBe(copy.unsealed)

    const cells = [...window.document.querySelectorAll('[data-perm-fn-level]')]

    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every(cell => !cell.hasAttribute('disabled'))).toBe(true)

    cleanup()
    fakeBridge([], { ...STATE, sealed: true })
    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(copy.functions.payments.name)).toBeTruthy())
    expect(window.document.querySelector('[data-permission-unsealed]')).toBeNull()
  })

  it('a level chosen unsealed reads as pending after the restart, and clicking it asks main to confirm it (review s4, M1)', async () => {
    const bridge = fakeBridge([], { ...STATE, sealed: true, unconfirmed: ['payments'] })

    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(copy.functions.payments.name)).toBeTruthy())

    expect(window.document.querySelector('[data-permission-unconfirmed]')?.textContent).toBe(
      copy.unconfirmed(copy.functions.payments.name)
    )

    const pending = window.document.querySelector(
      '[data-permission-function="payments"] [data-perm-fn-level="ignore"]'
    ) as HTMLElement

    expect(pending.hasAttribute('data-perm-unconfirmed')).toBe(true)
    // What is in force on that row (Manual) is marked too, so the dimmed choice is not read as the rule in force.
    expect(
      window.document
        .querySelector('[data-permission-function="payments"] [data-perm-fn-level="manual"]')
        ?.hasAttribute('data-perm-in-force')
    ).toBe(true)
    expect(pending.getAttribute('aria-label')).toBe(
      copy.levelPendingAria(copy.functions.payments.name, copy.levels.ignore.name)
    )
    await act(async () => {
      fireEvent.click(pending)
    })
    expect(bridge.setFunctionLevel).toHaveBeenCalledWith({ fn: 'payments', level: 'ignore' })

    // A confirmed row's marked cell stays inert: nothing to confirm there.
    const email = window.document.querySelector(
      '[data-permission-function="email"] [data-perm-fn-level="manual"]'
    ) as HTMLElement

    expect(email.hasAttribute('data-perm-unconfirmed')).toBe(false)

    const callsBefore = vi.mocked(bridge.setFunctionLevel).mock.calls.length

    await act(async () => {
      fireEvent.click(email)
    })
    // No call of any kind (critic A, s4: naming one argument set would miss a call with any other).
    expect(vi.mocked(bridge.setFunctionLevel).mock.calls.length).toBe(callsBefore)
  })

  it('nine rows × six levels; every cell is a radio carrying the gesture marker; main’s level is the checked one', async () => {
    fakeBridge()
    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(copy.functions.payments.name)).toBeTruthy())

    const rows = [...window.document.querySelectorAll('[data-permission-function]')]

    expect(rows.map(row => row.getAttribute('data-permission-function'))).toEqual([...PERMISSION_FUNCTIONS])

    for (const row of rows) {
      const cells = [...row.querySelectorAll('[data-perm-fn-level]')]

      expect(cells.map(cell => cell.getAttribute('data-perm-fn-level'))).toEqual([...FUNCTION_LEVELS])
      expect(
        cells.every(cell => cell.hasAttribute('data-perm-mode-confirm') && cell.getAttribute('role') === 'radio')
      ).toBe(true)

      const fn = row.getAttribute('data-permission-function') as keyof FunctionLevels
      const checked = cells.filter(cell => cell.getAttribute('aria-checked') === 'true')

      expect(checked.map(cell => cell.getAttribute('data-perm-fn-level'))).toEqual([STATE.functions[fn]])
    }
  })

  it('a click asks main for exactly that function and level; the window decides nothing itself', async () => {
    const bridge = fakeBridge()

    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-function="trading"]')).toBeTruthy())
    await act(async () => {
      fireEvent.click(
        window.document.querySelector('[data-permission-function="trading"] [data-perm-fn-level="askOnce"]')!
      )
    })
    expect(bridge.setFunctionLevel).toHaveBeenCalledWith({ fn: 'trading', level: 'askOnce' })
    expect($permissions.get().state?.functions.trading).toBe('mode')
  })

  it('a refusal for want of a gesture is said; Cancel on the system dialog says nothing', async () => {
    fakeBridge([
      { ok: false, error: 'gesture', message: 'x' },
      { ok: false, error: 'confirm', message: 'x' }
    ])
    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-function="files"]')).toBeTruthy())
    await act(async () => {
      fireEvent.click(
        window.document.querySelector('[data-permission-function="files"] [data-perm-fn-level="ignore"]')!
      )
    })
    expect(screen.getByRole('alert').textContent).toBe(copy.refused.gesture)
    await act(async () => {
      fireEvent.click(
        window.document.querySelector('[data-permission-function="files"] [data-perm-fn-level="ignore"]')!
      )
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('R2-m6: a switch OFF that a row can meet says those actions stay refused', async () => {
    fakeBridge()
    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-function="payments"]')).toBeTruthy())

    const capped = (fn: string) =>
      window.document.querySelector(`[data-permission-function="${fn}"] [data-permission-capped]`)

    // R2-m6: Spend & trade OFF reaches every row (a shell line's class brings its switch to every row it touches)
    for (const fn of ['email', 'payments', 'shell', 'files', 'publish']) {
      expect(capped(fn)?.textContent, fn).toBe(copy.capped)
      expect(capped(fn)?.getAttribute('data-permission-capped')).toBe('off')
    }
  })

  it('R2-m6: an undecided switch a row can meet says the row asks first; a row no switch caps says nothing', async () => {
    const bridge = fakeBridge()

    bridge.state = vi.fn(async () => ({ ...STATE, ceilings: { ...STATE.ceilings, spendTrade: 'on' as const } }))
    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-function="publish"]')).toBeTruthy())

    const capped = (fn: string) =>
      window.document.querySelector(`[data-permission-function="${fn}"] [data-permission-capped]`)

    // Web browsing undecided: only the Network publish row meets it
    expect(capped('publish')?.textContent).toBe(copy.cappedUndecided)
    expect(capped('publish')?.getAttribute('data-permission-capped')).toBe('undecided')
    expect(capped('email')).toBeNull()
    expect(capped('shell')).toBeNull()
  })

  it('a function grant is listed with a marked Revoke', async () => {
    const bridge = fakeBridge()

    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-function="payments"]')).toBeTruthy())

    const grant = screen.getByText(copy.grantFor(copy.functions.shopping.name))

    expect(grant).toBeTruthy()

    const revoke = screen.getByRole('button', { name: enPermissions.grants.revoke })

    expect(revoke.hasAttribute('data-perm-mode-confirm')).toBe(true)
    fireEvent.click(revoke)
    expect(bridge.revoke).toHaveBeenCalledWith('fg-1')
  })
})

describe('V3-F2 — strings in every shipped catalogue, and the native confirm', () => {
  const catalogues = {
    en: enPermissions,
    ar: arPermissions,
    ja: jaPermissions,
    zh: zhPermissions,
    'zh-hant': zhHantPermissions,
    'pt-PT': ptPtPermissions
  }

  it('every catalogue fills every function, level, column and dialog line; translations are not English', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const fc = catalogue.functions

      expect(fc).toBe(FUNCTION_COPY[locale as keyof typeof FUNCTION_COPY])

      for (const fn of PERMISSION_FUNCTIONS) {
        expect(fc.functions[fn].name.length).toBeGreaterThan(0)
        expect(fc.functions[fn].detail.length).toBeGreaterThan(0)
      }

      for (const level of FUNCTION_LEVELS) {
        expect(fc.levels[level].name.length).toBeGreaterThan(0)
        expect(fc.levels[level].summary.length).toBeGreaterThan(0)
        expect(fc.columns[level].length).toBeGreaterThan(0)
        expect(fc.dialog.lifts[level].length).toBeGreaterThan(0)

        if (locale !== 'en') {
          expect(fc.levels[level].summary).not.toBe(copy.levels[level].summary)
        }
      }

      // The never list no longer promises "every payment asks" (decision 10): spending is a row now.
      expect(catalogue.floor.items).toHaveLength(6)
    }
  })

  it('R3-N: the note states the rule — every money row and both message rows by name, Shell, and code', () => {
    for (const catalogue of Object.values(catalogues)) {
      const fc = catalogue.functions

      const named = (['payments', 'trading', 'shopping', 'acp', 'email', 'messaging', 'shell'] as const).map(
        fn => fc.functions[fn].name
      )

      for (const name of named) {
        expect(fc.touchNote).toContain(name)
      }
    }

    expect(copy.touchNote).toContain('all four money rows together')
    expect(copy.touchNote).toContain('Code is decided by Shell')
  })

  it('the native confirm names the function and the OLD → NEW level, in the system locale', () => {
    const text = raiseConfirmText('en-US', { fn: 'payments', from: 'askAlways', to: 'ignore' })

    expect(text.title).toBe('Payments: Ask always → Ignore?')
    expect(text.detail).toContain(copy.dialog.lifts.ignore)
    expect(text.confirm).toBe(copy.dialog.confirm)
    // Ruling 59: a hidden OS language reads English.
    expect(functionCopyFor('zh-TW')).toBe(FUNCTION_COPY.en)
    expect(functionCopyFor('zh-CN')).toBe(FUNCTION_COPY.en)
    expect(functionCopyFor('pt-PT')).toBe(FUNCTION_COPY['pt-PT'])
    expect(functionCopyFor('pt')).toBe(FUNCTION_COPY['pt-PT'])
    expect(raiseConfirmText('pt-PT', { fn: 'payments', from: 'askAlways', to: 'ignore' }).title).toBe(
      'Pagamentos: Perguntar sempre → Ignorar?'
    )
  })

  it('V3-T3: pt-PT keeps one word per concept with the rest of the catalogue, and the raise confirm reads natively', () => {
    const pt = FUNCTION_COPY['pt-PT']

    const words = [
      JSON.stringify(pt),
      pt.levelAria('E-mail', pt.levels.manual.name),
      pt.grantFor('E-mail'),
      pt.dialog.title('E-mail', pt.levels.mode.name, pt.levels.ignore.name)
    ].join('\n')

    // "desktop app" is "aplicação para computador" (V3-T m2); a Privacy switch is ativado/desativado, as on the
    // Privacy page; "checkout" and the "se vê que" / "continua a nunca" calques stay out.
    expect(words).not.toMatch(/secretária|desligad|\bligar\b|checkout|se vê que|continua a nunca|em todos os níveis/i)
    expect(pt.refused.unavailable).toContain('aplicação para computador do')
    expect(ptPtPermissions.modes.ignore.name).toBe('Ignorar permissões')
    expect(pt.capped).toContain('está desativado')
    expect(pt.cappedUndecided).toContain('por definir')
    // critic m2: the subject stays the agent, the switch is "definido" (not "until it sets it")
    expect(pt.cappedUndecided).toContain('até ser definido, o agente pergunta-lhe primeiro nessas ações')
    expect(raiseConfirmText('pt-PT', { fn: 'payments', from: 'askAlways', to: 'ignore' }).detail).toBe(
      [
        'Está a dar mais liberdade ao seu agente nesta área. A partir de agora, o agente vai:',
        '• atuar sempre sem lhe perguntar',
        '',
        'Mesmo assim, nunca fará o que o iclone os recusa em qualquer nível, e um interruptor desativado por si em Privacidade continua a recusar.'
      ].join('\n')
    )
  })

  it('V3-T3 (critic m3): the pt-PT ask headers are the level names, with no shorthand', () => {
    const pt = FUNCTION_COPY['pt-PT']

    expect(pt.columns.askOnce).toBe(pt.levels.askOnce.name)
    expect(pt.columns.askAlways).toBe(pt.levels.askAlways.name)
    expect(Object.values(pt.columns).join(' ')).not.toMatch(/\d×/)
  })

  it('V3-T3 (critic m5): a level change reads old → new, and right-to-left in Arabic', () => {
    for (const locale of ['en', 'ja', 'pt-PT'] as const) {
      expect(FUNCTION_COPY[locale].change('F', 'A', 'B')).toBe('F: A → B')
    }

    expect(FUNCTION_COPY.zh.change('F', 'A', 'B')).toBe('F：A → B')
    expect(FUNCTION_COPY['zh-hant'].change('F', 'A', 'B')).toBe('F：A → B')
    // ar reads right to left: the arrow points from the old level to the new one, as in its dialog title
    expect(FUNCTION_COPY.ar.change('F', 'A', 'B')).toBe('F: A ← B')
    expect(FUNCTION_COPY.ar.dialog.title('F', 'A', 'B')).toContain('A ← B')
  })

  it('frozen design: the new files carry no colour, radius, shadow or z literal', () => {
    const files = ['function-matrix.tsx', '../../iclone-shared/permission-function-copy.ts']
    const literal = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|\brounded(-[a-z0-9[\]-]+)?\b|\bshadow-|\bz-\d|\bz-\[/i

    for (const file of files) {
      expect(readFileSync(path.join(__dirname, file), 'utf8').match(literal)).toBeNull()
    }
  })
})
