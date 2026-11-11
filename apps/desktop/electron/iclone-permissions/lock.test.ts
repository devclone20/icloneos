// V3-F §6 static lock probes: no code path but the user's gesture reaches the mode, and no window-side policy writes.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const DESKTOP = path.resolve(__dirname, '../..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)

    if (name === 'node_modules' || name.startsWith('.')) {
      return []
    }

    if (statSync(full).isDirectory()) {
      return sources(full)
    }

    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

const rel = (file: string) => path.relative(DESKTOP, file)
const ELECTRON = sources(path.join(DESKTOP, 'electron'))
// Generated wire types name every RPC and field; they carry no call.
const RENDERER = sources(path.join(DESKTOP, 'src')).filter(file => !file.endsWith('.generated.ts'))

const grep = (files: string[], pattern: RegExp) =>
  files.filter(file => pattern.test(readFileSync(file, 'utf8'))).map(rel)

describe('LOCK: one writer of the mode, reachable only from the gesture-checked set-mode handler', () => {
  it('mode.json is named and written only by the store; writeMode is reached only through setMode, after the gesture and the alert, or through what setMode held', () => {
    expect(grep(ELECTRON, /['"]mode\.json['"]|MODE_FILE/)).toEqual(['electron/iclone-permissions/store.ts'])
    expect(grep([...ELECTRON, ...RENDERER], /\.writeMode\(/)).toEqual(['electron/iclone-permissions/authority.ts'])

    const authority = readFileSync(path.join(DESKTOP, 'electron/iclone-permissions/authority.ts'), 'utf8')
    const setMode = authority.slice(authority.indexOf('async setMode(input: unknown, gestureOk: boolean, windowId?: number)'))

    expect(authority.match(/\.writeMode\(/g)).toHaveLength(1)
    expect(setMode.indexOf('if (!gestureOk)')).toBeGreaterThan(-1)
    expect(setMode.indexOf('if (!gestureOk)')).toBeLessThan(setMode.indexOf('writeInForce('))
    expect(setMode.indexOf('deps.confirmIgnore')).toBeLessThan(setMode.indexOf('writeInForce('))
    // S11: two callers of the one write. A held choice is set in one place, after the gesture and the alert; the claim only takes it.
    expect(authority.match(/\bwriteInForce\(/g)).toHaveLength(2)
    expect(authority.match(/windowChoices\.set\(/g)).toHaveLength(1)
    expect(setMode.indexOf('if (!gestureOk)')).toBeLessThan(setMode.indexOf('windowChoices.set('))
    expect(setMode.indexOf('deps.confirmIgnore')).toBeLessThan(setMode.indexOf('windowChoices.set('))
    expect(setMode.indexOf('windowChoices.set(')).toBeLessThan(setMode.indexOf('claimWindowChoice('))
  })

  // Exempt, on purpose: the branch route (a branch takes the Setting, S11) and the bots plugin's own create route (it
  // has no empty composer). Neither shows a selector that could hold a choice.
  it('S11: the empty chat\'s send and the new tile, the two composer routes, take the held choice before anything can run in them', () => {
    const actions = readFileSync(path.join(DESKTOP, 'src/app/session/hooks/use-session-actions/index.ts'), 'utf8')
    const first = actions.indexOf("'session.create'")
    const claim = actions.indexOf('await claimWindowChoice(stored)')
    const second = actions.indexOf("'session.create'", claim)
    const secondClaim = actions.indexOf('await claimWindowChoice(stored)', second)

    expect(actions.split('await claimWindowChoice(stored)')).toHaveLength(3)
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(claim)
    expect(claim).toBeLessThan(second)
    expect(second).toBeLessThan(secondClaim)
    expect(actions.slice(first, claim)).not.toContain('prompt.submit')
    expect(actions.slice(second, secondClaim)).not.toContain('prompt.submit')
  })

  it('authority.setMode is called from exactly one place: the set-mode IPC handler, with main’s own gesture verdict', () => {
    expect(grep([...ELECTRON, ...RENDERER], /authority\.setMode\(/)).toEqual(['electron/iclone-permissions/ipc.ts'])

    const ipc = readFileSync(path.join(DESKTOP, 'electron/iclone-permissions/ipc.ts'), 'utf8')

    // fx23 (critic r2-A): the one call in that file. A second one could carry a forged verdict past the shape below.
    expect(ipc.match(/authority\.setMode\(/g)).toHaveLength(1)
    expect(ipc.match(/\bconst ok = gesture\(event, input\)/g)).toHaveLength(1)
    expect(ipc).not.toMatch(/\bok = (?!gesture\()/)

    // fx20 judges the click first and may refuse a project folder before the call; the verdict passed is still main's.
    const from = ipc.indexOf("ipcMain.handle('iclone:permissions:set-mode'")
    const next = ipc.indexOf('ipcMain.handle(', from + 1)
    const handler = ipc.slice(from, next === -1 ? undefined : next)

    expect(
      handler.startsWith(
        "ipcMain.handle('iclone:permissions:set-mode', async (event, input) => {\n    const ok = gesture(event, input)\n"
      )
    ).toBe(true)
    expect(handler.indexOf('const result = await authority.setMode(input, ok, sender?.id)\n')).toBeGreaterThan(-1)
  })

  it('the agent socket verb has no way to set a mode or a grant', () => {
    const verb = readFileSync(path.join(DESKTOP, 'electron/iclone-permissions/socket-verb.ts'), 'utf8')

    expect(verb).toContain(
      "const PERM_VERBS = ['ask', 'await', 'beat', 'bye', 'event', 'gapnote', 'hello', 'replay'] as const"
    )
    expect(verb).not.toMatch(/\.(setMode|writeMode|addGrant|revokeGrant|revoke)\(/)
  })

  it('F-2: no spawn key in the environment of a Hermes spawn — only its fd and the parent pid that may read it', () => {
    const ipc = readFileSync(path.join(DESKTOP, 'electron/iclone-permissions/ipc.ts'), 'utf8')
    const start = readFileSync(path.join(DESKTOP, 'electron/main/start-hermes.ts'), 'utf8')
    // V3-S r2: every Hermes spawn's key handling lives in the one spawn preparation (main/iclone-gate.ts).
    const gate = readFileSync(path.join(DESKTOP, 'electron/main/iclone-gate.ts'), 'utf8')

    expect(ipc).not.toMatch(/ICLONE_POLICY_KEY['"]?\s*:/)
    expect(ipc).toContain('ICLONE_POLICY_KEY_FD: String(PERMISSIONS_KEY_FD)')
    expect(gate).toContain("GATED_STDIO: ['ignore', 'pipe', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe', 'pipe']")
    expect(gate).toContain('keyPipe.end(permissions.keyLine')
    expect(start).toContain('stdio: gated.stdio')
  })
})

describe('LOCK: the window never writes Hermes’ approval policy', () => {
  it('0 config.set of yolo / approvals in src/**, and the retired modules are gone', () => {
    expect(
      grep(RENDERER, /config\.set['"][^)]*['"](yolo|approvals?[._a-z]*|approval_mode|command_allowlist)['"]/s)
    ).toEqual([])
    expect(grep(RENDERER, /key:\s*['"](yolo|approvals\.mode|approval_mode|command_allowlist)['"]/)).toEqual([])
    expect(grep(RENDERER, /yolo-session|store\/approval-mode|setSessionYolo|setYoloEnabled/)).toEqual([])
  })

  it('no window path answers a Hermes approval except the relay of main’s sheet answer', () => {
    // legacy.ts is answerServerRequest's transport for old gateways (it forwards what its caller decided).
    expect(grep(RENDERER, /['"]approval\.respond['"]/)).toEqual([
      'src/lib/server-requests/legacy.ts',
      'src/store/prompts.ts'
    ])
    expect(grep(RENDERER, /satisfies ApprovalResult|ApprovalResult\b.*choice/)).toEqual(['src/store/prompts.ts'])
  })
})

describe('LOCK: system permissions are requested only on the user’s own feature, never by the agent or at boot', () => {
  // Known app-feature sites, each started by the user's click: voice input asks for the microphone; Diagnostics'
  // "reset" fix runs tccutil. The agent's S class reaches macOS only through the permission sheet (round 2).
  const KNOWN = ['electron/iclone-doctor-fixes.ts', 'electron/main/window-ipc.ts']

  it('the TCC request calls are exactly the known feature sites', () => {
    expect(grep(ELECTRON, /askForMediaAccess\(|isTrustedAccessibilityClient\(true\)|\/usr\/bin\/tccutil/)).toEqual(
      KNOWN
    )
  })
})
