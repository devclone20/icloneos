"""K34 — the PyPI build is pinned and hash-locked. The publish job installs build-requirements.txt with
--require-hashes and builds with --no-isolation, every requirement is `==` with sha256 hashes, and hatchling is the
version pyproject.toml declares. Static: nothing is downloaded by this test."""

import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
REQS = HERE / "build-requirements.txt"
PUBLISH = HERE.parent / "github-workflows" / "publish.yml"
PYPROJECT = HERE / "pyproject.toml"

# What build 1.2.2.post1 and hatchling 1.27.0 import on CPython 3.13 (their 3.11+/posix closure).
CLOSURE = {"build", "hatchling", "packaging", "pathspec", "pluggy", "pyproject-hooks", "trove-classifiers"}


def requirements():
    text = REQS.read_text().replace("\\\n", " ")
    out = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        name, _, rest = line.partition("==")
        version = rest.split()[0] if rest else ""
        out[name.strip().lower()] = (version, re.findall(r"--hash=sha256:([0-9a-f]{64})\b", line), line)
    return out


def pypi_job():
    text = PUBLISH.read_text()
    start = text.index("\n  pypi:")
    nxt = re.search(r"\n  [a-z][\w-]*:\n", text[start + 1:])
    return text[start: start + 1 + nxt.start()] if nxt else text[start:]


class BuildPins(unittest.TestCase):
    def test_every_requirement_is_pinned_with_hashes(self):
        reqs = requirements()
        self.assertEqual(set(reqs), CLOSURE)
        for name, (version, hashes, line) in reqs.items():
            self.assertRegex(version, r"^\d[\w.]*$", name)
            self.assertGreaterEqual(len(hashes), 1, name)
            self.assertNotIn(">", line, name)

    def test_hatchling_matches_pyproject(self):
        declared = re.search(r'requires = \["hatchling==([^"]+)"\]', PYPROJECT.read_text())
        self.assertIsNotNone(declared)
        self.assertEqual(requirements()["hatchling"][0], declared.group(1))

    def test_publish_installs_with_hashes_and_builds_without_isolation(self):
        job = pypi_job()
        self.assertRegex(job, r"pip install --require-hashes[^\n]*-r packaging/python/build-requirements\.txt")
        self.assertRegex(job, r"python -m build --no-isolation\b")
        # Nothing else is pip-installed in the job, and no unpinned build package.
        self.assertEqual(len(re.findall(r"pip install", job)), 1)
        self.assertNotRegex(job, r"pip install [^\n]*\bbuild==")


if __name__ == "__main__":
    unittest.main()
