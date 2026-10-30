import { expect, test } from 'vitest'

import { redactPaneTokens } from './redact'

test('a pane token in scrollback is masked; other text is untouched', () => {
  const token = `v1.${'a1'.repeat(16)}.${'0f'.repeat(32)}`
  const text = `ICLONE_PANE_TOKEN=${token}\nICLONE_PANE_NAME=a\nv1.short.token`

  expect(redactPaneTokens(text)).toBe('ICLONE_PANE_TOKEN=v1.[pane token hidden]\nICLONE_PANE_NAME=a\nv1.short.token')
  expect(redactPaneTokens(`${token} ${token}`)).not.toContain('0f0f')
})

test('L-3: a token a full-screen program draws across two rows is masked, and the row count is kept', () => {
  const mac = '0f'.repeat(32)
  const screen = `ICLONE_PANE_TOKEN=v1.${'a1'.repeat(16)}.${mac.slice(0, 20)}   \n${mac.slice(20)}\n:q`

  expect(redactPaneTokens(screen)).toBe('ICLONE_PANE_TOKEN=v1.[pane token hidden]\n\n:q')
})
