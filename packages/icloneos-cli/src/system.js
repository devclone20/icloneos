// @ts-check
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { RELEASE_CONTRACT, Refusal } from './contract.js';
import { assertAllowedUrl } from './feed.js';

/**
 * Absolute paths only: a hostile PATH must not be able to substitute codesign or spctl.
 * @type {Readonly<Record<string, string>>}
 */
const SYSTEM_TOOLS = Object.freeze({
  codesign: '/usr/bin/codesign',
  ditto: '/usr/bin/ditto',
  hdiutil: '/usr/bin/hdiutil',
  open: '/usr/bin/open',
  openssl: '/usr/bin/openssl',
  pgrep: '/usr/bin/pgrep',
  plutil: '/usr/bin/plutil',
  security: '/usr/bin/security',
  spctl: '/usr/sbin/spctl',
});

const MAX_REDIRECTS = 5;
const MAX_TEXT_BYTES = 1024 * 1024;

/**
 * @typedef {import('./verify.js').Runner} Runner
 * @typedef {{
 *   run: Runner,
 *   fetchText: (url: string) => Promise<string>,
 *   download: (url: string, destination: string, onProgress?: (received: number, total: number) => void) => Promise<void>,
 *   abortSignal: AbortSignal,
 *   home: string,
 *   systemAppsDir: string,
 *   tmpRoot: string,
 *   platform: string,
 *   arch: string,
 *   uid: number,
 * }} System
 */

/** @type {Runner} */
export function runSystemTool(command, args) {
  const executable = SYSTEM_TOOLS[command];
  if (executable === undefined) return Promise.reject(new Error(`Unknown system tool: ${command}`));
  return new Promise((resolve) => {
    execFile(executable, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Follows redirects by hand so every hop, not only the last, must be HTTPS on a GitHub release host.
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<Response>}
 */
async function fetchVerified(url, signal) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertAllowedUrl(current);
    /** @type {Response} */
    let response;
    try {
      response = await fetch(current, { redirect: 'manual', signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Refusal(`Could not reach ${new URL(current).hostname}: ${error instanceof Error ? error.message : String(error)}.`);
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Refusal(`The release server answered HTTP ${response.status} for ${url}.`);
    return response;
  }
  throw new Refusal(`${url} redirected more than ${MAX_REDIRECTS} times.`);
}

/**
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function fetchText(url, signal) {
  const response = await fetchVerified(url, signal);
  if (response.body === null) return '';
  /** @type {Buffer[]} */
  const chunks = [];
  let received = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    received += chunk.length;
    // Leaving the loop by throwing destroys the stream, which cancels the download.
    if (received > MAX_TEXT_BYTES) throw new Refusal(`${url} is unexpectedly large for a text file.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {string} url
 * @param {string} destination
 * @param {AbortSignal} signal
 * @param {(received: number, total: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
async function download(url, destination, signal, onProgress) {
  const response = await fetchVerified(url, signal);
  if (response.body === null) throw new Refusal(`The release server sent an empty body for ${url}.`);
  const total = Number(response.headers.get('content-length') ?? '0');
  if (total > RELEASE_CONTRACT.maxDmgBytes) throw new Refusal('The disk image is larger than any iclone os release can be.');
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > RELEASE_CONTRACT.maxDmgBytes) {
        callback(new Refusal('The disk image is larger than any iclone os release can be.'));
        return;
      }
      onProgress?.(received, total);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    meter,
    createWriteStream(destination, { mode: 0o600, flags: 'wx' }),
    { signal },
  );
}

/**
 * @param {AbortSignal} abortSignal aborted by bin/icloneos.js on SIGINT or SIGTERM
 * @returns {System}
 */
export function realSystem(abortSignal) {
  return {
    run: runSystemTool,
    fetchText: (url) => fetchText(url, abortSignal),
    download: (url, destination, onProgress) => download(url, destination, abortSignal, onProgress),
    abortSignal,
    home: homedir(),
    systemAppsDir: '/Applications',
    tmpRoot: tmpdir(),
    platform: process.platform,
    arch: process.arch,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  };
}
