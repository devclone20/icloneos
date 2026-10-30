/**
 * K-RT9 (found live), exercised (critics' panel CRITICOS_V3RT, minor 5): the renderer-skew git call runs in the app's
 * own runtime folder, which has no `.git` and sits inside the owner's home (a repository on this owner's Mac). Git
 * gets a ceiling at that folder's parent, so it can never walk up into the home repository, and takes no optional
 * lock. The gate's mutation row used to prove this by reading desktop-settings.ts as text.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  runResolvedGit: vi.fn(async () => ({ code: 0, stderr: '', stdout: '3\n' }))
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('./env', () => ({
  DEFAULT_UPDATE_BRANCH: 'main',
  INSTALL_STAMP: { commit: '3f2a9c1d5e7b8a6c4d2e0f1a3b5c7d9e1f2a4b6c', source: 'build' },
  resolveUpdateRoot: () => '/Users/u/Library/Application Support/iclone os/hermes-runtime/abc/hermes-agent'
}))
vi.mock('./executables', () => ({ runResolvedGit: h.runResolvedGit }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('./paths', () => ({
  DESKTOP_UPDATE_CONFIG_PATH: '/nonexistent/u.json',
  DESKTOP_WINDOW_STATE_PATH: '/nonexistent/w.json'
}))
vi.mock('./state', () => ({ windowsState: {} }))

const { detectRendererSkew } = await import('./desktop-settings')

describe('the renderer-skew git call (K-RT9), exercised', () => {
  it('runs in the update root with a ceiling at its parent and no optional lock', async () => {
    expect(await detectRendererSkew()).toEqual({ desktopCommitsBehind: 3, outOfSync: true })

    expect(h.runResolvedGit).toHaveBeenCalledTimes(1)
    expect(h.runResolvedGit).toHaveBeenCalledWith(
      ['rev-list', '--count', '3f2a9c1d5e7b8a6c4d2e0f1a3b5c7d9e1f2a4b6c..HEAD', '--', 'apps/desktop'],
      {
        cwd: '/Users/u/Library/Application Support/iclone os/hermes-runtime/abc/hermes-agent',
        env: {
          GIT_CEILING_DIRECTORIES: '/Users/u/Library/Application Support/iclone os/hermes-runtime/abc',
          GIT_OPTIONAL_LOCKS: '0'
        }
      }
    )
  })
})
