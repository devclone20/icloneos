# icloneos (Python / pipx)

> **Not yet published.** `@icloneos/cli` (npm) and `icloneos` (PyPI) are not published yet. Do not install them from npm or PyPI until this line is removed. Any package under those names today is not ours. Install from https://github.com/devclone20/icloneos/releases only.

```sh
pipx install icloneos
icloneos install          # ~/Applications, no sudo
icloneos launch | update | uninstall
```

Standard library only. Every install downloads the release from
github.com/devclone20/icloneos and refuses to move anything unless the DMG's sha256 matches
`SHA256SUMS.txt` and both the DMG and the app are Developer ID signed by team `HJSLQL98D8` and
notarised. It never installs below the supported minimum version, nor older than the installed app
unless you pass `install --allow-downgrade`, and `launch` re-checks the signature before every open
(apps installed this way carry no quarantine flag, so Gatekeeper does not check them). Full documentation: `packaging/README.md` in the iclone os repository.
