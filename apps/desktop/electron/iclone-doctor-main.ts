/**
 * Wires the diagnostics runner into the app: Electron/OS facts as deps, IPC `iclone:doctor:*` behind the app sender
 * guard, and the agent door (`acp doctor …`, routed by iclone-acp-ipc.ts). No network unless a run asks for live probes.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, session, shell, systemPreferences } from 'electron'

import { acpWrapperSource, registryRowFor, renderInftRegistry, shouldInstallAcpWrapper } from './iclone-acp'
import { consentAllows } from './iclone-consent'
import { collectMacNames, diagnosticsFileHandlers, macNamesOnce } from './iclone-diagnostics-file'
import { createDoctor, type Doctor, setActiveDoctor } from './iclone-doctor'
import { loadCatalogue, PACK_IDS, resolveCatalogueDir } from './iclone-doctor-catalog'
import { bundleUnderTest, type DoctorEnv, runningBundleId } from './iclone-doctor-checks'

interface InitDoctorDeps {
  hermesHome: string
  venvDir: string
  isTrustedSender(event: Electron.IpcMainInvokeEvent, channel: string): boolean
  /** The local gateway this app spawned (pid + where it serves), or null (remote / not started). */
  gateway?(): { pid: number; baseUrl: Promise<string | null> } | null
  /** Stops / starts the app's own gateway (the restore of state.db needs it down; the app relaunches it at start). */
  stopGateway?(): Promise<void>
  startGateway?(): Promise<void>
  /** The owner's secret-storage choice. Off (the default) = the keychain is never touched, not even to probe it. */
  encryptionOn?(): boolean
  /** FX-7: the app's recent log lines, for the diagnostics report the owner saves to a file. */
  recentLogs?(): readonly string[]
  log?(line: string): void
}

const PRIVY_PARTITION = 'persist:iclone-privy'
const GATEWAY_WAIT_MS = 1500
const HEALTH_TIMEOUT_MS = 3000

/** node-pty ships spawn-helper under prebuilds/<platform>-<arch>/ (current) or build/Release/ (built from source). */
export function spawnHelperCandidates(ptyDir: string, platform = process.platform, arch = process.arch): string[] {
  const dir = ptyDir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)

  return [
    path.join(dir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(dir, 'build', 'Release', 'spawn-helper')
  ]
}

/** This instance's registry rows, rendered the way the app writes them (compared by slug + configDir). */
export function ownRegistryText(userData: string): string {
  const root = path.join(userData, 'inft')
  let names: string[] = []

  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'acp')))
      .map(d => d.name)
  } catch {
    // No iNFT set up yet.
  }

  return renderInftRegistry(names.flatMap(slug => registryRowFor(slug, path.join(root, slug, 'acp')) ?? []))
}

/** `abi` from the build's install-stamp.json (written at packaging), or null when the build carries none. */
export function stampedAbi(resourcesPath: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(resourcesPath, 'install-stamp.json'), 'utf8')) as {
      abi?: unknown
    }

    return typeof value.abi === 'string' && /^\d+$/.test(value.abi) ? value.abi : null
  } catch {
    return null
  }
}

function spawnHelperPath(): string | null {
  try {
    return (
      spawnHelperCandidates(path.dirname(require.resolve('node-pty/package.json'))).find(f => fs.existsSync(f)) ?? null
    )
  } catch {
    return null
  }
}

function catalogueCandidates(): string[] {
  return [
    // Packaged: package.json extraResources ships iclone/diagnostics to resources/diagnostics.
    path.join(process.resourcesPath ?? '', 'diagnostics'),
    path.join(process.resourcesPath ?? '', 'iclone', 'diagnostics'),
    path.resolve(app.getAppPath(), '..', '..', 'iclone', 'diagnostics')
  ]
}

/** isEncryptionAvailable() is a keychain touch (macOS can park the main thread on a login dialog): only behind the owner's choice. */
export function gatedKeychainProbe(encryptionOn: (() => boolean) | undefined, probe: () => boolean): boolean {
  return encryptionOn?.() === true && probe()
}

/** r4/r5: the Mac's names, read once (async, never on the main thread synchronously) and kept in memory for the session. */
const macNames = macNamesOnce(() =>
  collectMacNames({
    hostname: os.hostname(),
    username: os.userInfo().username,
    platform: process.platform,
    read: (file, args) =>
      new Promise(resolve => {
        execFile(file, [...args], { encoding: 'utf8', timeout: 2000 }, (error, stdout) =>
          resolve(error ? null : String(stdout).trim() || null)
        )
      })
  })
)

export function initIcloneDoctor(deps: InitDoctorDeps): Doctor {
  const dir = resolveCatalogueDir(catalogueCandidates())

  const catalogue = dir
    ? loadCatalogue(dir)
    : { packs: [], errors: [`catalogue not found (${PACK_IDS.length} packs expected)`] }

  const darwin = process.platform === 'darwin'
  const userData = app.getPath('userData')
  let claimed: { port: number; pid: number } | null = null
  let baseUrl: string | null = null

  // claim() is synchronous for the checks, so every run/fix first settles where the gateway serves.
  const refreshGateway = async () => {
    const live = deps.gateway?.() ?? null

    if (!live) {
      claimed = null
      baseUrl = null

      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    const url = await Promise.race([
      live.baseUrl.catch(() => null),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), GATEWAY_WAIT_MS)
      })
    ]).finally(() => clearTimeout(timer))

    const port = url ? Number(new URL(url).port) : NaN
    baseUrl = url
    claimed = Number.isInteger(port) && port > 0 ? { port, pid: live.pid } : null
  }

  if (catalogue.errors.length) {
    deps.log?.(`[iclone-doctor] catalogue: ${catalogue.errors.join('; ')}`)
  }

  const appBundle = bundleUnderTest(app.isPackaged, process.execPath, process.platform)

  const env: Omit<DoctorEnv, 'exec' | 'live' | 'signal'> = {
    platform: process.platform,
    home: app.getPath('home'),
    userData,
    hermesHome: deps.hermesHome,
    venvDir: deps.venvDir,
    icloneHome: path.join(app.getPath('home'), '.iclone-os'),
    appBundle,
    packaged: app.isPackaged,
    mainPid: process.pid,
    // The running copy's own id (a `.dev` pack is not the release app): TCC resets target it.
    bundleId: runningBundleId(appBundle),
    // FX-3: the computer-use driver whose Accessibility trust the doctor checks (cua_backend.py's override).
    cuaDriverCmd: process.env.HERMES_CUA_DRIVER_CMD ?? null,
    crashDumpsDir: app.getPath('crashDumps'),
    now: () => Date.now(),
    electron: {
      ...(darwin
        ? {
            mediaStatus: kind => systemPreferences.getMediaAccessStatus(kind),
            translated: () => app.runningUnderARM64Translation,
            inApplications: () => app.isInApplicationsFolder()
          }
        : {}),
      encryptionOn: deps.encryptionOn,
      safeStorage: () => gatedKeychainProbe(deps.encryptionOn, () => safeStorage.isEncryptionAvailable()),
      privyCookieCount: async () =>
        fs.existsSync(path.join(userData, 'Partitions', PRIVY_PARTITION.replace(/^persist:/, '')))
          ? (await session.fromPartition(PRIVY_PARTITION).cookies.get({})).length
          : null,
      cacheSize: () => session.defaultSession.getCacheSize(),
      // Never cookies or localStorage: those hold the Privy session and the iclone.* settings.
      clearCache: async () => {
        await session.defaultSession.clearCache()
        await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
      },
      netOnline: () => net.isOnline(),
      openExternal: url => shell.openExternal(url)
    },
    gateway: {
      claim: () => claimed,
      ...(deps.stopGateway && deps.startGateway ? { stop: deps.stopGateway, start: deps.startGateway } : {}),
      // Loopback only: the gateway this app spawned, never a remote host.
      health: async () => {
        if (!baseUrl) {
          return { ok: false, detail: 'gateway not answering yet' }
        }

        try {
          const res = await net.fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })

          return { ok: res.ok, detail: res.ok ? 'answers on loopback' : `status ${res.status}` }
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.name : 'unreachable' }
        }
      }
    },
    acp: {
      wrapperSource: () =>
        shouldInstallAcpWrapper(app.isPackaged)
          ? acpWrapperSource(path.join(userData, 'run', 'acp.sock'), path.join(userData, 'run', 'acp.token'))
          : null,
      registryText: () => ownRegistryText(userData)
    },
    native: {
      expectedAbi: app.isPackaged ? stampedAbi(process.resourcesPath ?? '') : null,
      abi: process.versions.modules,
      spawnHelper: spawnHelperPath()
    }
  }

  const inner = createDoctor({
    catalogue,
    env,
    dataDir: path.join(app.getPath('userData'), 'diagnostics'),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      packaged: app.isPackaged,
      arch: process.arch
    },
    osRelease: os.release(),
    consentAllows
  })

  const doctor: Doctor = {
    ...inner,
    run: async options => {
      await refreshGateway()

      return inner.run(options)
    },
    fix: async (fixId, options) => {
      await refreshGateway()

      return inner.fix(fixId, options)
    }
  }

  const handle = <A extends unknown[]>(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: A) => unknown
  ) =>
    ipcMain.handle(channel, (event, ...args) =>
      deps.isTrustedSender(event, channel) ? handler(event, ...(args as A)) : null
    )

  handle('iclone:doctor:list', () => doctor.list())
  handle('iclone:doctor:run', (event, input: unknown) => {
    const { packs, live } = (input && typeof input === 'object' ? input : {}) as { packs?: unknown; live?: unknown }

    const wanted = Array.isArray(packs)
      ? packs.filter((p): p is string => typeof p === 'string').slice(0, 8)
      : undefined

    return doctor.run({
      packs: wanted,
      live: live === true,
      onProgress: progress => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('iclone:doctor:progress', progress)
        }
      }
    })
  })
  handle('iclone:doctor:fix', (_event, input: unknown) => {
    const { fixId, dryRun } = (input && typeof input === 'object' ? input : {}) as { fixId?: unknown; dryRun?: unknown }

    return typeof fixId === 'string' && fixId.length <= 80
      ? doctor.fix(fixId, { dryRun: dryRun !== false, actor: 'user' })
      : null
  })
  handle('iclone:doctor:report', () => doctor.lastReport())
  handle('iclone:doctor:open-logs', async () => (await shell.openPath(app.getPath('logs'))) === '')

  // FX-7: the diagnostics report goes to a file the owner chooses — never uploaded to anyone.
  const diagnosticsFile = (event: Electron.IpcMainInvokeEvent, names: readonly string[]) =>
    diagnosticsFileHandlers({
      home: app.getPath('home'),
      machineNames: () => names,
      appVersion: app.getVersion(),
      report: () => doctor.lastReport()?.lines ?? null,
      logs: () => deps.recentLogs?.() ?? [],
      now: () => new Date(),
      chooseFile: async suggestedName => {
        const options: Electron.SaveDialogOptions = {
          defaultPath: path.join(app.getPath('downloads'), suggestedName),
          filters: [{ name: 'Text', extensions: ['txt'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation']
        }

        const owner = BrowserWindow.fromWebContents(event.sender)
        const chosen = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)

        return chosen.canceled || !chosen.filePath ? null : chosen.filePath
      }
    })

  handle('iclone:diagnostics:preview', async (event, input: unknown) =>
    diagnosticsFile(event, await macNames()).preview(input)
  )
  handle('iclone:diagnostics:save', async (event, input: unknown) =>
    diagnosticsFile(event, await macNames()).save(input)
  )

  setActiveDoctor(doctor)

  return doctor
}
