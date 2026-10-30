# Security Policy

icloneOS (the app **iclone os**) runs an AI agent on your Mac that can read files, run commands, send messages
and, under a mandate you sign, pay. We take reports about it seriously and handle them in private.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on this repository:

**https://github.com/devclone20/icloneos/security/advisories/new**

Please do not open a public issue, discussion or pull request for a security problem. icloneOS does not run a
bug bounty programme.

A useful report has:

- a short description and your view of the severity;
- the affected component, by file path and line range (for example `apps/desktop/electron/main.ts:120-145`);
- the app version (Settings › Machine › About), macOS version and Mac model;
- steps to reproduce against the latest release;
- which trust boundary below it crosses.

## What we aim for

| | |
|---|---|
| First reply | within 7 days |
| Disclosure | coordinated, 90 days from the report or when a fix ships, whichever comes first |
| Credit | in the advisory and the release notes, unless you prefer to stay anonymous |
| Supported versions | the latest release only |

## Scope

**In scope** — code this repository ships:

- the desktop app in `apps/desktop/` (Electron main process, preload, renderer);
- the icloneOS layer in `iclone/`: the wallet sign-in page, bundled skills and plugins, the runtime pin;
- the agent runtime as built from this repository, wherever it differs from Hermes Agent at upstream `1ac3f97`;
- the terminal launchers and packaging in `packages/` and `packaging/`;
- the releases published from this repository.

**Upstream.** The agent runtime the app bundles is built from this repository, on top of Hermes Agent by Nous
Research at upstream commit `1ac3f97`. A bug in code that is identical to that upstream commit (the agent loop,
tools, gateway, ACP adapter, TUI as Nous Research wrote them) belongs to Nous Research: report it through the
[Hermes Agent security advisories](https://github.com/NousResearch/hermes-agent/security/advisories/new). A bug in
anything icloneOS changed or added, in the runtime or elsewhere, belongs here. If you are not sure which side owns
it, report it here; with your consent we forward the upstream part.

## Trust model, in brief

The trust model of the bundled runtime is Hermes Agent's, by Nous Research. icloneOS adds the desktop rules
below it.

- **The operating system is the boundary.** In-process screens — the command approval patterns, output
  redaction, skill scanning — are heuristics that reduce accidents. They are not containment, and bypassing one
  is not a vulnerability by itself.
- **Seatbelt confines agent commands.** On macOS the agent's commands, tools, the browser and the helper programs
  they start run under a Seatbelt profile that denies by default. The agent runtime process itself is not
  kernel-sandboxed; a guard refuses any program it would start outside the sandbox. Escaping a profile, or starting
  an unconfined program, is in scope.
- **The window is untrusted; the main process is privileged.** Chat markdown, tool output and web content render
  in the window. Every privileged channel (terminal, keychain, wallet, payments, permissions) must answer only the
  app's own windows. A channel that acts for any other frame or window is in scope.
- **Commands to bundled CLIs are argv-only**, checked against a flag allowlist, never passed through a shell.
  Reaching an unlisted flag or a shell metacharacter is in scope.
- **The permission gate and its floors.** No mode allows wiping the disk, changing the agent's own permissions or
  its record, reading keys to send them anywhere, stopping the app or the gate, typing your administrator
  password, or transferring an iNFT. Getting the agent past one of these floors is in scope.
- **Keys stay in the main process.** Payment keys are sealed with the Keychain (payments stay off until the
  Keychain setting is on) and never sent to a window or a log. A key, seed or token that reaches either is in scope.
- **Pinned downloads.** The agent runtime is pinned by SHA-256 and installed from a copy inside the app. Getting
  the app to run an unpinned or mismatched runtime is in scope.
- **The wallet sign-in page** is served on loopback (`127.0.0.1`) only. Its Privy app ID is public by design.

## Out of scope

- Bypasses of in-process heuristics with no further impact.
- Prompt injection on its own, without a chained in-scope outcome.
- What a chosen setting allows: for example *Ignore permissions*, a function set to *Automatic*, or a privacy
  switch you turned on.
- Third-party skills, plugins and MCP servers you installed; review them before you install them.
- Exposing a gateway or API to the internet without authentication or a firewall.
- Reports that need prior write access to your own configuration or credential files.

## Known limitation

Saved desktop secrets (remote gateway tokens, access headers, OAuth token sets) are stored as plain text in the
app's data folder by default, protected by your macOS account and its file permissions. Turn on
**Settings › Machine › Gateways › Keep saved passwords in the system keychain** to encrypt them with the
Keychain. This follows the upstream default: on a Mac with a missing or locked keychain, encryption would
otherwise block every launch with a prompt. While the setting is off the app also has no key to seal the permission
log and payment keys with, so it stays in Manual, and payments and the ACP tools stay off, until you turn it on.

## Verifying a release

Every DMG is signed with Developer ID and notarised by Apple, and every release carries `SHA256SUMS.txt`:

```sh
grep iclone-os-mac-arm64.dmg SHA256SUMS.txt | shasum -a 256 -c
codesign --verify --deep --strict --verbose=2 "/Applications/iclone os.app"
spctl --assess --type execute --verbose "/Applications/iclone os.app"
```

`spctl` should report `source=Notarized Developer ID`. The signing team must be `HJSLQL98D8`:
`codesign -dv "/Applications/iclone os.app" 2>&1 | grep TeamIdentifier`. Installing, checking and uninstalling are
in [`docs/INSTALL.md`](docs/INSTALL.md).
