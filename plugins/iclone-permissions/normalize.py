r"""V3-F round 5 — the normaliser.

Round 4 rejected the classifier because its floor/class regexes read raw shell text: every critic round
invented a spelling the regex lists lacked (a verb split by a backslash, a verb taken from a variable, a
money CLI behind its install path, a `pkill` selector that is a regex). This module answers with ONE pure
function applied BEFORE every floor/class regex: it folds a command down to the simple commands it will
actually run, so a verb spelled `k\ill`, `ki''ll`, `$'\x6b'ill`, `v=kill; $v`, `sh -c 'kill'` or
`/bin/kill` all reduce to the same `kill`, and a payment CLI behind `~/.privy/bin/privy` or `npx privy`
reduces to `privy` — while a verb that only appears as *data* to `echo`/`grep`/`git log` is dropped, so it
is never mistaken for a command (the r4 over-floor minor m4).

`normalize(cmd)` is pure and side-effect free (no shell is ever run). It returns a ``NormalizedCommand``:

* ``commands`` — the flat list of ``SimpleCommand`` the text runs, with containers (``sh -c``, ``eval``,
  ``trap``, ``for/while … do … done``, ``find -exec``, ``$(…)``/`` `…` `` substitutions) unwrapped
  recursively (depth ≤ 3) so a verb hidden inside one surfaces as its own command. Each carries the folded,
  path-stripped, runner-unwrapped program word and its folded argv.
* ``text`` — a folded reconstruction of the whole command, for the text-scan floors that need the whole
  line (the launchd/fuser/pgrep/xargs/interpreter-kill and iNFT scans).
* ``unresolvable`` — a command word this module cannot read (a ``$(…)`` or backtick in command position, an
  ``eval`` of a non-literal, ``${!x}`` indirection, a bare unknown ``$VAR`` as the program). The caller
  floors such a command when a guard name/pid or a money binary appears anywhere (fail closed).

* ``data`` — the raw source of every word this module read as pure DATA (the argument of an ``echo``/``grep``
  whose output reaches no shell, interpreter or substitution). The classifier's raw view masks exactly these
  words and nothing else (round 6, the one data exception to "normalising only adds").

Round 6 (critic r5 M1/M2): code that reaches a shell or an interpreter on STDIN is code, not data. A pipeline
``<producer> | sh`` runs the producer's output, so a literal ``echo``/``printf`` (optionally through ``base64 -d``,
``xxd -r -p`` or ``cat``) piped into a shell is unwrapped into the commands it carries, and into an interpreter
(``python3``, ``node``, ``osascript`` …) it becomes that command's ``code``; a heredoc or here-string body is read
the same way. An interpreter's ``-c``/``-e``/``--eval`` argument is its ``code`` too. When the data cannot be read
(``curl … | sh``, ``sh < file``) the executor is ``unresolvable`` — the caller fails closed.

Round 7 (critic r6 M1, m-b, m-d) — what this module cannot fully model is reported, never guessed: besides
``unresolvable``, ``unknown_consumer`` marks piped or redirected data reaching a program that is neither a known
executor (shells, ``source``, interpreters, ``xargs`` — read as code above) nor on the closed NON-EXECUTING allowlist,
and ``overflow`` marks code nested past ``_MAX_DEPTH``. The classifier's one rule ("unknown poisons the line") reads
them; ``normalize(cmd, keep_data=True)`` is the reading with the data mask OFF (data-sink arguments kept as argv).

Nothing here decides a class or a floor; it only rewrites the text the classifier then reads.
"""

from __future__ import annotations

import re
import shlex
import base64
import binascii
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

_MAX_DEPTH = 3
_MAX_WORDS = 4000  # a line longer than this is pathological; stop folding and let the caller fail closed

# Binaries whose install path is folded away so `(?:\S*/)?privy` and `~/.privy/bin/privy` both read as `privy`.
_KNOWN_BINARIES = frozenset({
    "privy", "onchainos", "agentcard", "acp", "kill", "pkill", "killall", "launchctl", "osascript", "fuser",
    "cast", "forge",
})
# Wrappers that run the command that follows them (and consume their own options). `xargs` is deliberately NOT
# here: it changes which pids are fed to a kill, so the kill scan must still see the `xargs` word.
_WRAPPERS = frozenset({
    "sudo", "doas", "command", "builtin", "exec", "nohup", "nice", "ionice", "setsid", "caffeinate", "stdbuf",
    "time", "env",
})
# Runners that expose the NEXT token as the real program (`npx privy …` runs privy). `uv run`, `pnpm dlx`,
# `yarn dlx` take one extra sub-word first.
_RUNNERS = frozenset({"npx", "bunx", "uvx", "pnpm", "yarn", "uv", "pdm", "poetry", "bun", "deno"})
_RUNNER_SUBWORDS = {"pnpm": "dlx", "yarn": "dlx", "uv": "run", "pdm": "run", "poetry": "run"}
# Shell keywords that may lead a simple command inside a compound one.
_KEYWORDS = frozenset({"do", "then", "else", "elif", "{", "}", "(", ")", "!", "time"})
# Programs whose arguments are data, not code: a verb quoted as their argument is never a command. A word that
# contains a command substitution is still kept — that part really does run.
_DATA_SINKS = frozenset({"echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "print"})
_GIT_DATA_SUBCMDS = frozenset({"log", "grep", "show", "diff", "blame", "shortlog"})
# The iT pane proxy (V3-D): these subcommands hand their text to another live shell, so the text is a command.
_IT_CARRIERS = frozenset({"exec", "run", "send", "spawn"})
_IT_VALUE_OPTS = frozenset({"surface", "pane", "workspace", "host", "file", "window", "tab"})
# r7 U — consumers of piped/redirected data that only page, count, sort, search or filter it and never run any of it.
# A CLOSED allowlist: a program is here only when no argument can make it execute something, or when the flags that
# can are listed in ``_EXEC_FLAGS`` (a consumer using one is unknown). Every consumer that is neither here nor a known
# executor (``_executor``) is UNKNOWN.
NON_EXECUTING = frozenset({
    "cat", "less", "more", "head", "tail", "wc", "sort", "uniq", "grep", "egrep", "fgrep", "rg", "cut", "tr", "nl",
    "tac", "rev", "column", "fold", "fmt", "paste", "expand", "unexpand", "comm", "jq", "base64", "xxd", "od",
    "hexdump", "strings", "tee", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum",
})
# A long flag here also matches by GNU abbreviation (``_is_exec_flag``, r7b i2).
_EXEC_FLAGS: Dict[str, Tuple[str, ...]] = {"sort": ("--compress-program",), "rg": ("--pre",)}

_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
_VARNAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_DURATION = re.compile(r"^\d+(\.\d+)?[smhd]?$")


@dataclass
class SimpleCommand:
    prog: str                       # folded, path-stripped, runner-unwrapped, lowercased program word ("" if none)
    args: List[str]                 # folded argv after the program word (flags kept, data-sink data dropped)
    unresolvable: bool = False      # the program word could not be read (floors when it names a guard/money bin)
    runner: str = ""                # the runner that exposed ``prog`` (`npx`, `pnpm`, `uv` …), "" if none
    code: List[str] = field(default_factory=list)  # interpreter code it runs (-c/-e/--eval, piped or heredoc stdin)

    @property
    def candidate(self) -> str:
        extra = [body for body in self.code if body not in self.args]
        return " ".join([self.prog, *self.args, *extra]).strip()


@dataclass
class NormalizedCommand:
    text: str
    commands: List[SimpleCommand] = field(default_factory=list)
    unresolvable: bool = False
    data: List[str] = field(default_factory=list)  # raw source of every word read as pure data (see module doc)
    unknown_consumer: bool = False   # r7: piped/redirected data reaches a consumer that is not known (see module doc)
    overflow: bool = False           # r7: code nested past _MAX_DEPTH was not read
    data_kept: bool = False          # r7: data-sink arguments were kept as argv (the mask is OFF on this reading)


# ---- the lexer: raw text → pieces per word, respecting quotes and substitutions -----------------------------------

def _decode_ansi_c(body: str) -> str:
    """`$'…'`: decode \\xHH, \\0NNN / \\NNN octal, and the common C escapes. Unknown escapes pass through."""
    out: List[str] = []
    i, n = 0, len(body)
    simple = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "f": "\f", "v": "\v", "e": "\x1b",
              "\\": "\\", "'": "'", '"': '"', "?": "?"}
    while i < n:
        ch = body[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = body[i + 1]
        if nxt == "x":
            m = re.match(r"[0-9A-Fa-f]{1,2}", body[i + 2:i + 4])
            if m:
                out.append(chr(int(m.group(0), 16)))
                i += 2 + len(m.group(0))
                continue
        if nxt == "u" or nxt == "U":
            width = 4 if nxt == "u" else 8
            m = re.match(r"[0-9A-Fa-f]{1,%d}" % width, body[i + 2:i + 2 + width])
            if m:
                try:
                    out.append(chr(int(m.group(0), 16)))
                    i += 2 + len(m.group(0))
                    continue
                except ValueError:
                    pass
        if nxt == "0" or nxt.isdigit():
            m = re.match(r"[0-7]{1,3}", body[i + 1:i + 4])
            if m:
                out.append(chr(int(m.group(0), 8) & 0xFF))
                i += 1 + len(m.group(0))
                continue
        if nxt in simple:
            out.append(simple[nxt])
            i += 2
            continue
        out.append(nxt)
        i += 2
    return "".join(out)


def _read_balanced(text: str, start: int, open_ch: str, close_ch: str) -> Tuple[str, int]:
    """From ``text[start]`` == open_ch, return (inner, index-after-close). Nested same-pairs are balanced."""
    depth = 0
    i = start
    n = len(text)
    inner_start = start + 1
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[inner_start:i], i + 1
        i += 1
    return text[inner_start:], n


# A piece: (kind, payload). kinds: lit (resolved literal), var (name), subst (inner code, opaque value),
# unreadable (an ${!x}-style expansion we cannot resolve). A word is a list of pieces plus a "quoted-data" flag
# telling whether every piece was quoted/plain data (no substitution) — used to drop data-sink arguments.
_Piece = Tuple[str, str]


def _lex_word(text: str, i: int) -> Tuple[List[_Piece], int, bool]:
    """Lex one word starting at ``text[i]`` (not whitespace/operator). Returns (pieces, next_index, has_subst)."""
    pieces: List[_Piece] = []
    n = len(text)
    has_subst = False
    while i < n:
        ch = text[i]
        if ch.isspace() or ch in ";|&<>()":
            break
        if ch == "\\":
            if i + 1 < n:
                pieces.append(("lit", text[i + 1]))
                i += 2
            else:
                i += 1
            continue
        if ch == "'":
            inner, i = _read_squote(text, i)
            pieces.append(("lit", inner))
            continue
        if ch == '"':
            inner, j = _read_dquote(text, i)
            sub_pieces, sub_has = _expand_dquote(inner)
            pieces.extend(sub_pieces)
            has_subst = has_subst or sub_has
            i = j
            continue
        if ch == "$":
            piece, j, sub = _lex_dollar(text, i)
            if piece is not None:
                pieces.append(piece)
            has_subst = has_subst or sub
            i = j
            continue
        if ch == "`":
            inner, j = _read_backtick(text, i)
            pieces.append(("subst", inner))
            has_subst = True
            i = j
            continue
        pieces.append(("lit", ch))
        i += 1
    return pieces, i, has_subst


def _read_backtick(text: str, i: int) -> Tuple[str, int]:
    """From ``text[i]`` == '`', return (inner, index-after-closing-backtick). Backslash escapes the delimiter."""
    n = len(text)
    j = i + 1
    buf: List[str] = []
    while j < n:
        ch = text[j]
        if ch == "\\" and j + 1 < n:
            buf.append(text[j + 1])
            j += 2
            continue
        if ch == "`":
            return "".join(buf), j + 1
        buf.append(ch)
        j += 1
    return "".join(buf), n


def _read_squote(text: str, i: int) -> Tuple[str, int]:
    end = text.find("'", i + 1)
    if end == -1:
        return text[i + 1:], len(text)
    return text[i + 1:end], end + 1


def _read_dquote(text: str, i: int) -> Tuple[str, int]:
    n = len(text)
    j = i + 1
    buf: List[str] = []
    while j < n:
        ch = text[j]
        if ch == "\\" and j + 1 < n:
            buf.append(text[j:j + 2])
            j += 2
            continue
        if ch == '"':
            return "".join(buf), j + 1
        buf.append(ch)
        j += 1
    return "".join(buf), n


def _expand_dquote(inner: str) -> Tuple[List[_Piece], bool]:
    """Inside double quotes only $var, ${…}, $(…) and backticks expand; backslash escapes a few chars."""
    pieces: List[_Piece] = []
    has_subst = False
    i, n = 0, len(inner)
    lit: List[str] = []
    while i < n:
        ch = inner[i]
        if ch == "\\" and i + 1 < n and inner[i + 1] in '"\\$`':
            lit.append(inner[i + 1])
            i += 2
            continue
        if ch == "$":
            if lit:
                pieces.append(("lit", "".join(lit)))
                lit = []
            piece, j, sub = _lex_dollar(inner, i)
            if piece is not None:
                pieces.append(piece)
            has_subst = has_subst or sub
            i = j
            continue
        if ch == "`":
            if lit:
                pieces.append(("lit", "".join(lit)))
                lit = []
            innerb, j = _read_backtick(inner, i)
            pieces.append(("subst", innerb))
            has_subst = True
            i = j
            continue
        lit.append(ch)
        i += 1
    if lit:
        pieces.append(("lit", "".join(lit)))
    return pieces, has_subst


def _lex_dollar(text: str, i: int) -> Tuple[Optional[_Piece], int, bool]:
    """``text[i]`` == '$'. Return (piece, next_index, is_substitution)."""
    n = len(text)
    if i + 1 >= n:
        return ("lit", "$"), i + 1, False
    nxt = text[i + 1]
    if nxt == "'":
        inner, j = _read_squote(text, i + 1)
        return ("lit", _decode_ansi_c(inner)), j, False
    if nxt == '"':
        inner, j = _read_dquote(text, i + 1)
        sub_pieces, sub = _expand_dquote(inner)
        joined = "".join(p for k, p in sub_pieces if k == "lit")
        return ("lit", joined), j, sub
    if nxt == "(":
        inner, j = _read_balanced(text, i + 1, "(", ")")
        return ("subst", inner), j, True
    if nxt == "{":
        inner, j = _read_balanced(text, i + 1, "{", "}")
        if inner.startswith("!"):
            return ("unreadable", inner), j, True
        name = _VARNAME.match(inner)
        if name and name.group(0) == inner:
            return ("var", inner), j, False
        # ${v:-default} and friends: take the variable name, keep it resolvable from the map
        vm = _VARNAME.match(inner)
        return ("var", vm.group(0) if vm else inner), j, False
    if nxt in "!#?$*@-":
        return ("lit", "$" + nxt), i + 2, False
    m = _VARNAME.match(text, i + 1)
    if m:
        return ("var", m.group(0)), m.end(), False
    return ("lit", "$"), i + 1, False


# ---- tokenising a segment into words --------------------------------------------------------------------------------

@dataclass
class _Word:
    pieces: List[_Piece]
    has_subst: bool
    is_redirect: bool = False
    raw: str = ""                   # the word's source text, verbatim (what the classifier's raw view masks)
    op: str = ""                    # for a redirect: the operator (`>`, `2>>`, `<`, `<<`, `<<<` …); pieces = target


def _tokenise(segment: str) -> List[_Word]:
    words: List[_Word] = []
    i, n = 0, len(segment)
    while i < n and len(words) < _MAX_WORDS:
        ch = segment[i]
        if ch.isspace():
            i += 1
            continue
        if ch in "<>":
            # a redirection operator plus its target becomes one marked word (kept verbatim-ish, not a program)
            m = re.match(r"\d*[<>]+&?", segment[i:])
            op = m.group(0)
            j = i + len(op)
            while j < n and segment[j].isspace():
                j += 1
            pieces, k, sub = _lex_word(segment, j) if j < n and not segment[j] in ";|&" else ([], j, False)
            words.append(_Word(pieces, sub, is_redirect=True, raw=segment[i:k], op=op))
            i = k
            continue
        if ch in "()":
            i += 1
            continue
        pieces, j, has_subst = _lex_word(segment, i)
        if j == i:  # safety against a stuck scanner
            i += 1
            continue
        words.append(_Word(pieces, has_subst, raw=segment[i:j]))
        i = j
    return words


# ---- top-level split into segments and container bodies -------------------------------------------------------------

def _split_top_ops(text: str) -> List[Tuple[str, str]]:
    """Split on top-level `;`, newline, `|`, `|&`, `&&`, `||`, `&` — not inside quotes, `$(…)`, `` `…` `` or `${…}`.
    Each segment comes with the operator that ENDS it (``""`` for the last), so a pipeline (``|``/``|&``) stays a
    pipeline: the stdout of one segment is the stdin of the next."""
    segs: List[Tuple[str, str]] = []
    buf: List[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            buf.append(text[i:i + 2])
            i += 2
            continue
        if ch == "'":
            j = text.find("'", i + 1)
            j = n if j == -1 else j + 1
            buf.append(text[i:j])
            i = j
            continue
        if ch == '"':
            _, j = _read_dquote(text, i)
            buf.append(text[i:j])
            i = j
            continue
        if ch == "`":
            _, j = _read_backtick(text, i)
            buf.append(text[i:j])
            i = j
            continue
        if ch == "$" and i + 1 < n and text[i + 1] in "({":
            op, cl = ("(", ")") if text[i + 1] == "(" else ("{", "}")
            _, j = _read_balanced(text, i + 1, op, cl)
            buf.append(text[i:j])
            i = j
            continue
        if ch in ";\n":
            segs.append(("".join(buf), ";"))
            buf = []
            i += 1
            continue
        if ch in "|&":
            if i + 1 < n and text[i + 1] == ch:
                sep = ch * 2
            elif ch == "|" and i + 1 < n and text[i + 1] == "&":
                sep = "|&"
            else:
                sep = ch
            i += len(sep)
            segs.append(("".join(buf), sep))
            buf = []
            continue
        buf.append(ch)
        i += 1
    if buf:
        segs.append(("".join(buf), ""))
    return segs


def _split_top(text: str) -> List[str]:
    """The segments of :func:`_split_top_ops`, without their operators."""
    return [seg for seg, _op in _split_top_ops(text)]


# ---- heredocs: lifted out of the text before it is split on newlines -------------------------------------------------

_HEREDOC_OP = re.compile(r"<<(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|(\\?)([^\s;&|<>()'\"]+))")
_HEREDOC_MARK = re.compile(r"^\x00(\d+)\x00$")


def _lift_heredocs(text: str, ctx: "_Ctx") -> str:
    """Replace every top-level ``<<[-]DELIM`` with a marker word and remove its body lines from the text, storing
    the body in ``ctx.heredocs``. Without this a heredoc body is split on newlines into pseudo-commands and the
    code it carries is lost (critic r5 M1: ``python3 - <<'EOF' … EOF``)."""
    if "<<" not in text:
        return text
    out: List[str] = []
    pending: List[Tuple[int, str, bool]] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            out.append(text[i:i + 2])
            i += 2
            continue
        if ch == "'":
            j = text.find("'", i + 1)
            j = n if j == -1 else j + 1
            out.append(text[i:j])
            i = j
            continue
        if ch == '"':
            _, j = _read_dquote(text, i)
            out.append(text[i:j])
            i = j
            continue
        if ch == "`":
            _, j = _read_backtick(text, i)
            out.append(text[i:j])
            i = j
            continue
        if ch == "$" and i + 1 < n and text[i + 1] in "({":
            op, cl = ("(", ")") if text[i + 1] == "(" else ("{", "}")
            _, j = _read_balanced(text, i + 1, op, cl)
            out.append(text[i:j])
            i = j
            continue
        if text.startswith("<<<", i):
            out.append("<<<")
            i += 3
            continue
        if text.startswith("<<", i):
            m = _HEREDOC_OP.match(text, i)
            if m:
                delim = next((g for g in (m.group(2), m.group(3), m.group(5)) if g is not None), "")
                quoted = m.group(2) is not None or m.group(3) is not None or bool(m.group(4))
                idx = len(ctx.heredocs)
                ctx.heredocs.append(("", not quoted))
                pending.append((idx, delim, bool(m.group(1))))
                out.append("<<\x00%d\x00" % idx)
                i = m.end()
                continue
        if ch == "\n" and pending:
            out.append("\n")
            i += 1
            for idx, delim, strip_tabs in pending:
                lines: List[str] = []
                while i < n:
                    j = text.find("\n", i)
                    line = text[i:] if j == -1 else text[i:j]
                    i = n if j == -1 else j + 1
                    check = line.lstrip("\t") if strip_tabs else line
                    if check == delim:
                        break
                    lines.append(check)
                ctx.heredocs[idx] = ("\n".join(lines) + "\n", ctx.heredocs[idx][1])
            pending = []
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# ---- folding words to literals, with the assignment map -------------------------------------------------------------

def _fold_pieces(pieces: List[_Piece], assigns: Dict[str, str], sentinel: bool = False) -> str:
    """Fold a word to its literal text. With ``sentinel``, an unresolved variable or an opaque substitution is
    rendered as a ``$(…)``/``$name`` token (never dropped to nothing) so the caller's expansion/unreadable
    checks still see that the word carried something this module could not read."""
    out: List[str] = []
    for kind, payload in pieces:
        if kind == "lit":
            out.append(payload)
        elif kind == "var":
            out.append(assigns.get(payload, "$" + payload))
        elif sentinel and kind in ("subst", "unreadable"):
            out.append("$(…)")
    return "".join(out)


def _word_is_resolvable_literal(word: _Word, assigns: Dict[str, str]) -> bool:
    for kind, payload in word.pieces:
        if kind == "subst" or kind == "unreadable":
            return False
        if kind == "var" and payload not in assigns:
            return False
    return True


def _collect_assignments(segments: List[List[_Word]], assigns: Dict[str, str]) -> None:
    """One-hop literal `VAR=value` assignments, read left to right (a later value may use an earlier var)."""
    for words in segments:
        for w in words:
            if w.is_redirect or w.has_subst:
                break
            flat = _fold_pieces(w.pieces, assigns)
            m = _ASSIGN.match(flat)
            if not m:
                break
            if _word_is_resolvable_literal(w, assigns):
                assigns[m.group(1)] = m.group(2)
            else:
                break


# ---- building simple commands (with container recursion) ------------------------------------------------------------

def _basename(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def _strip_known_path(prog: str) -> str:
    base = _basename(prog)
    return base if base.lower() in _KNOWN_BINARIES else prog


# How a word re-parsed from a container's code is SPELLED in the original command: the raw view masks a data word
# only at its exact original spelling. An encoder is ("q", "id") — verbatim (single-quoted, a heredoc body, a plain
# word); ("q", "dq") — inside double quotes (`"`, `\\`, `$`, `` ` `` carry a backslash); ("map", {inner: outer}) —
# a snippet re-joined from whole words; ("q", "x") — unknown (nothing is masked: the raw view stays strict).
_Encoder = Tuple[str, object]
_ENC_ID: _Encoder = ("q", "id")
_ENC_UNKNOWN: _Encoder = ("q", "x")


def _quoting(w: "_Word") -> _Encoder:
    raw = w.raw
    if len(raw) >= 2 and raw[0] == "'" and raw[-1] == "'" and "'" not in raw[1:-1]:
        return _ENC_ID
    if len(raw) >= 2 and raw[0] == '"' and _read_dquote(raw, 0)[1] == len(raw):
        return ("q", "dq")
    if raw and not re.search(r"[\\'\"$`]", raw):
        return _ENC_ID
    return _ENC_UNKNOWN


def _word_map(words: List["_Word"], assigns: Dict[str, str], quote: bool) -> _Encoder:
    """An encoder for a snippet re-joined from whole words (each folded, optionally shlex-quoted)."""
    table: Dict[str, str] = {}
    for w in words:
        flat = _fold_pieces(w.pieces, assigns, sentinel=True)
        key = shlex.quote(flat) if quote else flat
        if not quote and (not flat or re.search(r"[\s\\'\"$`;&|<>()]", flat)):
            continue
        table[key] = w.raw
    return ("map", table)


def _encode(raw: str, chain: Tuple[_Encoder, ...]) -> Optional[str]:
    for kind, how in chain:
        if kind == "map":
            mapped = how.get(raw)  # type: ignore[union-attr]
            if mapped is None:
                return None
            raw = mapped
        elif how == "dq":
            raw = re.sub(r'([\\"$`])', r"\\\1", raw)
        elif how != "id":
            return None
    return raw


@dataclass
class _Ctx:
    assigns: Dict[str, str]
    out: List[SimpleCommand]
    data: List[str] = field(default_factory=list)
    heredocs: List[Tuple[str, bool]] = field(default_factory=list)   # (body, body expands $… / `…`)
    poisoned: bool = False      # some code ran from a source this module cannot read: no word is "pure data"
    unknown_consumer: bool = False  # r7: some piped/redirected data reaches a consumer that is not known
    overflow: bool = False      # r7: some code nested past _MAX_DEPTH was not read
    keep_data: bool = False     # r7: keep data-sink arguments as argv (the reading with the mask OFF)


@dataclass
class _Parsed:
    prog: str
    rest: List[Tuple[str, _Word]]
    runner: str
    unresolvable: bool
    redirects: List[_Word]
    prog_word: Optional[_Word] = None


# Shells that run the script on their stdin when they are given no `-c` and no script file.
_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"})
# Interpreters: their `-c`/`-e`/`--eval` argument is code, and with no script operand (or `-`) so is their stdin.
_INTERP = re.compile(r"^(python[\d.]*|pypy[\d.]*|node|nodejs|bun|deno|tsx|ts-node|ruby|perl[\d.]*|php[\d.]*|osascript"
                     r"|swift|lua[\d.]*|luajit|tclsh[\d.]*)$")
# family → (short-flag letters whose cluster takes the code as the next word, long code flags, flags taking a value)
_INTERP_SPEC: Dict[str, Tuple[str, Tuple[str, ...], frozenset]] = {
    "python": ("c", (), frozenset({"-W", "-X", "-Q"})),
    "node": ("ep", ("--eval", "--print"), frozenset({"-r", "--require", "--import", "--loader", "--input-type",
                                                     "--experimental-loader", "-C", "--conditions"})),
    "deno": ("", (), frozenset()),
    "ruby": ("e", (), frozenset({"-I", "-r", "-C", "-E", "-F"})),
    "perl": ("eE", (), frozenset({"-I", "-M", "-m"})),
    "php": ("r", (), frozenset({"-c", "-d", "-z"})),
    "osascript": ("e", (), frozenset({"-l", "-s"})),
    "other": ("e", (), frozenset()),
}


def _interp_family(base: str) -> str:
    if base.startswith(("python", "pypy")):
        return "python"
    if base in ("node", "nodejs", "bun", "tsx", "ts-node"):
        return "node"
    for fam in ("deno", "ruby", "perl", "php", "osascript"):
        if base.startswith(fam):
            return fam
    return "other"


def _interp_parse(base: str, flats: List[str]) -> Tuple[List[str], bool]:
    """(code given by flags, whether stdin is code): `python3 -c CODE`, `node -e CODE`, `osascript -e A -e B`,
    `deno eval CODE` give code; `python3 -`, a bare `node`, `osascript -l JavaScript` read their code from stdin; a
    script operand (`python3 x.py`, `python3 -m mod`) means stdin is data."""
    fam = _interp_family(base)
    letters, longs, valued = _INTERP_SPEC[fam]
    code: List[str] = []
    script = False
    k = 0
    while k < len(flats):
        tok = flats[k]
        if tok == "-":
            break
        if tok == "--":
            script = k + 1 < len(flats) and flats[k + 1] != "-"
            break
        if fam == "deno" and not tok.startswith("-"):
            if tok == "eval" and k + 1 < len(flats):
                code.append(flats[k + 1])
            else:
                script = True
            break
        if tok.startswith("--"):
            name, eq, val = tok.partition("=")
            if name in longs:
                if eq:
                    code.append(val)
                    k += 1
                elif k + 1 < len(flats):
                    code.append(flats[k + 1])
                    k += 2
                else:
                    k += 1
                continue
            k += 2 if (name in valued and not eq) else 1
            continue
        if tok.startswith("-") and len(tok) > 1:
            if fam == "python" and tok.endswith("m"):
                script = True
                break
            if tok in valued:
                k += 2
                continue
            if letters and tok[-1] in letters and k + 1 < len(flats):
                code.append(flats[k + 1])
                if fam == "python":
                    break           # `python -c CODE args…`: everything after the code is argv
                k += 2
                continue
            k += 1
            continue
        script = True
        break
    if code:
        return code, False
    return code, not script


def _shell_reads_stdin(flats: List[str]) -> Optional[bool]:
    """True when a shell runs its stdin, False when it runs a script FILE, None when it runs `-c` code (the
    container branch reads that)."""
    k = 0
    while k < len(flats):
        tok = flats[k]
        if tok == "-":
            return True
        if tok == "--":
            return k + 1 >= len(flats)
        if tok.startswith("--"):
            k += 2 if tok in ("--rcfile", "--init-file") else 1
            continue
        if tok[:1] in "-+" and len(tok) > 1:
            if tok in ("-o", "+o", "-O", "+O"):
                k += 2
                continue
            if tok.startswith("-") and "c" in tok[1:]:
                return None
            if tok.startswith("-") and "s" in tok[1:]:
                return True
            k += 1
            continue
        return False
    return True


def _executor(p: _Parsed) -> Tuple[str, bool]:
    """(kind, runs a file): kind is "shell" / "interp" when the command runs CODE from its stdin, "xargs" when it
    turns its stdin into argv, "" otherwise. ``runs a file`` marks a shell/interpreter/`source` running a script
    file this module cannot read."""
    base = _basename(p.prog)
    flats = [f for f, _ in p.rest]
    if base in _SHELLS:
        reads = _shell_reads_stdin(flats)
        return ("shell", False) if reads else ("", reads is False)
    if base in ("source", "."):
        if flats and flats[0] in ("/dev/stdin", "/dev/fd/0", "-"):
            return "shell", False
        return "", bool(flats)
    if _INTERP.match(base):
        code, reads = _interp_parse(base, flats)
        if reads:
            return "interp", False
        return "", not code
    if base == "xargs":
        return "xargs", False
    return "", False


def _consumer_known(p: Optional[_Parsed]) -> bool:
    """r7 U: a consumer of piped/redirected data is KNOWN when it is an executor (a shell, `source`, an interpreter,
    `xargs` — whatever their flags, their input is modelled as code or argv) or a NON-EXECUTING program used without
    an exec flag. Anything else — including a segment this module cannot parse or a program word it cannot read — is
    unknown."""
    if p is None or p.unresolvable or not p.prog:
        return False
    base = _basename(p.prog)
    if base in _SHELLS or base in ("source", ".", "xargs") or _INTERP.match(base):
        return True
    if base not in NON_EXECUTING:
        return False
    flags = _EXEC_FLAGS.get(base, ())
    return not any(_is_exec_flag(f, flags) for f, _ in p.rest)


def _is_exec_flag(word: str, flags: Tuple[str, ...]) -> bool:
    """r7b i2: ``word`` names one of ``flags`` — exactly, or as a GNU long-option abbreviation (``getopt_long``
    accepts any unambiguous prefix; an ambiguous one is matched too, fail closed). A bare ``--`` names nothing."""
    name = word.split("=", 1)[0]
    if name in flags:
        return True
    return name.startswith("--") and len(name) > 2 and any(f.startswith("--") and f.startswith(name) for f in flags)


def _emit_nested(text: str, ctx: _Ctx, depth: int, live: bool, chain: Tuple[_Encoder, ...] = ()) -> None:
    """Read code nested one level deeper — or, past ``_MAX_DEPTH``, record that it was NOT read (r7 m-d: overflow
    is unknown, never silent)."""
    if depth < _MAX_DEPTH:
        _emit_segments(text, ctx, depth + 1, live, chain)
    else:
        ctx.overflow = True


def _parse(words: List[_Word], ctx: _Ctx) -> Optional[_Parsed]:
    """One simple command's words → its program (after assignments, keywords, wrappers and runners) and argv."""
    folded: List[Tuple[str, _Word]] = []
    redirects: List[_Word] = []
    for w in words:
        if w.is_redirect:
            redirects.append(w)
            continue
        folded.append((_fold_pieces(w.pieces, ctx.assigns), w))

    idx = 0
    runner = ""
    while idx < len(folded):
        flat, w = folded[idx]
        if not flat and not w.has_subst:
            idx += 1
            continue
        if _ASSIGN.match(flat) and not w.has_subst:
            idx += 1
            continue
        base = _basename(flat.lower())
        if base in _KEYWORDS or flat in _KEYWORDS:
            idx += 1
            continue
        if base in _WRAPPERS:
            idx += 1
            # env/sudo consume VAR=val and -opts; others consume leading -opts
            while idx < len(folded):
                nxt = folded[idx][0]
                if nxt.startswith("-") or (base in ("env", "sudo") and _ASSIGN.match(nxt)):
                    idx += 1
                    continue
                break
            continue
        if base in _RUNNERS:
            sub = _RUNNER_SUBWORDS.get(base)
            runner = base
            idx += 1
            while idx < len(folded) and folded[idx][0].startswith("-"):
                idx += 1
            if sub and idx < len(folded) and folded[idx][0].lower() == sub:
                idx += 1
                while idx < len(folded) and folded[idx][0].startswith("-"):
                    idx += 1
            continue
        if base == "timeout":
            idx += 1
            while idx < len(folded) and folded[idx][0].startswith("-"):
                idx += 1
            if idx < len(folded) and _DURATION.match(folded[idx][0]):
                idx += 1
            continue
        break

    if idx >= len(folded):
        if redirects:
            return _Parsed("", [], runner, False, redirects)
        return None

    prog_flat, prog_word = folded[idx]
    unresolvable = prog_word.has_subst \
        or any(k in ("subst", "unreadable") for k, _ in prog_word.pieces) \
        or (any(k == "var" for k, _ in prog_word.pieces) and not _word_is_resolvable_literal(prog_word, ctx.assigns))
    prog = "" if (unresolvable and not prog_flat) else _strip_known_path(prog_flat).lower()
    return _Parsed(prog, folded[idx + 1:], runner, unresolvable, redirects, prog_word)


_Stream = Tuple[str, bool, _Encoder]     # (text, fully known, how its words are spelled in the original)


def _stdin_redirect(p: _Parsed, ctx: _Ctx) -> Optional[_Stream]:
    """The stdin a command's own redirects give it: a heredoc body, a here-string, or a file (unreadable). The last
    stdin redirect wins, as in the shell. ``None`` when it has none."""
    stdin: Optional[_Stream] = None
    for w in p.redirects:
        op = w.op.lstrip("0123456789") if w.op[:1] in "0" or not w.op[:1].isdigit() else ""
        if op == "<<":
            mark = _HEREDOC_MARK.match(_fold_pieces(w.pieces, {}))
            if mark and int(mark.group(1)) < len(ctx.heredocs):
                stdin = (ctx.heredocs[int(mark.group(1))][0], True, _ENC_ID)
            else:
                stdin = ("", False, _ENC_UNKNOWN)
        elif op == "<<<":
            stdin = (_fold_pieces(w.pieces, ctx.assigns, sentinel=True) + "\n",
                     _word_is_resolvable_literal(w, ctx.assigns), _quoting(w))
        elif op in ("<", "<&", "<>"):
            stdin = ("", False, _ENC_UNKNOWN)
    return stdin


_PRINTF_SPEC = re.compile(r"%(%|[-+ #0]*\d*(?:\.\d+)?[sbdiqcuxXoefgEG])")


def _printf(fmt: str, vals: List[str]) -> str:
    fmt = _decode_ansi_c(fmt)
    specs = [m for m in _PRINTF_SPEC.finditer(fmt) if m.group(1) != "%"]
    if not specs or not vals:
        return _PRINTF_SPEC.sub(lambda m: "%" if m.group(1) == "%" else "", fmt)
    out: List[str] = []
    pos = [0]

    def rep(m: "re.Match[str]") -> str:
        if m.group(1) == "%":
            return "%"
        v = vals[pos[0]] if pos[0] < len(vals) else ""
        pos[0] += 1
        return _decode_ansi_c(v) if m.group(1).endswith("b") else v

    while pos[0] < len(vals) and len(out) < 64:
        out.append(_PRINTF_SPEC.sub(rep, fmt))
    return "".join(out)


def _decode_base64(text: str) -> Optional[str]:
    compact = re.sub(r"\s+", "", text)
    try:
        raw = base64.b64decode(compact + "=" * (-len(compact) % 4), validate=False)
    except (binascii.Error, ValueError):
        return None
    return raw.decode("utf-8", errors="replace")


def _stdout_of(p: _Parsed, stdin: Optional[_Stream], ctx: _Ctx) -> _Stream:
    """What a command writes to its stdout, as far as it can be read without running anything: a literal
    `echo`/`printf`, and `cat`/`tee`/`base64 -d`/`xxd -r -p` applied to a readable stdin. ``(text, known)``."""
    base = _basename(p.prog)
    words = [w for _, w in p.rest]
    flats = [_fold_pieces(w.pieces, ctx.assigns, sentinel=True) for w in words]
    known = all(_word_is_resolvable_literal(w, ctx.assigns) for w in words)
    if base == "echo":
        k = 0
        while k < len(flats) and re.match(r"^-[neE]+$", flats[k]):
            k += 1
        text = " ".join(flats[k:])
        decoded = _decode_ansi_c(text)
        enc = _quoting(words[k]) if len(words) == k + 1 else _word_map(words[k:], ctx.assigns, False)
        if decoded != text:
            return text + "\n" + decoded + "\n", known, _ENC_UNKNOWN
        return text + "\n", known, enc
    if base == "printf":
        if flats[:1] == ["-v"]:
            return "", True, _ENC_UNKNOWN
        args = flats[1:] if flats[:1] == ["--"] else flats
        if not args:
            return "", True, _ENC_UNKNOWN
        return _printf(args[0], args[1:]) + "\n" + " ".join(args[1:]), known, _ENC_UNKNOWN
    src: _Stream = stdin if stdin is not None else ("", False, _ENC_UNKNOWN)
    operands = [f for f in flats if not f.startswith("-") or f == "-"]
    if base == "cat" and all(o == "-" for o in operands):
        return src
    if base == "tee":
        return src
    if base == "base64" and any(f in ("-d", "-D", "--decode") for f in flats):
        decoded = _decode_base64(src[0]) if src[1] else None
        return (decoded, True, _ENC_UNKNOWN) if decoded is not None else ("", False, _ENC_UNKNOWN)
    if base == "xxd" and "-r" in flats and any(f in ("-p", "-ps", "-plain") for f in flats):
        try:
            return bytes.fromhex(re.sub(r"\s+", "", src[0])).decode("utf-8", errors="replace"), src[1], _ENC_UNKNOWN
        except ValueError:
            return "", False, _ENC_UNKNOWN
    return "", False, _ENC_UNKNOWN


def _emit_parsed(p: _Parsed, ctx: _Ctx, depth: int, stdin: Optional["_Stream"], consumed: bool,
                 live: bool, local_data: List[str], chain: Tuple[_Encoder, ...]) -> None:
    """Turn one parsed simple command into a ``SimpleCommand`` (and recurse into any code it carries)."""
    prog, rest = p.prog, p.rest
    # containers: the code they carry really runs, so unwrap it into its own commands; the indices it consumes
    # as code are NOT kept as this command's own args (they are represented by the emitted inner commands).
    code_indices = _unwrap_container(prog, rest, ctx, depth, live or consumed, chain)
    # a substitution in a redirect target runs too (`cat x > $(…)`), and so does one in an unquoted heredoc body
    # a substitution in the program word itself (`x=$(…)`, `$(…) 4242`) runs before anything else
    for kind, payload in (p.prog_word.pieces if p.prog_word is not None else []):
        if kind == "subst" and payload.strip():
            _emit_nested(payload, ctx, depth, True)
    for w in p.redirects:
        for kind, payload in w.pieces:
            if kind == "subst" and payload.strip():
                _emit_nested(payload, ctx, depth, True)
        mark = _HEREDOC_MARK.match(_fold_pieces(w.pieces, {})) if w.op.endswith("<<") else None
        if mark and int(mark.group(1)) < len(ctx.heredocs):
            body, expands = ctx.heredocs[int(mark.group(1))]
            if expands:
                for kind, payload in _expand_dquote(body)[0]:
                    if kind == "subst" and payload.strip():
                        _emit_nested(payload, ctx, depth, True)

    if not prog and not p.unresolvable:
        return
    base_prog = _basename(prog)
    is_sink = (base_prog in _DATA_SINKS and not (base_prog == "printf" and rest[:1] and rest[0][0] == "-v")) \
        or (base_prog == "git" and bool(rest) and rest[0][0].lower() in _GIT_DATA_SUBCMDS)
    args: List[str] = []
    for k, (flat, w) in enumerate(rest):
        if k in code_indices:
            continue
        # a substitution embedded in an argument already runs as its own emitted command; keep its resolved parts
        # only. Data-sink arguments that carry no live substitution are data, never commands — and when their output
        # reaches nothing that runs it, their raw text is recorded for the classifier's raw view.
        if is_sink and not w.has_subst:
            if not (consumed or live):
                spelled = _encode(w.raw, chain)
                if spelled:
                    local_data.append(spelled)
            if not ctx.keep_data:
                continue
        args.append(_fold_pieces(w.pieces, ctx.assigns, sentinel=True))

    cmd = SimpleCommand(prog=prog, args=args, unresolvable=p.unresolvable, runner=p.runner)
    if _INTERP.match(base_prog):
        cmd.code.extend(_interp_parse(base_prog, [f for f, _ in rest])[0])
    kind, runs_file = _executor(p)
    if runs_file:
        ctx.poisoned = True
    if kind in ("shell", "interp") and stdin is not None:
        text, known, enc = stdin
        if not known:
            # code from a source this module cannot read (`curl … | sh`, `sh < file`): fail closed
            cmd.unresolvable = True
            ctx.poisoned = True
        if text.strip():
            if kind == "interp":
                cmd.code.append(text)
            else:
                _emit_nested(text, ctx, depth, live or consumed, (enc,) + chain)
    ctx.out.append(cmd)


def _unwrap_container(prog: str, rest: List[Tuple[str, _Word]], ctx: _Ctx, depth: int, live: bool,
                      chain: Tuple[_Encoder, ...] = ()) -> set:
    """Emit the commands carried inside a container program. Returns the ``rest`` indices consumed as code."""
    consumed: set = set()
    inner_snippets: List[Tuple[str, _Encoder]] = []
    substs: List[str] = []
    # the code a container carries is re-parsed, so it must keep its live substitutions (a `$(…)` inside a
    # `bash -lc "…"` string is still an unreadable target) — render it with the sentinel, never the bare fold.
    def code(word: _Word) -> str:
        return _fold_pieces(word.pieces, ctx.assigns, sentinel=True)

    # r7 m-d: the code is collected at every depth; past _MAX_DEPTH it is not read (``_emit_nested`` records the
    # overflow) and its words stay this command's argv, as before.
    if prog in _SHELLS:
        for k in range(len(rest)):
            flat = rest[k][0]
            if flat.startswith("-") and not flat.startswith("--") and "c" in flat.lstrip("-"):
                if k + 1 < len(rest):
                    inner_snippets.append((code(rest[k + 1][1]), _quoting(rest[k + 1][1])))
                    consumed.add(k + 1)
                break
    elif _basename(prog) == "it" and rest and rest[0][0].lower() in _IT_CARRIERS:
        # a pane proxy (V3-D): `it exec|run|send|spawn [--surface X …] <text>` runs <text> in another shell.
        k = 1
        parts: List[str] = []
        part_words: List[_Word] = []
        while k < len(rest):
            flat = rest[k][0]
            if flat.startswith("--") and "=" not in flat and flat[2:] in _IT_VALUE_OPTS:
                consumed.update((k, k + 1))
                k += 2
                continue
            if flat.startswith("-") and not parts:
                consumed.add(k)
                k += 1
                continue
            parts.append(code(rest[k][1]))
            part_words.append(rest[k][1])
            consumed.add(k)
            k += 1
        if parts:
            # the carried argv, both as argv (each word re-quoted) and as the line a pane would re-parse — the
            # receiving shell may do either, so both are read (fail closed).
            inner_snippets.append((" ".join(shlex.quote(p) for p in parts), _word_map(part_words, ctx.assigns, True)))
            inner_snippets.append((" ".join(parts), _ENC_UNKNOWN))
    elif prog == "eval":
        enc = _quoting(rest[0][1]) if len(rest) == 1 else _word_map([w for _, w in rest], ctx.assigns, False)
        inner_snippets.append((" ".join(code(w) for _, w in rest), enc))
        consumed.update(range(len(rest)))
    elif prog == "trap" and rest:
        inner_snippets.append((code(rest[0][1]), _quoting(rest[0][1])))
        consumed.add(0)
    elif prog == "find":
        joined = [f for f, _ in rest]
        if "-exec" in joined:
            k = joined.index("-exec") + 1
            piece = []
            piece_words: List[_Word] = []
            while k < len(joined) and joined[k] not in (";", "+", "\\;"):
                piece.append(code(rest[k][1]))
                piece_words.append(rest[k][1])
                consumed.add(k)
                k += 1
            if piece:
                inner_snippets.append((" ".join(piece), _word_map(piece_words, ctx.assigns, False)))

    # a substitution carried anywhere in the remaining words also runs as its own command — and its output is
    # consumed by this command, so nothing inside it is pure data
    for flat, w in rest:
        for kind, payload in w.pieces:
            if kind == "subst" and payload.strip():
                substs.append(payload)

    for snippet, enc in inner_snippets:
        if snippet and snippet.strip():
            _emit_nested(snippet, ctx, depth, live, (enc,) + chain)
    for snippet in substs:
        _emit_nested(snippet, ctx, depth, True)
    return consumed if depth < _MAX_DEPTH else set()


_PROC_SUBST = re.compile(r"[<>]\(")


def _unquoted(text: str) -> str:
    """``text`` with every quoted region blanked (for the operator scans that must not see data)."""
    return re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", " ", text)


def _emit_segments(text: str, ctx: _Ctx, depth: int, live: bool = False, chain: Tuple[_Encoder, ...] = ()) -> None:
    """Emit every simple command of ``text``. ``live``: this text's output is consumed by something that may run
    it (a substitution, a pipe into a shell), so no argument in it is pure data."""
    text = _lift_heredocs(text, ctx)
    if _PROC_SUBST.search(_unquoted(text)):
        # `>(sh)` / `<(…)`: a process substitution feeds a command this module does not model — nothing is data
        ctx.poisoned = True
    parts = _split_top_ops(text)
    lexed = [(_tokenise(seg), op) for seg, op in parts]
    # one-hop assignments are collected for THIS scope too, so a `V=kill; $V` inside `sh -c '…'` resolves.
    _collect_assignments([words for words, _ in lexed], ctx.assigns)
    pipelines: List[List[List[_Word]]] = []
    current: List[List[_Word]] = []
    for words, op in lexed:
        current.append(words)
        if op not in ("|", "|&"):
            pipelines.append(current)
            current = []
    if current:
        pipelines.append(current)

    local_data: List[str] = []
    for pipe in pipelines:
        parsed = [_parse(words, ctx) if words else None for words in pipe]
        kinds = [_executor(p)[0] if p is not None else "" for p in parsed]
        prev: Optional[_Stream] = None
        for k, p in enumerate(parsed):
            if p is None:
                # an empty or keyword-only segment (`}`, `done`, `fi`): a compound's output this module cannot read
                if k > 0:
                    ctx.unknown_consumer = True     # r7 U: what consumes the piped data is not known
                prev = ("", False, _ENC_UNKNOWN)
                continue
            stdin = _stdin_redirect(p, ctx)
            # r7 U (m-b): piped or redirected data counts as data only when its consumer is known not to run it
            if (k > 0 or stdin is not None) and not _consumer_known(p):
                ctx.unknown_consumer = True
            if stdin is None and k > 0:
                stdin = prev if prev is not None else ("", False, _ENC_UNKNOWN)
            consumed = any(kinds[m] for m in range(k + 1, len(parsed)))
            _emit_parsed(p, ctx, depth, stdin, consumed, live, local_data, chain)
            prev = _stdout_of(p, stdin, ctx)
    ctx.data.extend(local_data)


# ---- the public entry point -----------------------------------------------------------------------------------------

def _render_text(commands: List[SimpleCommand]) -> str:
    return " ; ".join(c.candidate for c in commands if c.candidate)


def normalize(cmd: str, keep_data: bool = False) -> NormalizedCommand:
    """Fold ``cmd`` to the simple commands it runs. Pure; never executes anything. ``keep_data``: the reading with
    the data mask OFF — data-sink arguments stay in argv (and in ``text``), so nothing is dropped (r7 U)."""
    if not isinstance(cmd, str) or not cmd.strip():
        return NormalizedCommand(text="", commands=[], unresolvable=False, data_kept=keep_data)

    ctx = _Ctx(assigns={}, out=[], keep_data=keep_data)
    try:
        _emit_segments(cmd, ctx, 0)
    except (RecursionError, ValueError):
        # a pathological line: hand back the raw text and declare it unreadable (the caller fails closed)
        return NormalizedCommand(text=cmd, commands=[SimpleCommand(prog="", args=[], unresolvable=True)],
                                 unresolvable=True, data_kept=keep_data)

    commands = ctx.out
    unresolvable = any(c.unresolvable for c in commands)
    text = _render_text(commands) or cmd
    data = [] if ctx.poisoned else [w for w in ctx.data if w.strip()]
    return NormalizedCommand(text=text, commands=commands, unresolvable=unresolvable, data=data,
                             unknown_consumer=ctx.unknown_consumer, overflow=ctx.overflow, data_kept=keep_data)


def mask_data(command: str, data: List[str]) -> str:
    """``command`` with every word the normaliser read as pure data blanked to ``_`` — the classifier's raw view.
    A data word is blanked only when EVERY occurrence of its text in ``command`` is accounted for by a data word
    (an occurrence that might also be live text keeps the whole word visible: the raw view errs strict)."""
    if not data:
        return command
    out = command
    for word, count in sorted(Counter(data).items(), key=lambda item: -len(item[0])):
        seen = out.count(word)
        if 0 < seen <= count:
            out = out.replace(word, "_")
    return out
