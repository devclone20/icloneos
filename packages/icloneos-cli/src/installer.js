// @ts-check
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Interrupted, RELEASE_CONTRACT, Refusal } from './contract.js';
import {
  assertNotBelowFloor,
  compareVersions,
  expectedHashFor,
  latestAssetUrl,
  parseFeedVersion,
  parseSha256Sums,
  taggedAssetUrl,
} from './feed.js';
import { verifySumsSignature } from './sums-signature.js';
import { verifyAppBundle, verifyDigest, verifyDiskImage, verifySignedApp } from './verify.js';

/**
 * @typedef {import('./system.js').System} System
 * @typedef {(line: string) => void} Logger
 * @typedef {{ version: string, dmgSha256: string }} Release
 */

const STAGING_PREFIX = '.icloneos-staging-';
const PREVIOUS_APP = 'previous.app';

/**
 * @param {System} sys
 * @returns {string[]}
 */
export function defaultSearchDirs(sys) {
  return [join(sys.home, 'Applications'), sys.systemAppsDir];
}

/**
 * @param {System} sys
 * @returns {void}
 */
function assertSupportedHost(sys) {
  if (sys.platform !== 'darwin') throw new Refusal('iclone os is a macOS app; this machine is not macOS.');
  if (sys.arch !== 'arm64') throw new Refusal('iclone os ships for Apple silicon (arm64) only.');
  if (sys.uid === 0) {
    throw new Refusal('Do not run icloneos as root or with sudo; it installs for your user only.');
  }
}

/**
 * Checkpoint between steps: a SIGINT/SIGTERM only sets the abort flag, so a run stops here, never between the
 * two renames of the swap.
 * @param {System} sys
 * @returns {void}
 */
function assertNotInterrupted(sys) {
  if (sys.abortSignal.aborted) throw new Interrupted(String(sys.abortSignal.reason));
}

/**
 * @param {System} sys
 * @param {boolean} [requireSignedSums]
 * @returns {Promise<Release>}
 */
export async function resolveLatestRelease(sys, requireSignedSums = RELEASE_CONTRACT.requireSignedSums) {
  const version = parseFeedVersion(await sys.fetchText(latestAssetUrl(RELEASE_CONTRACT.feedFile)));
  assertNotBelowFloor(version);
  const sumsText = await sys.fetchText(taggedAssetUrl(version, RELEASE_CONTRACT.sumsFile));
  if (requireSignedSums) await verifySignedSums(sys, version, sumsText);
  const sums = parseSha256Sums(sumsText);
  return { version, dmgSha256: expectedHashFor(sums, RELEASE_CONTRACT.dmgFile) };
}

/**
 * @param {System} sys
 * @param {string} version
 * @param {string} sumsText
 * @returns {Promise<void>}
 */
async function verifySignedSums(sys, version, sumsText) {
  const work = await mkdtemp(join(sys.tmpRoot, 'icloneos-sums-'));
  try {
    const sumsPath = join(work, RELEASE_CONTRACT.sumsFile);
    const signaturePath = join(work, RELEASE_CONTRACT.sumsSignatureFile);
    await writeFile(sumsPath, sumsText, { mode: 0o600, flag: 'wx' });
    await sys.download(taggedAssetUrl(version, RELEASE_CONTRACT.sumsSignatureFile), signaturePath);
    await verifySumsSignature(sys.run, { sumsPath, signaturePath, workDir: work });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * @param {System} sys
 * @param {string} plist
 * @param {string} key
 * @returns {Promise<string | undefined>}
 */
async function readPlistKey(sys, plist, key) {
  const result = await sys.run('plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * @param {System} sys
 * @param {string} appPath
 * @returns {Promise<{ bundleId: string | undefined, version: string | undefined }>}
 */
export async function readBundleInfo(sys, appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  return {
    bundleId: await readPlistKey(sys, plist, 'CFBundleIdentifier'),
    version: await readPlistKey(sys, plist, 'CFBundleVersion'),
  };
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every verb treats a symlinked `iclone os.app` the same way: it is never followed, replaced or removed.
 * @param {string} path
 * @returns {Promise<void>}
 */
async function assertNotSymlink(path) {
  const stats = await lstat(path).catch(() => undefined);
  if (stats?.isSymbolicLink()) {
    throw new Refusal(`${path} is a symbolic link; icloneos will not follow, replace or remove it.`);
  }
}

/**
 * @param {System} sys
 * @param {string} appPath
 * @returns {Promise<boolean>}
 */
async function isRunning(sys, appPath) {
  const executablePrefix = join(appPath, 'Contents', 'MacOS', '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = await sys.run('pgrep', ['-f', `^${executablePrefix}`]);
  return result.code === 0;
}

/**
 * @param {System} sys
 * @param {string} appPath
 * @returns {Promise<string | undefined>} the installed version, after proving the bundle is ours
 */
async function assertOurBundle(sys, appPath) {
  const info = await readBundleInfo(sys, appPath);
  if (info.bundleId !== RELEASE_CONTRACT.bundleId) {
    throw new Refusal(
      `${appPath} is not iclone os (bundle id ${info.bundleId ?? 'unreadable'}); icloneos will not touch it.`,
    );
  }
  return info.version;
}

/**
 * @param {System} sys
 * @param {string | undefined} dest
 * @returns {Promise<string>}
 */
export async function locateInstalledApp(sys, dest) {
  const dirs = dest === undefined ? defaultSearchDirs(sys) : [resolve(dest)];
  for (const dir of dirs) {
    const candidate = join(dir, RELEASE_CONTRACT.appBundleName);
    if (await exists(candidate)) {
      await assertNotSymlink(candidate);
      return candidate;
    }
  }
  throw new Refusal(`iclone os is not installed in ${dirs.join(' or ')}; run "icloneos install" first.`);
}

/**
 * @param {System} sys
 * @param {string} mountPoint
 * @returns {Promise<void>}
 */
async function detach(sys, mountPoint) {
  const result = await sys.run('hdiutil', ['detach', mountPoint, '-quiet']);
  if (result.code !== 0) await sys.run('hdiutil', ['detach', mountPoint, '-force', '-quiet']);
}

/**
 * Puts the previous app back if the swap did not finish, then removes the staging folder. If the restore itself
 * fails, the staging folder is kept so the previous app is never deleted.
 * @param {string} staging
 * @param {string} target
 * @returns {Promise<void>}
 */
async function settleStaging(staging, target) {
  const previous = join(staging, PREVIOUS_APP);
  if ((await exists(previous)) && !(await exists(target))) {
    try {
      await rename(previous, target);
    } catch {
      throw new Refusal(`The previous iclone os could not be put back; it is safe at ${previous}. Move it to ${target}.`);
    }
  }
  await rm(staging, { recursive: true, force: true });
}

/**
 * A run killed outright (SIGKILL, power loss) can leave the previous app inside a staging folder with nothing at
 * the target. Every verb sweeps those first: the previous app goes back if the target is missing, and the
 * leftovers are removed.
 * @param {string} dir
 * @param {Logger} log
 * @returns {Promise<void>}
 */
export async function recoverInterruptedSwaps(dir, log) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const target = join(dir, RELEASE_CONTRACT.appBundleName);
  for (const entry of entries) {
    if (!entry.name.startsWith(STAGING_PREFIX) || !entry.isDirectory()) continue;
    const staging = join(dir, entry.name);
    const previous = join(staging, PREVIOUS_APP);
    try {
      const previousStats = await lstat(previous).catch(() => undefined);
      if (previousStats?.isDirectory() && !(await exists(target))) {
        await rename(previous, target);
        log(`Restored iclone os at ${target} after an interrupted install.`);
      }
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      log(`Could not clean up ${staging}: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
}

/**
 * @param {System} sys
 * @param {string | undefined} dest
 * @param {Logger} log
 * @returns {Promise<string>}
 */
async function locateAfterRecovery(sys, dest, log) {
  const dirs = dest === undefined ? defaultSearchDirs(sys) : [resolve(dest)];
  for (const dir of dirs) await recoverInterruptedSwaps(dir, log);
  return locateInstalledApp(sys, dest);
}

/**
 * Download → hash → disk-image signature → mount → copy into a staging folder beside the target →
 * app signature + notarisation + team + bundle id + version → atomic swap. Nothing reaches the
 * target path until every check has passed on the exact bytes that will be moved.
 * @param {System} sys
 * @param {Release} release
 * @param {string} destDir
 * @param {Logger} log
 * @returns {Promise<string>} the installed app path
 */
async function installRelease(sys, release, destDir, log) {
  const target = join(destDir, RELEASE_CONTRACT.appBundleName);
  const work = await mkdtemp(join(sys.tmpRoot, 'icloneos-'));
  /** @type {string | undefined} */
  let staging;
  try {
    const dmg = join(work, RELEASE_CONTRACT.dmgFile);
    log(`Downloading iclone os ${release.version} …`);
    await sys.download(taggedAssetUrl(release.version, RELEASE_CONTRACT.dmgFile), dmg);
    assertNotInterrupted(sys);

    log('Verifying sha256 against SHA256SUMS.txt …');
    await verifyDigest(dmg, release.dmgSha256, RELEASE_CONTRACT.dmgFile);
    log('Verifying the disk image signature and notarisation …');
    await verifyDiskImage(sys.run, dmg);
    assertNotInterrupted(sys);

    // K81: the staging folder exists before anything is mounted, and the mount itself runs inside the
    // try/finally that detaches it: no failure (or interruption) between the two can leave the image mounted,
    // and the work folder is never removed from under a live read-only mount.
    staging = await mkdtemp(join(destDir, STAGING_PREFIX));
    const staged = join(staging, RELEASE_CONTRACT.appBundleName);
    const mountPoint = join(work, 'mnt');
    await mkdir(mountPoint, { mode: 0o700 });
    try {
      const attach = await sys.run('hdiutil', [
        'attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, '-quiet',
      ]);
      if (attach.code !== 0) throw new Refusal('hdiutil could not mount the verified disk image.');
      const source = join(mountPoint, RELEASE_CONTRACT.appBundleName);
      const sourceStat = await lstat(source).catch(() => undefined);
      if (sourceStat === undefined || !sourceStat.isDirectory()) {
        throw new Refusal(`The disk image does not contain ${RELEASE_CONTRACT.appBundleName} as a real folder.`);
      }
      const copy = await sys.run('ditto', [source, staged]);
      if (copy.code !== 0) throw new Refusal('Copying the app out of the disk image failed.');
    } finally {
      await detach(sys, mountPoint);
    }
    assertNotInterrupted(sys);

    log('Verifying the app signature, team id and notarisation …');
    await verifyAppBundle(sys.run, staged);
    const stagedInfo = await readBundleInfo(sys, staged);
    if (stagedInfo.version !== release.version) {
      throw new Refusal(
        `The app reports version ${stagedInfo.version ?? 'none'} but the release feed says ${release.version}.`,
      );
    }

    if (await exists(target)) {
      await assertNotSymlink(target);
      await assertOurBundle(sys, target);
      if (await isRunning(sys, target)) throw new Refusal('iclone os is running; quit it and try again.');
    }
    assertNotInterrupted(sys);
    // The swap: no checkpoint between these renames. If anything stops the run in between, `settleStaging`
    // (or the next run's sweep) puts the previous app back.
    if (await exists(target)) await rename(target, join(staging, PREVIOUS_APP));
    await rename(staged, target);
    return target;
  } finally {
    try {
      if (staging !== undefined) await settleStaging(staging, target);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function assertWritableDir(dir) {
  await mkdir(dir, { recursive: true });
  try {
    await access(dir, fsConstants.W_OK);
  } catch {
    throw new Refusal(`${dir} is not writable by you; use --dest ~/Applications (icloneos never uses sudo).`);
  }
}

/**
 * @typedef {{ dest?: string | undefined, force?: boolean, allowDowngrade?: boolean }} VerbOptions
 */

/**
 * @param {System} sys
 * @param {VerbOptions} options
 * @param {Logger} log
 * @returns {Promise<string>}
 */
export async function install(sys, options, log) {
  assertSupportedHost(sys);
  const destDir = resolve(options.dest ?? join(sys.home, 'Applications'));
  await assertWritableDir(destDir);
  await recoverInterruptedSwaps(destDir, log);
  const release = await resolveLatestRelease(sys);
  assertNotInterrupted(sys);
  const target = join(destDir, RELEASE_CONTRACT.appBundleName);
  if (await exists(target)) {
    await assertNotSymlink(target);
    const installed = await assertOurBundle(sys, target);
    const order = installed === undefined ? -1 : compareVersions(installed, release.version);
    if (order > 0 && !options.allowDowngrade) {
      throw new Refusal(
        `iclone os ${installed} is installed and the release feed offers the older ${release.version}; pass --allow-downgrade to install it anyway.`,
      );
    }
    if (order === 0 && !options.force) {
      log(`iclone os ${installed} is already installed at ${target}.`);
      return target;
    }
  }
  const installedPath = await installRelease(sys, release, destDir, log);
  log(`Installed iclone os ${release.version} at ${installedPath}.`);
  return installedPath;
}

/**
 * Never downgrades: an older feed leaves the installed app alone (use `install --allow-downgrade` for that).
 * @param {System} sys
 * @param {VerbOptions} options
 * @param {Logger} log
 * @returns {Promise<string>}
 */
export async function update(sys, options, log) {
  assertSupportedHost(sys);
  const appPath = await locateAfterRecovery(sys, options.dest, log);
  const installed = await assertOurBundle(sys, appPath);
  const release = await resolveLatestRelease(sys);
  assertNotInterrupted(sys);
  if (installed !== undefined && compareVersions(installed, release.version) >= 0) {
    log(`iclone os ${installed} is up to date.`);
    return appPath;
  }
  if (await isRunning(sys, appPath)) throw new Refusal('iclone os is running; quit it and try again.');
  const destDir = resolve(appPath, '..');
  await assertWritableDir(destDir);
  const updated = await installRelease(sys, release, destDir, log);
  log(`Updated iclone os ${installed ?? '?'} → ${release.version}.`);
  return updated;
}

/**
 * Re-verifies the signature before every open: apps installed by this launcher carry no quarantine flag, so
 * Gatekeeper does not assess them on launch.
 * @param {System} sys
 * @param {VerbOptions} options
 * @param {Logger} log
 * @returns {Promise<void>}
 */
export async function launch(sys, options, log) {
  assertSupportedHost(sys);
  const appPath = await locateAfterRecovery(sys, options.dest, log);
  await assertOurBundle(sys, appPath);
  await verifySignedApp(sys.run, appPath);
  const result = await sys.run('open', [appPath]);
  if (result.code !== 0) throw new Refusal(`macOS could not open ${appPath}.`);
  log(`Launched ${appPath}.`);
}

/**
 * Removes the app bundle only. User data (agents, keys, history) is deliberately kept. The bundle must carry
 * our signature unless --force is given: the Info.plist alone is not proof that the folder is ours.
 * @param {System} sys
 * @param {VerbOptions} options
 * @param {Logger} log
 * @returns {Promise<void>}
 */
export async function uninstall(sys, options, log) {
  assertSupportedHost(sys);
  const appPath = await locateAfterRecovery(sys, options.dest, log);
  await assertOurBundle(sys, appPath);
  if (await isRunning(sys, appPath)) throw new Refusal('iclone os is running; quit it and try again.');
  if (!options.force) {
    try {
      await verifySignedApp(sys.run, appPath);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      throw new Refusal(`${appPath} does not carry a valid iclone os signature (${error.message}); pass --force to remove it anyway.`);
    }
  }
  await rm(appPath, { recursive: true, force: false });
  log(`Removed ${appPath}. Your data in ~/.hermes and ~/Library/Application Support/iclone os was kept.`);
}
