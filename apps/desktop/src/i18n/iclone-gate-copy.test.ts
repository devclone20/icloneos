import { describe, expect, test } from 'vitest'

import { TRANSLATIONS } from './catalog'
import type { Locale } from './types'

/**
 * V3-S r3 (m-e): the permission-gate copy in every locale. The gate can be installed and still not active (disabled
 * via config, not armed), so no title may say "not installed" (round 1 m3 fixed pt-PT only; the Arabic title still
 * said it). The Open-in-terminal backstop toast is the locale's own text, never main's English reason.
 */
const INSTALLED: Record<Locale, RegExp> = {
  ar: /مثب/,
  en: /install/i,
  ja: /インストール|配置/,
  'pt-PT': /instalad/i,
  zh: /安装|就位/,
  'zh-hant': /安裝|就位/
}

const STAY_SHUT: Record<Locale, string> = {
  ar: 'تبقى ملفات هذا التطبيق مغلقة',
  en: "this app's own files stay shut",
  ja: 'このアプリ自身のファイルは閉じたまま',
  'pt-PT': 'os ficheiros desta app ficam fechados',
  zh: '此应用自身的文件保持关闭',
  'zh-hant': '此應用程式本身的檔案保持關閉'
}

// G23: the extra line, shown when the path is one your shell, git or launchd runs from, or holds keys.
const READ_THE_PATH: Record<Locale, string> = {
  ar: 'اقرأ المسار قبل أن تسمح',
  en: 'Read the path before you allow',
  ja: '許可する前にパスを確認してください',
  'pt-PT': 'Leia o caminho antes de permitir',
  zh: '允许前请先阅读路径',
  'zh-hant': '允許前請先閱讀路徑'
}

// G23 minor 2: with the Seatbelt off the file tool writes these too, so the sentence is bound to it.
const WHILE_ON: Record<Locale, string> = {
  ar: 'ما دام Seatbelt مفعّلًا',
  en: 'While the Seatbelt is on',
  ja: 'Seatbelt がオンの間は',
  'pt-PT': 'Enquanto o Seatbelt estiver ligado',
  zh: 'Seatbelt 开启时',
  'zh-hant': 'Seatbelt 開啟時'
}

// G23 minor 4: store/permissions.ts: session, then the project's own mode, then this default.
const OR_ITS_PROJECTS: Record<Locale, string> = {
  ar: 'ولا لمشروعها',
  en: "or its project's",
  ja: 'そのプロジェクトにも',
  'pt-PT': 'nem do seu projeto',
  zh: '及其项目',
  'zh-hant': '及其專案'
}

const locales = Object.keys(TRANSLATIONS) as Locale[]

describe('the permission-gate copy', () => {
  // fx22 (F-d), G22 B4: Allow writes the file, but not everywhere, so the sheet says before the click that some places stay shut.
  test.each(locales)('%s: the outside-the-project effect says some places stay shut even after Allow', locale => {
    const effect = TRANSLATIONS[locale].settings.permissions.ask.effects.Wo

    expect(effect).toContain(STAY_SHUT[locale])
  })

  test.each(locales)('%s: G23 the owner: the sheet says what stays shut and when, and warns on a file that runs later', locale => {
    const ask = TRANSLATIONS[locale].settings.permissions.ask

    expect(ask.effects.Wo).toContain(STAY_SHUT[locale])
    expect(ask.effects.Wo).toContain(WHILE_ON[locale])
    expect(ask.heldFile).toContain(READ_THE_PATH[locale])
    expect(ask.heldFile).toContain('launchd')
  })

  test.each(locales)('%s: G24 a patch sheet says it reads before it writes', locale => {
    const reads = { en: 'reads', 'pt-PT': 'lê', zh: '读取', 'zh-hant': '讀取', ja: '読み取', ar: 'يقرأ' } as Record<string, string>

    expect(TRANSLATIONS[locale].settings.permissions.ask.outsideFilePatch).toContain(reads[locale])
  })

  test.each(locales)('%s: G23 the default names the project, which comes before it', locale => {
    expect(TRANSLATIONS[locale].settings.permissions.scope.standingNote).toContain(OR_ITS_PROJECTS[locale])
  })

  // fx22: "Reading is free" was false: a confined command cannot read a sibling folder (read_file says the same).
  test.each(locales)('%s: Manual does not say reading is unrestricted', locale => {
    const summary = TRANSLATIONS[locale].settings.permissions.modes.manual.summary

    expect(summary).not.toMatch(/Reading is free|Ler é livre|القراءة حرة|読み取りは自由|读取不受限制|讀取不受限制/)
    // Every locale names the limit: the folder the command runs in.
    expect(summary).toMatch(/folder|pasta|مجلد|フォルダー|文件夹|資料夾/)
  })

  // G102 panel B M1: the agent writes its own iNFT profile (SOUL, memories, its folder) with no ask in every mode,
  // Plan included, so neither Plan nor Manual may say it changes nothing or asks before every write without that word.
  test.each(locales)('%s: Plan and Manual name the agent’s own iNFT profile', locale => {
    const { plan, manual } = TRANSLATIONS[locale].settings.permissions.modes

    for (const summary of [plan.summary, manual.summary]) {
      expect(summary).toContain('iNFT')
      expect(summary).toContain('SOUL')
    }

    for (const readOnly of ['Read-only', 'Só leitura', 'للقراءة فقط', '読み取り専用', '只读', '唯讀']) {
      expect(plan.summary).not.toContain(readOnly)
    }
  })

  // U-1: the composer menu's short line carries the same promise: Plan's never says read-only, Ignore's says it asks
  // about nothing, and none of them is the full summary.
  test.each(locales)('%s: the mode shorts keep the gate promises', locale => {
    const { ignore, plan, manual, automatic, acceptEdits } = TRANSLATIONS[locale].settings.permissions.modes

    for (const readOnly of ['Read-only', 'read only', 'Só leitura', 'للقراءة فقط', '読み取り専用', '只读', '唯讀', '只讀']) {
      expect(plan.short).not.toContain(readOnly)
    }

    for (const { short, summary } of [ignore, plan, manual, automatic, acceptEdits]) {
      expect(short.length).toBeGreaterThan(0)
      expect(short.length).toBeLessThan(summary.length)
    }
  })

  test('the English shorts', () => {
    const { ignore, plan, manual, automatic, acceptEdits } = TRANSLATIONS.en.settings.permissions.modes

    expect([ignore.short, manual.short, automatic.short, plan.short, acceptEdits.short]).toEqual([
      'Never asks',
      'Asks before acting',
      'Edits, runs safe commands',
      'Reads and plans',
      'Edits without asking'
    ])
  })

  test('the English Plan and Manual words', () => {
    const { plan, manual } = TRANSLATIONS.en.settings.permissions.modes

    expect(plan.summary).toBe('Reads and plans in the chat. It changes nothing but its own iNFT profile (SOUL, memories, its folder).')
    expect(manual.summary).toContain(
      'Asks before every write outside its own iNFT profile (SOUL, memories, its folder) and before every command, network call, message, install and deletion. '
    )
  })

  test('every locale is covered', () => {
    expect(locales.sort()).toEqual((Object.keys(INSTALLED) as Locale[]).sort())
  })

  test.each(locales)('%s: the gate title says the gate is not active, never that it is not installed', locale => {
    const { gateTitle } = TRANSLATIONS[locale].boot.failure

    expect(gateTitle).not.toMatch(INSTALLED[locale])
    expect(gateTitle.length).toBeGreaterThan(5)

    if (locale !== 'en') {
      expect(gateTitle).not.toBe(TRANSLATIONS.en.boot.failure.gateTitle)
    }
  })

  test.each(locales.filter(locale => locale !== 'en'))(
    '%s: the Open-in-terminal refusal is translated, and carries no gate mark',
    locale => {
      const { openInTerminal, openInTerminalGateRefused } = TRANSLATIONS[locale].sidebar.row

      expect(openInTerminalGateRefused).not.toBe(TRANSLATIONS.en.sidebar.row.openInTerminalGateRefused)
      expect(openInTerminal).not.toBe(TRANSLATIONS.en.sidebar.row.openInTerminal)
      expect(openInTerminalGateRefused).not.toContain('[iclone-gate]')
    }
  )

  test.each(locales)(
    '%s: m-g — the unmanaged-runtime hint names the git checkout and the locale’s own Repair label',
    locale => {
      const { gateHintUnmanaged, repairInstall } = TRANSLATIONS[locale].boot.failure

      expect(gateHintUnmanaged).toContain('git')
      expect(gateHintUnmanaged).toContain('Hermes')
      expect(gateHintUnmanaged).toContain(repairInstall)
      expect(gateHintUnmanaged).not.toContain('[iclone-gate')

      if (locale !== 'en') {
        expect(gateHintUnmanaged).not.toBe(TRANSLATIONS.en.boot.failure.gateHintUnmanaged)
      }
    }
  )

  test('pt-PT: European Portuguese, formal (no gerúndio, no "você", "aplicação" not "app")', () => {
    const { gateHintUnmanaged } = TRANSLATIONS['pt-PT'].boot.failure

    expect(gateHintUnmanaged).not.toMatch(/ando\b|endo\b|indo\b|você|\bapp\b|arquivo|usuário/i)
    expect(gateHintUnmanaged).toMatch(/a sua/)
  })
})
