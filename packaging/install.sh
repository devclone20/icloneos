#!/bin/sh
# iclone os installer — curl -fsSL https://cloneframe.io/install.sh | sh
# Verifies sha256 (SHA256SUMS.txt) + Developer ID signature + notarisation + team HJSLQL98D8
# before anything is moved. Installs to ~/Applications by default. Never uses sudo.
# Everything runs inside main() so a truncated download of this script executes nothing.
set -eu

REPO="devclone20/icloneos"
DMG="iclone-os-mac-arm64.dmg"
APP="iclone os.app"
BUNDLE_ID="io.cloneframe.icloneos"
TEAM_ID="HJSLQL98D8"
# The rollback floor: never install a release below it, whatever the feed says.
MIN_VERSION="0.0.3"
SUMS_SIG="SHA256SUMS.txt.sig"
# Off until the owner publishes the first signed list (packaging/README.md, "Signing SHA256SUMS").
REQUIRE_SIGNED_SUMS=0
APPLE_ROOT_CA_SHA256="b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024"
ROOTS_KEYCHAIN="/System/Library/Keychains/SystemRootCertificates.keychain"

refuse() { printf 'icloneos: refused — %s\n' "$1" >&2; exit 2; }
say() { printf '%s\n' "$1" >&2; }

fetch() {
  # $1 url, $2 output file. HTTPS only, also across redirects; the final host must be GitHub's.
  # K85: the same 2 GiB cap the other launchers enforce, and a bounded connect.
  final=$(/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL \
    --max-filesize 2147483648 --connect-timeout 15 \
    -o "$2" -w '%{url_effective}' "$1") || refuse "could not download $1."
  case "$final" in
    https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) ;;
    *) refuse "the download was redirected to an unexpected host ($final)." ;;
  esac
}

field() { # $1 Key, $2 codesign --display report
  printf '%s\n' "$2" | /usr/bin/sed -n "s/^$1=//p" | /usr/bin/head -n 1
}

is_version() { # strict dotted digits, as the other launchers accept
  printf '%s\n' "$1" | /usr/bin/grep -Eqx '[0-9]+(\.[0-9]+){1,3}'
}

version_lt() { # succeeds when $1 < $2, compared numerically part by part
  /usr/bin/awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); if (m > n) n = m
    for (i = 1; i <= n; i++) { if (x[i] + 0 < y[i] + 0) exit 0; if (x[i] + 0 > y[i] + 0) exit 1 }
    exit 1 }'
}

regex_escape() {
  # shellcheck disable=SC2016 # `$` here is a literal regex metacharacter to escape, not an expansion.
  printf '%s' "$1" | /usr/bin/sed 's/[][\.*^$(){}+?|]/\\&/g'
}

verify_signed_by_team() { # $1 path, $2 label, $3 spctl type
  /usr/bin/codesign --verify --deep --strict "$1" 2>/dev/null || refuse "the code signature of $2 is invalid."
  report=$(/usr/bin/codesign --display --verbose=2 "$1" 2>&1) || refuse "codesign could not read $2."
  team=$(field TeamIdentifier "$report")
  [ "$team" = "$TEAM_ID" ] || refuse "$2 is signed by team ${team:-none}, not $TEAM_ID."
  case "$(field Authority "$report")" in
    "Developer ID Application:"*) ;;
    *) refuse "$2 is not signed with a Developer ID Application certificate." ;;
  esac
  if [ "$3" = open ]; then
    verdict=$(/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "$1" 2>&1) || verdict=""
  else
    verdict=$(/usr/sbin/spctl --assess --type execute --verbose=2 "$1" 2>&1) || verdict=""
  fi
  case "$verdict" in
    *"source=Notarized Developer ID"*) ;;
    *) refuse "Gatekeeper does not accept $2 as notarised." ;;
  esac
}

signer_field() { # $1 subject|issuer, $2 key, $3 `openssl x509 -text -subject -issuer -nameopt sep_multiline` report
  printf '%s\n' "$3" | /usr/bin/awk -v want="$1" -v key="$2" '
    /^subject=/ { s = "subject"; next }
    /^issuer=/ { s = "issuer"; next }
    s == want && substr($0, 1, 4) == "    " && substr($0, 5, 1) != " " {
      i = index($0, "="); k = substr($0, 5, i - 5)
      if (k == key) { print substr($0, i + 1); exit }
    }'
}

verify_sums_signature() { # $1 SHA256SUMS.txt, $2 its detached CMS signature
  # Chain to Apple Root CA (pinned by sha256, read from the SIP-protected root store), exactly one signer,
  # a Developer ID Application leaf of our team from Apple's Developer ID CA. LibreSSL needs -ignore_critical
  # for Apple's extensions; the Developer ID marker extension is checked explicitly below.
  /usr/bin/security find-certificate -a -c "Apple Root CA" -p "$ROOTS_KEYCHAIN" >"$work/roots.pem" 2>/dev/null \
    || refuse "Apple's root certificate was not found in the system root store."
  /usr/bin/awk -v dir="$work" '/-----BEGIN CERTIFICATE-----/ { n++; f = dir "/root-" n ".pem" }
    f { print > f } /-----END CERTIFICATE-----/ { close(f); f = "" }' "$work/roots.pem"
  root=""
  for cert in "$work"/root-*.pem; do
    [ -f "$cert" ] || continue
    fingerprint=$(/usr/bin/openssl x509 -in "$cert" -noout -fingerprint -sha256 2>/dev/null \
      | /usr/bin/sed 's/^.*=//; s/://g' | /usr/bin/tr 'A-F' 'a-f')
    [ "$fingerprint" != "$APPLE_ROOT_CA_SHA256" ] || root="$cert"
  done
  [ -n "$root" ] || refuse "Apple's root certificate was not found in the system root store."
  /usr/bin/openssl smime -verify -binary -inform DER -in "$2" -content "$1" -CAfile "$root" -purpose any \
    -ignore_critical -signer "$work/sums-signer.pem" -out /dev/null 2>/dev/null \
    || refuse "the signature on SHA256SUMS.txt is invalid or does not chain to Apple's root certificate."
  signers=$(/usr/bin/grep -c -- '-----BEGIN CERTIFICATE-----' "$work/sums-signer.pem" || true)
  [ "$signers" = 1 ] || refuse "SHA256SUMS.txt must carry exactly one signer, not $signers."
  signer=$(/usr/bin/openssl x509 -in "$work/sums-signer.pem" -noout -text -subject -issuer \
    -nameopt sep_multiline,utf8) || refuse "openssl could not read the signer of SHA256SUMS.txt."
  [ "$(signer_field issuer CN "$signer")" = "Developer ID Certification Authority" ] \
    && [ "$(signer_field issuer O "$signer")" = "Apple Inc." ] \
    || refuse "SHA256SUMS.txt was not signed with a certificate from Apple's Developer ID authority."
  case "$signer" in *"1.2.840.113635.100.6.1.13:"*) ;; *) refuse "SHA256SUMS.txt was not signed with a Developer ID Application certificate." ;; esac
  case "$(signer_field subject CN "$signer")" in
    "Developer ID Application:"*) ;;
    *) refuse "SHA256SUMS.txt was not signed with a Developer ID Application certificate." ;;
  esac
  [ "$(signer_field subject OU "$signer")" = "$TEAM_ID" ] \
    || refuse "SHA256SUMS.txt is not signed by the iclone os team $TEAM_ID."
}

cleanup() {
  # Runs on every exit, including Ctrl-C and SIGTERM (their traps exit, which lands here). The previous app
  # goes back if the swap did not finish; staging is kept if that restore fails, so the app is never deleted.
  trap '' INT TERM
  [ -z "$work" ] || /usr/bin/hdiutil detach "$work/mnt" -force -quiet 2>/dev/null || true
  if [ -n "$staging" ] && [ -d "$staging/previous.app" ] && [ ! -e "$target" ] && [ ! -L "$target" ]; then
    if ! /bin/mv "$staging/previous.app" "$target"; then
      say "icloneos: your previous iclone os is safe at $staging/previous.app; move it to $target."
      staging=""
    fi
  fi
  [ -z "$staging" ] || /bin/rm -rf "$staging"
  [ -z "$work" ] || /bin/rm -rf "$work"
}

recover_interrupted_swaps() {
  # A run killed outright (SIGKILL, power loss) can strand the previous app in a staging folder.
  for stale in "$dest"/.icloneos-staging-*; do
    [ -d "$stale" ] && [ ! -L "$stale" ] || continue
    if [ -d "$stale/previous.app" ] && [ ! -L "$stale/previous.app" ] && [ ! -e "$target" ] && [ ! -L "$target" ]; then
      /bin/mv "$stale/previous.app" "$target" && say "Restored iclone os at $target after an interrupted install."
    fi
    [ -e "$stale/previous.app" ] || /bin/rm -rf "$stale"
  done
}

main() {
  dest="$HOME/Applications"
  allow_downgrade=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dest) [ $# -ge 2 ] || refuse "--dest needs a directory."; dest="$2"; shift 2 ;;
      --allow-downgrade) allow_downgrade=1; shift ;;
      *) refuse "unknown option $1 (accepted: --dest <dir>, --allow-downgrade)." ;;
    esac
  done
  [ "$(/usr/bin/uname -s)" = Darwin ] || refuse "iclone os is a macOS app; this machine is not macOS."
  [ "$(/usr/bin/uname -m)" = arm64 ] || refuse "iclone os ships for Apple silicon (arm64) only."
  [ "$(/usr/bin/id -u)" != 0 ] || refuse "do not run this as root or with sudo; it installs for your user only."
  if ! /bin/mkdir -p "$dest" || [ ! -w "$dest" ]; then
    refuse "$dest is not writable by you; pass --dest ~/Applications."
  fi

  work=""
  staging=""
  target="$dest/$APP"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  work=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/icloneos.XXXXXX")

  recover_interrupted_swaps
  [ ! -L "$target" ] || refuse "$target is a symbolic link; icloneos will not follow, replace or remove it."
  installed=""
  if [ -e "$target" ]; then
    [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$target/Contents/Info.plist" 2>/dev/null)" = "$BUNDLE_ID" ] \
      || refuse "$target is not iclone os; it will not be replaced."
    installed=$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$target/Contents/Info.plist" 2>/dev/null || true)
  fi

  fetch "https://github.com/$REPO/releases/latest/download/latest-mac.yml" "$work/latest-mac.yml"
  version=$(/usr/bin/sed -n "s/^version:[[:space:]]*['\"]\{0,1\}\([0-9][0-9.]*\)['\"]\{0,1\}[[:space:]]*$/\1/p" "$work/latest-mac.yml" | /usr/bin/head -n 1)
  [ -n "$version" ] || refuse "the release feed does not announce a version."
  is_version "$version" || refuse "the release feed announces a malformed version \"$version\"."
  if version_lt "$version" "$MIN_VERSION"; then
    refuse "the release feed offers $version, below the minimum supported version $MIN_VERSION; this looks like a rollback, so nothing was installed."
  fi
  if [ -n "$installed" ] && is_version "$installed" && version_lt "$version" "$installed" && [ "$allow_downgrade" = 0 ]; then
    refuse "iclone os $installed is installed and the release feed offers the older $version; pass --allow-downgrade to install it anyway."
  fi
  base="https://github.com/$REPO/releases/download/v$version"

  fetch "$base/SHA256SUMS.txt" "$work/SHA256SUMS.txt"
  if [ "$REQUIRE_SIGNED_SUMS" = 1 ]; then
    fetch "$base/$SUMS_SIG" "$work/$SUMS_SIG"
    verify_sums_signature "$work/SHA256SUMS.txt" "$work/$SUMS_SIG"
  fi
  # Every entry for the DMG must agree; two different hashes are refused, as in the other launchers.
  # K85: like the other launchers, any line that is not "<sha256> <file>" (or " *<file>") refuses the whole list.
  expected=$(/usr/bin/awk -v f="$DMG" '
    { sub(/\r$/, ""); sub(/[ \t]+$/, "") }
    $0 == "" { next }
    $0 !~ /^[0-9a-f][0-9a-f]* [ *][^ \t\/][^\/]*$/ || length($1) != 64 { bad = 1; next }
    ($2 == f || $2 == "*" f) { h[$1] = 1 }
    END { if (bad) { print "malformed"; exit }
          n = 0; for (k in h) { n++; o = k }; if (n == 1) print o; else if (n > 1) print "conflict" }' "$work/SHA256SUMS.txt")
  [ "$expected" != malformed ] || refuse "SHA256SUMS.txt contains a line that is not \"<sha256>  <file>\"."
  [ "$expected" != conflict ] || refuse "SHA256SUMS.txt gives two different hashes for $DMG."
  [ -n "$expected" ] || refuse "SHA256SUMS.txt has no entry for $DMG."

  say "Downloading iclone os $version …"
  fetch "$base/$DMG" "$work/$DMG"
  actual=$(/usr/bin/shasum -a 256 "$work/$DMG" | /usr/bin/awk '{ print $1 }')
  [ "$actual" = "$expected" ] || refuse "the sha256 of $DMG ($actual) does not match SHA256SUMS ($expected)."
  verify_signed_by_team "$work/$DMG" "the disk image" open

  /bin/mkdir -m 700 "$work/mnt"
  /usr/bin/hdiutil attach "$work/$DMG" -nobrowse -readonly -noautoopen -mountpoint "$work/mnt" -quiet \
    || refuse "hdiutil could not mount the verified disk image."
  if [ ! -d "$work/mnt/$APP" ] || [ -L "$work/mnt/$APP" ]; then
    refuse "the disk image does not contain $APP."
  fi
  staging=$(/usr/bin/mktemp -d "$dest/.icloneos-staging-XXXXXX")
  /usr/bin/ditto "$work/mnt/$APP" "$staging/$APP" || refuse "copying the app out of the disk image failed."
  /usr/bin/hdiutil detach "$work/mnt" -quiet || /usr/bin/hdiutil detach "$work/mnt" -force -quiet

  verify_signed_by_team "$staging/$APP" "the app bundle" execute
  plist="$staging/$APP/Contents/Info.plist"
  [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$plist")" = "$BUNDLE_ID" ] \
    || refuse "the app bundle does not identify as $BUNDLE_ID."
  [ "$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$plist")" = "$version" ] \
    || refuse "the app version disagrees with the release feed ($version)."

  [ ! -L "$target" ] || refuse "$target is a symbolic link; icloneos will not follow, replace or remove it."
  if [ -e "$target" ]; then
    [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$target/Contents/Info.plist" 2>/dev/null)" = "$BUNDLE_ID" ] \
      || refuse "$target is not iclone os; it will not be replaced."
    if /usr/bin/pgrep -f "^$(regex_escape "$target/Contents/MacOS/")" >/dev/null; then
      refuse "iclone os is running; quit it and run this again."
    fi
    /bin/mv "$target" "$staging/previous.app"
  fi
  # A signal between these two moves runs cleanup(), which puts the previous app back.
  /bin/mv "$staging/$APP" "$target" || refuse "could not move the verified app into $dest."
  say "Installed iclone os $version at $target."
  say "Open it with: open \"$target\""
}

main "$@"
