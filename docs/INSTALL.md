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
