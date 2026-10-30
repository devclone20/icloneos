"""V3-F §1/§4 — every tool call → exactly one action class, plus the facts the mode table's footnotes need.

Classes: R read · Wp write in project · Wo write outside · X shell · N network · $ spend · M message ·
S system permission · I install · D delete. An unknown tool is ``UNKNOWN_TOOL_CLASS``, the strictest class (V3-UP
r2): a new tool is never silently allowed, not even in Ignore permissions. ``TOOL_CLASSES`` names every tool Hermes
can dispatch (registry, bundled plugins and memory providers, aliases, the Tool Search bridge); the coverage test
derives that universe by machine and fails on any name missing here.
"""

from __future__ import annotations

import errno
import fnmatch
import glob
import json
import os
import re
import shlex
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .normalize import NormalizedCommand, SimpleCommand, _split_top, mask_data, normalize
from .policy import MANUAL_TABLE_ROW, decide_cell, matching_grant

# (class, ceiling consent key or None[, "get"]) — "get" marks a GET with no body and no credentials (Plan
# allows it, note 5). Path-taking writers and readers are refined from their arguments below.
_R = ("R", None)
_N_GET = ("N", "webBrowsing", "get")
_N = ("N", "webBrowsing")
_M = ("M", "sendMessages")
_X = ("X", "terminal")

TOOL_CLASSES: Dict[str, Tuple[Optional[str], ...]] = {
    # agent-to-agent: talking to another agent is a message
    "a2a_call": _M,
    "a2a_discover": _N,
    "a2a_history": _R,
    "a2a_list": _R,
    "a2a_orchestrate": _M,
    # the app's own panes and previews: no effect outside the window
    "annotate_preview": _R,
    "apply_layout": _R,
    "close_terminal": _R,
    "desktop_preview": _R,
    "drive_preview": _R,
    "focus_pane": _R,
    "gui_tour": _R,
    "show_tip": _R,
    "tour": _R,  # 1ac3f97 alias → gui_tour (same class)
    "tip": _R,  # 1ac3f97 alias → show_tip
    "clarify": _R,
    "todo_list": _R,
    "todo": _R,  # 1ac3f97 alias → todo_list
    # browsing: navigation reads, everything else may submit
    "browser_back": _N_GET,
    "browser_navigate": _N_GET,
    "browser_snapshot": _N_GET,
    "browser_get_images": _N_GET,
    "browser_vision": _N_GET,
    "browser_console": _N,
    "browser_click": _N,
    "browser_press": _N,
    "browser_scroll": _N_GET,
    "browser_type": _N,
    "browser_dialog": _N,
    "browser_cdp": _N,
    # Browser Use mode (1ac3f97's default browser): ``code`` is PYTHON the harness runs on the host, with every module
    # it can import — code execution first, browsing second (V3-UP r3; read like execute_code's code below). icloneOS'
    # confinement turns Browser Use mode off (tools/browser_use_cli.py), so this row governs an unconfined Hermes.
    "browser_exec": _X,
    # the password vault (1ac3f97): the list returns handles, never secrets; unlock is a system prompt the user
    # answers; a fill can put a CARD into a checkout, so it is spend-class; saving writes Hermes' vault. A 2FA code
    # entry mints the second factor from a saved authenticator seed "with no questions": a credential action, classed
    # like the fill (ruling 43) — it asks by default in every mode; the owner's per-function levels can lower it.
    "browser_vault_list": _R,
    "browser_vault_unlock": ("S", "automation"),
    "browser_vault_fill": ("$", "spendTrade"),
    "browser_vault_save_login": ("Wo", "fileWriting"),
    "browser_vault_enter_code": ("$", "spendTrade"),
    # the screen and the desktop
    "computer_use": ("S", "automation"),
    "read_window_below": ("R", "screen"),
    "read_terminal": _R,
    # shell and code (PROCESS_TOOLS are refined from their action below: reads stay R, input to a running shell is X)
    "terminal": _X,
    "process_manage": _X,
    "process": _X,  # 1ac3f97 alias → process_manage
    "execute_code": _X,
    "cronjob_manage": ("X", "scheduledTasks"),
    "cronjob": ("X", "scheduledTasks"),  # 1ac3f97 alias → cronjob_manage
    # delegation: the sub-agent's own tool calls pass this plugin themselves
    "delegate_task": _R,
    # messaging platforms
    "discord": _M,
    "discord_admin": _M,
    "message_agent": _M,  # Bot Mode teammate DM (an inline tool, injected rather than registered)
    "meet_join": _M,  # google_meet (opt-in plugin): the bot joins a call others are in
    "meet_say": _M,
    "meet_leave": _R,
    "meet_status": _R,
    "meet_transcript": _R,
    "react_to_message": _M,
    "send_message": _M,
    "feishu_drive_add_comment": _M,
    "feishu_drive_reply_comment": _M,
    "yb_send_dm": _M,
    "yb_send_sticker": _M,
    # network reads and provider calls
    "feishu_doc_read": _N_GET,
    "feishu_drive_list_comments": _N_GET,
    "feishu_drive_list_comment_replies": _N_GET,
    "web_search": _N_GET,
    "web_extract": _N_GET,
    "x_search": _N_GET,
    "yb_query_group_info": _N_GET,
    "yb_query_group_members": _N_GET,
    "yb_search_sticker": _N_GET,
    "image_generate": _N,
    "video_generate": _N,
    "video_analyze": _N,
    "vision_analyze": _N,
    "text_to_speech": _N,
    "xai_video_edit": _N,
    "xai_video_extend": _N,
    "spotify_albums": _N_GET,
    "spotify_devices": _N_GET,
    "spotify_library": _N_GET,
    "spotify_playlists": _N_GET,
    "spotify_search": _N_GET,
    "spotify_playback": _N,
    "spotify_queue": _N,
    # files
    "read_file": _R,
    "search_files": _R,
    "session_search": _R,
    "skill_view": _R,
    "skills_list": _R,
    "write_file": ("Wp", "fileWriting"),
    "patch": ("Wp", "fileWriting"),
    # desktop Projects (1ac3f97: one tool for create/switch/list): its strictest action decides — create writes
    "desktop_project": ("Wo", "fileWriting"),
    # Hermes' own state outside any project: memory, skills, the kanban board
    "memory": ("Wo", "fileWriting"),
    "skill_manage": ("Wo", "fileWriting"),
    "kanban_list": _R,
    "kanban_show": _R,
    "kanban_attachments": _R,
    "kanban_attach": ("Wo", "fileWriting"),
    "kanban_attach_url": ("Wo", "fileWriting"),
    "kanban_block": ("Wo", "fileWriting"),
    "kanban_comment": ("Wo", "fileWriting"),
    "kanban_complete": ("Wo", "fileWriting"),
    "kanban_create": ("Wo", "fileWriting"),
    "kanban_heartbeat": ("Wo", "fileWriting"),
    "kanban_link": ("Wo", "fileWriting"),
    "kanban_request_changes": ("Wo", "fileWriting"),
    "kanban_request_review": ("Wo", "fileWriting"),
    "kanban_schedule": ("Wo", "fileWriting"),
    "kanban_unblock": ("Wo", "fileWriting"),
    # installing tools: connectors and MCP servers (1ac3f97), catalog plugins and hub skills
    "manage_connections": ("I", "installSoftware"),
    "manage_catalog": ("I", "installSoftware"),
    "setup_mcp": ("I", "installSoftware"),  # an inline replay shim for manage_connections(install, mcp)
    # Tool Search lookups (V3-UP r3, ruling 43): they return tool NAMES and DESCRIPTIONS from the session's own catalog
    # and nothing else — a read in every mode, Plan included. ``tool_call`` is not a tool of its own: see
    # ``BRIDGE_WRAPPERS`` (the class of what it wraps).
    "tool_search": _R,
    "tool_describe": _R,
    # The bundled memory providers' tools (opt-in, ``memory.provider``; injected into the agent, never registered).
    # A query sends the agent's text to the provider (a local CLI or a remote service holding a credential): N, never
    # the GET-only kind. A status/list read sends nothing of the agent's. Anything that stores, changes or forgets a
    # memory writes Hermes' own state outside the project, like ``memory``: Wo. A local file a tool uploads is read in
    # the Hermes process: its path argument carries the secrets floor (``PATH_ARGS``).
    "brv_query": _N,
    "brv_curate": ("Wo", "fileWriting"),
    "brv_status": _R,
    "fact_store": ("Wo", "fileWriting"),  # one tool for add/search/update/remove: its strictest action decides
    "fact_feedback": ("Wo", "fileWriting"),
    "retaindb_profile": _N,
    "retaindb_search": _N,
    "retaindb_context": _N,
    "retaindb_list_files": _N,
    "retaindb_read_file": _N,
    "retaindb_remember": ("Wo", "fileWriting"),
    "retaindb_forget": ("Wo", "fileWriting"),
    "retaindb_ingest_file": ("Wo", "fileWriting"),
    "retaindb_delete_file": ("Wo", "fileWriting"),
    "retaindb_upload_file": ("Wo", "fileWriting"),
    "viking_search": _N,
    "viking_read": _N,
    "viking_browse": _N,
    "viking_remember": ("Wo", "fileWriting"),
    "viking_forget": ("Wo", "fileWriting"),
    "viking_add_resource": ("Wo", "fileWriting"),
}

# V3-UP r3 (ruling 43): the Tool Search bridge's ``tool_call`` reaches the permission hook only when the agent loop
# could not peel it (a connector batch, an entry it could not resolve, an out-of-scope or malformed call); a peeled
# call reaches the hook under the name it wraps. It is classified as what it wraps — every entry, the strictest wins —
# and as the unknown class when it cannot be read.
BRIDGE_WRAPPERS = frozenset({"tool_call"})
_WRAPPER_DEPTH_MAX = 2

# V3-UP r3: every argument of a tool OTHER than the file tools (``PATH_READERS``/``PATH_WRITERS``/patch) that can name
# a file or a directory on this machine. The candidates are derived by machine from the runtime's own schemas
# (tests/fixtures/tool_universe.json ``pathArgs``); each is decided here or, when it never names a local path, in
# the tool-table test with its reason — a new one fails that test. Kinds: ``read`` (the tool reads it: the secrets
# floor), ``anchor`` (a directory a later session or job runs in: the secrets floor; its own calls are judged there),
# ``cwd`` (where this call's command runs: its relative paths resolve there, and the secrets floor), ``write`` (the
# tool writes it: classified as that write, Wp/Wo and the guard floor, the stricter of it and the tool's class wins).
PATH_ARGS: Dict[str, Tuple[Tuple[str, str], ...]] = {
    "terminal": (("workdir", "cwd"),),
    "cronjob_manage": (("workdir", "anchor"),),
    "cronjob": (("workdir", "anchor"),),  # 1ac3f97 alias → cronjob_manage
    "desktop_project": (("path", "anchor"),),
    "kanban_create": (("workspace_path", "anchor"),),
    "delegate_task": (("tasks[].images[]", "read"),),
    "desktop_preview": (("url", "read"),),  # the pane opens a file path as readily as a URL
    # V3-UP r5 (ruling 56): the browser renders a local resource as readily as a web page (file:, view-source:file:,
    # filesystem:, blob: of a file, chrome:/about: pages): its url is a path argument in every mode.
    "browser_navigate": (("url", "read"),),
    "vision_analyze": (("image_url", "read"),),
    "video_analyze": (("video_url", "read"),),
    "yb_send_dm": (("media_files[].path", "read"),),
    "retaindb_upload_file": (("local_path", "read"),),
    "viking_add_resource": (("url", "read"),),
    "text_to_speech": (("output_path", "write"),),
}

# V3-UP r2 (M1), ruling 40: a tool missing from the table — a dynamic ``mcp__…`` or ``connectors__…`` tool, a
# user-installed plugin's or memory provider's tool, anything upstream adds after this version — is the strictest
# class: it may pay, so it asks in every mode (Ignore included), Plan refuses it, no grant lifts it, and the spend
# switch OFF refuses it. Every name the runtime itself can dispatch is in the table (tests/plugins/
# test_iclone_permissions_tool_table.py holds it to tests/fixtures/tool_universe.json, derived by machine).
UNKNOWN_TOOL_CLASS: Tuple[Optional[str], ...] = ("$", "spendTrade")
# The background-process tool under both names the runtime accepts (1ac3f97 renamed it before the permission hook).
PROCESS_TOOLS = frozenset({"process_manage", "process"})
# Tools whose ``code`` argument runs as a program (its shell-outs read like a command line): max(X, those).
CODE_TOOLS = frozenset({"execute_code", "browser_exec"})

GET_ONLY_TOOLS = frozenset(name for name, value in TOOL_CLASSES.items() if value[2:] == ("get",))
PATH_WRITERS = {"write_file": "path", "patch": "path"}
PATH_READERS = {"read_file": "path", "search_files": "path"}
# process actions that only look at a background process; everything else acts on it (write/submit are shell input).
_PROCESS_READS = frozenset({"list", "poll", "log", "wait"})
_PROCESS_INPUT_MAX = 8192

# acp commands the agent socket treats as moving value (iclone-acp-ipc movesValue): the verbs, any subcommand named
# for money, and any money option on an ordinary verb (`provider submit --transfer-amount`, V3-I critic F2).
_ACP_SPEND = re.compile(
    r"(^|[\s;&|(])acp(\s+--inft\s+\S+)?\s+("
    r"trade(?!\s+(stock-list|hl-status|hl-orders)\b)|client\s+(fund|create-job|create-custom-job)"
    r"|provider\s+set-budget-with-fund-request|wallet\s+(send-transaction|topup)|compute\s+top-up"
    r"|\S+\s+\S*(transfer|fund|pay|hire|top-?up)\S*)\b"
)
_ACP_CALL = re.compile(r"(^|[\s;&|(])acp\s")
_MONEY_FLAG = re.compile(r"(^|\s)--(transfer|fund|pay|hire|top-?up|value|amount-to-send)([-=\s]|$)", re.I)
_BOOLEAN_FLAGS = frozenset({"--json", "--yes", "-y", "--force", "--quiet", "-q", "--verbose", "-v"})


def _acp_dry_run(command: str) -> bool:
    """`--dry-run` counts only as the unambiguous last flag of a single command (same rule as iclone-acp-ipc)."""
    if any(sep in command for sep in (";", "&", "|", "\n", "$(", "`")):
        return False
    words = _command_words(command)
    if "--" in words or not words or words[-1] != "--dry-run":
        return False
    before = words[-2] if len(words) > 1 else ""
    return not before.startswith("-") or "=" in before or before in _BOOLEAN_FLAGS


def _acp_spends(command: str) -> bool:
    moving = bool(_ACP_SPEND.search(command)) or bool(_ACP_CALL.search(command) and _MONEY_FLAG.search(command))
    return moving and not _acp_dry_run(command)


# A message sent through a CLI is M (asks in Automatic like any message): acp's message/email verbs and the agentcard
# agent inbox (`agentcard email send|reply|compose|forward`, critic r3 T8 list — an email, not a spend).
_ACP_MESSAGE = re.compile(
    r"(^|[\s;&|(\"',:=\[{])(acp(\s+--inft\s+\S+)?\s+(message\s+send|email\s+(compose|reply))"
    r"|agentcard\s+(\S+\s+)*?email\s+(send|reply|compose|forward))\b",
    re.I,
)
_INSTALL = re.compile(
    r"(^|[\s;&|(])(sudo\s+)?(brew\s+(install|reinstall|upgrade)|npm\s+(i|install|add)\b|pnpm\s+add|yarn\s+add"
    r"|pip3?\s+install|uv\s+(pip\s+install|tool\s+install|add)|pipx\s+install|gem\s+install|cargo\s+install"
    r"|apt(-get)?\s+install|port\s+install|softwareupdate\s+-i|installer\s+-pkg)\b"
)
_DELETE = re.compile(r"(^|[\s;&|(])(sudo\s+)?(rm|rmdir|unlink|trash|shred)\s")
_DELETE_PROGS = frozenset({"rm", "rmdir", "unlink", "trash", "shred"})
_PRIVILEGED = re.compile(r"(^|[\s;&|(])(sudo|doas|su)\s|--global\b|\s-g\b|/usr/local/|/opt/homebrew/(?!bin/brew)")
_TCC = re.compile(r"tccutil|x-apple\.systempreferences|com\.apple\.preference\.security|System Settings|System Preferences", re.I)
_OSASCRIPT = re.compile(r"(^|[\s;&|(])osascript\b")
_SUDO_FEED = re.compile(r"sudo\s+(-\w*S|--stdin)|\|\s*sudo\b|SUDO_ASKPASS")
_KEYCHAIN = re.compile(r"(^|[\s;&|(])security\s+(find-generic-password|find-internet-password|dump-keychain|export)\b")
# A pane driving another pane is a shell by proxy (V3-D): never classed lower than X, whatever it carries.
_IT_PROXY_VERBS = frozenset({"exec", "run", "send", "send-key", "spawn", "tmux", "bus"})
_IT_PROXY = re.compile(r"(^|[\s;&|(])it\s+(exec|run|send|send-key|spawn|tmux|bus\s+attention)\b")
# On-chain sends outside acp: a signed transaction moves value.
_CHAIN_SEND = re.compile(r"(^|[\s;&|(])(cast\s+(send|mktx|publish)|forge\s+script\b[^\n]*--broadcast)\b")
# Floor 7: stopping icloneOS or Hermes (the permission gate lives in them). A kill verb may sit inside quotes
# (`osascript -e 'do shell script "killall icloneOS"'`), after `xargs`, behind a path (`/bin/kill`, `./kill`) or in
# any letter case (`KILL` resolves on a case-insensitive APFS) — r4 T2'.
_KILL = re.compile(r"(^|[\s;&|(\"'])(sudo\s+)?(?:\S*/)?(kill|pkill|killall)\b([^;&|\n]*)", re.I)
_KILL_NAMES = re.compile(r"hermes|iclone|electron|python|node\b|\bvenv\b|tui_gateway", re.I)
# A target this classifier cannot read: a command substitution, ANY parameter expansion (`${X}`, `$PPID`, `$$`, `$!`,
# `$USER`), or a pid list fed by `xargs`. `kill $(pgrep -f electron)` and `kill $PPID` name the gate without naming it,
# so the floor holds for every expansion (r3 T2, r4 T2').
_EXPANSION = re.compile(r"\$\(|`|\$\{|\$[\w$!]")
_XARGS_KILL = re.compile(r"\bxargs\b[^;&|\n]*\b(kill|pkill|killall|launchctl)\b")
# `kill -9 -1` (every process the user owns) and `kill 0` (this process group) always reach the gate.
_KILL_ALL = re.compile(r"(^|\s)(--\s+)?(-1|0)(\s|$)")
# `pgrep`/`pidof` naming a guard inside a command that kills: the pid is the gate's, however it is piped.
_PID_LOOKUP = re.compile(r"\b(pgrep|pidof)\b[^;&|\n)`]*")
# launchd is another way to stop a process: by label, by `pid/<n>/`, by an expansion — or a whole domain at once
# (`bootout gui/501` tears down the user's session, Electron included).
_LAUNCHCTL = re.compile(
    r"(^|[\s;&|(\"'])(sudo\s+)?(?:\S*/)?launchctl\s+(stop|disable|kill|unload|bootout|remove|kickstart\s+-k)\b([^;&|\n]*)", re.I
)
_LAUNCHD_DOMAIN = re.compile(r"(^|\s)(system|(gui|user|login|session)/\d+)/?(?=\s|$)")
# `fuser -k <file|port>` kills whoever holds a resource: the holder cannot be read here, so it may be the gate.
_FUSER_KILL = re.compile(r"(^|[\s;&|(\"'])(sudo\s+)?(?:\S*/)?fuser\s+[^;&|\n]*?(-\w*k|--kill)", re.I)
# pkill/killall selecting by something other than a name — the user (`-u`/`-U`), a parent (`-P`), a process group
# (`-g`), a group id (`-G`), a session (`-s`), a tty (`-t`), a pidfile (`-F`), a regex (`killall -m`) — reaches the gate:
# it runs as the user, under launchd, in the user's session, and any regex can spell its name. A signal (`-HUP`,
# `-SIGKILL`, `-9`) is not a selector.
_PKILL_SELECTOR_FLAGS = frozenset("uUPgGstFm")
_PKILL_LONG_SELECTORS = frozenset({"uid", "euid", "user", "parent", "pgroup", "group", "session", "terminal", "pidfile",
                                   "regex", "older", "newer"})
_SIGNAL_NAME = re.compile(r"^(SIG)?[A-Z]{2,}\d?$")
# m3 (r4): a kill written in an interpreter — `os.kill(`, `psutil`, `process.kill(`, `Process.kill(`, `.terminate()`,
# `.send_signal(`, a signal that can only be sent — floors when the text holds a guard pid, an expansion, a walk over
# every process, or no literal pid at all (then the pid comes from a file, a lookup or a loop the classifier cannot
# read). A literal pid that is not a guard is not the floor.
_CODE_KILL = re.compile(
    r"os\.kill(pg)?\s*\(|\bpsutil\b|process\.kill\s*\(|\.terminate\s*\(|\.send_signal\s*\(|\.kill\s*\(\s*\)"
    r"|signal\.SIG(KILL|STOP)\b",
    re.I,
)
_CODE_KILL_UNREADABLE = re.compile(r"process_iter\s*\(|\bpids\s*\(\s*\)")
_CODE_NUMBER = re.compile(r"(?<![\w.])(\d+)(?![\w.])")
_SIGNAL_RANGE_MAX = 64
# `osascript … quit|kill` of an app named in _KILL_NAMES is the same stop by another door (r3 T5). A wordless
# quit is a stop too (r4 m6): ⌘Q sent with `keystroke "q" using command down`, or the raw `aevtquit` Apple
# event — both quit the targeted (or frontmost) app without a `quit` token.
_OSASCRIPT_STOP = re.compile(r"\b(quit|kill)\b", re.I)
_OSASCRIPT_KEYQ = re.compile(
    r"keystroke\s+[\"']?q[\"']?\s+using\s+(command|cmd)(\s+key)?\s+down|«?\s*event\s+aevtquit\s*»?|\baevtquit\b", re.I)
_OSASCRIPT_APP = re.compile(r"\b(?:application|app|process)\s+(?:id\s+)?[\"']([^\"']+)[\"']", re.I)
_OSASCRIPT_INTERMEDIARIES = frozenset({"system events", "system preferences", "system settings"})
# Floor 5 via the payment CLIs the bundled skills teach (V3-J contract): x402 fetch/send, cards, OKX, Privy. r4 T8':
# every verb that signs or sends — `privy … rpc <eth_send*|eth_sign*|personal_sign|*signTypedData*|sign/sendTransaction>`,
# `privy … wallets send|sign`, `onchainos wallet send|transfer|contract-call|sign-message|gas-station`, `onchainos
# cross-chain|strategy|defi|gateway|payment|swap|bridge|sign|broadcast`. Reads (`wallets list`, `rpc eth_getBalance`,
# `wallet balance|addresses|history`) are not named here. The boundary accepts the quotes, commas and colons of JSON
# arguments (an MCP tool carrying the same text, critic i6).
_CARD_SPEND = re.compile(
    r"(^|[\s;&|(\"',:=\[{])(agentcard\s+(\S+\s+)*?(wallet\s+(fetch|send|transfer|pay)|request\s+new|card\s+(create|new)"
    r"|checkout|pay(ment)?|x402)"
    r"|onchainos\s+(\S+\s+)*?(payment|swap|bridge|cross-chain|strategy|defi|gateway|x402|limit-order|gas-station|sign|broadcast"
    r"|wallet\s+(send|transfer|contract-call|sign-message|gas-station|sign|approve|withdraw|deposit))"
    r"|privy\s+(\S+\s+)*?(transactions?|wallets?\s+(send|sign|transfer)"
    r"|rpc\s+(\S+\s+)*?(--method[=\s]+)?[\"']?(eth_send\w*|eth_sign\w*|personal_sign|\w*sign(typeddata|transaction|message|andsend)\w*"
    r"|\w*_sign\w*|send\w*transaction)))\b",
    re.I,
)
# T-M2/T-N: a payment/kill/automation binary is the same program whether it is typed bare, behind its install
# path, or after a runner (`npx privy`) — the normaliser folds all of those to the bare program word, so these
# sets are matched against the folded program, not the raw text.
_MONEY_PROGS = frozenset({"privy", "onchainos", "agentcard"})
_CHAIN_PROGS = frozenset({"cast", "forge"})
_MONEY_NAME = re.compile(r"\b(privy|onchainos|agentcard|acp)\b", re.I)
_NODE_RUNNERS = frozenset({"node", "bun", "deno", "ts-node", "tsx"})
_NODE_MONEY_PATH = re.compile(r"/(privy|onchainos|agentcard)/", re.I)
# killall/pkill sweeps and `fuser -k` act on a process broadly: even when they miss the gate they are not the
# "safe" X that Automatic allows unattended.
_KILL_FAMILY = frozenset({"pkill", "killall", "fuser"})
# m1 (r2, r4): an expansion where a write lands — a redirect target that CONTAINS one (`> /tmp/$(…)/x`, `>> $B/x`),
# or any argument of cp/mv/ln/tee/install/rsync/dd/touch/truncate/sponge/sed -i/perl -pi that contains one (`cp a $B`)
# — can spell a guarded path without naming it. A bare `$NAME` counts; an escaped `\$(` is a literal file name and does
# not. Hermes' own detector does not see it; the classifier marks it dangerous (Automatic asks). In Ignore it stays R1
# until V3-G confinement.
_UNESCAPED_EXPANSION = r"(?<!\\)(\$\(|`|\$\{|\$\w)"
_EXPANSION_WRITE = re.compile(
    r"(\d*|&)?>{1,2}\|?\s*[\"']?[^\s;&|<>]*?" + _UNESCAPED_EXPANSION
    + r"|(^|[\s;&|(])(sudo\s+)?(cp|mv|ln|tee|install|rsync|dd|touch|truncate|sponge|sed\s+-\w*i|perl\s+-\w*i)\b[^;&|\n]*?"
    + _UNESCAPED_EXPANSION
)
# Floor 8: an iNFT changes owner only by the owner's hand. Function names and their 4-byte selectors.
_OWNERSHIP_FN = re.compile(r"safeTransferFrom|transferFrom|setApprovalForAll|\bapprove\b|\bpermit\b", re.I)
_OWNERSHIP_SELECTORS = ("42842e0e", "b88d4fde", "23b872dd", "095ea7b3", "a22cb465")
_APPROVE_ALL = re.compile(r"setApprovalForAll|a22cb465", re.I)


@dataclass
class Classified:
    cls: str
    ceiling_key: Optional[str]
    target: str
    project: Optional[str]
    facts: Dict[str, bool] = field(default_factory=dict)
    floor: Optional[str] = None
    unknown: bool = False   # r7 U: some part of the text could not be fully modelled (see ``line_has_unknown``)


@dataclass(frozen=True)
class Scope:
    """r7b m-g: who is calling — the session and its lineage (the hook's own), so the class is chosen against the
    grants that really match this call (``policy.matching_grant``), exactly as the decision will read them."""
    session_id: Optional[str] = None
    lineage: Tuple[str, ...] = ()


_NO_SCOPE = Scope()


_PATH_ERRORS = (OSError, RuntimeError, ValueError)


def _walk_ceilings() -> List[Path]:
    """K-RT9: where the walk up for a git root stops. The user's home (a home that is itself a git repository must not
    make every folder in it one project), ``HERMES_HOME`` and the runtime this plugin runs in."""
    raws = (os.environ.get("HOME") or os.path.expanduser("~"),
            os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes"),
            str(Path(__file__).resolve().parents[2]))
    out: List[Path] = []
    for raw in raws:
        try:
            out.append(Path(raw).expanduser().resolve())
        except _PATH_ERRORS:
            continue
    return out


def _past_ceiling(candidate: Path, here: Path, ceilings: Sequence[Path]) -> bool:
    """True when ``candidate`` is above a ceiling ``here`` lies in, or is the home folder itself (never a project root
    unless it is where the call runs)."""
    home = ceilings[0] if ceilings else None
    for ceiling in ceilings:
        if (here == ceiling or ceiling in here.parents) and candidate in ceiling.parents:
            return True
    return candidate != here and home is not None and candidate == home and home in here.parents


def project_root(cwd: Optional[str]) -> Optional[str]:
    """realpath of the git root above ``cwd``, else ``cwd`` itself (§1 "Project"). Unresolvable ⇒ no project.
    The walk never reaches the home folder or goes above HERMES_HOME or the runtime root (K-RT9)."""
    if not cwd:
        return None
    try:
        here = Path(cwd).expanduser().resolve()
        ceilings = _walk_ceilings()
        for candidate in (here, *here.parents):
            if _past_ceiling(candidate, here, ceilings):
                break
            if (candidate / ".git").exists():
                return str(candidate)
        return str(here)
    except _PATH_ERRORS:
        return None


def _resolve(raw: str, cwd: Optional[str]) -> Optional[str]:
    """The real path a tool would touch, or ``None`` when it cannot be resolved (loop, NUL, too long) — the
    caller then treats it as outside every project and inside every guard (fail closed, F-1)."""
    try:
        expanded = os.path.expanduser(raw)
        if not os.path.isabs(expanded) and cwd:
            expanded = os.path.join(cwd, expanded)
        try:
            # Python 3.13+ no longer raises on a symlink loop in a non-strict resolve (the runtime ships 3.14):
            # a strict resolve still does (ELOOP), so a loop stays unresolvable; any other strict failure (a path
            # that does not exist yet, an unreadable folder) resolves non-strictly as before.
            return str(Path(expanded).resolve(strict=True))
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                return None
            return str(Path(expanded).resolve())
    except _PATH_ERRORS:
        return None


def _within(path: Optional[str], root: str) -> bool:
    if path is None:
        return False
    try:
        resolved_root = str(Path(root).expanduser().resolve())
    except _PATH_ERRORS:
        resolved_root = root
    return path == resolved_root or path.startswith(resolved_root.rstrip(os.sep) + os.sep)


def _guarded(path: Optional[str], roots: Sequence[str]) -> bool:
    """A write target inside a never-writable path. An unresolvable target is guarded: it may be one."""
    return path is None or any(_within(path, root) for root in roots)


def _matches_secret(path: Optional[str], pattern: str) -> bool:
    if path is None:
        return True
    try:
        pattern = str(Path(os.path.dirname(pattern)).resolve() / os.path.basename(pattern))
    except _PATH_ERRORS:
        pass
    return fnmatch.fnmatchcase(path, pattern) or _within(path, pattern)


def _mentions(command: str, paths: Sequence[str]) -> Optional[str]:
    home = os.path.expanduser("~")
    normalized = command.replace("$HOME", home).replace("${HOME}", home)
    normalized = re.sub(r"(^|[\s=\"'])~(?=/)", lambda m: m.group(1) + home, normalized)
    for raw in paths:
        stem = raw.split("*", 1)[0].rstrip(os.sep) or raw
        if stem and stem in normalized:
            return raw
    return None


_REDIRECT = re.compile(r"^(\d*|&)?[<>]+&?")
_GLOB_MAX = 200


def _command_words(command: str) -> List[str]:
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return command.split()


def _command_paths(command: str, cwd: Optional[str]) -> List[Optional[str]]:
    """Every word that may name a path, resolved — including ``>file`` redirects, ``--opt=path`` values and glob
    expansions (a glob is how the round-1 critic copied over the policy). ``None`` = a path that does not resolve."""
    out: List[Optional[str]] = []
    for word in _command_words(command):
        candidates = [_REDIRECT.sub("", word)]
        if "=" in word:
            candidates.append(word.split("=", 1)[1])
        for raw in candidates:
            if not raw or (raw.startswith("-") and "=" not in raw):
                continue
            if "\0" in raw:
                out.append(None)
                continue
            if any(ch in raw for ch in "*?["):
                try:
                    base = raw if os.path.isabs(os.path.expanduser(raw)) else os.path.join(cwd or ".", raw)
                    for hit in glob.glob(os.path.expanduser(base))[:_GLOB_MAX]:
                        out.append(_resolve(hit, cwd))
                except _PATH_ERRORS:
                    out.append(None)
            out.append(_resolve(raw, cwd))
    return out


def _hardline(command: str) -> Optional[str]:
    try:
        from tools.approval import detect_hardline_command

        hit, description = detect_hardline_command(command)
    except Exception as exc:  # noqa: BLE001 — the floor cannot be checked, so the floor holds
        return f"hardline: the never-run list could not be checked ({type(exc).__name__})"
    return f"hardline: {description}" if hit else None


def _dangerous(command: str) -> bool:
    try:
        from tools.approval import detect_dangerous_command
    except Exception:  # pragma: no cover
        return True
    return bool(detect_dangerous_command(command)[0])


def _stop_targets_guard(rest: str, guard_pids: Sequence[int], by_name: bool) -> bool:
    """The arguments of one kill/launchctl verb: a guard pid, a guard name (when the verb takes names), a target the
    classifier cannot read (an expansion), or everything at once."""
    if _EXPANSION.search(rest) or _KILL_ALL.search(rest):
        return True
    if by_name and _KILL_NAMES.search(rest):
        return True
    # `-<n>` after the signal is a process group (`kill -9 -4242`): Electron leads the group Hermes runs in, so a
    # negative number is compared like a pid. A signal number (`-9`) is compared too — a guard never has a pid ≤ 64.
    numbers = {abs(int(n)) for n in re.findall(r"(?<![\w.])-?\d+\b", rest)}
    return bool(numbers & set(guard_pids))


def _pkill_selects_more_than_a_name(rest: str) -> bool:
    """pkill/killall arguments that pick processes by user, parent, group, session, tty, pidfile or regex."""
    for token in rest.split():
        if token.startswith("--"):
            if token[2:].split("=", 1)[0] in _PKILL_LONG_SELECTORS:
                return True
        elif token.startswith("-") and len(token) > 1:
            flags = token[1:]
            if flags.isdigit() or _SIGNAL_NAME.match(flags):
                continue
            if set(flags) & _PKILL_SELECTOR_FLAGS:
                return True
    return False


def _code_kills_guard(text: str, guard_pids: Sequence[int]) -> bool:
    """A kill written in Python/Node/Ruby (m3): a guard pid literal, an expansion, a walk over every process, or no
    literal pid at all ⇒ the floor. Only a literal pid outside the guards (`os.kill(1234, 9)`) is not."""
    if not _CODE_KILL.search(text):
        return False
    if _EXPANSION.search(text) or _CODE_KILL_UNREADABLE.search(text):
        return True
    numbers = {int(n) for n in _CODE_NUMBER.findall(text)}
    if numbers & set(guard_pids):
        return True
    return not any(n > _SIGNAL_RANGE_MAX for n in numbers)


def _kill_targets_guard(command: str, guard_pids: Sequence[int]) -> bool:
    kills = list(_KILL.finditer(command))
    launches = list(_LAUNCHCTL.finditer(command))
    if (not kills and not launches and not _XARGS_KILL.search(command) and not _CODE_KILL.search(command)):
        return False
    # A pid looked up by name anywhere in a command that kills: the lookup names the target (`pgrep -f electron |
    # xargs kill`, `kill $(pgrep -x icloneOS)`).
    if any(_KILL_NAMES.search(lookup.group(0)) for lookup in _PID_LOOKUP.finditer(command)):
        return True
    if _XARGS_KILL.search(command):
        return True
    for match in kills:
        verb, rest = match.group(3).lower(), match.group(4) or ""
        by_name = verb in ("pkill", "killall")
        if by_name and _pkill_selects_more_than_a_name(rest):
            return True
        if _stop_targets_guard(rest, guard_pids, by_name):
            return True
    for match in launches:
        # launchd targets are labels (`gui/501/com.iclone.os`), `pid/<n>/…`, or a whole domain: names always count here.
        rest = match.group(4) or ""
        if _LAUNCHD_DOMAIN.search(rest) or _stop_targets_guard(rest, guard_pids, True):
            return True
    return _code_kills_guard(command, guard_pids)


def _osascript_stops_guard(command: str) -> bool:
    """`osascript` with a `quit|kill` of an app named in _KILL_NAMES anywhere in the command (r3 T5, r4 m2): the script
    may come after `-e`, on stdin (`echo '… to quit' | osascript`) or in a heredoc, so the whole text is read. A script
    file (`osascript x.scpt`) cannot be read and stays S (asks in every mode)."""
    if not _OSASCRIPT.search(command):
        return False
    if _OSASCRIPT_STOP.search(command) and _KILL_NAMES.search(command):
        return True
    # A wordless ⌘Q / aevtquit quits the app it is told to, or the frontmost one. It is the floor when it names a
    # guard, or when it names no explicit non-guard app at all (the frontmost app may be ours — fail closed).
    if _OSASCRIPT_KEYQ.search(command):
        if _KILL_NAMES.search(command):
            return True
        # ⌘Q / aevtquit sent via System Events (or with no app at all) lands on the FRONTMOST app, which may be
        # ours — only an explicit `tell application "<non-guard, non-intermediary>"` names a different target.
        named = [app for app in _OSASCRIPT_APP.findall(command)
                 if not _KILL_NAMES.search(app) and app.strip().lower() not in _OSASCRIPT_INTERMEDIARIES]
        if not named:
            return True
    return False


# An argv array in JSON arguments (`["privy", "wallets", "rpc", …]`) reads as the command line it will become.
_ARGV_JOIN = re.compile(r"[\"']\s*,\s*[\"']")


def _inft_floor(text: str, policy: Mapping[str, Any]) -> Optional[str]:
    text = _ARGV_JOIN.sub(" ", text)
    lowered = text.lower()
    if _APPROVE_ALL.search(text):
        return "inft: an approval over every token of a collection is signed only by you"
    contracts = [str(c).lower() for c in policy.get("inftContracts") or [] if isinstance(c, str) and c]
    # The contract matches with or without its `0x` (r3 T6): `cast send 4dfb…631 'transferFrom(…)'` names it too.
    bodies = [c[2:] if c.startswith("0x") and len(c) == 42 else c for c in contracts]
    if not any(c and c in lowered for c in contracts + bodies):
        return None
    if (
        _OWNERSHIP_FN.search(text)
        or any(sel in lowered for sel in _OWNERSHIP_SELECTORS)
        or _CHAIN_SEND.search(text)
        or _ACP_SPEND.search(text)
        or _CARD_SPEND.search(text)
    ):
        return "inft: transferring an iNFT or signing an approval for one is done only by you"
    return None


def _interpreter_paths() -> List[str]:
    """Where this gate's interpreter loads code from (r3 T3): the prefix it runs in and every site-packages dir —
    `sitecustomize.py` or a `.pth` there runs inside the gate's process before any plugin does."""
    # The whole venv when there is one (its bin/ and lib/); a system prefix such as /usr is too broad to name, so
    # there only its site-packages count.
    paths = [sys.prefix] if sys.prefix != sys.base_prefix else []
    # The interpreter binary itself, behind the venv's symlink (a write through `venv/bin/python` lands there).
    try:
        paths.append(os.path.realpath(sys.executable))
    except _PATH_ERRORS:
        pass
    try:
        import site

        paths += list(site.getsitepackages())
        paths.append(site.getusersitepackages())
    except Exception:  # noqa: BLE001 — a venv without `site` still has its prefix guarded
        pass
    return [p for p in paths if isinstance(p, str) and p]


def guard_paths(policy: Mapping[str, Any]) -> List[str]:
    """Floor 2 + 7 write guards: main's list plus what only this process knows (its spool, stats, own code and the
    interpreter it runs in). Writes to any of these are updates, never agent edits."""
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    own = [
        os.path.dirname(os.path.abspath(__file__)),
        os.path.join(home, "iclone-perm-spool"),
        os.path.join(home, "iclone-perm-stats"),
        os.path.join(home, "plugins"),
    ] + _interpreter_paths()
    return [str(p) for p in policy.get("protectedPaths") or [] if isinstance(p, str)] + own


def _guard_pids(policy: Mapping[str, Any]) -> List[int]:
    pids = [p for p in policy.get("guardPids") or [] if isinstance(p, int) and p > 1]
    own = [os.getpid(), os.getppid()]
    # The process group this gate runs in (Electron leads it): `kill -- -<pgid>` stops everything in it (r4 T2').
    try:
        own.append(os.getpgrp())
    except (AttributeError, OSError):  # pragma: no cover — no process groups on this platform
        pass
    return pids + own


def _money_prog(cmd: SimpleCommand) -> Optional[str]:
    """The payment binary a simple command actually invokes, after the normaliser has folded its program word:
    the bare name, or a `node …/privy/bin/cli` whose script path names the CLI."""
    prog = cmd.prog.rsplit("/", 1)[-1].lower()
    if prog in _MONEY_PROGS:
        return prog
    if prog in _NODE_RUNNERS:
        for arg in cmd.args:
            if arg.startswith("-"):
                continue
            hit = _NODE_MONEY_PATH.search(arg)
            return hit.group(1).lower() if hit else None
    return None


def _command_spends(commands: Sequence[SimpleCommand]) -> bool:
    """`$` by program word: a payment/trade command whose PROGRAM is a money CLI (folded, path-stripped, behind a
    runner or a node script path), so `~/.privy/bin/privy` and `npx privy` (r4 M2) both read as `privy`."""
    for cmd in commands:
        prog = cmd.prog.rsplit("/", 1)[-1].lower()
        money = _money_prog(cmd)
        if money and _CARD_SPEND.search(money + " " + " ".join(cmd.args)):
            return True
        if prog == "acp" and _acp_spends(" ".join(["acp", *cmd.args])):
            return True
        if prog in _CHAIN_PROGS and _CHAIN_SEND.search(" ".join([prog, *cmd.args])):
            return True
    return False


def _command_messages(commands: Sequence[SimpleCommand]) -> bool:
    """`M` — a message/email sent through the acp or agentcard CLI (program word, same discipline)."""
    for cmd in commands:
        prog = cmd.prog.rsplit("/", 1)[-1].lower()
        if prog in ("acp", "agentcard") and _ACP_MESSAGE.search(" ".join([prog, *cmd.args])):
            return True
    return False


# r6 (critic r5 M3, T-M1b): the guarded processes as a `pkill -f`/`killall -m` pattern meets them — their names AND
# their real command lines and binary paths (a fragment such as `bin/` or `MacOS/` selects them). The static part
# names where main, Electron and the Hermes backend live (`backend-command.ts`: `hermes serve --host 127.0.0.1
# --port 0`); the live part is read from this process (the Hermes backend the gate runs in) and the guard pids.
_GUARD_CORPUS = ("hermes", "hermes serve --host 127.0.0.1 --port 0", "icloneos", "iclone os", "electron",
                 "python", "python3", "node", "tui_gateway", "tui_gateway/server.py", "serve",
                 "/Applications/iclone os.app/Contents/MacOS/iclone os",
                 "/Applications/iclone os.app/Contents/Frameworks/iclone os Helper (Renderer).app/Contents/MacOS/"
                 "iclone os Helper (Renderer)",
                 "/Applications/iclone os.app/Contents/Frameworks/iclone os Helper (GPU).app/Contents/MacOS/"
                 "iclone os Helper (GPU)",
                 "/Applications/Hermes.app/Contents/MacOS/Hermes",
                 "/Users/u/.hermes/hermes-agent/venv/bin/python3 /Users/u/.hermes/hermes-agent/venv/bin/hermes serve "
                 "--host 127.0.0.1 --port 0",
                 "/Users/u/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main serve --host 127.0.0.1 --port 0",
                 "/Users/u/.hermes/hermes-agent/venv/bin/python -m tui_gateway.server",
                 "/Users/u/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .",
                 "/opt/homebrew/bin/node", "/usr/local/bin/python3")
_LIVE_CORPUS: Dict[Tuple[int, ...], Tuple[str, ...]] = {}
_LIVE_CORPUS_LOCK = threading.Lock()


def _guard_corpus(guard_pids: Sequence[int]) -> Tuple[str, ...]:
    """The static corpus plus the live argv/exe of this process and of every guard pid (best effort, cached per
    pid set): a pattern that matches what the gate is ACTUALLY running as reaches it."""
    key = tuple(sorted(set(guard_pids)))
    with _LIVE_CORPUS_LOCK:
        cached = _LIVE_CORPUS.get(key)
    if cached is not None:
        return cached
    live: List[str] = [sys.executable, " ".join(getattr(sys, "orig_argv", None) or sys.argv)]
    try:
        live.append(os.path.realpath(sys.executable))
    except _PATH_ERRORS:
        pass
    try:
        import psutil  # noqa: PLC0415 — optional; without it the static corpus still holds the shapes
    except Exception:  # noqa: BLE001
        psutil = None
    if psutil is not None:
        for pid in key:
            try:
                proc = psutil.Process(pid)
                live.append(" ".join(proc.cmdline()))
                live.append(proc.exe())
            except Exception:  # noqa: BLE001 — gone or not ours to read: the static corpus still applies
                continue
    corpus = _GUARD_CORPUS + tuple(item for item in live if isinstance(item, str) and item.strip())
    with _LIVE_CORPUS_LOCK:
        _LIVE_CORPUS[key] = corpus
    return corpus


def _pattern_could_match_guard(pattern: str, guard_pids: Sequence[int] = ()) -> bool:
    """A `pkill -f`/`killall` pattern that, read as a regex, could match a guarded process name, command line or
    binary path (r5 T-M1b, r6 M3): an empty or everything-matching pattern, or any regex that matches the guard
    corpus. An invalid regex fails closed."""
    pattern = pattern.strip().strip("\"'")
    if not pattern or pattern in (".", ".*", ".+", "^", "$", "^.*$", "[a-z]", "[a-zA-Z]"):
        return True
    try:
        rx = re.compile(pattern, re.I)
    except re.error:
        return True
    return any(rx.search(item) for item in _guard_corpus(guard_pids))


def _pkill_pattern_floor(commands: Sequence[SimpleCommand], guard_pids: Sequence[int] = ()) -> bool:
    """A `pkill`/`killall` whose selector pattern could reach a guard. A plain literal that matches no guard
    (`pkill -f my-dev-server`, `pkill -t ttys003 vim`'s name) is NOT the floor — it is a dangerous X."""
    for cmd in commands:
        if cmd.prog.rsplit("/", 1)[-1].lower() not in ("pkill", "killall"):
            continue
        pattern = _pkill_pattern(cmd)
        if pattern is not None and _pattern_could_match_guard(pattern, guard_pids):
            return True
    return False


def _pkill_pattern(cmd: SimpleCommand) -> Optional[str]:
    """The pattern argument of a pkill/killall: the value of `-f`/`--full`/`-m`/`--match`/`-x`, else the first
    non-flag operand. ``None`` when a selector flag (handled elsewhere) owns the match, with no pattern."""
    args = cmd.args
    i = 0
    pattern_flag = False
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if tok.startswith("--"):
            name = tok[2:].split("=", 1)[0]
            if name in ("full", "match", "exact") and "=" in tok:
                return tok.split("=", 1)[1]
            if name in ("full", "match", "exact"):
                pattern_flag = True
            i += 1
            continue
        if tok.startswith("-") and len(tok) > 1:
            flags = tok[1:]
            if flags.isdigit() or _SIGNAL_NAME.match(flags):
                i += 1
                continue
            if set(flags) & set("fmx"):
                pattern_flag = True
            i += 1
            continue
        return tok
    if i < len(args):
        return args[i]
    return "" if pattern_flag else None


def _fuser_kill_floor(commands: Sequence[SimpleCommand], guard_pids: Sequence[int]) -> bool:
    """`fuser -k <port>/tcp|<file>` kills whoever holds a resource. It is a dangerous X in general; it is the
    floor when a guarded process is the holder (r5 T-M1b) — or when the holder cannot be read (r6 m4)."""
    for cmd in commands:
        if cmd.prog.rsplit("/", 1)[-1].lower() != "fuser":
            continue
        if not any(a in ("-k", "--kill") or (a.startswith("-") and not a.startswith("--") and "k" in a[1:])
                   for a in cmd.args):
            continue
        for arg in cmd.args:
            port = re.match(r"(\d+)(/(tcp|udp))?$", arg)
            if port and _port_held_by_guard(int(port.group(1)), guard_pids):
                return True
    return False


def _port_held_by_guard(port: int, guard_pids: Sequence[int]) -> bool:
    """Whether a guard holds ``port``. Fails CLOSED (r6 m4): no psutil, or a guard whose sockets cannot be read
    (access denied, any error other than "that process is gone"), counts as holding it — the floor."""
    try:
        import psutil  # noqa: PLC0415
    except Exception:  # noqa: BLE001 — cannot read the holders ⇒ it may be ours
        return True
    gone = getattr(psutil, "NoSuchProcess", ())
    # Each guard's OWN sockets: the system-wide table (`net_connections`) needs root on macOS and would always come
    # back unreadable. A same-user process's sockets are readable.
    for pid in dict.fromkeys(guard_pids):
        try:
            proc = psutil.Process(pid)
            conns = proc.net_connections(kind="inet") if hasattr(proc, "net_connections") else proc.connections(kind="inet")
        except gone:
            continue        # that guard does not exist: it holds nothing
        except Exception:  # noqa: BLE001 — unreadable ⇒ it may hold the port (fail closed)
            return True
        for conn in conns:
            laddr = getattr(conn, "laddr", None)
            if laddr and getattr(laddr, "port", None) == port:
                return True
    return False


def _unresolvable_floor(view: "View", guard_pids: Sequence[int], guarded: Sequence[str] = ()) -> bool:
    """A command whose program word (or whose code on stdin) this gate cannot read is the floor when a guarded pid,
    a guarded process name, or a payment binary appears anywhere in it — the unreadable part could resolve to
    exactly that (r5 T-N, fail closed). On the normalised reading: its own text, as since r5.

    r7 U: when the LINE has an unknown (``line_has_unknown``), the VERBATIM command (``raw.full``) is searched too —
    the data mask and the normaliser's dropped data can no longer hide a token from both readings (critic r6 M1).
    r7b m-q: that search runs on BOTH readings — a quote-folded token is whole only in the normalised text (which
    keeps the data of an unknown line), the verbatim text keeps what the normaliser could drop.
    There the tokens are a live guard pid, a guarded absolute path, or a guard name that names this product
    (``_GUARD_WORDS``); generic runtime basenames (interpreters, electron) count only as a guarded path. A money
    binary in the verbatim line is the ``$`` class (``_class_spend``), not this floor.
    r7b m-o: the product name counts as a word of its own, never inside a path (``_guard_word_outside_paths``) —
    the owner's repos and worktrees carry it in their paths; when a stop-type verb is on the line (either reading,
    ``view.stop``) it counts anywhere, as before."""
    if view.unresolvable:
        if _KILL_NAMES.search(view.full) or _MONEY_NAME.search(view.full):
            return True
        if _numbers(view.full) & set(guard_pids):
            return True
    if view.unknown:
        named = _GUARD_WORDS.search(view.full) if view.stop else _guard_word_outside_paths(view.full)
        return bool(named or _mentions(view.full, guarded) or _numbers(view.full) & set(guard_pids))
    return False


def _guard_word_outside_paths(text: str) -> bool:
    """r7b m-o: a product guard name in a word that is not a path — a word holding a ``/`` (or starting with ``~``
    or ``.``, a home- or dot-relative name) is a path, and the owner's own paths carry the product name."""
    for word in _WORD_SPLIT.split(text):
        if word and "/" not in word and word[0] not in "~." and _GUARD_WORDS.search(word):
            return True
    return False


def _numbers(text: str) -> set:
    return {abs(int(n)) for n in re.findall(r"(?<![\w.])-?\d+\b", text)}


# r7 U: the guard names searched as bare words in the verbatim line of a line with an unknown — the names of THIS
# product's processes; `_KILL_NAMES` also lists generic runtimes (python, node, electron, venv) that a read line
# names all the time, and those count there only as a guarded path (``guard_paths``) or a guard pid.
_GUARD_WORDS = re.compile(r"hermes|iclone|tui_gateway", re.I)
_MONEY_WORD = re.compile(r"(?<![\w.-])(privy|onchainos|agentcard|acp)(?![\w-])", re.I)
# r7b m-o: the words of a line (split on blanks, quotes and shell punctuation), and the stop-type verbs the
# plugin's own stop rules read (kill family, launchd, AppleScript quit, a process handle's terminate/signal).
_WORD_SPLIT = re.compile(r"[\s'\"`;|&()<>=,{}\[\]]+")
_STOP_VERBS = ("kill", "pkill", "killall", "fuser", "launchctl", "bootout", "stop", "quit", "aevtquit", "terminate",
               "signal", "send_signal")
_STOP_WORD = re.compile(r"(?<![A-Za-z0-9])(%s)(?![A-Za-z0-9])" % "|".join(_STOP_VERBS), re.I)


# ---- r6: two readings, every rule on both (monotone by construction) ------------------------------------------------
# Round 5 ran the floor/class rules on the NORMALISED text only, and the normaliser threw away code that reached a
# shell or an interpreter on stdin (critic r5 M1). Round 6 makes the use of the normaliser MONOTONE: every floor and
# class rule below is evaluated on the ORIGINAL text (``raw``) and on the NORMALISED text (``norm``), and the
# stricter result wins — normalising can only add a restriction, never remove one.
#
# The one deliberate difference between the readings: in ``raw.text`` the words the normaliser proved to be pure
# DATA (an `echo`/`grep`/`git log` argument whose output reaches no shell, interpreter or substitution, in a command
# line that runs no unreadable code) are masked, so `echo 'kill 4242'` is not read as a kill (the r4 over-floor m4).
# ``raw.full`` — what the path, secret, privilege and Hermes detectors read — is the command verbatim.

@dataclass(frozen=True)
class View:
    name: str                               # "raw" | "norm"
    text: str                               # verb / spend / iNFT scans
    full: str                               # paths, secrets, privilege, Hermes' own detectors
    commands: Tuple[SimpleCommand, ...]     # simple commands (raw: a plain shlex split of each top-level segment)
    unresolvable: bool
    unknown: bool = False                   # r7 U: the LINE has an unknown (same on both readings)
    stop: bool = False                      # r7b m-o: a stop-type verb is on the line, on EITHER reading


def _literal_commands(text: str) -> Tuple[SimpleCommand, ...]:
    """The original reading's simple commands: each top-level segment split as the shell would split its words —
    no variable resolution, no wrapper/runner/path folding, no container unwrapping."""
    out: List[SimpleCommand] = []
    for segment in _split_top(text):
        words = [w for w in _command_words(segment) if w not in ("(", ")", "{", "}")]
        if words:
            out.append(SimpleCommand(prog=words[0], args=words[1:]))
    return tuple(out)


# ---- r7 U: "unknown poisons the line" -----------------------------------------------------------------------------
# Three times a part of the line the classifier cannot fully model was treated as harmless (critic r6 M1, m-b, m-d).
# ONE predicate now says the line has an unknown, and when it does: (a) the data mask is OFF on BOTH readings —
# raw is the command verbatim, norm keeps every data-sink argument; (b) the class is at least X `dangerous`;
# (c) the verbatim command is searched for guard tokens (floor 7) and money binaries (`$`).

def line_has_unknown(norm: NormalizedCommand, code_unknown: bool = False) -> bool:
    """True when ANY of: a program word on some segment cannot be read (``norm.unresolvable``); piped or redirected
    data reaches a consumer that is neither a known executor nor on the closed NON-EXECUTING allowlist
    (``norm.unknown_consumer``); code is nested past the depth cap, in the normaliser (``norm.overflow``) or in the
    code classifier, or a code body it read has an unknown of its own (``code_unknown``)."""
    return bool(norm.unresolvable or norm.unknown_consumer or norm.overflow or code_unknown)


def views(command: str, norm: Optional[NormalizedCommand] = None,
          unknown: Optional[bool] = None) -> Tuple[View, View]:
    """The two readings of a shell command every rule is evaluated on. ``unknown`` (default: the predicate on
    ``norm``) turns the data mask OFF on both: raw reads the command verbatim, norm keeps the data-sink arguments."""
    norm = norm if norm is not None else normalize(command)
    if unknown is None:
        unknown = line_has_unknown(norm)
    if unknown and not norm.data_kept:
        norm = normalize(command, keep_data=True)
    masked = command if unknown else mask_data(command, norm.data)
    stop = bool(_STOP_WORD.search(command) or _STOP_WORD.search(norm.text))
    raw = View("raw", masked, command, _literal_commands(masked), False, unknown, stop)
    folded = View("norm", norm.text, norm.text, tuple(norm.commands), norm.unresolvable, unknown, stop)
    return raw, folded


@dataclass(frozen=True)
class _Ctx:
    cwd: Optional[str]
    policy: Mapping[str, Any]
    protected: Tuple[str, ...]
    secrets: Tuple[str, ...]
    guard_pids: Tuple[int, ...]


def _floor_hardline(v: View, c: _Ctx) -> Optional[str]:
    return _hardline(v.full)


def _floor_policy(v: View, c: _Ctx) -> Optional[str]:
    if _mentions(v.full, c.protected) or any(
            path is not None and _guarded(path, c.protected) for path in _command_paths(v.full, c.cwd)):
        return "policy: the command touches the permission policy or its guards"
    return None


def _floor_secrets(v: View, c: _Ctx) -> Optional[str]:
    if _mentions(v.full, c.secrets) or _KEYCHAIN.search(v.full):
        return "secrets: the command reads a key, token or keychain item"
    return None


def _floor_sudo(v: View, c: _Ctx) -> Optional[str]:
    return "privilege: sudo is never fed by the agent" if _SUDO_FEED.search(v.full) else None


def _floor_tcc(v: View, c: _Ctx) -> Optional[str]:
    return "privilege: system permissions are granted by you in System Settings" if _TCC.search(v.full) else None


def _floor_confinement(v: View, c: _Ctx) -> Optional[str]:
    if (_kill_targets_guard(v.text, c.guard_pids) or _pkill_pattern_floor(v.commands, c.guard_pids)
            or _fuser_kill_floor(v.commands, c.guard_pids) or _osascript_stops_guard(v.full)
            or _unresolvable_floor(v, c.guard_pids, c.protected)):
        return "confinement: icloneOS and the agent runtime are not stopped by the agent"
    return None


def _floor_inft(v: View, c: _Ctx) -> Optional[str]:
    return _inft_floor(v.text, c.policy)


# The floors, in the order their reasons are reported. Each is evaluated on BOTH readings.
FLOOR_RULES: Tuple[Tuple[str, Any], ...] = (
    ("hardline", _floor_hardline), ("policy", _floor_policy), ("secrets", _floor_secrets), ("sudo", _floor_sudo),
    ("tcc", _floor_tcc), ("confinement", _floor_confinement), ("inft", _floor_inft),
)


def _class_spend(v: View) -> bool:
    # r7 U (c): in a line with an unknown, a money binary named anywhere in the line is a spend — on both readings
    # (r7b m-q: a quote-folded name is whole only in the normalised text).
    return bool(_command_spends(v.commands) or _CARD_SPEND.search(v.text) or _acp_spends(v.text)
                or _CHAIN_SEND.search(v.text) or (v.unknown and _MONEY_WORD.search(v.full)))


def _class_message(v: View) -> bool:
    return bool(_command_messages(v.commands) or _ACP_MESSAGE.search(v.text))


def _class_install(v: View) -> bool:
    return bool(_INSTALL.search(v.full)) or any(_INSTALL.search(line) for line in _class_lines(v.commands))


def _class_automation(v: View) -> bool:
    return bool(_OSASCRIPT.search(v.full)) or any(
        cmd.prog.rsplit("/", 1)[-1].lower() == "osascript" for cmd in v.commands)


def _class_delete(v: View) -> bool:
    return bool(_DELETE.search(v.full)) or bool(_delete_commands(v.commands))


# The classes above X, most specific first, with their ceiling keys. Each is evaluated on BOTH readings.
CLASS_RULES: Tuple[Tuple[str, str, Any], ...] = (
    ("$", "spendTrade", _class_spend), ("M", "sendMessages", _class_message),
    ("I", "installSoftware", _class_install), ("S", "automation", _class_automation),
    ("D", "fileWriting", _class_delete),
)
_PRECEDENCE = ("$", "M", "I", "S", "D", "X")


def _rank(cls: str) -> int:
    return len(_PRECEDENCE) - _PRECEDENCE.index(cls) if cls in _PRECEDENCE else 0


# ---- r7 C: the strictest class over EVERY class present ------------------------------------------------------------
# A line (or a code body) can show several classes at once. Round 6 kept ONE by rank, so a laxer class could win
# over a stricter one in some mode, and the stricter class's ceiling was never consulted (critic r6 m-c). Round 7
# decides every class present against the signed policy — its own cell in EVERY mode of the table, its own ceiling,
# its own facts, and any grant that MATCHES this call — and keeps the class decided most strictly.
# r7b m-g: a grant counts only when ``policy.matching_grant`` finds it for the real session, lineage and project
# (``Scope``); a grant scoped to another session or project never makes its class look laxer here.
# `_PRECEDENCE` only breaks ties. No table (unsigned or the fuzz policy) ⇒ the Manual row, as ``policy.decide`` does.
_OUTCOME_SEVERITY = {"allow": 0, "ask": 1, "refuse": 2}


def _class_severity(cand: "Classified", policy: Mapping[str, Any],
                    scope: Scope = _NO_SCOPE) -> Tuple[int, int]:
    """(how strictly the policy decides ``cand`` summed over every mode, precedence rank). Mirrors
    ``policy.decide``: the cell of the class, its ceiling (a switch the body does not name is undecided), and a
    grant for the class that matches this call's session, lineage and project (``matching_grant``) — so a granted
    class never wins over one that still asks, and a grant scoped elsewhere never lowers the decision (r7b m-g)."""
    table = policy.get("table")
    if isinstance(table, Mapping) and table:
        rows = [row if isinstance(row, Mapping) else MANUAL_TABLE_ROW for row in table.values()]
        key = cand.ceiling_key or (policy.get("ceilingKey") or {}).get(cand.cls)
        ceiling = ((policy.get("ceilings") or {}).get(key) or "undecided") if key else None
        granted = cand.cls != "$" and matching_grant(
            policy, cand.cls, scope.session_id, cand.project, list(scope.lineage)) is not None
    else:
        rows, ceiling, granted = [MANUAL_TABLE_ROW], None, False
    total = 0
    for row in rows:
        outcome, _rule = decide_cell(str(row.get(cand.cls, "Q")), cand.facts, cls=cand.cls, floor=None,
                                     ceiling=ceiling, granted=granted)
        total += _OUTCOME_SEVERITY.get(outcome, _OUTCOME_SEVERITY["refuse"])
    return total, _rank(cand.cls)


def _strictest(cands: Sequence["Classified"], policy: Mapping[str, Any],
               scope: Scope = _NO_SCOPE) -> "Classified":
    """The candidate the policy decides most strictly (a ceiling set to OFF refuses in every mode, so it wins);
    ties go to the precedence order. When one candidate is at least as strict as every other in every mode, it is
    the one returned (its sum is the largest)."""
    return max(cands, key=lambda cand: _class_severity(cand, policy, scope))


def _fact_proxied(v: View) -> bool:
    return bool(_IT_PROXY.search(v.full)) or any(
        cmd.prog.rsplit("/", 1)[-1] == "it" and cmd.args[:1] and cmd.args[0].lower() in _IT_PROXY_VERBS
        for cmd in v.commands)


_WRITE_PROGS = frozenset({"cp", "mv", "ln", "tee", "install", "rsync", "dd", "touch", "truncate", "sponge", "sed", "perl"})


def _fact_expansion_write(v: View) -> bool:
    """m1: an expansion where a write lands. Shell expansions exist only in the ORIGINAL text — there the lexical
    rule reads them (a backslash-escaped dollar is a literal file name). The normaliser has already resolved what it could:
    in its reading the same fact is a write command whose argument still carries an unreadable substitution."""
    if v.name == "raw":
        return bool(_EXPANSION_WRITE.search(v.full))
    def writes(cmd: SimpleCommand) -> bool:
        prog = cmd.prog.rsplit("/", 1)[-1].lower()
        if prog in ("sed", "perl"):
            return any(re.match(r"^-\w*i", a) for a in cmd.args)
        return prog in _WRITE_PROGS

    return any(writes(cmd) and any("$(…)" in a for a in cmd.args) for cmd in v.commands)


def _fact_dangerous(v: View) -> bool:
    return (_fact_proxied(v) or _dangerous(v.full) or _fact_expansion_write(v)
            or _has_kill_family(v.commands) or v.unresolvable or v.unknown)


def _fact_privileged(v: View) -> bool:
    return bool(_PRIVILEGED.search(v.full))


# The X facts (dangerous ⇒ Automatic asks; privileged). Each is evaluated on BOTH readings.
FACT_RULES: Tuple[Tuple[str, Any], ...] = (("dangerous", _fact_dangerous), ("privileged", _fact_privileged))


def command_floor(command: str, cwd: Optional[str], policy: Mapping[str, Any],
                  norm: Optional[NormalizedCommand] = None,
                  readings: Optional[Tuple[View, View]] = None) -> Optional[str]:
    """The never-acceptable rules for any text that will run as a shell or as code (floors 1, 2, 4, 6, 7, 8), each
    evaluated on the original AND the normalised reading (``views``) — the first floor either reading hits."""
    readings = readings if readings is not None else views(command, norm)
    ctx = _Ctx(cwd, policy, tuple(guard_paths(policy)),
               tuple(str(p) for p in policy.get("secretPaths") or [] if isinstance(p, str)),
               tuple(_guard_pids(policy)))
    for _name, rule in FLOOR_RULES:
        for view in readings:
            floor = rule(view, ctx)
            if floor:
                return floor
    return None


# The shell-outs an `execute_code` body (or an interpreter's -c/-e/stdin code) can carry: a string literal handed to
# a process-spawning call, a backtick substitution, or an ARGV LIST (`["privy", "wallets", …]`, `("kill", "4242")`,
# `spawn("privy", ["wallets", …])`) — the list is joined into the one command it runs (r6 M2), and its elements are
# never read as commands one by one (an argv element is an argument, not a command line).
_CODE_STRING = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"|\'([^\'\\]*(?:\\.[^\'\\]*)*)\'|`([^`]*)`', re.S)
_LIT = r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\''
_ARGV_SEQ = re.compile(r"(?:%s)(?:\s*,\s*[\[(]?\s*(?:%s))+" % (_LIT, _LIT))
_SHELLOUT_SITE = re.compile(
    r"os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|os\.posix_spawn\w*|pty\.spawn|subprocess\.\w+|commands\.getoutput"
    r"|asyncio\.create_subprocess_\w+|child_process|\.exec(Sync|File|FileSync)?\s*\(|spawn(Sync)?\s*\(|execa"
    r"|shell_exec|popen|Deno\.(run|Command)|Bun\.spawn|IO\.popen|Kernel\.(system|exec|spawn)|\bsystem\s*\(",
    re.I,
)
_CODE_DEPTH_MAX = 3


def _code_unescape(text: str) -> str:
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), text)


def _argv_lists(code: str) -> List[Tuple[List[str], Tuple[int, int]]]:
    """Every run of ≥2 comma-separated string literals in ``code``, as (argv, span)."""
    out: List[Tuple[List[str], Tuple[int, int]]] = []
    for match in _ARGV_SEQ.finditer(code):
        argv = [_code_unescape(next(g for g in lit.groups() if g is not None))
                for lit in _CODE_STRING.finditer(match.group(0))]
        if len(argv) >= 2:
            out.append((argv, match.span()))
    return out


def _classify_code(code: str, cwd: Optional[str], project: Optional[str], policy: Mapping[str, Any],
                   _depth: int = 0, scope: Scope = _NO_SCOPE) -> Classified:
    """Code (``execute_code``, an interpreter's -c/-e/stdin) → the highest class it reaches: the code itself (its
    floor, and any verb either reading surfaces) joined with every shell-out it carries — each argv list as ONE
    command, each other string literal as a command line. Returns the winning class with its ceiling, and a floor
    that is the union of the code's and the shell-outs'."""
    whole = classify_command(code, cwd, project, policy, _depth=_depth + 1, scope=scope)
    floor = whole.floor
    shellouts: List[Classified] = []
    spans: List[Tuple[int, int]] = []
    for argv, span in _argv_lists(code):
        spans.append(span)
        cand = classify_command(shlex.join(argv), cwd, project, policy, _depth=_depth + 1, scope=scope)
        shellouts.append(cand)
        floor = floor or cand.floor
    has_site = bool(_SHELLOUT_SITE.search(code))
    for match in _CODE_STRING.finditer(code):
        if any(a <= match.start() < b for a, b in spans):
            continue
        literal = _code_unescape(next((g for g in match.groups() if g is not None), ""))
        if not literal.strip():
            continue
        # a bare word is not a shell-out unless the code clearly spawns one; this keeps ordinary string data
        # from being re-read as a command.
        if not has_site and " " not in literal and "/" not in literal:
            continue
        cand = classify_command(literal, cwd, project, policy, _depth=_depth + 1, scope=scope)
        shellouts.append(cand)
        floor = floor or cand.floor
    unknown = whole.unknown or any(c.unknown for c in shellouts)
    cands = [c for c in [whole, *shellouts] if c.cls != "X"]
    if not cands:
        return Classified("X", "terminal", code[:2000], project, {"dangerous": True}, floor, unknown)
    # r7 C: the class the policy decides most strictly among every class the code shows (not the highest rank).
    top = _strictest(cands, policy, scope).cls
    # the shell-outs that reach the top class say what it is (`subprocess.run('rm -rf build')` is a project delete);
    # the code read as a whole speaks only when no shell-out does. Facts are joined strictly across them.
    sources = [c for c in shellouts if c.cls == top] or [whole]
    facts: Dict[str, bool] = dict(sources[0].facts)
    if top == "D":
        facts["inProject"] = all(c.facts.get("inProject") for c in sources)
    if top == "I":
        facts["privileged"] = any(c.facts.get("privileged") for c in sources)
    return Classified(top, sources[0].ceiling_key, code[:2000], project, facts, floor, unknown)


def _has_kill_family(commands: Sequence[SimpleCommand]) -> bool:
    """A `pkill`/`killall`/`fuser` sweep that did not reach the gate is still never the `A:safe` X that Automatic
    allows unattended — it acts on processes broadly (r5 T-M1b)."""
    return any(cmd.prog.rsplit("/", 1)[-1].lower() in _KILL_FAMILY for cmd in commands)


def _class_lines(commands: Sequence[SimpleCommand]) -> List[str]:
    """Each simple command the text runs as ``<program basename> <argv>`` (and once more behind the runner that
    exposed it, `pnpm add …`, `uv pip install …`): the program word path-stripped, so the class rules read
    `/opt/homebrew/bin/brew install`, `"o"sascript` or `v=rm; $v` as what they run (r5 T-N)."""
    lines: List[str] = []
    for cmd in commands:
        prog = cmd.prog.rsplit("/", 1)[-1]
        if not prog:
            continue
        line = " ".join([prog, *cmd.args])
        lines.append(line)
        if cmd.runner:
            lines.append(cmd.runner + " " + line)
    return lines


def _delete_commands(commands: Sequence[SimpleCommand]) -> List[SimpleCommand]:
    return [cmd for cmd in commands if cmd.prog.rsplit("/", 1)[-1].lower() in _DELETE_PROGS]


def _deletes_in_project(command: str, readings: Sequence[View], cwd: Optional[str], project: Optional[str]) -> bool:
    """``inProject`` for a delete: every raw path word AND every target of every delete either reading sees is
    inside the project. A target the classifier cannot read — an unresolved `$VAR`, a `$(…)`, a backtick — may be
    anywhere, so it is never in the project (r5: `rm -rf $HOME/x` is not a project delete)."""
    if not project:
        return False
    deletes = [cmd for view in readings for cmd in _delete_commands(view.commands)]
    if not deletes:
        # the delete was seen only as text (inside a proxy's payload, a quoted string): its target is unknown
        return False
    paths = _command_paths(command, cwd)[1:]
    targets = [arg for cmd in deletes for arg in cmd.args if arg and not arg.startswith("-")]
    if any(_EXPANSION.search(t) or "$(…)" in t for t in targets):
        return False
    paths += [_resolve(t, cwd) for t in targets]
    return bool(paths) and all(_within(path, project) for path in paths)


# r7b m-d2: the class of a line whose code is nested past a depth cap (the normaliser's or the code classifier's).
# `$` is the one class that asks in Manual, Automatic, acceptEdits AND Ignore (Plan refuses it), on the plugin and in
# main alike, and that no grant ever lifts. Its ceiling is the spend switch: OFF refuses, which is stricter still.
_OVERFLOW_CLASS = ("$", "spendTrade")


def _code_bodies(norm: NormalizedCommand) -> List[str]:
    return list(dict.fromkeys(body for cmd in norm.commands for body in cmd.code if body.strip()))


def classify_command(command: str, cwd: Optional[str], project: Optional[str], policy: Mapping[str, Any],
                     norm: Optional[NormalizedCommand] = None, _depth: int = 0,
                     scope: Scope = _NO_SCOPE) -> Classified:
    """A shell command: the floor first, then the most specific class it shows. Every floor, class and fact rule is
    evaluated on BOTH readings (``views``) and the stricter wins (r6). An interpreter's code (`python3 -c`, `node -e`,
    a heredoc or a pipe into `python3 -`) is classified as code and lifts the class (r6 M2). A pane proxy (`it
    exec|run|send|spawn`) is max(X, the class of what it carries) — never lower (r5 T-M3)."""
    norm = norm if norm is not None else normalize(command)
    # The code bodies are read FIRST: an unknown inside one (or code nested past the cap, r6 m-d) poisons this line.
    code_calls: List[Classified] = []
    overflow = False
    bodies = _code_bodies(norm)
    if bodies:
        if _depth < _CODE_DEPTH_MAX:
            code_calls = [_classify_code(body, cwd, project, policy, _depth, scope) for body in bodies]
        else:
            overflow = True
    unknown = line_has_unknown(norm, overflow or any(c.unknown for c in code_calls))
    readings = views(command, norm, unknown)
    target = command
    floor = command_floor(command, cwd, policy, norm, readings)
    facts_x = {name: any(rule(view) for view in readings) for name, rule in FACT_RULES}
    # r7 C: EVERY class the line shows is a candidate (with its own facts), and so is every class a code body shows;
    # the one the policy decides most strictly is the class (``_strictest``), never one picked by rank.
    cands: List[Classified] = []
    for rule_cls, key, rule in CLASS_RULES:
        if any(rule(view) for view in readings):
            if rule_cls == "I":
                facts: Dict[str, bool] = {"privileged": facts_x["privileged"]}
            elif rule_cls == "D":
                facts = {"inProject": _deletes_in_project(command, readings, cwd, project)}
            else:
                facts = {}
            cands.append(Classified(rule_cls, key, target, project, facts))
    for code_call in code_calls:
        floor = floor or code_call.floor
        if code_call.cls != "X":
            cands.append(Classified(code_call.cls, code_call.ceiling_key, target, project, dict(code_call.facts)))
    if overflow or norm.overflow:
        # r7b m-d2 (lead ruling): code nested past a depth cap was not read, so it ASKS in every mode, Ignore
        # included — never the plain X that Ignore allows. The floors above still apply on top.
        cands.append(Classified(*_OVERFLOW_CLASS, target, project, {}))
    if cands:
        top = _strictest(cands, policy, scope)
        return Classified(top.cls, top.ceiling_key, target, project, dict(top.facts), floor, unknown)
    return Classified("X", "terminal", target, project, facts_x, floor, unknown)


# ---- patch (V4A multi-file) ---------------------------------------------------------------------------------------

_V4A_HEADER = re.compile(r"^\*\*\*\s*(Update|Add|Delete|Move)\s+(File|to)\s*:\s*(.+?)\s*$", re.MULTILINE)


def patch_targets(patch: str) -> Tuple[Optional[List[Tuple[str, str]]], Optional[str]]:
    """``[(op, path)]`` for every file a V4A patch touches, read with Hermes' own parser AND a header scan (union),
    or ``(None, why)`` when it cannot be read — an unreadable patch is refused, never guessed (F-3)."""
    if not isinstance(patch, str) or not patch.strip():
        return None, "empty patch"
    targets: List[Tuple[str, str]] = []
    try:
        from tools.patch_parser import parse_v4a_patch

        operations, error = parse_v4a_patch(patch)
    except Exception as exc:  # noqa: BLE001
        return None, f"unreadable patch ({type(exc).__name__})"
    if error:
        return None, f"unreadable patch ({error})"
    for op in operations:
        kind = getattr(getattr(op, "operation", None), "value", "update")
        targets.append((kind, str(op.file_path)))
        if getattr(op, "new_path", None):
            targets.append(("add", str(op.new_path)))
    for match in _V4A_HEADER.finditer(patch):
        raw = match.group(3)
        if match.group(1) == "Move" and "->" in raw:
            old_path, new_path = (part.strip() for part in raw.split("->", 1))
            targets += [("delete", old_path), ("add", new_path)]
        else:
            targets.append(("delete" if match.group(1) == "Delete" else "update", raw))
    if not targets:
        return None, "the patch names no file"
    return targets, None


def _classify_writes(paths: List[Tuple[str, Optional[str]]], project: Optional[str], ceiling: Optional[str],
                     policy: Mapping[str, Any]) -> Classified:
    """One class for a set of writes/deletes: D if anything is deleted, else Wo if anything lands outside, else Wp.
    ``inProject`` holds only when every target is inside; any guarded target is the floor for the whole call."""
    in_project = bool(project) and all(_within(path, project) for _, path in paths)
    deletes = any(op == "delete" for op, _ in paths)
    cls = "D" if deletes else ("Wp" if in_project else "Wo")
    target = ", ".join(path or "(a path that does not resolve)" for _, path in paths)
    floor = None
    if any(_guarded(path, guard_paths(policy)) for _, path in paths):
        floor = "policy: writing the permission policy or its guards"
    return Classified(cls, ceiling, target, project, {"inProject": in_project}, floor)


# ---- process input (write / submit to a running shell) -------------------------------------------------------------

_process_input: Dict[str, str] = {}
_process_lock = threading.Lock()


def _pending_input(session: str) -> str:
    with _process_lock:
        return _process_input.get(session, "")


def commit_process_input(args: Mapping[str, Any]) -> None:
    """After an ALLOWED ``process write``: remember the partial line, so a command typed in pieces is judged whole."""
    action = str(args.get("action") or "")
    session = str(args.get("session_id") or "")
    if action not in ("write", "submit") or not session:
        return
    with _process_lock:
        if action == "submit" or "\n" in str(args.get("data") or ""):
            _process_input.pop(session, None)
        else:
            _process_input[session] = (_process_input.get(session, "") + str(args.get("data") or ""))[-_PROCESS_INPUT_MAX:]


# ---- the classifier --------------------------------------------------------------------------------------------------

def _classify_one(tool_name: str, args: Mapping[str, Any], cwd: Optional[str], policy: Mapping[str, Any], *,
                  session_id: Optional[str] = None, lineage: Optional[Sequence[str]] = None) -> Classified:
    """One tool call by its own name (``classify`` adds the wrapper and the path arguments around it)."""
    project = project_root(cwd)
    scope = Scope(session_id or None, tuple(s for s in lineage or () if isinstance(s, str) and s))
    args = args if isinstance(args, Mapping) else {}

    if tool_name == "terminal":
        command = str(args.get("command") or args.get("cmd") or "")
        if command:
            # V3-UP r3: ``workdir`` is where the command runs, so its relative paths resolve THERE (the project the
            # call is judged against stays the session's own).
            return classify_command(command, _workdir(args, cwd), project, policy, scope=scope)

    if tool_name in PROCESS_TOOLS:
        action = str(args.get("action") or "")
        if action in _PROCESS_READS:
            return Classified("R", None, f"process {action} {args.get('session_id') or ''}".strip(), project)
        if action in ("write", "submit"):
            session = str(args.get("session_id") or "")
            typed = _pending_input(session) + str(args.get("data") or "")
            shell = classify_command(typed or "(empty input)", cwd, project, policy, scope=scope)
            # Input to a running shell is a shell command: NEVER a lower class than the command typed (r5 T-M3).
            # The result is max(typed class, X) — a read lifts up to X, but a `$`/`M`/`S`/`I`/`D` command keeps
            # its own (higher) class so a spend or an automation stop typed into a live shell is not quietly
            # allowed in Ignore. The old branch forced X and lowered `$`/`S` to the Automatic-safe X.
            target = f"process {action} → {typed}"[:4000]
            if shell.cls == "X":
                facts = {"dangerous": shell.facts.get("dangerous", True),
                         "privileged": bool(_PRIVILEGED.search(typed))}
                return Classified("X", "terminal", target, project, facts, shell.floor)
            return Classified(shell.cls, shell.ceiling_key, target, project, dict(shell.facts), shell.floor)
        target = f"process {action or '(no action)'} {args.get('session_id') or ''}".strip()
        return Classified("X", "terminal", target, project, {"dangerous": action not in ("kill", "close")}, None)

    entry = TOOL_CLASSES.get(tool_name, UNKNOWN_TOOL_CLASS)
    cls, ceiling = str(entry[0]), entry[1]
    target = ""
    facts: Dict[str, bool] = {}
    floor = None

    if tool_name == "patch" and (str(args.get("mode") or "replace") == "patch" or args.get("patch")):
        targets, why = patch_targets(str(args.get("patch") or ""))
        if targets is None:
            return Classified("Wo", ceiling, f"patch: {why}", project, {"inProject": False},
                              f"unreadable: {why}; a patch is applied only when every file it touches is known")
        explicit = [("update", str(args["path"]))] if args.get("path") else []
        return _classify_writes([(op, _resolve(raw, cwd)) for op, raw in explicit + targets], project, ceiling, policy)

    if tool_name in PATH_WRITERS:
        raw = str(args.get(PATH_WRITERS[tool_name]) or "")
        if not raw:
            return Classified("Wo", ceiling, "(no file named)", project, {"inProject": False},
                              "unreadable: a write that names no file is refused")
        return _classify_writes([("update", _resolve(raw, cwd))], project, ceiling, policy)

    if tool_name in PATH_READERS:
        raw = str(args.get(PATH_READERS[tool_name]) or "")
        path = _resolve(raw, cwd) if raw else ""
        target = path if path is not None else f"{raw} (does not resolve)"
        if raw and any(_matches_secret(path, p) for p in policy.get("secretPaths") or []):
            floor = "secrets: reading a key, token or keychain item"
    elif tool_name in CODE_TOOLS:
        code = str(args.get("code") or "")
        shell = _classify_code(code, cwd, project, policy, scope=scope)
        # The code runs as code AND runs the shell-outs it contains; its class is max(X, those shell-outs') so a
        # spend or an automation stop embedded in `os.system`/`subprocess`/`child_process`/backticks is not the
        # plain X that Ignore allows (r5 T-M3). The floor (kill/iNFT in code) is kept either way.
        if shell.cls != "X":
            return Classified(shell.cls, shell.ceiling_key, code[:2000], project, dict(shell.facts), shell.floor)
        cls, ceiling = str(entry[0]), entry[1]
        target = code[:2000]
        facts = {"dangerous": True}
        floor = shell.floor
    elif cls == "N":
        target = str(args.get("url") or args.get("query") or args.get("ref") or "")
        facts["getOnly"] = tool_name in GET_ONLY_TOOLS
    else:
        for key in ("command", "url", "path", "action", "name", "query", "target"):
            if args.get(key):
                target = str(args.get(key))
                break

    if tool_name not in TOOL_CLASSES:
        target = f"{tool_name} (unclassified tool — the strictest class)"
        facts = {"dangerous": True}

    if floor is None and cls != "R":
        try:
            floor = _inft_floor(json.dumps(args, default=str), policy)
        except (TypeError, ValueError):
            floor = "unreadable: the call's arguments cannot be read"

    return Classified(cls, ceiling, target[:4000], project, facts, floor)


def classify(tool_name: str, args: Mapping[str, Any], cwd: Optional[str], policy: Mapping[str, Any], *,
             session_id: Optional[str] = None, lineage: Optional[Sequence[str]] = None, _depth: int = 0) -> Classified:
    """The single classifier: tool + arguments → class, target, facts, floor. ``session_id``/``lineage`` are the
    call's own (the hook passes them): when a line shows several classes, the one picked is decided against the
    grants that match this call, as ``policy.decide`` will read them (r7b m-g). A bridge wrapper is the class of
    what it wraps (``BRIDGE_WRAPPERS``); every argument that names a local path carries its floor (``PATH_ARGS``)."""
    args = args if isinstance(args, Mapping) else {}
    if tool_name in BRIDGE_WRAPPERS:
        return _classify_wrapper(args, cwd, policy, session_id=session_id, lineage=lineage, depth=_depth)
    base = _classify_one(tool_name, args, cwd, policy, session_id=session_id, lineage=lineage)
    if tool_name not in PATH_ARGS:
        return base
    scope = Scope(session_id or None, tuple(s for s in lineage or () if isinstance(s, str) and s))
    return _with_path_args(tool_name, args, cwd, policy, base, scope)


def _classify_wrapper(args: Mapping[str, Any], cwd: Optional[str], policy: Mapping[str, Any], *,
                      session_id: Optional[str], lineage: Optional[Sequence[str]], depth: int) -> Classified:
    """``tool_call``: every entry it carries is classified by its own name and arguments; the strictest wins and any
    entry's floor is the call's. Unreadable (no entries, a parse error, wrappers nested past the cap) ⇒ unknown."""
    project = project_root(cwd)
    entries: Optional[list] = None
    try:
        from tools.tool_search_validation import normalize_tool_call_entries

        parsed, error = normalize_tool_call_entries(dict(args))
        entries = None if error else list(parsed)
    except Exception:  # noqa: BLE001 — a runtime without the bridge cannot read it: the strictest class
        entries = None
    if not entries or depth >= _WRAPPER_DEPTH_MAX:
        return Classified(*UNKNOWN_TOOL_CLASS, "tool_call (unreadable — the strictest class)", project,
                          {"dangerous": True})
    cands: List[Classified] = []
    for entry in entries:
        name = str(entry.get("name") or "") if isinstance(entry, Mapping) else ""
        inner = entry.get("arguments") if isinstance(entry, Mapping) else None
        cands.append(classify(name, inner if isinstance(inner, Mapping) else {}, cwd, policy, session_id=session_id,
                              lineage=lineage, _depth=depth + 1))
    scope = Scope(session_id or None, tuple(s for s in lineage or () if isinstance(s, str) and s))
    top = _strictest(cands, policy, scope)
    floor = next((c.floor for c in cands if c.floor), None)
    names = ", ".join(str(e.get("name") or "?") for e in entries if isinstance(e, Mapping))
    target = f"tool_call → {names}: {top.target}"
    return Classified(top.cls, top.ceiling_key, target[:4000], project, dict(top.facts), floor,
                      any(c.unknown for c in cands))


def _workdir(args: Mapping[str, Any], cwd: Optional[str]) -> Optional[str]:
    """The directory a terminal command runs in: its ``workdir`` (relative to the session's cwd), else the cwd."""
    raw = args.get("workdir")
    if not isinstance(raw, str) or not raw.strip():
        return cwd
    resolved = _resolve(raw.strip(), cwd)
    return resolved if resolved is not None else raw


def _arg_values(args: Mapping[str, Any], spec: str) -> List[str]:
    """The string values at ``spec`` (``a``, ``a.b``, ``a[]``, ``a[].b``): every element of a list, a single value
    where a list is expected (the runtime coerces it), nothing that is not a non-empty string."""
    values: List[Any] = [args]
    for part in spec.split("."):
        many = part.endswith("[]")
        key = part[:-2] if many else part
        found: List[Any] = []
        for value in values:
            if not isinstance(value, Mapping) or key not in value:
                continue
            item = value[key]
            if many and isinstance(item, (list, tuple)):
                found.extend(item)
            elif item is not None:
                found.append(item)
        values = found
    return [v for v in values if isinstance(v, str) and v.strip()]


_URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


# V3-UP r5 (ruling 56): schemes that only wrap another URL (the inner one is what is read) …
_WRAPPER_SCHEMES = ("view-source:", "filesystem:", "blob:")
# … and a browser's own pages, which can list or show local state with no path to judge: a local resource.
_LOCAL_RESOURCE_SCHEMES = ("chrome:", "chrome-untrusted:", "chrome-search:", "chrome-extension:", "devtools:",
                           "about:", "edge:", "brave:", "opera:", "vivaldi:")
LOCAL_RESOURCE = "\0local-resource"


def _unwrap_url(text: str) -> str:
    """``view-source:filesystem:FILE:///x`` → ``FILE:///x``: every wrapper scheme stripped, case-insensitively."""
    while True:
        lowered = text.lower()
        prefix = next((p for p in _WRAPPER_SCHEMES if lowered.startswith(p)), None)
        if prefix is None:
            return text
        text = text[len(prefix):].strip()


def _local_path(value: str) -> Optional[str]:
    """The local path a value names: a ``file:`` URL's path (inside any wrapper scheme), a plain path,
    ``LOCAL_RESOURCE`` for a browser's own page (anything but ``about:blank``); ``None`` for a remote URL scheme
    (``http(s):``, ``data:``, ``viking://``, …) — those are not files on this machine."""
    text = _unwrap_url(value.strip())
    lowered = text.lower()
    if lowered.startswith(_LOCAL_RESOURCE_SCHEMES) and lowered != "about:blank":
        return LOCAL_RESOURCE
    if lowered.startswith("file:"):
        from urllib.parse import unquote, urlparse

        return unquote(urlparse(text).path) or None
    if _URL_SCHEME.match(text) and not re.match(r"^[A-Za-z]:[\\/]", text):
        return None
    return text


def _with_path_args(tool_name: str, args: Mapping[str, Any], cwd: Optional[str], policy: Mapping[str, Any],
                    base: Classified, scope: Scope) -> Classified:
    """``PATH_ARGS``: a read (or a directory a later session runs in) inside a secret path is the secrets floor; a
    write is classified as the write it is (Wp/Wo, the guard floor) and the stricter of it and the tool's own class
    is the call's."""
    floor = base.floor
    cands = [base]
    targets: List[str] = []
    for spec, kind in PATH_ARGS[tool_name]:
        for value in _arg_values(args, spec):
            raw = _local_path(value)
            if raw is None:
                continue
            if raw == LOCAL_RESOURCE:  # a page that can show local state with no path to judge: fail closed
                targets.append(f"{value} (a local resource)")
                floor = floor or "secrets: a local resource the browser would show"
                continue
            path = _resolve(raw, cwd)
            targets.append(path if path is not None else f"{raw} (does not resolve)")
            if kind == "write":
                written = _classify_writes([("update", path)], base.project, "fileWriting", policy)
                cands.append(Classified(written.cls, written.ceiling_key, written.target, base.project,
                                        dict(written.facts)))
                floor = floor or written.floor
            elif floor is None and any(_matches_secret(path, p) for p in policy.get("secretPaths") or []):
                floor = "secrets: reading a key, token or keychain item"
    if len(cands) == 1 and floor == base.floor:
        return base
    top = _strictest(cands, policy, scope)
    target = base.target if top is base else f"{base.target} → {top.target}".strip(" →")
    if not target and targets:
        target = ", ".join(targets)
    return Classified(top.cls, top.ceiling_key, target[:4000], base.project, dict(top.facts), floor, base.unknown)
