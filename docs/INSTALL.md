# Installing iclone os

iclone os is a signed, notarised macOS app for Apple silicon (macOS 12 or later). Each release publishes it as a
DMG to download, a zip that in-app updates fetch, and `SHA256SUMS.txt`, the SHA-256 of the DMG, the zip and the update files.

## Requirements

You need a Mac with Apple silicon (M1 or later) and macOS 12 Monterey or later.

## From the DMG

1. Download [`iclone-os-mac-arm64.dmg`](https://github.com/devclone20/icloneos/releases/latest/download/iclone-os-mac-arm64.dmg)
   and `SHA256SUMS.txt` from the [latest release](https://github.com/devclone20/icloneos/releases/latest).
2. Check the download (optional, recommended):

   ```sh
   grep iclone-os-mac-arm64.dmg SHA256SUMS.txt | shasum -a 256 -c
   ```

   It prints `iclone-os-mac-arm64.dmg: OK`. Anything else means the file is not the one we published: delete it.
3. Open the DMG and drag **iclone os** to Applications.
4. Open **iclone os**. The first time, macOS asks whether to open an app downloaded from the internet: choose
   **Open**. Gatekeeper has checked the Developer ID signature and Apple's notarisation, so the app opens, and macOS
   does not ask again.

Updates arrive inside the app: **Settings › Machine › Updates** checks the release feed at start, every six hours and
when your Mac wakes, and downloads an update only when you click. Updates install into the copy in Applications.
Opened from the disk image or from Downloads, the app offers to move itself there.

## First launch

1. **First launch.** Choose *Install the agent locally* (or connect to an agent you already run). The one-time
   install shows each step. Then you read and accept the policy and see the permission settings.
2. **Your model.** Sign in with Nous Portal or a subscription you have, paste an API key (OpenRouter, OpenAI,
   Anthropic, Google Gemini, xAI, Fireworks), or point it at a local endpoint such as Ollama, llama.cpp or vLLM.
   Change it later in **Settings › Profile › Providers** and **Settings › Agent › Model**.
3. **What the agent may do.** **Settings › Agent › Permissions** has five modes — Manual, Automatic, Accept
   edits, Plan and Ignore permissions — and a level per kind of action. A new install starts in **Manual**,
   which asks before every write, command, network call, message, install and deletion. Only your own click
   changes the mode. **Settings › Profile › Privacy** turns whole kinds of action off. The other four modes,
   payments and the ACP tools need the Keychain setting on (**Settings › Machine › Gateways › Keep saved passwords in the system keychain**);
   until it is on, the app stays in **Manual** and they stay off.

## Check the installed app yourself

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/iclone os.app"
spctl --assess --type execute --verbose "/Applications/iclone os.app"   # source=Notarized Developer ID
codesign -dv "/Applications/iclone os.app" 2>&1 | grep -E 'Identifier|TeamIdentifier'
```

The bundle identifier is `io.cloneframe.icloneos` and the signing team is `HJSLQL98D8`.

## Uninstalling

Quit iclone os, then move **iclone os** from Applications (or wherever you put it) to the Bin. That removes the app
only. Your agents, keys and history stay in `~/.hermes`, the app's settings in
`~/Library/Application Support/iclone os`, and the caches and preferences macOS keeps for any app under
`~/Library`; delete them yourself if you want them gone. Nothing ever removes `~/.hermes` for you.

## Release integrity

Every DMG is signed with Developer ID and notarised by Apple. `SHA256SUMS.txt` is published with every release.
The hash catches corruption and tampered mirrors; the trust anchor is Apple's signature together with our team
id, which only the holder of our Developer ID key can produce.

`SHA256SUMS.txt.sig` is that signature over the list: a detached CMS signature made with our Developer ID
Application certificate (team `HJSLQL98D8`). The launchers check it before they trust any line of the list. To
check it by hand, put both files in one folder, open Terminal there and paste this block. It calls only the tools
that ship with macOS, by their full paths, so another `openssl` earlier in your `PATH` (Homebrew's, for example)
is never used, and it trusts only Apple's root certificate, picked out of the system root store by its SHA-256
fingerprint. It prints one line: `OK`, or `FAIL` with the check that failed.

```sh
unset OPENSSL_CONF; s=SHA256SUMS.txt; t=$(/usr/bin/mktemp -d); /bin/mkdir "$t/none"
/usr/bin/security find-certificate -a -c "Apple Root CA" -p /System/Library/Keychains/SystemRootCertificates.keychain | /usr/bin/awk -v d="$t" '/BEGIN CERTIFICATE/{n++} n{print > (d "/root" n ".pem")}'
for f in "$t"/root*.pem; do
  [ "$(/usr/bin/openssl x509 -in "$f" -noout -fingerprint -sha256 | /usr/bin/sed 's/.*=//')" = "B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24" ] && /bin/cp "$f" "$t/apple-root.pem"
done
if [ ! -f "$t/apple-root.pem" ]; then
  echo "FAIL (chain): Apple Root CA is not in this Mac's system root store"
elif ! /usr/bin/openssl pkcs7 -inform DER -in "$s.sig" -noout 2>/dev/null; then
  echo "FAIL (signature): $s.sig is not a DER CMS/PKCS#7 signature"
elif ! /usr/bin/openssl smime -verify -binary -inform DER -in "$s.sig" -content "$s" -noverify -signer "$t/signer.pem" -out /dev/null 2>/dev/null; then
  echo "FAIL (content): $s is not the list $s.sig signs: it was changed after signing, or the .sig belongs to another list"
elif [ "$(/usr/bin/grep -c 'BEGIN CERTIFICATE' "$t/signer.pem")" != 1 ]; then
  echo "FAIL (signer): $s.sig must carry exactly one signer"
elif ! /usr/bin/openssl smime -verify -binary -inform DER -in "$s.sig" -content "$s" -CAfile "$t/apple-root.pem" -CApath "$t/none" -purpose any -ignore_critical -out /dev/null 2>/dev/null; then
  echo "FAIL (chain): the signing certificate does not chain to Apple's root certificate"
elif ! /usr/bin/openssl x509 -in "$t/signer.pem" -noout -text -subject -issuer -nameopt sep_multiline,utf8 > "$t/cert.txt" 2>/dev/null; then
  echo "FAIL (signer): the signing certificate cannot be read"
elif [ "$(/usr/bin/awk '/^subject=/{s=0} /^issuer=/{s=1} s && /^    CN=/{sub(/^    CN=/, ""); print; exit}' "$t/cert.txt")" != "Developer ID Certification Authority" ] || [ "$(/usr/bin/awk '/^subject=/{s=0} /^issuer=/{s=1} s && /^    O=/{sub(/^    O=/, ""); print; exit}' "$t/cert.txt")" != "Apple Inc." ]; then
  echo "FAIL (issuer): the certificate was not issued by Apple's Developer ID Certification Authority"
elif ! /usr/bin/grep -qF '1.2.840.113635.100.6.1.13:' "$t/cert.txt" || [[ "$(/usr/bin/awk '/^issuer=/{s=0} /^subject=/{s=1} s && /^    CN=/{sub(/^    CN=/, ""); print; exit}' "$t/cert.txt")" != "Developer ID Application:"* ]]; then
  echo "FAIL (kind): the certificate is not a Developer ID Application certificate"
elif [ "$(/usr/bin/awk '/^issuer=/{s=0} /^subject=/{s=1} s && /^    OU=/{sub(/^    OU=/, ""); print; exit}' "$t/cert.txt")" != "HJSLQL98D8" ]; then
  echo "FAIL (team): the certificate does not belong to team HJSLQL98D8"
else
  echo "OK: $s.sig is a valid signature over $s by a Developer ID Application certificate of team HJSLQL98D8, chained to Apple's root"
fi
/bin/rm -rf "$t"
```

The block checks, in this order, that Apple's root certificate is the one in the system root store (not one from
your keychains or an `SSL_CERT_DIR`; the empty `-CApath` keeps any other certificate folder out, and `unset
OPENSSL_CONF` keeps a configuration file from switching `openssl` off), that the signature is a CMS signature, that
it covers exactly these bytes of `SHA256SUMS.txt`, that it has one signer, that the signer's certificate chains to
that root, that Apple's Developer ID Certification Authority (organisation Apple Inc.) issued it, that it is a
Developer ID Application certificate (Apple's marker extension and the certificate's name), and that it belongs to
team `HJSLQL98D8`. Then check the files you
downloaded against the list:

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS.txt
```

Each file you have should print `OK`.

`security cms -D -i SHA256SUMS.txt.sig` is not a verdict: depending on the certificate-usage policy it is asked
for, it reports a good list as `SigningCertNotTrusted`, and it exits `0` even when the list was changed
(`DigestMismatch`). Use the block above.
