# Changelog

All notable changes to iclone os. Each release lists its assets — the DMG, the zip and `SHA256SUMS.txt` — on the
[Releases](https://github.com/devclone20/icloneos/releases) page.

## v0.0.7, beta version (2026-11-12)

icloneOS v0.0.7 is a beta version.

This release is about speed. v0.0.6 was prepared but not released, so everything listed under v0.0.6 below also ships in v0.0.7.

### Faster

In our tests on big projects, the hard-link guard no longer slows the app down. In v0.0.6 it looked through the whole project folder on the app's main thread around every command the agent ran, so on a large project the window could freeze. In v0.0.7 that work runs in the background, and after the first look the guard rechecks only the folders that changed.

What we measured on our test Mac (Apple M5 Max), on two test projects, one of 300,000 files and one of 520,000 folders:

| Measure | v0.0.7 | v0.0.6 |
|---|---|---|
| Longest pause of the main thread while the agent runs 50 commands (300,000-file project) | about 2 ms | 1,351 ms |
| Time the guard adds | about 10 ms per check, about 19 ms per command | |
| Recheck after changes, measured on a 520,000-folder project | 6 to 13 ms | |
| CPU with the app idle and a large project open | 2.7 % of one core | |
| First command after the Mac wakes from sleep | about 1.2 s | |
| A project that starts small and grows to 125,000 folders | longest pause about 2 ms | |
| A project with 20,000 hard links | longest pause about 2 ms while checking; about 35 ms when you click Allow | |
| Switching permission mode (with a 200,000-record audit) | about 10 ms (the first switch after opening up to about 0.1 s) | |

Your own project is not one of these: the numbers depend on its size and on your Mac.

- The permissions audit check is incremental. The full chain is verified once when the app starts, and again if its files change outside the app; after that each new record is checked as it is written, instead of the whole chain being read again on every change.
- Fewer disk syncs: switching mode rewrites only the files whose content changed, and those writes no longer block the window.

### Clearer

- The mode menu in the message bar is short: each mode shows its name and a few words. The menu applies to **This chat** only. The full description of each mode, and the default for new chats, are in Settings › Agent › Permissions.

### Security

- The hard-link check, the audit chain and the signed policy keep the checks they had in v0.0.6, and their tests were extended; a few expectations moved by recorded decisions, none of them loosened.
- If the check does not answer in time, the command is refused with a message instead of running unchecked.
- Five accepted dependency advisories still have no compatible fix: three in the sign-in page (zod in two versions, and decode-uri-component) and two in the optional ACP CLI (zod, and acp-node, which is no longer maintained upstream). A static check found that the app does not run the affected code; we keep them, with the same scope, and decide them again at v0.0.8.

### Known limits

- The first scan after you open a very large project can take about half a minute. The first command waits for it, with a status line ("Checking the project folder…"); if it takes too long the command is refused with a message instead of running unchecked.
- A hard link planted in a project at the very moment a check runs is caught when the command ends, and the next command in that project is refused until you review it.
- A hard link made from outside a project to a file inside it is found by the periodic full scan. On a very large project that scan runs less often, so such a link can take up to 30 minutes to be found.
- The check uses the app's own macOS file-event module. It relies on events arriving in the order the system queued them: we measured that order, but Apple does not document it. If the event stream stops answering, the check falls back to a full scan after 2 seconds.
- Each check waits for its own file-event marker to come back, so it adds about 10 ms per check, about 19 ms per command in our tests (one check before it and one after).
- If the audit record of your default permission mode is lost, the app falls back to Manual and tells you once, so you can choose your mode again.
- After the Mac wakes from a long sleep, the first command on a very large project waits while the project is checked again (about a second in our tests on the 520,000-folder project).
- While the app holds the records of a very large project (520,000 folders in our tests), its memory grows by about 0.6 GB. A project unused for 30 minutes is released, but macOS may keep those pages counted against the app until it needs them; the app reuses them, so opening more large projects does not keep adding memory.
- The known limits listed under v0.0.6 still apply.

## v0.0.6, beta version (not released)

icloneOS v0.0.6 is a beta version.

While confinement is on, as it is by default on macOS, the agent runtime itself runs inside its own Seatbelt profile, which refuses anything it does not name; agent
commands are started outside it by the app and confined in their own profile.
The Containers pane shows those commands as they run, and why any of them was refused.
What these notes say about profiles, the launcher, the kernel and refusals holds only while confinement is on, and a shell command you approve runs once outside it.

### What you can turn off, and what that costs

- **Turning confinement off.** Confinement is on by default on macOS, and you can turn it off; the control is named Isolation. The control is in Containers › Backends, Settings › Agent › Permissions and Settings › Advanced. Turning it off shows a system alert that says what you lose, with Cancel as the default; turning it on is one click with no alert. Either change restarts the agent, and what it is doing stops. While it is off a red warning shows in the Message bar and on every tab of the Containers pane. Off is not kept across a quit unless the keychain holds the app's key: otherwise confinement is on again at the next launch, and the alert says which. Apple's container tool shows its state and the reason.
- **What you lose while it is off.** Agent commands run as you with no Seatbelt around them: they can change or delete any file you can, and read your SSH, cloud and package tokens, your keychain files, this app's data and the agent's own keys; the file tools ask once before reading your keys and secrets in the modes that ask. They can read what your other programs were started with and their environment, this app's runtime included, and those can hold secrets. They can reach the network and change a repository's git config and hooks; MCP servers, scheduled scripts, installs of plugins, skills and packages, and your hooks run outside the Seatbelt too. Your permission mode still decides, and in Ignore permissions nothing asks; those are checks in the app, not the kernel, and a determined program can go round them.
- **Turning it back on.** The kernel refuses again, and that undoes nothing. A program started while it was off can keep running, and what it did stays: changed files, copied secrets, things left to run later, including files the app later trusts. Such a program can also keep a copy of the signed off setting: put back during the session it is refused; putting it back after you quit has not been tested.
- **Ignore permissions.** The Message bar has a selector with an arrow and the current mode's name; it lists the five modes. In Ignore the Seatbelt still holds your agent's commands, while its file tools go outside it one file at a time. Your choice applies to the open session, at once and with no restart, and another session can differ; Settings › Permissions holds the default for new sessions. With the Keychain setting off, the mode you choose lasts until you quit, then it is Manual again. A new chat has its own mode. An iNFT pill used in an empty chat does not ask; one that moves an existing chat to a new chat can still ask. A new install stays in Manual with confinement on. The first time you choose it a system alert names what it lifts; after that it is one click. In this mode nothing in the app or the runtime asks about what a session is doing: not the app's sheet, the runtime's own ask, the dangerous-command prompt, the gateway, MCP trust and consent, ACP edits, or staged memory and skill writes. Without asking, the agent can move your iNFTs, send your keys, type your admin password, overwrite its own permission files (icloneOS does not take an edit it cannot verify), spend your money, ignore every Privacy switch you turned off, and write, delete, run and install anything confinement allows, and, while it is off, anything but the runtime's own stores. A malicious page or file the agent reads can lead it to do any of this, and nothing protects you from that. This mode does not turn confinement off: while confinement is on, the kernel still refuses what a profile does not name, and that is no promise about your iNFTs or keys. macOS's own privacy prompts and a refused backend are not asks, and they still happen. Payments and the agent's consent requests read the mode of the session that called them; a session with no call in the last two minutes, or one the app does not know, asks, even in this mode.
- **What still refuses.** In Ignore permissions, apart from confinement while it is on, five checks refuse: total destruction of the machine, in every mode; a recursive delete whose whole target is a variable or command output it cannot read, or a recursive delete it can read as aimed at the disk, a home folder or the system, also when a variable left empty would make it so, or by a command whose name it cannot read, or a recursive delete whose targets or options it cannot fully read; a call too unreadable to check (a patch whose files it cannot name, a write that names no file, or arguments it cannot read); deny rules you wrote; and the file tools on the runtime's own stores. That means `rm -rf` at `/` or everything in it, `~`, `$HOME` or a whole `/Users/name`; erasing or writing raw to a disk (`diskutil` erase, `dd` to a disk device, `newfs`); and kernel or boot damage (kext unload, `nvram`, `bless`, `csrutil`). Shutdown, reboot, killing every process, system permissions and stopping icloneOS ask once in the modes that ask, Plan refuses, Ignore runs them. It is a check on the text of a command in the app and the runtime, not a wall in the kernel: a script, a program, a language's own delete call, or a command built at run time, encoded or passed through eval can go round it, and with confinement off nothing in the kernel stands behind it. The check reads one command at a time: a variable exported, or a function or alias made, by an earlier command in the same terminal (the terminal keeps them between calls), such as `HOME`, `CDPATH`, `IFS` or `GIT_CONFIG_PARAMETERS`, is not known to it, so `export CDPATH=/` and then `cd usr && rm -rf *` is not refused. It does not know the folder a command runs in either, so a recursive delete that climbs out of a project with `..`, such as `rm -rf ../../*` run two folders below your home, is not refused; a launcher such as `xargs`, `npx rimraf` or `cmake -E rm` around a delete is not read. In every other mode moving an iNFT, sending keys out, typing the admin password and changing the agent's own permissions still ask, what you approve runs, and no grant for a session or for always lifts the ask.
- **Scheduled scripts.** A scheduled job's own script is read before it runs, with no one to ask: outside Ignore permissions it is refused when it meets any of the gate's floors (shutdown, reboot, killing every process, a fork bomb, stopping icloneOS, its permission policy and the files that guard it, secrets, sudo, system permissions, iNFT moves, an unread command beside a payment program, total destruction, a recursive delete whose whole target is a variable or command output it cannot read, or a recursive delete it can read as aimed at the disk, a home folder or the system, also when a variable left empty would make it so, or by a command whose name it cannot read, or a recursive delete whose targets or options it cannot fully read, and a call too unreadable to check); what a tool call would only ask about because of your mode (deletes, git push --force, payments, curl | sh) runs with no ask, because you scheduled it. In Ignore permissions it is refused only for total destruction, a recursive delete whose whole target is a variable or command output it cannot read, or a recursive delete it can read as aimed at the disk, a home folder or the system, also when a variable left empty would make it so, or by a command whose name it cannot read, or a recursive delete whose targets or options it cannot fully read, a call too unreadable to check; Ignore here is the mode set for the folder the icloneOS runtime works in, else the default in Settings › Permissions, not a mode picked for a chat; that the job's own working folder does not count is read from the code, with no behaviour test yet (a stated limit). A script that meets a deny rule you wrote is refused in every mode, and so is a Python script that declares an encoding other than UTF-8 or ASCII. Only the script's own text is checked: a file it runs is not, and commands built by xargs or find -exec sh -c around a delete are not read, for tool calls and scripts alike. A script changed after the check does not run: a Python script started through icloneOS' own dependency environment runs only if its bytes match the checked ones. On macOS and Linux a shell script's identity is checked again just before it starts and bash reads the whole file before running any line, so lines added after it starts never run; a write or a file swapped in, in the instant between that last check and bash reading the file, still runs unchecked; on Windows bash reads the file while it runs, so lines added after it starts can run. A Python script on another interpreter is refused if the file changed by the moment it starts, but a change after it has started is not caught. Anything a script runs itself, its own file again included, is not checked. A scheduled shell script runs with BASH_ENV and ENV cleared, so no startup file runs before the checked text.
- **Approved shell commands.** Allowing a shell command on the ask runs that one command outside the Seatbelt, with your full access, together with the programs it starts, in the folder the ask names. The ask says so before you click, and the run is logged in Activity. This covers a command of the terminal tool, in the foreground or in the background, with or without a pty, whose text equals what the ask showed; execute_code stays confined. A command allowed with no ask stays confined, and a refused agent is told the mode, the cause and what to do. An approved action that names its path widens through the existing grant and stays confined. The one exception is a single file in your home folder that no folder grant can open, hidden or not, or at any depth under `~/Library`, your shell startup files, `~/.gitconfig`, `~/Library/LaunchAgents`, keys and browser profiles included: your agent's file tools write that exact file once outside the Seatbelt and log it in Activity. In Manual, Accept edits and Automatic you allow it once on the ask, whatever a stored grant says; in Ignore permissions there is no ask; Plan stays read-only. `read_file` and `patch` take the same route, so the agent then holds what it read, keys and other `.env` files included. A link such as a `~/.zshrc` in a dotfiles repo writes its real target, and the ask names both. For the shell, git and launchd files it knows, the ask says that what goes in may run later with your access; that list is not complete, so read the path. With the Seatbelt off, your keys and secrets, keychain, browser profiles and shell, git and launchd files also ask once in every mode that can write but Ignore, whatever a stored grant says. With the Seatbelt on, only this app's own files stay shut; with it off they ask, Plan refuses and Ignore writes them, while the file tools still refuse the runtime's stores in every mode: no write to state.db, sessions, mcp-tokens, pairing, vault, browser-profile and the runtime's own .env, no read of mcp-tokens, vault, browser-profile, auth.json, auth.lock, that .env and webhook_subscriptions.json; reading state.db, sessions and pairing does not ask. After reading only part of a file the agent must read the rest or patch; it cannot replace the file. The approval lasts 120 seconds and is bound to the text and the folder. Programs in the command's group end with it; do not count on a child that leaves the group ending with it.
- **The agent's own iNFT profile.** The agent writes its own profile in every mode, Plan included: SOUL, memories and the files in its folder, with write_file, patch and the memory tool. That route refuses config.yaml, .env, auth.json, hidden files, anything named permission or policy, code and database files, plugins, hooks, skills, sessions and another agent's profile. A shell echo into SOUL.md stays refused by the kernel while confinement is on.
- **Screen recording.** Your agent can now record the whole screen to a video file in Movies/icloneOS Recordings, for at most 600 seconds: it asks in Manual, not in Ignore permissions, and the Screen recording switch in Settings > Privacy stops it in every mode but Ignore permissions.
- **Computer use.** While confinement is on, computer use, once you grant it, runs outside the Seatbelt through the signed driver; it asks in Manual, Accept edits and Automatic, Plan refuses it, and Ignore permissions runs it with no ask. Allow turns to Waiting for macOS at once; if macOS stays silent the exact pane opens and a line says so, and a failure shows its reason. An unreadable state says so and never says not allowed, and What is CuaDriver? explains the driver. 

### Improved

- **AI record.** A new title-bar button beside the browser record button records the screen as timed screenshots, only the ones that changed, and puts them in your next message with a short timeline; you can remove any of them, and nothing leaves your Mac until you send.
- **Keys 1 to 5 in the selector.** With the selector open in the Message bar, keys 1 to 5 change the mode at once, for this session.
- **The browser record button.** Its video goes to Movies/icloneOS Recordings, and nothing deletes it, except the empty file a failed save leaves; a partial video stays and the notice says it may be incomplete. A confined command cannot write in that folder, and neither it nor Movies can be a project. Turning the button off stops it, and saves at once in most cases; with the Seatbelt off and a visible browser the save can take about half a minute, and the button says so; it shows off, armed or capturing; a notice names the file, and a failed save says so.
- **The browser with the Seatbelt on.** Your agent's browser runs outside the Seatbelt. With Web browsing on in Settings > Privacy, it runs after you allow it in Manual and Accept edits, with no ask in Automatic, and in Plan it opens and reads pages with no ask; in Ignore permissions it never asks. It goes through a door in the launcher that takes exact commands and refuses `file:` addresses. A web page can lead the agent. Its debugger listens only on ports that web pages cannot load and every Seatbelt profile refuses. Because it runs outside the Seatbelt, the browser can reach this Mac's local services, which confined commands cannot. A confined command with network can still reach other devices on your local network over IPv4.
- **The agent runtime has its own profile.** Before this release, agent commands, tools, the browser and helper programs
  ran in a profile, but the runtime that issues them, and the interpreter processes it starts, did not. The runtime now
  starts from a profile that denies everything by default and allows only what was measured as needed.
  - It can start only its own interpreter, found by its real path.
  - It can write only to its own home (except the `plugins`, `installs` and `tools` folders inside it), its run folder,
    scratch and temporary folders, and caches.
  - The app's own state and secrets are not readable to it, except the policy file the app writes for the launcher (your modes, grants and listed folders), the list of allowed hard links, and the tokens of the permission and payment sockets it may call. Its unix sockets are limited to name lookup, the launcher
    below, and the app's permission and payment sockets; keychain services are denied. Over IP it can reach any internet host and any service on this Mac's loopback, because it has to call your model providers and local model servers.
- **Agent commands start from a launcher the app owns.** The runtime no longer starts them itself. A launcher that the
  app owns starts each command in its own profile, and it checks every request first: the profile, the parameters,
  the folders the command is granted and that the caller is a process of the same user. It refuses a request that reuses one of the last 16,384 run tokens. The runtime cannot remove a run's record.
- **Refusals name their run.** A refusal is tied to the run that caused it whenever the kernel's report names one; the rest are listed as not attributed. The app keeps its own record of
  refusals, capped at 10,000 rows.
- **Stopping a run stops its descendants.** A child process that detaches itself from its parent is still found and
  stopped with the run while the run's record exists. A confined command left running in the background is stopped when you quit the app. A process whose run record is gone is stopped when you quit the app and whenever the modes change, lowered or raised. It shows under one command, the newest that could have started it; that row says so, and its Stop ends it. A Stop that was pressed but whose kill did not complete does not read as stopped while something of the run is alive.
- **Quieter refusal list.** Two routine macOS lookups for system logging stay refused but are no longer reported. They
  had made up 51 of the 58 refusal rows in one hour of normal use.
  Every other refusal is listed and counted, wherever it pointed. A shell's repeated look at one folder, as a `cd` or a wildcard does, reads as one line with its count; nothing in that folder was read.
- **Runtime housekeeping is marked.** The runtime's own routine calls carry a mark saying they came from the runtime.
  The Containers pane folds such a run away only when it ended with no refusals, or has been running for under 30
  seconds. The mark is the runtime's own statement and never hides a refusal.
- **Containers pane.** The pane has five sections: Activity, Refusals, Profiles, Agents and Backends (Backends was named "This Mac").
  The top of the window is the title alone; each state and warning sits in the section it belongs to.
  For each run you can see when it started, its state and when it ended; you can stop it, open an inspector for it, and
  see why a command was refused.
  - Every confined command shows when it started, what it is doing and how it ended, and you can stop it or see why
    something was refused.
    A command left running in the background shows Background ended once the last process it left has gone. The launcher knows when that was and whether it stopped it, not how the command ended, so no exit status is shown.
  - Refusals can be filtered by who issued them when the runtime has refusals of its own, and runtime
    housekeeping can be folded away in Activity. Refusal groups keep the refusal's own wording in their headings.
  - A refusal that the runtime reports (not the launcher) is marked as runtime-reported, because a runtime that has
    been compromised could hide its own refusals.
  - Tooltips in the pane use the app's own tooltip instead of the operating system's.
- **Light appearance.** Light mode was broken across the app, and v0.0.4 shipped with it. In light mode the dark skins
  now render as the light skin; the dark appearance is unchanged. Text contrast was measured text by text.

- **ChatGPT traffic through your own proxy.** If you send ChatGPT traffic through your own proxy, set HERMES_CODEX_BASE_URL to it: a ChatGPT login goes there while the variable is set and stops the moment it is unset. With only model.base_url, a URL on a manual row, or --base-url, the login is refused once, naming the host, the variable, the key command and how to remove the URL; nothing is sent.
- **Subagents with their own URL.** A subagent that sets its own base URL (delegation.base_url) now needs its own key (delegation.api_key); it inherits the parent's key only when the URL equals the parent's route.
- **A lost or broken config.yaml.** If a gateway's config.yaml is unreadable or incomplete, a gateway key is refused with a message naming the fix. If the file is lost, icloneOS shows the provider setup screen, which does not name the file. In both cases nothing is sent until it is fixed; it no longer continues on the last gateway it saw.
- **Background commands.** With confinement on, background=true commands run, survive a hangup, and poll and die through the process tool. A tool relying on a hangup to reload does not get one inside background=true, because the hangup is ignored. A backend that is refused gives its reason without asking you for six named tools; another tool can show one sheet first.

### Limits that stay true
- **Ports confined commands cannot use.** A confined command with network cannot use the ports the browser's debugger uses (among them IRC on 6667 and SIP on 5060), anywhere.
- **A command you approve starts fresh.** A shell command you approve runs once outside the Seatbelt, and its `cd` and `export` do not carry to the next command.
- **No TCP over IPv6 in confined commands.** The kernel rule that keeps confined commands with network off this Mac's local services cannot tell those from the rest of IPv6, so a name falls back to IPv4, and on an IPv6-only network they will not connect.

- **By default.** Every limit below describes confinement while it is on; it is on by default, and you can turn it off.
- **The runtime keeps its own data.** The runtime can still read and write its own home: its configuration, its
  sessions and the model keys stored there. Apart from the project folder a window opened, its walls are your home folder, your keys, your keychains, the app's own
  records and other apps; its own data is not behind one.
- **The runtime chooses the project folder.** The runtime picks which project folder a command gets. A compromised
  runtime could name almost any folder in your home as the project (everything outside `~/Library` and the list of
  keys, credentials and app data that is never offered), and a command running in its own profile could then read it.
  The folder a command gets is not only the one you opened.
- **What the launcher checks.** Writing inside a project needs a mode that allows project writes. The launcher that starts every confined command reads the modes from the app itself, never from the agent's request, and allows a command at most what the widest mode you have set anywhere on this Mac allows; a mode you narrow for one session or project is honoured by the runtime and not re-checked by the launcher. When every mode you have set is Manual or Plan, a confined command can write a project only after you allowed a command in that folder in the app: for the two minutes after a one-time allow, for as long as an allow for that project lasts, or, because the launcher cannot tell sessions apart, in every open folder after an allow for a session or for always. A one-time allow of a command or of the network also opens the network for those two minutes. The launcher checks the folder and the time, not the exact command: asking about each command is the runtime's job. Automatic writes with no pass only when File writing is on: undecided, a command runs read-only and says so; off, a request to write is refused. A command that lacks the permission runs without project writes or network; the Containers pane says so, and so does the output of a command that then fails. A command's own row offers Allow this folder when that command ran narrowed because its folder was not listed. A folder that an allowed ask listed gets the next ask instead, for as long as that ask's pass lasts.
- **Which folders.** Apart from its own scratch and output folders and, for builds, package caches, a confined command can write only inside a folder you opened with Open folder… or the project picker, typed in the command palette (a trailing slash or `..` is taken as the folder it names), set as your Default project directory, named by allowing a command, or listed with Allow this folder in the Containers pane. A project clicked in the sidebar is not listed by the click. Projects from an earlier version are not listed, so they run read-only until one Allow this folder, which is kept across quits. A command in a folder that is not listed, with no allow in effect, has no project writes; until a later command there has project writes, that command's details offer Allow this folder. A folder you named by allowing a command stays writable only while that allow lasts. A folder you listed stays listed until you remove it in the Permissions pane; listing it sets no mode, so writing there still needs a mode or an allow. A confined command cannot write any other folder, and it can read one only if it runs in that folder. A folder inside a git repository under your home folder that you open, type, set as your default or allow with Allow this folder is listed together with the repository's root, never your home folder itself. An ask inside such a repository names the root on its sheet and lists it only while its pass or grant is live. A command run in a sub-folder of a listed folder runs under the listed repository that holds it, or else under the nearest listed folder, and writes as that folder. Your Default project directory is listed each time the agent starts, so removing it under Permissions lasts only until the agent next starts. Moving it removes from the list only what the default itself added. A folder the picker chose that the app will not list says why, as a typed path does. The app keeps the 500 folders most recently listed; naming a 501st drops the oldest, and a command with project writes running there is stopped. Folders are compared by identity: a working folder given in another case or Unicode form runs in the spelling the folder itself reports. A folder too large to check in time is refused, and the command says so; a check that only waited behind others says that instead. A command whose working folder is reached through a link, inside the project or anywhere else, is refused before it starts: none of it ran. The refusal says which folder to give. A link in a project is listed in path completion as a plain entry and is not followed.
- **Plan.** When every mode you have set is Plan, a confined command can read but not write or reach the network. If the app could not write its policy for the launcher, no confined command runs.
- **Not every process.** The Electron app itself, the launcher, and the payment and permission helpers run as ordinary
  processes and are not covered by these profiles.
- **Linked settings.** A `config.yaml`, `.env` or `.op.env` linked outside the agent's home is refused while confinement is on; the app offers a button that replaces it with a private copy, and the command that does the same, except for a link to your keys or the app's own data, which you move yourself.
- **What project writes allow.** If a project folder is already a git repository when a confined command starts, that command cannot change that repository's config or hooks, so some git commands that write them, such as `git remote add`, `git config user.name` and `git worktree add`, are refused and `git push -u` does not record the upstream. It can still write a rebase plan into `.git`, and a `git rebase --continue` you then run carries out any command in that plan. A repository the agent creates, or any repository nested inside the project, has no protection of its config or hooks: treat git in those folders as running the agent's code. Anything else in the project is the agent's text too: a `.envrc`, an editor task, a `package.json` script or a Makefile you then run runs the agent's code. Review the changes before you run them yourself.
- **Your git name and e-mail.** So that a confined `git commit` carries your identity, the app gives the runtime the name and e-mail from `~/.config/git/config` or `~/.gitconfig`, and the runtime can reach any internet host. If neither file sets a name, git falls back to your macOS account name and host name.
- **Very short background commands.** A background command that ends almost at once, before the launcher has seen its first process, is seen only if the runtime's background wrapper started it.
- **If the launcher is killed.** A launcher that is killed outright, rather than quit with the app, cannot stop the commands it started when you quit or lower a mode. The pane's Stop still works.
- **Other processes.** A confined process (a command the agent runs or a worker of the runtime) cannot read any other process's command line or environment; the kernel refuses the call. Inside confinement ps, top, pgrep and lsof do not work, because they ask about other processes, and nohup cannot detach; use background=true for a long-running command. Other apps of your user that are not confined can read the runtime's environment, which holds the app's own session secrets and anything the shell that launched the app had exported. Under confinement a descendant in the same group goes with a kill; one in its own process group has no test, so do not count on it.
- **Run-token folder.** A compromised runtime can fill the run-token folder with files, which slows the pane's scan and Stop; it gains no access by doing so.
- **Known issue.** One macOS account cannot run two versions of the app at once, because the app allows a single
  running instance (app id `io.cloneframe.icloneos`).

### Fixed
- With the Seatbelt on, an approved background command could look finished while it ran, with no Stop. Stop now ends it, with the launcher up or killed.
- After a hangup, the agent could lose track of a background command and no longer kill it.

- Cmd+T or a cmd-click could leave a chat that no longer opened on a plain click.
- The browser record button could save a video of a single frame; it now records the navigation.

### Security
- A confined command with network could reach loopback services through `::ffff:0.0.0.0`. The kernel now refuses it.

- **Where a ChatGPT login or key can be sent.** v0.0.6 fixes where a ChatGPT login or key can be sent. chatgpt.com's Codex API takes only ChatGPT's own login; that login goes only to chatgpt.com, and no pool row changes that, unless HERMES_CODEX_BASE_URL names the host at that moment; this is checked on every httpx send, the SDK's included, and on the catalog's urllib sender; a refused send stops once with its fix and is not retried. The check sees only Authorization: Bearer. A key that is not a login passes to every host but the Codex paths of chatgpt.com, so a key sent to the wrong gateway goes through. Login means shaped like one, not signature-checked. Not seen: aiohttp, requests, a urllib call outside the catalog's, the codex app-server binary, a header added later by an httpx.Auth or event hook.
- **Other processes in v0.0.5.** The v0.0.5 command profile did not deny the kernel call that returns another process's command line and, unless that process is a platform binary or signed with `restrict`, its environment. We read that profile and measured the call on a later tree; we did not run the v0.0.5 build. v0.0.6 denies the call for confined processes.
- **Writes to the agent's home.** The app's own writes to the agent's home folder, including its installer's settings step, now refuse symbolic links and special files, so a compromised agent cannot use them to redirect those writes to your other files. A brief window remains in some file steps of the runtime updater, between its check and the step itself.
- **Accepted advisories.** The five accepted dependency advisories from the v0.0.5 notes (zod and decode-uri-component in the sign-in page; zod and acp-node in the optional ACP CLI) still have no compatible fix, so we keep them and decide them again at v0.0.7. A static check found that the sign-in page does not run the affected code and that the ACP CLI uses zod only on local configuration.

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
