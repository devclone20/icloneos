import { beforeEach, describe, expect, it, vi } from 'vitest'

// R14: the persona runtime block carries ONE skills line (progressive disclosure: names live in
// <available_skills>, never here). Exercised through a real re-registration of a stored persona.
const config = vi.hoisted(() => ({ personalities: {} as Record<string, { system_prompt: string }> }))

vi.mock('@/api/config', () => ({
  getHermesConfigRecord: vi.fn(async () => ({ agent: { personalities: config.personalities } })),
  saveHermesConfig: vi.fn(async (patch: { agent: { personalities: Record<string, { system_prompt: string }> } }) => {
    Object.assign(config.personalities, patch.agent.personalities)
  })
}))

vi.mock('@/api/profiles', () => ({
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  getProfileSoul: vi.fn(async () => {
    throw new Error('404')
  }),
  updateProfileSoul: vi.fn()
}))

vi.mock('@/store/profile', () => ({ refreshProfiles: vi.fn(async () => undefined) }))

const { setPersonaDeactivation } = await import('@/app/home/inft-profile')
const { RUNTIME_SKILLS } = await import('@/app/settings/skills-settings-model')

const SKILLS_LINE =
  '- Skills: the <available_skills> index lists them; open one with skill_view only when the task matches its line; do not browse skills. Before a step that needs a permission the owner may have off, load `consent`.'

const STORED = [
  '# Soul',
  'I am seven.',
  '',
  '## iclone os runtime (written by the app on every selection — not part of the soul)',
  '- You are iNFT #7 (i01 #7) inside the iclone os desktop app.',
  '- To act on it, run the Virtuals CLI ONLY as `~/.iclone-os/bin/acp --inft robinhood-0xabc-7 <command…> --json` in your terminal.',
  ''
].join('\n')

const count = (text: string, needle: string) => text.split(needle).length - 1

beforeEach(() => {
  config.personalities = { 'p-7': { system_prompt: STORED } }
  window.localStorage.clear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    icloneOwnership: { promptHeaderWritten: vi.fn(async () => 1) }
  }
})

describe('R14 — the runtime block names the skills index exactly once', () => {
  it('a re-registered persona carries the one skills line, ≤ 240 B, without skill names', async () => {
    await setPersonaDeactivation('p-7', 'transferred at block 90')

    const prompt = config.personalities['p-7'].system_prompt

    expect(count(prompt, SKILLS_LINE)).toBe(1)
    expect(Buffer.byteLength(SKILLS_LINE)).toBeLessThanOrEqual(240)
    expect(prompt).not.toContain('acp-offerings')
  })

  it('names every skill the pane calls runtime-named (RUNTIME_SKILLS), each exactly once', async () => {
    await setPersonaDeactivation('p-7', null)

    const prompt = config.personalities['p-7'].system_prompt

    for (const name of RUNTIME_SKILLS) {
      expect(count(prompt, `\`${name}\``), name).toBe(1)
    }
  })

  it('never stacks: registering twice still leaves one line', async () => {
    await setPersonaDeactivation('p-7', 'transferred at block 90')
    await setPersonaDeactivation('p-7', null)
    await setPersonaDeactivation('p-7', 'transferred at block 91')

    expect(count(config.personalities['p-7'].system_prompt, SKILLS_LINE)).toBe(1)
  })
})
