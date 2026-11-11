"""fx29 (lead's rulings 1 and 2), unconfined half: through SeatbeltEnvironment.request_project and the real validator,
the kernel's spelling is the one the run is judged and started in; a project inside a listed folder is judged as that
folder; a link is refused as a link, before any place field."""
import json
import os
import unicodedata

import pytest

from tests.plugins.test_iclone_fx26a import seatbelt
from tests.plugins.test_iclone_launcher import L, w  # noqa: F401


def ask(world, session_cwd, *, project_root=None):
    env = seatbelt.SeatbeltEnvironment(cwd=str(world.proj), timeout=5, cls="project", index=world.index, task_id="fx29")
    tok = seatbelt._REQUEST.set({"cwd": session_cwd, "project": None, "refused": None, "command": "true"})
    try:
        project, _refused = env.request_project()
    finally:
        seatbelt._REQUEST.reset(tok)
    argv = env.sandbox_argv(["/bin/bash", "-c", "true"], None, project_root or project)
    req = {"v": 1, "argv": argv, "cwd": seatbelt.request_cwd(session_cwd), "env": {"PATH": "/usr/bin:/bin"}}
    return world.validator().request(req)


def refused(world, session_cwd, **kw):
    with pytest.raises(L.Refusal) as caught:
        ask(world, session_cwd, **kw)
    return caught.value


def define(plan, key):
    return next(a.split("=", 1)[1] for a in plan["argv"] if a.startswith(f"{key}="))


@pytest.fixture
def tree(w):
    p = str(w.proj)
    repo, plain = os.path.join(p, "repo"), os.path.join(p, "Plainf")
    for d in (os.path.join(repo, ".git"), os.path.join(repo, "sub", "Deep"), os.path.join(plain, "sub")):
        os.makedirs(d, exist_ok=True)
    nfc = unicodedata.normalize("NFC", "Ação")
    os.makedirs(os.path.join(repo, unicodedata.normalize("NFD", nfc)), exist_ok=True)
    os.symlink(os.path.join(repo, "sub"), os.path.join(repo, "linkin"))
    w.policy("acceptEdits", listed=[p, repo, plain])
    return w, p, repo, plain, nfc


def test_another_case_runs_in_the_kernel_spelling_with_the_project_judged_there(tree):
    w, p, repo, plain, nfc = tree
    for asked, folder, project in (
        (os.path.join(repo, "SUB"), os.path.join(repo, "sub"), repo),
        (os.path.join(p, "REPO", "sub"), os.path.join(repo, "sub"), repo),
        # Unconfined, the runtime finds the git root above Plainf (the world's project, listed): that is its project.
        (os.path.join(p, "plainf"), plain, p),
        (os.path.join(p, "plainf", "SUB"), os.path.join(plain, "sub"), p),
        (os.path.join(repo, nfc), os.path.join(repo, unicodedata.normalize("NFD", nfc)), repo),
    ):
        plan = ask(w, asked)
        assert plan["cwd"] == folder and plan["start"]["cwd"] == folder, asked
        assert plan["start"]["project"] == project and define(plan, "PROJECT_ROOT") == project, asked
        # Listed: the write is not narrowed for the folder (the mode may still ask; the live test proves the write).
        assert plan["start"].get("narrowed_why") != "unlisted-folder", asked
        assert "-D" in plan["argv"] and plan["argv"].count("-D") == len(L.PARAM_KEYS)


def test_a_project_named_inside_a_listed_folder_is_judged_as_that_folder_never_wider(tree):
    w, p, repo, plain, _nfc = tree
    sub = os.path.join(repo, "sub", "Deep")
    # What the runtime sends under its profile: the workdir itself, as it cannot see the .git above it.
    plan = ask(w, sub, project_root=sub)
    assert define(plan, "PROJECT_ROOT") == repo and plan["start"]["project"] == repo
    assert plan["start"].get("narrowed_why") != "unlisted-folder"
    # The listed folder in another case holds it just the same: judged by identity, spelled by the kernel.
    plan = ask(w, os.path.join(p, "REPO", "sub"), project_root=os.path.join(p, "REPO", "sub"))
    assert define(plan, "PROJECT_ROOT") == repo and plan["start"].get("narrowed_why") != "unlisted-folder"
    # An unlisted ancestor is no project: the project stays as named, no write.
    w.policy("acceptEdits", listed=[repo, plain])
    loose = os.path.join(p, "loose", "inner")
    os.makedirs(loose)
    plan = ask(w, loose, project_root=loose)
    assert plan["start"]["project"] == loose and plan["start"]["write"] is False


def test_a_link_is_refused_as_a_link_before_the_place_fields(tree):
    w, _p, repo, _plain, _nfc = tree
    for asked in (os.path.join(repo, "linkin"), os.path.join(repo, "linkin", "Deep")):
        err = refused(w, asked)
        assert err.code == "cwd-spelling", asked
        assert os.path.realpath(asked) in str(err) and "Give " in str(err) and "malformed" not in str(err), asked
    # The pane's sentence and the agent's say the same thing: a link, give the folder itself.
    copy = open(os.path.join(os.path.dirname(__file__), "..", "..", "apps", "desktop", "src", "i18n", "en", "confinement.ts"),
                encoding="utf-8").read()
    row = copy[copy.index("'cwd-spelling':"):]
    row = row[:row.index("policy:")]
    assert "link" in row and "Give the folder itself as the working folder" in row and "malformed" not in row


def test_a_missing_folder_a_fifo_or_a_file_is_said_as_gone_with_the_path(tree):
    """fx32p: an ordinary event for a resumed session, never a malformed request."""
    w, p, _repo, _plain, _nfc = tree
    gone = os.path.join(p, "gone")
    os.mkdir(gone)
    os.rmdir(gone)
    fifo = os.path.join(p, "ff")
    os.mkfifo(fifo)
    plain = os.path.join(p, "a-file")
    with open(plain, "w", encoding="utf-8") as out:
        out.write("x")
    for where in (gone, fifo, plain):
        said = refused(w, where)
        assert said.code == "cwd-gone"
        assert str(said) == (f"Its working folder {where} is not there any more, so it was not started. "
                             "Move the folder back, or give a folder that exists.")


def test_the_never_list_in_another_case_stays_refused(tree):
    w, _p, _repo, _plain, _nfc = tree
    denied = next(iter(w.index.denied))
    os.makedirs(denied, exist_ok=True)
    other = os.path.join(os.path.dirname(denied), os.path.basename(denied).swapcase())
    assert refused(w, other).code == "bad-request"
