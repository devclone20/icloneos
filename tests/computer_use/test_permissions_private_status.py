"""G-99: the card's state is what macOS says for com.trycua.driver, read from a real (fake-binary) private daemon process."""

import json
import subprocess
import sys

import pytest

from tools.computer_use import cua_backend_daemon, cua_backend_driver, permissions

DRIVER = r"""
import json, os, sys
state = os.environ["FAKE_CUA_STATE"]
args = sys.argv[1:]
open(os.path.join(state, "argv.log"), "a").write(json.dumps(args) + "\n")
marker = os.path.join(state, "daemon.on")
answer = json.load(open(os.path.join(state, "answer.json")))
if args[:1] == ["serve"]:
    if answer.get("never_starts"):
        sys.exit(0)
    open(marker, "w").close()
elif args[:1] == ["status"]:
    sys.exit(0 if os.path.exists(marker) else 3)
elif args[:2] == ["call", "check_permissions"]:
    print(json.dumps(answer["tcc"]))
elif args[:2] == ["permissions", "status"]:
    print(json.dumps({"daemon_running": False, "status": "unknown", "reason": "no daemon"}))
elif args[:1] == ["stop"]:
    os.remove(marker)
elif args[:1] == ["doctor"]:
    print(json.dumps({"ok": True, "probes": []}))
elif args[:1] == ["--version"]:
    print("cua-driver 0.28.2")
"""


@pytest.fixture
def driver(tmp_path, monkeypatch):
    script = tmp_path / "cua-driver.py"
    script.write_text(DRIVER)
    monkeypatch.setenv("FAKE_CUA_STATE", str(tmp_path))
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(permissions, "_private_status_cache", (0.0, "", None))
    monkeypatch.setattr(permissions, "_PRIVATE_START_SECONDS", 2.0)
    monkeypatch.setattr(cua_backend_driver, "resolve_cua_driver_cmd", lambda override=None: str(script))
    monkeypatch.setattr(permissions, "_child_env", lambda: dict(__import__("os").environ))
    monkeypatch.setattr(
        permissions, "_run",
        lambda binary, *args, timeout: subprocess.run([sys.executable, "-I", binary, *args], capture_output=True, text=True, timeout=timeout),
    )
    monkeypatch.setattr(
        cua_backend_daemon, "_embedded_daemon_spawn_command",
        lambda binary, serve_args, *, platform: [binary, *serve_args],
    )

    def answer(**body):
        (tmp_path / "answer.json").write_text(json.dumps(body))

    def argv():
        return [json.loads(line) for line in (tmp_path / "argv.log").read_text().splitlines()]

    return answer, argv


def tcc(accessibility, screen):
    return {"accessibility": accessibility, "screen_recording": screen, "screen_recording_capturable": None,
            "source": {"executable": "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"}}


@pytest.mark.parametrize(
    "accessibility,screen,ready",
    [(True, True, True), (False, False, False), (True, False, False), (False, True, False)],
    ids=["granted", "denied", "revoked-screen", "revoked-accessibility"],
)
def test_state_comes_from_the_private_daemon_and_nothing_can_prompt(driver, accessibility, screen, ready):
    answer, argv = driver
    answer(tcc=tcc(accessibility, screen))

    status = permissions.computer_use_status()

    assert (status["accessibility"], status["screen_recording"], status["ready"]) == (accessibility, screen, ready)
    assert status["source"]["executable"].endswith("CuaDriver.app/Contents/MacOS/cua-driver")
    calls = argv()
    serve = next(call for call in calls if call[0] == "serve")
    assert serve[:2] == ["serve", "--embedded"] and "--no-permissions-gate" in serve
    socket_path = serve[serve.index("--socket") + 1]
    assert ["call", "check_permissions", '{"prompt":false}', "--socket", socket_path] in calls
    assert ["stop", "--socket", socket_path] in calls, "the daemon never outlives the read"
    assert not any(call[:2] == ["permissions", "grant"] for call in calls), "a status read never asks macOS"


def test_two_reads_in_the_same_moment_start_one_daemon_and_a_later_read_sees_a_change(driver, monkeypatch):
    answer, argv = driver
    answer(tcc=tcc(False, False))
    assert permissions.computer_use_status()["ready"] is False
    answer(tcc=tcc(True, True))
    assert permissions.computer_use_status()["ready"] is False, "inside the moment: the cached read"
    assert sum(call[0] == "serve" for call in argv()) == 1

    monkeypatch.setattr(permissions, "_PRIVATE_STATUS_TTL_SECONDS", 0.0)
    assert permissions.computer_use_status()["ready"] is True, "the switch was turned on: the next read says so"
    assert sum(call[0] == "serve" for call in argv()) == 2


def test_a_daemon_that_never_answers_is_unknown_with_a_reason_never_not_allowed(driver):
    answer, _ = driver
    answer(never_starts=True, tcc=tcc(True, True))

    status = permissions.computer_use_status()

    assert status["ready"] is None
    assert "could not report" in status["error"]


def test_a_daemon_answering_without_the_booleans_is_unknown_not_not_allowed(driver):
    answer, _ = driver
    answer(tcc={"source": {}})

    status = permissions.computer_use_status()

    assert status["ready"] is None and status["error"] is None


def test_an_app_failing_the_signature_check_is_refused_before_anything_runs(driver, monkeypatch):
    answer, argv = driver
    answer(tcc=tcc(True, True))

    def refuse(binary, serve_args, *, platform):
        raise RuntimeError("CuaDriver.app signature does not match com.trycua.driver")

    monkeypatch.setattr(cua_backend_daemon, "_embedded_daemon_spawn_command", refuse)

    status = permissions.computer_use_status()

    assert status["ready"] is None and "signature" in status["error"]
    assert not any(call[0] == "serve" for call in argv())


def test_launch_names_home_and_telemetry_because_launch_services_forwards_no_environment(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(permissions, "_child_env", lambda: {"CUA_DRIVER_RS_TELEMETRY_ENABLED": "0"})
    monkeypatch.setattr(
        cua_backend_daemon, "_embedded_daemon_spawn_command",
        lambda binary, serve_args, *, platform: ["/usr/bin/open", "-n", "-g", "-a", "/Applications/CuaDriver.app", "--args", *serve_args],
    )

    command = permissions._private_daemon_launch("/x/cua-driver", "/tmp/s.sock")

    assert command[0] == "/usr/bin/open"
    assert command[1:5] == ["--env", f"HOME={tmp_path}", "--env", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0"]
    assert command[5:] == ["-n", "-g", "-a", "/Applications/CuaDriver.app", "--args", "serve", "--embedded", "--socket", "/tmp/s.sock", "--no-permissions-gate"]


def test_a_long_tmpdir_never_breaks_the_socket(monkeypatch):
    monkeypatch.setattr(permissions.tempfile, "gettempdir", lambda: "/private/tmp/" + "x" * 120)
    assert permissions._private_socket_path().startswith("/tmp/hc-")
