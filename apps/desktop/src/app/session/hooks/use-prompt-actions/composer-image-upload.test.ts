import { beforeEach, expect, test, vi } from 'vitest'

import { uploadComposerAttachment } from './index'

const USER_DATA = '/Users/me/Library/Application Support/icloneOS'
const png = 'data:image/png;base64,iVBORw0KGgo='

const requestGateway = vi.fn(async (method: string, _params?: unknown) =>
  method === 'image.attach_bytes' || method === 'image.attach' ? { attached: true, path: '/h/images/x.png' } : {}
)

const attach = (path: string) =>
  uploadComposerAttachment(
    { id: path, kind: 'image', label: 'x.png', path },
    { remote: false, requestGateway: requestGateway as never, sessionId: 's1' }
  )

beforeEach(() => {
  requestGateway.mockClear()
  window.hermesDesktop = {
    ...window.hermesDesktop,
    readFileDataUrl: vi.fn(async () => png),
    readFileDataUrlForAttach: vi.fn(async () => png)
  } as typeof window.hermesDesktop
})

// The Seatbelt denies the runtime the app's own data folder whole, so a path there is "image not found" to it. The app
// reads those bytes itself and hands them over; the live row `rec.model_gets` found this.
test.each([
  `${USER_DATA}/composer-images/composer_2026_ab12.png`,
  `${USER_DATA}/composer-images/screen/2026-rec/screen-t003s.png`
])('an image in the app data folder travels as bytes: %s', async path => {
  await attach(path)

  expect(requestGateway.mock.calls[0][0]).toBe('image.attach_bytes')
  expect(requestGateway.mock.calls[0][1]).toMatchObject({ content_base64: 'iVBORw0KGgo=', session_id: 's1' })
})

test('the large reader is used, so a native-size frame is not stopped at the preview limit', async () => {
  await attach(`${USER_DATA}/composer-images/screen/2026-rec/screen-t003s.png`)

  expect(window.hermesDesktop.readFileDataUrlForAttach).toHaveBeenCalled()
  expect(window.hermesDesktop.readFileDataUrl).not.toHaveBeenCalled()
})

test('an image the runtime can read itself still goes by path', async () => {
  await attach('/Users/me/Pictures/cat.png')

  expect(requestGateway.mock.calls[0][0]).toBe('image.attach')
})
