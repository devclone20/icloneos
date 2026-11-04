# Changelog

All notable changes to iclone os. Each release lists its assets — the DMG, the zip and `SHA256SUMS.txt` — on the
[Releases](https://github.com/devclone20/icloneos/releases) page.

## v0.0.5 — beta version (2026-11-05)

icloneOS v0.0.5 is a beta version.

It updates the app to Electron 44, which fixes all 15 published security advisories that affected v0.0.4, including
the six rated high. Two third-party packages inside the bundled sign-in page still carry high-severity advisories that
cannot be fixed yet; we explain why and what it means under Security.

### Improved

- **Electron 44.** The app runs on Electron 44.10.1 (Chromium 152), up from 40.10.2. It needs macOS 13 (Ventura) or
  later; Electron 44 no longer runs on macOS 12. On macOS 12 the app keeps v0.0.4: the in-app updater reports it as up
  to date instead of offering v0.0.5, and the v0.0.4 download stays available. v0.0.4 keeps those 15 advisories and gets
  no further fixes, so move to macOS 13 or later when you can.
- **File dialogs.** Electron 44 opens a file dialog with no folder set in Downloads, every time. The file pickers and
  save dialogs for attachments, downloads and saved files now remember the last folder you used for each kind of pick
  while the app is open.
- **Notifications.** A notification that macOS refuses to show, as it does for an unsigned build since Electron 42, is
  now handled: the update notifier releases the notification it holds, and each source of notifications logs its first
  failure once, with the platform error only.
  A notification is also kept in memory until it closes, fails or is clicked, up to the 64 most recent, so a click or a
  failure can no longer be lost to cleanup.
- **Quitting.** Logging out, shutting down, closing the terminal or a `kill` (SIGTERM, SIGINT or SIGHUP) now quit the
  app through its normal path, without the quit confirmation: the background services stop and an open remote (SSH)
  connection is closed. A quit also asks Chromium to write the storage and cookies of every browsing profile the app
  opened to disk, and waits for that for at most 2 seconds. A quit that stalls on the app's own work now moves on: after
  a signal the app exits within about 15 seconds (about 11 unless a remote connection is still closing), and any other
  quit reaches Chromium's own shutdown within 24 seconds (12, plus up to 12 more while a remote connection is closing),
  plus the storage write above. Chromium's own shutdown has no limit of ours on a normal quit and can take longer, and
  so can a quit that installs an app update or waits for a remote update to finish. On the remote machine the app stops only the background service it can confirm belongs to it; otherwise, or
  when stopping it takes longer than the quit allows, it leaves that service alone and the next launch tidies up.
- **Licences.** The app now includes Chromium's licence file, `LICENSES.chromium.html`, in its `Resources` folder. The
  third-party notices list Electron 44.10.1 and KaTeX 0.18.2.
- **Known issue.** If you quit the app while a remote (SSH) connection is still being set up, the SSH control
  connection it opened can stay open in the background for up to 5 minutes before it closes on its own; no remote
  service, port forward or data is affected, and a fix is planned for a later release.

### Security

- **Electron advisories closed.** Electron 40.10.2 had 15 published advisories; as of the release, Electron 44.10.1
  has none of them.
  - High (the six v0.0.4 listed as known): GHSA-9f4c-93c8-jc8g, GHSA-hq2x-r82h-9wj4, GHSA-gr2m-v5gq-v685,
    GHSA-j84w-jfhq-vhvj, GHSA-9qh4-3jw8-366w and GHSA-jr5w-w6x2-84p9 (compromised eMudhra intermediate certificates).
  - Moderate: GHSA-r4w5-6pfg-jxp5, GHSA-vv43-5jgx-7qv8, GHSA-fw47-9c62-h3vw, GHSA-2p8c-gr87-2676, GHSA-x562-297c-g43g
    and GHSA-997q-gvvc-jwmx.
  - Low: GHSA-98mx-cjp9-gchm, GHSA-3qxv-5xgr-q7w9 and GHSA-h3v5-h239-pg29.

  The exception v0.0.4 carried for Electron is gone.
- **Client certificates are never sent.** A server that asks for a client certificate could get the first matching one
  from your keychain: a window's request already could, and since Electron 44 the app's own background requests could
  too. The app now answers every such request with no certificate, and logs only the host that asked, once. If your
  gateway sits behind a proxy that requires client certificates (mutual TLS), the app can no longer reach it; mutual
  TLS is not a supported way to sign in to a gateway.
- **Dependency updates.**
  - App: KaTeX 0.18.2 and sanitize-html 2.18.1.
  - Runtime (bundled components): mcp 2.2.0, OpenTelemetry 1.45.1, pyasn1 0.6.5, multidict 6.9.1 and tornado 6.6.
  - WhatsApp bridge: music-metadata 11.16.0 and qs 6.16.1, which fix the moderate advisories v0.0.4 kept.
  - ACP CLI: ws 8.21.3 and js-cookie 3.0.7, two of the three packages v0.0.4 listed with high advisories (the third,
    zod, is below), plus follow-redirects 1.16.2 and uuid 11.1.1 (for one of its dependencies).
  - Website: tinypool 2.1.2; the documentation site has no critical or high advisories.
- **Two packages with no fix inside their consumers' major versions.** Each is fixed only in a newer major than the
  one its consumer requires, and forcing the new major under the consumer would break it:
  - zod (GHSA-mrhx-c7xc-m3w5, high: memory exhaustion on oversized input), in version 3.25.76 and in two nested 3.22.4
    copies, fixed only in zod 4.6.6. The Privy SDK inside the bundled sign-in page requires zod 3, and so does the
    optional ACP CLI, which the app installs only when you click to add it. The optional ACP CLI carries the same zod
    3.25.76 and the same advisory, and also @virtuals-protocol/acp-node 0.3.0-beta-subscription.2 (high; an npm
    advisory with no GHSA number: it depends on vulnerable versions of @account-kit/infra, the same zod chain, and has
    no fixed release); both are covered by our release checks with an explicit accepted risk each, and for both the
    plausible worst case is that the ACP CLI process runs out of memory or stalls. If a network payload repeatedly
    exhausted the optional ACP CLI's memory, the app would keep restarting it, waiting longer each time up to about
    once a minute, with no cap on restarts, so a slow restart loop is possible until you stop the agent; a restart cap
    is planned for a later release. Both are decided again at v0.0.6; acp-node-v2 is being looked at, though today it
    carries the same chain, so moving to it does not close this by itself.
  - decode-uri-component 0.2.2 (GHSA-qr28-fpjm-wq7f, high; also the moderate GHSA-vcc3-ghjq-m6fr, which our release
    checks do not block on), fixed only in 0.5.1, through query-string 7 in the same sign-in page.

  **Accepted risk.** For the three entries accepted for the sign-in page (zod 3.25.76, zod 3.22.4 and
  decode-uri-component 0.2.2), the worst case is that the sign-in window runs out of memory or stalls; no data or code
  is exposed. None can be fixed now: no compatible fix exists inside the major versions the sign-in SDK requires. Our
  release checks cover the sign-in page's dependencies, and exactly three package versions are accepted explicitly,
  each by name, version and advisory. The checks stop accepting each one at v0.0.6: it must then be decided again or,
  as soon as a compatible fix exists, removed. `npm audit` shows more packages as high than these, because it also
  counts every package that depends on them. All three, and the two of the optional ACP CLI, are listed under Known
  Limitations in `SECURITY.md`.
- **Signed checksums.** The release procedure signs `SHA256SUMS.txt` with the app's Developer ID
  (`SHA256SUMS.txt.sig`) once the app and DMG are notarized, and verifies the signature before upload, so you can
  check your download against a signed list.

## v0.0.4 — 2026-10-31

The first launch installs faster, every package's row in the install screen now tells the truth about that package,
and the app's shipped dependencies carry no known critical or high advisory except six Electron ones that need the
next major version (planned for v0.0.5).

### Improved

- **Faster first launch.** The runtime installer downloads the next package while the previous one unpacks, verifies
  and publishes. For the five core tools (ffmpeg, node, npm, Python and ripgrep) the install went from 13.9 s to 10.0 s
  (median of five cold runs, about 1.4× faster); nothing changes once everything is installed. The Python environment
  and the two optional tools were not part of this measurement. *How it was measured:* the real pinned archives from a
  local server simulating one shared 100 Mbit/s link with 30 ms per request, the app's own CPython 3.14.7, five cold and
  three warm runs of each build alternated run by run. Your network sets your real time; the overlap is what changed.
  Fetching four packages at once was slower on that link, so the installer fetches one package ahead.
- **The install screen names every failure.** Each package row changes only on a line that names that package. A new
  row state, **Stopped**, marks a package that was still in progress when an install stopped; a package that finished
  stays done; nothing is marked failed without its own failure. A failure the installer reports without a package name
  shows in the failure card as *Installer reported: …* and in **Settings › Machine › Agent runtime**. Repairs read
  **Repairing**. Ctrl-C in a terminal install stops within two seconds.
- **Measured, not guessed.** A benchmark harness now ships in the source tree (`npm run bench`). It times eight parts
  of the app on their real code paths, each with a control that must move the number, and names one it can't time yet.
  - Five parts are inside their time budgets: the agent watchdog, the folder reader, the terminal pane bus and the
    command spawn policy check stay in TypeScript, and the full gate suite runs in about 8 minutes, against a 30-minute
    budget.
  - Two parts are over budget, and neither is a CPU cost, so neither is a reason to rewrite them in another language:
    writing each audit-log record with an fsync takes about 7.8 ms of the slowest operation's 8.1 ms (95th percentile),
    while the cryptography itself takes 0.3 ms; and the iNFT Book holds about 352 MB of renderer memory with 1,000
    cards, against a 300 MB budget. Both get fixed in place later.
  - One part can't be measured yet: the app has no workspace index.
  - The whole first launch (the five core tools, the two optional tools and the Python environment) went from 45.5 s
    in v0.0.3 to 40.2 s in v0.0.4: the median of five cold runs of each, on a simulated 100 Mbit/s line with 20 ms per
    request, with the load average under 4 at the start of every cold run, and the Python environment built from a
    package cache made minutes earlier. These two totals are measured but not yet cross-checked by the harness's
    deliberate-delay control, which could not run in those two sessions.

### Security

- **Dependencies.** `npm audit --omit=dev` shows 0 critical and 0 high in the packages the app ships; the WhatsApp
  bridge and the Photon sidecar locks have 0 high. Updated: dompurify 3.4.17, js-yaml 4.3.2, simple-git 4.0.2, undici
  7.30.1, axios, follow-redirects, @xmldom/xmldom, fast-uri; sharp 0.35.5 (WhatsApp bridge); @grpc/grpc-js 1.14.5 and
  zod 4.6.6 (Photon sidecar); Pillow 13.0.0, PyJWT 2.15.0, certifi, brotlicffi, aiohttp 3.14.4, urllib3 2.8.0 and the
  rest of the runtime's critical/high set. A release gate now fails the build on a critical or high advisory in any of
  the three shipped locks.
- **Sign-in keys.** With PyJWT 2.15 the key set of a self-hosted identity provider is never fetched through a redirect;
  the app resolves its address once with the same rule it uses for discovery.
- **Git in the review pane.** Commit and push pass eight named git variables from your shell (including
  `GIT_SSH_COMMAND`, `GIT_ASKPASS` and `GIT_SSL_CAINFO`); `GIT_SSL_NO_VERIFY` is never passed.
- **Electron (known, not fixed in v0.0.4).** v0.0.4 still ships Electron 40.10.2. Six high-severity Electron
  advisories apply to it, and no Electron 40 release fixes any of them. Five are fixed in Electron 41.10.x
  (GHSA-9f4c-93c8-jc8g in 41.10.3, GHSA-hq2x-r82h-9wj4 in 41.10.4, and GHSA-gr2m-v5gq-v685, GHSA-j84w-jfhq-vhvj and
  GHSA-9qh4-3jw8-366w in 41.10.6). The sixth, GHSA-jr5w-w6x2-84p9 (compromised eMudhra intermediate certificates), is
  fixed only from Electron 42.11.16. One upgrade to Electron 42.11.16 or later (43.8.1 or later on 43, 44.9.1 or later
  on 44) closes all six; it is planned for v0.0.5. Until then:
  - GHSA-9f4c-93c8-jc8g and GHSA-hq2x-r82h-9wj4 (popups opened from restricted frames): no frame in the app grants
    `allow-popups`, and whatever frame asks, every window-open handler denies; the system browser is reached only
    through the app's own document.
  - GHSA-gr2m-v5gq-v685 (windows opened from a restricted top-level document): no window can be opened from page
    content. Every handler denies.
  - GHSA-j84w-jfhq-vhvj (file/http protocol handlers, cross-origin reads): the app registers no `file` or `http`
    protocol handler. Its one privileged scheme is the app's own media protocol.
  - GHSA-9qh4-3jw8-366w (`<webview>` Node.js in Web Workers): every webview is forced to
    `nodeIntegrationInWorker=false`.
  - GHSA-jr5w-w6x2-84p9 (eMudhra certificates): applies to all TLS traffic. There is no in-app mitigation before the
    upgrade.

  Electron 40.10.6, the last release of the same major, fixes one moderate advisory (GHSA-r4w5-6pfg-jxp5) and none of
  the six; it goes in with the v0.0.5 upgrade.
- **Other runtime locks.** The ACP CLI, which the app installs only when you ask, carries its own lock with 3 high
  advisories (ws, zod, js-cookie; npm counts 14 packages as high, including the ones that depend on them), triaged
  as not reachable from the app. The WhatsApp bridge keeps 2 moderate
  advisories (music-metadata, qs). Both are tracked for a later release.

## v0.0.3 — 2026-10-30

Your agent now asks before it acts, runs its commands in a sandbox, pays only under a mandate you sign, and shows
you what it is doing out of sight. This release also brings the iNFT Book, pixel pets and slash commands.

### New

- **Permission modes.** **Settings › Agent › Permissions** offers five modes — Manual, Automatic, Accept edits,
  Plan and Ignore permissions — each described in one line. A new install starts in Manual, which asks before
  every write, command, network call, message, install and deletion. Some things no mode allows: wiping the disk,
  changing its own permissions or its record, reading your keys to send them anywhere, stopping the app or its
  permission gate, typing your administrator password, or transferring an iNFT. Every request shows the exact
  action, the agent's reason and how long your answer holds; no answer in two minutes counts as Deny. Only your
  own click changes the mode.
- **A level for each kind of action.** In the same pane, e-mail, payments, trading, shopping, ACP jobs,
  messaging, shell, files and publishing each have their own level, from fully automatic to off. A new install
  follows the mode. Raising a level needs your click and a confirmation, and is recorded; lowering one applies at
  once.
- **Payments under your signature.** **Settings › Economy › Payments**. Agents can pay web resources that ask
  for payment (x402, HTTP 402), only under a mandate you sign for one agent: total budget, smallest and largest
  payment, who may be paid, and dates, for at most 90 days. Default caps are 1.00 USDC per payment, 5.00 per day
  and 2.00 per agent per day; payee and site lists start empty; **Stop all payments** refuses everything at once.
  Each payment asks once on the permission sheet. The keys stay in the app's main process. In this version
  payments are set to the Base Sepolia test network.
- **Background tasks.** A button in the Message window lists the agents, shell jobs and scheduled runs working
  out of sight — what each is doing, for how long, and its last line — with the permission log in a second tab.
  A task that died shows as dead instead of vanishing.
- **iT panes that work together.** Agents in different terminal panes can message each other, broadcast, or ask
  and wait for an answer. Panes started under tmux keep running when the app closes and reattach when it opens.
- **A sandbox for agent commands.** Agent commands run inside macOS Seatbelt profiles; anything a profile does
  not name is refused. The new **Containers** window in the Dock shows what runs inside and outside the sandbox,
  every refusal, and a Kill button that stops a process and everything it started.
- **ACP Market › Work.** Offers with your policy's verdict, jobs in flight, completed jobs, payments and history.
  Put your agent online from this Mac and take it offline safely, after every job settles. Autonomy has three
  levels — Observe, Approve each job, Act within policy. In this version an approval is recorded and the quote is
  held, never sent; the agent never spends, hires or tops up.
- **iNFT Book.** In **Settings › Economy**: every iNFT in your wallet as a card with a checkbox; Home shows only
  the ones you check. Images load as they scroll into view.
- **Slash commands.** Type `/` in the composer for every command, grouped, one line each. `/compact` shrinks a
  long conversation, `/skills` lists your skills, `/mode` opens the permission mode picker.
- **Pixel pets.** **Settings › Machine › Appearance › Pet**: twenty pixel robots from three legions — Play,
  Death and God. Off until you choose one; it can wander the window or pop out into its own.

### Improved

- **Settings sections open and close every time.** The collapsible groups in Settings now open and close
  as often as you like, in any order.
- **A black start screen.** The app opens on a pure black screen that reads **GODS & ROBOTS** while it connects.
- **Dock windows open maximized.** A window opened from the Dock now fills the app. **Settings › Machine ›
  Appearance** lets you choose *Maximized* or *Normal size*; the expand button on each window still switches it.
- **Updates tell the truth.** When the agent runtime's compatibility is not confirmed, **Settings › Machine › Updates**
  offers *Review compatibility* instead of Update.

### Security

- Payment keys, the agents' wallet, mandates, the ACP work record and the sandbox's own state are protected in
  every mode; no agent can delete or rewrite them.
- No key or seed is sent to a window or a log.
- Privileged app channels answer only the app's own windows.
- Web pages shown inside the app (the preview pane, sign-in windows, generated content) can no longer open app
  windows, move the app's own window to another page with a link or a script, or open your browser without a click.
  Links open in your browser only when you click them, and a local file link only opens documents and media; anything
  else is shown in Finder.
- The two optional bridges, both off by default, have updated dependencies. A crafted local request can no longer
  stop the WhatsApp bridge (body-parser 1.20.9). The photon sidecar's own dependencies move to undici 7.30.1, which
  clears 18 published advisories from them.

### Known limits

- Payments run on the Base Sepolia test network only.
- Apple's `container` tool is detected but not used; Seatbelt is the sandbox.
- tmux panes run on this Mac only, not over SSH.
- In ACP Work, an approval is recorded and the quote is held, never sent.
- **Microphone in the preview.** A web page shown in the preview pane can ask for the microphone. The app allows it
  only while Microphone is on in **Settings › Profile › Privacy**, and then does not ask page by page (macOS asks
  once per app, not per page). Keep Microphone off when you are not using voice, and preview only sites you trust.
- **Links inside a PDF in the preview.** A click on one did nothing in our tests, but the tests could not confirm
  that the click reached the PDF viewer. If the viewer itself moved the app's window to another page, through the
  browser engine rather than the page, this version would not stop it.
- **Electron 40.10.2.** The app is built on Electron 40.10.2, the same version as v0.0.2. It has six published
  high-severity advisories that no 40.x release fixes. We checked each one against the app: five do not apply to how
  the app is set up (one of them because the app now opens your browser only on a click); one needs an attacker on your
  network holding a compromised certificate. The next version moves
  to Electron 42.
- **Dependencies.** A few libraries the app ships (DOMPurify, js-yaml, simple-git, KaTeX) have published advisories;
  none can be reached with untrusted input in the way the app uses them. The two optional bridges, off by default,
  still have three high-severity ones. In the photon sidecar, one needs a server role the sidecar never takes, and one
  takes its input only from Photon's own service or from a local channel that needs a token and caps its size. In the
  WhatsApp bridge, sharp makes the thumbnail of an image the agent chooses to send; its advisory describes code
  execution on Linux, and its effect on macOS has not been determined. The HTTP client built into Node, which the photon
  sidecar runs on, is still in the range of some of the undici advisories its own update clears (one stops the client when a server
  renegotiates TLS with another certificate); the sidecar's code makes no request with it, and a Node release that
  ships undici 8.12.2 or later closes them. The ACP CLI, installed only when you ask for
  it, pins packages with advisories its code does not reach. DOMPurify, js-yaml and simple-git are updated in the next
  version, and the rest are on the plan.
