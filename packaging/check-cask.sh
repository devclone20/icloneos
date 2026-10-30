#!/bin/sh
# Release-time gate for the Homebrew channel: run it before the tap is published or updated.
#   sh packaging/check-cask.sh [--dmg <the notarised DMG that was uploaded>] [--cask <path to icloneos.rb>]
# Passes (exit 0) only when the cask's URL is the tagged DMG of devclone20/icloneos at the cask's own version, that
# version is not below the launchers' rollback floor (release-contract.json minimumVersion), the URL answers (200
# after GitHub's redirects, HTTPS and GitHub hosts only) and the downloaded bytes hash to the cask's sha256 — and, with
# --dmg, the local uploaded DMG hashes to the same value. Any failure exits 2 with one sentence. Reads only; never
# edits the cask, never pushes.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cask="$here/homebrew/Casks/icloneos.rb"
contract="$here/release-contract.json"
dmg=""

refuse() { printf 'check-cask: refused — %s\n' "$1" >&2; exit 2; }

version_lt() { # succeeds when $1 < $2, compared numerically part by part
  /usr/bin/awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); if (m > n) n = m
    for (i = 1; i <= n; i++) { if (x[i] + 0 < y[i] + 0) exit 0; if (x[i] + 0 > y[i] + 0) exit 1 }
    exit 1 }'
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dmg) [ $# -ge 2 ] || refuse "--dmg needs a file."; dmg="$2"; shift 2 ;;
      --cask) [ $# -ge 2 ] || refuse "--cask needs a file."; cask="$2"; shift 2 ;;
      *) refuse "unknown option $1 (accepted: --dmg <file>, --cask <file>)." ;;
    esac
  done
  [ -f "$cask" ] || refuse "no cask at $cask."
  [ -f "$contract" ] || refuse "no release contract at $contract."

  repo=$(/usr/bin/sed -n 's/^  "repository": "\([^"]*\)",$/\1/p' "$contract")
  floor=$(/usr/bin/sed -n 's/^  "minimumVersion": "\([^"]*\)",$/\1/p' "$contract")
  dmg_name=$(/usr/bin/sed -n 's/^  "dmgFile": "\([^"]*\)",$/\1/p' "$contract")
  [ -n "$repo" ] && [ -n "$floor" ] && [ -n "$dmg_name" ] || refuse "the release contract is unreadable."

  version=$(/usr/bin/sed -n 's/^  version "\([0-9][0-9.]*\)"$/\1/p' "$cask")
  sha=$(/usr/bin/sed -n 's/^  sha256 "\([0-9a-f]\{64\}\)"$/\1/p' "$cask")
  template=$(/usr/bin/sed -n 's/^  url "\([^"]*\)",$/\1/p' "$cask")
  [ -n "$version" ] || refuse "the cask has no version line."
  [ -n "$sha" ] || refuse "the cask has no 64-hex sha256 line."
  [ -n "$template" ] || refuse "the cask has no url line."
  if version_lt "$version" "$floor"; then
    refuse "the cask is at $version, below the rollback floor $floor; no such DMG is offered by $repo."
  fi

  url=$(printf '%s' "$template" | /usr/bin/sed "s/#{version}/$version/g")
  expected="https://github.com/$repo/releases/download/v$version/$dmg_name"
  [ "$url" = "$expected" ] || refuse "the cask URL is $url, not $expected."

  work=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/check-cask.XXXXXX")
  trap '/bin/rm -rf "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  final=$(/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL \
    --max-filesize 2147483648 --connect-timeout 15 \
    -o "$work/cask.dmg" -w '%{http_code} %{url_effective}' "$url") || refuse "the cask URL did not answer 200: $url."
  case "$final" in
    "200 https://github.com/"*|"200 https://objects.githubusercontent.com/"*|"200 https://release-assets.githubusercontent.com/"*) ;;
    *) refuse "the cask URL ended at an unexpected answer or host ($final)." ;;
  esac
  actual=$(/usr/bin/shasum -a 256 "$work/cask.dmg" | /usr/bin/awk '{ print $1 }')
  [ "$actual" = "$sha" ] || refuse "the DMG at the cask URL hashes to $actual, not the cask's $sha."
  if [ -n "$dmg" ]; then
    [ -f "$dmg" ] || refuse "no DMG at $dmg."
    local_sha=$(/usr/bin/shasum -a 256 "$dmg" | /usr/bin/awk '{ print $1 }')
    [ "$local_sha" = "$sha" ] || refuse "the uploaded DMG $dmg hashes to $local_sha, not the cask's $sha."
  fi
  printf 'check-cask: OK — icloneos %s, %s, sha256 %s\n' "$version" "$url" "$sha"
}

main "$@"
