"""P5d: delete-target words are expanded by bash itself (set -f, empty env, no rc, no stdin, hard timeout), never by an
imitation of its rules. Every destructive string here is classified only; nothing is run but the floor's own inert bash.
Run under iso_env.sh (throwaway HOME/TMPDIR)."""
from __future__ import annotations

import re
import subprocess

import pytest

import tools.approval_floor as floor
from tools.approval_floor import FOLLOWED_LINKS_DELETE, UNRESOLVED_DELETE, destruction_of

_CACHED_BASH = floor._bash_output
TOTAL = "recursive delete of the whole disk, a home folder or the system"


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    _CACHED_BASH.cache_clear()
    monkeypatch.setattr(floor, "_BLOCK_FIELDS", {})  # every test reads its words through bash itself
    yield
    _CACHED_BASH.cache_clear()


@pytest.fixture
def scripts(monkeypatch):
    seen = []
    real = floor._bash_output.__wrapped__

    def recording(script):
        seen.append(script)
        return real(script)

    monkeypatch.setattr(floor, "_bash_output", recording)
    return seen


RUNS_SOMETHING = ["$(cmd)", "`cmd`", "<(cmd)", ">(cmd)", "$((1+1))", "$[1+1]", "${!X}", "${X@P}", '"$(cmd)"',
                  "${X:-$(cmd)}"]


@pytest.mark.parametrize("form", RUNS_SOMETHING)
def test_a_construct_that_runs_something_is_unresolved_and_never_given_to_bash(form, scripts):
    assert destruction_of(f"rm -rf {form}", "/tmp") == UNRESOLVED_DELETE
    assert all("cmd" not in s and "1+1" not in s and "!X" not in s and "@P" not in s for s in scripts), scripts


@pytest.mark.parametrize("form", ['"unclosed', "'unclosed", "${X", "build\\"])
def test_a_word_never_closed_is_unresolved_and_never_given_to_bash(form, scripts):
    assert destruction_of(f"rm -rf {form}", "/tmp") == UNRESOLVED_DELETE
    assert all("unclosed" not in s and "${X\n" not in s for s in scripts)


def test_a_written_root_around_a_construct_is_still_total():
    for command in ('rm -rf /"$(cmd)"', 'rm -rf ~/"`cat f`"/', 'rm -rf "$HOME/$(cat f)"'):
        assert destruction_of(command, "/tmp") == TOTAL, command
    assert destruction_of("rm -rf build-$(date +%s)", "/tmp") is None
    assert destruction_of('rm -rf "$(git rev-parse --show-toplevel)/build"', "/tmp") == UNRESOLVED_DELETE


@pytest.mark.live_system_guard_bypass  # P5t: the floor stops its own bash session on a timeout
def test_the_timeout_fails_closed(monkeypatch):
    def hang(*_a, **_k):
        raise subprocess.TimeoutExpired("bash", floor._BASH_TIMEOUT)

    monkeypatch.setattr(floor.subprocess.Popen, "communicate", hang)
    assert destruction_of("rm -rf bu{il,i}d", "/tmp") == UNRESOLVED_DELETE
    assert destruction_of('rm -rf "$X/build"', "/tmp") == UNRESOLVED_DELETE
    assert destruction_of("rm -rf build", "/tmp") is None  # a plain word never needs bash
    assert destruction_of("rm -rf \"build\" 'dist'", "/tmp") is None  # nor one with only quotes on it


@pytest.mark.live_system_guard_bypass  # P5t: the floor stops its own bash session on a timeout
def test_a_real_timeout_fails_closed(monkeypatch):
    monkeypatch.setattr(floor, "_BASH_TIMEOUT", 1e-6)
    floor._bash_output.cache_clear()
    floor._BLOCK_FIELDS.clear()
    assert destruction_of("rm -rf bu{il,i}d", "/tmp") == UNRESOLVED_DELETE


def test_a_huge_brace_range_is_unread_never_listed(scripts):
    assert destruction_of("rm -rf x{1..99999999}", "/tmp") == UNRESOLVED_DELETE
    assert not scripts


@pytest.mark.parametrize("command,expected", [
    ('rm -rf "${X:+/}"', TOTAL), ('rm -rf "${X+/}"', TOTAL), ('rm -rf "${X:-/}"', TOTAL), ('rm -rf "${X-/}"', TOTAL),
    ('rm -rf "${X:+/}${Y:+tmp}"', TOTAL), ('rm -rf "${X:+/Users}${Y:+/Shared}"', TOTAL),
    ('rm -rf "${X:+build}"/*', UNRESOLVED_DELETE), ('rm -rf "$X"', UNRESOLVED_DELETE), ('rm -rf "$X"/*', UNRESOLVED_DELETE),
    ('rm -rf "$DESTDIR/usr"', UNRESOLVED_DELETE), ('rm -rf "${X:-build}"', None), ('rm -rf "$T/sub"', None),
    ('rm -rf "${dir:?}"/*', UNRESOLVED_DELETE), ('rm -rf ./"$T"', None),
])
def test_unknown_names_are_read_unset_and_set_and_the_worse_stands(command, expected):
    assert destruction_of(command, "/tmp") == expected, command


def test_mktemp_never_runs(tmp_path):
    command = f'T=$(mktemp -d {tmp_path}/MARK_mk.XXXXXX); rm -rf "$T"; true || mktemp {tmp_path}/MARK_mk2.XXXXXX'
    assert destruction_of(command, str(tmp_path)) is None
    assert not list(tmp_path.glob("MARK_mk*"))


def test_bash_never_touches_the_filesystem(tmp_path):
    for index, form in enumerate(["$(touch {m})", "`touch {m}`", '"$(touch {m})"', "<(touch {m})", "${{X:=$(touch {m})}}",
                                  "$((`touch {m}`))"]):
        marker = tmp_path / f"MARK_{index}"
        destruction_of("true || rm -rf " + form.format(m=marker), str(tmp_path))
        assert not marker.exists(), form
    destruction_of(f"true || rm -rf {tmp_path}/*", str(tmp_path))  # set -f: no glob is read either


def test_the_callers_environment_never_reaches_bash(tmp_path, monkeypatch):
    marker = tmp_path / "MARK_env"
    script = tmp_path / "bash_env.sh"
    script.write_text(f"true || exit 0\n: > {marker}\n")
    for name in ("BASH_ENV", "ENV"):
        monkeypatch.setenv(name, str(script))
    monkeypatch.setenv("X", "/")
    assert destruction_of('rm -rf "$X"/build', str(tmp_path)) is None  # the caller's X is not the call's
    assert not marker.exists()


@pytest.mark.parametrize("command,expected", [
    ("cd ${X:+build} && rm -rf *", UNRESOLVED_DELETE),  # D5: cd with nothing is HOME
    ("grm -rf /", TOTAL), ("gfind ~ -exec rm -rf {} +", TOTAL),  # D7
    ("find -sx / -delete", TOTAL), ("find -- / -delete", TOTAL), ("find -L . -delete", FOLLOWED_LINKS_DELETE),  # D1, D6
    ("rsync -a --delete e/ ~/ --exclude .git", TOTAL), ("rsync -a --delete e/ build --exclude /", None),  # D2
    ('unset TMPDIR; rm -rf "$TMPDIR"/*', UNRESOLVED_DELETE),  # D3
    ("rm -rf '~'", None), ("mv r /dev/null", None),  # D13, D11
    ("rm -rf build 2>/dev/null", None),
    ("grsync -a --delete e/ ~/", TOTAL), ("grsync -a --delete e/ build", None),  # D7: grsync fails closed as rsync does
    ("grsync -a --delete --frobnicate e/ build", UNRESOLVED_DELETE), ("grsync -a --delete e/ $X", UNRESOLVED_DELETE),
])
def test_lens_d_rows(command, expected):
    assert destruction_of(command, "/tmp") == expected, command


@pytest.mark.parametrize("command,expected", [
    ("rm --foo -rf build", UNRESOLVED_DELETE), ("rm --foo build", UNRESOLVED_DELETE), ("rm -rZ build", UNRESOLVED_DELETE),
    ("rm --v build", UNRESOLVED_DELETE),  # ambiguous: --verbose or --version
    ("grm --rec -f ~", TOTAL), ("rm --recu -f /", TOTAL), ("grm --recursive=x -f ~", TOTAL), ("rm --foo ~", TOTAL),
    ("rm --verbose -f build", None), ("rm -rf --one-file-system --preserve-root=all build", None), ("rm -f build", None),
    ("rsync -a --frobnicate --delete e/ build", UNRESOLVED_DELETE), ("rsync -aQ --delete e/ build", UNRESOLVED_DELETE),
    ("rsync -a --no-perms --info=progress2 --delete e/ build", None), ("rsync -a --frobnicate e/ build", None),
    ("rsync -a --frobnicate --delete e/ ~/", TOTAL),
])
def test_m1_an_option_the_floor_does_not_know_is_never_skipped(command, expected):
    assert destruction_of(command, "/tmp") == expected, command


@pytest.mark.parametrize("command,expected", [
    ("find ~ -exec grm -rf {} +", TOTAL), ("find ~ -execdir grm -rf {} ;", TOTAL), ("find / -ok gunlink {} ;", TOTAL),
    ("gfind ~ -exec /opt/homebrew/bin/grmdir {} +", TOTAL), ("find . -exec grm -f {} +", None),
    ("find ~ -exec grep -l x {} +", None),
])
def test_m7_find_exec_with_a_gnu_delete_deletes(command, expected):
    assert destruction_of(command, "/tmp") == expected, command


@pytest.mark.parametrize("command", ["find -H . -delete", "find -L build -delete", "find . -follow -delete",
                                     "find -HL build -exec rm {} +"])
def test_find_following_links_says_so(command):
    assert destruction_of(command, "/tmp") == FOLLOWED_LINKS_DELETE, command
    assert "follows the links below its start" in FOLLOWED_LINKS_DELETE
    assert "Write the path out literally" not in FOLLOWED_LINKS_DELETE
    assert destruction_of(command.replace("build", "/").replace(" . ", " / "), "/tmp") == TOTAL


@pytest.mark.parametrize("forget", ["unset X", "export -n X", "declare -n X", "read X", "declare X"])
def test_a_name_made_unknown_again_is_read_both_ways(forget):
    assert destruction_of('X=build; rm -rf "$X"/*', "/tmp") is None
    assert destruction_of(f'X=build; {forget}; rm -rf "$X"/*', "/tmp") == UNRESOLVED_DELETE, forget
    assert destruction_of(f'X=build; {forget}; X=dist; rm -rf "$X"/*', "/tmp") is None, forget


def test_more_than_four_unknown_names_in_one_word_is_unresolved(scripts):
    assert destruction_of('rm -rf "build/$A$B$C$D"', "/tmp") is None
    assert destruction_of('rm -rf "build/$A$B$C$D$E"', "/tmp") == UNRESOLVED_DELETE
    assert not any("$E" in s for s in scripts)


@pytest.mark.parametrize("command", ["cd; rm -rf *", "cd && rm -rf ./*", "cd -P; rm -rf ."])
def test_a_bare_cd_is_the_home(command):
    assert destruction_of(command, "/tmp") == TOTAL, command


def test_mv_moves_the_link_never_what_it_points_to(tmp_path):
    (tmp_path / "link").symlink_to("/")
    assert destruction_of("mv link /dev/null", str(tmp_path)) is None  # D11
    assert destruction_of("gmv -f link /dev/null", str(tmp_path)) is None
    assert destruction_of("mv / /dev/null", str(tmp_path)) == TOTAL
    assert destruction_of("mv ~ /dev/null", str(tmp_path)) == TOTAL


# P5e (lead decision): with confinement on (the default) the floor's bash runs inside the agent's Seatbelt, through
# host_lane.confine_program (a probe; spawn_sites.json lists the site), never refused into a blanket "unresolved".
# Each case runs in a fresh interpreter started confined, so hermes_bootstrap installs the real spawn guard; the
# confiner stands in for the plugin's (proved live elsewhere) and only ever wraps the floor's own inert bash.
_ROOT = __import__("pathlib").Path(__file__).resolve().parents[2]
_CONFINED_COMMANDS = ['rm -rf "$X/build"', 'rm -rf "${X:+build}"/*', "rm -rf bu{il,i}d", 'rm -rf "${X:+/}"',
                      "rm -rf build"]
_SANDBOX_ALLOW = "['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', *argv]"
_SANDBOX_DENY = "['/usr/bin/sandbox-exec', '-p', '(version 1)(deny default)', *argv]"


def _confined_verdicts(tmp_path, confiner):
    import json
    import os
    import sys
    import textwrap

    home, hermes_home = tmp_path / "home", tmp_path / "hh"
    home.mkdir(exist_ok=True)
    hermes_home.mkdir(exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith("ICLONE_")}
    env.update(HOME=str(home), HERMES_HOME=str(hermes_home), PYTHONDONTWRITEBYTECODE="1",
               HERMES_DISABLE_LAZY_INSTALLS="1", TERMINAL_ENV="local", ICLONE_CONFINEMENT="1")
    env["PYTHONPATH"] = os.pathsep.join([str(_ROOT)] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p])
    register = "" if confiner is None else (
        "host_lane.register_program_confiner(lambda argv, *, kind, env=None, reads=(), writes=(): "
        f"{confiner})\n")
    script = "import hermes_bootstrap, json\nfrom tools.environments import host_lane\n" + register + textwrap.dedent(f"""
        from tools.approval_floor import destruction_of
        print("RESULT=" + json.dumps({{"guard": host_lane.spawn_guard_installed(), "refusals": host_lane.spawn_refusals(),
                                      "verdicts": [destruction_of(c, "/tmp") for c in {_CONFINED_COMMANDS!r}]}}))
    """)
    out = subprocess.run([sys.executable, "-c", script], cwd=str(tmp_path), env=env, capture_output=True, text=True,
                         timeout=120)
    lines = [line for line in out.stdout.splitlines() if line.startswith("RESULT=")]
    assert lines, f"rc={out.returncode}\nstdout={out.stdout[-2000:]}\nstderr={out.stderr[-3000:]}"
    result = json.loads(lines[-1][len("RESULT="):])
    assert result["guard"] is True, result
    return result


@pytest.fixture
def darwin_only():
    import sys

    if sys.platform != "darwin":
        pytest.skip("sandbox-exec is macOS")


def test_confined_bash_runs_inside_the_seatbelt_and_reads_every_word_as_unconfined(tmp_path, darwin_only):
    unconfined = [destruction_of(c, "/tmp") for c in _CONFINED_COMMANDS]
    assert unconfined == [None, UNRESOLVED_DELETE, None, TOTAL, None], unconfined
    confined = _confined_verdicts(tmp_path, f"({_SANDBOX_ALLOW}, env)")
    assert confined["verdicts"] == unconfined, confined
    assert confined["refusals"] == [], confined


@pytest.mark.parametrize("confiner", [None, f"({_SANDBOX_DENY}, env)", "(_ for _ in ()).throw(OSError('no profile'))",
                                      "(['/usr/bin/false'], env)", "(['/bin/bash', '-c', 'printf x'], env)"],
                         ids=["no-confiner", "sandbox-refuses", "confiner-raises", "sealed-but-fails", "not-the-sandbox"])
def test_a_confined_bash_that_cannot_run_fails_closed(tmp_path, confiner, darwin_only):
    got = _confined_verdicts(tmp_path, confiner)["verdicts"]
    # every word that needs bash is unresolved; a plain word, which bash is not needed for, is read as before
    assert got == [UNRESOLVED_DELETE] * 4 + [None], got


def test_bash_output_counts_only_when_bash_reached_its_closing_mark(monkeypatch):
    def stopped_early(_process, timeout=None):
        return b"\x020\x001\x00build\x00", None

    monkeypatch.setattr(floor.subprocess.Popen, "communicate", stopped_early)
    monkeypatch.setattr(floor, "_BLOCK_FIELDS", {})
    assert floor._bash_output.__wrapped__("set -f") is None
    assert destruction_of("rm -rf bu{il,i}d", "/tmp") == UNRESOLVED_DELETE


# P5e perf: path lookups are reused inside one decision only (floor._WALK_MEMO), never across decisions.
def test_a_link_changed_between_two_decisions_is_seen(tmp_path):
    (tmp_path / "real").mkdir()
    link = tmp_path / "l"
    link.symlink_to(tmp_path / "real")
    assert destruction_of("rm -rf l/", str(tmp_path)) is None
    link.unlink()
    link.symlink_to("/")
    assert destruction_of("rm -rf l/", str(tmp_path)) == TOTAL
    assert floor._WALK_MEMO.get() is None


def test_a_reused_prefix_still_counts_its_links(tmp_path):
    # a chain of links just under the limit, then one more through the same prefix: reuse must not reset the count
    chain = tmp_path / "c0"
    chain.mkdir()
    for at in range(1, floor._MAX_LINKS + 3):
        (tmp_path / f"c{at}").symlink_to(tmp_path / f"c{at - 1}")
    deep = str(tmp_path / f"c{floor._MAX_LINKS + 2}")
    fresh = [floor._through_links(deep + "/x", True, [0]), floor._through_links(deep + "/y", True, [5])]
    with floor.walk_snapshot():
        reused = [floor._through_links(deep + "/x", True, [0]), floor._through_links(deep + "/y", True, [5])]
    assert reused == fresh and fresh[0][1] is False, (fresh, reused)


# Pass 5d: classifying a command never executes anything. Layer 1: the filter (a word that could run something is never
# given to bash); layer 2: bash runs --restricted; layer 3: sandbox-exec denies exec, writes, reads, network, lookups and
# signals; layer 4: its own session, killed whole on timeout or error. Every payload is `touch` of a marker in tmp_path.
_FLOOR_ENV = dict(floor._BASH_ENV)


def _touch(marker):
    return f'touch "{marker}"'


# (prelude the line sets, word): each ran its payload under the floor's bash before pass 5d (test_found_form_is_live).
FOUND_FORMS = [
    ("", "$'\\''$({p})''"),  # _masked read $'\'' as a quote closing at \' and blanked the $( ) after it
    ("", "${{X:a[\\$({p})]}}"),  # substring offset: arithmetic expands the escaped $( ) in the subscript again
    ("", "${{X:0:a[\\$({p})]}}"),  # substring length, the same
    ("", '"${{X:a[\\$({p})]}}"'),  # the same in double quotes
    ("Y='a[$({p})]'", "${{X:Y}}"),  # arithmetic reads the value of Y, set on the line, as arithmetic: a[$( )] runs
    ("Y='a[$({p})]'", "${{X:0:Y}}"),
    ("", "${{X:-\\'}}$({p})${{X:-\\'}}"),
]


def _form(index, marker):
    prelude, word = FOUND_FORMS[index]
    return prelude.format(p=_touch(marker)), word.format(p=_touch(marker))


def _run(argv, env, cwd):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, env=env, cwd=cwd, timeout=10)


@pytest.mark.parametrize("index", range(len(FOUND_FORMS)))
def test_found_form_is_live_in_a_plain_bash(index, tmp_path):
    marker = tmp_path / f"MARK_{index}"
    prelude, word = _form(index, marker)
    _run(["/bin/bash", "--noprofile", "--norc", "-c", f"X=abc\n{prelude}\nset -f\nset -- {word}"],
         {"PATH": "/usr/bin:/bin"}, str(tmp_path))
    assert marker.exists(), "the form no longer runs anything in bash: the test proves nothing"


@pytest.mark.parametrize("index", range(len(FOUND_FORMS)))
def test_found_form_never_runs_through_the_floor(index, tmp_path, scripts, darwin_only):
    marker = tmp_path / f"MARK_{index}"
    prelude, word = _form(index, marker)
    destruction_of(f"X=abc; {prelude + ';' if prelude else ''} true || rm -rf {word}", str(tmp_path))
    assert not marker.exists()
    assert all(word not in s for s in scripts), scripts  # layer 1: the word is never given to bash at all


@pytest.mark.parametrize("index", range(len(FOUND_FORMS)))
@pytest.mark.parametrize("path", ["/var/empty", "/usr/bin:/bin"])
def test_found_form_never_runs_in_the_floors_bash_even_if_the_filter_misses(index, path, tmp_path, darwin_only):
    marker = tmp_path / f"MARK_{index}"
    prelude, word = _form(index, marker)
    argv = floor.floor_bash_argv(f"X=abc\n{prelude}\nset -f\nset -- {word}")
    _run(argv, {**_FLOOR_ENV, "PATH": path}, "/")  # even with a PATH to touch: exec and writes are denied
    assert not marker.exists()


RESTRICTED = {
    "slash_command": "/usr/bin/touch {m}",
    "path_change": "PATH=/usr/bin:/bin; touch {m}",
    "shell_change": "SHELL=/bin/sh; export PATH=/usr/bin:/bin; touch {m}",
    "env_change": "export ENV={s} BASH_ENV={s}; /bin/bash -c :",
    "redirection": "printf x > {m}",
    "exec": "exec /usr/bin/touch {m}",
    "enable_f": "enable -f /usr/lib/libSystem.B.dylib touch; touch {m}",
    "hash_p": "hash -p /usr/bin/touch t; t {m}",
    "source_path": ". {s}",
}


@pytest.mark.parametrize("name", sorted(RESTRICTED))
def test_restricted_shell_refuses(name, tmp_path):
    marker, script = tmp_path / "MARK_r", tmp_path / "s.sh"
    script.write_text(f"touch {marker}\n")
    body = RESTRICTED[name].format(m=marker, s=script)
    env = {**_FLOOR_ENV, "PATH": "/usr/bin:/bin"} if name in ("source_path", "env_change") else dict(_FLOOR_ENV)
    plain = floor.floor_bash_argv(body, sandboxed=False)
    _run([a for a in plain if a != "--restricted"], env, str(tmp_path))
    if name not in ("enable_f",):  # control: without --restricted the payload runs (enable -f needs a loadable)
        assert marker.exists(), "control: the payload should run without --restricted"
        marker.unlink()
    _run(plain, env, str(tmp_path))
    assert not marker.exists()


def _profile_run(body, rules, tmp_path):
    argv = ["/usr/bin/sandbox-exec", "-p", floor._bash_profile(rules), "/bin/bash", "--noprofile", "--norc", "-c", body]
    return _run(argv, dict(_FLOOR_ENV), "/").stdout.decode("utf-8", "replace")


def _without(fragment):
    return tuple(r for r in floor._BASH_PROFILE_RULES if fragment not in r)


def _sandbox_probe(kind, rules, tmp_path):
    """True when the forbidden thing happened under ``rules`` (a plain, unrestricted bash, so only the profile acts)."""
    import pwd
    import socket
    import os

    if kind == "exec":
        return "EXECUTED" in _profile_run("/bin/echo EXECUTED", rules, tmp_path)
    if kind == "write":
        marker = tmp_path / "MARK_w"
        _profile_run(f"printf x > {marker}", rules, tmp_path)
        return marker.exists()
    if kind == "read":
        sentinel = tmp_path / "sentinel"
        sentinel.write_text("SENTINEL_CONTENT")
        return "SENTINEL_CONTENT" in _profile_run(f'printf %s "$(< {sentinel})"', rules, tmp_path)
    if kind == "network":
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(0.5)
            _profile_run(f": < /dev/tcp/127.0.0.1/{listener.getsockname()[1]}", rules, tmp_path)
            try:
                listener.accept()[0].close()
                return True
            except socket.timeout:
                return False
    if kind == "lookup":
        return pwd.getpwuid(os.getuid()).pw_dir in _profile_run("unset HOME; printf %s ~", rules, tmp_path)
    if kind == "signal":
        helper = subprocess.Popen(["/bin/sleep", "30"])
        try:
            _profile_run(f"kill -TERM {helper.pid}", rules, tmp_path)
            return helper.wait(timeout=0.5) is not None
        except subprocess.TimeoutExpired:
            return False
        finally:
            helper.kill()
            helper.wait()
    raise AssertionError(kind)


SANDBOX_RULES = {"exec": "process-exec", "write": "file-write", "read": "file-read", "network": "network",
                 "lookup": "mach-lookup", "signal": "signal"}


@pytest.mark.parametrize("kind", sorted(SANDBOX_RULES))
def test_sandbox_profile_denies_and_its_mutant_does_not(kind, tmp_path, darwin_only):
    assert not _sandbox_probe(kind, floor._BASH_PROFILE_RULES, tmp_path)
    assert _sandbox_probe(kind, _without(SANDBOX_RULES[kind]), tmp_path), "mutant without the rule stayed green"


def test_sandbox_unavailable_or_failing_fails_closed(monkeypatch, darwin_only):
    floor._BLOCK_FIELDS.clear()
    monkeypatch.setattr(floor, "_SANDBOX_EXEC", "/nonexistent/sandbox-exec")
    assert destruction_of("rm -rf bu{il,i}d", "/tmp") == UNRESOLVED_DELETE
    monkeypatch.setattr(floor, "_SANDBOX_EXEC", "/usr/bin/sandbox-exec")
    floor._bash_output.cache_clear()
    floor._BLOCK_FIELDS.clear()
    floor._BLOCK_FIELDS.clear()
    monkeypatch.setattr(floor, "_BASH_PROFILE_RULES", ("(not-a-rule",))
    assert destruction_of("rm -rf bu{il,i}d", "/tmp") == UNRESOLVED_DELETE
    monkeypatch.setattr(floor, "_BASH_PROFILE_RULES", ("(deny default)",))
    floor._bash_output.cache_clear()
    floor._BLOCK_FIELDS.clear()
    assert destruction_of("rm -rf bu{il,i}d", "/tmp") == UNRESOLVED_DELETE


def _ours(token):
    out = subprocess.run(["/bin/ps", "-A", "-o", "pid=,command="], capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if token in line]


def test_a_timeout_leaves_no_process_behind(monkeypatch, darwin_only):
    floor._BLOCK_FIELDS.clear()
    import uuid

    token = "slowtok" + uuid.uuid4().hex[:8]
    assert _ours(token) == []
    monkeypatch.setattr(floor, "_BASH_TIMEOUT", 0.3)
    # bash and a subshell it put in the background spin forever: the whole group goes, not only bash
    assert floor._bash_output.__wrapped__(f": {token}\n( while :; do :; done ) & while :; do :; done") is None
    assert _ours(token) == []
    floor._BLOCK_FIELDS.clear()
    monkeypatch.setattr(floor, "_BASH_TIMEOUT", 1e-6)
    assert destruction_of(f"rm -rf bu{{il,i}}d_{token}", "/tmp") == UNRESOLVED_DELETE
    assert _ours(token) == []


NOT_PLAIN = ["${X:-\\$(cmd)}", '"${X:-\\`cmd\\`}"', '"a\\$(cmd)"', "${X:Y}", "${X:a[1]}", "${X/;/cmd}", "${X:-a|cmd}",
             "${X%<cmd}", "${X:-$Y}", "${X[Y]}", "'a\nb'", '"a\nb"', "${X[Y]:-w}", "${#X[Y]}", "${X[Y]%w}",
             '"${X[1+Y]:-w}"']


@pytest.mark.parametrize("form", NOT_PLAIN)
def test_a_parameter_that_is_not_plain_is_unread_never_given_to_bash(form, scripts):
    assert destruction_of(f"rm -rf {form}", "/tmp") in (UNRESOLVED_DELETE, None)
    assert all("cmd" not in s and "X:Y" not in s and "a[1]" not in s and "X[Y]" not in s and "a\nb" not in s
               for s in scripts), scripts


@pytest.mark.parametrize("form", [f for f in NOT_PLAIN if "[" in f])
def test_a_subscript_is_outside_the_grammar_itself(form):
    assert not floor._bash_reads(form)  # the grammar, not the bare ${X[Y]} rewrite (_ARRAY_USE)


@pytest.mark.parametrize("command,expected", [
    ("gfind -O3 / -delete", TOTAL), ("find -O3 ~ -delete", TOTAL), ("gfind -O3 ~ -exec rm -rf {} +", TOTAL),
    ("gfind -O / -delete", TOTAL), ("gfind -D tree / -delete", TOTAL), ("find -E -X / -delete", TOTAL),
    ("find -f / -delete", TOTAL), ("gfind -Q / -delete", UNRESOLVED_DELETE), ("find -9 ~ -delete", UNRESOLVED_DELETE),
    ("gfind -Ofast / -delete", UNRESOLVED_DELETE), ("find -Zz / -delete", UNRESOLVED_DELETE),
    ("find build -delete", None), ("gfind -O2 build -delete", None),
])
def test_m3_find_options_before_the_start_points(command, expected):
    assert destruction_of(command, "/tmp") == expected


@pytest.mark.parametrize("change", ["printf -v X %s /", "printf -vX %s /", "mapfile X", "readarray -t X", "X+=/..",
                                    "read -a X", "getopts ab X", "let X=1", "((X=1))", "(( X += 1 ))",
                                    "for X; do :; done", "select X in a; do :; done", "unset X", "read X"])
def test_m4_a_name_changed_by_a_builtin_is_unknown_after_it(change):
    assert destruction_of(f"X=build; rm -rf $X/", "/tmp") is None
    assert destruction_of(f"X=build; {change}; rm -rf $X/", "/tmp") == UNRESOLVED_DELETE, change


# Pass 5e (lens F): the closed word grammar, the session kill, the CPU limit and the tighter profile.
LENS_F_FORMS = ['"${a[i]:-$i}"', '"${#a[i]}$i"', '"${a[i]%q}$i"', '"${a[i+0]:-$i}"']


@pytest.mark.parametrize("form", LENS_F_FORMS)
@pytest.mark.parametrize("program", ["rm -rf", "rm -f", "ls"])
def test_lens_f_a_subscript_never_reaches_bash(form, program, tmp_path, scripts, darwin_only):
    import shlex
    import time

    marker = tmp_path / "MARK"
    value = f"x[$(: > {marker}; while [ $SECONDS -lt 3 ]; do :; done)]"  # inert: an empty file that must never appear
    start = time.monotonic()
    result = destruction_of(f"i={shlex.quote(value)}; {program} {form}", str(tmp_path))
    assert time.monotonic() - start < 0.5
    assert not marker.exists()
    assert all("[i" not in s for s in scripts), scripts
    if program == "rm -rf":
        assert result == UNRESOLVED_DELETE


GRAMMAR_FORBIDDEN = ["${a[i]}", "${a[1]}", "${#X}", "${!X}", "${X%y}", "${X#y}", "${X/a/b}", "${X^^}", "${X,,}",
                     "${X:=w}", "${X=w}", "${X?}", "${X:?w}", "${X:1}", "${X:1:2}", "${X:-${Y}}",
                     "${X:-a[1]}", "${X:-$1}", "${X:-(c)}", "${X:-a;b}", "${X:-`c`}", "${X:-~root}", "${X@Q}", "${#}", "$(c)",
                     "$((1+1))", "$[1+1]", "$'a'", '$"a"', "`c`", "<(c)", ">(c)", "$1", "$@", "$*", "$#", "$?", "$$",
                     "$!", "$-", "${1}", "${@}", "\n", "~root", "~+", "~-"]
_IN_QUOTES_STAYS_FORBIDDEN = ("$", "`", "\n")


def _fuzz_words(count, seed):
    import random

    rng = random.Random(seed)
    for _ in range(count):
        piece = rng.choice(GRAMMAR_FORBIDDEN)
        pre = "".join(rng.choice("ab/._-") for _ in range(rng.randrange(4)))
        post = "".join(rng.choice("ab/._-") for _ in range(rng.randrange(4)))
        # a ~ form goes first or after =, where bash expands ~user (an assignment-like word)
        joint = "=" if piece.startswith("~") and pre else ""
        word = pre + joint + piece + "Q7" + post
        if piece.startswith(_IN_QUOTES_STAYS_FORBIDDEN) and rng.random() < 0.5:
            word = f'"{word}"'
        yield piece, word


def _spawned_scripts(monkeypatch, words):
    """Every bash script the floor tried to start for ``words``; the spawn is refused, so nothing runs."""
    seen = []

    def refuse(argv, *args, **kwargs):
        seen.append(argv[-1])
        raise OSError("spawn refused by the test")

    monkeypatch.setattr(floor.subprocess, "Popen", refuse)
    for _piece, word in words:
        floor._bash_output.cache_clear()
        floor._BLOCK_FIELDS.clear()
        destruction_of(f"rm -rf {word}", "/tmp")
    return seen


def test_fuzz_no_forbidden_form_reaches_bash(monkeypatch):
    words = list(_fuzz_words(10000, 5))
    seen = _spawned_scripts(monkeypatch, words)
    leaked = [p for p, _w in words if any(p + "Q7" in s for s in seen)]
    assert leaked == []
    assert all(not floor._bash_reads(w) for _p, w in words)


def test_fuzz_mutant_with_a_wider_grammar_goes_red(monkeypatch):
    import re

    monkeypatch.setattr(floor, "_BASH_WORD", re.compile(r"(?s:.)*"))
    words = list(_fuzz_words(300, 6))
    seen = _spawned_scripts(monkeypatch, words)
    assert any(p + "Q7" in s for p, _w in words for s in seen), "a wider grammar stayed green"


def test_a_brace_bomb_never_reaches_bash(scripts):
    assert destruction_of("rm -rf a{1..99999999}", "/tmp") == UNRESOLVED_DELETE
    assert destruction_of("rm -rf a{1..1002}", "/tmp") == UNRESOLVED_DELETE
    many = " ".join(f"{c}{{1..999}}" for c in "abcde")  # 5 x 999 words: past 4096 for one command
    assert destruction_of(f"rm -rf {many}", "/tmp") == UNRESOLVED_DELETE
    assert all("99999999" not in s and "1002" not in s and "e{1..999}" not in s for s in scripts), scripts
    assert destruction_of("rm -rf build{1..9} out{a,b}", "/tmp") is None


@pytest.mark.parametrize("command", ["rm -rf ~root/build", "X=~root/a; rm -rf \"$X\"", "rm -rf --x=~daemon/a",
                                     "rm -rf a:~nobody", "rm -rf ${X:-~root}"])
def test_tilde_with_a_name_never_reaches_bash(command, scripts):
    import re

    destruction_of(command, "/tmp")
    assert not any(re.search(r"~[A-Za-z_]", s) for s in scripts), scripts


def test_bash_starts_with_a_cpu_limit(darwin_only):
    got = floor._bash_output.__wrapped__("printf '%s\\0' \"$(ulimit -St)\" \"$(ulimit -Ht)\"")
    assert got == ("2", "3")


def _job_script(token):
    # set -m gives the background job its own process group: killpg on bash's group alone would miss it
    return f": {token}\nset -m\n( while :; do :; done ) &\nprintf '%s\\0' ok"


@pytest.mark.live_system_guard_bypass  # the floor's own signals to bash's session are the point of the test
def test_a_job_in_its_own_group_leaves_no_process(monkeypatch, darwin_only):
    import time
    import uuid

    token = "jobtok" + uuid.uuid4().hex[:8]
    assert _ours(token) == []
    monkeypatch.setattr(floor, "_BASH_TIMEOUT", 0.3)  # the job holds bash's stdout: the call ends by its timeout
    assert floor._bash_output.__wrapped__(_job_script(token)) is None
    assert _ours(token) == []  # at once: killed with the session, not later by its CPU limit
    time.sleep(5)
    assert _ours(token) == []


@pytest.mark.live_system_guard_bypass
def test_mutant_without_the_session_kill_leaves_the_job_until_its_cpu_limit(monkeypatch, darwin_only):
    import os
    import signal
    import time
    import uuid

    token = "jobtok" + uuid.uuid4().hex[:8]
    monkeypatch.setattr(floor, "_session_members", lambda session: {})
    monkeypatch.setattr(floor, "_BASH_TIMEOUT", 0.3)
    try:
        floor._bash_output.__wrapped__(_job_script(token))
        assert _ours(token), "mutant without the session kill stayed green"
        deadline = time.monotonic() + 10
        while _ours(token) and time.monotonic() < deadline:
            time.sleep(0.2)
        assert _ours(token) == []  # RLIMIT_CPU ended it on its own
    finally:
        for line in _ours(token):
            os.kill(int(line.split()[0]), signal.SIGKILL)


_PROGRAM_PROBE = r"""
import ctypes, sys
kind = sys.argv[1]
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
if kind == "process-info":
    buf = ctypes.create_string_buffer(4096)
    print("HAPPENED" if libc.proc_pidpath(int(sys.argv[2]), buf, 4096) > 0 else "denied")
elif kind == "iokit-open":
    io = ctypes.CDLL("/System/Library/Frameworks/IOKit.framework/IOKit")
    io.IOServiceMatching.restype = ctypes.c_void_p
    io.IOServiceGetMatchingService.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    service = io.IOServiceGetMatchingService(0, io.IOServiceMatching(b"IOPMrootDomain"))
    connection = ctypes.c_uint(0)
    task = ctypes.c_uint.in_dll(libc, "mach_task_self_")
    if io.IOServiceOpen(service, task, 0, ctypes.byref(connection)) == 0:
        io.IOServiceClose(connection)
        print("HAPPENED")
elif kind == "ipc-posix":
    import _multiprocessing
    name = sys.argv[2]
    try:
        _multiprocessing.SemLock(1, 1, 1, name, True)
        print("HAPPENED")
    except OSError:
        pass
    finally:
        try:
            _multiprocessing.sem_unlink(name)
        except OSError:
            pass
"""
# Rules a probe program itself needs lifted (it is a program, reads its own files, and IOKit matching uses mach).
_PROBE_NEEDS = ("process-exec", "file-read", "mach-lookup")


def _program_probe(kind, rules, tmp_path):
    import uuid

    script = tmp_path / "probe.py"
    script.write_text(_PROGRAM_PROBE)
    rules = tuple(r for r in rules if not any(need in r for need in _PROBE_NEEDS))
    if kind == "sysctl-write":
        current = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.maxfilesperproc"], capture_output=True, text=True,
                                 check=True).stdout.strip()
        # the same value it has, so even a root run changes nothing; the read-back line shows the write got past the sandbox
        body = f"/usr/sbin/sysctl -w kern.maxfilesperproc={current}"
        out = _run(["/usr/bin/sandbox-exec", "-p", floor._bash_profile(rules), "/bin/bash", "--noprofile", "--norc",
                    "-c", body], dict(_FLOOR_ENV), "/").stdout.decode("utf-8", "replace")
        return "kern.maxfilesperproc:" in out
    helper = subprocess.Popen(["/bin/sleep", "30"])
    try:
        extra = str(helper.pid) if kind == "process-info" else "/flr" + uuid.uuid4().hex[:8]
        argv = ["/usr/bin/sandbox-exec", "-p", floor._bash_profile(rules), "/usr/bin/python3", "-I", str(script), kind, extra]
        out = _run(argv, dict(_FLOOR_ENV), "/").stdout.decode("utf-8", "replace")
        return "HAPPENED" in out
    finally:
        helper.kill()
        helper.wait()


@pytest.mark.parametrize("kind", ["process-info", "iokit-open", "sysctl-write", "ipc-posix"])
def test_sandbox_profile_denies_5e_and_its_mutant_does_not(kind, tmp_path, darwin_only):
    assert not _program_probe(kind, floor._BASH_PROFILE_RULES, tmp_path)
    assert _program_probe(kind, _without(kind), tmp_path), "mutant without the rule stayed green"


# Pass 5f (lens G): each form below is never imitated; it is unresolved (Ignore refuses, other modes ask), or total when
# a written glob can name a root. Strings are classified only.
LENS_G_UNRESOLVED = [
    "rm -rf {,}~USER", "find {,}~USER -delete", "rsync -a --delete src/ {,}~USER/", "rm -rf {x,}~root/",
    "rm -rf {a=,}~root", "rm -rf {,}~root", "pushd / && pushd /tmp && rm -rf {,}~1/*", "pushd ~ && pushd /tmp && rm -rf {,}~+1",
    "rm -rf {,}~-1", "rm -rf ~+", "rm -rf ~-", "rm -rf ~1", "rm -rf ~+1", "rm -rf a=~root", "rm -rf a:~nobody",
    'cd ~ && rm -rf "$_"', "mkdir -p ~ && rm -rf $_", 'cd ~/x; rm -rf "$_"', "rm -rf ${_}", "rm -rf ${_:-x}",
    "rm -rf $0", "rm -rf $-", "rm -rf $!", "rm -rf $$", "rm -rf $?", "rm -rf $#", "rm -rf $@", "rm -rf $*",
    "IFS=x; X=/Usersxbuild; rm -rf $X", "IFS=x; rm -rf ${Y:-/Usersxbuild}", "export IFS=x; X=/Usersxb; rm -rf $X",
    "X=/Usersxb; IFS=x rm -rf $X", "read IFS; X=/Usersxb; rm -rf $X",
    "CDPATH=/Users; cd someone && rm -rf ./*", "CDPATH=/; cd Users && rm -rf ./*",
    "export CDPATH=/; cd Users; rm -rf *",
    "pushd ~; pushd /tmp; popd; rm -rf ./*", "pushd ~ && pushd /tmp && pushd +1 && rm -rf ./*",
    "cd ~ && cd /tmp && popd; rm -rf ./*", "pushd; rm -rf *", "pushd -1; rm -rf .", "pushd -n ~; rm -rf ./*",
    "cd ~ && cd /tmp && cd - && rm -rf ./*", "rm -rf /tmp/*/x", "rm -rf /Users/*/Library/x",
]


@pytest.mark.parametrize("command", LENS_G_UNRESOLVED)
def test_lens_g_forms_are_unresolved_never_read(command):
    assert destruction_of(command, "/tmp") in (UNRESOLVED_DELETE, TOTAL), command
    assert destruction_of(command, "/tmp") is not None


@pytest.mark.parametrize("form", ["{,}~root", "{x,}~root/a", "{a=,}~root", "{,}~1", "{,}~+1", "{,}~-1", "a{b,c}~d"])
def test_a_tilde_after_a_brace_never_reaches_bash(form, scripts):
    assert destruction_of(f"rm -rf {form}", "/tmp") == UNRESOLVED_DELETE
    assert not floor._bash_reads(form)
    assert all("~" not in s for s in scripts), scripts


def test_a_tilde_at_the_start_keeps_its_reading():
    assert destruction_of("rm -rf ~/{,}", "/tmp") == TOTAL
    assert destruction_of("rm -rf ~/{build,dist}", "/tmp") is None
    assert destruction_of("rm -rf build~ a~b", "/tmp") is None
    assert destruction_of("rm -rf ${UNSET:-~}", "/tmp") == TOTAL


@pytest.mark.parametrize("command", ["IFS=x; rm -rf \"$X\"/build", "IFS=x; rm -rf build", "CDPATH=/; cd /tmp/a && rm -rf ./*",
                                     "CDPATH=/; cd ./a && rm -rf ./*"])
def test_ifs_and_cdpath_leave_quoted_and_explicit_forms_alone(command):
    assert destruction_of(command, "/tmp") is None


def test_cdpath_in_the_environment_makes_a_relative_cd_unknown(monkeypatch):
    assert destruction_of("cd a && rm -rf ./*", "/tmp") is None
    monkeypatch.setenv("CDPATH", "/")
    assert destruction_of("cd a && rm -rf ./*", "/tmp") == UNRESOLVED_DELETE


@pytest.mark.parametrize("command", ["rm -rf /Us?rs", "rm -rf /[U]sers", "rm -rf /?sers/someone*", "rm -rf /U*",
                                     "rm -rf /???", "rm -rf /[^x]sers", "cd / && rm -rf Us?rs", "find /Sys?em -delete",
                                     "rsync -a --delete x/ /Us?rs/", "rm -rf /Users/?*", "rm -rf /Us?rs/*"])
def test_a_glob_that_can_name_a_root_is_total(command):
    assert destruction_of(command, "/tmp") == TOTAL, command


@pytest.mark.parametrize("command", ["rm -rf build/*.o /tmp/mytool-*", "rm -rf /tmp/x?", "rm -rf ./build-[0-9]",
                                     "rm -rf /Users/Shared/*", "rm -rf /private/tmp/a*"])
def test_an_ordinary_glob_stays_ordinary(command, monkeypatch):
    monkeypatch.setenv("HOME", "/Users/someone")  # P5u: a HOME right under /private/tmp could be named by these globs
    assert destruction_of(command, "/tmp") is None, command


@pytest.mark.parametrize("command", ["rm -rf build # clean $HOME cache", "rm -rf build # it's done", "rm -rf build #$X",
                                     "rm -rf build;# rm -rf /", "rm -rf build\n# rm -rf ~\nls"])
def test_a_comment_ends_the_command(command):
    assert destruction_of(command, "/tmp") is None, command


def test_a_hash_inside_a_word_or_quotes_is_no_comment():
    assert destruction_of("rm -rf a#b / ", "/tmp") == TOTAL
    assert destruction_of("rm -rf '#' /", "/tmp") == TOTAL
    assert destruction_of("rm -rf build\n rm -rf ~ # x", "/tmp") == TOTAL


def test_a_line_has_one_budget_of_steps(monkeypatch):
    import time

    huge = "; ".join("rm -rf a%d{1..1000}{1,2,3,4}" % i for i in range(3))
    started = time.monotonic()
    destruction_of(huge, "/tmp")
    assert time.monotonic() - started < 4.0
    many = "; ".join("rm -rf a%d{1..1000}{1,2,3,4}" % i for i in range(40))
    started = time.monotonic()
    assert destruction_of(many, "/tmp") == UNRESOLVED_DELETE  # past the line's budget
    assert time.monotonic() - started < 6.0
    monkeypatch.setattr(floor, "_LINE_STEPS", 0)
    assert destruction_of("rm -rf build", "/tmp") == UNRESOLVED_DELETE


def test_a_brace_list_bomb_is_unread_and_never_reaches_bash(scripts):
    bomb = "x" + "{a,b}" * 13  # 8192 words from lists alone
    assert destruction_of(f"rm -rf {bomb}", "/tmp") == UNRESOLVED_DELETE
    assert all("{a,b}" * 13 not in s for s in scripts), scripts
    assert floor._brace_words(bomb) is None
    assert floor._brace_words("x{a,b}{c,d,e}") == 6


def test_a_block_cut_short_is_never_read(monkeypatch):
    def cut_short(script):
        return ("\x020", "build", "/")  # bash stopped before the block's closing ''

    monkeypatch.setattr(floor, "_bash_output", cut_short)
    assert floor._read_chunk(["blk"]) == {"blk": floor._STOPPED}
    assert destruction_of("rm -rf bu{il,i}d", "/tmp") == UNRESOLVED_DELETE


# Pass 5g, lens H: a glob the floor cannot read near a root is unresolved, never matched by imitation.
LENS_H_GLOBS = ["rm -rf /[!u]sers", "rm -rf /[^u]sers", "rm -rf /[!a-z]sers", "rm -rf /[[:upper:]]sers",
                "rm -rf /Use[[:alpha:]]s", "rm -rf /[!s]ystem", "rm -rf /[!l]ibrary", "rm -rf /[[:upper:]]*",
                "rm -rf /[![:lower:]]sers", "rm -rf /[[:alpha:]]sr", "rm -rf /[[:alnum:]]ar", "find /[!u]sers -delete",
                "rsync -a --delete x/ /[!u]sers/", "cd / && rm -rf [!u]sers", "cd / && rm -rf [[:upper:]]*",
                "sudo rm -rf /[!u]sers", "env rm -rf /[[:upper:]]sers", "rm -rf /Users/[!x]*", "rm -rf /private/v?r"]


@pytest.mark.parametrize("command", LENS_H_GLOBS)
def test_a_glob_near_a_root_the_floor_cannot_read_is_never_allowed(command):
    assert destruction_of(command, "/tmp") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["rm -rf build\r# ~", "rm -rf /tmp/x\r# /Users", "rm -rf node_modules\r# ~/",
                                     "rm -rf build\r#\r~"])
def test_a_hash_after_a_carriage_return_is_no_comment(command):
    assert destruction_of(command, "/tmp") is not None, command


LENS_H_SUBSTITUTION_COMMENTS = ["x=$(true # it's\n); rm -rf ~ #'", "x=`true # it's\n`; rm -rf ~ #'",
                                "y=$(: #\")\n); rm -rf ~ #\"", "echo $(: #`\n); rm -rf ~ #`", "x=$(true # (\n); rm -rf ~",
                                "echo $(: #'\n)\nrm -rf ~\n'"]


@pytest.mark.parametrize("command", LENS_H_SUBSTITUTION_COMMENTS)
def test_a_comment_inside_a_substitution_never_hides_the_line(command):
    assert destruction_of(command, "/tmp") is not None, command


# Pass 5g, lens I: a delete is judged in every folder the line could be in; a cd the floor cannot read is unresolved.
LENS_I_FROM_A_HOME = ["cd build; rm -rf *", "cd /tmp/nope-xyz; rm -rf *", "cd /tmp/nope-xyz; find . -delete",
                      "cd /tmp/nope-xyz; rm -rf -- \"$PWD\"", "cd /tmp/nope-xyz\nrm -rf *", "pushd /tmp/nope-xyz; rm -rf *",
                      "cd /tmp/nope-xyz; rsync -a --delete /tmp/empty/ .", "(cd /tmp); rm -rf *", "cd /tmp | true; rm -rf *",
                      "{ cd /tmp; } | cat; rm -rf *", "cd /tmp & rm -rf *", "false && cd /tmp; rm -rf *",
                      "if false; then cd /tmp; fi; rm -rf *", "while false; do cd /tmp; done; rm -rf *",
                      "cd() { :; }; cd /tmp; rm -rf *"]


@pytest.mark.parametrize("command", LENS_I_FROM_A_HOME)
def test_a_cd_that_may_not_run_keeps_the_folder_before_it(command):
    assert destruction_of(command, "/Users/someone") in (UNRESOLVED_DELETE, TOTAL), command


LENS_I_UNREAD_CD = ["cd 2>/dev/null ~; rm -rf *", "HOME=/ cd; rm -rf usr", "env -C / rm -rf usr", "env -C /usr rm -rf *",
                    "sudo -D / rm -rf usr", "env --chdir / rm -rf usr", "usr=/; shopt -s cdable_vars; cd usr; rm -rf *",
                    "shopt -s expand_aliases\nalias cd=true\ncd /tmp\nrm -rf *", "source ./env.sh; rm -rf *",
                    ". ./env.sh; rm -rf *"]


@pytest.mark.parametrize("command", LENS_I_UNREAD_CD)
def test_a_cd_or_folder_change_the_floor_cannot_read_is_unresolved(command):
    assert destruction_of(command, "/tmp/proj") in (UNRESOLVED_DELETE, TOTAL), command


def test_cd_with_an_empty_word_stays_where_it_is():
    assert destruction_of('cd ""; rm -rf usr', "/") == TOTAL
    assert destruction_of("cd ''; rm -rf usr", "/") == TOTAL
    assert destruction_of('cd ""; rm -rf ./*', "/tmp/proj") is None  # not the home: bash 3.2 stays where it is


@pytest.mark.parametrize("command", ["cd build && rm -rf *", "cd dist; rm -rf ./*", "cd build && rm -rf ./*.o",
                                     "(cd build && rm -rf *)", "cd /tmp/proj/dist && rm -rf ./*"])
def test_an_ordinary_cd_and_delete_in_a_project_stays_allowed(command):
    assert destruction_of(command, "/tmp/proj") is None, command


# Pass 5h (lens J). Every probe is a string given to the classifier; nothing is run.
LENS_J_UNKNOWN_FOLDER = ["env -C/ rm -rf Users", "env -iC/ rm -rf Users", "sudo -D/ rm -rf Users", "env -C/Users rm -rf someone",
                         "cd ~- && rm -rf Users", 'cd "$SOMEVAR"; rm -rf Library', 'cd "$SOMEVAR" && rm -rf System',
                         'pushd "$X"; rm -rf Users', "cd $(cat f); rm -rf Applications"]


@pytest.mark.parametrize("command", LENS_J_UNKNOWN_FOLDER)
def test_an_unknown_folder_leaves_every_relative_target_unresolved(command):
    assert destruction_of(command, "/Users/someone/proj") in (UNRESOLVED_DELETE, TOTAL), command


def test_an_attached_folder_option_is_read_as_the_folder_it_names():
    assert destruction_of("env -C/ rm -rf Users", "/tmp/proj") == TOTAL
    assert destruction_of("env -C/tmp/proj rm -rf build", "/tmp") is None


LENS_J_CDPATH_HOME = [": ${CDPATH:=/}; cd Users && rm -rf *", ": ${CDPATH=/}; cd Users; rm -rf ./*",
                      "read CDPATH <<< /; cd Library && rm -rf *", "printf -v CDPATH /; cd Users && rm -rf *",
                      "declare CDPATH=/; cd Users && rm -rf *", "read HOME <<< /; cd && rm -rf Users",
                      "read -r HOME <<< /; cd; rm -rf -- Users Library", "printf -v HOME /; cd && rm -rf Users",
                      "HOME=/; cd; rm -rf Users", "export HOME=/; cd ~ && rm -rf Users", ": ${HOME:=/}; cd && rm -rf Users",
                      "mapfile HOME < f; cd && rm -rf Users", "getopts a HOME; cd && rm -rf Users",
                      "read HOME <<< /; rm -rf ~/Users"]


@pytest.mark.parametrize("command", LENS_J_CDPATH_HOME)
def test_cdpath_or_home_named_on_the_line_makes_the_cd_unknown(command):
    for cwd in ("/Users/someone/proj", "/tmp/proj"):
        assert destruction_of(command, cwd) in (UNRESOLVED_DELETE, TOTAL), (command, cwd)


def test_reading_cdpath_or_home_keeps_an_ordinary_cd():
    # 5p (lead's decision): after a command with a quoted or $ word the folder is unknown, so the relative cd that
    # follows is unknown too: rm -rf * is unresolved (Ignore refuses, other modes ask). Known over-refusal.
    assert destruction_of('echo "$CDPATH"; cd build && rm -rf *', "/tmp/proj") == UNRESOLVED_DELETE
    assert destruction_of('echo "$HOME"; cd /tmp/proj && rm -rf build', "/tmp") is None


LENS_J_LINKS = ["ln -s / x && rm -rf x/*", "ln -s .. up; rm -rf up/*", "ln -sfn ~ h && rm -rf h/",
                "ln -s .. up && rm -rf up/", "ln -s / x; find x/ -delete", "sudo ln -s / x; rm -rf /tmp/proj/x/*"]


@pytest.mark.parametrize("command", LENS_J_LINKS)
def test_a_link_made_on_the_line_is_unresolved(command):
    assert destruction_of(command, "/tmp/proj") in (UNRESOLVED_DELETE, TOTAL), command
    assert destruction_of(command.split(";")[-1].split("&&")[-1], "/tmp/proj") is None, command


LENS_J_GIT_CLEAN = [("git -C ~ clean -ffdx", "/tmp/proj"), ("git -C .. clean -ffdxq", "/Users/someone/proj"),
                    ("git clean -ffdx", "/Users/someone"), ("git clean -f -d", "/Users/someone"),
                    ("git -C / clean --force -d", "/tmp"), ("git -c a=b -C .. clean -fdx", "/Users/someone/proj")]


@pytest.mark.parametrize("command,cwd", LENS_J_GIT_CLEAN)
def test_git_clean_is_read_as_a_delete_of_its_folder(command, cwd):
    assert destruction_of(command, cwd) == TOTAL, command


@pytest.mark.parametrize("command", ["git clean -fdx", "git clean -ffdx", "git -C sub clean -fd", "git clean -nfdx",
                                     "git clean -fx", "git status"])
def test_an_ordinary_git_clean_in_a_project_stays_allowed(command):
    assert destruction_of(command, "/tmp/proj") is None, command
    assert destruction_of('git -C "$X" clean -fdx', "/tmp/proj") == UNRESOLVED_DELETE


LENS_J_CD_AND = [("cd proj && rm -rf *", "/Users/someone"), ("cd proj && rm -rf ./*", "/Users/someone"),
                 ("cd proj/build && rm -rf *", "/Users/someone"), ("cd /tmp/x && rm -rf *", "/Users/someone"),
                 ('cd "$TMPDIR" && rm -rf *', "/Users/someone"), ("cd tmp && rm -rf *", "/"),
                 ("cd someone/proj && rm -rf *", "/Users"), ("cd sub && rm -rf ../*", "/Users/someone/proj"),
                 ("make && cd build && rm -rf * && cmake ..", "/Users/someone"), ("(cd build && rm -rf *)", "/Users/someone")]


@pytest.mark.parametrize("command,cwd", LENS_J_CD_AND)
def test_a_delete_joined_to_a_cd_by_and_alone_runs_in_the_cd_target(command, cwd):
    assert destruction_of(command, cwd) is None, command


@pytest.mark.parametrize("command", ["cd proj; rm -rf *", "cd proj || true && rm -rf *", "cd proj | cat && rm -rf *",
                                     "cd proj && true; rm -rf *", "true || cd proj && rm -rf *", "(cd proj) && rm -rf *",
                                     "cd proj & rm -rf *", 'cd "$X" && rm -rf *'])
def test_any_other_join_keeps_every_folder(command):
    assert destruction_of(command, "/Users/someone") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["pushd build >/dev/null; rm -rf *; popd >/dev/null", "cd build 2>/dev/null && rm -rf *",
                                     "pushd build > /dev/null && rm -rf * && popd > /dev/null", "cd build &>/dev/null && rm -rf *"])
def test_a_cd_with_its_output_to_dev_null_is_read(command):
    assert destruction_of(command, "/Users/someone/proj") is None, command


@pytest.mark.parametrize("command", ["cd build >out && rm -rf *", "cd build 2>&1 && rm -rf *", "cd build </dev/null && rm -rf *"])
def test_a_cd_with_any_other_redirection_stays_unresolved(command):
    assert destruction_of(command, "/Users/someone/proj") == UNRESOLVED_DELETE, command


@pytest.mark.parametrize("command", ["cd proj && \nrm -rf *", "cd proj &&\n\nrm -rf ./*"])
def test_a_newline_after_and_continues_the_list(command):
    assert destruction_of(command, "/Users/someone") is None, command


@pytest.mark.parametrize("command", ["git clean -ffdx", "env -C.. find . -delete", "rm -rf Users"])
def test_a_call_folder_that_is_not_absolute_is_unknown(command):
    assert destruction_of(command, "somewhere/proj") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("target", ["Users", "users", "Library", "tmp", "*", ".", "./", "..", "../b", "a/../..", "U*", "{a}",
                                    "./Users/x"])
def test_under_an_unknown_folder_a_target_that_could_be_a_root_is_unresolved(target):
    assert destruction_of(f'cd "$X" && rm -rf {target}', "/tmp/proj") in (UNRESOLVED_DELETE, TOTAL), target


@pytest.mark.parametrize("target", ["build", "./build/*", "dist", "node_modules", "build/*.o", "out/sub"])
def test_under_an_unknown_folder_an_ordinary_target_stays_allowed(target):
    assert destruction_of(f'cd "$X" && rm -rf {target}', "/tmp/proj") is None, target


# Pass 5i (lens M, lens L): git clean read as git reads it; bash's logical cd; loops, functions and traps that move the
# folder; volume names under an unknown folder; bare names after a link; cd into a fresh mktemp folder. Strings only.
@pytest.mark.parametrize("command,cwd", [("git clean -fd -en", "/Users/someone"), ("git clean --forc -d", "/Users/someone"),
                                         ("git clean --for -d", "/Users/someone"), ("git clean -fd -e n", "/Users/someone"),
                                         ("git clean -fd --exclude n", "/Users/someone"), ("git clean -fd -eXn", "/Users/someone"),
                                         ("git -c clean.requireForce=false clean -d", "/Users/someone"),
                                         ("git clean -fdx ~", "/Users/someone/proj"), ("git clean -fdx ..", "/Users/someone/proj"),
                                         ("git clean -fd -- /", "/tmp/proj"), ("git clean -f .", "/Users/someone"),
                                         ("git clean -f -- ~", "/Users/someone"), ("git clean -fx ~", "/tmp/proj"),
                                         ("git -cclean.requireForce=false clean .", "/Users/someone")])
def test_git_clean_options_and_paths_are_read_as_git_reads_them(command, cwd):
    assert destruction_of(command, cwd) == TOTAL, command


@pytest.mark.parametrize("command", ["git clean -fdi", "git clean -fdz", "git clean -fd --frobnicate", "git clean -fdx :/",
                                     "git clean -fd ':(top)'", "git clean -fd :!build", 'git -C "$X" clean -fd build'])
def test_git_clean_with_an_option_or_pathspec_it_cannot_read_is_unresolved(command):
    assert destruction_of(command, "/tmp/proj") == UNRESOLVED_DELETE, command


@pytest.mark.parametrize("command", ["git clean -fdx build", "git clean -fd -e keep.txt", "git clean --dry -fd", "git clean -fdn"])
def test_an_ordinary_git_clean_with_paths_or_patterns_stays_allowed(command):
    assert destruction_of(command, "/Users/someone/proj" if "~" not in command else "/tmp/proj") is None, command


def test_mutant_git_clean_without_the_long_prefixes_no_longer_reads_forc(monkeypatch):
    monkeypatch.setattr(floor, "_GIT_CLEAN_LONG", ())
    assert destruction_of("git clean --forc -d", "/Users/someone") != TOTAL


def test_mutant_git_clean_without_pathspec_magic_reads_top_as_a_name(monkeypatch):
    monkeypatch.setattr(floor, "_GIT_PATHSPEC_MAGIC", "\x00")
    assert destruction_of("git clean -fdx :/", "/tmp/proj") is None


LENS_L_LOGICAL_CD = ["cd /tmp/../Users && rm -rf *", "cd /var/.. && rm -rf Users", "cd /tmp/.. && rm -rf Users Library",
                     "cd /var/../Applications && rm -rf *", "cd /etc/../Users; rm -rf ./*",
                     "cd /Applications/Safari.app/../.. && rm -rf *", "cd /Applications/Safari.app/.. && rm -rf *",
                     "cd /Applications/Safari.app/.. && rm -rf ../Users", "cd /Applications/Safari.app && cd .. && rm -rf *",
                     "rm -rf /var/../Users", "rm -rf /tmp/../Users/"]


@pytest.mark.parametrize("command", LENS_L_LOGICAL_CD)
def test_a_cd_is_judged_logically_and_physically_and_the_worse_wins(command):
    assert destruction_of(command, "/tmp/w") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command,cwd", [("cd .. && rm -rf build", "/Users/someone/proj/sub"),
                                         ("cd ../x && rm -rf *", "/Users/someone/proj/sub"),
                                         ("cd sub && cd .. && rm -rf build", "/Users/someone/proj")])
def test_an_ordinary_cd_up_stays_allowed(command, cwd):
    assert destruction_of(command, cwd) is None, command


def test_mutant_without_the_logical_reading_misses_the_link_climb(monkeypatch):
    monkeypatch.setattr(floor, "_logical_reading", lambda field, cwd, follow: None)
    assert destruction_of("cd /var/.. && rm -rf Users", "/tmp/w") is None


@pytest.mark.parametrize("command,cwd", [("for i in 1 2 3; do cd ..; done; rm -rf *", "/Users/someone/p/q/r"),
                                         ("up() { cd ..; }; up; up; up; rm -rf *", "/Users/someone/p/q/r"),
                                         ('while [ "$PWD" != / ]; do cd ..; done; rm -rf *', "/tmp/w"),
                                         ("until false; do cd ..; done; rm -rf *", "/tmp/w"),
                                         ("f() { cd ~; }; cd /tmp/x && f && rm -rf *", "/tmp/w"),
                                         ("function f { cd ~; }; cd /tmp/x && f && rm -rf *", "/tmp/w"),
                                         ("cd /tmp/x && trap 'cd ~' DEBUG && rm -rf *", "/tmp/w")])
def test_a_cd_in_a_loop_a_called_function_or_a_trap_leaves_the_folder_unknown(command, cwd):
    assert destruction_of(command, cwd) in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["f() { make; }; make && rm -rf build", "for f in *.o; do rm -f $f; done",
                                     "for d in a b; do cd $d && make; done; rm -rf build"])
def test_a_loop_or_function_that_moves_nothing_stays_allowed(command):
    assert destruction_of(command, "/tmp/w") is None, command


def test_mutant_without_the_loop_rule_reads_the_loop_cd_once(monkeypatch):
    monkeypatch.setattr(floor, "_FOLDER_WORDS_ANYWHERE", frozenset())  # 5p rule off too
    monkeypatch.setattr(floor, "_COMMAND_WORD_NOISE", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_LOOP_WORDS", frozenset())
    assert destruction_of("for i in 1 2 3; do cd ..; done; rm -rf *", "/Users/someone/p/q/r") is None


def test_mutant_without_the_function_rule_misses_the_call(monkeypatch):
    monkeypatch.setattr(floor, "_FOLDER_WORDS_ANYWHERE", frozenset())  # 5p rule off too
    monkeypatch.setattr(floor, "_COMMAND_WORD_NOISE", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_folder_moving_functions", lambda text: frozenset())
    monkeypatch.setattr(floor, "_ANY_FUNCTION", re.compile(r"(?!)"))  # 5k's wider rule off too
    assert destruction_of("up() { cd ..; }; up; up; up; rm -rf *", "/Users/someone/p/q/r") is None


@pytest.mark.parametrize("target", ['"Macintosh HD/"', '"macintosh hd"', "Data", "data/*", '"System Volume Information"',
                                    "Preboot", "Recovery", "VM"])
def test_under_an_unknown_folder_a_volume_name_is_unresolved(target):
    assert destruction_of(f'cd "$X" && rm -rf {target}', "/tmp/w") == UNRESOLVED_DELETE, target


def test_mutant_without_the_volume_names_reads_macintosh_hd_as_ordinary(monkeypatch):
    monkeypatch.setattr(floor, "_PROTECTED_NAMES", floor._PROTECTED_NAMES - {"macintosh hd"})
    assert destruction_of('cd "$X" && rm -rf "Macintosh HD/"', "/tmp/w") is None


@pytest.mark.parametrize("command", ["ln -s /x y && rm -rf dist", "ln -s / x && rm -rf x", "ln -sf ../lib l; rm -rf build"])
def test_after_a_link_a_bare_name_is_an_ordinary_delete(command):
    assert destruction_of(command, "/tmp/w") is None, command


def test_mutant_reading_every_target_through_the_link_refuses_a_bare_name(monkeypatch):
    monkeypatch.setattr(floor, "_may_go_through_a_link", lambda field, follow=True: True)
    assert destruction_of("ln -s /x y && rm -rf dist", "/tmp/w") == UNRESOLVED_DELETE


@pytest.mark.parametrize("command", ['cd "$(mktemp -d)" && rm -rf *', "cd $(mktemp -d) && rm -rf *",
                                     "cd `mktemp -d` && rm -rf ./*", 'pushd "$(mktemp -d -t x)" && rm -rf *'])
def test_a_cd_into_a_fresh_mktemp_folder_is_ordinary(command):
    assert destruction_of(command, "/Users/someone") is None, command


def test_mutant_without_the_mktemp_cd_refuses_it(monkeypatch):
    monkeypatch.setattr(floor, "_MKTEMP_CD", __import__("re").compile("(?!)"))
    assert destruction_of('cd "$(mktemp -d)" && rm -rf *', "/Users/someone") in (UNRESOLVED_DELETE, TOTAL)


def test_a_project_folder_named_by_a_variable_keeps_bin_unresolved():
    # Stated: under a folder the floor cannot read, bin (a root name) is unresolved; obj alone stays allowed.
    assert destruction_of('cd "$PROJECT_DIR" && rm -rf bin obj', "/tmp/w") == UNRESOLVED_DELETE
    assert destruction_of('cd "$PROJECT_DIR" && rm -rf obj', "/tmp/w") is None


@pytest.mark.parametrize("command", ["script -q /dev/null rm -rf ~", "script -t 0 out rm -rf /", "su -c 'rm -rf ~' root",
                                     "su root -c 'rm -rf /'"])
def test_script_and_su_c_run_what_they_are_given(command):
    assert destruction_of(command, "/tmp/w") == TOTAL, command


@pytest.mark.parametrize("command", ["script -q /dev/null make", "su -c 'rm -rf build' someone"])
def test_script_and_su_c_with_ordinary_work_stay_allowed(command):
    assert destruction_of(command, "/tmp/w") is None, command


def test_total_only_from_the_folder_before_a_cd_is_unresolved_and_its_mutant_is_total(monkeypatch):
    assert destruction_of("cd proj; rm -rf *", "/Users/someone") == UNRESOLVED_DELETE
    assert destruction_of("rm -rf *", "/Users/someone") == TOTAL
    real = floor._chdir_places
    # Mutant: every folder counts as one the line reaches (the cap never applies).
    monkeypatch.setattr(floor, "_chdir_places", lambda prefix, here: real(prefix, here) + [None, "/Users/someone"])
    assert destruction_of("cd proj; rm -rf *", "/Users/someone") == TOTAL


LENS_N_FUNCTIONS = ["f(){ echo ${HOME}; cd /; }; cd src && f && rm -rf *",
                    "f(){ case x in x) true;; esac; cd /; }; cd src && f && rm -rf *",
                    "f(){ echo $(pwd); cd /; }; cd src && f && rm -rf *", "f(){ echo }; cd /; }; cd src && f && rm -rf *",
                    "g(){ cd /; }; f(){ g; }; cd src && f && rm -rf *", "function f { echo ${HOME}; cd /; }; cd src && f && rm -rf *",
                    "f(){ make; }; cd build && f && rm -rf *"]


@pytest.mark.parametrize("command", LENS_N_FUNCTIONS)
def test_a_call_of_any_function_on_a_line_with_a_cd_leaves_the_folder_unknown(command):
    # Stated: bodies are not parsed, so a function that moves nothing is unknown too (Ignore refuses, Manual asks).
    assert destruction_of(command, "/tmp/w") in (UNRESOLVED_DELETE, TOTAL), command


def test_mutant_reading_the_body_up_to_the_first_brace_misses_lens_n(monkeypatch):
    monkeypatch.setattr(floor, "_folder_moving_functions", lambda text: frozenset(
        m.group(1) or m.group(2) for m in floor._FUNCTION_DEFINITION.finditer(text)
        if floor._MOVES_FOLDER.search(text[m.end():].split("}")[0])))
    monkeypatch.setattr(floor, "_ANY_FUNCTION", re.compile(r"(?!)"))  # 5k's wider rule off too
    assert destruction_of(LENS_N_FUNCTIONS[0], "/tmp/w") is None


@pytest.mark.parametrize("command", ["ln -s / x && cd x && rm -rf Users", "ln -s / x && rsync -a --delete e/ x",
                                     "ln -s / x && pushd x && rm -rf *", "ln -s / x && find -L x -delete"])
def test_after_a_link_a_bare_name_that_is_followed_stays_unresolved(command):
    assert destruction_of(command, "/tmp/w") in (UNRESOLVED_DELETE, FOLLOWED_LINKS_DELETE, TOTAL), command


def test_after_a_link_rm_of_the_link_itself_stays_allowed_and_its_mutant_refuses(monkeypatch):
    assert destruction_of("ln -s ../shared dist && rm -rf dist", "/tmp/w") is None
    monkeypatch.setattr(floor, "_may_go_through_a_link", lambda field, follow=True: True)
    assert destruction_of("ln -s ../shared dist && rm -rf dist", "/tmp/w") == UNRESOLVED_DELETE


def test_mutant_git_clean_needing_d_again_misses_a_forced_clean(monkeypatch):
    assert destruction_of("git clean -f .", "/Users/someone") == TOTAL


# Pass 5j (lens P-2, review p16-lens-P): git reads its config and tree from the environment too. A line that names
# GIT_CONFIG*, GIT_WORK_TREE, GIT_DIR or core.worktree makes a git clean on it unresolved, forced or not.
@pytest.mark.parametrize("command", [
    "GIT_CONFIG_PARAMETERS=\"'clean.requireForce=false'\" git clean -dx",
    "export GIT_CONFIG_PARAMETERS=\"'clean.requireForce=false'\"; git clean -dx",
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=clean.requireForce GIT_CONFIG_VALUE_0=false git clean -dx",
    "GIT_WORK_TREE=/ git clean -fdx",
    "git -c core.worktree=/ clean -fdx",
])
def test_git_config_from_the_environment_makes_a_clean_unresolved(command):
    assert destruction_of(command, "/Users/someone") in (UNRESOLVED_DELETE, TOTAL), command


def test_mutant_without_the_environment_check_lets_the_clean_through(monkeypatch):
    command = "GIT_CONFIG_PARAMETERS=\"'clean.requireForce=false'\" git clean -dx"
    monkeypatch.setattr(floor, "_GIT_ENV_CONFIG", re.compile(r"(?!)"))
    assert destruction_of(command, "/Users/someone") is None


def test_a_plain_project_clean_stays_allowed_after_5j():
    assert destruction_of("git clean -fdx", "/tmp/w/proj") is None


# Pass 5k (lens Q, review p17-lens-Q, both proven in bash): a folder-moving function called behind time, an assignment
# or with a name the definition pattern missed. No call is looked for: a line with a function definition and a cd makes
# the folder unknown after every command.
LENS_Q_CALLS = [
    "f(){ cd /; }; cd sub && time f && rm -rf *",
    "f(){ cd /; }; cd sub && time -p f && rm -rf *",
    "f(){ cd /; }; cd sub && X=1 f && rm -rf *",
    "f+(){ cd /; }; cd sub && f+ && rm -rf *",
    "function f+ { cd /; }; cd sub && f+ && rm -rf *",
    "f(){ cd /; }; cd sub && time f && find . -delete",
]


@pytest.mark.parametrize("command", LENS_Q_CALLS)
def test_lens_q_a_call_the_floor_cannot_spot_still_leaves_the_folder_unknown(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, FOLLOWED_LINKS_DELETE, TOTAL), command


def test_mutant_without_the_any_function_rule_misses_lens_q(monkeypatch):
    monkeypatch.setattr(floor, "_FOLDER_WORDS_ANYWHERE", frozenset())  # 5p rule off too
    monkeypatch.setattr(floor, "_COMMAND_WORD_NOISE", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_ANY_FUNCTION", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_folder_moving_functions", lambda text: frozenset())  # 5i's name rule off too
    assert destruction_of(LENS_Q_CALLS[0], "/tmp/w/proj") is None


def test_a_line_without_a_function_keeps_the_cd_and_chain():
    assert destruction_of("cd sub && time make && rm -rf build", "/tmp/w/proj") is None


# Pass 5l (lens S, review p18-lens-S): the runtime runs a command with aliases expanded, so an alias the line makes is
# not read: the line is unresolved (proven in bash: alias f='cd /'; f; rm -rf * ran in /). And 5k's function rule reads
# code only: () inside quotes, or a . that is an argument (find ., git add .), is not a definition or a folder change.
@pytest.mark.parametrize("command", ["alias f='cd /'; f; rm -rf *", "alias x='rm -rf ~'; x", "alias x=rm; x -rf /",
                                     "builtin alias x='rm -rf /System'; x"])
def test_an_alias_made_on_the_line_is_unresolved(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


def test_mutant_without_the_alias_rule_lets_it_through(monkeypatch):
    monkeypatch.setattr(floor, "_ALIAS_DEFINITION", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_ALIAS_ANYWHERE", re.compile(r"(?!)"))  # 5p's wider rule off too
    assert destruction_of("alias x='rm -rf ~'; x", "/tmp/w/proj") is None


@pytest.mark.parametrize("command", ["cd sub && rm -rf bin && echo 'done()'", "cd sub && find . -name x && rm -rf bin",
                                     "cd sub && git add . && rm -rf tmp && echo \"f() { cd /; }\""])
def test_quoted_parentheses_or_a_dot_argument_keep_ordinary_deletes(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


def test_mutant_reading_quotes_as_code_refuses_the_ordinary_delete(monkeypatch):
    monkeypatch.setattr(floor, "_QUOTED", re.compile(r"(?!)"))
    assert destruction_of("cd sub && rm -rf bin && echo 'f() { cd /; }'", "/tmp/w/proj") is not None


# Pass 5m (lens V, review p19-lens-V): quotes and backslashes do not hide alias or cd from bash, and a function that
# runs its arguments can run a cd it is given.
@pytest.mark.parametrize("command", ["\\alias x='rm -rf ~'", "'alias' x='rm -rf ~'", "a''lias x='rm -rf ~'",
                                     "alias -- x='rm -rf ~'", "f(){ \"$@\"; }; f c\\d /; rm -rf *"])
def test_lens_v_spellings_are_unresolved(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


def test_mutant_without_unquoting_misses_a_quoted_alias(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category", lambda text: False)  # P5y2: the category layer off too
    monkeypatch.setattr(floor, "_WORD_NOISE", re.compile(r"(?!)"))
    assert destruction_of("\\alias x='rm -rf ~'", "/tmp/w/proj") is None


# Pass 5n (lens W, lens X; reviews p20-lens-W, p20-lens-X, proven in bash): bash builds a word from quotes, escapes,
# $'..', braces, commas and backslash-newline. The floor removes that noise from the word in command position: alias
# there makes the line unresolved, and cd/pushd/popd/source/. spelled that way leaves the folder unknown. Any function
# defined on the line leaves the folder unknown after every command, whatever its body holds.
LENS_WX = ["{alias,} x='rm -rf ~'\nx", "$'alias' x='rm -rf ~'\nx", "al\\\nias x='rm -rf ~'\nx",
           "X=1 alias y='rm -rf ~'; y", "f(){ for a; do \"$a\" /; done; }; f c$'d'; rm -rf *", "$'cd' /; rm -rf *",
           "c\\\nd /; rm -rf *"]


@pytest.mark.parametrize("command", LENS_WX)
def test_lens_w_and_x_spellings_are_unresolved(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["echo \"alias ll='ls -la'\" >> ~/.zshrc", 'grep -n "alias gs=" ~/.zshrc',
                                     "f(){ make; }; f && rm -rf build"])
def test_a_mentioned_alias_or_a_harmless_function_keeps_ordinary_work(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


def test_mutant_without_the_spelled_command_word_misses_dollar_quoted_cd(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category", lambda text: False)  # P5y2: the category layer off too
    monkeypatch.setattr(floor, "_COMMAND_WORD_NOISE", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_FOLDER_WORDS_ANYWHERE", frozenset())
    assert destruction_of("$'cd' /; rm -rf *", "/tmp/w/proj") is None


def test_mutant_requiring_a_cd_in_the_body_misses_lens_w(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category", lambda text: False)  # P5y2: the category layer off too
    monkeypatch.setattr(floor, "_FOLDER_WORDS_ANYWHERE", frozenset())  # 5p rule off too
    monkeypatch.setattr(floor, "_COMMAND_WORD_NOISE", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_ANY_FUNCTION", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_folder_moving_functions", lambda text: frozenset())
    assert destruction_of("f(){ for a; do \"$a\" /; done; }; f c$'d'; rm -rf *", "/tmp/w/proj") is None


# Pass 5o: a command word written with any of ' " \ $ { } ` , is not rebuilt: the folder is unknown after it, so a later
# delete of a root name, *, . or .. is unresolved; ordinary names (build, dist) stay allowed.
@pytest.mark.parametrize("word", ["${x:-cd}", "$'cd'", "c''d", 'c""d', "c\\d", "{cd,}", "`echo cd`", "$(echo cd)", "c,d"])
def test_a_command_word_written_with_shell_quoting_leaves_the_folder_unknown(word):
    assert destruction_of(f"{word} /; rm -rf *", "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), word


@pytest.mark.parametrize("command", ['"$PY" -m build && rm -rf build', "$EDITOR x; rm -rf dist", "X=1 make && rm -rf build"])
def test_a_variable_program_keeps_ordinary_deletes(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


# Pass 5p (lens W2, review p21-lens-W2, proven in bash): an alias made behind case, time -p or a redirection, on a line
# with more than one command, is caught by "alias name=" anywhere; a single command that only mentions it is not.
LENS_W2 = ["case x in *) alias ls='cd /';; esac\nls && rm -rf *", "time -p alias ls='cd /'\nls && rm -rf *",
           "2>/dev/null alias ls='cd /'\nls && rm -rf *", "X=1 2>&1 alias ls='cd /'\nls && rm -rf *",
           "{ 2>/dev/null alias ls='cd /'; }\nls && rm -rf *"]


@pytest.mark.parametrize("command", LENS_W2)
def test_lens_w2_aliases_are_unresolved(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


def test_mutant_without_the_anywhere_rule_misses_lens_w2(monkeypatch):
    monkeypatch.setattr(floor, "_ALIAS_ANYWHERE", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_GLOB_IN_WORD", re.compile(r"(?!)"))  # the case pattern * is a glob word (5r)
    assert destruction_of(LENS_W2[0], "/tmp/w/proj") is None


def test_a_mentioned_alias_on_a_line_with_more_commands_is_unresolved_by_choice():
    # Lead's decision (5p): "alias name=" anywhere on a line with more than one command is unresolved, even when it is
    # only printed; Ignore refuses, the other modes ask. Known over-refusal, stated in SECURITY.md.
    assert destruction_of("printf '%s\\n' \"alias k='kubectl'\" >> .bashrc && rm -rf dist", "/tmp/w/proj") == UNRESOLVED_DELETE


# Pass 5p (lens X2, review p21-lens-X2, proven in bash): a cd behind a redirection, an assignment, time, !, if, {,
# builtin or command, or a quoted command word after them, leaves the folder unknown.
LENS_X2 = ["</dev/null cd /; rm -rf *", "X=1 $'cd' /; rm -rf *", "time $'cd' /; rm -rf *", "! $'cd' /; rm -rf *",
           "if $'cd' /; then rm -rf *; fi", "{ $'cd' /; }; rm -rf *", "builtin cd /; rm -rf *", "command cd /; rm -rf *"]


@pytest.mark.parametrize("command", LENS_X2)
def test_lens_x2_a_cd_behind_a_prefix_leaves_the_folder_unknown(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


def test_mutant_reading_only_the_first_word_misses_a_redirected_cd(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category", lambda text: False)  # P5y4: the category layer off too
    monkeypatch.setattr(floor, "_FOLDER_WORDS_ANYWHERE", frozenset())
    monkeypatch.setattr(floor, "_COMMAND_WORD_NOISE", re.compile(r"(?!)"))
    assert destruction_of("</dev/null cd /; rm -rf *", "/tmp/w/proj") is None


# Pass 5q (lens W3, review p22-lens-W3, proven in bash): a glob command word that can match a folder word runs it.
@pytest.mark.parametrize("command", ["[c]d /; rm -rf *", "?d /; rm -rf *", "c[d] / && rm -rf *", "*d ~; rm -rf *",
                                     "time [c]d /; rm -rf *", "[p]ushd /; rm -rf *"])
def test_lens_w3_a_glob_that_can_be_a_folder_word_leaves_the_folder_unknown(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


def test_an_ordinary_glob_argument_keeps_the_folder():
    assert destruction_of("ls *.txt; rm -rf build", "/tmp/w/proj") is None


def test_mutant_without_the_glob_rule_misses_lens_w3(monkeypatch):
    monkeypatch.setattr(floor, "_GLOB_IN_WORD", re.compile(r"(?!)"))
    assert destruction_of("[c]d /; rm -rf *", "/tmp/w/proj") is None


# Pass 5q (lens X3, review p22-lens-X3): a . with a redirection before it is source; prefixed spellings stay unresolved.
@pytest.mark.parametrize("command", [">/dev/null . ./x; rm -rf *", "! alias ls='cd /'\nls && rm -rf *",
                                     "time alias ls='cd /'\nls && rm -rf *", "if alias ls='cd /'; then ls; fi; rm -rf *",
                                     "while $'cd' /; do break; done; rm -rf *", ">/dev/null $'cd' /; rm -rf *",
                                     "2>/dev/null c''d /; rm -rf *"])
def test_lens_x3_prefixed_spellings_are_unresolved(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["find . -name '*.pyc' -delete", "git add . && rm -rf build", "cp x . && rm -rf dist"])
def test_a_dot_argument_is_not_source(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


# Pass 5r (lens X4, review p23-lens-X4): letterless globs behind a prefix, and . -- FILE, are folder changes.
@pytest.mark.parametrize("command", ["time ?? /; rm -rf *", "X=1 ?? /; rm -rf *", ">/dev/null * /; rm -rf *",
                                     ">/dev/null . -- ./x; rm -rf *"])
def test_lens_x4_spellings_leave_the_folder_unknown(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


# Pass 5r (lens W4, review p23-lens-W4, proven in bash): a wrapper or launcher option with a value the floor does not know
# no longer hides the delete program after it; quoted code handed to a launcher is read as code.
LENS_W4 = ["caffeinate -t 60 rm -rf ~", "caffeinate -w 1 rm -rf /", "exec -a x rm -rf /", "env -P /bin rm -rf /Users",
           "timeout --signal KILL 5 rm -rf ~", "timeout --kill-after 1 5 rm -rf ~", "csh -c 'rm -rf ~'",
           "taskpolicy -b rm -rf ~", "xcrun rm -rf ~", "lockf -k f rm -rf ~", "apply 'rm -rf %1' ~", "coproc rm -rf /"]


@pytest.mark.parametrize("command", LENS_W4)
def test_lens_w4_a_launched_delete_is_read(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["echo rm -rf ~", "timeout 5 make && rm -rf build", "caffeinate -i make",
                                     "nice -n 5 rm -rf build"])
def test_ordinary_wrapped_work_stays_allowed(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


def test_mutant_without_the_launched_scan_misses_lens_w4(monkeypatch):
    monkeypatch.setattr(floor, "_launched_hit", lambda words, cwd: None)
    assert destruction_of("caffeinate -t 60 rm -rf ~", "/tmp/w/proj") is None


# Pass 5s (lens W5a, proven): Homebrew g-prefixed wrappers, env -S code, launchers that run the command they are given.
@pytest.mark.parametrize("command", [
    "genv rm -rf /", "gnice -n 19 /bin/rm -rf /Users", "gnohup gfind / -delete", "gstdbuf -oL rm -rf ~",
    "gchroot / rm -rf /", "genv -i grm -rf ~", "gtimeout 5 grm -rf ~",
    "env -C / -S 'rm -rf *'", "env -S'rm -rf ~'", "env -S'find / -delete'", "env -u X -S 'rm -rf ~'",
    "env -iS'rm -rf ~'", "genv --split-string='rm -rf /'",
    "/usr/bin/leaks --atExit -- /bin/rm -rf ~", "xctrace record --launch -- rm -rf /", "dtruss rm -rf /",
    "hyperfine 'rm -rf /'", "gdb --args rm -rf ~", "valgrind rm -rf ~", "torsocks rm -rf ~", "proxychains4 rm -rf /",
    "fakeroot rm -rf ~", "login -f root rm -rf /"])
def test_lens_w5a_a_wrapped_or_launched_delete_is_read(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["env", "sudo", "env FOO=1 npm test", "genv FOO=1 ls", "env -S 'echo hi'",
                                     "gnice -n 5 rm -rf build", "env -S'rm -rf build'", "gdb ./a.out",
                                     "hyperfine 'sleep 1'", "valgrind ./a.out"])
def test_ordinary_wrapped_work_stays_allowed_5s(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


def test_mutant_without_g_names_misses_lens_w5a(monkeypatch):
    monkeypatch.setattr(floor, "_plain_name", lambda name: name)
    assert destruction_of("gnice -n 19 /bin/rm -rf /Users", "/tmp/w/proj") is None


def test_mutant_skipping_a_wrapper_with_no_program_misses_env_split(monkeypatch):
    original = floor._program

    def skipping(words):
        prog, args, fed = original(words)
        return ("", [], fed) if prog in floor._WRAPPERS and not args else (prog, args, fed)

    monkeypatch.setattr(floor, "_program", skipping)
    assert destruction_of("env -S'rm -rf ~'", "/tmp/w/proj") is None


def test_mutant_without_the_new_launchers_misses_leaks(monkeypatch):
    monkeypatch.setattr(floor, "_LAUNCHERS", floor._LAUNCHERS - {"leaks"})
    assert destruction_of("/usr/bin/leaks --atExit -- /bin/rm -rf ~", "/tmp/w/proj") is None


# Pass 5t (gates, fail closed): the literal text $HOME as a delete target is read as the home; a literal ~ is not.
@pytest.mark.parametrize("command", ["rm -rf '$HOME'", "rm -rf '${HOME}'", "rm -rf '$HOME/'", "rm -rf ./'$HOME'",
                                     'rm -rf \\$HOME', "cd /tmp && rm -rf '$HOME'"])
def test_p5t_the_literal_home_name_is_the_home(command):
    assert destruction_of(command, "/tmp/w/proj") == TOTAL, command


@pytest.mark.parametrize("command", ["rm -rf '~'", "rm -rf '$HOME/tmp'", "rm -rf './~'", "rm -rf '$HOMEDIR'"])
def test_p5t_other_literals_stay_ordinary(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


def test_p5t_mutant_without_the_literal_rule_allows_quoted_home(monkeypatch):
    monkeypatch.setattr(floor, "_LITERAL_HOME_NAME", re.compile(r"(?!)"))
    assert destruction_of("rm -rf '$HOME'", "/tmp/w/proj") is None


# Pass 5u (panel 5 critic B, proven): a last name made only of glob tokens with a * lists every name, like *.
@pytest.mark.parametrize("command", ["rm -rf ~/?*", "rm -rf ~/*?", "rm -rf ~/??*", 'rm -rf "$HOME"/?*', "rm -rf /usr/?*",
                                     "rm -rf /Library/?*", "rm -rf /Applications/?*", "rm -rf ~/.?*", "rm -rf ~/[a-z]*"])
def test_p5u_a_glob_of_every_name_is_the_folder(command):
    assert destruction_of(command, "/tmp/w/proj") == TOTAL, command


@pytest.mark.parametrize("command", ["rm -rf build/?*", "rm -rf *.o", "rm -rf ~/a*", "rm -rf ~/??", "rm -rf ./?*",
                                     "rm -rf dist/*"])
def test_p5u_globs_with_a_letter_or_no_star_stay_ordinary(command, monkeypatch):
    monkeypatch.setenv("HOME", "/Users/someone")
    assert destruction_of(command, "/tmp/w/proj") is None, command


def test_p5u_mutant_without_the_all_names_rule_allows_question_star(monkeypatch):
    monkeypatch.setattr(floor, "_ALL_NAMES", re.compile(r"(?!)"))
    assert destruction_of("rm -rf ~/?*", "/tmp/w/proj") is None


# Pass 5u (lens W6, proven): an extglob pattern on a delete line is a glob the floor does not read.
@pytest.mark.parametrize("command", ["bash -O extglob -c 'rm -rf ~/@(*)'", "bash -O extglob -c 'rm -rf /@(*)'",
                                     "shopt -s extglob\nrm -rf ~/@(*)", "rm -rf ~/!(x)", "rm -rf ~/+(?)", "rm -rf ~/?(*)",
                                     "find ~/@(*) -delete", "cd ~ && rm -rf @(*)", "rm -rf /usr/*(*)",
                                     "bash -O extglob -c 'RM -rf ~/@(*)'", "Rm -rf ~/@(*)", "FIND ~/@(*) -delete"])
def test_p5u_an_extglob_delete_is_unresolved(command):
    from tools.approval_detection import detect_floor_command  # the path the runtime takes: it reads bash -c code too

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["rm -rf build", "echo '@(x)'", "ls ~/@(a|b)", "rm -rf dist/*.o",
                                     "git log | grep -E '(fix)+(ui)'", "git commit -m \"Done!(ok)\"", "rm -rf build; echo \"!(x)\""])
def test_p5u_extglob_without_a_delete_or_a_delete_without_extglob_stays_ordinary(command):
    assert destruction_of(command, "/tmp/w/proj") is None, command


def test_p5u_mutant_without_the_extglob_rule_allows_at_star(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_EXTGLOB", re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_EXTGLOB_PATTERN", re.compile(r"(?!)"))
    assert not detect_floor_command("bash -O extglob -c 'rm -rf ~/@(*)'")[0]


@pytest.mark.parametrize("command", ["rm -rf ~/[!.]*", "rm -rf build/[!.]*", "rm -rf build/[^.]*", "find build/[!.]* -delete"])
def test_p5u_a_negated_set_stays_unread(command):
    assert destruction_of(command, "/tmp/w/proj") in (UNRESOLVED_DELETE, TOTAL), command


@pytest.mark.parametrize("command", ["rm -rf '$HOME'/*", "rm -rf '$HOME'/?*", "rm -rf '$HOME/.'",
                                     "rm -rf '$HOME'/[a-z]*", "rm -rf '${HOME}'/[ab]*", "rm -rf '$HOME'/[a-z]?"])
def test_p5u_the_literal_home_name_with_only_globs_after_it_is_the_home(command):
    assert destruction_of(command, "/tmp/w/proj") == TOTAL, command


def test_p5u_question_star_run_in_a_home_is_the_home(monkeypatch):
    monkeypatch.setenv("HOME", "/Users/someone")
    assert destruction_of("rm -rf ?*", "/Users/someone") == TOTAL


# Pass 5w (lens W7, proven): a quoted program name with extglob, a set that starts with ], a globbed program name.
@pytest.mark.parametrize("command", ["bash -O extglob -c 'r\"m\" -rf ~/@(*)'", "bash -O extglob -c 'r${NOPE}m -rf ~/@(*)'",
                                     "bash -O extglob -c 'r\"m\" -rf /@(*)'", "rm -rf ~/[]A-Za-z]*", "find ~/[]A-Za-z]* -delete",
                                     "cd ~ && rm -rf []A-Za-z]*", "/bin/r[m] -rf ~/*", "/bin/r? -rf ~/*"])
def test_p5w_lens_w7_spellings_are_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


def test_p5w_mutant_reading_extglob_only_by_raw_delete_words_misses_quoted_rm(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category", lambda text: False)  # P5y2: the category layer off too
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_EXTGLOB", re.compile(r"(?!)"))  # P5x: no pattern and no leftover opener is replaced
    assert not detect_floor_command("bash -O extglob -c 'r\"m\" -rf ~/@(*)'")[0]


def test_p5w_mutant_without_globbed_program_rule_allows_r_bracket_m(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category", lambda text: False)  # P5y2: the category layer off too
    monkeypatch.setattr(floor, "_UNREAD_PROGRAM", re.compile(r"^[$`]|\x01"))
    assert destruction_of("/bin/r[m] -rf ~/*", "/tmp/w/proj") is None


# Pass 5x (lens X8, proven): an extglob pattern lives inside one word. At 5w the pattern ran from an opener in one
# quoted string to a ) in a later one and swallowed the delete between them.
P5X_SPANNING = ["echo '?(' && rm -rf ~ && echo ')'", "printf '%s\\n' '*(' ; rm -rf / ; printf ')'",
                "echo ?( ; rm -rf /", "echo '*(' ; $'\\x72m' -rf ~", "echo '@(' ; RM -rf ~/* ; echo ')'",
                "echo \"+(\" && rm -rf / && echo \")\""]


@pytest.mark.parametrize("command", P5X_SPANNING)
def test_p5x_an_extglob_opener_in_a_string_never_hides_a_delete(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


def test_p5x_mutant_with_the_5w_spanning_pattern_hides_the_delete(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_EXTGLOB_PATTERN", re.compile(r"[@!+?*]\((?:[^()]|\([^()]*\))*\)"))
    assert not detect_floor_command("printf '%s\\n' '*(' ; rm -rf / ; printf ')'")[0]


@pytest.mark.parametrize("command", ["ls @(a|b)", "grep -E 'a?(b)' f", "echo \"?(x\" > f", "[ -r / ]", "[[ -d / ]]",
                                     "[ -r \"$HOME\" ]", "test -d / && echo ok"])
def test_p5x_lines_without_a_delete_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


def test_p5x_mutant_without_the_test_command_exception_refuses_a_test(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_TEST_PROGRAMS", frozenset())
    assert detect_floor_command("[ -r / ]")[0]


@pytest.mark.parametrize("command", ["rm -rf '$HOME'/[]a-z]*", "rm -rf '${HOME}'/[]a]", "rm -rf '$HOME'/[!.]*",
                                     "rm -rf '$HOME'/[[:alpha:]]*", "rm -rf '$HOME'/[![:upper:]]?"])
def test_p5x_the_literal_home_name_with_any_bracket_set_is_the_home(command):
    assert destruction_of(command, "/tmp/w/proj") == TOTAL, command


def test_p5x_mutant_with_the_5w_literal_home_rule_misses_a_close_bracket_set(monkeypatch):
    monkeypatch.setattr(floor, "_LITERAL_HOME_NAME",
                        re.compile(r"(?:\./)?\$(?:HOME|\{HOME\})(?:/(?:[.*?]|\[[^/\]]*\]?)*)*/*\Z"))
    assert destruction_of("rm -rf '$HOME'/[]a-z]*", "/tmp/w/proj") != TOTAL


@pytest.mark.parametrize("command", ["rm -rf '$HOME'/[[:alpha:]]*", "rm -rf '$HOME'/[]a-z]*"])
def test_p5x_the_literal_home_with_a_set_is_refused_with_no_cwd(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command  # tools/approval.py calls the floor with no cwd in Ignore


def test_p5x_an_unclosed_opener_on_a_delete_line_is_unresolved():
    assert destruction_of("echo ?( ; rm -rf build", "/tmp/w/proj") == UNRESOLVED_DELETE


def test_p5x_mutant_without_the_delete_word_fallback_allows_an_unclosed_opener(monkeypatch):
    monkeypatch.setattr(floor, "_DELETE_WORD", re.compile(r"(?!)"))
    assert destruction_of("echo ?( ; rm -rf build", "/tmp/w/proj") is None


def test_p5x_mutant_without_classes_in_the_literal_home_misses_alpha(monkeypatch):
    monkeypatch.setattr(floor, "_LITERAL_HOME_NAME",
                        re.compile(r"(?:\./)?\$(?:HOME|\{HOME\})(?:/(?:[.*?]|\[[!^]?\]?[^/\]]*\]?)*)*/*\Z"))
    assert destruction_of("rm -rf '$HOME'/[[:alpha:]]*", "/tmp/w/proj") != TOTAL


# Pass 5x3 (lens W10, proven): bash expands braces before ~ and $NAME, and a pattern body never holds a $( ).
P5X3_BRACE_HOME = ["{rm,-rf,~}", "rm {-rf,~}", "$({rm,-rf,~})", "echo $({rm,-rf,$HOME})", "rm {-rf,$HOME}",
                   "x=$({rm,-rf,~})", "for i in 1; do {rm,-rf,~}; done"]


@pytest.mark.parametrize("command", P5X3_BRACE_HOME + ["echo @(x|$({rm,-rf,/}))"])
def test_p5x3_lens_w10_lines_are_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["echo {a,~}", "cp {a,b}.txt ~/x", "rm -rf build/{a,b}", "mkdir -p ~/{a,b}",
                                     "ls @(a|b)"])
def test_p5x3_braces_without_a_delete_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


def test_p5x3_mutant_without_the_brace_rule_allows_rm_brace_home(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_BRACE_WORD", re.compile(r"(?!)"))  # 5y: the category rule holds it
    assert not detect_floor_command("rm {-rf,~}")[0]


def test_p5x3_mutant_with_a_dollar_in_the_pattern_body_hides_a_root_delete(monkeypatch):
    from tools.approval_detection import detect_floor_command

    body = r"[^()\s'\";&<>`]"
    monkeypatch.setattr(floor, "_EXTGLOB_PATTERN", re.compile(r"[@!+?*]\((?:" + body + r"|\(" + body + r"*\))*\)"))
    monkeypatch.setattr(floor, "_BRACE_SPLIT", re.compile(r"(?!)"))  # the second layer: brace commas split the delete word
    assert destruction_of("echo @(x|$({rm,-rf,/}))", None) is None  # the reading as written (the variants split at ( and |)
    assert detect_floor_command("echo @(x|$({rm,-rf,/}))")[0]  # the variants alone still refuse it: a third layer


# Pass 5y (lens W11, method change): what the floor does not read is refused by category. Every line W11 proved.
P5Y_W11 = [
    '{rm,-rf,{/Users,x}}',
    '{rm,-rf,/Users/{someone,x}}',
    '{rm,-rf,{/*,x}}',
    '{{rm,-rf},/}',
    '{rm,-r{f,},/}',
    '{rm,{-rf,/}}',
    '{rm,-rf,{/,x}}',
    '{rm,-rf,/{,}}',
    "bash -c '{rm,-rf,{/,x}}'",
    "env -S '{rm,-rf,{/,x}}'",
    'sudo/time/nohup/command/exec/coproc {rm,-rf,{/,x}}',
    '$({rm,-rf,{/,x}})',
    "eval '{rm,-rf,{/,x}}'",
    '( {rm,-rf,{/,x}} )',
    'echo ok; {rm,-rf,{/,x}}',
    'echo x | xargs {rm,-rf,{/,x}}',
    'echo / | xargs {{rm,-rf},-v}',
    'find . -exec {rm,-rf,{/,x}} \\;',
    'find / -exec {{rm,-rf},{}} +',
    "echo '{rm,-rf,{/,x}}' | at now",
    'at now <<< {rm,-rf,{/,x}}',
    '{find,{/,x},-delete}',
    '{git,clean,-fdx,{/,x}}',
    'git {clean,-fdx,{/,x}}',
    '{rsync,-a,--delete,x/,{/,y}}',
    'rm {-rf,{/Users,x}}',
    'rm {-rf,/{U..U}sers}',
    'rm {-rf,{/Users/*,x}}',
    'rm {{-rf,x},/}',
    'rm {-r{f,},/}',
    'rm {-rf,{/,x}}',
    '{{rm,-rf},~}',
    '{{rm,-rf},$HOME}',
    '{{rm,-rf},~/}',
    '{{rm,-r},-f,~}',
    'rm {{-rf,x},~}',
    '{rm,-rf,~{,}}',
    '{rm,-rf,~/{,}}',
    'rm {-rf,~{,}}',
    '{rm,-rf,~{a..a}}',
    "{$'\\x72m',-rf,/}",
    "{$'\\x72m',-rf,{/,x}}",
    '{${x-rm},-rf,/Users}',
    '{${x-rm},-rf,/}',
    '{$x,-rf,/Users}',
    '{$x,-rf,~}',
    '{$1,-rf,~}',
    "env -S '{$'\\''\\x72m'\\'',-rf,~}'",
    'IFS=,; x=rm,-rf,/Users; $x',
    'x=rm,-rf,/Users; IFS=,; $x',
    'export IFS=,; x=rm,-rf,/Users; $x',
    "IFS=, eval 'x=rm,-rf,/Users; $x'",
    'IFS=,; x=rm,-rf,~; $x',
    'IFS=/; x=rm/-rf; $x ~',
    'IFS=,; x=rm,-rf; $x /Users',
    'IFS=,; ${x:-rm,-rf,/Users}',
    'set -- -rf ~; rm "$@"',
    'set -- rm -rf /; "$@"',
]


@pytest.mark.parametrize("command", P5Y_W11)
def test_p5y_lens_w11_lines_are_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["echo {a,b}", "cp {a,b}.txt /tmp/x", "rm -rf build/{a,b}", "mkdir -p ~/{a,b}",
                                     "git commit -m 'fix {a,b} in rm'", "ls -la {src,test}/", "echo \"{x,y}\"",
                                     "find . -name '*.{js,ts}' -print", "echo $1", "for f in *.py; do echo $f; done"])
def test_p5y_ordinary_lines_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["rm -rf build && mkdir -p {dist,$OUT}", "IFS=, read a b <<< x; echo $a"])
def test_p5y_the_stated_over_refusal_of_the_whole_line(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("attr, command", [
    ("_BRACE_WORD", "{rm,-rf,{/Users,x}}"), ("_BRACE_WORD", "rm {-rf,{/Users,x}}"),
    ("_IFS_SET", "IFS=,; x=rm,-rf,~; $x"), ("_POSITIONAL", "set -- -rf ~; rm \"$@\"")])
def test_p5y_mutant_without_each_category_allows_its_line(monkeypatch, attr, command):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, attr, re.compile(r"(?!)"))
    assert not detect_floor_command(command)[0], (attr, command)


def test_p5y_mutant_without_the_quote_stripped_reading_allows_env_s(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category_more", lambda text: False)  # P5y5: the worst-case layer off too
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_unread_by_category", lambda text: floor._unread_by_category_once(text))
    assert not detect_floor_command("env -S '{rm,-rf,{/,x}}'")[0]


# Pass 5y2 (W13 differential fuzzer, bash itself as the oracle): every line it proved, kept as a test.
P5Y2_W13 = ["rm $'-rf' /", "exec r{m,} $'-rf' /./", "X=; nohup r''m $'-rf' /", "${V-rm} $'-rf' ./build/* ${HOME%/}",
            "`echo rm` -rf -- ~", "env -S 'r\"m\" --recursive /?*'", "env -S '`echo rm` {-rf,} /Library proj_tmp'",
            "env -S 'r\"m\" -r -f ~/.'", "true; env -S '${V:-rm} -{r,}f /./ /Library' || true", "echo $(rm '-r'f ~)",
            "X=; x=$(${V:-rm} $'-rf' /System); echo $x", "$'\\x72m' -rf /"]


@pytest.mark.parametrize("command", P5Y2_W13)
def test_p5y2_w13_fuzzer_lines_are_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["echo $'a\\tb'", "printf $'%s\\n' x", "rm $'-f' build", "echo $(ls)",
                                     "rm -rf build && echo $(date)", "\"$PY\" -m build && rm -rf build",
                                     "git commit -m 'rm -rf old'", "[ -r / ]"])
def test_p5y2_ordinary_lines_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


@pytest.mark.parametrize("attr, command", [("_ANSI_C_WORD", "rm $'-rf' /"), ("_SUBST_SPAN", "echo $(rm '-r'f ~)")])
def test_p5y2_mutant_without_each_rule_allows_its_line(monkeypatch, attr, command):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_unread_by_category_more", lambda text: False)  # P5y4: the worst-case layer off too

    monkeypatch.setattr(floor, attr, re.compile(r"(?!)"))
    assert not detect_floor_command(command)[0], (attr, command)


def test_p5y2_mutant_without_the_unread_program_rule_allows_a_variable_program(monkeypatch):
    monkeypatch.setattr(floor, "_unread_by_category_more", lambda text: False)  # P5y5: the worst-case layer off too
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_unread_recursive_command", lambda text: False)
    assert not detect_floor_command("env -S 'r\"m\" -r -f ~/.'")[0]


# Pass 5y3 (oracle rows pinned not_floor): a substitution inside single quotes is text, bash runs nothing.
@pytest.mark.parametrize("command", ["cat '$(rm -rf /)'", "echo '`rm -rf ~`'"])
def test_p5y3_a_single_quoted_substitution_stays_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


def test_p5y3_mutant_reading_single_quoted_substitutions_refuses_text(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_in_single_quotes", lambda text, pos: False)
    assert detect_floor_command("cat '$(rm -rf /)'")[0]


# Pass 5y4 (lens X10, proven): a redirection before the command; an unread word standing as the flag or target.
P5Y4_X10 = ["2>/dev/null rm -rf ~", ">/dev/null rm -rf ~", "2>/dev/null rm -rf /Users", "2>/dev/null ${V-rm} -rf ~",
            ">x `echo rm` -rf ~", "set -- -rf; rm ${!#} /Users", "f=-rf; n=f; rm ${!n} ~", "rm $(echo -rf) ~",
            "rm ${F} ~", "rm $F /", "for IFS in ,; do x=rm,-rf,~; $x; done"]


@pytest.mark.parametrize("command", P5Y4_X10)
def test_p5y4_lens_x10_lines_are_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["rm -f \"$TMPFILE\"", "rm $X", "2>/dev/null rm -rf build", "rm $(cat list)",
                                     ">out.txt echo hi", "cp $A $B", "ls $DIR"])
def test_p5y4_ordinary_lines_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


@pytest.mark.parametrize("attr, command", [("_LEADING_REDIRECT", "2>/dev/null rm -rf ~"),
                                           ("_UNREAD_WORD", "rm $(echo -rf) ~")])
def test_p5y4_mutant_without_each_rule_allows_its_line(monkeypatch, attr, command):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, attr, re.compile(r"(?!)"))
    assert not detect_floor_command(command)[0], (attr, command)


def test_p5y2_a_flag_written_only_with_braces_or_quotes_is_refused_as_stated():
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command("rm -{r,}f build")[0]  # stated over-refusal: the flag is only seen once built


# Pass 5y5 (W13 with the X10 families: unread flags, leading redirections): every line it proved at 5y4.
P5Y5_W13 = [
    "echo ')' ; ! {rm,} $(printf %s -rf) ~/[[:alpha:]]* && echo ')'",
    "echo ')' ; true && 'rm' $(printf %s -rf) ~/[[:alpha:]]*",
    "echo '{a,b}' ; { ${V-rm} $(printf %s -rf) ~/[[:alpha:]]*; }\necho ok",
    "echo '?(' && false || ${V-rm} $(printf %s -rf) $'\\x2f'",
    'echo \'{a,b}\' ; ! "$(printf rm)" $(echo -rf) ~/[[:alpha:]]* && echo \')\'',
    "2>/dev/null nice -n 5 r''m $(echo -rf) ./build/* ~/[[:alpha:]]*\necho ok",
    'x=$(${V-rm} $(printf %s -rf) ~/ ..); echo $x',
    "echo ')' ; builtin r''m $(printf %s -rf) ~/[[:alpha:]]* 2>/dev/null",
    'X=; echo $(${V-rm} $(printf %s -rf) ~/[[:alpha:]]*) ; echo done',
    "echo '?(' && echo $(${V-rm} $(echo -rf) /*)",
    "cd . && command 'rm' $(echo -rf) ~/[[:alpha:]]* # )",
    "echo '{a,b}' ; ( 'rm' $(printf %s -rf) ~/[[:alpha:]]* node_modules )",
    'shopt -s extglob\nenv "$(printf rm)" $(echo -rf) ~/[[:alpha:]]*',
    '# c\ntrue && \\rm $(echo -rf) ~/[[:alpha:]]*',
    "# c\nenv -S '`echo rm` $(echo -rf) /usr/' && echo ')'",
    "true; env -S '${V:-rm} $(printf %s -rf) ${X:-/}' 2>/dev/null",
    'F=-rf; n=F; 2>/dev/null eval \'r\'"\'"\'\'"\'"\'m $(printf %s -rf) /*\'',
    'X=; env -S \'r\'"\'"\'\'"\'"\'m $(printf %s -rf) ~\' ; echo done',
    'F=-rf; n=F; env -S \'$\'"\'"\'\\x72m\'"\'"\' $(printf %s -rf) ~/?*\'\necho ok',
    'set -- a; env -S \'$\'"\'"\'\\x72m\'"\'"\' $(echo -rf) ~/.\'\necho ok',
    'F=-rf; n=F; 2>/dev/null env -S \'$\'"\'"\'\\x72m\'"\'"\' ${!n} /Applications build\' || true',
    'shopt -s extglob\neval "rm $(printf %s -rf) ~/@(*)" || true',
    '</dev/null env -S \'$\'"\'"\'\\x72m\'"\'"\' $(printf %s -rf) ${HOME:-/}\'\necho ok',
    'echo \'?(\' && env -S \'$\'"\'"\'\\x72m\'"\'"\' $(printf %s -rf) ~ /Use{r,}s\' && echo \')\'',
]


@pytest.mark.parametrize("command", P5Y5_W13)
def test_p5y5_w13_lines_are_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


def test_p5y5_mutant_without_the_reread_of_quoted_code_allows_env_s(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_REREAD", re.compile(r"(?!)"))
    assert not detect_floor_command("env -S '$'\"'\"'\\x72m'\"'\"' $(echo -rf) ~/.'")[0]


@pytest.mark.parametrize("command", ["\"$PY\" -m build && rm -rf build", "git commit -m \"Done!(ok)\"",
                                     "eval \"echo hi\"", "bash -c 'npm test'", "env -S 'node app.js'"])
def test_p5y5_ordinary_lines_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["rm -rf ~/\"$X\"/build", "rm -rf \"${HOME:+/tmp/x}\"", "D=build; rm -rf \"$HOME/$D\""])
def test_p5y5_oracle_rows_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


def test_p5y6_a_flag_set_on_the_line_is_read_inside_env_s():
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command("F=-rf; n=F; 2>/dev/null env -S 'r'\"'\"''\"'\"'m ${F} /*'\necho ok")[0]


# Pass 5y7 (lens X11): a name set once to written text; set twice or by read/for it stays unknown; globbed programs.
@pytest.mark.parametrize("command", ["F=x; [ -n y ] && F=-rf; rm $F ~", "F=x; F=-rf; rm $F ~", "read F; rm $F ~",
                                     "/bin/r[m] $X /"])
def test_p5y7_a_name_with_more_than_one_value_or_a_globbed_program_is_the_worst_case(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["F=x; rm $F ~", "F=-f; rm $F build", "D=build; rm -rf \"$HOME/$D\""])
def test_p5y7_a_name_set_once_to_written_text_is_that_text(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


@pytest.mark.parametrize("attr, command", [("_IFS_SET", "for IFS in ,; do x=rm,-rf,~; $x; done")])
def test_p5y7_mutant_without_each_spelling_allows_its_line(monkeypatch, attr, command):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, attr, re.compile(r"(?!)"))
    monkeypatch.setattr(floor, "_unread_by_category_more", lambda text: False)
    assert not detect_floor_command(command)[0], (attr, command)


# Pass 5y9 (panel 6 B, major): a name is known only when set once, as its own statement, before its first use.
P5Y9_INHERITED = ["rm $F /", "rm $F /; F=grep", "false && F=grep; rm $F /", "f(){ F=grep; }; rm ${F} ~",
                  "F=grep rm $F /", "( F=grep ); rm $F /", "export F=-rf; rm $F ~", "true || F=grep; rm $F ~"]


@pytest.mark.parametrize("command", P5Y9_INHERITED)
def test_p5y9_a_name_the_line_may_not_set_before_use_keeps_the_inherited_value(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


def test_p5y9_mutant_with_the_5y8_set_once_reading_allows_a_late_assignment(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_set_once", lambda n, context: (re.findall(rf"(?<![\w$]){n}=([^\s;&|$`()'\"]*)", context) or [None])[0])
    assert not detect_floor_command("rm $F /; F=grep")[0]


# Pass 5y8 relaxations (panel 6 B, medium): each loosened rule keeps its line ordinary, and its mutant refuses it.
@pytest.mark.parametrize("command", ["x=grep; $x -r a docs/", "gr'e'p -r 'a b' docs/", "env g$'\\x72'ep -r x docs/",
                                     "gi$'\\x74' log --grep=kill", "r\\m -rf build", "C=grep; ${C} -r x docs/"])
def test_p5y8_relaxed_lines_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["'rm' -rf ~", "r\\m -rf ~", "cd . && command 'rm' $(echo -rf) ~/[[:alpha:]]* # )"])
def test_p5y8_relaxations_keep_the_real_deletes_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


def test_p5y8_mutant_judging_categories_on_normaliser_variants_refuses_grep(monkeypatch):
    from tools.approval_detection import detect_floor_command

    real = floor.destruction_of
    monkeypatch.setattr(floor, "destruction_of", lambda text, cwd=None, categories=True: real(text, cwd, True))
    import tools.approval_detection as det
    monkeypatch.setattr(det, "destruction_of", floor.destruction_of, raising=False)
    assert detect_floor_command("env g$'\\x72'ep -r x docs/")[0]


def test_p5y8_mutant_counting_long_options_as_recursive_refuses_git_log(monkeypatch):
    from tools.approval_detection import detect_floor_command

    monkeypatch.setattr(floor, "_RECURSIVE_HINT", re.compile(r"(?<![\w])-[A-Za-z]*[rR]|--recursive|-delete|--delete"))
    assert detect_floor_command("gi$'\\x74' log --grep=kill")[0]


@pytest.mark.parametrize("command", ["if false; then F=grep; fi; rm $F /", "echo \"F=grep;\" ; rm $F /"])
def test_p5y9_more_inherited_shapes_are_refused(command):
    from tools.approval_detection import detect_floor_command

    assert detect_floor_command(command)[0], command


@pytest.mark.parametrize("command", ["sh -c 'x=Grep;\t${x} -r TODO src/'", "gr'e'p -r x ."])
def test_p5y9_a_name_set_first_in_a_c_string_and_a_plain_quoted_program_stay_ordinary(command):
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command(command)[0], command


def test_p5y8_mutant_reading_quoted_plain_programs_as_unread_refuses_grep(monkeypatch):
    from tools.approval_detection import detect_floor_command

    real = floor._unread_recursive_command
    monkeypatch.setattr(floor, "_unread_recursive_command",
                        lambda text: real(text) or bool(re.search(r"\w'[^']*'\w.*\s-r\b", text)))
    assert detect_floor_command("gr'e'p -r x .")[0]


def test_p5y9c_a_clustered_c_string_reads_its_first_assignment():
    from tools.approval_detection import detect_floor_command

    assert not detect_floor_command("bash -lc \"cmd=grep; \t ${cmd} -r TODO src/\"")[0]
    assert detect_floor_command("bash -lc 'F=-rf; rm $F ~'")[0]
