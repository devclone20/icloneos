'use strict'

// iclone os, v0.0.9: inert stand-in for anymatch, installed by the npm override in ../../package.json.
// anymatch 3 depends on picomatch 2, and every picomatch up to 4.0.7 has GHSA-fc5q-39xc-vjpf (ReDoS through
// single-branch repeated extglobs; no patched release). In this lock the only importer of anymatch is unstorage's
// Node `fs` driver (unstorage/drivers/fs), which privy-login.js (a browser bundle) never includes. If a future
// bundle ever reached it, matching would fail loudly here instead of compiling an untrusted glob.
function anymatch() {
  throw new Error(
    'anymatch is not available in the iclone os sign-in island (GHSA-fc5q-39xc-vjpf): ' +
      "unstorage's Node fs driver is not part of the browser bundle"
  )
}

module.exports = anymatch
module.exports.default = anymatch
