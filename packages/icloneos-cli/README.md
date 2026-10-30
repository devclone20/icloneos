# @icloneos/cli

> **Not yet published.** `@icloneos/cli` (npm) and `icloneos` (PyPI) are not published yet. Do not install them from npm or PyPI until this line is removed. Any package under those names today is not ours. Install from https://github.com/devclone20/icloneos/releases only.

Thin launcher for the iclone os macOS app (Apple silicon). Zero runtime dependencies.

```sh
npm install -g @icloneos/cli
icloneos install      # into ~/Applications; --system for /Applications; --dest <dir> anywhere
icloneos launch       # re-checks the signature, then opens the app
icloneos update       # never downgrades
icloneos uninstall    # removes the app only; your data is kept
```

Every install and update fetches the release from
[devclone20/icloneos](https://github.com/devclone20/icloneos), and refuses to
move anything unless:

1. the DMG's sha256 equals the entry in that release's `SHA256SUMS.txt`;
2. the DMG passes `codesign --verify --strict`, is Developer ID signed by team `HJSLQL98D8`, and
   `spctl` reports it notarised;
3. the copied app passes `codesign --verify --deep --strict`, is signed by the same team, identifies as
   `io.cloneframe.icloneos`, is notarised (`spctl -a -t exec`), and reports the feed's version.

It never installs a version below the supported minimum (the rollback floor), nor one older than the
installed app unless you pass `install --allow-downgrade`. A symlinked `iclone os.app` is never
followed, replaced or removed. Ctrl-C at any point keeps the installed app.

Apps installed this way carry no quarantine flag, so Gatekeeper does not assess them on launch; that is
why `launch` re-runs `codesign --verify --deep --strict` and the team check before every open.

It never calls `sudo` and refuses to run as root. Exit codes: `0` ok, `2` refused (one-sentence
reason on stderr), `64` usage error, `130`/`143` interrupted (installed app kept), `1` unexpected failure.
