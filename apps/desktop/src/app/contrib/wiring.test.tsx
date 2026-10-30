/**
 * wiring.tsx is where app-wide registrants are mounted, and the remote folder
 * picker is one of them: lib/desktop-fs has no other registrant, and with none
 * mounted a remote directory pick is answered as unavailable — ⌘O and the home
 * files island then show an error instead of a folder (app/remote-picker).
 *
 * Rendering wiring.tsx means booting the whole desktop app in jsdom, so this
 * guard reads the module source. It exists to make a future deletion of the
 * mount fail here, next to the deletion, rather than in a user's remote
 * session months later.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// A variable path keeps Vite from rewriting `new URL(literal, import.meta.url)`
// into an asset URL (same trick as ic-system.test.tsx).
function moduleSource(file: string) {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
}

const source = moduleSource('./wiring.tsx')

describe('contrib wiring mounts the remote folder picker', () => {
  it('imports it from its own module', () => {
    expect(source).toContain("import { RemoteFolderPicker } from '../remote-picker/remote-picker'")
  })

  it('mounts it exactly once', () => {
    expect(source.match(/<RemoteFolderPicker \/>/g)).toHaveLength(1)
  })
})
