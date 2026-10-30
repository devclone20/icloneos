"""V3-RT (from V3-RT-B r2): PM's uv runs carry generous network timeouts and retries, and the user's own values win.
The real pinned uv is not run: a fake executable records the environment it is started with."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from pm.environment import UV_NETWORK_DEFAULTS, PythonEnvironment, _only_excluded_missing


def _fake_uv(tmp_path: Path) -> tuple[Path, Path]:
    record = tmp_path / "env.json"
    uv = tmp_path / "uv"
    uv.write_text(f"#!/usr/bin/env python3\nimport json, os\njson.dump(dict(os.environ), open({str(record)!r}, 'w'))\n")
    uv.chmod(uv.stat().st_mode | stat.S_IEXEC)
    return uv, record


def _run(tmp_path: Path, env: dict) -> dict:
    uv, record = _fake_uv(tmp_path)
    environment = PythonEnvironment(uv=uv, python=Path("/usr/bin/python3"), destination=tmp_path / "venv",
                                    cache=tmp_path / "cache", env=env)
    environment._run(["--version"], cwd=tmp_path, timeout=30)
    return json.loads(record.read_text())


def test_uv_gets_the_network_defaults(tmp_path):
    seen = _run(tmp_path, {"PATH": os.environ["PATH"]})
    assert {key: seen.get(key) for key in UV_NETWORK_DEFAULTS} == UV_NETWORK_DEFAULTS
    assert int(seen["UV_HTTP_TIMEOUT"]) >= 300 and int(seen["UV_HTTP_RETRIES"]) >= 10


def test_a_value_the_user_set_wins(tmp_path):
    seen = _run(tmp_path, {"PATH": os.environ["PATH"], "UV_HTTP_TIMEOUT": "900", "UV_HTTP_RETRIES": "20"})
    assert seen["UV_HTTP_TIMEOUT"] == "900" and seen["UV_HTTP_RETRIES"] == "20"
    assert seen["UV_HTTP_CONNECT_TIMEOUT"] == UV_NETWORK_DEFAULTS["UV_HTTP_CONNECT_TIMEOUT"]


def test_uv_sync_never_installs_an_excluded_telemetry_distribution(tmp_path):
    """Ruling 57.2: PM passes --no-install-package for every name PM ships in runtime-venv-exclusions.txt."""
    from pm.environment import VENV_EXCLUSIONS_FILE, venv_exclusions

    uv = tmp_path / "uv"
    record = tmp_path / "argv.json"
    uv.write_text(f"#!/usr/bin/env python3\nimport json, sys\njson.dump(sys.argv[1:], open({str(record)!r}, 'w'))\n")
    uv.chmod(uv.stat().st_mode | stat.S_IEXEC)
    environment = PythonEnvironment(uv=uv, python=Path("/usr/bin/python3"), destination=tmp_path / "venv",
                                    cache=tmp_path / "cache", env={"PATH": os.environ["PATH"]})
    environment.sync(tmp_path)
    argv = json.loads(record.read_text())
    names = venv_exclusions()
    # The names are exactly the list's (critic r2 m4: no literal here, so a new list cannot leave this test behind).
    listed = [line.strip() for line in VENV_EXCLUSIONS_FILE.read_text().splitlines()
              if line.strip() and not line.lstrip().startswith("#")]
    assert names == listed and names
    for name in names:
        assert argv[argv.index(name) - 1] == "--no-install-package"
    # The list PM ships is the one V3-FX's packaging gate checks (iclone/telemetry/, when this tree has it).
    fx = Path(__file__).resolve().parents[2] / "iclone" / "telemetry" / "runtime-venv-exclusions.txt"
    assert fx.is_file(), "V3-FX's exclusion list is missing: the list PM ships has nothing to be checked against"

    def names_of(path):
        return sorted(line.strip() for line in path.read_text().splitlines()
                      if line.strip() and not line.lstrip().startswith("#"))
    assert names_of(fx) == names_of(VENV_EXCLUSIONS_FILE)


HEAD = "Using Python 3.14.7 environment at: /x/venv\nChecked 120 packages in 9ms\n"
NEMO = ("The package `hermes-agent` requires `nemo-relay>=0.9,<0.10 ; python_full_version >= '3.14'`, but it's "
        "not installed")
PYYAML = "The package `hermes-agent` requires `pyyaml>=6`, but it's not installed"
UV_WARNING = ("warning: The `UV_NATIVE_TLS` environment variable is deprecated and will be removed in a future "
              "release. Use `UV_SYSTEM_CERTS` instead.")  # verbatim from uv 0.11


def report(*lines, head=HEAD):
    return head + f"Found {len(lines)} incompatibilit{'y' if len(lines) == 1 else 'ies'}\n" + "\n".join(lines)


def tolerated(text):
    ok, _reason = _only_excluded_missing(text)
    return ok


def test_the_check_tolerates_only_the_excluded_distributions():
    """Ruling 57.2, found live: uv pip check fails because hermes-agent requires nemo-relay, which PM excludes on
    purpose; that and only that is accepted. Ruling 58 (critic r2 M1): every other line of the report is a problem,
    even next to the tolerated one."""
    from pm.environment import venv_exclusions

    head, nemo = HEAD, NEMO
    glued = "The package `hermes-agent` requires `nemo-relay+x>=1`, but it's not installed"
    another = next(name for name in venv_exclusions() if name != "nemo-relay")

    assert tolerated(report(nemo))
    assert tolerated(UV_WARNING + "\n" + report(nemo, nemo.replace("nemo-relay", another)))
    # Any other warning, and a tolerated line repeated to make the count match, are not understood: refused.
    assert not tolerated("warning: something about TLS\n" + report(nemo))
    assert not tolerated(report(nemo, nemo))
    assert not tolerated(report(glued))
    # A problem glued onto uv's own frame line (backticks never appear in it) is not hidden there.
    assert not tolerated(report(nemo).replace("environment at: /x/venv", "environment at: /x/venv " + glued))
    assert not tolerated(report(nemo).replace("Checked 120 packages in 9ms", "Checked 120 packages in 9ms; x"))
    for other in [
        PYYAML,
        # The excluded distribution IS installed (a wrong version): telemetry present, never tolerated.
        "The package `hermes-agent` requires `nemo-relay>=2`, but `0.1` is installed",
        "The package `x` requires Python >=3.15, but `3.14.7` is installed",
        "The environment has multiple installed distributions of `requests`",
        "error: something else went wrong",
    ]:
        assert not tolerated(report(nemo, other)), other
    # A count that does not match the lines read means part of the report was not understood.
    assert not tolerated(head + "Found 2 incompatibilities\n" + nemo)
    assert not tolerated(head + nemo)
    # A denylisted name that is not on the shipped list is not tolerated (the list is the contract).
    assert "posthog" not in venv_exclusions()
    assert not tolerated(report(nemo.replace("nemo-relay", "posthog")))


def _coloured(*problems):
    """A report as uv 0.11 prints it under FORCE_COLOR / CLICOLOR_FORCE with its output piped (captured live)."""
    lines = ["\x1b[1m\x1b[33mwarning\x1b[39m\x1b[0m\x1b[1m:\x1b[0m \x1b[1m" + UV_WARNING[len("warning: "):] + "\x1b[0m",
             "\x1b[2mUsing Python 3.14.7 environment at: /x/venv\x1b[0m",
             "\x1b[2mChecked \x1b[1m120 packages\x1b[0m \x1b[2min 9ms\x1b[0m\x1b[0m",
             f"\x1b[1mFound {len(problems)} incompatibilit{'y' if len(problems) == 1 else 'ies'}\x1b[0m",
             *(f"\x1b[1m{problem}\x1b[0m" for problem in problems)]
    return "\n".join(lines) + "\n"


def test_the_check_reads_a_coloured_report():
    """uv honours FORCE_COLOR / CLICOLOR_FORCE even when piped: the one legitimate report (hermes-agent requires
    nemo-relay) wrapped in SGR escapes is still read and tolerated, so a coloured shell or CI can install."""
    assert "\x1b[" in _coloured(NEMO), "the fixture is not coloured"
    ok, reason = _only_excluded_missing(_coloured(NEMO))
    assert ok, f"the coloured legitimate report was refused: {reason}"
    # Only SGR (colour) sequences are dropped; any other control sequence is a line not understood.
    ok, reason = _only_excluded_missing(_coloured(NEMO).replace("\x1b[2mUsing", "\x1b[2K\x1b[2mUsing"))
    assert not ok, "a non-colour control sequence was read past"


def test_a_coloured_report_with_a_real_problem_is_refused():
    """Colour never hides a problem: the same coloured report naming a non-excluded missing requirement is refused,
    and the refusal names that line, uncoloured."""
    ok, reason = _only_excluded_missing(_coloured(NEMO, PYYAML))
    assert not ok, "a coloured report with a real problem was tolerated"
    assert PYYAML in reason, f"the refusal does not name the problem line: {reason!r}"
    assert "\x1b" not in reason, f"the refusal keeps the colour escapes: {reason!r}"


def test_a_requirement_from_an_excluded_distribution_is_refused():
    """A tolerated-looking line whose requirer is itself excluded proves telemetry IS installed: refused."""
    from pm.environment import venv_exclusions

    assert "langfuse" in venv_exclusions()
    for requirer in ("langfuse", "Langfuse", "nemo_relay"):
        line = f"The package `{requirer}` requires `nemo-relay>=1`, but it's not installed"
        ok, reason = _only_excluded_missing(report(NEMO, line))
        assert not ok, f"an excluded distribution ({requirer}) is installed and the report was tolerated"
        assert "an excluded distribution is installed" in reason and line in reason, reason


def _checking_uv(tmp_path: Path, stderr: str, **kwargs) -> tuple[PythonEnvironment, Path]:
    """A fake uv that records its argv, prints *stderr* as `uv pip check` would and exits 1."""
    uv = tmp_path / "uv"
    record = tmp_path / "argv.json"
    uv.write_text("#!/usr/bin/env python3\nimport json, sys\n"
                  f"json.dump(sys.argv[1:], open({str(record)!r}, 'w'))\n"
                  f"sys.stderr.write({stderr!r})\nsys.exit(1)\n", encoding="utf-8")
    uv.chmod(uv.stat().st_mode | stat.S_IEXEC)
    environment = PythonEnvironment(uv=uv, python=Path("/usr/bin/python3"), destination=tmp_path / "venv",
                                    cache=tmp_path / "cache", env={"PATH": os.environ["PATH"]}, **kwargs)
    return environment, record


def _check(environment: PythonEnvironment):
    from pm.package import InstallError

    try:
        environment.check()
    except InstallError as exc:
        return exc
    return None


def test_the_refusal_names_the_line_it_could_not_read(tmp_path):
    """A refused report says which line was not understood (or which summary is missing), not only uv's tail."""
    stray = "error: something else went wrong"
    ok, reason = _only_excluded_missing(report(NEMO, stray))
    assert not ok and reason == f"line not understood: {stray}", reason
    ok, reason = _only_excluded_missing(HEAD + NEMO)
    assert not ok and "no `Found N incompatibilities` summary" in reason, reason
    ok, reason = _only_excluded_missing(HEAD + "Found 2 incompatibilities\n" + NEMO)
    assert not ok and "counts 2 problems, 1 read" in reason, reason
    # Through check(): the InstallError carries the reason.
    environment, record = _checking_uv(tmp_path, report(NEMO, stray))
    refused = _check(environment)
    assert refused is not None, "check() accepted a report with a line it cannot read"
    assert f"line not understood: {stray}" in str(refused), str(refused)
    assert json.loads(record.read_text())[:2] == ["pip", "check"]


def test_the_check_runs_uncoloured_and_reads_the_whole_report(tmp_path, monkeypatch):
    """check() asks uv for no colour (FORCE_COLOR would otherwise win) and reads the full report even in verbose/CI
    mode, where every other uv run is streamed and keeps only its last 2000 characters."""
    import io

    from pm.progress import verbose_output

    monkeypatch.setenv("HERMES_VERBOSE", "1")
    assert verbose_output(), "the verbose mode is not in effect"
    long_head = f"Using Python 3.14.7 environment at: /x/{'v' * 2500}/venv\nChecked 120 packages in 9ms\n"
    environment, record = _checking_uv(tmp_path, report(NEMO, head=long_head), output=io.StringIO())
    refused = _check(environment)
    assert refused is None, f"the report's head was lost: {refused}"
    argv = json.loads(record.read_text())
    assert argv[:2] == ["pip", "check"]
    assert "--color" in argv and argv[argv.index("--color") + 1] == "never", argv


def test_a_missing_exclusion_list_refuses_the_install_before_uv_runs(tmp_path, monkeypatch):
    """V3-RT critic r2 m4: without the list PM installs nothing (fail closed); uv is never started."""
    import pm.environment as environment_module
    from pm.package import InstallError

    monkeypatch.setattr(environment_module, "VENV_EXCLUSIONS_FILE", tmp_path / "absent.txt")
    uv = tmp_path / "uv"
    record = tmp_path / "argv.json"
    uv.write_text(f"#!/usr/bin/env python3\nimport json, sys\njson.dump(sys.argv[1:], open({str(record)!r}, 'w'))\n")
    uv.chmod(uv.stat().st_mode | stat.S_IEXEC)
    environment = PythonEnvironment(uv=uv, python=Path("/usr/bin/python3"), destination=tmp_path / "venv",
                                    cache=tmp_path / "cache", env={"PATH": os.environ["PATH"]})
    try:
        environment.sync(tmp_path)
        refused = None
    except InstallError as exc:
        refused = exc
    assert refused is not None, "PM installed the environment without its telemetry exclusion list"
    assert "telemetry exclusion list absent.txt is missing" in str(refused)
    assert not record.exists(), "uv ran without the exclusion list"
