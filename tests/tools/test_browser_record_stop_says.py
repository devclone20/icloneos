"""A browser recording that fails to save says so: the old button's whole result is that file."""
import logging

from tools import browser_tool as b


def _stop_with(monkeypatch, result):
    monkeypatch.setattr(b._session, "_run_browser_command", lambda *a, **k: result)
    b._recording_sessions.add("rec-task")


def test_a_failed_save_is_a_warning_with_the_reason(monkeypatch, caplog):
    _stop_with(monkeypatch, {"success": False, "error": "daemon gone"})
    with caplog.at_level(logging.INFO, logger="tools.browser_tool"):
        b._maybe_stop_recording("rec-task")
    warned = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("daemon gone" in m and "rec-task" in m for m in warned)
    assert "rec-task" not in b._recording_sessions


def test_a_saved_recording_is_no_warning(monkeypatch, caplog):
    _stop_with(monkeypatch, {"success": True, "data": {"path": "/x.webm"}})
    with caplog.at_level(logging.INFO, logger="tools.browser_tool"):
        b._maybe_stop_recording("rec-task")
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


# agent-browser 0.26 with the app's Chrome for Testing, measured directly: `record start` before the first `open` left
# 1 frame and a stop of 25 s (or no frame at all: ffmpeg "does not contain any stream", RC 234); after it 52 frames in
# 5 s and a stop under 1 s, 2 frames on a turn with no wait. So the recording starts once the first page is there.
def _navigate_calls(monkeypatch, open_results):
    calls, results = [], list(open_results)

    def run(_task, command, args=None, timeout=None, **_k):
        calls.append((command, (args or [None])[0]))
        if command == "open":
            return results.pop(0)
        return {"success": True, "data": {}}

    session = {"_first_nav": True, "features": {"local": True}}
    monkeypatch.setattr(b._session, "_run_browser_command", run)
    monkeypatch.setattr(b._session, "_get_session_info", lambda *_a, **_k: session)
    monkeypatch.setattr("hermes_cli.config.read_raw_config", lambda: {"browser": {"record_sessions": True}})
    monkeypatch.setattr(b, "_attach_auto_snapshot", lambda *_a, **_k: None)
    monkeypatch.setattr(b, "check_website_access", lambda _u: None, raising=False)
    monkeypatch.setattr(b, "_is_safe_url", lambda _u: True, raising=False)
    b._recording_sessions.clear()
    return calls


def test_the_recording_starts_after_the_first_page_never_before(monkeypatch):
    calls = _navigate_calls(monkeypatch, [{"success": True, "data": {"url": "https://example.com/", "title": "E"}}])
    b.browser_navigate("https://example.com/", task_id="rec-order")
    b._recording_sessions.clear()
    assert [c for c, _ in calls] == ["open", "record"]
    assert calls[1][1] == "start"


def test_a_first_open_that_fails_leaves_the_recording_for_the_next_one(monkeypatch):
    calls = _navigate_calls(
        monkeypatch,
        [{"success": False, "error": "net"}, {"success": True, "data": {"url": "https://example.com/", "title": "E"}}],
    )
    b.browser_navigate("https://example.com/", task_id="rec-order")
    assert "record" not in [c for c, _ in calls]
    b.browser_navigate("https://example.com/", task_id="rec-order")
    b._recording_sessions.clear()
    assert [c for c, _ in calls] == ["open", "open", "record"]


def test_a_stop_cannot_hold_the_turn(monkeypatch):
    seen = {}

    def run(_task, _command, _args=None, timeout=None, **_k):
        seen["timeout"] = timeout
        return {"success": True, "data": {}}

    monkeypatch.setattr(b._session, "_run_browser_command", run)
    b._recording_sessions.add("rec-task")
    b._maybe_stop_recording("rec-task")
    # G21, lead's decision: bound stays, and it outlasts the measured 25 s stop so a slow stop is not reported as a failure.
    assert seen["timeout"] is not None and 25 < seen["timeout"] <= 60


def test_no_frames_is_said_in_plain_words(monkeypatch, caplog):
    _stop_with(monkeypatch, {"success": False, "error": "ffmpeg: Output file does not contain any stream (234)"})
    with caplog.at_level(logging.INFO, logger="tools.browser_tool"):
        b._maybe_stop_recording("rec-task")
    warned = " ".join(r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)
    assert "no frames" in warned and "rec-task" in warned


def test_a_recording_that_cannot_start_is_a_warning(monkeypatch, caplog):
    monkeypatch.setattr(b._session, "_run_browser_command", lambda *a, **k: {"success": False, "error": "nope"})
    monkeypatch.setattr("hermes_cli.config.read_raw_config", lambda: {"browser": {"record_sessions": True}})
    b._recording_sessions.clear()
    with caplog.at_level(logging.INFO, logger="tools.browser_tool"):
        b._maybe_start_recording("rec-task")
    assert any("nope" in r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)
