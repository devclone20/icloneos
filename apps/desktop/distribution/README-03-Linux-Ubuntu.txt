iclone os {{version}} for Linux (Ubuntu 22.04 / 24.04, x64 or arm64)

Packages
  iclone-os-{{version}}-linux-amd64.deb       Ubuntu/Debian, x64 (recommended)
  iclone-os-{{version}}-linux-arm64.deb       Ubuntu/Debian, arm64
  iclone-os-{{version}}-linux-x86_64.AppImage any distribution, x64
  iclone-os-{{version}}-linux-arm64.AppImage  any distribution, arm64

Install (.deb)
  sudo apt install ./iclone-os-{{version}}-linux-amd64.deb
  Then open "iclone os" from the app grid, or run: iclone-os
Run (AppImage)
  chmod +x iclone-os-{{version}}-linux-x86_64.AppImage && ./iclone-os-{{version}}-linux-x86_64.AppImage
  Ubuntu 24.04 needs FUSE 2 for AppImages: sudo apt install libfuse2t64   (22.04: sudo apt install libfuse2)

The Hermes runtime pinned in runtime.json ships inside the package. The first launch installs it from there
(sha256-checked; the upstream repository is never contacted) and downloads only the toolchain it builds on:
uv, Python, Node and their PyPI/npm packages (internet needed once). The .deb already depends on git, curl,
python3 and libatomic1. AppImage users install these first (and .deb users too if it asks for build tools):
  sudo apt install git build-essential curl python3 libatomic1

Secrets: iclone os stores tokens in the desktop keyring (GNOME Keyring or KWallet; it picks the one of your session).
Without a running keyring it does not save remote gateway tokens and says so. It writes a token in plain text only
after you opt in, in one of two ways: start it with --password-store=basic, or confirm "Store the gateway token in
plain text?" in Settings -> Gateways when you save a token with no keyring available.
The econ apps keep the acp CLI login in the same keyring.

arm64 cap: Virtuals ships the acp CLI signer for x86-64 Linux only, so the arm64 packages do not include it. On arm64
the econ apps and every acp command that signs are unavailable; chat, sessions, skills and settings work as on x64.

Updates: iclone os has no in-app updater on Linux. To update, install the next .deb the same way
(sudo apt install ./iclone-os-<next version>-linux-amd64.deb), or replace the AppImage file with the next one.
The packages are not code-signed (Linux has no OS-level signing for them); verify them instead:
  sha256sum -c SHA256SUMS.txt
