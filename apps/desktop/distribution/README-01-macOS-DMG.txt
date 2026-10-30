iclone os {{version}} for macOS

Requirements: macOS 12 or later on Apple silicon.

Install
1. Open iclone-os-mac-arm64.dmg.
2. Drag "iclone os" to Applications.
3. Open it from Applications. The app is signed with a Developer ID and notarized by Apple, so Gatekeeper opens it
   without warnings. Opened from Downloads, it offers to move itself to Applications.
4. The Hermes runtime pinned in runtime.json ships inside the app. The first launch installs it from there
   (sha256-checked; the upstream repository is never contacted) and downloads only uv, Python, Node and their
   PyPI/npm packages (internet needed once).

Verify the download
  shasum -a 256 -c SHA256SUMS.txt

Updates arrive inside the app (Settings > About) from the same release feed (latest-mac.yml).
