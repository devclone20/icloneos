"""icloneOS F40, ruling L1: the one floor Ignore all keeps, total destruction of the machine.

A check on the text of a command, never a kernel wall: a determined program can go round it, and the Ignore alert says
so, and an obfuscated command gets past it. Every other mode refuses these too. Near misses must stay out: a project
subfolder, a path that merely contains a home, a read of the same tool (``diskutil list``, ``csrutil status``, ``nvram -p``).

F50, ruling S3: what is written plainly on the line is read: assignments, ``for``, braces, ``pushd``, wrappers and pipes
into ``xargs``. A broad recursive delete of a value only known when it runs (``rm -rf $X``, ``rm -rf "$X"/*``) is the floor.

P4: a target is folded as if every expansion the line did not set were empty. If what is left is the disk, a home or a
system root (``"$HOME/$X"``, ``~/"$X"``, ``/"$X"``, ``"$X"/``), it is total destruction for the forms listed here
(P5b and P5d narrow it). A written part that is not a root (``"$HOME/build"``, ``"$T/sub"``) keeps it ordinary work.

P5 (lead rulings): total destruction needs a written root or home part (``/"$X"``, ``~/"$X"``, ``"$HOME/$X"``) or a fold
that is literally one (``${X:-/}``, ``${X-$HOME}``, ``${HOME%/*}``, ``$'/'``, an array of ``"$HOME"``). A target that is
only expansions with slashes or globs (``"$OUT_DIR/"``, ``"$X"/*``) is the unresolved floor. ``${X:-w}`` is read as w.
$PWD is the call's folder, $OLDPWD the one a ``cd`` on the line left, $TMPDIR the runtime's (else /tmp). The literal part
is resolved through links (``/Volumes/Macintosh HD/`` is /), and the Data volume's firmlinks are the roots they mirror. A
``cd`` or ``pushd`` meets the same reading: into a root it is that root; into a folder it cannot read, a later delete of
``.``, ``*`` or ``./*`` is unresolved.

P5b (lead rulings): links are resolved component by component BEFORE ``..`` is applied (``d/..`` with d -> ~/Documents is
the home), and a link is only followed when the operand goes on past it (``rm -rf link`` removes the link). What a path
resolves to is then compared by identity (device and inode) with the protected folders, so a case change, ``//``, an
escaped space or a chain of links is the same folder. Paths under /net, /Network, /home and the autofs mounts are never
looked up (no hang): they are read as written. A target whose FIRST part is an expansion the line did not set
(``"$DESTDIR/usr"``) is the unresolved floor, never total destruction: only an empty value makes it a root, and the owner
can approve it. It reads the text of a command; it is not a wall.

P5c (review p6-lens-code): ``${X:+w}`` and ``${X+w}`` of a name the line did not set are w OR nothing: both are read and the
worse answer stands (``"${X:+build}"/*`` is ``"$X"/*``); ``${HOME:+w}`` is w. ``${X:-}`` is ``$X``. ``rm``, ``mv``
(D11: it renames the link, never what it points to) and ``find`` without -H, -L or -follow act on a link operand
itself; every other program, a ``cd`` and an rsync destination follow it. ``~/`` and ``$HOME/`` are resolved through
links like the absolute spelling. ``find`` with -H, -L or -follow and a delete follows the links below its start points
(-H is read the same as -L): unless a start point is already a root, it is the unresolved floor with its own reason.

P5d (pass 5, lead): a delete target is expanded by bash itself, never by a copy of its rules: every word of a line is
given to one ``/bin/bash`` call (empty env, ``set -f``, cwd /, 2 s timeout, one subshell per reading), kept per word and
per set/unset choice across the line's commands and detection variants; a word with only quotes on it is read without
bash. A construct that runs something (``$(...)``, backticks, ``$((...))``, ``${!X}``, ``${X@P}``) is never given to bash:
an unknown name stands in for it. A name the line did not set is read unset and set, and the worse answer stands;
``unset``, ``export -n``, ``declare -n`` and ``read`` make a name unknown again. More than four unknown names in a word, a
word never closed, a brace range too large to list, or a bash call that fails or times out is the unresolved floor (fail
closed). M1: an option ``rm``/``grm`` do not know is read as a recursive one (at least unresolved, never skipped), a GNU
long option is any unambiguous prefix of one (``--rec`` is ``--recursive``), and an option rsync is not known to take
with a delete is unresolved. M7: ``find -exec``/``-execdir``/``-ok`` with ``grm``, ``gunlink`` or ``grmdir`` deletes.

P5e (pass 5e): a word reaches the floor's bash only if it matches a small closed grammar; any other form (a named array
subscript, ``${!X}``, ``${X@P}``, a tilde with a name) is an unknown value and never reaches bash. That bash is restricted
to ``printf``, has a CPU limit, runs in its own session and is killed as a group.

P5f (pass 5f): a tilde reaches bash only at the very start of a word, as ``~`` or ``~/``; ``$_`` and the special
parameters are never names. After a line sets ``IFS``, a target with an unquoted expansion is unresolved; after it sets
``CDPATH``, or with ``CDPATH`` in the environment, a relative ``cd`` is. ``popd``, a bare ``pushd``, ``pushd`` with
``+N``, ``-N`` or ``-n`` and ``cd -`` make the folder unknown. A glob that can, by its text alone, name a protected folder
or a home (``/Us?rs``) is total destruction. A line has one counted budget of reading steps; past it, it is unresolved.

P5g (pass 5g): a ``cd`` never replaces the folder. A delete is judged in the call's own folder and in every earlier
``cd``/``pushd`` target on the line (a ``cd`` may fail, or run in a subshell, a pipe or a branch); the worse reading wins.
A bare ``cd`` is the home (a single written ``HOME=`` before it is that folder); ``cd ""`` stays in the folder. After a
``cd`` to a name the line did not set, a later delete is read as P5h says. Unresolved too: a ``cd`` with a redirection
(P5h: other than its output or errors to /dev/null), or with an assignment before it other than that ``HOME=``; ``shopt``,
``alias``, ``unalias`` or a function named ``cd``, ``pushd`` or ``popd`` on the line; ``source`` or ``.``; ``env -C``,
``sudo -D`` or ``--chdir`` with a folder it cannot read; a negated set or a class in a delete target; any other glob in a
name right under /, /Users, /Volumes, /private or a home's parent. An unquoted ``#`` starts a comment only at the start
of a word (after a blank or one of ``;&|()``, never after a carriage return); a line with ``$( )`` or a backtick and a
``#`` is also read with each such ``#`` as a comment, and the worse reading wins.

P5h (pass 5h): in a folder the floor cannot read, a relative delete target that could name a root (., a leading glob or
brace, any .., a protected folder's, a volume's or a home's name first) is unresolved; a call folder that is not an
absolute path is a folder it cannot read; ``env -C/``, ``env -iC/``
and ``sudo -D/`` name the folder written after the letter. A word naming ``CDPATH`` (other than reading it) makes every
relative ``cd`` unknown; one naming ``HOME`` makes a bare ``cd`` and every word that starts with ``~`` unknown. A delete
joined to a ``cd`` by ``&&`` alone, in the same list (a newline right after ``&&`` continues it), is judged in that
``cd``'s folder only, when it is read; any other join keeps every folder. After an ``ln`` on the line, a path through a
folder or a glob in a delete is unresolved; a bare name is exempt only for rm, rmdir, unlink or a plain find (they act
on the link), never for a cd, an rsync destination or find -L; a link made another way is not seen.
``git [-C DIR] clean`` with ``-f`` (with or without ``-d``) deletes each path it is given, else ``DIR/*``; an option or pathspec it
cannot read is unresolved. P5i: a ``cd`` is judged logically (.. before links) and physically, the worse wins; a ``cd`` in
a loop, any function defined on the line (P5n), or a trap, makes the folder
unknown; ``cd "$(mktemp -d)"`` is a fresh temp folder. A total
destruction read only in a folder the line may be in when a ``cd`` failed or did not run is capped at unresolved. rimraf, cmake -E and a language's own delete
call are not read.

P5j-P5p: trap -- CODE reads the code after --; GIT_CONFIG*/GIT_WORK_TREE/GIT_DIR/core.worktree on the line make a git
clean unresolved; a function defined on the line, a word written with quotes/escapes/$/braces/backticks/commas, or
cd/pushd/popd/source as any word leave the folder unknown after that command; alias in command position, or alias name=
anywhere on a line with more than one command, is unresolved. Kept limit: one command is read at a time.

P5q-P5s: a glob that can match a folder word (with or without letters) and ``. --`` leave the folder unknown; after a
wrapper or launcher from the closed list ``_LAUNCHERS`` (also its Homebrew g-prefixed copy), any later word that is rm,
find, rsync or git is judged as that command, a quoted word starting with one is read as code, and env's ``-S``/
``--split-string`` value is read as code; a wrapper with no program after its options is still judged. A launcher not
on the list is not read.

P5t-P5x: a delete target that is the literal text $HOME or ${HOME}, alone or followed only by / and glob tokens, bracket
sets (also one that opens with ], is negated or holds a class such as [:alpha:]) or ., is read as the home (fail closed; a literal ~ is not, nor a literal $HOME with
a real name after it or reached by a cd); a last name made only of glob tokens with a * in it (?*, *?, ??*, [a-z]*,
[]a-z]*, .?*) is read as every name in the folder, as * is, while a negated set ([! [^) stays unread; an extglob
pattern (@( !( +( ?( *( up to its own closing parenthesis, inside one word: no space, quote, $ or ; & < > ` in it) is
read as a value the floor does not read, and an opener left without its closing parenthesis is read the same way,
with the line unresolved at least when it names a delete program (the detection variants split a pattern at ( and |, so
in practice a delete line with any extglob pattern is at least unresolved); a globbed program name is not read, except the
test command [ and the keyword [[.
P5y-P5y9: what the floor does not read is refused by category (unread brace words, IFS with an unquoted $,
positional parameters on a delete line, a decoded $'..' delete, an unread program with a recursive flag, a
substitution body read on its own, a leading redirection moved away, the worst case of a delete whose flag or target
is an expansion, eval/env -S/-c code read again, a name set once on the line to written text read as that text):
see _unread_by_category and _unread_by_category_more (P5y4-P5y9); a name is read as written text only
as _set_once allows (P5y9).
"""
from __future__ import annotations

import codecs
import fnmatch
import itertools
import os
import posixpath
import re
import pwd
import shlex
import signal
import stat
import subprocess
import threading
import unicodedata
from fnmatch import fnmatchcase
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from typing import Dict, FrozenSet, Iterator, List, Optional, Tuple

try:  # imported up front: a lookup at the first bash call would open files in the middle of a decision
    from tools.environments.host_lane import confine_program, confined_process
except ImportError:  # no host lane to confine bash with: every word that needs bash is unresolved (fail closed)
    confine_program = confined_process = None

_WRAPPERS = frozenset({"sudo", "doas", "env", "command", "exec", "nice", "nohup", "time", "caffeinate", "busybox", "timeout",
                       "gtimeout", "arch", "stdbuf", "ionice", "xargs", "parallel", "watch", "builtin"})
_WRAPPER_VALUE_FLAGS = {"sudo": frozenset({"-u", "-g", "-h", "-p", "-U", "-C", "-D", "-T", "-r", "-t", "--chdir"}),
                        "doas": frozenset({"-u", "-C"}), "env": frozenset({"-u", "-C", "-S", "--chdir"}), "nice": frozenset({"-n"}),
                        "timeout": frozenset({"-k", "-s"}), "gtimeout": frozenset({"-k", "-s"}), "arch": frozenset({"-arch"}),
                        "stdbuf": frozenset({"-i", "-o", "-e"}), "ionice": frozenset({"-c", "-n", "-p"}),
                        "watch": frozenset({"-n", "-q"}), "parallel": frozenset({"-j", "-n", "-S"}),
                        "xargs": frozenset({"-I", "-J", "-L", "-P", "-R", "-S", "-E", "-n", "-s", "-d", "-a"})}
# A wrapper whose first plain word is its own value, not the program.
_WRAPPER_TAKES_VALUE = frozenset({"timeout", "gtimeout"})


def _plain_name(name: str) -> str:
    """P5s (lens W5a, proven): Homebrew installs GNU coreutils as genv, gnice, gnohup, gstdbuf, gchroot, gxargs...;
    a g-prefixed copy of a wrapper or launcher the floor knows is read as that wrapper or launcher."""
    if name.startswith("g") and (name[1:] in _WRAPPERS or name[1:] in _LAUNCHERS):
        return name[1:]
    return name
_KEYWORDS = frozenset({"do", "then", "else", "elif", "if", "while", "until", "{", "!", "}", "done", "fi", "esac"})
_DECLARE = frozenset({"export", "declare", "typeset", "readonly", "local"})
_SEPARATORS = frozenset({";", "&", "|", "&&", "||", ";;", "|&", "(", ")", "\n"})
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_APPENDING = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\+=")
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# M4: builtins that set the names among their words (read, mapfile/readarray, getopts, let, select's name): each such
# name is unknown after them, read both ways, as after unset.
_SETS_ITS_NAMES = frozenset({"unset", "read", "mapfile", "readarray", "getopts", "let"})
# ((X=...)) changes X as let does; $(( )) is arithmetic inside a word and is never given to bash.
_ARITHMETIC_COMMAND = re.compile(r"(?<!\$)\(\(((?:[^()]|\([^()]*\))*)\)\)")
_HOME_TOKEN = "/users/__home__"
_SUBSTITUTION = re.compile(r"\$\(([^()]*)\)|`([^`]*)`")
_ONE_NAME = r"(?:/+)[^/]+"
# Whole-machine roots, after the path is folded, lower-cased and a trailing glob removed.
# The Data volume's firmlinks mirror the system roots: /System/Volumes/Data/Library is /Library.
_DATA_VOLUME = re.compile(r"^/system/volumes/data(?=/|$)")
_ROOTS = re.compile(
    r"^(?:/|/users|/users" + _ONE_NAME + r"|/home|/home" + _ONE_NAME + r"|/root|/system|/system/volumes"
    r"|/library|/applications|/usr|/bin|/sbin|/etc|/var|/private|/private/etc|/private/var|/boot|/lib|/volumes)$")
# The shared folder is not anyone's home and not the machine: deleting it is ordinary work.
_NOT_A_ROOT = re.compile(r"^/users/shared$")
# The folder a cd the line cannot read leads to: a path under it is not a root, the folder itself or above it is unknown.
_UNKNOWN_CWD = "/__iclone_unknown_cwd__"
# A delete operand that is nothing but a value the shell fills in: when it is empty this is the root.
_UNRESOLVED = re.compile(r"^/?(?:\$[A-Za-z0-9_@*#?!-]*|\$\{[^}]*\}|\$\(.*\)|`.*`?)/*(?:\*+|\.\*+)?$", re.S)
# Kernel settings that can stop the machine, by name (ruling S3); other sysctl writes are ordinary tuning.
_CRITICAL_SYSCTL = frozenset({"kern.maxproc", "kern.maxprocperuid", "kern.securelevel", "kern.bootargs", "kern.bootsignature"})
_DISK_WRITE_ANY = frozenset({"tee", "shred", "wipefs", "blkdiscard", "sfdisk", "sgdisk", "parted"})
_DISK_WRITE_LAST = frozenset({"cp", "mv", "gcp", "install"})
_FDISK_WRITES = frozenset({"-e", "-i", "-u", "-a", "-f", "-y"})
_GPT_READS = frozenset({"show", "-h", "--help", "-v"})
_CF_OR_ZERO_WIDTH = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")
_DISK_DEVICE = re.compile(r"^/dev/(?:r?disk\d|sd[a-z]|nvme\d|hd[a-z]|mmcblk\d|vd[a-z]|xvd[a-z])")
_REDIRECT_TO_DISK = re.compile(r">\s*/dev/(?:r?disk\d|sd[a-z]|nvme\d|hd[a-z]|mmcblk\d|vd[a-z]|xvd[a-z])")
_DISKUTIL_ERASE = frozenset({"erasedisk", "erasevolume", "secureerase", "zerodisk", "randomdisk", "reformat",
                             "partitiondisk", "splitpartition", "mergepartitions", "deletecontainer", "deletevolume"})
_DISKUTIL_NEST = frozenset({"apfs", "ap", "corestorage", "cs", "appleraid", "ar"})
_BLESS_READS = frozenset({"--info", "--getboot", "--version", "--help"})
_CSRUTIL_READS = frozenset({"status", "report", "--help"})


_PUNCTUATION = "();<>|&\n"
_BLANKS = " \t\r"


def _process_substitution(text: str, index: int) -> bool:
    return text[index] in "<>" and text[index + 1:index + 2] == "("


def _close(text: str, index: int, closer: str) -> int:
    """Where the construct ends: the index of ``closer`` (``""``: the end of a top-level word, a blank or an operator),
    quotes and nested ``$( )``, ``${ }``, backticks and ``<( )`` skipped as bash skips them; -1 when it is never closed."""
    quoted = closer == '"'
    while index < len(text):
        char = text[index]
        if char == closer or (not closer and (char in _BLANKS or (char in _PUNCTUATION
                                                                 and not _process_substitution(text, index)))):
            return index
        if char == "\\":
            index += 2
            continue
        if char == "'" and not quoted:
            end = text.find("'", index + 1)
        elif text.startswith("$'", index) and not quoted:
            end = index + 2
            while end < len(text) and text[end] != "'":
                end += 2 if text[end] == "\\" else 1
            end = end if end < len(text) else -1
        elif text.startswith("$(", index) or (not quoted and _process_substitution(text, index)):
            end = _close(text, index + 2, ")")
        elif text.startswith("${", index):
            end = _close(text, index + 2, "}")
        elif char == "`":
            end = _close(text, index + 1, "`")
        elif char == '"' and not quoted:
            end = _close(text, index + 1, '"')
        elif char == "(" and closer == ")":
            end = _close(text, index + 1, ")")
        else:
            index += 1
            continue
        if end < 0:
            return -1
        index = end + 1
    return len(text) if not closer else -1


def _tokens(text: str) -> Iterator[Tuple[str, bool]]:
    """The line cut into words and operators where bash cuts it; a word keeps its quotes, as written (True: operator).
    A word that is never closed runs to the end of the text."""
    index = 0
    while index < len(text):
        if text[index] in _BLANKS:
            index += 1
        elif text[index] in _PUNCTUATION and not _process_substitution(text, index):
            end = index
            while end < len(text) and text[end] in _PUNCTUATION and not _process_substitution(text, end):
                end += 1
            yield text[index:end], True
            index = end
        else:
            end = _close(text, index, "")
            end = len(text) if end < 0 else max(end, index + 1)
            yield text[index:end], False
            index = end


def _simple_commands(text: str) -> Iterator[Tuple[List[str], Optional[List[str]], str]]:
    """Each simple command as its words exactly as written, with the command piped into it and every separator written
    between it and the command before it ("" at the start of the text or of a substitution)."""
    pending = [text]
    while pending:
        part = pending.pop()
        # Text in single quotes is text: the shell does not run a substitution written there.
        pending.extend(a or b for a, b in _SUBSTITUTION.findall(re.sub(r"'[^']*'", "''", part)))
        words: List[str] = []
        feeding: Optional[List[str]] = None
        before = ""
        for token, operator in _tokens(part):
            if operator and (token in _SEPARATORS or set(token) <= set(";|&()\n")):
                if words:
                    yield words, feeding, before
                    before = ""
                feeding = (words or feeding) if token in ("|", "|&") else None
                words = []
                before += token
            else:
                words.append(token)
        if words:
            yield words, feeding, before


def _program(words: List[str]) -> Tuple[str, List[str], bool]:
    """The program a line really runs, past keywords, assignments and wrappers such as sudo and env; and whether xargs
    or parallel hands it more words."""
    index, fed, wrapper = 0, False, ""
    while index < len(words):
        word = words[index]
        name = _plain_name(posixpath.basename(word).lower())
        if word in _KEYWORDS or _ASSIGNMENT.match(word) or _APPENDING.match(word):
            index += 1
        elif name == "script" and index + 1 < len(words):
            # P5i: script [-adeFkpqr] [-t time] [-T file] file command...: the command after the file runs
            index += 1
            while index < len(words) and words[index].startswith("-"):
                index += 2 if words[index] in ("-t", "-T") else 1
            index += 1
        elif name in _WRAPPERS:
            fed = fed or name in ("xargs", "parallel")
            wrapper = name
            index += 1
            while index < len(words) and words[index].startswith("-") or (
                    index < len(words) and _ASSIGNMENT.match(words[index])):
                index += 2 if words[index] in _WRAPPER_VALUE_FLAGS.get(name, ()) else 1
            if name in _WRAPPER_TAKES_VALUE:
                index += 1
        else:
            rest = [w for w in words[index + 1:] if w != ":::"]
            return name, rest, fed
    # P5s (lens W5a): a wrapper with no program after its options still runs (env -S 'code', env -C / -S'code'): the
    # wrapper is the program, so the launched-delete reading below is reached instead of the line being skipped.
    return wrapper, [], fed


# P5d (lead design): words are expanded by bash itself, never by an imitation of its rules. One bash per simple
# command, `set -f` (no globbing, so no file is read), no profile, no rc, no stdin, an empty environment (no BASH_ENV,
# PATH at an empty folder), cwd /, a hard timeout; each reading in its own subshell so ${X:=v} and ${X:?} stay there.
# Pass 5e: a word reaches bash only when it matches _BASH_WORD, a closed grammar (literal text, quotes and escapes, a bare
# ~ or ~/, brace lists and small ranges of literal text, $NAME, ${NAME}, ${NAME:-w}, ${NAME-w}, ${NAME:+w}, ${NAME+w} with
# a literal w); any other ${ } and every construct that runs something is first replaced by a name of its own (an unknown
# value), and a word still outside the grammar is unread. A name the line did not set is read twice, unset and set to the
# sentinel, and the worse answer stands; a name used only as ${X:-w} or ${X:=w} with a written w is read as w.
_BASH = "/bin/bash"
# Pass 5f: one line has a budget of reading steps (a word planned or read, a field checked), counted, never timed, so
# the decision stays a pure function of the text (R5: no clock moves it). About 1 s of work; each bash call keeps its own
# 2 s limit. Past the budget the line is a delete the floor cannot read.
_LINE_STEPS = 100_000
_BUDGET = threading.local()


class _OutOfTime(Exception):
    """The line ran past _LINE_STEPS: what is left of it is read as a delete the floor cannot read."""


def _spend() -> None:
    left = getattr(_BUDGET, "left", None)
    if left is not None:
        if left <= 0:
            raise _OutOfTime
        _BUDGET.left = left - 1
_BASH_TIMEOUT = 2.0
_BASH_ENV = {"PATH": "/var/empty", "LC_ALL": "C"}
# Pass 5d/5e, defence in depth for a word the grammar should never have let through.
# bash runs restricted (no command name with a slash, PATH/SHELL/ENV/BASH_ENV read-only, no output redirection, no exec,
# no enable -f, no hash -p, no . of a path) inside sandbox-exec with the profile below, confined or not; on any failure,
# timeout included, every word is unresolved; after every call each process of bash's session (job control can give a
# job its own group, never its own session: setsid is not a builtin) and every group seen is killed, and bash starts with
# a CPU limit (2 s soft, 3 s hard, inherited) so a spinning child dies on its own. RLIMIT_NPROC is per user on macOS (it
# counts every process the user runs), so it cannot bound bash alone and is not set. A Seatbelt profile cannot be applied
# inside another (sandbox_apply: Operation not permitted, measured), so in a confined process bash runs restricted inside
# the agent's probe profile (confine_program) instead; anywhere else it always runs under this one. Seatbelt: the last matching rule
# wins, so each deny is followed by the one thing bash needs (dyld's reads to start /bin/bash, /dev/null as stderr).
# With set -f and HOME always given, an expansion needs no file, no lookup and no network.
_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
_BASH_PROFILE_RULES: Tuple[str, ...] = (
    '(deny process-exec*)\n(allow process-exec (literal "/bin/bash"))',
    '(deny file-write*)\n(allow file-write-data (literal "/dev/null"))',
    '(deny file-read*)\n(allow file-read* (literal "/bin/bash") (subpath "/usr/lib") (subpath "/System/Library")'
    ' (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/private/var/db/dyld") (literal "/dev/null")'
    ' (literal "/") (literal "/private") (literal "/private/var") (literal "/dev"))',
    "(deny network*)",
    "(deny mach-lookup)",
    "(deny signal)\n(allow signal (target self))",
    "(deny process-info*)\n(allow process-info* (target self))",
    "(deny sysctl-write)",
    "(deny iokit-open)",
    "(deny ipc-posix*)",
)
# Seatbelt has no fork count; the CPU limit and the session kill bound what a fork can do.
_BASH_LIMITS = "ulimit -S -t 2\nulimit -H -t 3\n"


def _bash_profile(rules: Optional[Tuple[str, ...]] = None) -> str:
    return "(version 1)\n(allow default)\n" + "\n".join(_BASH_PROFILE_RULES if rules is None else rules) + "\n"


def floor_bash_argv(script: str, rules: Optional[Tuple[str, ...]] = None, sandboxed: bool = True) -> List[str]:
    """The exact argv the floor starts bash with for ``script`` (before the host lane confines it)."""
    bash = [_BASH, "--restricted", "--noprofile", "--norc", "-c", _BASH_LIMITS + script]
    return [_SANDBOX_EXEC, "-p", _bash_profile(rules), *bash] if sandboxed else bash


def _all_pids() -> List[int]:
    """Every pid on the system (libproc on macOS, /proc elsewhere); empty when neither can be read."""
    try:
        if os.path.isdir("/proc/self"):
            return [int(name) for name in os.listdir("/proc") if name.isdigit()]
        import ctypes

        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        count = libc.proc_listallpids(None, 0)
        if count <= 0:
            return []
        buffer = (ctypes.c_int * (count + 64))()
        count = libc.proc_listallpids(buffer, ctypes.sizeof(buffer))
        return [pid for pid in buffer[:max(count, 0)] if pid > 0]
    except (OSError, AttributeError, ValueError):
        return []


def _session_members(session: int) -> Dict[int, int]:
    """pid -> process group of every process in ``session`` (bash's own: start_new_session makes it the leader)."""
    found: Dict[int, int] = {}
    for pid in _all_pids():
        try:
            if os.getsid(pid) == session:
                found[pid] = os.getpgid(pid)
        except OSError:
            continue
    return found


def _end_group(process: "subprocess.Popen[bytes]") -> None:
    """Kill bash and everything it started: every process of its session, stopped first so none forks past the scan, and
    every group seen; then reap bash."""
    groups = {process.pid}
    process.poll()  # a bash that already ended is reaped first: its session id stays reserved while any member lives
    for _round in range(4):
        members = _session_members(process.pid)
        if not members:
            break
        for pid in members:
            try:
                os.kill(pid, signal.SIGSTOP)
            except OSError:
                pass
        members.update(_session_members(process.pid))
        groups.update(members.values())
        for pid in members:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except OSError:
            pass
    try:
        process.wait(timeout=_BASH_TIMEOUT)
    except subprocess.TimeoutExpired:
        pass

_BASH_DONE = "\x03done"
_BASH_DONE_LINE = "\nprintf '\\003done\\0'"
_SENTINEL = "\x01\x01\x01\x01"
_SENTINELS = re.compile("\x01+")
_PLACEHOLDER = "__iclone_value__"
_MAX_READINGS = 256
_HOME_SHAPE = "/Users/__iclone_home__"
_MAX_UNKNOWN_NAMES = 4  # D4: 2**4 readings of names the line did not set; more is unread
_MAX_BRACE_WORDS = 4096  # words one brace expansion, or all of one command's, may list
_MAX_BRACE_SPAN = 1000  # |B - A| of one {A..B}
_PLAIN_WORD = re.compile(r"[^$`'\"\\{~\x01()<>]*")
_BRACE_RANGE = re.compile(r"\{(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?\d+)?\}")
_BRACE_LIST = re.compile(r"\{([^{}]*,[^{}]*)\}")
# Pass 5e: the closed grammar of a word bash may be given (see the header). Each alternative starts with its own
# character (a { either opens a brace list or has no } after it), so a word that fails is rejected without backtracking.
# Pass 5f: a ~ only at the very start of the word and only as the bare ~ or ~/ (a brace list after it keeps it at the
# start of every word it lists); every other ~ (after a brace group, after = or :, in the middle, ~user, ~1, ~+, ~-)
# never reaches bash. ~user at the start is mapped in Python first (_OTHER_USER); a ~ in the middle of an otherwise plain
# word is read as the literal it is, in Python (_PLAIN_TILDE). $_ is not a name: bash rewrites it after every command.
_NAME_TEXT = r"[A-Za-z_][A-Za-z0-9_]*"
# w: literal text and plain $NAME (a value bash substitutes and never reads again), a bare ~ or ~/ only at its start.
_DEFAULT_TEXT = (r"(?:~(?=[/}]))?(?:[^$`\\\[\](){};|&<>'\"~}\x00-\x08\n]"
                 rf"|\$(?!_(?![A-Za-z0-9_])){_NAME_TEXT}(?![A-Za-z0-9_]))*")
_PARAMETER_NAME = rf"(?!_(?![A-Za-z0-9_])){_NAME_TEXT}"
_PARAMETER = rf"\$(?:{_PARAMETER_NAME}(?![A-Za-z0-9_])|\{{{_PARAMETER_NAME}(?::?[-+]{_DEFAULT_TEXT})?\}})"
# ${X:=w} and ${X=w} give the word the value ${X:-w} and ${X-w} give (the assignment stays in the reading's subshell):
# read as those, so := never reaches bash.
_ASSIGN_DEFAULT = re.compile(rf"\$\{{({_NAME_TEXT})(:?)=")
_ESCAPED = r"\\[^\x00-\x08\n]"
_BRACE_ITEM = r"[^\s{},$`\\'\"()<>;&|~\x00-\x08]*"
_BASH_WORD = re.compile(
    r"(?:[^\s\"'\\$`(){<>;&|~\x00-\x08]"
    rf"|{_ESCAPED}"
    r"|'[^'\x00-\x08\n]*'"
    rf"|\"(?:[^\"\\$`\x00-\x08\n]|\\[^$`\x00-\x08\n]|{_PARAMETER})*\""
    rf"|{_PARAMETER}"
    rf"|\{{{_BRACE_ITEM}(?:,{_BRACE_ITEM})*\}}"
    r"|\{(?![^}]*\})"  # a { no } follows is literal to bash
    r"|(?<![\s\S])~(?=/|$))*")
_PARAMETER_ONLY = re.compile(_PARAMETER)
_NAME_USE = re.compile(r"\$\{#?([A-Za-z_]\w*)|\$([A-Za-z_]\w*)")
_LEADING_USE = re.compile(r"^(\"?)\$(?:\{#?([A-Za-z_]\w*|[0-9@*])|([A-Za-z_]\w*|[0-9@*]))")
_OTHER_USER = re.compile(r"^~[A-Za-z_][\w.-]*(?=/|$)")
# A ~ in the middle of a word with nothing else bash would act on (build~, a~b): literal, read here, never by bash.
_PLAIN_TILDE = re.compile(r"[^$`'\"\\{~\x01()<>=:\s][^$`'\"\\{\x01()<>]*")
# Names bash fills in itself (some read-only); never assigned, bash's own value is used.
_BASH_OWN = re.compile(r"BASH\w*|UID|EUID|PPID|SHELLOPTS|RANDOM|SRANDOM|SECONDS|LINENO|GROUPS|FUNCNAME|PIPESTATUS|OSTYPE"
                       r"|MACHTYPE|HOSTTYPE|HOSTNAME|IFS|EPOCHSECONDS|EPOCHREALTIME|SHLVL|OPTIND|OPTERR|HISTCMD|DIRSTACK")
_Form = Tuple[str, bool]


class _Word(str):
    """A word as the program receives it when every unknown name is set (the sentinel marks what came from one), with
    every (field, head_was_empty) bash can hand over for the word as written; ``unread`` when it was never given to bash.
    head_was_empty: the word starts with an unknown name, unset in that reading, so what is left is the written rest."""

    forms: Tuple[_Form, ...] = ()
    unread = False
    runs_head = False  # the word starts with a construct that runs something ("$(git rev-parse ...)/build")
    written = ""  # as written, quotes dropped, when a construct in it was replaced by an unknown name


def _word(text: str, forms: Tuple[_Form, ...], unread: bool = False) -> _Word:
    made = _Word(text)
    made.forms, made.unread = forms, unread
    return made


def _masked(word: str) -> str:
    """The word with single-quoted and escaped text blanked: what is left is what bash would act on."""
    out, quoted, index = [], False, 0
    while index < len(word):
        char = word[index]
        if char == "\\":
            out.append("__")
            index += 2
        elif word.startswith("$'", index) and not quoted:  # $'\'' is one quote: its \' never closes it
            end = index + 2
            while end < len(word) and word[end] != "'":
                end += 2 if word[end] == "\\" else 1
            end = min(end, len(word) - 1)
            out.append("_" * (end + 1 - index))
            index = end + 1
        elif char == "'" and not quoted:
            end = word.find("'", index + 1)
            end = len(word) if end < 0 else end
            out.append("_" * (end + 1 - index))
            index = end + 1
        else:
            quoted = quoted != (char == '"')
            out.append(char)
            index += 1
    return "".join(out)


_ASSIGNED_TILDE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=(?=~(?:/|$))")


def _bash_reads(word: str) -> bool:
    """The word is in the grammar bash may be given (_BASH_WORD). An assignment's value starts a word of its own:
    NAME=~ and NAME=~/x read as ~ and ~/x."""
    lead = _ASSIGNED_TILDE.match(word)
    return _BASH_WORD.fullmatch(word[lead.end():] if lead else word) is not None


def _with_stand_ins(word: str) -> str:
    """The word with each construct that would make bash run something ($( ), backticks, <( ), >( ), $(( )), $[ ],
    and every ${ } outside the grammar) replaced by a name of its own the line never sets: its value is unknown."""
    out, index, quoted, made = [], 0, False, 0
    while index < len(word):
        char, end = word[index], -1
        if char == "\\":
            out.append(word[index:index + 2])
            index += 2
            continue
        if char == "'" and not quoted:
            end = word.find("'", index + 1)
            end = len(word) - 1 if end < 0 else end
            out.append(word[index:end + 1])
            index = end + 1
            continue
        if word.startswith("$'", index) and not quoted:
            end = index + 2
            while end < len(word) and word[end] != "'":
                end += 2 if word[end] == "\\" else 1
            out.append(word[index:end + 1])
            index = end + 1
            continue
        if word.startswith("$(", index) or (not quoted and _process_substitution(word, index)):
            end = _close(word, index + 2, ")")
        elif word.startswith("$[", index):
            end = _close(word, index + 2, "]")
        elif char == "`":
            end = _close(word, index + 1, "`")
        elif word.startswith("${", index):
            end = _close(word, index + 2, "}")
            piece = _ASSIGN_DEFAULT.sub(r"${\1\2-", word[index:end + 1], count=1) if end >= 0 else ""
            if end >= 0 and _PARAMETER_ONLY.fullmatch(piece):
                out.append(piece)
                index = end + 1
                continue
        if end >= 0:
            made += 1
            out.append("${__iclone_runs_%d}" % made)
            index = end + 1
            continue
        quoted = quoted != (char == '"')
        out.append(char)
        index += 1
    return "".join(out)


def _brace_words(word: str) -> Optional[int]:
    """How many words the word's brace expansions list, or None past _MAX_BRACE_SPAN or _MAX_BRACE_WORDS."""
    masked = _masked(word)
    size = 1
    for low, high in _BRACE_RANGE.findall(masked):
        span = abs(ord(high) - ord(low)) if low.isalpha() and high.isalpha() else (
            abs(int(high) - int(low)) if not (low.isalpha() or high.isalpha()) else None)
        if span is None or span > _MAX_BRACE_SPAN:
            return None
        size *= span + 1
    for items in _BRACE_LIST.findall(masked):
        size *= items.count(",") + 1
    return size if size <= _MAX_BRACE_WORDS else None


def _choices(raw: str, values: Dict[str, List[str]]) -> List[Tuple[str, Tuple[Optional[str], ...]]]:
    """Each name the word uses with the values it is read with: the line's own values, or unset and the sentinel."""
    names = {a or b for a, b in _NAME_USE.findall(raw)} | ({"HOME", "PWD", "OLDPWD"} if "~" in raw else set())
    found: List[Tuple[str, Tuple[Optional[str], ...]]] = []
    for name in sorted(names):
        if _BASH_OWN.fullmatch(name):
            continue
        if name in values:
            found.append((name, tuple(dict.fromkeys(values[name]))))
            continue
        uses = len(re.findall(r"\$\{?" + re.escape(name) + r"(?!\w)", raw))
        written = [w for w in re.findall(r"\$\{" + re.escape(name) + r":?-([^}]*)\}", raw) if w.strip()]
        if uses and len(written) == uses:
            found.append((name, (None,)))
        else:
            found.append((name, (None, _SENTINEL)))
    return found


def _setting(name: str, value: Optional[str]) -> str:
    return f"unset {name}" if value is None else f"{name}={shlex.quote(value)}"


@lru_cache(maxsize=4096)
def _bash_output(script: str) -> Optional[Tuple[str, ...]]:
    """bash's NUL-separated fields for ``script``, or None. In a confined process bash runs only inside the agent's
    Seatbelt (a probe through ``confine_program``, the spawn guard refuses anything else). The fields count only when
    bash reached the closing mark: a sandbox, launcher or bash that stopped early leaves every word unresolved."""
    if confine_program is None or confined_process is None:
        return None
    try:
        sandboxed = not confined_process()
        if sandboxed and not os.path.isfile(_SANDBOX_EXEC):
            return None
        argv, env = confine_program(floor_bash_argv(script + _BASH_DONE_LINE, sandboxed=sandboxed), kind="probe",
                                    env=dict(_BASH_ENV))
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=env, cwd="/", start_new_session=True)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    try:
        stdout, _stderr = process.communicate(timeout=_BASH_TIMEOUT)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    finally:
        _end_group(process)
    fields = tuple(stdout.decode("utf-8", "surrogateescape").split("\0"))
    if fields[-2:] != (_BASH_DONE, ""):
        return None
    return fields[:-2]


# One block reads one word with one set/unset choice of its names, in its own subshell under an empty env, set -f and
# cwd /: its fields depend on its text alone, so they are kept across the commands of a line and every detection
# variant of it. _STOPPED marks a reading that stopped bash (${X:?}); a failed bash call keeps nothing.
_STOPPED: Tuple[str, ...] = ("\x02stopped",)
_BLOCK_FIELDS: Dict[str, Tuple[str, ...]] = {}
_MAX_KEPT_BLOCKS = 8192
# Each block is a forked subshell (~1 ms on macOS): a call stays well inside _BASH_TIMEOUT, a long line takes several.
_MAX_BLOCKS_PER_CALL = 200
# Only quotes on top of a plain word: bash's expansion is its quote removal alone (set -f, no name, no brace, no tilde).
_QUOTED_WORD = re.compile(r"[^$`\\{~\x01()<>]*")


def _without_quotes(word: str) -> str:
    out, quote = [], ""
    for char in word:
        if char == quote:
            quote = ""
        elif not quote and char in "'\"":
            quote = char
        else:
            out.append(char)
    return "".join(out)


def _block(prelude: str, text: str) -> str:
    """One reading: the line's values (quoted literals) and printf of the word; the closing '' marks its end."""
    return f"( {prelude or ':'}\nprintf '%s\\0' {text} '' )"


def _read_blocks(blocks: List[str]) -> Optional[Dict[str, Tuple[str, ...]]]:
    """The fields of every block, those not yet read in one bash call; None when bash failed or timed out. The answer is
    its own copy, so a block dropped from the kept ones by another thread is never read as missing."""
    got = {b: _BLOCK_FIELDS[b] for b in dict.fromkeys(blocks) if b in _BLOCK_FIELDS}
    missing = [b for b in dict.fromkeys(blocks) if b not in got]
    for start in range(0, len(missing), _MAX_BLOCKS_PER_CALL):
        _spend()
        chunk = _read_chunk(missing[start:start + _MAX_BLOCKS_PER_CALL])
        if chunk is None:
            return None
        got.update(chunk)
    return got


def _read_chunk(missing: List[str]) -> Optional[Dict[str, Tuple[str, ...]]]:
    output = _bash_output("set -f\n" + "\n".join(f"printf '\\002%d\\0' {at}\n{b}" for at, b in enumerate(missing)))
    if output is None:
        return None
    fields: Dict[int, Tuple[str, ...]] = {}
    at: Optional[int] = None
    taken: List[str] = []
    for token in (*output, "\x02"):
        if token.startswith("\x02") and token[1:].isdigit() or token == "\x02":
            if at is not None and taken and taken[-1] == "":
                fields[at] = tuple(taken[:-1])
            at, taken = (int(token[1:]) if token != "\x02" else None), []
        else:
            taken.append(token)
    if len(_BLOCK_FIELDS) + len(missing) > _MAX_KEPT_BLOCKS:
        _BLOCK_FIELDS.clear()
    got = {}
    for at, block in enumerate(missing):
        got[block] = _BLOCK_FIELDS[block] = fields.get(at, _STOPPED)
    return got


_Reading = Tuple[Dict[str, Optional[str]], str, Optional[str]]
_Plan = Tuple[str, List[_Reading], Optional[str]]


def _unquoted_expansion(raw: str) -> bool:
    """The word has a $ or a backtick outside quotes: its value is split on IFS."""
    bare = re.sub(r'"[^"]*"?', "", _masked(raw))
    return "$" in bare or "`" in bare


def _planned(raw_words: List[str], values: Dict[str, List[str]], split: bool = False) -> List[_Plan]:
    """Each word with the bash blocks that read it: one per set/unset choice of its names (and of its tail).
    ``split``: the line set IFS, so a word with an unquoted expansion is split in a way the reading cannot know."""
    plans: List[_Plan] = []
    listed = 0
    for raw in raw_words:
        _spend()
        if split and _unquoted_expansion(raw):
            plans.append((raw, [], "unread"))
            continue
        if "~" in raw[1:] and _PLAIN_TILDE.fullmatch(raw) and not re.search(r"[=:]~", raw):
            plans.append((raw, [], None))  # build~, a~b: a ~ bash never expands
            continue
        raw = _OTHER_USER.sub("~", raw)  # another user's home is a home, as the plain ~ is
        if _PLAIN_WORD.fullmatch(raw) or set(raw) <= set(_PUNCTUATION):  # a redirection operator is kept as written
            plans.append((raw, [], None))
            continue
        if _QUOTED_WORD.fullmatch(raw) and _bash_reads(raw):
            plans.append((_without_quotes(raw), [], None))
            continue
        given = raw if _bash_reads(raw) else _with_stand_ins(raw)
        size = _brace_words(given) if _bash_reads(given) else None
        if size is None or listed + size > _MAX_BRACE_WORDS:  # outside the grammar, or too many words: never to bash
            plans.append((raw, [], "unread"))
            continue
        listed += size
        choices = _choices(given, values)
        count = 1
        for _name, options in choices:
            count *= len(options)
        if count > _MAX_READINGS or sum(_SENTINEL in options for _name, options in choices) > _MAX_UNKNOWN_NAMES:
            plans.append((raw, [], "unread"))
            continue
        lead = _LEADING_USE.match(given)
        tail = None
        if lead:
            end = _close(given, lead.end(), "}") + 1 if lead.group(2) else lead.end()
            tail = lead.group(1) + given[end:] if end > 0 else None
        readings: List[_Reading] = []
        for picked in itertools.product(*(options for _name, options in choices)):
            setting = dict(zip((name for name, _options in choices), picked))
            prelude = "; ".join(_setting(name, value) for name, value in setting.items())
            readings.append((setting, _block(prelude, given), None if tail is None else _block(prelude, tail)))
        plans.append((raw if given == raw else "\0" + raw, readings, (lead.group(2) or lead.group(3)) if lead else None))
    return plans


def _plan_blocks(plans: List[_Plan]) -> List[str]:
    return [b for _raw, readings, _lead in plans for _setting, word, tail in readings for b in (word, tail) if b]


def _expanded(raw_words: List[str], values: Dict[str, List[str]], split: bool = False) -> List[_Word]:
    """The words as bash expands them; blocks a line already read are not given to bash again."""
    plans = _planned(raw_words, values, split)
    read = _read_blocks(_plan_blocks(plans))
    words: List[_Word] = []
    for raw, readings, lead_name in plans:
        _spend()
        stood_in = raw.startswith("\0")
        raw = raw.lstrip("\0")
        if not readings:
            if lead_name == "unread":
                words.append(_word(re.sub(r"[\"']", "", raw), (), unread=True))
            else:
                words.append(_word(raw, ((raw, False),)))
            continue
        forms: List[_Form] = []
        shown: Optional[Tuple[str, ...]] = None
        all_set = False
        for setting, word_block, tail_block in readings:
            got = read[word_block] if read is not None else _STOPPED
            if got is _STOPPED:
                continue  # that reading stopped bash (${X:?}): the command does not run with it
            rest = read[tail_block] if read is not None and tail_block else ()
            rest = () if rest is _STOPPED else rest
            empty_head = bool(lead_name) and lead_name in setting and setting[lead_name] is None
            forms += [(field, empty_head and field in rest) for field in got] or [("", empty_head)]
            if shown is None or (not all_set and None not in setting.values()):
                shown, all_set = got, None not in setting.values()
        if read is None or shown is None:
            words.append(_word(re.sub(r"[\"']", "", raw), (), unread=True))
            continue
        frozen = tuple(dict.fromkeys(forms))
        if not shown and frozen:
            shown = (next((field for field, _head in frozen if field), ""),)
        for field in shown:
            words.append(_word(field, frozen))
            words[-1].written = re.sub(r"[\"']", "", raw) if stood_in else ""
            words[-1].runs_head = bool(lead_name) and lead_name.startswith("__iclone_runs_")
    return words


def _plain(text: str) -> _Word:
    return _word(text, ((text, False),))


# P5u-P5x (panel 5 B, proven): a last name made only of glob tokens with a * in it (?*, *?, ??*, [a-z]*, []a-z]*, .?*) lists every
# name in the folder, as * does; it is read as the folder itself. A name with one literal character outside a bracket
# (a*, *.txt) is ordinary.
_ALL_NAMES = re.compile(r"/\.?(?:[*?]|\[(?![!^])\]?[^/\]]*\]?)+$")  # a negated set ([! [^) or a class stays unread, as before


def _without_trailing_glob(text: str) -> str:
    while True:
        trimmed = re.sub(r"/(?:\*+|\.\*+|\.\[[^/]*)$", "", text) or "/"
        if trimmed == text:
            every = _ALL_NAMES.search(text)
            if every and "*" in every.group(0):
                trimmed = text[:every.start()] or "/"
        if trimmed == text:
            return text
        text = trimmed


# Never looked up: an automounted or network path can hang a stat for as long as the share takes to answer.
_AUTOFS_FIXED = ("/net", "/network", "/home", "/system/volumes/data/home")
_GLOB = re.compile(r"[*?\[]")
_MAX_LINKS = 40
# One snapshot of the filesystem per decision: what one destruction_of call (or a caller's decide/classify that opens
# walk_snapshot) looked up is reused inside it and dropped when it returns, so a link changed between two decisions is
# always seen. Never a module-level cache.
_WALK_MEMO: ContextVar[Optional[Dict[tuple, object]]] = ContextVar("approval_floor_walk_memo", default=None)


@contextmanager
def walk_snapshot() -> Iterator[None]:
    """Reuse path lookups for the rest of this call; a nested scope joins the open one."""
    if _WALK_MEMO.get() is not None:
        yield
        return
    token = _WALK_MEMO.set({})
    try:
        yield
    finally:
        _WALK_MEMO.reset(token)


@lru_cache(maxsize=1)
def _autofs_points() -> Tuple[str, ...]:
    points = set(_AUTOFS_FIXED)
    try:
        with open("/etc/auto_master", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                fields = line.split("#", 1)[0].split()
                if fields and fields[0].startswith("/") and fields[0] != "/-":
                    points.add(posixpath.normpath(fields[0]).lower())
    except OSError:
        pass
    return tuple(sorted(points))


def _under_autofs(path: str) -> bool:
    lowered = path.lower()
    return any(lowered == point or lowered.startswith(point + "/") for point in _autofs_points())


def _through_links(path: str, follow_last: bool, hops: List[int]) -> Tuple[str, bool]:
    """An absolute path with its links resolved component by component, ``..`` applied to what is already resolved; the
    last component is followed only when ``follow_last``. False when it stopped early (a glob, an autofs path, a loop):
    the rest is then left as written. Inside one decision a written prefix already resolved is not walked again; its
    links still count toward _MAX_LINKS, and a prefix whose count would pass it is walked, so the answer is the same."""
    names = [name for name in path.split("/") if name]
    memo = _WALK_MEMO.get()
    origin, done, start = hops[0], "/", 0
    if memo is not None:
        for cut in range(len(names) if follow_last else len(names) - 1, 0, -1):
            hit = memo.get(("prefix", "/" + "/".join(names[:cut])))
            if hit is not None and origin + hit[1] <= _MAX_LINKS:
                done, start, hops[0] = hit[0], cut, origin + hit[1]
                break
    for index in range(start, len(names)):
        name = names[index]
        if name == ".":
            pass
        elif name == "..":
            done = posixpath.dirname(done)
        else:
            here = posixpath.join(done, name)
            if _GLOB.search(name) or _under_autofs(here):
                return posixpath.join(done, *names[index:]), False
            if index == len(names) - 1 and not follow_last:
                return here, True
            try:
                info = os.lstat(here)
            except (OSError, ValueError):
                info = None
            if info is None or not stat.S_ISLNK(info.st_mode):
                done = here
            else:
                hops[0] += 1
                try:
                    target = os.readlink(here)
                except OSError:
                    return posixpath.join(done, *names[index:]), False
                if hops[0] > _MAX_LINKS:
                    return posixpath.join(done, *names[index:]), False
                done, exact = _through_links(posixpath.join(done, target), True, hops)
                if not exact:
                    return posixpath.join(done, *names[index + 1:]), False
        if memo is not None:
            memo[("prefix", "/" + "/".join(names[:index + 1]))] = (done, hops[0] - origin)
    return done, True


def _folded(path: str, cwd: Optional[str], follow: bool = True) -> str:
    """Home spellings joined, links resolved before dots are collapsed (the last link only when ``follow``, or when the
    path ends with a slash), a trailing glob dropped, lower-cased (APFS folds case), the Data volume's firmlinks read as
    the roots."""
    memo = _WALK_MEMO.get()
    if memo is None:
        return _folded_now(path, cwd, follow)
    key = ("folded", path, cwd, follow)
    if key not in memo:
        memo[key] = _folded_now(path, cwd, follow)
    return memo[key]


def _folded_now(path: str, cwd: Optional[str], follow: bool) -> str:
    text = path.strip()
    if not text.startswith("/"):
        if not cwd:
            return ""
        text = posixpath.join(cwd, text)
    text = re.sub(r"/+", "/", text)
    if not re.search(r"[$`]", text) and not text.lower().startswith((_HOME_TOKEN, _UNKNOWN_CWD)):
        last = follow or text.endswith("/") or text.endswith("/.")
        text, exact = _through_links(text, last, [0])
        left = posixpath.normpath(text)
        # A path that climbed out of an autofs mount (/net/../Users/x/r/) is looked up again once it has left it.
        if not exact and left != text and not _under_autofs(left) and not _GLOB.search(left):
            text = _through_links(left, last, [0])[0]
    text = _without_trailing_glob(posixpath.normpath(text))
    return _DATA_VOLUME.sub("", text.lower()) or "/"


_PROTECTED = ("/", "/Users", "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/private", "/private/etc",
              "/private/var", "/etc", "/var", "/opt")


def _identity(path: str, follow: bool) -> Optional[Tuple[int, int]]:
    memo = _WALK_MEMO.get()
    if memo is None:
        return _identity_now(path, follow)
    key = ("identity", path, follow)
    if key not in memo:
        memo[key] = _identity_now(path, follow)
    return memo[key]


def _identity_now(path: str, follow: bool) -> Optional[Tuple[int, int]]:
    try:
        info = os.stat(path) if follow else os.lstat(path)
    except (OSError, ValueError):
        return None
    return info.st_dev, info.st_ino


@lru_cache(maxsize=1)
def _protected_identities() -> FrozenSet[Tuple[int, int]]:
    """The machine's roots by device and inode, once per process. The boot volume's link under /Volumes is / itself."""
    found = (_identity(path, True) for path in _PROTECTED)
    return frozenset(identity for identity in found if identity is not None)


def _is_protected_identity(folded: str) -> bool:
    """The folded path (links already resolved where the operand goes past them) is a protected folder or the home, by
    device and inode. The last component is not followed: deleting a link to / removes the link."""
    if not folded.startswith("/") or folded.startswith((_HOME_TOKEN, _UNKNOWN_CWD)) or _under_autofs(folded):
        return False
    found = _identity(folded, False)
    if found is None:
        return False
    home = os.environ.get("HOME") or ""
    return found in _protected_identities() or (home.startswith("/") and found == _identity(home, True))


# Pass 5f: a glob in a folder of the path (/Us?rs, /[U]sers, /?sers/me*) is matched, as text only (no file is listed),
# component by component against every whole-machine root and home: a pattern that can name one is a delete of it.
_GLOB_ROOTS: Tuple[Tuple[Optional[str], ...], ...] = tuple(
    tuple(p.lower().strip("/").split("/")) for p in _PROTECTED if p != "/") + (
    ("users", None), ("home",), ("home", None), ("root",), ("system", "volumes"), ("boot",), ("lib",), ("volumes",))


def _glob_names_a_root(folded: str) -> bool:
    """The folded path still holds a glob after its trailing ones are dropped, and it can match a root or a home."""
    if not _GLOB.search(folded):
        return False
    parts = [p for p in folded.lower().split("/") if p]
    homes = tuple(tuple(p for p in h.split("/") if p) for h in _home_folded())
    for root in _GLOB_ROOTS + homes:
        if len(root) == len(parts) and all(
                (name is None and part != "shared") or (name is not None and fnmatchcase(name, part.replace("[^", "[!")))
                for part, name in zip(parts, root)):
            return True
    return False


# Pass 5g: never imitate a glob the floor cannot match as bash does. A negated set or a POSIX class anywhere, or any glob in
# a name right under / , /Users, /Volumes, /private or a home's parent (a name that could be a protected folder or a home),
# is unresolved when the simple match above did not already find a root.
_GLOB_UNREAD = re.compile(r"\[[!^]|\[\[:")
_GLOB_PARENTS = frozenset({"", "/users", "/volumes", "/private"})


def _glob_unread(folded: str) -> bool:
    if _GLOB_UNREAD.search(folded):
        return True
    parents = _GLOB_PARENTS | {posixpath.dirname(h.rstrip("/")).lower() for h in _home_folded()}
    parts = folded.split("/")
    first = next((at for at, part in enumerate(parts) if at and _GLOB.search(part)), None)
    return first is not None and "/".join(parts[:first]).lower() in parents


def _home_folded() -> Tuple[str, ...]:
    home = os.environ.get("HOME") or ""
    return (_folded(home, None), _folded(home.rstrip("/") + "/", None)) if home.startswith("/") else ()


def _is_root_folded(folded: str) -> bool:
    return bool(folded) and ((bool(_ROOTS.match(folded)) and not _NOT_A_ROOT.match(folded)) or folded in _home_folded()
                             or _is_protected_identity(folded))


_ECHOES_A_ROOT = re.compile(r"(?:\$\(|`)\s*(?:echo|printf)\s+[\"']?(?:~|/[\s)`\"']|\$\{?HOME)")
_SAYS_A_ROOT = re.compile(r"[$`(\s]~|\$\(.*\$\{?HOME|`.*\$\{?HOME|\s/[\s)`]")
# F53: not total destruction by itself, so it is not hardline: it asks as any command does, and in Ignore, where nothing
# else would stop it, it refuses with this text. A line that also destroys outright reports that instead.
UNRESOLVED_DELETE = ("recursive delete of a path only known when it runs, which could be the whole disk. "
                     "Write the path out literally, or set the variable earlier in this same command to a written path "
                     "or to mktemp")
# m2: find -H, -L or -follow with a delete reaches whatever the links below its start points point to.
FOLLOWED_LINKS_DELETE = ("recursive delete of a path only known when it runs: find follows the links below its start "
                         "point (-H, -L or -follow) to whatever they point to, which could be the whole disk. Drop -H, -L "
                         "and -follow so links are removed, not followed")
UNRESOLVED_DELETES = frozenset({UNRESOLVED_DELETE, FOLLOWED_LINKS_DELETE})
_ROOT_OR_HOME = "recursive delete of the whole disk, a home folder or the system"


def _unknown(cwd: Optional[str]) -> bool:
    return bool(cwd) and (cwd == _UNKNOWN_CWD or cwd.startswith(_UNKNOWN_CWD + "/"))


def _fold_from(text: str, cwd: Optional[str], follow: bool) -> Optional[str]:
    if _unknown(cwd) and not text.startswith("/") and _could_be_a_root(text):
        return None  # pass 5h: in a folder the floor cannot read, a relative path that could name a root is unresolved
    return _folded(text, cwd, follow)


# Pass 5h: the names a relative path under an unknown folder could match at / or /Users.
_PROTECTED_NAMES = frozenset({"users", "system", "library", "applications", "usr", "bin", "sbin", "private", "etc", "var",
                              "opt", "volumes", "tmp", "cores", "dev", "home",
                              # P5i: the names of the volumes and their links (/Volumes/Macintosh HD is /, /System/Volumes/Data)
                              "macintosh hd", "data", "system volume information", "preboot", "recovery", "vm"})


def _could_be_a_root(text: str) -> bool:
    """A relative path, in a folder the floor cannot read, that could be a protected folder, a home or everything in one:
    it is ., climbs with .., starts with a glob or a brace, or starts with a protected name or a home's name."""
    parts = [p for p in text.split("/") if p]
    while parts and parts[0] == ".":
        parts.pop(0)
    if not parts or ".." in parts or re.search(r"[*?\[{]", parts[0]):
        return True
    try:
        homes = {name.lower() for name in os.listdir("/Users")}
    except OSError:
        homes = set()
    return parts[0].lower() in _PROTECTED_NAMES | homes


def _forms(word: str) -> Tuple[_Form, ...]:
    return word.forms if isinstance(word, _Word) else ((word, False),)


def _form_reading(field: str, empty_head: bool, cwd: Optional[str], follow: bool) -> Tuple[Optional[str], Optional[str]]:
    """(verdict, folded path) of one field bash hands over. Nothing written but slashes and globs around an unknown
    value is unresolved; a field that starts with an unknown value folds under the unknown-folder stand-in (unresolved
    when it climbs out of it); a root reached only because a leading unknown name was empty is unresolved (the owner
    can approve it), a root otherwise is total destruction."""
    if "\x01" in field:
        if re.fullmatch(r"[/*?]*|/*(?:\*+|\.\*+)/*", _SENTINELS.sub("", field)):
            return UNRESOLVED_DELETE, None
        if field.startswith("\x01"):
            under = _folded(_UNKNOWN_CWD + "/" + _SENTINELS.sub("", field).lstrip("/"), None)
            return (None, under) if under.startswith(_UNKNOWN_CWD + "/") else (UNRESOLVED_DELETE, None)
        field = _SENTINELS.sub(_PLACEHOLDER, field)
    folded = _fold_from(field, cwd, follow)
    if folded is None:
        return UNRESOLVED_DELETE, None
    logical = _logical_reading(field, cwd, follow)
    if logical is not None and (_is_root_folded(logical) or _glob_names_a_root(logical)):
        folded = logical  # P5i: bash's cd applies .. to the text before links (cd -L); the worse reading wins
    if _is_root_folded(folded) or _glob_names_a_root(folded):
        return (UNRESOLVED_DELETE, None) if empty_head else (_ROOT_OR_HOME, folded)
    if _glob_unread(folded):
        return UNRESOLVED_DELETE, None
    if field.startswith("/") and _GLOB.search(posixpath.dirname(_without_trailing_glob(field.rstrip("/")) or "/")):
        return UNRESOLVED_DELETE, None  # a glob in a folder of an absolute path: what it lists is not read here
    if empty_head:
        under = _folded(_UNKNOWN_CWD + "/" + field.lstrip("/"), None)
        return (None, under) if under.startswith(_UNKNOWN_CWD + "/") else (UNRESOLVED_DELETE, None)
    return None, folded


def _logical_reading(field: str, cwd: Optional[str], follow: bool) -> Optional[str]:
    """P5i: the folded path with every .. applied to the written text first (bash's logical cd), or None when the field has
    no .. or its folder is not read. A cd judges this reading and the physical one; rm and find get the worse of both."""
    if ".." not in field.split("/"):
        return None
    if field.startswith("/"):
        text = field
    elif cwd and cwd.startswith("/") and not _unknown(cwd) and not cwd.lower().startswith(_HOME_TOKEN):
        text = posixpath.join(cwd, field)
    else:
        return None
    return _folded(posixpath.normpath(text) + ("/" if field.endswith("/") else ""), None, follow)


# P5t (gates, fail closed): rm -rf '$HOME' deletes a folder literally named $HOME, yet a backend that quotes the line
# again (ssh, docker exec) would expand it; nobody needs a folder of that name, so the literal is read as the home.
# A literal ~ is not: a folder named ~ made by mistake is common and must stay removable.
_LITERAL_HOME_NAME = re.compile(r"(?:\./)?\$(?:HOME|\{HOME\})(?:/(?:[.*?]|\[[!^]?\]?(?:\[:[a-z]+:\]|[^/\]])*\]?)*)*/*\Z")  # also $HOME/* /?* /. /[a-z]*


def _target_hit(path: str, cwd: Optional[str], follow: bool = True) -> Optional[str]:
    """P4/P5, the one check for every destructive target (rm -r, find -delete or -exec rm, rsync --delete, mv to /dev/null,
    and the folder a cd leads to), over every way bash hands the word over: a root, a home or a system root is total
    destruction; a target the line cannot read is the unresolved floor. ``follow`` False only for a program that removes
    a link operand itself (rm, plain find)."""
    if isinstance(path, _Word) and path.unread:
        return UNRESOLVED_DELETE
    runs_head = isinstance(path, _Word) and path.runs_head
    forms = _forms(path)
    linked = bool(getattr(_BUDGET, "linked", False))
    # Every word one brace expansion lists shares its forms: they are read once per decision, not once per word.
    memo = getattr(_BUDGET, "memo", None)
    key = (id(forms), runs_head, cwd, follow, linked)
    if memo is not None and key in memo and memo[key][0] is forms:
        return memo[key][1]
    hit: Optional[str] = UNRESOLVED_DELETE if runs_head else None
    for field, empty_head in forms:
        _spend()
        if field and _LITERAL_HOME_NAME.match(field):
            hit = _ROOT_OR_HOME  # P5t (fail closed): the text $HOME itself, quoted so bash keeps it, as if it were the home
            break
        if field:
            verdict = _form_reading(field, empty_head, cwd, follow)[0]
            if verdict == _ROOT_OR_HOME:
                hit = verdict
                break
            hit = hit or verdict or (UNRESOLVED_DELETE if linked and _may_go_through_a_link(field, follow) else None)
    if memo is not None:
        memo[key] = (forms, hit)
    return hit


def _may_go_through_a_link(field: str, follow: bool = True) -> bool:
    """Pass 5h/5i: after an ln on the line, a path that goes through a folder (any slash after the first name, a trailing
    slash included) or ends in a glob may go through the new link. A bare name is exempt only for a program that acts on
    the link itself (``follow`` False: rm, rmdir, unlink, a plain find); a cd, an rsync destination or find -L follow it."""
    bare = field.rstrip("/")
    return "/" in field.lstrip("/") or bool(_GLOB.search(posixpath.basename(bare))) or (
        follow and not bare.startswith("/") and bare not in ("", ".", ".."))


def _cd_resolved(target: str, cwd: Optional[str]) -> Optional[str]:
    """The folder a cd leads to, the worst of its readings: None when one cannot be read, else a root if one is."""
    if isinstance(target, _Word) and target.unread:
        return None
    folded: List[str] = []
    unread = False
    home = os.environ.get("HOME") or ""
    for field, empty_head in _forms(target):
        if not field and not empty_head:  # cd "" stays in the folder (bash 3.2); a bare cd is handed the home
            folded.append(cwd or "")
            continue
        verdict, one = _form_reading(field or home, empty_head, cwd, True) if field or home else (UNRESOLVED_DELETE, None)
        if verdict == _ROOT_OR_HOME and one is not None:
            return one
        logical = _logical_reading(field, cwd, True) if field and "\x01" not in field else None
        # P5i: the logical folder (cd -L) and the physical one differ: where the cd lands is not read
        unread = unread or verdict == UNRESOLVED_DELETE or one is None or (logical is not None and logical != one) or (
            bool(field) and bool(getattr(_BUDGET, "linked", False)) and _may_go_through_a_link(field, True))
        if one is not None:
            folded.append(one)
    return None if unread else (folded[0] if folded else cwd or "")


# rm's options, BSD and GNU. GNU takes any unambiguous prefix of a long option for it (--rec is --recursive).
_RM_SHORT = frozenset("dfiIPRrvWx")
_RM_LONG = ("--force", "--interactive", "--one-file-system", "--no-preserve-root", "--preserve-root", "--recursive",
            "--dir", "--verbose", "--help", "--version")


def _long_option(arg: str, known: Tuple[str, ...]) -> Optional[str]:
    name = arg.partition("=")[0]
    if name in known:
        return name
    matches = [option for option in known if option.startswith(name)]
    return matches[0] if len(matches) == 1 else None


def _rm_hit(args: List[str], cwd: Optional[str], follow: bool = False, strict: bool = True) -> Optional[str]:
    """``strict`` (rm itself): M1, an option rm does not know may be a recursive one, so it is read as one and the
    delete is at least unresolved, never skipped. A program the gate cannot read (G102) keeps the plain reading."""
    recursive, unknown, operands, flags_done = False, False, [], False
    for arg in args:
        if flags_done or not arg.startswith("-") or arg == "-":
            operands.append(arg)
        elif arg == "--":
            flags_done = True
        elif arg.startswith("--"):
            option = _long_option(arg, _RM_LONG)
            recursive = recursive or option == "--recursive"
            unknown = unknown or option is None
        else:
            recursive = recursive or bool(re.search(r"[rR]", arg))
            unknown = unknown or not set(arg[1:]) <= _RM_SHORT
    unknown = unknown and strict
    if not recursive and not unknown:
        return None
    hits = [_target_hit(op, cwd, follow) for op in operands]
    if _ROOT_OR_HOME in hits:
        return _ROOT_OR_HOME
    if unknown:
        return UNRESOLVED_DELETE
    # A substitution that says what it prints is read, not guessed at: echo ~ is the home however it is spelled.
    if any(_UNRESOLVED.match(said) and _SAYS_A_ROOT.search(said) for said in (getattr(op, "written", "") or op
                                                                           for op in operands)):
        return _ROOT_OR_HOME
    return UNRESOLVED_DELETE if UNRESOLVED_DELETE in hits else None


_FIND_OPTIONS = re.compile(r"-[EHLPXdsx]+")
_FIND_GNU_LEVEL = re.compile(r"-O\d*")
_FIND_FOLLOWS = re.compile(r"-[EHLPXdsx]*[HL][EHLPXdsx]*")
_FIND_SHORT_PRIMARIES = frozenset({"-a", "-o", "-ls", "-ok", "-or", "-and", "-not", "-amin", "-atime", "-cmin", "-ctime",
                                   "-mmin", "-mtime", "-name", "-path", "-type", "-size", "-user", "-perm", "-exec"})
_FIND_UNREAD = _word("", (), unread=True)


def _find_roots(args: List[str]) -> List[str]:
    """find's start points: past its options (BSD -EHLPXdsx grouped, -f PATH, --; GNU -O<n>, -D DEBUG), the words before
    the first expression. D1/M3: any other dash word before the start points makes them unread."""
    roots: List[str] = []
    index, options = 0, True
    while index < len(args):
        arg = args[index]
        if options and arg == "--":
            options = False
        elif options and arg == "-f" and index + 1 < len(args):
            roots.append(args[index + 1])
            index += 1
        elif options and (_FIND_OPTIONS.fullmatch(arg) or _FIND_GNU_LEVEL.fullmatch(arg)):
            pass
        elif options and arg == "-D" and index + 1 < len(args):
            index += 1  # GNU -D debugopts
        elif arg.startswith(("-", "(", "!")):
            # M3: before the start points, only an expression may follow the options (a primary is -word, -ls, -ok...);
            # any other dash word is an option the floor does not know, which may take the next word: unread
            if not roots and not arg.startswith(("(", "!")) and not (
                    re.fullmatch(r"-(?:[a-z]{3,}|B[a-z]+)\w*", arg) or arg in _FIND_SHORT_PRIMARIES):
                roots.append(_FIND_UNREAD)
            break
        else:
            options = False
            roots.append(arg)
        index += 1
    return roots


def _fed_hit(prog: str, args: List[str], feeding: Optional[List[str]], cwd: Optional[str],
             values: Dict[str, List[str]]) -> Optional[str]:
    """``echo ~ | xargs rm -rf``, ``find ~ | xargs rm -rf``: the words come from the command piped in, when it says them."""
    if prog != "rm" or not feeding:
        return None
    source, given, _fed = _program(_expanded(feeding, values))
    if source in ("echo", "printf"):
        words = [w for w in given if not w.startswith(("-", "%"))]
    elif source == "find":
        words = _find_roots(given)
    else:
        return None
    return _rm_hit([*args, *words], cwd)


_FIND_EXEC_DELETES = frozenset({"rm", "unlink", "rmdir", "grm", "gunlink", "grmdir"})  # M7: the GNU spellings too
# --del and every spelling rsync takes as a delete option (--delete, its unambiguous prefixes, --delete-*); not --delay-*.
_RSYNC_DELETE = re.compile(r"--del(?:e(?:t(?:e.*)?)?)?")


# D2: rsync options whose value is the next word (a long one written with = carries its own).
_RSYNC_VALUE_LONG = frozenset({"--exclude", "--include", "--filter", "--exclude-from", "--include-from", "--files-from",
                               "--rsh", "--rsync-path", "--partial-dir", "--temp-dir", "--compare-dest", "--copy-dest",
                               "--link-dest", "--backup-dir", "--suffix", "--chmod", "--chown", "--usermap", "--groupmap",
                               "--log-file", "--log-file-format", "--out-format", "--password-file", "--port",
                               "--sockopts", "--timeout", "--contimeout", "--bwlimit", "--max-size", "--min-size",
                               "--max-delete", "--modify-window", "--block-size", "--iconv", "--protocol",
                               "--checksum-choice", "--compress-choice", "--compress-level", "--skip-compress", "--info",
                               "--debug", "--address", "--config", "--dparam", "--remote-option", "--stop-after",
                               "--stop-at", "--write-batch", "--read-batch", "--only-write-batch", "--outbuf", "--cc",
                               "--zc", "--zl", "--early-input", "--mkpath-dir"})
_RSYNC_VALUE_SHORT = frozenset("efTBM@")


_RSYNC_SHORT = frozenset("vqcarRbudlLkKHpEAXogDtUNOJSnWxyzCFhPi8460sIm")
_RSYNC_FLAG_LONG = frozenset({
    "--verbose", "--quiet", "--no-motd", "--checksum", "--archive", "--recursive", "--relative", "--no-implied-dirs",
    "--backup", "--update", "--inplace", "--append", "--append-verify", "--dirs", "--old-dirs", "--mkpath", "--links",
    "--copy-links", "--copy-unsafe-links", "--safe-links", "--munge-links", "--copy-dirlinks", "--keep-dirlinks",
    "--hard-links", "--perms", "--executability", "--acls", "--xattrs", "--owner", "--group", "--devices", "--specials",
    "--copy-devices", "--write-devices", "--times", "--atimes", "--open-noatime", "--crtimes", "--omit-dir-times",
    "--omit-link-times", "--super", "--fake-super", "--sparse", "--preallocate", "--dry-run", "--whole-file",
    "--one-file-system", "--existing", "--ignore-existing", "--remove-source-files", "--del", "--delete",
    "--delete-before", "--delete-during", "--delete-delay", "--delete-after", "--delete-excluded",
    "--ignore-missing-args", "--delete-missing-args", "--ignore-errors", "--force", "--partial", "--prune-empty-dirs",
    "--numeric-ids", "--ignore-times", "--size-only", "--fuzzy", "--compress", "--cvs-exclude", "--from0", "--old-args",
    "--protect-args", "--secluded-args", "--trust-sender", "--8-bit-output", "--human-readable", "--progress",
    "--itemize-changes", "--stats", "--list-only", "--ipv4", "--ipv6", "--version", "--help", "--delay-updates",
    "--blocking-io", "--msgs2stderr", "--fsync", "--extended-attributes", "--cache", "--checksum-seed", "--max-alloc",
    "--copy-as", "--stderr", "--no-detach", "--detect-renamed"})


def _rsync_unknown_option(args: List[str]) -> bool:
    for arg in args:
        if arg == "--":
            return False
        if arg.startswith("--"):
            name = arg.partition("=")[0]
            plain = "--" + name[5:] if name.startswith("--no-") else name
            if name not in _RSYNC_VALUE_LONG and name not in _RSYNC_FLAG_LONG and plain not in _RSYNC_FLAG_LONG:
                return True
        elif arg.startswith("-") and arg != "-":
            for letter in arg[1:]:
                if letter in _RSYNC_VALUE_SHORT:
                    break
                if letter not in _RSYNC_SHORT:
                    return True
    return False


def _rsync_operands(args: List[str]) -> List[str]:
    """rsync's sources and destination: every word that is not an option or an option's value."""
    operands: List[str] = []
    index, options = 0, True
    while index < len(args):
        arg = args[index]
        if not options or not arg.startswith("-") or arg == "-":
            operands.append(arg)
        elif arg == "--":
            options = False
        elif arg.startswith("--"):
            index += arg in _RSYNC_VALUE_LONG
        else:
            group = arg[1:]
            taking = next((at for at, letter in enumerate(group) if letter in _RSYNC_VALUE_SHORT), None)
            index += taking is not None and taking == len(group) - 1
        index += 1
    return operands


_GIT_VALUE_OPTIONS = frozenset({"-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"})
_GIT_CLEAN_LONG = ("--force", "--dry-run", "--quiet", "--interactive", "--exclude")
_GIT_CLEAN_SHORT = frozenset("dfnqxX")
_REQUIRE_FORCE_OFF = re.compile(r"^clean\.requireforce=(?:false|no|off|0)?$", re.I)


# Pass 5j (lens P-2): git reads config and its tree from the environment too (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/
# KEY_n/VALUE_n, GIT_CONFIG*, GIT_WORK_TREE, GIT_DIR) and from -c core.worktree. When the line names any of them, a git
# clean on it is read as forced and its tree as unknown: unresolved, whatever its own options say.
_GIT_ENV_CONFIG = re.compile(r"GIT_(?:CONFIG\w*|WORK_TREE|DIR|COMMON_DIR|INDEX_FILE)|core\.worktree", re.IGNORECASE)


def _git_clean_hit(args: List[str], cwd: Optional[str]) -> Optional[str]:
    """Pass 5h/5i/5j: git [-C DIR]... clean with -f (any spelling: -f, --force or a prefix of it, or -c clean.requireForce
    turned off), with or without -d, deletes what it is given (a line naming GIT_CONFIG*, GIT_WORK_TREE, GIT_DIR or
    core.worktree makes it unresolved, forced or not): each path argument (relative to DIR or the call's folder) is read as a
    recursive delete of that path, and with none, of DIR's contents (rm -rf DIR/*). Unresolved: an option it does not
    know (-i, an unknown letter or long name), a pathspec with magic (any argument starting with :), a -C folder it
    cannot read, a tree named elsewhere (--work-tree, --git-dir). -e takes the rest of its cluster or the next word."""
    gitenv = bool(getattr(_BUDGET, "gitenv", False))
    at, base, elsewhere, force = 0, cwd, gitenv, gitenv
    while at < len(args) and args[at].startswith("-"):
        option = args[at].partition("=")[0]
        elsewhere = elsewhere or option in ("--git-dir", "--work-tree")
        if args[at] == "-C" and at + 1 < len(args):
            base = _cd_resolved(args[at + 1], base)
            if base is None:
                elsewhere = True
        value = str(args[at + 1]) if args[at] == "-c" and at + 1 < len(args) else (
            str(args[at])[2:] if str(args[at]).startswith("-c") and len(str(args[at])) > 2 else None)
        if value is not None and _REQUIRE_FORCE_OFF.match(value):
            force = True
        elif (value is not None and re.search(r"[$`\\]", value)) or option == "--config-env":
            elsewhere = True  # a config value it cannot read: a forced clean is unresolved
            force = True
        at += 2 if args[at] in _GIT_VALUE_OPTIONS or args[at] == "-C" else 1
    if at >= len(args) or args[at] != "clean":
        return None
    letters, unknown, dry, paths, index = set(), False, False, [], at + 1
    while index < len(args):
        arg = str(args[index])
        if arg == "--":
            paths.extend(args[index + 1:])
            break
        if arg.startswith("--"):
            name = arg.partition("=")[0]
            known = [o for o in _GIT_CLEAN_LONG if o.startswith(name)] if len(name) > 2 else []
            if len(known) != 1:
                unknown = True
            elif known[0] == "--force":
                letters.add("f")
            elif known[0] == "--dry-run":
                dry = True
            elif known[0] == "--interactive":
                unknown = True
            elif known[0] == "--exclude" and "=" not in arg:
                index += 1
        elif arg.startswith("-") and len(arg) > 1:
            for at_letter, letter in enumerate(arg[1:]):
                if letter == "e":
                    index += at_letter == len(arg) - 2  # -e PATTERN: the next word; -ePATTERN: the rest of the cluster
                    break
                if letter not in _GIT_CLEAN_SHORT:
                    unknown = True
                letters.add(letter)
        else:
            paths.append(args[index])
        index += 1
    if "n" in letters or dry:
        return None if not unknown else UNRESOLVED_DELETE
    if unknown:
        return UNRESOLVED_DELETE
    if not (force or "f" in letters):
        return None  # without a force git refuses (clean.requireForce, unless a config file it does not read says so)
    if elsewhere or any(str(p).startswith(_GIT_PATHSPEC_MAGIC) for p in paths):
        return UNRESOLVED_DELETE
    if not paths:
        return _target_hit(_plain("*"), base)
    hit: Optional[str] = None
    for path in paths:
        one = _target_hit(path, base)
        if one and one not in UNRESOLVED_DELETES:
            return one
        hit = hit or one
    return hit


# P5r (lens W4, proven): a wrapper or launcher option that takes a value the floor does not know (caffeinate -t 60,
# exec -a x, env -P DIR, timeout --signal KILL, taskpolicy -b, lockf -k f) made the next word read as the program. No
# option grammar is imitated: after any wrapper or launcher word, every later word that is a delete program is judged
# from there, and a quoted word whose first token is one (csh -c 'rm -rf ~', apply 'rm -rf %1' ~) is read as code.
_LAUNCHERS = _WRAPPERS | frozenset({"csh", "tcsh", "taskpolicy", "xcrun", "sandbox-exec", "lockf", "apply", "coproc",
                                    "ssh-agent", "lldb", "dtrace", "chroot", "launchctl", "open", "osascript", "script",
                                    "su", "runuser", "setsid", "flock", "unbuffer", "time", "gtime", "chronic", "nocache",
                                    # P5s (lens W5a, proven): programs that run the command they are given
                                    "leaks", "xctrace", "instruments", "dtruss", "hyperfine", "gdb", "valgrind",
                                    "torsocks", "proxychains", "proxychains4", "fakeroot", "login", "at", "batch"})
_DELETE_PROGRAMS = frozenset({"rm", "grm", "rmdir", "unlink", "find", "gfind", "rsync", "grsync", "git"})


def _launched_hit(words: List[str], cwd: Optional[str]) -> Optional[str]:
    launched = False
    for j, word in enumerate(words):
        name = _plain_name(posixpath.basename(word).lower())
        if launched and j:
            # P5s (lens W5a, proven): env -S'code' / --split-string=code runs that code, the option written onto it
            split = re.match(r"(?:-[A-Za-z]*S|--split-string=)(.+)", word, re.S)
            if split and split.group(1).split():
                hit = destruction_of(split.group(1), cwd)
                if hit:
                    return hit
            if name in _DELETE_PROGRAMS:
                hit = _command_hit(_GNU_NAMES.get(name, name), words[j + 1:], cwd)
                if hit:
                    return hit
            first = word.split()[0] if word.split() else ""
            if " " in word and posixpath.basename(first).lower() in _DELETE_PROGRAMS:
                hit = destruction_of(re.sub(r"%\d", "$X9", word), cwd)
                if hit:
                    return hit
        launched = launched or name in _LAUNCHERS
    return None


def _command_hit(prog: str, args: List[str], cwd: Optional[str]) -> Optional[str]:
    lowered = [a.lower() for a in args]
    if prog == "rm":
        return _rm_hit(args, cwd)
    if prog == "git":
        return _git_clean_hit(args, cwd)
    if "--help" in lowered:
        return None
    if prog == "find" and ("-delete" in lowered or (bool({"-exec", "-execdir", "-ok", "-okdir"} & set(lowered))
                                                    and any(posixpath.basename(a) in _FIND_EXEC_DELETES for a in lowered))):
        follows = "-follow" in lowered or any(_FIND_FOLLOWS.fullmatch(a) for a in args)
        # D6: following links below a start point reaches whatever they point to, which is not read here.
        hits = [_target_hit(root, cwd, follows) for root in _find_roots(args)]
        if _ROOT_OR_HOME in hits:
            return _ROOT_OR_HOME
        if follows:
            return FOLLOWED_LINKS_DELETE
        if UNRESOLVED_DELETE in hits:
            return UNRESOLVED_DELETE
    if prog == "rsync" and any(_RSYNC_DELETE.fullmatch(a) for a in lowered):
        plain = _rsync_operands(args)
        hit = _target_hit(plain[-1], cwd) if plain else None
        if hit == _ROOT_OR_HOME:
            return hit
        if _rsync_unknown_option(args):  # M1: an option not known here may take a value and move the destination
            return UNRESOLVED_DELETE
        if hit:
            return hit
    if prog == "mv":
        # Lead ruling: a root, a home or a glob under one thrown to /dev/null. Other moves, a Trash too, are a stated limit.
        # D11: mv renames a link operand itself, it never moves what the link points to.
        plain = [a for a in args if not a.startswith("-")]
        if len(plain) >= 2 and plain[-1] == "/dev/null" and any(_target_hit(a, cwd, follow=False) == _ROOT_OR_HOME for a in plain[:-1]):
            return _ROOT_OR_HOME
    if prog in _DISK_WRITE_ANY and any(_DISK_DEVICE.match(a) for a in lowered):
        return "raw write to a disk"
    if prog in _DISK_WRITE_LAST and lowered and _DISK_DEVICE.match(lowered[-1]):
        return "raw write to a disk"
    if prog == "fdisk" and set(lowered) & _FDISK_WRITES:
        return "changing how a disk is partitioned"
    if prog == "gpt" and lowered and not set(lowered) & _GPT_READS:
        return "changing how a disk is partitioned"
    if prog == "asr" and lowered[:1] == ["restore"] and ("--erase" in lowered or any(_DISK_DEVICE.match(a) for a in lowered)):
        return "erasing a disk"
    if prog == "dd" and any(a.startswith("of=") and _DISK_DEVICE.match(a[3:]) for a in lowered):
        return "raw write to a disk"
    if prog == "diskutil":
        verbs = lowered[1:2] if lowered[:1] and lowered[0] in _DISKUTIL_NEST else lowered[:1]
        if any(verb in _DISKUTIL_ERASE or verb.startswith("erase") for verb in verbs):
            return "erasing a disk"
    if prog == "mkfs" or prog.startswith(("mkfs.", "newfs")):
        return "formatting a disk"
    if prog in ("kextunload", "kextload") or (prog == "kmutil" and lowered[:1] and lowered[0] in ("unload", "load")):
        return "changing what the kernel has loaded"
    if prog == "nvram" and args and any(a.startswith("-") and a[1:2] in "cdf" or "=" in a for a in args):
        return "changing the firmware settings"
    if prog == "bless" and args and not set(lowered) & _BLESS_READS:
        return "changing how the machine boots"
    if prog == "csrutil" and lowered[:1] and lowered[0] not in _CSRUTIL_READS:
        return "changing System Integrity Protection"
    if prog == "sysctl" and any(a.lstrip("-").split("=")[0] in _CRITICAL_SYSCTL and "=" in a for a in lowered):
        return "changing a kernel setting the machine cannot run without"
    return None


# G102 (rehearsal B M1): a program word that is only a value filled in when it runs (`$CMD`, `${X}`, `"$RM"`, `$(…)`, a
# backtick) cannot be read, so it is read as the worst program its arguments allow: a recursive delete. Decoded or eval'd
# computed text is not read here; that stays the declared limit.
_UNREAD_PROGRAM = re.compile(r"^[$`]|\x01|[*?\[]")  # P5w (lens W7): a globbed program name (/bin/r[m]) is not read
_TEST_PROGRAMS = frozenset({"[", "[["})  # P5x (lens X8): the test command and keyword run no program; [ -r / ] stays ordinary
_UNREAD_DESTRUCTION = "recursive delete of the whole disk, a home folder or the system, by a program this gate cannot read"


def _unread_program_hit(args: List[str], cwd: Optional[str]) -> Optional[str]:
    hit = _rm_hit(args, cwd, follow=True, strict=False)
    return _UNREAD_DESTRUCTION if hit and hit not in UNRESOLVED_DELETES else hit


# T=$(mktemp -d ...), T="$(mktemp)", T=`mktemp`: mktemp prints a new path under the temp folder or the folder it is given,
# never a root, so the variable is resolved. Only mktemp and its own words: a ; or a pipe in the substitution stays unread.
# An environment prefix (TMPDIR=/tmp) and a quoted template, with ${NAME} or ${NAME:-word} in it, are mktemp's own words.
_MKTEMP_WORD = r"(?:\"(?:[^\"`()$\\]|\$\{[A-Za-z_]\w*(?::?-[^}\"`()$]*)?\})*\"|'[^']*'|[^\s()`;&|<>\"'$\\]+)"
_MKTEMP_CALL = (r"\s*(?:[A-Za-z_]\w*=" + _MKTEMP_WORD + r"?\s+)*(?:/usr/bin/)?mktemp(?:[ \t]+" + _MKTEMP_WORD + r")*[ \t]*")
_MKTEMP_ASSIGNMENT = re.compile(r"(\b[A-Za-z_][A-Za-z0-9_]*=)(?:\"\$\(" + _MKTEMP_CALL + r"\)\"|\$\(" + _MKTEMP_CALL + r"\)|`"
                                + _MKTEMP_CALL + r"`)")
_MKTEMP_STAND_IN = "/private/tmp/mktemp.made"
# P5i: cd "$(mktemp -d)" (or pushd, unquoted, backticks) lands in a fresh temp folder.
_MKTEMP_CD = re.compile(r"(\b(?:cd|pushd)[ \t]+)(?:\"\$\(" + _MKTEMP_CALL + r"\)\"|\$\(" + _MKTEMP_CALL + r"\)|`"
                        + _MKTEMP_CALL + r"`)(?=[ \t]*(?:$|[;&|\n)]))")


_ARRAY_ASSIGNMENT = re.compile(r"(?<![\w$])([A-Za-z_][A-Za-z0-9_]*)=\(([^()]*)\)")
_ARRAY_USE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\[[^\]]*\]\}")
_DEFAULT_WORD = re.compile(r"\$\{(?!HOME\b)([A-Za-z_][A-Za-z0-9_]*):?[-=]([^}]*)\}")


def only_names_the_original_resolves(original: str, normalised: str) -> bool:
    """P5b/P5c: the normalised reading drops ``${X:-w}`` to ``$X`` and hoists ``T=$(mktemp)`` out of its assignment. Its
    unresolved delete is forgiven only when the same text, with each such name set first to its written default word or
    to mktemp's path, deletes nothing unresolved: names that never reach a delete target (``$JOBS``, ``$SRC``) do not
    count, and a name or a substitution that does reach one, with no default, still stands."""
    given = {m.group(1): m.group(2) for m in _DEFAULT_WORD.finditer(original) if m.group(2).strip()}
    given.update({m.group(1).rstrip("="): _MKTEMP_STAND_IN for m in _MKTEMP_ASSIGNMENT.finditer(original)})
    if not given:
        return False
    prefix = "".join(f"{name}={shlex.quote(word)}; " for name, word in given.items())
    return destruction_of(prefix + normalised) is None


# D7: the GNU spellings Homebrew installs (grm, gfind, grsync, gmv) are the same programs.
_GNU_NAMES = {"grm": "rm", "gfind": "find", "grsync": "rsync", "gmv": "mv"}


def _assigned(values: Dict[str, List[str]], word: str) -> None:
    name = word.partition("=")[0]
    if isinstance(word, _Word) and word.unread:
        values.pop(name, None)  # a value only known when it runs: the name is read as unknown
        return
    values[name] = list(dict.fromkeys(field.partition("=")[2] for field, _head in _forms(word))) or [""]


def destruction_of(text: str, cwd: Optional[str] = None, categories: bool = True) -> Optional[str]:
    """What total destruction this shell text would do, in plain words, or None. A ``cd`` or ``pushd`` on the line moves
    the cwd, and what the line assigns is read where it is used. Pass 5f: one line has _LINE_STEPS reading steps in all (bash
    calls and the reading after them, an eval inside it included); past it the line is a delete it cannot read."""
    owner = getattr(_BUDGET, "left", None) is None
    if owner:
        _BUDGET.left, _BUDGET.memo, _BUDGET.linked = _LINE_STEPS, {}, False
        _BUDGET.gitenv = bool(_GIT_ENV_CONFIG.search(text))  # pass 5j (lens P-2)
        _BUDGET.categories = categories  # P5y8: the category rules judge the line as written, not a normaliser variant
    try:
        with walk_snapshot():
            return _destruction_of(text, cwd)
    except _OutOfTime:
        if not owner:
            raise
        return UNRESOLVED_DELETE
    finally:
        if owner:
            _BUDGET.left = _BUDGET.memo = _BUDGET.linked = _BUDGET.gitenv = None


def _uncommented(text: str) -> str:
    """The line without its comments: an unquoted # that starts a word ends the command, up to the newline. A word starts
    only after a space, a tab or ;&|()\\n (never after \\r). A line with $( ), a backtick or a heredoc keeps its comments:
    the floor does not read a comment inside them (pass 5g)."""
    if "$(" in text or "`" in text or "<<" in text:
        return text
    out, index = [], 0
    while index < len(text):
        char = text[index]
        if char in _BLANKS or (char in _PUNCTUATION and not _process_substitution(text, index)):
            out.append(char)
            index += 1
        elif char == "#" and (not index or text[index - 1] in " \t\n;&|()"):
            end = text.find("\n", index)
            index = len(text) if end < 0 else end
        else:
            end = _close(text, index, "")
            end = len(text) if end < 0 else max(end, index + 1)
            out.append(text[index:end])
            index = end
    return "".join(out)


# Names whose value changes how a later word is split (IFS) or where a relative cd lands (CDPATH).
_SPLIT_OR_CD_NAME = re.compile(r"^(IFS|CDPATH)(?:\+?=|$)")
# Pass 5g: shell state that changes what a cd does (shopt cdable_vars, an alias, a function named cd): every cd is unknown.
_CD_REDEFINED = re.compile(r"\b(?:shopt|alias|unalias)\b|\bfunction\s+(?:cd|pushd|popd)\b"
                           r"|(?:^|[\s;&|({])(?:cd|pushd|popd)\s*\(\s*\)")
# A folder change before a program (env -C DIR, sudo -D DIR, --chdir): the program runs where the floor does not read.
_CHDIR_OPTION = re.compile(r"^(?:-[A-Za-z]*[CD]|--chdir)")
_REDIRECTION = re.compile(r"^[0-9]*[<>&][<>&|]*$")
_CD_NOT_THROUGH_CDPATH = re.compile(r"^(?:/|\.\.?(?:/|$))")
# Pass 5h: a word that names CDPATH or HOME other than to read it ($X, ${X}, ${X%..}) may give it a value: ${X:=w}, read X,
# printf -v X, declare/export/local X, mapfile X, getopts .. X, X=w.
_NAMES_CDPATH = re.compile(r"(?<![$\w{])CDPATH\b|\$\{CDPATH:?=")
_NAMES_HOME = re.compile(r"(?<![$\w{])HOME\b|\$\{HOME:?=")
# A redirection of the output or the errors to /dev/null never changes where a cd goes.
_TO_DEV_NULL = frozenset({">", "1>", "2>", "&>", ">>", "1>>", "2>>", "&>>", ">|", "1>|", "2>|"})


# Pass 5g: a # at a word start anywhere, inside $( ) and backticks too, up to the newline.
_ANY_COMMENT = re.compile(r"(?:^|(?<=[ \t\n;&|()]))#[^\n]*")


def _chdir_places(prefix: List[str], here: Optional[str]) -> List[Optional[str]]:
    """The folder a wrapper moves its program to (env -C DIR, sudo -D DIR, --chdir[=]DIR); unknown when not read."""
    found: List[Optional[str]] = []
    for at, word in enumerate(prefix):
        text = str(word)
        if not _CHDIR_OPTION.match(text):
            continue
        attached = re.match(r"-[A-Za-z]*[CD](.+)", text)
        forms = _forms(word)
        if (text == "--chdir" or not attached) and at + 1 < len(prefix):
            target = prefix[at + 1]
        elif text.startswith("--chdir=") and len(forms) == 1:
            target = _plain(forms[0][0][len("--chdir="):])
        elif attached and not text.startswith("--") and len(forms) == 1 and not getattr(word, "unread", False):
            target = _plain(attached.group(1))  # env -C/, env -iC/, sudo -D/: the folder written after the letter
        else:
            target = _word("", (), unread=True)
        folded = _cd_resolved(target, here)
        found.append(_UNKNOWN_CWD if folded is None else folded or here)
    return found


# P5u-P5x (lenses W6, W7, X8, proven): with extglob on (bash -O extglob, shopt -s extglob) rm -rf ~/@(*) lists every
# name in the home, and the floor's reading splits the word at the parenthesis. An extglob pattern is replaced by a
# value the floor does not read, so the normal reading judges the line with its own program and target rules. A
# pattern lives inside one word: it never spans a space, a quote or ; & < > ` (P5x: '?(' && rm -rf ~ && ')' spanned
# two quoted strings and hid the delete). An opener left without its closing parenthesis is replaced the same way and
# the line is then unresolved at least, when it names a delete program: refused in Ignore and Plan, asked elsewhere.
_EXTGLOB = re.compile(r"[@!+?*]\(")
_EXTGLOB_BODY = r"[^()\s'\";&<>`$]"  # P5x3 (lens W10): never a $( ), which bash runs inside a pattern too
_EXTGLOB_PATTERN = re.compile(r"[@!+?*]\((?:" + _EXTGLOB_BODY + r"|\(" + _EXTGLOB_BODY + r"*\))*\)")
_DELETE_WORD = re.compile(r"(?<![\w.-])(?:g?rm|g?rmdir|g?unlink|g?find|g?rsync|git|g?mv)(?![\w-])", re.I)  # RM runs rm here
# P5x3 (lens W10, proven): bash expands braces before ~ and $NAME, so {rm,-rf,~} and rm {-rf,~} run rm -rf on the
# home; such a brace word is outside the grammar given to bash and is judged by _unread_by_category (P5y).
_BRACE_SPLIT = re.compile(r"[{},]")


def _names_a_delete(text: str) -> bool:
    """A delete program named on the line, also when quotes, escapes or brace commas build or split the word."""
    return bool(_DELETE_WORD.search(_WORD_NOISE.sub("", text))
                or _DELETE_WORD.search(_BRACE_SPLIT.sub(" ", re.sub(r"[\\'\"]", "", text))))


def _destruction_of(text: str, cwd: Optional[str]) -> Optional[str]:
    """A line with $( ) or backticks and a # is read twice, as written and with every such # taken as a comment (the
    floor does not read a comment inside a substitution); the worse reading wins."""
    text = text.replace("\\\n", "")  # P5n (lens X): a backslash-newline joins the two halves of a word for bash
    if _EXTGLOB.search(text):
        # P5w-P5x (lenses W6/X7/W7/X8, proven): an extglob pattern is a value the floor does not read; the normal
        # reading then judges the line with its own program rules (RM, r"m", ${X}rm...). An opener left unbalanced is
        # replaced too, so what follows it is still read, and the line is at least unresolved when it names a delete.
        text = _EXTGLOB_PATTERN.sub("$__iclone_extglob", text)
        if _EXTGLOB.search(text):
            names_a_delete = _names_a_delete(text)
            text = _EXTGLOB.sub("$__iclone_extglob ", text)
            if names_a_delete:
                found = _destruction_of(text, cwd)
                return found if found and found not in UNRESOLVED_DELETES else UNRESOLVED_DELETE
    denoised = _WORD_NOISE.sub("", text)
    if _ALIAS_DEFINITION.search(denoised) or (_ALIAS_ANYWHERE.search(denoised) and _MORE_THAN_ONE_COMMAND.search(text)):
        return UNRESOLVED_DELETE  # P5l (lens S): the runtime runs commands with aliases expanded; an alias made on the line is not read
    if ("$(" in text or "`" in text) and _ANY_COMMENT.search(text):
        readings = (_destruction_of_line(text, cwd), _destruction_of(_ANY_COMMENT.sub("", text), cwd))
        found = next((r for r in readings if r and r not in UNRESOLVED_DELETES), None) or readings[0] or readings[1]
    else:
        found = _destruction_of_line(text, cwd)
    if (not found or found in UNRESOLVED_DELETES) and getattr(_BUDGET, "categories", True) and _unread_by_category(text):
        return found or UNRESOLVED_DELETE
    return found


# P5y (lenses W10/W11, method change after three lenses in a row found new spellings): what the floor does not read
# is refused by category, not by spelling. On a line the normal reading finds no total destruction in, the line is
# at least unresolved when it has (a) a brace word bash would expand that is outside the grammar given to bash
# (nested lists, ~ or $ in an item, $'..') and the line names a delete program, the word carries a recursive flag
# (-r, -R, --recursive, -delete, --delete, clean) or the word starts a command; (b) IFS set, exported or read on the
# line and any $ outside double quotes (a program or a target split on IFS, also in code eval reads again); (c) a positional parameter ($@ $* $1 ${1}) on a line that
# names a delete program. Brace words are also judged with the line's quotes taken away (env -S, at and a shell's stdin read
# a string again as code). The whole line is judged, so a harmless brace or IFS use next to an ordinary delete is
# refused in Ignore too: a stated over-refusal.
_BRACE_WORD = re.compile(r"[^\s;&|<>()]*\{[^\s;&|<>()]*")
_RECURSIVE_HINT = re.compile(r"(?<![\w-])-(?!-)[A-Za-z]*[rR]|--recursive|-delete|--delete|(?<![\w-])clean(?![\w-])")  # P5y8: --grep is not -r
_COMMAND_START_BRACE = re.compile(r"(?:^|[;&|(`\n]|\$\(|\b(?:do|then|else|eval|exec|sudo|env|xargs|-exec|-execdir)\s)\s*['\"]?\{")
_IFS_SET = re.compile(r"(?<![\w$])IFS\+?=|\b(?:for|select)\s+IFS\b|\b(?:export|declare|local|readonly|typeset|read|printf\s+-v)\b[^;&|\n]*\bIFS\b")
_POSITIONAL = re.compile(r"\$(?:[@*]|\d|\{[@*\d])")
_QUOTED_TEXT = re.compile(r"\"(?:[^\"\\]|\\.)*\"")  # double quotes only: a $ in single quotes counts (eval reads it again)


def _unread_by_category(text: str) -> bool:
    """Brace words are also judged with the quotes taken away: env -S, at and a shell's stdin read a quoted string
    again as code."""
    return _unread_by_category_once(text) or _unread_by_category_once(re.sub(r"[\\'\"]", "", text), braces_only=True)


_ANSI_C_WORD = re.compile(r"\$'((?:[^'\\]|\\.)*)'")


def _ansi_c_decoded(text: str) -> str:
    """Every $'..' on the line written out as bash decodes it (\\xHH, \\NNN octal, \\uHHHH and the C escapes)."""
    def one(m):
        try:
            return codecs.decode(m.group(1).encode("latin-1", "backslashreplace"), "unicode_escape")
        except Exception:
            return " rm -rf / "  # an escape the floor cannot decode stays unread: judged as a delete
    return _ANSI_C_WORD.sub(one, text)


_SUBST_SPAN = re.compile(r"\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`")
_SEGMENT_SPLIT = re.compile(r"&&|\|\||[;&|\n()]|(?<![\w-])(?:then|do|else|elif|if|while|until|time)(?![\w-])")
_SKIP_FIRST = frozenset({"env", "command", "builtin", "exec", "sudo", "nohup", "nice", "xargs", "eval", "!", "{", "}",
                         "time", "coproc", "doas", "caffeinate", "timeout", "gtimeout", "stdbuf", "ionice", "chrt"})
_RECURSIVE_FLAG = re.compile(r"(?<![\w-])(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive|-delete)(?![\w-])")


_SET_BY_OTHER = r"\b(?:read|for|select|declare|local|export|readonly|typeset|printf|mapfile|readarray|getopts)\b[^;&|\n]*\b{n}\b"


def _set_once(n: str, context: str) -> Optional[str]:
    """P5y9 (panel 6 B, major): the written text a name holds when the line uses it, or None when that is not known.
    Known only when the line sets it exactly once, as a statement of its own (at the start, after ; or a newline, not
    after && or ||, not in front of a command), before its first use, with no function or subshell on the line and
    no read/for/declare/export/printf -v of it. Otherwise the name keeps what the environment gave it: unknown."""
    if re.search(r"\(\s*\)\s*\{|\bfunction\b", context):
        return None
    if re.search(_SET_BY_OTHER.format(n=n), context):
        return None
    every = list(re.finditer(rf"(?<![\w$]){n}\+?=", context))
    stmt = list(re.finditer(rf"(?:^|(?<=[;\n]))[ \t]*{n}=([^\s;&|$`()'\"]*)[ \t]*(?=;|\n|$)", context))
    stmt += list(re.finditer(rf"(?<![\w-])(?:-[A-Za-z]*c|eval|-S)[ \t]+['\"][ \t]*{n}=([^\s;&|$`()'\"]*)[ \t]*(?=;)", context))
    # P5y9b (R5 fuzz): sh -c 'x=grep; $x -r ..': the first statement of a string that -c, eval or env -S runs
    if len(every) != 1 or len(stmt) != 1:
        return None
    use = re.search(rf"\$(?:\{{{n}[}}:%#/^,!-]|{n}(?!\w))", context)
    if not use or use.start() < stmt[0].end():
        return None
    before = context[:stmt[0].start()]
    if before.count("(") != before.count(")") or before.count("{") != before.count("}"):
        return None  # inside a subshell or a group: it may not run, or not reach the use
    return stmt[0].group(1)


def _known_names(seg: str, context: str) -> str:
    """P5y8 (R5 fuzz): seg with $'..' decoded and every name the line sets once, to one written text, written out
    (x=grep; $x -r reads as grep -r). A name set more than once or by read/for/declare/printf -v stays as it is."""
    seg = _ansi_c_decoded(seg) if "$'" in seg else seg
    for n in set(re.findall(r"\$\{?([A-Za-z_]\w*)", seg)) - {"HOME"}:
        value = _set_once(n, context)
        if value is not None:
            seg = re.sub(rf"\$(?:\{{{n}\}}|{n}(?!\w))", lambda m: value, seg)
    return seg


def _unread_recursive_command(text: str) -> bool:
    """A command whose program word the floor does not read (a $, a substitution, a quote, a backslash, a brace list
    or a glob in the word; wrappers, keywords, assignments and their flags are passed over) and that carries a
    recursive flag in any spelling, in that same command."""
    for seg in _SEGMENT_SPLIT.split(_SUBST_SPAN.sub(lambda m: " $__iclone_subst " + m.group(0).replace(";", " ")
                                                    .replace("|", " ").replace("&", " ") + " ", text)):
        words = _known_names(seg, text).split()
        while words and (words[0] in _SKIP_FIRST or words[0].startswith("-") or words[0].isdigit()
                         or re.match(r"^[A-Za-z_]\w*\+?=", words[0])):
            words.pop(0)
        plain_prog = re.sub(r"[\\'\"]", "", words[0]) if words else ""
        if words and re.fullmatch(r"[\w./+-]+", plain_prog):
            continue  # P5y8 (R5 fuzz): gr'e'p -r reads as grep once quotes go: a plain program that deletes nothing
        if (words and words[0] not in _TEST_PROGRAMS and re.search(r"[$`'\"\\*?\[]|\{[^}]*[,.][^}]*\}", words[0])
                and _RECURSIVE_FLAG.search(_flat(" ".join(words[1:])))):
            return True
    return False


def _flat(text: str) -> str:
    """The line as words: $'..' decoded, quotes and backslashes taken away, brace commas split; then the same once
    more with the brace marks taken away, so -{r,}f also reads as -rf."""
    plain = re.sub(r"[\\'\"]", "", _ansi_c_decoded(text))
    return _BRACE_SPLIT.sub(" ", plain) + " " + re.sub(r"[{},]", "", plain)


def _in_single_quotes(text: str, pos: int) -> bool:
    """True when pos sits inside a '..' string (outside double quotes, after no backslash), where bash expands nothing."""
    single = double = False
    i = 0
    while i < pos:
        c = text[i]
        if c == "\\" and not single:
            i += 2
            continue
        if c == "'" and not double:
            single = not single
        elif c == '"' and not single:
            double = not double
        i += 1
    return single


_LEADING_REDIRECT = re.compile(r"(^|[;&|(\n`]|\$\(|&&|\|\|)(\s*)((?:\d*(?:>>?|<<?|&>>?|>&|<&|>\|)\s*[^\s;&|<>]+\s+)+)")


_REREAD = re.compile(r"(?<![\w-])(?:eval|-S|-[A-Za-z]*c)(?![\w-])")  # -c, also clustered (bash -lc)
_HOME_REF = re.compile(r"^\$(?:HOME|\{HOME(?:(?:[%#/^,]|:(?!\+))[^}]*)?\})$")  # ${HOME:+w} is w, not the home
_DEFAULT_REF = re.compile(r"^\$\{[A-Za-z_]\w*:?[-=]([^}]*)\}$")
_UNREAD_WORD = re.compile(r"[$`]")


def _canonical_delete(seg: str, context: str = "") -> Optional[str]:
    """The worst case of one command whose program or arguments are only known when it runs: quotes taken away, an
    unread or delete-named program written rm, a home reference ~, ${X:-w} its w, any other expansion -rf. None when the
    command has no such word or its program is a plain word that is not a delete."""
    seg = _known_names(seg, context)
    if not _REREAD.search(seg):  # a '..' string outside eval, env -S and -c is text bash never expands (P5y8: in
        toks, seen_prog = [], False  # the arguments only; a quoted program word is still that word)
        for tok in seg.split():
            plain = re.sub(r"[\\'\"]", "", tok)
            if not seen_prog and (plain in _SKIP_FIRST or plain.startswith("-") or plain.isdigit()
                                  or re.match(r"^[A-Za-z_]\w*\+?=", plain) or re.match(r"^\d*[<>]", plain)):
                toks.append(tok)
                continue
            if seen_prog and re.fullmatch(r"'[^']*'", tok):
                tok = "lit"  # a whole quoted word after the program
            seen_prog = True
            toks.append(tok)
        seg = " ".join(toks)
    words = re.sub(r"[\\'\"]", "", seg).split()
    while words and (words[0] in _SKIP_FIRST or words[0].startswith("-") or words[0].isdigit()
                     or re.match(r"^[A-Za-z_]\w*\+?=", words[0]) or re.match(r"^\d*[<>]", words[0])):
        words.pop(0)
    if not words or not any(_UNREAD_WORD.search(w) for w in words):
        return None
    for n in set(re.findall(r"\$\{?([A-Za-z_]\w*)", " ".join(words))) - {"HOME"}:
        value = _set_once(n, context)  # P5y6-P5y9: see _set_once; otherwise unknown (worst case -rf)
        if value is not None:
            words = [re.sub(rf"\$(?:\{{{n}\}}|{n}(?!\w))", lambda m: value, w) for w in words]
    if not any(_UNREAD_WORD.search(w) for w in words[1:]) and not _UNREAD_WORD.search(words[0]):
        return None
    prog = words[0]
    if prog in _TEST_PROGRAMS:
        return None
    if not (_UNREAD_WORD.search(prog) or "{" in prog or re.search(r"[*?\[]", prog) or re.fullmatch(r"\s*g?(?:rm|rmdir|unlink)\s*", _flat(prog).split(" ")[0] if _flat(prog).strip() else "")):
        return None  # P5y5: only an unread program or rm/rmdir/unlink is rewritten as rm (git, find, mv keep their own reading)
    out = ["rm"]
    for w in words[1:]:
        if _HOME_REF.match(w):
            out.append("~")
        elif _DEFAULT_REF.match(w):
            out.append(_DEFAULT_REF.match(w).group(1) or "-rf")
        elif _UNREAD_WORD.search(w) and re.match(r"[~/]", w) and re.search(r"\$(?:\{[^}]*\}|\w+)/?$", w):
            out.append(re.sub(r"\$(?:\{[^}]*\}|\w+)|`[^`]*`", "*", w))  # P5y5: ~/$x is ~/* in the worst case
        elif _UNREAD_WORD.search(w) and not re.search(r"\$(?:HOME|\{HOME)", w):
            out.append("-rf")
        else:
            out.append(w.replace("${HOME}", "~").replace("$HOME", "~"))
    if not _RECURSIVE_FLAG.search(" ".join(out[1:])):
        return None  # P5y5: the worst case counts only with a recursive flag
    return " ".join(out)


def _unread_by_category_more(text: str) -> bool:
    """P5y4 (lens X10, proven): (g) a redirection written before the command (2>/dev/null rm -rf ~) is read with the
    redirection moved away; (h) a word that is only an expansion ($F, ${!#}, $(echo -rf), `x`) in a command is read as
    -rf, so a delete whose flag or target is only known when it runs is at least unresolved when it could be total."""
    moved = _LEADING_REDIRECT.sub(lambda m: m.group(1) + m.group(2), text)
    if moved != text:
        found = _destruction_of(moved, None)
        if found:
            return True
    rereads = bool(_REREAD.search(text))  # P5y5: code in eval, env -S or -c strings is read again, quotes and all
    if rereads:  # P5y5 (W13): the string after eval, env -S or -c, unquoted as bash does, read again as code
        try:
            toks = shlex.split(text.replace("\n", " ; "), posix=True)
        except ValueError:
            toks = []
        for i, t in enumerate(toks[:-1]):
            if t in ("eval", "-S") or re.fullmatch(r"-[A-Za-z]*c", t) or (t.startswith("-S") and len(t) > 2):
                inner = t[2:] if t.startswith("-S") and len(t) > 2 else toks[i + 1]
                sets = re.findall(r"(?<![\w$])([A-Za-z_]\w*=[^\s;&|$`()'\"]*)(?=[\s;&|]|$)", text)
                sets = [a for a in sets if a not in inner]  # P5y9b: an assignment inside the string is read there, once
                inner = "; ".join(sets + [inner]) if sets else inner  # the names the outer line wrote, kept
                if inner != text and inner.strip() and (_destruction_of(inner, None) or _unread_by_category_more(inner)):
                    return True
    for m in _SUBST_SPAN.finditer(text):  # P5y5 (W13): x=$(${V-rm} $(echo -rf) ~/ ..): every body in its worst case
        if rereads or not _in_single_quotes(text, m.start()):
            body = m.group(0)[2:-1] if m.group(0).startswith("$(") else m.group(0)[1:-1]
            if body.strip() and body != text and _unread_by_category_more(body):
                return True
    masked = _SUBST_SPAN.sub(lambda m: m.group(0) if (_in_single_quotes(text, m.start()) and not rereads)
                             else "$__iclone_subst", text)
    for seg in _SEGMENT_SPLIT.split(masked):
        canonical = _canonical_delete(_ansi_c_decoded(seg) if "$'" in seg else seg, text)
        if canonical and _destruction_of_line(canonical, None):  # P5y5: unresolved in the worst case counts too
            return True
    return False


def _unread_by_category_once(text: str, braces_only: bool = False) -> bool:
    if not braces_only and _unread_by_category_more(text):
        return True
    if not braces_only and _names_a_delete(_flat(text)) and _RECURSIVE_FLAG.search(_flat(text)) \
            and not _RECURSIVE_FLAG.search(text):
        return True  # P5y2 (W13): a recursive flag only written with quotes, braces, escapes or $'..' (-{r,}f)
    if not braces_only and _names_a_delete(_flat(text)):
        for m in _SUBST_SPAN.finditer(text):  # P5y2 (W13): echo $(rm '-r'f ~): each substitution read on its own too
            if _in_single_quotes(text, m.start()):
                continue  # P5y3 (oracle row): cat '$(rm -rf /)' prints the text, bash runs nothing
            body = m.group(0)[2:-1] if m.group(0).startswith("$(") else m.group(0)[1:-1]
            if body.strip() and body != text and _destruction_of(body, None):
                return True
    if not braces_only and _unread_recursive_command(text):
        return True  # P5y2 (W13 fuzzer): ${V-rm} -rf, `echo rm` -rf, r''m $'-rf': a program the floor does not read
    if not braces_only and "$'" in text:  # P5y2 (W13 fuzzer): $'-rf', $'\x72m': a word bash decodes, the floor did not
        decoded = _ansi_c_decoded(text)
        if decoded != text and (_names_a_delete(decoded) and (_RECURSIVE_HINT.search(decoded) or "-delete" in decoded)):
            return True
    braces = [w for w in _BRACE_WORD.findall(text) if ("," in w or ".." in w) and not _BASH_WORD.fullmatch(w)]
    if braces and (_names_a_delete(text) or _COMMAND_START_BRACE.search(text)
                   or any(_RECURSIVE_HINT.search(_BRACE_SPLIT.sub(" ", w)) for w in braces)):
        return True
    if braces_only:
        return False
    if _IFS_SET.search(text) and "$" in _QUOTED_TEXT.sub("", text):  # a double-quoted expansion is never split on IFS
        return True
    return bool(_POSITIONAL.search(text) and _names_a_delete(text))


def _cd_words(raw_words: List[str], home_written: bool) -> List[str]:
    """A cd's words without a redirection of fd 1 or 2 to /dev/null; when the line may change HOME, a word that starts
    with ~ is a value the floor does not read."""
    if raw_words[0] in ("cd", "pushd", "popd"):
        kept: List[str] = []
        for word in raw_words:
            if kept and kept[-1] in _TO_DEV_NULL and word == "/dev/null":
                kept.pop()
                if len(kept) > 1 and kept[-1] in ("1", "2"):  # 2>/dev/null reaches here as 2, >, /dev/null
                    kept.pop()
            else:
                kept.append(word)
        raw_words = kept
    return ["$(:)" if home_written and word.startswith("~") else word for word in raw_words]


_LOOP_WORDS = frozenset({"for", "while", "until", "select"})
_GIT_PATHSPEC_MAGIC = ":"
_MOVES_FOLDER = re.compile(r"(?:^|[\s;&|({'\"])(?:cd|pushd|popd|source|\.)(?=$|[\s;&|)}'\"])")
_FUNCTION_DEFINITION = re.compile(r"(?:^|[\s;&|({])(?:function[ \t]+([A-Za-z_][\w.:-]*)(?:[ \t]*\([ \t]*\))?"
                                  r"|([A-Za-z_][\w.:-]*)[ \t]*\([ \t]*\))")


# P5k (lens Q, review p17-lens-Q): a call is not looked for at all. Any function definition on the line (an empty pair
# of parentheses, or the word function) together with any cd, pushd, popd, source or . makes every command of the line,
# other than a cd/pushd/popd itself, one after which the folder is unknown: `time f`, `X=1 f`, `f+` all count.
_ANY_FUNCTION = re.compile(r"[^\s;&|(){}<>'\"]\([ \t]*\)|(?:^|[\s;&|({])function[ \t]")
# P5l (lens S medium): quoted text is not code, and a lone . only moves the folder in command position (source).
_QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
# P5l (lens S critical): aliases are expanded where the runtime runs a command; a line that makes one is not read.
_ALIAS_DEFINITION = re.compile(r"(?:^|[;&|({`\n])[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*(?:(?:builtin|command)(?:[ \t]+-\S*)*[ \t]+)?"
                               r"alias(?:[ \t]+-\S*)*[ \t]+[^\s=;&|]+=")  # P5n: command position only
# P5m/P5n (lenses V, W, X): bash builds a word from quotes, escapes, $'..', braces and commas ({alias,}, c$'d', \alias);
# for the alias and folder-word checks that noise is removed from the text (backslash-newline is removed first).
_WORD_NOISE = re.compile(r"[\\'\"${},]")
_FOLDER_WORDS_ANYWHERE = frozenset({"cd", "pushd", "popd", "source"})
_GLOB_IN_WORD = re.compile(r"[*?\[]")


def _SOURCED_AFTER_DOT(raw_words, dot) -> bool:
    """P5q (lens X3): a . followed by a word that is not an option is read as source (>/dev/null . ./x); find . -name and
    git add . are not."""
    words = [str(x) for x in raw_words]
    return any(words[i] == "." and i + 1 < len(words) and (words[i + 1] == "--" or not words[i + 1].startswith("-")) and words[i + 1] not in (
        ";", "&&", "||", "|", "&") for i in range(len(words)))
# P5p (lens W2): an alias can be made behind case, time -p or a redirection; on a line with more than one command,
# "alias name=" anywhere (any spelling) makes the line unresolved. A single command that only mentions it stays allowed.
_ALIAS_ANYWHERE = re.compile(r"\balias(?:[ \t]+-\S*)*[ \t]+[^\s=;&|]+=")
_MORE_THAN_ONE_COMMAND = re.compile(r"[;&|\n]")
_COMMAND_WORD_NOISE = re.compile(r"[\\'\"${}`,]")
_ASSIGNMENT_WORD = re.compile(r"[A-Za-z_]\w*\+?=")


def _folder_moving_functions(text: str) -> FrozenSet[str]:
    """P5i (lens N): bodies are not parsed. When the line holds a cd, pushd, popd, source or . anywhere, every function
    it defines (name() { ... }, function name ...) is one whose call may change folder; else none is."""
    if not _MOVES_FOLDER.search(text):
        return frozenset()
    return frozenset(m.group(1) or m.group(2) for m in _FUNCTION_DEFINITION.finditer(text))


def _destruction_of_line(text: str, cwd: Optional[str]) -> Optional[str]:
    text = _uncommented(_CF_OR_ZERO_WIDTH.sub("", unicodedata.normalize("NFC", text)))
    if cwd and not cwd.startswith("/"):
        cwd = _UNKNOWN_CWD  # pass 5h: a call folder that is not an absolute path is one the floor cannot read
    text = _MKTEMP_ASSIGNMENT.sub(lambda m: m.group(1) + _MKTEMP_STAND_IN, text)
    text = _MKTEMP_CD.sub(lambda m: m.group(1) + _MKTEMP_STAND_IN, text)
    # A literal array is read as every value it holds, the way a for loop's list is.
    text = _ARRAY_ASSIGNMENT.sub(lambda m: f"for {m.group(1)} in {m.group(2)}; do :; done", text)
    text = _ARRAY_USE.sub(r"${\1}", text)
    text = _ARITHMETIC_COMMAND.sub(lambda m: " let " + " ".join(sorted(set(_NAME.findall(m.group(1))))) + " ", text)
    here = cwd
    unresolved = None
    home = os.environ.get("HOME") or ""
    values: Dict[str, List[str]] = {"TMPDIR": [os.environ.get("TMPDIR") or "/tmp"]}
    if not home:  # bash's own fallback (getpwuid), done here: its sandbox has no directory lookup
        try:
            home = pwd.getpwuid(os.getuid()).pw_dir
        except KeyError:
            home = ""
    if home:
        # HOME is read as this process's and as the shape every macOS home has, so ~/.. is /Users wherever the
        # runtime's own HOME happens to live.
        values["HOME"] = values["USERPROFILE"] = list(dict.fromkeys([home, _HOME_SHAPE]))
    if cwd and not _unknown(cwd):
        values["PWD"] = [cwd]
    split, through_cdpath = False, bool(os.environ.get("CDPATH") or _NAMES_CDPATH.search(text))
    home_written = bool(_NAMES_HOME.search(text))
    # Pass 5g: a cd never replaces the folder. It may fail or not run (a subshell, a pipe, a job, a branch), so a delete
    # is judged in every folder the line could be in at that point, the call's own first, and the worse reading wins.
    places: List[Optional[str]] = [here]
    cd_unread = bool(_CD_REDEFINED.search(text))
    commands = [(_cd_words(raw_words, home_written), feeding, before) for raw_words, feeding, before in _simple_commands(text)]
    chain: Optional[str] = None  # the folder of a top-level cd joined by && alone to the commands after it
    # P5i: a cd in a loop body may run any number of times, and a function that holds one may be called at any point:
    # after either, the folder is one the floor cannot read.
    loops = 0
    movers = _folder_moving_functions(text)
    bare = _QUOTED.sub("''", text)
    # P5n (lens W): a function body can build a cd the floor does not read (for a; do "$a"; done with c$'d'): any
    # function defined on the line leaves the folder unknown after every command, whatever its body holds.
    any_mover = bool(movers) or bool(_ANY_FUNCTION.search(bare))
    spelled_before = False
    logical_here = cwd if cwd and not _unknown(cwd) else None  # P5i: the folder as bash's $PWD spells it (cd -L)
    # Every word of the line read in one bash call with the values known now; a command whose names an earlier
    # assignment changed reads only its new blocks. A failed call here is retried command by command.
    _read_blocks([b for raw_words, _feeding, _before in commands for b in _plan_blocks(_planned(raw_words, values))])
    for raw_words, feeding, before in commands:
        _spend()
        if before.rstrip("\n") != "&&":  # a newline after && continues the list
            chain = None
        if raw_words[0] in _LOOP_WORDS:
            loops += 1
        elif raw_words[0] == "done":
            loops = max(0, loops - 1)
        # P5o: a command word written with quotes, escapes, $, braces, backticks or commas is not rebuilt: it may be a
        # cd (${x:-cd}, $'cd', c\d), so the folder is unknown from there (later relative deletes of root names refuse).
        if spelled_before:
            here, chain = _UNKNOWN_CWD, None  # the noisy command word before this one may have been a cd
            if here not in places:
                places.append(here)
        # P5p (lens X2): what comes before a command word (X=1, time, !, if, a redirection) is not parsed: after any
        # command other than a plain cd/pushd/popd that has a word written with shell quoting, or cd/pushd/popd/source in
        # any spelling or position, the folder is unknown.
        spelled_before = raw_words[0] not in ("cd", "pushd", "popd") and any(
            w not in ("{", "}") and "()" not in w and not _ASSIGNMENT_WORD.match(w) and (
                bool(_COMMAND_WORD_NOISE.search(w)) or _WORD_NOISE.sub("", w) in _FOLDER_WORDS_ANYWHERE
                or (w == "." and (w == raw_words[0] or _SOURCED_AFTER_DOT(raw_words, w)))
                # P5q (lens W3): a glob word that can match a folder word ([c]d, ?d, *d) runs it
                or (bool(_GLOB_IN_WORD.search(w))
                    and any(fnmatch.fnmatchcase(n, w) for n in _FOLDER_WORDS_ANYWHERE | {"."})))
            for w in (str(x) for x in raw_words))
        if (any_mover and raw_words[0] not in ("cd", "pushd", "popd")) or raw_words[0] in movers or (
                raw_words[0] == "trap" and any(
                _MOVES_FOLDER.search(str(w)) for w in raw_words[1:])):
            here, chain = _UNKNOWN_CWD, None  # a call of a function that changes folder, or a trap that does
            if here not in places:
                places.append(here)
        for raw in raw_words:  # IFS=x cmd, export IFS, read IFS, for IFS in ...: worse wins
            named = _SPLIT_OR_CD_NAME.match(raw)
            split = split or bool(named and named.group(1) == "IFS")
        if raw_words[0] in ("for", "select") and len(raw_words) >= 2 and not (
                raw_words[0] == "for" and len(raw_words) >= 3 and raw_words[2] == "in"):
            values.pop(raw_words[1], None)  # M4: select's choice, or a for over the positional words
            continue
        if raw_words[0] == "for" and len(raw_words) >= 3 and raw_words[2] == "in":
            listed = _expanded(raw_words[3:], values, split)
            if any(word.unread for word in listed):
                values.pop(raw_words[1], None)
            else:
                values[raw_words[1]] = list(dict.fromkeys(f for w in listed for f, _h in w.forms)) or [""]
            continue
        words = _expanded(raw_words, values, split)
        prog, args, fed = _program(words)
        prog = _GNU_NAMES.get(prog, prog)
        if prog in ("ln", "gln"):
            _BUDGET.linked = True  # pass 5h: a link made on the line is not followed, what may go through it is unresolved
        for word in words[:len(words) - len(args) - (1 if prog else 0)] if prog else words:
            appended = _APPENDING.match(word)
            if appended:
                values.pop(appended.group(1), None)  # M4: X+=... is unknown after it, read both ways
        if prog in _SETS_ITS_NAMES or (prog in _DECLARE and any(a.startswith("-") and "n" in a for a in args)):
            for name in args:
                for found in _NAME.findall(name.partition("=")[0]) if prog == "let" else [name.partition("=")[0]]:
                    values.pop(found, None)
            continue
        if prog == "printf":  # M4: printf -v X / -vX sets X
            for at, arg in enumerate(args):
                if arg == "-v" and at + 1 < len(args):
                    values.pop(args[at + 1], None)
                elif arg.startswith("-v") and len(arg) > 2:
                    values.pop(arg[2:], None)
        if prog in _DECLARE:
            for name in args:
                if not name.startswith("-") and "=" not in name:
                    values.pop(name, None)
        if not prog or prog in _DECLARE:
            for word in (args if prog else words):
                if _ASSIGNMENT.match(word):
                    _assigned(values, word)
            if not prog:
                continue
        prefix = words[:len(words) - len(args) - 1]
        raw_prefix = [str(w) for w in raw_words[:len(prefix)]]
        if prog in ("source", "."):  # what the file does to the folder is not read
            places.append(_UNKNOWN_CWD)
            cd_unread = True
            continue
        if prog in ("cd", "pushd", "popd"):
            target = next((a for a in args if not a.startswith("-")), _plain(home or "~"))
            homes = [w[5:] for w in raw_prefix if w.startswith("HOME=")]
            if prog == "cd" and len(homes) == 1 and re.fullmatch(r"[\w./~+-]+", homes[0]) and not any(
                    not a.startswith("-") for a in args):
                target = _plain(homes[0])  # HOME=/ cd: the HOME the command is given
            elif home_written and not any(not a.startswith("-") for a in args):
                target = _word("", (), unread=True)  # HOME may be changed on the line: a bare cd goes to an unknown home
            elif cd_unread or any(_REDIRECTION.match(str(w)) for w in raw_words) or any(
                    _ASSIGNMENT.match(w) for w in raw_prefix):  # cd 2>/dev/null ~, X=y cd: not read
                target = _word("", (), unread=True)
            if prog == "cd" and "-" in args:  # cd - (the folder before): not followed, the cwd is unknown
                target = _word("", (), unread=True)
            stack = prog == "popd" or (prog == "pushd" and (
                not any(not a.startswith(("-", "+")) for a in args) or any(a.startswith(("-", "+")) for a in args)))
            via_cdpath = through_cdpath and any(not a.startswith("-") for a in args) and (
                not _CD_NOT_THROUGH_CDPATH.match(str(target)))
            # popd, a bare pushd (a swap), pushd +N/-N/-n and a relative cd through CDPATH: the cwd is unknown
            folded = None if stack or via_cdpath or loops else _cd_resolved(target, here)
            written = _forms(target)[0][0] if len(_forms(target)) == 1 and not getattr(target, "unread", False) else ""
            logical = None
            if written and "\x01" not in written and prog != "popd":
                logical = posixpath.normpath(written if written.startswith("/") else posixpath.join(logical_here, written)) \
                    if written.startswith("/") or logical_here else None
            if folded is not None and logical and not written.startswith("/") and ".." in written.split("/"):
                # P5i: a relative .. after a cd through a link: the logical folder and the physical one may differ
                other = _cd_resolved(_plain(logical), None)
                if other != folded and not _is_root_folded(folded):
                    folded = other if other and _is_root_folded(other) else None
            logical_here = logical if folded is not None else None
            here = _UNKNOWN_CWD if folded is None else (folded or here)
            if here not in places:
                places.append(here)
            # Pass 5h: a top-level cd joined to what follows by && alone: those commands run only if the cd worked.
            known = here and not _unknown(here)
            chain = here if raw_words[0] in ("cd", "pushd") and not stack and "|" not in before and known else None
            values.pop("PWD", None)
            values.pop("OLDPWD", None)
            if all(p and not _unknown(p) for p in places):
                values["PWD"] = values["OLDPWD"] = list(dict.fromkeys(places))
            continue
        hit = None
        moved = _chdir_places(prefix, here)
        for place in ([chain] if chain else places) + moved:
            if prog == "eval":
                one = destruction_of(" ".join(args), place)
            elif prog == "su" and "-c" in args[:-1]:
                one = destruction_of(str(args[args.index("-c") + 1]), place)  # P5i: su -c 'code' runs that code
            else:
                one = _command_hit(prog, args, place)
                if not one:
                    one = _launched_hit([str(w) for w in words], place)  # P5r (lens W4)
            if not one and _UNREAD_PROGRAM.search(prog) and prog not in _TEST_PROGRAMS:
                one = _unread_program_hit(args, place)
            if not one and fed:
                one = _fed_hit(prog, args, feeding, place, values)
            if one and one not in UNRESOLVED_DELETES and not (chain or place == here or place in moved):
                # P5i: total only from a folder the line may be in when a cd failed or did not run (not the one it
                # reaches when every cd works): capped at unresolved, so Ignore and Plan refuse and the others ask
                one = UNRESOLVED_DELETE
            if one and one not in UNRESOLVED_DELETES:
                hit = one
                break
            hit = hit or one
        if hit in UNRESOLVED_DELETES and _ECHOES_A_ROOT.search(text):  # the parser splits an unquoted $( ) apart
            return "recursive delete of the whole disk, a home folder or the system"
        if hit in UNRESOLVED_DELETES:
            unresolved = unresolved if unresolved == FOLLOWED_LINKS_DELETE else hit
        elif hit:
            return hit
    masked = re.sub(r"'[^']*'|\"[^\"]*\"", "''", text)
    return "raw write to a disk" if _REDIRECT_TO_DISK.search(masked) else unresolved
