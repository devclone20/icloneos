import { describe, expect, it } from 'vitest'

import { confirmIgnoreNatively } from './ignore-dialog'

async function detail(scope: string, key: null | string) {
  let options: { detail?: string } = {}

  const dialog = {
    showMessageBox: async (...args: unknown[]) => {
      options = args.at(-1) as { detail?: string }

      return { response: 0 }
    }
  }

  await confirmIgnoreNatively(dialog as never, null, 'en', { key, scope })

  return options.detail ?? ''
}

describe('G20: the once-only Ignore alert', () => {
  it('a session scope opens with the words, not the session id', async () => {
    const text = await detail('session', '20261106_065306_792cd2')

    expect(text).not.toContain('20261106_065306_792cd2')
    expect(text.startsWith('Your agent stops asking about anything.')).toBe(true)
  })

  it('a project scope still names its folder', async () => {
    expect((await detail('project', '/Users/me/proj')).startsWith('/Users/me/proj\n')).toBe(true)
  })

  it('says that it shows once', async () => {
    expect((await detail('session', 'x')).endsWith('This alert shows once. After this, Ignore is one touch anywhere: a session, a project or the default for new sessions. Whatever is waiting for your answer when you turn it on goes through at once.')).toBe(true)
  })
})
