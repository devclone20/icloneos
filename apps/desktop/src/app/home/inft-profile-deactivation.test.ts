import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({
  personalities: {} as Record<string, unknown>,
  failRead: false,
  saves: [] as { slug: string; prompt: string }[]
}))

const profiles = vi.hoisted(() => ({ souls: {} as Record<string, string> }))

vi.mock('@/api/config', () => ({
  getHermesConfigRecord: vi.fn(async () => {
    if (config.failRead) {
      throw new Error('gateway down')
    }

    return { agent: { personalities: config.personalities } }
  }),
  saveHermesConfig: vi.fn(async (patch: { agent: { personalities: Record<string, { system_prompt: string }> } }) => {
    for (const [slug, v] of Object.entries(patch.agent.personalities)) {
      config.saves.push({ slug, prompt: v.system_prompt })
      config.personalities[slug] = { system_prompt: v.system_prompt }
    }
  })
}))

vi.mock('@/api/profiles', () => ({
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  getProfileSoul: vi.fn(async (slug: string) => {
    if (!(slug in profiles.souls)) {
      throw new Error('404')
    }

    return { content: profiles.souls[slug] }
  }),
  updateProfileSoul: vi.fn()
}))

vi.mock('@/store/profile', () => ({ refreshProfiles: vi.fn(async () => undefined) }))

const { DEACTIVATION_HEADING, setPersonaDeactivation, splitStoredPrompt } = await import('./inft-profile')

const promptHeaderWritten = vi.fn(async () => 1)

const RUNTIME = [
  '',
  '## iclone os runtime (written by the app on every selection — not part of the soul)',
  '- You are iNFT #7 (i01 #7) inside the iclone os desktop app. Your EconomyOS lives here.',
  '- To act on it, run the Virtuals CLI ONLY as `~/.iclone-os/bin/acp --inft robinhood-0xabc-7 <command…> --json` in your terminal.',
  ''
].join('\n')

const NOTICE = 'transferred at block 90, tx 0xcd'
const headers = (text: string) => text.split(DEACTIVATION_HEADING).length - 1

beforeEach(() => {
  config.personalities = {}
  config.failRead = false
  config.saves = []
  profiles.souls = {}
  promptHeaderWritten.mockClear()
  window.localStorage.clear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    icloneOwnership: { promptHeaderWritten }
  }
})

describe('R9 r3 — the deactivation header without a soul cached this session', () => {
  it('splits a stored prompt back into the soul, the ACP slug and the name', () => {
    const parts = splitStoredPrompt(`# Soul\nI am seven.${RUNTIME}`)

    expect(parts).toEqual({
      soul: '# Soul\nI am seven.',
      acpSlug: 'robinhood-0xabc-7',
      name: 'i01 #7',
      hadHeader: false
    })
  })

  it('after a restart: reads the stored system_prompt, adds the header once, keeps the runtime block, reports', async () => {
    config.personalities['p-7'] = { system_prompt: `# Soul\nI am seven.${RUNTIME}` }

    await setPersonaDeactivation('p-7', NOTICE)

    expect(config.saves).toHaveLength(1)
    const written = config.saves[0].prompt
    expect(written.startsWith('# Soul\nI am seven.\n')).toBe(true)
    expect(headers(written)).toBe(1)
    expect(written).toContain(NOTICE)
    expect(written).toContain('--inft robinhood-0xabc-7 <command')
    expect(written.indexOf(DEACTIVATION_HEADING)).toBeLessThan(written.indexOf('## iclone os runtime'))
    expect(promptHeaderWritten).toHaveBeenCalledWith('p-7')

    // the same notice again: settled, no second write
    await setPersonaDeactivation('p-7', NOTICE)
    expect(config.saves).toHaveLength(1)
  })

  it('an old header in the stored prompt is replaced, never stacked', async () => {
    config.personalities['p-8'] = {
      system_prompt: `# Soul${'\n'}${DEACTIVATION_HEADING}\n- old notice\n${RUNTIME}`
    }

    await setPersonaDeactivation('p-8', NOTICE)

    expect(headers(config.saves[0].prompt)).toBe(1)
    expect(config.saves[0].prompt).not.toContain('old notice')
  })

  it('no personality entry (ghost card): the profile SOUL.md carries the header', async () => {
    profiles.souls['p-9'] = 'Soul of nine'

    await setPersonaDeactivation('p-9', NOTICE)

    expect(config.saves[0].prompt.startsWith('Soul of nine')).toBe(true)
    expect(headers(config.saves[0].prompt)).toBe(1)
    expect(promptHeaderWritten).toHaveBeenCalledWith('p-9')
  })

  it('a persona that does not exist (or a tombstone) is a no-op that does not report', async () => {
    config.personalities['p-11'] = { system_prompt: '' }

    await setPersonaDeactivation('p-10', NOTICE)
    await setPersonaDeactivation('p-11', NOTICE)

    expect(config.saves).toHaveLength(0)
    expect(promptHeaderWritten).not.toHaveBeenCalled()
  })

  it('a failed config read reports nothing and is retried on the next view change', async () => {
    config.personalities['p-12'] = { system_prompt: `Soul 12${RUNTIME}` }
    config.failRead = true

    await setPersonaDeactivation('p-12', NOTICE)
    expect(config.saves).toHaveLength(0)
    expect(promptHeaderWritten).not.toHaveBeenCalled()

    config.failRead = false
    await setPersonaDeactivation('p-12', NOTICE)
    expect(config.saves).toHaveLength(1)
    expect(promptHeaderWritten).toHaveBeenCalledWith('p-12')
  })

  it('a held persona with no stored header is not rewritten; a stale header is cleared without a report', async () => {
    config.personalities['p-13'] = { system_prompt: `Soul 13${RUNTIME}` }
    config.personalities['p-14'] = { system_prompt: `Soul 14\n${DEACTIVATION_HEADING}\n- x\n${RUNTIME}` }

    await setPersonaDeactivation('p-13', null)
    await setPersonaDeactivation('p-14', null)

    expect(config.saves.map(s => s.slug)).toEqual(['p-14'])
    expect(headers(config.saves[0].prompt)).toBe(0)
    expect(config.saves[0].prompt).toContain('--inft robinhood-0xabc-7')
    expect(promptHeaderWritten).not.toHaveBeenCalled()
  })

  it('concurrent view updates for one slug write once', async () => {
    config.personalities['p-15'] = { system_prompt: `Soul 15${RUNTIME}` }

    await Promise.all([setPersonaDeactivation('p-15', NOTICE), setPersonaDeactivation('p-15', NOTICE)])

    expect(config.saves).toHaveLength(1)
  })
})
