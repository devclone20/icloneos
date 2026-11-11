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
- **Seatbelt confines agent commands.** On macOS, while confinement is on (it is on by default, and you can turn it
  off), the agent's commands and the programs they start run under a Seatbelt profile that denies by default; the
  agent's browser runs outside it, through a door in the launcher. The agent runtime process itself is not
  kernel-sandboxed; while confinement is on, a guard refuses any other program it would start outside the sandbox,
  except a shell command you approve, which runs once outside it, and the helpers the app runs for computer use
  and screen recording. The file tools can go outside it for a single file in your home folder that no folder grant
  can open: once on the ask in the modes that ask, with no ask in Ignore permissions.
  Escaping a profile, or starting an unconfined program, is in scope.
- **The window is untrusted; the main process is privileged.** Chat markdown, tool output and web content render
  in the window. Every privileged channel (terminal, keychain, wallet, payments, permissions) must answer only the
  app's own windows. A channel that acts for any other frame or window is in scope.
- **Commands to bundled CLIs are argv-only**, checked against a flag allowlist, never passed through a shell.
  Reaching an unlisted flag or a shell metacharacter is in scope.
- **The permission gate and its floors.** Every mode refuses the total destruction of the machine: wiping the disk
  or a whole home folder, raw writes to a disk, and kernel or boot damage. Outside Ignore permissions, changing the
  agent's own permissions or its record, reading keys to send them anywhere, stopping the app or the gate, typing
  your administrator password and transferring an iNFT ask first; in Ignore permissions
  nothing asks, and the agent can do all of them. Getting the agent past the total-destruction floor, or past an
  ask in a mode that asks, is in scope.
- **What the delete check does not read (stated limits).** The check reads the text of one command at a time, so a
  script, a program, a language's own delete call, or a command built at run time, encoded or passed through `eval`
  can go round it. A variable exported, or a function or alias made, by an earlier command in the same terminal is
  not known to it: `export CDPATH=/` and then `cd usr && rm -rf *` is not refused. It does not know the folder a
  command runs in, so a delete that climbs out with `..`, such as `rm -rf ../../*` run two folders below your home,
  is not refused. A launcher around a delete (`xargs` fed from input it cannot
  read, `npx rimraf`, `cmake -E rm`) is not read. `${X:-w}` is read as `w`, whatever `X` holds when it runs. A git
  alias and `clean.requireForce` turned off in a config file are not read; paths under `/net`, `/Network` and
  `/home` are read as written; `find -exec shred`, `srm` and `rsync --remove-source-files` are not read as deletes,
  and moves to the Trash and AppleScript deletes are not read. Your own deny rules still apply. A way past the
  check that is not on this list is in scope.
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

## Known Limitations

### Saved desktop secrets

Saved desktop secrets (remote gateway tokens, access headers, OAuth token sets) are stored as plain text in the
app's data folder by default, protected by your macOS account and its file permissions. Turn on
**Settings › Machine › Gateways › Keep saved passwords in the system keychain** to encrypt them with the
Keychain. This follows the upstream default: on a Mac with a missing or locked keychain, encryption would
otherwise block every launch with a prompt. While the setting is off the app also has no key to seal the permission
log and payment keys with, so it stays in Manual, and payments and the ACP tools stay off, until you turn it on.

### Accepted high-severity advisories with no compatible fix

These ship in v0.0.7. Our release checks accept each one explicitly, by name, version and advisory (for `acp-node`, whose
npm advisory id can change between runs, by name, version and the accepted GHSA advisories it depends on), and stop accepting
it at v0.0.8: it must then be decided again or, as soon as a compatible fix exists, removed. `npm audit` shows more
packages as high than the ones named here, because it also counts every package that depends on them.

**The bundled sign-in page** (the sign-in window only):

- `zod` 3.25.76 and two nested copies of 3.22.4 (GHSA-mrhx-c7xc-m3w5, high: memory exhaustion validating oversized
  constrained collections). It is fixed only in zod 4.6.6, and the Privy SDK's packages require zod 3.
- `decode-uri-component` 0.2.2 (GHSA-qr28-fpjm-wq7f, high: denial of service on percent-encoded input; also the
  moderate GHSA-vcc3-ghjq-m6fr). It is fixed only in 0.5.1, and it comes in through `query-string` 7 in the WalletConnect
  packages of the same page.

The worst case is that the sign-in window runs out of memory or hangs. No data or code is exposed. These parsers see
responses from Privy's servers and the wallet RPC endpoints, and URLs such as WalletConnect pairing links.

**The optional ACP CLI**, which the app installs only when you click to add it:

- `zod` 3.25.76 (the same advisory), required by its account-kit packages.
- `@virtuals-protocol/acp-node` 0.3.0-beta-subscription.2 (high; an npm advisory with no GHSA number: it depends on
  vulnerable versions of the same zod chain, and has no fixed release).

The plausible worst case is that the ACP CLI process runs out of memory or stalls. The app restarts it, waiting longer
each time up to about once a minute, with no cap on restarts yet, so a slow restart loop is possible until you stop the
agent. These are known; a report that only restates them is out of scope, but ideas to fix them are welcome as issues.

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
