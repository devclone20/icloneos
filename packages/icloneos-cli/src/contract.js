// @ts-check
// Mirrors packaging/release-contract.json; test/channels.test.js keeps every channel in agreement.

export const RELEASE_CONTRACT = Object.freeze({
  repository: 'devclone20/icloneos',
  feedFile: 'latest-mac.yml',
  sumsFile: 'SHA256SUMS.txt',
  sumsSignatureFile: 'SHA256SUMS.txt.sig',
  // Off until the owner publishes the first signed list (packaging/README.md, "Signing SHA256SUMS").
  requireSignedSums: false,
  appleRootCaSha256: 'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024',
  dmgFile: 'iclone-os-mac-arm64.dmg',
  appBundleName: 'iclone os.app',
  bundleId: 'io.cloneframe.icloneos',
  teamId: 'HJSLQL98D8',
  // The rollback floor: raise it with every launcher release that follows an app release with a known flaw.
  minimumVersion: '0.0.3',
  allowedDownloadHosts: Object.freeze([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ]),
  maxDmgBytes: 2 * 1024 ** 3,
});

/** A refusal is an expected, explained stop: the CLI prints the one-sentence reason and exits 2. */
export class Refusal extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = 'Refusal';
  }
}

/** The user (or the OS) stopped the run with SIGINT or SIGTERM; the CLI exits 130 or 143. */
export class Interrupted extends Error {
  /** @param {string} signal */
  constructor(signal) {
    super(`interrupted by ${signal}`);
    this.name = 'Interrupted';
    this.signal = signal;
  }
}
