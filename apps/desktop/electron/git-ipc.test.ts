import assert from 'node:assert/strict'

import { beforeEach, describe, test, vi } from 'vitest'

const { handlers, ops } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  ops: {
    reviewRevParse: vi.fn(async () => 'abc123'),
    reviewCommit: vi.fn(async () => ({ ok: true })),
    reviewPush: vi.fn(async () => ({ ok: true })),
    reviewCreatePr: vi.fn(async () => ({ ok: true }))
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => ({})) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn))
  }
}))
vi.mock('./git-review-ops', async importOriginal => ({ ...(await importOriginal<object>()), ...ops }))

import { registerGitIpc } from './git-ipc'
import { createAppSenderGuard } from './ipc-sender-guard'

const INDEX = '/app/dist/index.html'
const mainFrame = { url: `file://${INDEX}` }
const appWindow = { sender: { getType: () => 'window', isDestroyed: () => false, mainFrame }, senderFrame: mainFrame }

// The senders the guard exists to refuse: a <webview> guest, a subframe of the app window, a remote page in a window.
const strangers = {
  webview: { sender: { getType: () => 'webview', isDestroyed: () => false, mainFrame }, senderFrame: mainFrame },
  subframe: { sender: appWindow.sender, senderFrame: { url: `file://${INDEX}` } },
  remotePage: {
    sender: { getType: () => 'window', isDestroyed: () => false, mainFrame: { url: 'https://example.invalid/' } },
    senderFrame: null
  }
}

describe('git IPC answers only the app window (G-42, review R1-A minor 1)', () => {
  const refused: string[] = []

  beforeEach(() => {
    handlers.clear()
    refused.length = 0
    ops.reviewRevParse.mockClear()
    ops.reviewCommit.mockClear()
    ops.reviewPush.mockClear()
    ops.reviewCreatePr.mockClear()
    registerGitIpc({
      resolveGitBinary: () => 'git',
      resolveGhBinary: () => 'gh',
      isTrustedSender: createAppSenderGuard({
        rendererIndexPath: () => INDEX,
        log: line => refused.push(line),
        hasOwnerWindow: () => true
      })
    })
  })

  test('every hermes:git channel is registered behind the guard', () => {
    assert.equal(handlers.size, 22)
  })

  test('a strange sender is refused on every channel, and nothing runs', async () => {
    for (const [name, event] of Object.entries(strangers)) {
      for (const [channel, handler] of handlers) {
        await assert.rejects(
          async () => handler(event, '/repo', 'HEAD'),
          /Git is only available to the app window/,
          `${name} on ${channel}`
        )
      }
    }

    assert.equal(ops.reviewRevParse.mock.calls.length, 0)
    assert.equal(ops.reviewCommit.mock.calls.length, 0)
    assert.ok(refused.some(line => line.includes('refused hermes:git:review:commit from webview sender')))
  })

  test("the app's own renderer goes through", async () => {
    assert.equal(await handlers.get('hermes:git:review:revParse')!(appWindow, '/repo', 'HEAD'), 'abc123')
    assert.deepEqual(ops.reviewRevParse.mock.calls[0], ['/repo', 'HEAD', 'git'])
  })

  // v0.0.4 review F2: the write ops let GIT_SSH_COMMAND, GIT_ASKPASS, SSH_ASKPASS and GIT_AUTHOR_* / GIT_COMMITTER_*
  // reach git from the main process's own environment. The renderer has no way to name them: each handler forwards
  // fixed positional arguments, so an env object or a variable-named field in the payload is dropped before git runs.
  test('a renderer payload cannot carry git environment into commit, push or createPr', async () => {
    const injected = {
      env: { GIT_SSH_COMMAND: 'touch injected-marker' },
      GIT_SSH_COMMAND: 'touch injected-marker',
      GIT_DIR: '/elsewhere'
    }

    await handlers.get('hermes:git:review:commit')!(appWindow, '/repo', 'msg', 1, injected)
    await handlers.get('hermes:git:review:push')!(appWindow, '/repo', injected)
    await handlers.get('hermes:git:review:createPr')!(appWindow, '/repo', injected)

    assert.deepEqual(ops.reviewCommit.mock.calls, [['/repo', 'msg', true, 'git']])
    assert.deepEqual(ops.reviewPush.mock.calls, [['/repo', 'git']])
    assert.deepEqual(ops.reviewCreatePr.mock.calls, [['/repo', 'git', 'gh']])
  })
})
