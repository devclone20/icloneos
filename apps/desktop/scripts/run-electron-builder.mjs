// Resolve electronDist at runtime (#38673, #47917): electron-builder 26.8.x can
// re-unpack a broken Electron.app; reusing the installed dist dodges that.
// npm workspace hoisting is non-deterministic — require.resolve finds electron
// wherever it landed. Dist present → -c.electronDist=<abs>/dist; absent → let
// electron-builder fetch via @electron/get (electronVersion + ELECTRON_MIRROR).

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import {
  NON_RELEASE_APP_ID,
  NON_RELEASE_CONFIG_FILE,
  RELEASE_APP_ID,
  nonReleaseBuildConfig,
  planIdentity,
} from "./build-identity.mjs"

const require = createRequire(import.meta.url)

function electronDistDir() {
  try {
    return path.join(path.dirname(require.resolve("electron/package.json")), "dist")
  } catch {
    return null
  }
}

function distBinary(dist) {
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
  }
  if (process.platform === "win32") {
    return path.join(dist, "electron.exe")
  }
  return path.join(dist, "electron")
}

function electronBuilderCli() {
  const pkgJson = require.resolve("electron-builder/package.json")
  const bin = require(pkgJson).bin
  const rel = typeof bin === "string" ? bin : bin["electron-builder"]
  return path.join(path.dirname(pkgJson), rel)
}

const dist = electronDistDir()
const args = []
if (dist && fs.existsSync(distBinary(dist))) {
  args.push(`-c.electronDist=${dist}`)
} else {
  console.warn(
    "[run-electron-builder] no local electron dist; electron-builder will fetch " +
      "via @electron/get (electronVersion + ELECTRON_MIRROR)."
  )
}
// K144 r2: only the release pipelines pass --iclone-release-identity; every other pack gets the non-release identity
// (its own bundle id, no URL scheme), derived from package.json `build` (scripts/build-identity.mjs).
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
let identity
try {
  identity = planIdentity(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
if (identity.needsConfigFile) {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"))
  const configFile = path.join(desktopRoot, "build", NON_RELEASE_CONFIG_FILE)
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, `${JSON.stringify(nonReleaseBuildConfig(pkg.build), null, 2)}\n`)
  args.push("--config", configFile)
  console.log(`[run-electron-builder] non-release pack: ${NON_RELEASE_APP_ID}, no URL scheme`)
} else {
  console.log(`[run-electron-builder] release pack: ${RELEASE_APP_ID} with its URL scheme`)
}
args.push(...identity.args)

const result = spawnSync(process.execPath, [electronBuilderCli(), ...args], {
  stdio: "inherit",
})
if (result.error) {
  console.error(`[run-electron-builder] spawn failed: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status == null ? 1 : result.status)
