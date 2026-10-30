"""V3-F2 — which of the user's functions a tool call touches (contract V3F2 §4). Pure, and separate from the classifier.

``functions_of(tool_name, args, classified, ...)`` returns the call's CANDIDATE functions (a ``Functions`` tuple).
``policy.decide`` lets each candidate decide with the level the user set for it and keeps the strictest, so a
candidate added here can only keep or tighten a decision, never loosen one.

Round 3 (R3-MONO) — the decision is MONOTONE IN PARTS: for any lines A and B, decide(A ; B) >= max(decide(A),
decide(B)) in every mode and every level setting. Two things make it hold by construction:

- the function set of a text line is the UNION over its parts — every contiguous run of its top-level segments, each
  read as a line of its own (its words, its own class) — closed over the families (``cover``: any money row ⇒ all
  four money rows, any message row ⇒ both message rows). The family never comes from the line's single class alone.
- each part also carries its own class, facts, floor and switch (``Part``): a row at a user level decides on the
  whole line AND on every part it touches, the strictest wins (``policy.decide``), so a part whose own class asks can
  never be lowered by the class another part gives the whole line.

Round 4 (R4-UNREAD) — what is not fully read fails closed. The call is UNREAD (``Functions.unread``): it is every
function, and ``policy.decide`` lets no row at a user level allow it — no grant lifts it, the row asks (Manual still
refuses; a floor and an OFF switch still refuse first). Unread never comes from the line's class. A read call always
carries its whole line as part 0, so an empty list on the wire is never a reading (main reads it as unread).

Round 5 (R5-K) — the work is COUNTED before any part is read, never timed: the segments of the line plus the segments
of every shell-out its code carries (``_Work``). Past ``_K_SEG`` of them, or past ``_PARTS_MAX`` parts (main's own
cap), or code nested deeper than the classifier reads it, nothing is read and the call is unread. The decision is a
pure function of the call, the signed body and the grants: no clock, no load, no partial reading.

Round 5 (R5-G) — a call is FULLY READ only when the WHOLE of it is in a closed grammar (``_grammar_line``), checked
before any part is read: segments joined by the six operators, each made of plain assignments, a literal program
word, plain arguments and plain file redirections; a closed table of wrappers that only run their argv; a shell,
``source`` or interpreter only on a script FILE, or an interpreter whose code body is read here (its shell-outs in
the same grammar). The grammar is a recogniser of that plain shape, never a list of forms to refuse: whatever it does
not accept is UNREAD. The parts of an unread call are still read when the counted work allows (R5-D keeps every one
of them as a term), and main is told by the ``unread`` flag beside the part list.

This module never changes the classifier's verdict (``cls``, ``facts``, ``floor``) and holds no regex of its own: it
reads the class, the ``unknown`` flag, the normaliser's PUBLIC ``normalize()`` output against the token tables below,
and — through the seam, like ``classify._money_prog`` — the normaliser's own top-level split and the classifier's
own reading of interpreter code (R3-C27: a shell-out inside code is read through the same tables). Anything it
cannot attribute is Shell; a tool it does not know (any ``mcp_*``, any future tool) and an exception get all nine.
"""

from __future__ import annotations

import shlex
from typing import Any, Dict, Iterable, List, Mapping, NamedTuple, Optional, Sequence, Set, Tuple

from .policy import FUNCTIONS, level_of

MONEY = ("payments", "trading", "shopping", "acp")
MESSAGES = ("email", "messaging")

# Structured tools (no shell text), by name. A tool in none of the tables below — a dynamically registered `mcp_*`
# tool, a tool added after this version — is EVERY function (§4.2, R2-M1): it may pay, trade, message, write or
# publish, so the strictest row decides (at the shipped defaults every row is `mode`, i.e. exactly V3-F).
# tests/plugins/test_iclone_permissions_functions.py holds every classify.TOOL_CLASSES name to exactly one table.
_MESSAGING_TOOLS = frozenset({
    "a2a_call", "a2a_orchestrate", "discord", "discord_admin", "react_to_message", "feishu_drive_add_comment",
    "feishu_drive_reply_comment", "yb_send_dm", "yb_send_sticker", "message_agent", "meet_join", "meet_say",
})
_FILE_TOOLS = frozenset({
    "write_file", "patch", "desktop_project", "memory", "skill_manage", "kanban_attach", "kanban_attach_url",
    "kanban_block", "kanban_comment", "kanban_complete", "kanban_create", "kanban_heartbeat", "kanban_link",
    "kanban_request_changes", "kanban_request_review", "kanban_schedule", "kanban_unblock", "browser_vault_save_login",
    # the bundled memory providers' writers (V3-UP r3): they store, change or forget a memory, like ``memory``
    "brv_curate", "fact_store", "fact_feedback", "retaindb_remember", "retaindb_forget", "retaindb_ingest_file",
    "retaindb_delete_file", "retaindb_upload_file", "viking_remember", "viking_forget", "viking_add_resource",
})
# Browser actions that can submit what the page holds (a form, a post): the Network publish row. A vault fill can put
# a card into a checkout: its class (`$`) adds every money row on top (``cover``).
_PUBLISH_TOOLS = frozenset({
    "browser_click", "browser_type", "browser_press", "browser_dialog", "browser_cdp", "browser_exec", "browser_console",
    "browser_vault_fill", "browser_vault_enter_code",
})
# Tools that run text as a command or code: Shell, plus what the text itself attributes (terminal) — see below.
# 1ac3f97 renamed process/cronjob before the permission hook; both names stay (the runtime still accepts the old ones).
_SHELL_TOOLS = frozenset({"terminal", "process_manage", "process", "execute_code", "cronjob_manage", "cronjob"})
_PROCESS_TOOLS = frozenset({"process_manage", "process"})
# Tools no row governs in this version: they stay with the global mode (reads, GETs, provider calls, the screen,
# installs through manage_connections/manage_catalog/setup_mcp, the app's own panes, delegation — the sub-agent's
# calls pass the gate themselves).
_NO_FUNCTION = frozenset({
    "a2a_discover", "a2a_history", "a2a_list", "annotate_preview", "apply_layout", "close_terminal", "desktop_preview",
    "drive_preview", "focus_pane", "gui_tour", "show_tip", "tour", "tip", "clarify", "todo_list", "todo", "browser_back",
    "browser_navigate", "browser_snapshot", "browser_get_images", "browser_vision", "browser_scroll", "browser_vault_list",
    "browser_vault_unlock", "computer_use", "read_window_below", "read_terminal", "delegate_task", "feishu_doc_read",
    "feishu_drive_list_comments", "feishu_drive_list_comment_replies", "web_search", "web_extract", "x_search",
    "yb_query_group_info", "yb_query_group_members", "yb_search_sticker", "image_generate", "video_generate",
    "video_analyze", "vision_analyze", "text_to_speech", "xai_video_edit", "xai_video_extend", "spotify_albums",
    "spotify_devices", "spotify_library", "spotify_playlists", "spotify_search", "spotify_playback", "spotify_queue",
    "read_file", "search_files", "session_search", "skill_view", "skills_list", "kanban_list", "kanban_show",
    "kanban_attachments", "manage_connections", "manage_catalog", "setup_mcp", "meet_leave", "meet_status",
    "meet_transcript",
})
# V3-UP r3: the Tool Search lookups and the bundled memory providers' queries — no row governs them either (reads of
# the session's own catalog; provider calls). A list of their own so the shipped V3-F2 fixture (functions.json) stays
# as it was; main's mirror is functions.ts ``NO_FUNCTION_PROVIDER_READS`` and tests/fixtures/
# functions_provider_reads.json holds the two equal.
_NO_FUNCTION_PROVIDER_READS = frozenset({
    "tool_search", "tool_describe", "brv_query", "brv_status", "retaindb_profile", "retaindb_search", "retaindb_context",
    "retaindb_list_files", "retaindb_read_file", "viking_search", "viking_read", "viking_browse",
})
_PROCESS_READS = frozenset({"list", "poll", "log", "wait"})

# Shell programs → function, by program word and its first sub-words (the normaliser has already folded install
# paths, runners and wrappers to the bare program word).
_FILE_PROGS = frozenset({"rm", "rmdir", "unlink", "trash", "cp", "mv", "mkdir", "touch", "ln"})
_PUBLISH_SUBCMDS = {
    "git": frozenset({"push"}),
    "npm": frozenset({"publish"}), "pnpm": frozenset({"publish"}), "yarn": frozenset({"publish", "npm"}),
    "bun": frozenset({"publish"}), "cargo": frozenset({"publish"}), "twine": frozenset({"upload"}),
    "docker": frozenset({"push"}), "podman": frozenset({"push"}),
    "gh": frozenset({"release", "pr", "issue", "gist", "repo", "api"}),
    "netlify": frozenset({"deploy"}),
}
_PUBLISH_PROGS = frozenset({"vercel", "scp", "sftp", "rsync"})
_UPLOAD_FLAGS = frozenset({"-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form",
                           "-T", "--upload-file", "--post-data", "--post-file", "--body-data", "--body-file"})
_UPLOAD_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_ONCHAINOS_TRADING = frozenset({"swap", "bridge", "cross-chain", "strategy", "defi", "limit-order"})
_ACP_JOB_VERBS = frozenset({"client", "provider", "job", "jobs", "offering", "offerings", "resource", "resources",
                            "market", "work"})
_ACP_PAYMENT_VERBS = frozenset({"wallet", "compute", "pay", "x402", "mandate", "mandates", "payments"})


def _positionals(args: Sequence[str]) -> List[str]:
    """The non-option words, lower-cased, with acp's `--inft <slug>` pair removed."""
    out: List[str] = []
    skip = False
    for arg in args:
        low = arg.lower()
        if skip:
            skip = False
            continue
        if low == "--inft":
            skip = True
            continue
        if not low.startswith("-"):
            out.append(low)
    return out


def _uploads(args: Sequence[str]) -> bool:
    for i, arg in enumerate(args):
        head = arg.split("=", 1)[0]
        if head in _UPLOAD_FLAGS or head.startswith("--data") or head.startswith("--form"):
            return True
        if head in ("-X", "--request", "--method"):
            value = arg.split("=", 1)[1] if "=" in arg else (args[i + 1] if i + 1 < len(args) else "")
            if value.upper() in _UPLOAD_METHODS:
                return True
        if head.startswith("-X") and head[2:].upper() in _UPLOAD_METHODS:
            return True
    return False


def _acp_function(word: str) -> Optional[str]:
    if word == "trade":
        return "trading"
    if word == "message":
        return "messaging"
    if word == "email":
        return "email"
    if word in _ACP_PAYMENT_VERBS:
        return "payments"
    if word in _ACP_JOB_VERBS:
        return "acp"
    return None


def _runner_folded(cmd: Any, prog: str, args: List[str]) -> Tuple[str, List[str]]:
    """R2-M2: a money CLI run by a script runner through its install path (runner + script path) is that CLI. The
    program word comes from the classifier's own reading of the normaliser's output (``classify._money_prog``, read
    through the seam, no rule of its own here); the CLI's argv is what follows the script path."""
    from .classify import _NODE_RUNNERS, _money_prog

    if prog not in _NODE_RUNNERS:
        return prog, args
    money = _money_prog(cmd)
    if not money:
        return prog, args
    script = next((i for i, arg in enumerate(args) if not arg.startswith("-")), len(args))
    return money, args[script + 1:]


def program_functions(cmd: Any) -> Set[str]:
    """The functions of ONE simple command of the normaliser's output (``prog`` + ``args``).

    The subcommand (first positional word) attributes the command precisely; a function word found anywhere else in
    the argv is ADDED (the strictest of them decides), so an option or an argument can never move a command out of the
    row its words name. A command in no table is Shell."""
    prog = str(getattr(cmd, "prog", "") or "").rsplit("/", 1)[-1].lower()
    args = [str(a) for a in (getattr(cmd, "args", None) or [])]
    prog, args = _runner_folded(cmd, prog, args)
    words = _positionals(args)
    first = words[0] if words else ""
    if getattr(cmd, "unresolvable", False) or getattr(cmd, "code", None):
        return {"shell"}
    if prog == "agentcard":
        out = {"email" if first == "email" else "payments" if first in ("wallet", "x402") else "shopping"}
        if "email" in words:
            out.add("email")
        if "wallet" in words or "x402" in words:
            out.add("payments")
        return out
    if prog == "onchainos":
        out = {"trading"} if any(w in _ONCHAINOS_TRADING for w in words) else set()
        if first not in _ONCHAINOS_TRADING:
            out.add("payments")
        return out
    if prog in ("privy", "cast", "forge"):
        return {"payments"}
    if prog == "acp":
        out = {_acp_function(first) or "acp"}
        out.update(fn for fn in (_acp_function(w) for w in words[1:]) if fn)
        return out
    if prog in _FILE_PROGS:
        return {"files"}
    if prog in _PUBLISH_PROGS:
        return {"publish"}
    # `pnpm publish`, `bun publish`: the normaliser unwraps the runner, so the subcommand is the program word.
    if prog == "publish" and getattr(cmd, "runner", ""):
        return {"publish"}
    if prog in _PUBLISH_SUBCMDS:
        if first in _PUBLISH_SUBCMDS[prog]:
            return {"publish"}
        # `git -C dir push`: global options before the subcommand — both rows decide.
        return {"shell", "publish"} if any(w in _PUBLISH_SUBCMDS[prog] for w in words) else {"shell"}
    if prog in ("curl", "wget", "http", "https", "xh") and _uploads(args):
        return {"publish"}
    return {"shell"}


# ---- the closure (one rule, twice: here and main's `coverFunctions`; fixture `coverCodes` holds them equal) ---------

def close_families(fns: Iterable[str]) -> Set[str]:
    """R3-MONO family closure over a UNION: any money row ⇒ all four money rows, any message row ⇒ both."""
    out = set(fns)
    for family in (MONEY, MESSAGES):
        if out.intersection(family):
            out.update(family)
    return out


def cover(tool_name: str, cls: str, fns: Iterable[str]) -> Tuple[str, ...]:
    """The class coverage and the family closure (§4.5), applied to a call's (or a part's) function set. It can only
    ADD rows. Main's ``coverFunctions`` is the same function (``tests/fixtures/functions.json`` ``coverCodes``).

    - text tools (shell text, process input, code): an empty set is Shell; a `$` line adds every money row, an `M`
      line both message rows; a Shell part on a `$`/`M` line adds every money AND message row; then the families
      are closed over the union (``close_families``) — whatever row the words name, and whatever class the line has;
    - structured tools keep the row their name and target pin (a `send_message` to e-mail is Email alone): `$`
      adds every money row, `M` both message rows when the tool names none;
    - any tool: `D`/`Wp`/`Wo` adds Files; a tool that is neither a text tool nor a no-function tool, with an EMPTY
      set, is every function (R2-M1 here; R3-U: main applies the same to what the plugin sends)."""
    wanted = {fn for fn in fns if fn in FUNCTIONS}
    if cls == "R":
        return _ordered(wanted)
    text = tool_name in _SHELL_TOOLS
    if not wanted and not text and tool_name not in _NO_FUNCTION and tool_name not in _NO_FUNCTION_PROVIDER_READS:
        wanted = set(FUNCTIONS)
    if text and not wanted:
        wanted.add("shell")
    if cls == "$":
        wanted.update(MONEY)
    if cls == "M" and (text or not wanted.intersection(MESSAGES)):
        wanted.update(MESSAGES)
    if text and cls in ("$", "M") and "shell" in wanted:
        wanted.update(MONEY + MESSAGES)
    if cls in ("D", "Wp", "Wo"):
        wanted.add("files")
    if text:
        wanted = close_families(wanted)
    return _ordered(wanted)


# ---- the words of a text: every simple command, and every shell-out inside code ---------------------------------------

def _code_shellouts(code: str) -> List[str]:
    """The command lines interpreter code carries, exactly as the classifier reads them (``classify._classify_code``,
    through the seam): each argv list as one command, each other string literal as a command line (a bare word only
    when the code clearly spawns one)."""
    from .classify import _CODE_STRING, _SHELLOUT_SITE, _argv_lists, _code_unescape

    out: List[str] = []
    spans: List[Tuple[int, int]] = []
    for argv, span in _argv_lists(code):
        spans.append(span)
        out.append(shlex.join(argv))
    has_site = bool(_SHELLOUT_SITE.search(code))
    for match in _CODE_STRING.finditer(code):
        if any(a <= match.start() < b for a, b in spans):
            continue
        literal = _code_unescape(next((g for g in match.groups() if g is not None), ""))
        if not literal.strip() or (not has_site and " " not in literal and "/" not in literal):
            continue
        out.append(literal)
    return out


def _code_functions(code: str, depth: int = 0) -> Set[str]:
    """R3-C27: code is Shell, plus what every shell-out it carries reads as through the same tables (a publish
    inside code reaches the Publish row). Code nested past the classifier's depth cap is Shell alone (the class
    then brings its rows: the classifier reads it as `$`)."""
    from .classify import _CODE_DEPTH_MAX

    out = {"shell"}
    if depth >= _CODE_DEPTH_MAX:
        return out
    for line in _code_shellouts(code):
        out.update(_shell_text_functions(line, depth + 1))
    return out


def _shell_text_functions(text: str, depth: int = 0) -> Set[str]:
    from .normalize import normalize

    out: Set[str] = set()
    for keep in (False, True):
        norm = normalize(text, keep_data=keep)
        if norm.unresolvable or norm.unknown_consumer or norm.overflow or not norm.commands:
            out.add("shell")
        for cmd in norm.commands:
            out.update(program_functions(cmd))
            for body in getattr(cmd, "code", None) or ():
                if str(body).strip():
                    out.update(_code_functions(str(body), depth))
    return out


def _process_text(args: Mapping[str, Any]) -> str:
    """The line a `process` write/submit completes: the classifier's own pending input for the session plus ``data``
    (read through the seam, ``classify._pending_input``; it is read BEFORE the hook commits this input)."""
    from .classify import _pending_input

    return _pending_input(str(args.get("session_id") or "")) + str(args.get("data") or "")


# ---- the parts of a text line ---------------------------------------------------------------------------------------

# R5-K: the work a call may cost, counted before any part is read — the segments of the line plus the segments of
# every shell-out its code carries. Every contiguous run of a line's segments is a part (n·(n+1)/2 − 1 classifier
# reads for n segments); past this many segments nothing is read and the call is UNREAD.
_K_SEG = 8
# main's PARTS_MAX (authority.ts): a reading with more parts than this is unread on both sides.
_PARTS_MAX = 64
_HEREDOC_DELIM = "ICLONE_F2_HEREDOC_%d"


class Part(NamedTuple):
    """One part of a line, read as a line of its own: what the classifier says of it and the functions it touches."""
    cls: str
    facts: Tuple[Tuple[str, bool], ...]
    floor: Optional[str]
    ceiling_key: Optional[str]
    fns: Tuple[str, ...]


class Functions(tuple):
    """The call's candidates (function ids in the fixed order) and the parts they were read from.

    ``read`` is False when the parts were not read (the signed body sets no level: every row follows the mode, the
    parts cannot change a decision; main is sent ``null``). ``unread`` is True when the call is not FULLY READ: past
    the counted caps (R4-UNREAD, R5-K: no part read, main is sent ``[]``) or outside the closed grammar (R5-G: the
    parts the counted work allows are read and sent). Either way it is every function, and no row at a user level
    allows it; main is told by the payload's ``unread`` flag."""

    parts: Tuple[Part, ...]
    read: bool
    unread: bool

    def __new__(cls, fns: Iterable[str] = (), parts: Iterable[Part] = (), read: bool = False,
                unread: bool = False) -> "Functions":
        self = super().__new__(cls, _ordered(fns))
        self.parts = tuple(parts)
        self.read = read
        self.unread = unread
        return self

    def wire(self) -> Optional[List[Dict[str, Any]]]:
        """The parts as the payload carries them to main (``null`` = not read, ``[]`` = unread; R5-G: an unread call
        may carry the parts it read, and the payload's ``unread`` flag says it is unread)."""
        if not self.read:
            return None
        return [{"cls": p.cls, "facts": dict(p.facts), "floor": p.floor, "ceilingKey": p.ceiling_key,
                 "fns": list(p.fns)} for p in self.parts]


class _Unread(Exception):
    """The call's parts cannot all be read within the caps (R4-UNREAD, R5-K)."""


class _Work:
    """R5-K: the texts to read for one call and the segments counted so far. Counting past ``_K_SEG`` raises
    ``_Unread`` at once, before the runs of a long line are even listed."""

    def __init__(self) -> None:
        self.texts: List[str] = []
        self.segments = 0

    def count(self, segments: int) -> None:
        self.segments += segments
        if self.segments > _K_SEG:
            raise _Unread


def _segments(text: str) -> Tuple[List[Tuple[str, str]], List[Tuple[str, bool]]]:
    """The normaliser's own top-level split (through the seam): heredocs lifted first (so a heredoc body is never
    split into pseudo-commands), then ``(segment, operator)`` pairs."""
    from .normalize import _Ctx, _lift_heredocs, _split_top_ops

    ctx = _Ctx(assigns={}, out=[])
    lifted = _lift_heredocs(text, ctx)
    return _split_top_ops(lifted), list(ctx.heredocs)


def _run_text(segs: Sequence[Tuple[str, str]], heredocs: Sequence[Tuple[str, bool]], i: int, j: int) -> str:
    """Segments i..j as one line (their own operators between them), each lifted heredoc put back behind it."""
    text = "".join(seg + op for seg, op in segs[i:j]) + segs[j][0]
    bodies: List[str] = []
    for idx, (body, expands) in enumerate(heredocs):
        marker = "<<\x00%d\x00" % idx
        if marker in text:
            delim = _HEREDOC_DELIM % idx
            text = text.replace(marker, "<<" + (delim if expands else "'%s'" % delim))
            bodies.append(body + delim)
    return (text.strip() + "".join("\n" + b for b in bodies)).strip()


def _runs(text: str, work: Optional[_Work] = None) -> List[str]:
    """The part texts of a line: every contiguous run of its segments but the whole line. With ``work``, the
    segments are counted first (R5-K: past ``_K_SEG`` the runs are never listed)."""
    segs, heredocs = _segments(text)
    n = len(segs)
    if work is not None:
        work.count(n)
    return [_run_text(segs, heredocs, i, j) for i in range(n) for j in range(i, n) if (i, j) != (0, n - 1)]


def _code_bodies(text: str) -> List[str]:
    """The interpreter code a shell line carries (both readings of the normaliser)."""
    from .normalize import normalize

    return list(dict.fromkeys(str(body) for keep in (False, True) for cmd in normalize(text, keep_data=keep).commands
                              for body in getattr(cmd, "code", None) or () if str(body).strip()))


def _code_texts(code: str, depth: int, work: _Work) -> None:
    """Every text to read for interpreter code: each shell-out it carries, as a line of its own, with all of ITS
    parts (R4-UNREAD: a shell-out is a line like any other; R5-K: its segments are counted). Code nested past the
    classifier's depth is unread."""
    from .classify import _CODE_DEPTH_MAX

    if depth >= _CODE_DEPTH_MAX:
        raise _Unread
    for line in _code_shellouts(code):
        work.texts.append(line)
        _line_texts(line, depth + 1, work)


def _line_texts(text: str, depth: int, work: _Work) -> None:
    """Every text to read for one line, the line itself excluded: each run of its segments, and every shell-out of
    the code it carries with that shell-out's own parts. Raises ``_Unread`` past ``_K_SEG`` or the code depth."""
    work.texts.extend(_runs(text, work))
    for body in _code_bodies(text):
        _code_texts(body, depth, work)


# ---- R5-G: the closed grammar of a FULLY READ line --------------------------------------------------------------------

# Wrappers that only run the argv after their own words (a CLOSED table; each takes the few words below, no others).
_TRANSPARENT_WRAPPERS = frozenset({"env", "nohup", "timeout", "nice", "time"})
# The shell's reserved words: in program position they open a compound command, which is not in the grammar.
_RESERVED = frozenset({"if", "then", "else", "elif", "fi", "do", "done", "case", "esac", "while", "until", "for", "in",
                       "function", "select", "coproc"})
# Characters of an unquoted word, and of a program word (ASCII, no expansion of any kind).
_WORD_PUNCT = frozenset("-_./:,+@%^=~")
_PROGRAM_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./+")
_IDENT_START = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_")
_IDENT_CHARS = _IDENT_START | frozenset("0123456789")
_WORD_END = frozenset(" \t\n;&|<>")
_SEPARATORS = (";", "&", "\n")


class _GWord(NamedTuple):
    value: str      # the word with its quotes removed
    raw: str        # the word as written
    quoted: bool    # some of it was quoted
    start: int
    end: int
    expands: bool = False   # R5-ARG: it holds a glob character or a plain parameter expansion


# R5-ARG: unquoted glob characters (accepted in argument positions only).
_GLOB_CHARS = frozenset("*?[]")


def _param(text: str, i: int) -> int:
    """The end of a PLAIN parameter expansion at ``i`` (``$NAME`` or ``${NAME}``, nothing inside the braces but the
    name), or -1: any other ``$`` form — a substitution, arithmetic, an operator in braces, a special parameter."""
    n = len(text)
    braced = text.startswith("${", i)
    j = i + (2 if braced else 1)
    if j >= n or text[j] not in _IDENT_START:
        return -1
    while j < n and text[j] in _IDENT_CHARS:
        j += 1
    if braced:
        return j + 1 if j < n and text[j] == "}" else -1
    return j


def _scan_word(text: str, i: int) -> Optional[_GWord]:
    """One word at ``i``: unquoted plain characters, single-quoted text, double-quoted text, and (R5-ARG) unquoted
    glob characters and plain parameter expansions, the word then marked ``expands``. None for anything else (the
    scanner does not classify it); where an expanding word may stand is the grammar's business (argument
    positions only)."""
    start, n, out, quoted, expands = i, len(text), [], False, False
    while i < n and text[i] not in _WORD_END:
        ch = text[i]
        if ch == "$":
            j = _param(text, i)
            if j < 0:
                return None
            out.append(text[i:j])
            expands, i = True, j
        elif ch in _GLOB_CHARS:
            out.append(ch)
            expands, i = True, i + 1
        elif ch == "'":
            j = text.find("'", i + 1)
            if j == -1:
                return None
            out.append(text[i + 1:j])
            quoted, i = True, j + 1
        elif ch == '"':
            i += 1
            while i < n and text[i] != '"':
                if text[i] == "`":
                    return None
                if text[i] == "$":
                    j = _param(text, i)
                    if j < 0:
                        return None
                    out.append(text[i:j])
                    expands, i = True, j
                    continue
                if text[i] == "\\" and i + 1 < n:
                    i += 1
                out.append(text[i])
                i += 1
            if i >= n:
                return None
            quoted, i = True, i + 1
        elif ch.isalnum() or ch in _WORD_PUNCT:
            out.append(ch)
            i += 1
        else:
            return None
    if i == start:
        return None
    return _GWord("".join(out), text[start:i], quoted, start, i, expands)


def _scan_redirect(text: str, i: int, fd: str, start: int) -> Tuple[Optional[tuple], int]:
    """A plain file redirection at ``i``: ``[fd]>``, ``[fd]>>`` or ``[fd]<`` and a plain word. A duplication
    (``>&``) is not in the grammar: the normaliser splits its ``&`` as an operator, so the two readings differ."""
    n = len(text)
    if text.startswith(("<<", "<>", ">|", "<(", ">(", ">&", "<&"), i):
        return None, i
    op = ">>" if text.startswith(">>", i) else text[i]
    j = i + len(op)
    while j < n and text[j] in " \t":
        j += 1
    word = _scan_word(text, j)
    # R5-ARG: a redirection target is never an expansion (it names the file written or read)
    return (("redir", fd + op, word, start, word.end), word.end) if word and not word.expands else (None, i)


def _scan(text: str) -> Optional[List[tuple]]:
    """The line as ``("op", op)``, ``("word", _GWord)`` and ``("redir", op, target, start, end)`` tokens, or None
    as soon as one character is not part of the plain shape."""
    toks: List[tuple] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in " \t":
            i += 1
        elif ch in ";\n":
            if text.startswith(";;", i):
                return None
            toks.append(("op", ch))
            i += 1
        elif ch == "|":
            if text.startswith("|&", i):
                return None
            op = "||" if text.startswith("||", i) else "|"
            toks.append(("op", op))
            i += len(op)
        elif ch == "&" and text.startswith("&>", i):
            return None
        elif ch == "&":
            op = "&&" if text.startswith("&&", i) else "&"
            toks.append(("op", op))
            i += len(op)
        elif ch in "<>":
            tok, i = _scan_redirect(text, i, "", i)
            if tok is None:
                return None
            toks.append(tok)
        else:
            word = _scan_word(text, i)
            if word is None:
                return None
            i = word.end
            if i < n and text[i] in "<>" and not word.quoted and word.raw.isdigit():
                tok, i = _scan_redirect(text, i, word.raw, word.start)
                if tok is None:
                    return None
                toks.append(tok)
            else:
                toks.append(("word", word))
    return toks


def _plain(word: _GWord) -> bool:
    return not word.quoted and all(ch in _PROGRAM_CHARS for ch in word.raw) and not word.raw.startswith("-")


def _assignment(word: _GWord) -> bool:
    name = word.raw.split("=", 1)[0]
    return "=" in word.raw and bool(name) and name[0] in _IDENT_START and all(ch in _IDENT_CHARS for ch in name)


def _unwrap(words: Sequence[_GWord], k: int) -> int:
    """The index of the first word after a transparent wrapper's own words (-1: a word it does not take)."""
    name, k = words[k].raw, k + 1
    nxt = words[k].raw if k < len(words) and not words[k].quoted else None
    if name == "env":
        while k < len(words) and _assignment(words[k]):
            if words[k].expands:
                return -1
            k += 1
        return -1 if k < len(words) and words[k].raw.startswith("-") else k
    if name == "timeout":
        dur = (nxt or "").rstrip("smhd")
        return k + 1 if dur and dur.replace(".", "", 1).isdigit() else -1
    if name == "nice":
        if nxt == "-n":
            val = words[k + 1].raw if k + 1 < len(words) else ""
            return k + 2 if val.lstrip("-").isdigit() else -1
        if nxt and nxt.startswith("-"):
            return k + 1 if nxt[1:].isdigit() else -1
        return k
    if name == "time" and nxt == "-p":
        return k + 1
    return -1 if nxt is not None and nxt.startswith("-") else k


def _grammar_segment(words: Sequence[_GWord], text: str, depth: int) -> bool:
    """One segment: plain assignments, the transparent wrappers, then a literal program word and plain arguments —
    and the normaliser's own reading of it is that one command (``_agrees``)."""
    k = 0
    while k < len(words) and _assignment(words[k]):
        if words[k].expands:  # R5-ARG: an assignment is not an argument position
            return False
        k += 1
    wrapped = False
    while k < len(words) and _plain(words[k]) and words[k].raw in _TRANSPARENT_WRAPPERS:
        k, wrapped = _unwrap(words, k), True
        if k < 0:
            return False
    if k == len(words):
        return not wrapped
    prog = words[k]
    if not _plain(prog) or prog.raw in _RESERVED:
        return False
    # R5-ARG: an argument-position expansion cannot change which program runs or add a command; an executor's
    # arguments (its script path among them) are its input, so there it is not in the grammar
    return _agrees(text, prog.raw.rsplit("/", 1)[-1].lower(), depth, any(w.expands for w in words[k + 1:]))


def _agrees(text: str, base: str, depth: int, args_expand: bool = False) -> bool:
    """The normaliser reads the segment as exactly this one command (its program, or the runner that exposed it),
    with nothing it could not read; a shell or ``source`` runs a script FILE; an interpreter runs a file or code this
    module reads (its shell-outs in the same grammar); nothing takes its stdin as code or argv."""
    from .normalize import _INTERP, _SHELLS, _Ctx, _basename, _executor, _parse, _tokenise, normalize

    bodies: List[str] = []
    for keep in (False, True):
        norm = normalize(text, keep_data=keep)
        if norm.unresolvable or norm.unknown_consumer or norm.overflow or len(norm.commands) != 1:
            return False
        cmd = norm.commands[0]
        if cmd.unresolvable or (cmd.prog.rsplit("/", 1)[-1] != base and cmd.runner != base):
            return False
        bodies.extend(str(body) for body in cmd.code or () if str(body).strip())
    parsed = _parse(_tokenise(text), _Ctx(assigns={}, out=[]))
    if parsed is None:
        return False
    prog = _basename(parsed.prog)
    if args_expand and any(p in _SHELLS or p in ("source", ".", "xargs") or _INTERP.match(p) for p in (prog, base)):
        return False
    kind, runs_file = _executor(parsed)
    if kind or ((prog in _SHELLS or prog in ("source", ".")) and not runs_file):
        return False
    if bodies:
        return bool(_INTERP.match(prog)) and all(_grammar_code(body, depth) for body in dict.fromkeys(bodies))
    return not _INTERP.match(prog) or runs_file


def _grammar_code(code: str, depth: int) -> bool:
    """Interpreter code read here: every shell-out it carries is in the grammar, within the classifier's depth."""
    from .classify import _CODE_DEPTH_MAX

    return depth < _CODE_DEPTH_MAX and all(_grammar_line(line, depth + 1) for line in _code_shellouts(code))


def _grammar_line(text: str, depth: int = 0) -> bool:
    """R5-G: the WHOLE line is in the closed grammar (FULLY READ), or it is not (UNREAD)."""
    from .normalize import normalize

    toks = _scan(text)
    if toks is None:
        return False
    for keep in (False, True):
        norm = normalize(text, keep_data=keep)
        if norm.unresolvable or norm.unknown_consumer or norm.overflow:
            return False
    segments: List[List[tuple]] = [[]]
    ops: List[str] = []
    for tok in toks:
        if tok[0] == "op":
            ops.append(tok[1])
            segments.append([])
        else:
            segments[-1].append(tok)
    for k, seg in enumerate(segments):
        before = ops[k - 1] if k > 0 else None
        after = ops[k] if k < len(ops) else None
        if not seg:
            # a blank line, or a separator that ends the line — nothing else may be empty
            if before not in (None,) + _SEPARATORS or after not in (None, "\n"):
                return False
            continue
        start = min(t[1].start if t[0] == "word" else t[3] for t in seg)
        end = max(t[1].end if t[0] == "word" else t[4] for t in seg)
        if not _grammar_segment([t[1] for t in seg if t[0] == "word"], text[start:end], depth):
            return False
    return True


def _part(tool_name: str, text: str, ctx: Mapping[str, Any]) -> Part:
    """One part read as a line of its own: the classifier's class, facts, floor and switch, and its functions."""
    from .classify import classify

    call = classify("terminal", {"command": text}, ctx.get("cwd"), ctx.get("policy") or {},
                    session_id=ctx.get("session_id"), lineage=ctx.get("lineage"))
    words = _shell_text_functions(text) if text.strip() else {"shell"}
    if getattr(call, "unknown", False):
        words.add("shell")
    return Part(str(call.cls), tuple(sorted((k, bool(v)) for k, v in dict(call.facts).items())), call.floor,
                call.ceiling_key, cover(tool_name, str(call.cls), words))


def _read_parts(tool_name: str, texts: Sequence[str], ctx: Mapping[str, Any]) -> List[Part]:
    """Read every text as a part — all of them, or none (R5-K: past ``_PARTS_MAX`` parts, counted before the first
    read, the call is unread). The same text is read once."""
    todo = list(dict.fromkeys(texts))
    if len(todo) + 1 > _PARTS_MAX:  # + part 0, the whole line
        raise _Unread
    return list(dict.fromkeys(_part(tool_name, text, ctx) for text in todo))


def _levels_set(policy: Optional[Mapping[str, Any]]) -> bool:
    """True when the signed body sets any row to something other than Follow mode (a malformed level counts)."""
    levels = (policy or {}).get("functions")
    return isinstance(levels, Mapping) and any(level_of(levels.get(fn)) != "mode" for fn in FUNCTIONS)


def _ordered(cands: Iterable[str]) -> Tuple[str, ...]:
    wanted = set(cands)
    return tuple(fn for fn in FUNCTIONS if fn in wanted)


def _structured(tool_name: str, args: Mapping[str, Any]) -> Optional[Set[str]]:
    if tool_name == "send_message":
        target = str(args.get("target") or "")
        return {"email"} if target.split(":", 1)[0].strip().lower() == "email" else {"messaging"}
    if tool_name in _MESSAGING_TOOLS:
        return {"messaging"}
    if tool_name in _FILE_TOOLS:
        return {"files"}
    if tool_name in _PUBLISH_TOOLS:
        return {"publish"}
    if tool_name in _NO_FUNCTION or tool_name in _NO_FUNCTION_PROVIDER_READS:
        return set()
    return None


def functions_of(tool_name: str, args: Mapping[str, Any], classified: Any, *, cwd: Optional[str] = None,
                 policy: Optional[Mapping[str, Any]] = None, session_id: Optional[str] = None,
                 lineage: Optional[Sequence[str]] = None) -> Functions:
    """The call's candidate functions, in the fixed function order. Never raises: an error is all nine.

    ``cwd``/``policy``/``session_id``/``lineage`` are the hook's own (the classifier got the same): with them, and a
    signed body that sets any level, the parts of a text call are read (each run classified as a line of its own),
    within the counted caps — or the call is unread (R4-UNREAD, R5-K). A call outside the closed grammar is unread
    too (R5-G), with the parts the counted work allows read all the same (R5-D keeps them)."""
    try:
        cls = str(getattr(classified, "cls", "X"))
        if cls == "R":
            return Functions((), (), True)
        args = args if isinstance(args, Mapping) else {}
        cands = _structured(tool_name, args)
        if cands is not None:
            return Functions(cover(tool_name, cls, cands), (), True)
        if tool_name not in _SHELL_TOOLS:
            return Functions(FUNCTIONS, (), True)  # R2-M1: a tool this module does not know is every function
        read = _levels_set(policy)
        ctx = {"cwd": cwd, "policy": policy, "session_id": session_id, "lineage": lineage}
        work = _Work()
        cands = {"shell"}
        full = True  # R5-G: the whole call is in the closed grammar
        try:
            if tool_name == "terminal":
                text = str(args.get("command") or args.get("cmd") or "")
                cands = _shell_text_functions(text)
                if read and text:
                    _line_texts(text, 0, work)
                    full = _grammar_line(text)
            elif tool_name in _PROCESS_TOOLS:
                action = str(args.get("action") or "")
                if action.lower() in _PROCESS_READS:
                    cands = set()
                elif action in ("write", "submit"):
                    # R2-M3: the same text the classifier reads (the input typed so far + this data), through the
                    # same tables as `terminal`; Shell stays (it runs inside a live process, which may not be a shell).
                    text = _process_text(args)
                    cands = _shell_text_functions(text) | {"shell"}
                    if read and text:
                        _line_texts(text, 0, work)
                        full = _grammar_line(text)
            elif tool_name == "execute_code":
                # R3-C27: the code's shell-outs are read through the same tables (and are parts of the call)
                code = str(args.get("code") or "")
                cands = _code_functions(code)
                if read:
                    _code_texts(code, 0, work)
                    full = _grammar_code(code, 0)
            parts = _read_parts(tool_name, work.texts, ctx) if read else []
        except _Unread:
            return Functions(FUNCTIONS, (), True, unread=True)
        if getattr(classified, "unknown", False):
            cands.add("shell")
        for part in parts:
            cands.update(part.fns)
        fns = cover(tool_name, cls, cands) if full else FUNCTIONS
        if read:  # part 0: the whole call as the classifier read it (a read call never sends an empty list)
            facts = tuple(sorted((k, bool(v)) for k, v in dict(getattr(classified, "facts", None) or {}).items()))
            parts.insert(0, Part(cls, facts, getattr(classified, "floor", None),
                                 getattr(classified, "ceiling_key", None), fns))
        return Functions(fns, parts, read, unread=not full)
    except Exception:  # noqa: BLE001 — fail closed: every row decides, the strictest wins, and nothing was read
        return Functions(FUNCTIONS, (), False, unread=True)
