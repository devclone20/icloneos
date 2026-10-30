iclone os {{version}} — Linux (Ubuntu) — PENDING

The Linux packages for this version are not here yet.

They are built by the Linux CI workflow (.github/workflows/release-linux.yml) on GitHub, from the same commit as the
macOS DMG: an amd64 and an arm64 .deb, plus an AppImage for each. That workflow runs once the owner approves pushing
it. When the run finishes, this folder is rebuilt with:

  npm run distribution -- <version> --linux-run <run id> --replace

Until then, use the macOS DMG (01-macOS-DMG) or the Chrome app (02-Chrome-App).
