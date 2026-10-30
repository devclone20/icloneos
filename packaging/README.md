# Installing iclone os from a terminal

> **Not yet published.** `@icloneos/cli` (npm) and `icloneos` (PyPI) are not published yet. Do not install them from npm or PyPI until this line is removed. Any package under those names today is not ours. Install from https://github.com/devclone20/icloneos/releases only.

iclone os is a signed, notarised macOS app (Apple silicon, macOS 12+). Package managers install
command-line tools, not app bundles, so every terminal channel publishes the same small **launcher**
(or, for Homebrew, a cask pointing at the DMG). Every launcher fetches the **same** artefact from
[`devclone20/icloneos`](https://github.com/devclone20/icloneos) and verifies it
before anything is moved. None of them uses `sudo`.

## The commands, per channel

| Channel | Install the app | Launch | Update | Uninstall |
|---|---|---|---|---|
| Homebrew | `brew install --cask devclone20/iclone/icloneos` | `open -a "iclone os"` | `brew upgrade --cask icloneos` | `brew uninstall --cask icloneos` (`--zap` also removes app data) |
| npm | `npm install -g @icloneos/cli && icloneos install` | `icloneos launch` | `icloneos update` | `icloneos uninstall` then `npm uninstall -g @icloneos/cli` |
| pipx | `pipx install icloneos && icloneos install` | `icloneos launch` | `icloneos update` | `icloneos uninstall` then `pipx uninstall icloneos` |
| curl \| sh | `curl -fsSL https://cloneframe.io/install.sh \| sh` | `open -a "iclone os"` | run the same line again | drag `~/Applications/iclone os.app` to the Bin |

`icloneos launch` re-checks the signature before every open (see "Gatekeeper" below); `open -a` does not.

The npm and pipx launchers take `--dest <dir>` (any folder you own) or `--system` (`/Applications`);
the default is `~/Applications`. `install.sh` takes `--dest <dir>`: `curl -fsSL … | sh -s -- --dest DIR`.
Homebrew installs into `/Applications` by default; `--appdir=~/Applications` keeps it per-user.
`install --allow-downgrade` (launchers) and `--allow-downgrade` (`install.sh`) accept a release older than the
installed app; nothing ever installs below the floor (see below). `uninstall --force` removes a bundle whose
signature no longer checks out. Exit codes: `0` ok, `2` refused (one-sentence reason), `64` usage,
`130`/`143` interrupted by Ctrl-C/SIGTERM (the installed app is kept), `1` unexpected.

Uninstalling removes the app only. Agents, keys and history in `~/.hermes` and
`~/Library/Application Support/iclone os` are kept; only `brew uninstall --zap` removes the latter,
and nothing ever removes `~/.hermes`.

## How each channel works

**Homebrew cask** (`homebrew/Casks/icloneos.rb`). The cask pins the DMG's URL **and its sha256** inside
our own tap. Homebrew downloads, checks the hash, mounts, copies `iclone os.app` and runs no code of ours.
Homebrew sets the `com.apple.quarantine` flag, so Gatekeeper assesses the signature and notarisation on
first launch. Because the hash lives in a different repository from the release, this is the strongest
channel: tampering needs both repositories.

**Gatekeeper does not check apps installed by npm, pipx or `install.sh`.** Those downloads carry no
quarantine flag (`xattr -l` on the installed app is empty), so macOS does not assess them on launch. That is
why the launchers run every check below themselves before moving anything, and why `icloneos launch`
re-runs `codesign --verify --deep --strict` plus the team and bundle-id checks before every open.

**npm** (`../packages/icloneos-cli`, `@icloneos/cli`, command `icloneos`). Plain ESM checked by
`tsc --strict`, zero runtime dependencies, no install scripts, ~45 kB unpacked. The source you audit
is exactly the source that runs.

**pipx / pip** (`python/`, `icloneos`). Standard library only, the same four verbs, the same checks.
It uses macOS's `/etc/ssl/cert.pem` when the python.org build has no CA store, so TLS verification
stays on without depending on `certifi`.

**install.sh**. POSIX `sh`, passes `shellcheck`, everything inside `main()` so a truncated download
runs nothing. Readers can check it first:
`curl -fsSLO https://cloneframe.io/install.sh && less install.sh && sh install.sh`.

### What the launchers and install.sh check, in order, before anything is moved

1. They are on macOS arm64 and not running as root.
2. The version comes from `releases/latest/download/latest-mac.yml`. `SHA256SUMS.txt` and the DMG are
   then both fetched from tag `v<version>`, so the two cannot come from different releases.
3. HTTPS only, including redirects. The final host must be `github.com`,
   `objects.githubusercontent.com` or `release-assets.githubusercontent.com`.
4. The DMG's sha256 must equal its `SHA256SUMS.txt` entry. If it does not, the DMG is never mounted.
5. The DMG must pass `codesign --verify --strict`, carry a `Developer ID Application` leaf signed by team
   `HJSLQL98D8`, and be accepted by `spctl` as `Notarized Developer ID`.
6. The DMG is mounted read-only with `-nobrowse`, and the app is copied with `ditto` into a staging
   folder next to the destination.
7. The **staged copy** (the exact bytes that will be moved) must pass
   `codesign --verify --deep --strict`, be signed by team `HJSLQL98D8`, identify as
   `io.cloneframe.icloneos`, pass `spctl -a -t exec` as notarised, and report the feed's `CFBundleVersion`.
8. An existing `iclone os.app` is replaced only if it is not a symbolic link, its bundle id is ours and it
   is not running. The swap is two renames on one volume. If anything stops the run between them (an
   error, Ctrl-C or SIGTERM), cleanup puts the old app back; Python also holds both signals for the
   duration of the swap. A run killed outright (SIGKILL, power loss) leaves the old app in
   `.icloneos-staging-*/previous.app`, and the next run of any verb moves it back.

Before step 4 they also refuse a feed version below `minimumVersion` from `release-contract.json`
(the rollback floor, currently `0.0.3`) and, unless `--allow-downgrade` is passed, a version older than the
installed app. `update` never downgrades. A symlinked `iclone os.app` is never followed, replaced or
removed by any verb.

System tools are called by absolute path (`/usr/bin/codesign`, `/usr/sbin/spctl`, …), so a hostile
`PATH` cannot stand in for them. The hash in step 4 catches corruption and tampered mirrors. The trust
anchor is Apple's signature plus our team id (steps 5 and 7): only the holder of our Developer ID key
can produce a build that passes them.

## Development

```sh
cd packages/icloneos-cli && npm ci && npm run check          # tsc --strict + node:test
cd packaging/python && PYTHONPATH=src python3 -m unittest discover -s tests
shellcheck -s sh packaging/install.sh
```

`npm run check` also runs `test/install-sh.test.js`, which runs the real `install.sh` under `/bin/sh` (on
macOS) with only curl, codesign, spctl, hdiutil, ditto, pgrep, security and openssl stubbed. A stub `mv`
sends the script a real SIGINT/SIGTERM between the two moves of the swap.

`release-contract.json` is the single list of constants (repo, asset names, bundle id, team id,
allowed hosts). `packages/icloneos-cli/test/channels.test.js` fails if any channel drifts from it or
starts invoking `sudo`.

### When a new app version ships

The npm, pipx and `install.sh` launchers follow `latest-mac.yml` and need no change. If the previous
version has a security flaw, raise `minimumVersion` to the new version in `release-contract.json`, in
`src/contract.js`, as `MINIMUM_VERSION` in `python/src/icloneos/cli.py` and as `MIN_VERSION` in
`install.sh` (`channels.test.js` fails until all four agree), then ship a launcher release. The cask needs
two lines:

```sh
shasum -a 256 apps/desktop/release/iclone-os-mac-arm64.dmg     # the notarised DMG that was uploaded
# edit homebrew/Casks/icloneos.rb: version "X.Y.Z", sha256 "<hash>"
sh packaging/check-cask.sh --dmg apps/desktop/release/iclone-os-mac-arm64.dmg   # the release-time gate, must say OK
brew audit --cask --strict --online devclone20/iclone/icloneos
```

`check-cask.sh` is the gate that lets the Homebrew channel be listed: it refuses (exit 2) unless the cask's URL is
the tagged DMG of `devclone20/icloneos` at the cask's version, that version is not below `minimumVersion`, the URL
answers 200 on GitHub's hosts, and the downloaded DMG and the uploaded one both hash to the cask's sha256. The
cask in this tree still names 0.0.2, which `devclone20/icloneos` never published (its first release is v0.0.3), so
the gate refuses it until the bump above is made.

## Signing SHA256SUMS (prepared, off until the first signed release)

**Why.** `latest-mac.yml`, `SHA256SUMS.txt` and the DMG all come from the same release repository. Apple's
signature proves a DMG is ours, but not that it is the *current* one. Someone holding a write token for
`devclone20/icloneos` could re-point "latest" at an older, genuinely notarised build. The floor stops builds
older than `minimumVersion`. A signature on `SHA256SUMS.txt` made with the Developer ID key, which never
leaves your release keychain, also stops anything between the floor and the newest release.

**What the launchers check** (`src/sums-signature.js`, `verify_sums_signature` in `cli.py` and
`install.sh`, all identical): `SHA256SUMS.txt.sig` from the same tag is a detached CMS over the exact bytes of
`SHA256SUMS.txt`. Its chain ends at Apple Root CA, which is read from the SIP-protected
`SystemRootCertificates.keychain` and pinned by sha256 `b0b1730e…f024`. It has exactly one signer, a
Developer ID Application leaf (Apple marker `1.2.840.113635.100.6.1.13`) issued by Apple's
"Developer ID Certification Authority", with `OU=HJSLQL98D8`. The verification was proven on a real Apple
chain: a third-party Developer ID CMS was accepted for its own team, and refused for `HJSLQL98D8`, for
tampered content, and for a self-signed look-alike, in all three faces.

**The owner's step, once per release.** This happens inside `release:mac` and runs from your Terminal only,
never in CI:

```sh
npm run release:mac -- --team HJSLQL98D8 --gates <abs path>/P7_gates.sh --sign-sums
```

After the DMG is notarised and stapled and `SHA256SUMS.txt` is written, the script:

1. reads the single `Developer ID Application: … (HJSLQL98D8)` identity from
   `~/Library/Keychains/iclone-release.keychain-db`;
2. runs `security unlock-keychain ~/Library/Keychains/iclone-release.keychain-db`, where **you type the
   keychain password**; nothing stores or passes it;
3. runs `security cms -S -N "Developer ID Application: … (HJSLQL98D8)" -k ~/Library/Keychains/iclone-release.keychain-db -H SHA256 -G -T -i release/SHA256SUMS.txt -o release/SHA256SUMS.txt.sig`.
   If macOS asks whether `security` may use the key, choose **Allow** (once), not *Always Allow*;
4. runs `security lock-keychain …` in a `finally`, so the keychain is locked even if signing fails;
5. verifies the new `.sig` with the launchers' own code
   (`node packages/icloneos-cli/scripts/verify-sums-signature.js release/SHA256SUMS.txt release/SHA256SUMS.txt.sig HJSLQL98D8`).
   Only then is `SHA256SUMS.txt.sig` added to `release/UPLOAD.txt`. Upload it with the other assets.

If step 5 refuses with "does not chain to Apple's root certificate", the CMS was written without the
intermediate certificate. Import Apple's "Developer ID - G2" intermediate
(<https://www.apple.com/certificateauthority/>) into the release keychain and sign again.

**Switching it on**, only after the first release that carries a verified `SHA256SUMS.txt.sig`: set
`requireSignedSums` to `true` in `release-contract.json` and `src/contract.js`,
`REQUIRE_SIGNED_SUMS = True` in `cli.py`, and `REQUIRE_SIGNED_SUMS=1` in `install.sh`. `channels.test.js`
fails until all four agree. Then ship a launcher release. From then on, **every** release must be signed;
a release without `.sig` is refused by every launcher.

## Publishing: the owner's steps, in order

Nothing here has been published. Every step is outward-facing under your identity. Do them all on the
same day, **before** the names appear anywhere public.

### 0. Lock the accounts first

```sh
npm profile enable-2fa auth-and-writes          # npm: 2FA on login AND on every publish
```
- PyPI: enable 2FA (security key or TOTP) at <https://pypi.org/manage/account/two-factor/>.
- GitHub: 2FA is already required for `devclone20`. Confirm it, and keep it on.
- npm org: create **`icloneos`** at <https://www.npmjs.com/org/create>. The CLI cannot create orgs, and
  owning the scope is what makes `@icloneos/*` unsquattable.

### 1. Public repositories (the launcher must be auditable; the app repo stays private)

```sh
gh repo create devclone20/icloneos-cli --public --description "Verifying launcher for iclone os"
gh repo create devclone20/homebrew-iclone --public --description "Homebrew tap for iclone os"
```
Copy `packages/icloneos-cli/` and `packaging/` into `icloneos-cli` with the same layout, and
`packaging/github-workflows/publish.yml` to `.github/workflows/publish.yml` there. Copy the contents of
`packaging/homebrew/` (`Casks/icloneos.rb`, `README.md`) to the root of `homebrew-iclone`.

### 2. Homebrew tap

```sh
sh packaging/check-cask.sh --dmg apps/desktop/release/iclone-os-mac-arm64.dmg   # from the app repo: must say OK
cd homebrew-iclone && git add -A && git commit -m "icloneos 0.0.3" && git push -u origin main
brew tap devclone20/iclone
brew audit --cask --strict --online devclone20/iclone/icloneos
brew install --cask devclone20/iclone/icloneos     # self-test, then: brew uninstall --cask icloneos
```

### 3. npm: claim both names now, from your machine (each publish asks for your OTP)

```sh
cd packages/icloneos-cli && npm ci --ignore-scripts && npm run check
npm publish --access public --ignore-scripts       # @icloneos/cli
npm access set mfa=publish @icloneos/cli           # every future publish needs 2FA
cd ../../packaging/npm-defensive && npm publish --access public   # bare "icloneos" placeholder
npm access set mfa=publish icloneos
```
Later releases come from CI without a token. On npmjs.com go to `@icloneos/cli` → Settings → Trusted
Publisher → GitHub Actions, and enter repo `devclone20/icloneos-cli`, workflow `publish.yml`,
environment `npm`. Each release is then `git tag cli-vX.Y.Z && git push --tags`, it carries npm
provenance, and it waits for your approval on the `npm` environment.

### 4. PyPI through trusted publishing (no API token ever exists)

1. <https://pypi.org/manage/account/publishing/> → *Add a new pending publisher*: project `icloneos`,
   owner `devclone20`, repository `icloneos-cli`, workflow `publish.yml`, environment `pypi`.
2. In `devclone20/icloneos-cli` → Settings → Environments, create `npm` and `pypi` with yourself as
   required reviewer. Then Settings → Rules → Rulesets → New tag ruleset: target `cli-v*`, restrict
   creation, update and deletion, bypass list = you only. A tag pushed by anyone else never starts a publish.
3. `git tag cli-v0.1.0 && git push origin cli-v0.1.0`, then approve the `pypi` job. A pending publisher
   does not reserve the name until this first upload, so do it straight away.

If you would rather claim PyPI by hand first: `cd packaging/python && python3 -m build && python3 -m twine
upload dist/*` with a token scoped to the project. Then delete the token and switch to trusted publishing.

### 5. install.sh on the website

Upload `packaging/install.sh` to `https://cloneframe.io/install.sh` through the site's normal
`_UPLOAD` path, served as `text/plain`, and list its sha256 (`shasum -a 256 packaging/install.sh`)
on the download page next to the commands in the table above.

## Name-squatting protection

- **One spelling everywhere:** `icloneos` (registries), `iclone os` (prose), `icloneOS` (UI). No other
  spelling is ever published, so any other spelling is not us.
- **Claim before announcing.** An announced name that is not registered invites squatters. Steps 0–4
  happen before any post mentions a terminal install.
- **Own the npm scope.** Nobody can publish inside `@icloneos/`. The bare `icloneos` placeholder blocks
  the obvious lookalike, and npm's similarity rule then rejects punctuation variants such as
  `iclone-os` and `iclone.os`.
- **PyPI normalises differently.** `iclone-os`, `iclone_os` and `iclone.os` are one name there, but a
  different name from `icloneos`. Claim `iclone-os` with a placeholder on the same day as `icloneos`.
- **Always the tap-qualified cask name.** `brew install --cask icloneos` without the tap resolves to
  homebrew/cask core, where anyone could submit that name. Every page and post prints
  `devclone20/iclone/icloneos`.
- **2FA on publish** (`mfa=publish`), **no long-lived tokens** (trusted publishing). If a token is ever
  needed, scope it to one package and delete it after use.
- **No install scripts** in either npm package (`npm publish --ignore-scripts` in CI). A launcher that
  ran code at `npm install` time would be exactly the hole this design avoids.
- **Watch the names.** Add `@icloneos/cli` and `icloneos` to Socket.dev, and watch GitHub for new
  repositories or casks named `icloneos`. The `cmux-agent-mcp` incident shows these attacks are real.
- **Report impostors** at <https://www.npmjs.com/support> and to `admin@pypi.org`, and say the official
  channels are the ones listed on cloneframe.io.
