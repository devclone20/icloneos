/**
 * V3-S r4 (m-a′; lead ruling 37, interim until V3-RT's artifact) — no gated Python reads or writes bytecode, anywhere.
 *
 * Python prefers a `.pyc` to the source it caches and never compares an unchecked-hash one with that source. Round 3
 * gave each gated Python a new, empty PYTHONPYCACHEPREFIX folder, but that folder could be listed by the same user
 * (0700 keeps other users out, not this one), and Python reads a prefix `.pyc` at IMPORT time — so for a lazily
 * imported module the window was the whole life of the process (shown live: a planted pyc read 2 s after start).
 *
 * Now the prefix lies UNDER A NON-DIRECTORY (`NO_BYTECODE_PREFIX`, below `/dev/null`): every lookup of
 * `<prefix>/<source dir>/<module>.pyc` fails (ENOTDIR) and Python compiles from source; nothing can ever be created
 * there, by the app or anyone else, so there is nothing to sweep and no window. With a prefix set Python never looks in
 * a source tree's `__pycache__/` either, and PYTHONDONTWRITEBYTECODE=1 means nothing is written. A same-user edit of a
 * `.py` after the check stays K-S1 (V3-RT), the same class as before.
 *
 * Cost: every gated Python compiles what it imports, every time (as round 3; measured in V3S_builder_r4.md). Ruling
 * 37's end state (V3-RT): the artifact ships checked-hash `.pyc`s covered by its manifest, read-only, no per-spawn
 * compile — this module's prefix then points at that cache.
 *
 * The two functions keep round 3's names (their call sites are shared with V3-RT's branch): `freshPycachePrefix`
 * removes what round 3 left in its root and returns `NO_BYTECODE_PREFIX`; `releasePycachePrefix` has nothing to remove.
 */
import fs from 'node:fs'

export type PycacheTag = 'probe' | 'spawn'

/** Lies under a character device (posix) / the NUL device (win32): no directory can ever exist there. */
export const NO_BYTECODE_PREFIX =
  process.platform === 'win32' ? '\\\\.\\NUL\\icloneos-no-bytecode' : '/dev/null/icloneos-no-bytecode'

/** The node the prefix lies under; it must exist and never be a directory, or the prefix could hold files. */
const PREFIX_PARENT = process.platform === 'win32' ? null : '/dev/null'

/** Round 3's per-process folders (a dead process' leftovers) are removed once per root; a link is unlinked, never followed. */
const swept = new Set<string>()

function sweepRoundThreeRoot(root: string): void {
  if (swept.has(root)) {
    return
  }

  try {
    const stat = fs.lstatSync(root)

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.unlinkSync(root)
    } else {
      fs.rmSync(root, { force: true, recursive: true })
    }
  } catch {
    // Missing (the common case) or not removable now: nothing reads from it any more.
  }

  swept.add(root)
}

/**
 * The PYTHONPYCACHEPREFIX of one gated Python (probe or spawn): `NO_BYTECODE_PREFIX`. Removes round 3's folder at
 * `legacyRoot` once. Throws when the prefix could hold files (its parent is a directory), so the caller refuses.
 */
export function freshPycachePrefix(legacyRoot: string, _tag: PycacheTag): string {
  sweepRoundThreeRoot(legacyRoot)

  if (PREFIX_PARENT && (!fs.existsSync(PREFIX_PARENT) || fs.lstatSync(PREFIX_PARENT).isDirectory())) {
    throw new Error(`${PREFIX_PARENT} is not a device here, so ${NO_BYTECODE_PREFIX} could hold bytecode`)
  }

  return NO_BYTECODE_PREFIX
}

/** Nothing to remove: the prefix can hold nothing. Kept so a spawn's exit hook stays the same across fronts. */
export function releasePycachePrefix(_prefix: string): void {}

/** The env every gated Python runs with: no bytecode read (the prefix can hold none) and none written. */
export function pycacheEnv(prefix: string): { PYTHONDONTWRITEBYTECODE: '1'; PYTHONPYCACHEPREFIX: string } {
  return { PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: prefix }
}

/**
 * Ruling 37, end state (V3-RT): a MANAGED runtime the app has just verified against its manifest (every shipped `.pyc`
 * is a PEP 552 checked-hash file covered by the manifest; any unlisted `.pyc` was removed) runs on that bytecode:
 * no prefix, nothing written, and every hash-based `.pyc` checked against its source at import.
 */
export const CHECKED_BYTECODE_FLAGS: readonly string[] = ['--check-hash-based-pycs', 'always']

export function shippedBytecodeEnv(): { PYTHONDONTWRITEBYTECODE: '1' } {
  return { PYTHONDONTWRITEBYTECODE: '1' }
}
