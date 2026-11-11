"""fx25: the words a refused or narrowed run gives point where the control is, and the runtime's own lister stays inside
the project. The lister runs under the real kernel: a profile kills the shell on any read of the link's target, so a
script that follows the link dies with a signal instead of leaving a refusal nobody counted."""
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tui_gateway import methods_complete

ROOT = Path(__file__).resolve().parents[2]


def _script(monkeypatch) -> str:
    seen = {}

    def capture(command, **kwargs):
        seen["command"] = command
        return '{"output": "", "exit_code": 0}'

    monkeypatch.setattr("tools.terminal_tool.terminal_tool", capture)
    methods_complete._backend_dir_entries("/x", None)
    return shlex.split(seen["command"])[2]


def _world(tmp_path, link: bool):
    root = Path(os.path.realpath(tmp_path))
    project, sibling = root / "project", root / "sibling"
    (project / "sub").mkdir(parents=True)
    (project / "a.txt").write_text("a")
    (project / ".hidden").write_text("h")
    sibling.mkdir()
    if link:
        (project / "linked").symlink_to(sibling)
    return project, sibling


def _list(script: str, project: Path, sibling: Path):
    profile = f'(version 1)(allow default)(deny file-read* (subpath "{sibling}") (with send-signal SIGKILL))'
    return subprocess.run(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", script, "sh", str(project)],
                          capture_output=True, text=True, timeout=20, cwd=str(project))


needs_kernel = pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("sandbox-exec"), reason="macOS kernel")


@needs_kernel
class TestLister:
    def test_a_link_to_a_sibling_is_listed_and_never_followed(self, tmp_path, monkeypatch):
        project, sibling = _world(tmp_path, link=True)
        done = _list(_script(monkeypatch), project, sibling)
        assert done.returncode == 0, (done.returncode, done.stderr)
        assert sorted(done.stdout.split()) == [".hidden", "a.txt", "linked", "sub/"]

    def test_a_project_with_no_link_lists_the_same_way(self, tmp_path, monkeypatch):
        project, sibling = _world(tmp_path, link=False)
        done = _list(_script(monkeypatch), project, sibling)
        assert done.returncode == 0, (done.returncode, done.stderr)
        assert sorted(done.stdout.split()) == [".hidden", "a.txt", "sub/"]

    def test_the_kill_rule_does_catch_a_follow(self, tmp_path):
        """The instrument: a stat through the link does die, so a green above means no follow."""
        project, sibling = _world(tmp_path, link=True)
        done = _list('[ -e "$1/linked" ]', project, sibling)
        assert done.returncode == -9, (done.returncode, done.stderr)


class TestTheWordsPointAtTheControl:
    def test_the_refused_write_names_the_control_only_with_its_condition(self):
        text = (ROOT / "tools/file_operations.py").read_text(encoding="utf-8")
        assert "(the ask, or Allow this folder in the Containers pane)" not in text
        assert "If it runs read-only because the folder is not listed" in text

    def test_the_moved_note_names_the_control_only_with_its_condition(self):
        text = (ROOT / "plugins/iclone-confinement/seatbelt.py").read_text(encoding="utf-8")
        assert "chose Allow this folder" not in text
        assert "If it is read-only because the folder is not listed" in text
