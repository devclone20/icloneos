// @ts-check
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { Interrupted, Refusal } from './contract.js';
import { install, launch, uninstall, update } from './installer.js';

/** @typedef {import('./system.js').System} System */

const USAGE = `icloneos — install and run the iclone os desktop app (macOS, Apple silicon)

Usage:
  icloneos install   [--dest <dir> | --system] [--force] [--allow-downgrade]
  icloneos launch    [--dest <dir> | --system]
  icloneos update    [--dest <dir> | --system]
  icloneos uninstall [--dest <dir> | --system] [--force]
  icloneos --version | --help

Every install and update downloads the release from github.com/devclone20/icloneos and
refuses to move anything unless the sha256 matches SHA256SUMS.txt and the app is signed and notarised
by team HJSLQL98D8. It never installs a version below the supported minimum, nor one older than the
installed app unless you pass --allow-downgrade. launch re-checks the signature before opening.
The default destination is ~/Applications; --system uses /Applications. icloneos never asks for sudo.`;

const VERBS = Object.freeze({ install, launch, update, uninstall });

const OPTIONS = /** @type {const} */ ({
  dest: { type: 'string' },
  system: { type: 'boolean' },
  force: { type: 'boolean' },
  'allow-downgrade': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
});

/** @param {readonly string[]} argv */
function parseCommandLine(argv) {
  return parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: OPTIONS });
}

/**
 * @param {string} verb
 * @returns {verb is keyof typeof VERBS}
 */
function isVerb(verb) {
  return Object.hasOwn(VERBS, verb);
}

/** @returns {string} */
export function packageVersion() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}

/**
 * @param {readonly string[]} argv
 * @param {System} sys
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, sys, io) {
  /** @type {ReturnType<typeof parseCommandLine>} */
  let parsed;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    io.err(`icloneos: ${error instanceof Error ? error.message : String(error)}`);
    io.err(USAGE);
    return 64;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(packageVersion());
    return 0;
  }
  if (values.help || positionals.length === 0) {
    io.out(USAGE);
    return 0;
  }
  const [verb, ...extra] = positionals;
  if (verb === undefined || !isVerb(verb) || extra.length > 0) {
    io.err(`icloneos: unknown command "${positionals.join(' ')}".`);
    io.err(USAGE);
    return 64;
  }
  if (values.dest !== undefined && values.system) {
    io.err('icloneos: use either --dest or --system, not both.');
    return 64;
  }
  if (values.force && verb !== 'install' && verb !== 'uninstall') {
    io.err('icloneos: --force only applies to install and uninstall.');
    return 64;
  }
  if (values['allow-downgrade'] && verb !== 'install') {
    io.err('icloneos: --allow-downgrade only applies to install.');
    return 64;
  }
  const dest = values.system ? sys.systemAppsDir : values.dest;
  try {
    await VERBS[verb](sys, { dest, force: values.force === true, allowDowngrade: values['allow-downgrade'] === true }, io.err);
    return 0;
  } catch (error) {
    if (sys.abortSignal.aborted || error instanceof Interrupted) {
      const signal = String(sys.abortSignal.reason ?? (error instanceof Interrupted ? error.signal : 'SIGINT'));
      io.err('icloneos: interrupted — nothing half-installed: the app in place is either the one you had or the fully verified new one.');
      return signal === 'SIGTERM' ? 143 : 130;
    }
    if (error instanceof Refusal) {
      io.err(`icloneos: refused — ${error.message}`);
      return 2;
    }
    io.err(`icloneos: failed — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
