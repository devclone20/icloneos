"""fx24: the cwd has one spelling and the row says the real folder (r3-B), a link's line says only what can be done
(proof7 F1), the roots the launcher judges are the runtime's spawned now (r2-B 3), and the left-running watch starts
before the hard-link scan (r3-B)."""
import json
import os
import threading
import types

import pytest

from tests.plugins.test_iclone_launcher import L, w  # noqa: F401
from tests.plugins.test_iclone_fx21 import TestF1Launcher  # noqa: F401


@pytest.mark.parametrize("spell", ["{p}/../{n}", "{p}/.", "{p}/", "/{p}", "{p}/sub/.."])
def test_a_cwd_not_in_its_one_spelling_is_refused(w, spell):
    w.policy("acceptEdits", listed=[str(w.proj)])
    (w.proj / "sub").mkdir(exist_ok=True)
    cwd = spell.format(p=w.proj, n=w.proj.name)
    with pytest.raises(L.Refusal) as caught:
        w.validator().request({**w.request(["/bin/pwd"]), "cwd": cwd})
    assert caught.value.code == "cwd-spelling" and "as the folder itself spells it" in str(caught.value)


def test_the_r3b_spelling_never_reaches_a_start_row(w):
    secret = w.proj.parent / "dot-ssh"
    secret.mkdir()
    w.policy("acceptEdits", listed=[str(w.proj)])
    with pytest.raises(L.Refusal):
        w.validator().request({**w.request(["/bin/pwd"]), "cwd": f"{secret}/../{w.proj.name}"})


def test_a_link_is_refused_and_says_only_what_can_be_done(w):
    link = w.proj.parent / "lnk"
    link.symlink_to(w.proj)
    w.policy("acceptEdits", listed=[str(w.proj)])
    with pytest.raises(L.Refusal) as caught:
        w.validator().request({**w.request(["/bin/pwd"]), "cwd": str(link)})
    assert caught.value.code == "cwd-spelling" and f"Give {w.proj} itself as the working folder" in str(caught.value)
    assert "Allow this folder" not in str(caught.value)


def test_a_link_inside_the_project_is_refused_too(w):
    real = w.proj / "real"
    real.mkdir()
    (w.proj / "in").symlink_to(real)
    w.policy("acceptEdits", listed=[str(w.proj)])
    with pytest.raises(L.Refusal):
        w.validator().request({**w.request(["/bin/pwd"]), "cwd": str(w.proj / "in")})


def _policy_file(tmp_path, roots):
    policy = L.LauncherPolicy(str(tmp_path), module=types.SimpleNamespace())
    body = {"v": 1, "body": {}, "projects": [], "asked": [], **({"roots": roots} if roots is not None else {})}
    with open(policy.path, "w") as out:
        json.dump(body, out)
    return policy


def test_the_roots_are_main_s_for_the_runtime_spawned_now_not_those_at_the_launcher_s_start(w, tmp_path):
    first, second = w.proj.parent / "first", w.proj.parent / "second"
    first.mkdir()
    second.mkdir()
    v = w.validator()
    v.read_roots, v.write_roots = (str(first),), ()
    params = lambda root: {"PROJECT_ROOT": str(root), "SCRATCH": "/scratch"}  # noqa: E731
    v.policy = _policy_file(tmp_path, {"reads": [str(second)], "writes": []})
    assert v.scan_root(params(first)) == str(first)  # the old project is nobody's: this process scans it
    assert v.scan_root(params(second)) is None


@pytest.mark.parametrize("roots", [None, {"reads": ["rel"], "writes": []}, {"reads": []}, "x"])
def test_a_file_that_does_not_say_the_roots_leaves_those_of_the_launcher_s_start(w, tmp_path, roots):
    first = w.proj.parent / "first"
    first.mkdir()
    v = w.validator()
    v.read_roots, v.write_roots = (str(first),), ()
    v.policy = _policy_file(tmp_path, roots)
    assert v.scan_root({"PROJECT_ROOT": str(first), "SCRATCH": "/scratch"}) is None


def test_a_survivor_that_ends_during_the_scan_still_gets_its_rows(monkeypatch):
    helper = TestF1Launcher()
    Lm, launcher, members, _ = helper.world(monkeypatch)
    launcher.journal.rows = []
    run = helper.run(Lm)
    run.member = run.token
    run.facts = {"scan_root": "/p", "session": None, "cls": "project"}
    run.proc.wait = lambda: 0
    run.proc.returncode = 0
    members[run.token] = [99]
    seen_running = threading.Event()

    def scan(*_a, **_k):  # the survivor is seen, and ends, while the scan still walks
        for _ in range(500):
            if any(row["ev"] == "left-running" for row in launcher.journal.rows):
                seen_running.set()
                break
            threading.Event().wait(0.01)
        members[run.token] = []

    monkeypatch.setattr(Lm.core, "check_hardlinks_after_run", scan)
    launcher.validator = types.SimpleNamespace(index=None)
    monkeypatch.setattr(Lm, "send_msg", lambda *a, **k: None)
    launcher._reap(run, types.SimpleNamespace(), threading.Lock())
    assert seen_running.is_set()
    assert [row["ev"] for row in launcher.journal.rows] == ["end", "left-running", "left-ended"]
