// main.ts's before-quit, pinned at the source (its real listener never runs in a test): where the quit is marked as
// quitting, the "Quit Anyway" latch, and what a forced exit must stop or relaunch since it skips every will-quit handler.
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
const beforeQuit = main.slice(main.indexOf("app.on('before-quit', event => {"))
const waitAt = beforeQuit.indexOf('waitForManagedUpdateOperations(')
const sealAt = beforeQuit.indexOf('sealQuitTeardown()')
const backendsAt = beforeQuit.indexOf('backendShutdown.run()')

describe("main.ts's before-quit marks the quit only at its teardown", () => {
  it('the seal (quitting + coordinator) comes after the remote-update wait has returned, before the backend stop', () => {
    expect(waitAt).toBeGreaterThan(0)
    expect(sealAt).toBeGreaterThan(waitAt)
    expect(backendsAt).toBeGreaterThan(sealAt)
    // The wait's own branch returns before the seal: a quit waiting for an update never seals.
    expect(beforeQuit.slice(waitAt, sealAt)).toMatch(/\n {4}return\n {2}\}\n/)
  })

  it('nothing in main seals the coordinator or marks quitting on its own', () => {
    expect(main).not.toContain('sshBootstrapCoordinator.shutdown()')
    expect(main).not.toMatch(/quitState\.quitting = true/)
    expect(main).not.toContain('beginQuitTeardown(')
  })
})

describe('the active-work dialog', () => {
  it('fx21: a background command the launcher still holds counts in the decision', () => {
    expect(main).toMatch(/quitPromptFor\(\s*mergeActiveWork\(activeWorkByWebContents\.values\(\)\),\s*quitState\.isQuittingForHandoff,\s*leftRunningCount\(runFiles\(app\.getPath\('userData'\)\), undefined, currentConfinement\(\)\?\.launcherSince\(\) \?\? null\)\s*\)/)
  })

  it('"Quit Anyway" latches the choice before it quits again (else the dialog reopens on every pass)', () => {
    expect(main).toMatch(
      /if \(response === 1\) \{\n\s+quitConfirmedWithActiveWork = true\n\s+requitAfter\('quit confirmation'\)/
    )
  })

  it('a sealed teardown latches the choice before the latch is read: no dialog once the backends are stopping', () => {
    expect(main).toMatch(
      /if \(quitTeardownSealed\(\)\) \{\n\s+quitConfirmedWithActiveWork = true\n\s+\}\n\n\s+if \(SKIP_QUIT_CONFIRM \|\| quitConfirmedWithActiveWork/
    )
  })

  it('the latch is read before the dialog opens: a confirmed quit falls straight through', () => {
    expect(main).toMatch(
      /if \(SKIP_QUIT_CONFIRM \|\| quitConfirmedWithActiveWork \|\| quitPromptOpen\) \{\n\s+return false/
    )
  })
})

describe('a forced exit skips will-quit: main registers what it must still do', () => {
  it('the ACP WORK listeners, the confinement log stream and the pay socket are stopped by a forced exit too', () => {
    // Registered in the ONE teardown registry (will-quit and every forced exit). That each registration is reached
    // (statement level, no dead branch) is proven by teardown-registry.test.ts's structural gate.
    expect(main).toContain("registerTeardown('acp work', () => acpWork.stopAll())")
    expect(main).toContain("registerTeardown('confinement', () => stopConfinement())")
    expect(main).toContain("registerTeardown('payments', () => payments.close())")
    expect(main).not.toMatch(/app\.(on|once)\('will-quit'/)
  })

  it('the armed "Restart now" relaunch runs on a forced quit-cap exit', () => {
    expect(main).toContain('relaunchOnForcedQuit(() => relaunchOnQuit.runIfArmed())')
  })
})
