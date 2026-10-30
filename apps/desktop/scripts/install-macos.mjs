#!/usr/bin/env node
// install-macos.mjs — puts iclone os in /Applications so Finder, Spotlight,
// Launchpad and the Dock treat it like any other Mac app, and a double-click
// opens it.
//
// Usage:
//   npm run install:mac                  # build, then install
//   npm run install:mac -- --skip-build  # install whatever is in release/
//
// Why this exists rather than "drag the .app out of release/":
//
//   1. The repo lives under ~/Desktop, which macOS syncs through a file
//      provider (iCloud/OneDrive). That provider keeps stamping
//      com.apple.FinderInfo onto the bundle, and codesign refuses to seal a
//      bundle carrying one — so a build signed IN PLACE never verifies. We
//      copy first and sign at the destination, outside the provider.
//   2. electron-builder skips signing entirely when there is no Developer ID
//      ("0 valid identities found"), which leaves the app with the Electron
//      binary's own linker signature and an unbound Info.plist. Ad-hoc signing
//      the installed bundle gives it a real identity and sealed resources. A
//      local build is a NON-RELEASE pack (scripts/build-identity.mjs): bundle id
//      io.cloneframe.icloneos.dev and no iclone:// scheme, so it never takes
//      deep links from a release install. A locally built app is never quarantined, so
//      Gatekeeper does not prompt.
//   3. Two bundles with the same id confuse Launch Services — it will happily
//      resolve the staging copy in release/. We remove it after installing so
//      exactly one iclone os is registered (and the file provider is not asked
//      to sync 330 MB).
//
// A Developer ID bundle (release-mac.mjs) is NEVER re-signed (contract P7
// decision 14): stapled → ditto + verify only; not stapled → refused. Any other
// bundle is a local build: it is signed with a self-signed identity created
// once (scripts/macos-signing.mjs), so the app keeps ONE identity across builds
// and the keychain stops asking after every reinstall. That result is a proper
// local install, not something to distribute.

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APP_NAME, findBuiltApp } from './built-app.mjs'
import { NON_RELEASE_APP_ID, RELEASE_APP_ID } from './build-identity.mjs'
import { inspectBundle, installPlan, requirementIsStable, signBundle } from './macos-signing.mjs'
import { isMain } from './utils.mjs'
import { verifyPackagedAcp } from './verify-packaged-acp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

/** Whatever is installed at the destination now — a release or a non-release build — is quit before it is replaced. */
const BUNDLE_IDS = [RELEASE_APP_ID, NON_RELEASE_APP_ID]
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'

function run(command, args, { allowFailure = false, cwd = projectRoot } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' })

  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim()

    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }

  return result
}

function resolveDestinationDir() {
  // /Applications is group-writable by admins on macOS, which is where an app
  // belongs. A non-admin account falls back to its own ~/Applications, which
  // Finder shows the same way.
  const system = '/Applications'
  const probe = run('test', ['-w', system], { allowFailure: true })

  if (probe.status === 0) {
    return system
  }

  const user = join(process.env.HOME ?? '', 'Applications')

  run('mkdir', ['-p', user])

  return user
}

export function installMacos({ skipBuild = false } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(`install-macos only runs on macOS (this is ${process.platform})`)
  }

  if (!skipBuild) {
    console.log('[install-macos] building the app bundle (npm run pack)…')
    const build = spawnSync('npm', ['run', 'pack'], { cwd: projectRoot, stdio: 'inherit' })

    if (build.status !== 0) {
      throw new Error('the build failed; nothing was installed')
    }
  }

  const source = findBuiltApp(projectRoot)

  if (!source) {
    throw new Error(`no built app found under release/ — run \`npm run pack\` first`)
  }

  const plan = installPlan(inspectBundle(source))

  if (plan.action === 'refuse') {
    throw new Error(`${plan.reason} — run \`npm run release:mac -- --staple-only\`; nothing was installed`)
  }

  // The bundle's own binary must run the bundled CLI before it is installed:
  // a build whose dock apps all fail is not an install, whatever codesign says.
  const cli = verifyPackagedAcp(source)

  if (!cli.ok) {
    throw new Error(`the packaged ACP CLI failed its self-test (${cli.error}); nothing was installed`)
  }

  console.log(
    `[install-macos] bundled acp ${cli.version ?? ''} answered under the app binary${cli.skipped ? ` (${cli.skipped})` : ''}`
  )

  const destinationDir = resolveDestinationDir()
  const destination = join(destinationDir, APP_NAME)

  console.log(`[install-macos] installing ${source}`)
  console.log(`[install-macos]         to ${destination}`)

  // The app cannot be replaced while it is running.
  for (const bundleId of BUNDLE_IDS) {
    run('osascript', ['-e', `tell application id "${bundleId}" to quit`], { allowFailure: true })
  }

  rmSync(destination, { force: true, recursive: true })
  // ditto, not cp: it preserves the bundle's symlinks, permissions and the
  // framework layout that codesign then seals.
  run('ditto', [source, destination])

  // Strip the file provider's leftovers (codesign refuses to verify a bundle
  // carrying com.apple.FinderInfo).
  run('xattr', ['-cr', destination])

  if (plan.action === 'copy-verify') {
    console.log('[install-macos] Developer ID bundle, stapled: copied as-is, never re-signed')
  } else {
    // A local build gets its own STABLE identity (scripts/macos-signing.mjs): an
    // ad-hoc signature changes with every build, and the login keychain then
    // asked the owner to "Always Allow" the Virtuals CLI's token per reinstall.
    const signed = signBundle(destination, { log: console.log })

    console.log(
      `[install-macos] signed with ${signed.kind === 'adhoc' ? 'an ad-hoc signature' : `"${signed.identity}"`}`
    )
    console.log(`[install-macos] designated requirement: ${signed.requirement || '(none reported)'}`)

    if (!requirementIsStable(signed.requirement)) {
      console.warn(
        '[install-macos] WARNING: the requirement is a per-build hash — macOS will ask for keychain access again after the next reinstall'
      )
    }
  }

  const verify = run('codesign', ['--verify', '--deep', '--strict', destination], {
    allowFailure: true
  })

  if (verify.status !== 0) {
    throw new Error(`the installed bundle does not verify:\n${(verify.stderr || '').trim()}`)
  }

  if (existsSync(LSREGISTER)) {
    run(LSREGISTER, ['-f', destination], { allowFailure: true })
  }

  // One bundle id, one app: drop the staging copy so Launch Services and
  // Spotlight cannot resolve iclone os to a build directory.
  rmSync(dirname(source), { force: true, recursive: true })

  console.log('[install-macos] done — the app is signed, registered and ready')
  console.log(`[install-macos] open it from Finder, Spotlight or: open -a "${destination}"`)

  return destination
}

if (isMain(import.meta.url)) {
  try {
    installMacos({ skipBuild: process.argv.includes('--skip-build') })
  } catch (error) {
    console.error(`[install-macos] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
