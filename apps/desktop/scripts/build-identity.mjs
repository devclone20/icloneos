/**
 * build-identity.mjs — K144 r2 (M2): which identity a pack gets.
 *
 * macOS routes `iclone://` by BUNDLE ID among every registered copy that declares the scheme in its Info.plist
 * (Electron's setAsDefaultProtocolClient stores a bundle id, not a path). So a trial pack, a lab pack or a dev
 * `npm run pack` that shares the release bundle id and declares the scheme can take deep links away from the
 * installed app as soon as LaunchServices has seen it once — whatever the app itself decides at runtime.
 *
 * Rule: only the release pipelines (release-mac.mjs, release-linux.mjs) build the release identity: bundle id
 * `io.cloneframe.icloneos` with the `iclone` URL scheme. They say so by passing RELEASE_IDENTITY_FLAG to
 * run-electron-builder.mjs. Every other pack (`npm run pack`, `dist:*`, `install:mac`, trial and lab builds) is a
 * NON-RELEASE pack: bundle id `io.cloneframe.icloneos.dev`, and no URL scheme at all (no CFBundleURLTypes on macOS, no
 * `x-scheme-handler/iclone` in the Linux desktop entry). Non-release is the default, so a new script that forgets the
 * flag can never claim the scheme. The runtime check (deep-link.ts protocolClaimDecision) stays as a second layer.
 *
 * package.json `build` stays the single source of the release config; the non-release config is derived from it and
 * written to `build/electron-builder.non-release.json`, which run-electron-builder.mjs hands to electron-builder.
 */

export const RELEASE_APP_ID = 'io.cloneframe.icloneos'
export const NON_RELEASE_APP_ID = 'io.cloneframe.icloneos.dev'
export const RELEASE_IDENTITY_FLAG = '--iclone-release-identity'
export const NON_RELEASE_CONFIG_FILE = 'electron-builder.non-release.json'

/** Platform blocks of an electron-builder config that may carry their own `protocols`. */
const PLATFORM_KEYS = ['mac', 'mas', 'masDev', 'linux', 'win', 'appImage', 'snap', 'flatpak', 'deb', 'rpm']

function withoutSchemeHandlers(mimeType) {
  const kept = String(mimeType)
    .split(';')
    .map(entry => entry.trim())
    .filter(entry => entry && !entry.startsWith('x-scheme-handler/'))

  return kept.length > 0 ? `${kept.join(';')};` : null
}

/** The non-release electron-builder config derived from package.json `build` (the input is not modified). */
export function nonReleaseBuildConfig(build) {
  if (!build || typeof build !== 'object') {
    throw new Error('[build-identity] package.json has no "build" config')
  }

  if (build.appId !== RELEASE_APP_ID) {
    throw new Error(`[build-identity] package.json build.appId is ${build.appId}, expected ${RELEASE_APP_ID}`)
  }

  const config = structuredClone(build)
  config.appId = NON_RELEASE_APP_ID
  delete config.protocols

  for (const key of PLATFORM_KEYS) {
    const block = config[key]

    if (!block || typeof block !== 'object') {
      continue
    }

    delete block.protocols

    if (block.extendInfo && typeof block.extendInfo === 'object') {
      delete block.extendInfo.CFBundleURLTypes
    }

    const entry = block.desktop?.entry

    if (entry && typeof entry === 'object' && 'MimeType' in entry) {
      const mime = withoutSchemeHandlers(entry.MimeType)

      if (mime) {
        entry.MimeType = mime
      } else {
        delete entry.MimeType
      }
    }
  }

  return config
}

/** URL schemes a config would declare (top-level and per-platform `protocols`, plus Linux scheme handlers). */
export function declaredSchemes(config) {
  const schemes = new Set()
  const protocolLists = [config.protocols, ...PLATFORM_KEYS.map(key => config[key]?.protocols)]

  for (const list of protocolLists) {
    for (const protocol of [list].flat().filter(Boolean)) {
      for (const scheme of [protocol.schemes].flat().filter(Boolean)) {
        schemes.add(String(scheme))
      }
    }
  }

  for (const key of PLATFORM_KEYS) {
    for (const url of config[key]?.extendInfo?.CFBundleURLTypes ?? []) {
      for (const scheme of url?.CFBundleURLSchemes ?? []) {
        schemes.add(String(scheme))
      }
    }

    for (const entry of String(config[key]?.desktop?.entry?.MimeType ?? '').split(';')) {
      if (entry.trim().startsWith('x-scheme-handler/')) {
        schemes.add(entry.trim().slice('x-scheme-handler/'.length))
      }
    }
  }

  return [...schemes].sort()
}

/** True when the caller already hands electron-builder its own config FILE (we would silently replace it). */
function hasConfigFileArg(args) {
  return args.some(
    (arg, index) =>
      ((arg === '--config' || arg === '-c') && args[index + 1] && !args[index + 1].startsWith('-')) ||
      /^(--config|-c)=/.test(arg)
  )
}

/**
 * Split run-electron-builder's argv into the identity decision and electron-builder's own args.
 * Returns `{ release, args, needsConfigFile }`; throws when a non-release pack also names a config file.
 */
export function planIdentity(argv) {
  const release = argv.includes(RELEASE_IDENTITY_FLAG)
  const args = argv.filter(arg => arg !== RELEASE_IDENTITY_FLAG)

  if (!release && hasConfigFileArg(args)) {
    throw new Error(
      '[build-identity] a non-release pack cannot take its own config file (it would carry the release identity)'
    )
  }

  return { release, args, needsConfigFile: !release }
}
