# Changelog

All notable changes to iclone os. Each release lists its assets — the DMG, the zip and `SHA256SUMS.txt` — on the
[Releases](https://github.com/devclone20/icloneos/releases) page.

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
