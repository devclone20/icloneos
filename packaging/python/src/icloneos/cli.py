"""icloneos: install, launch, update and uninstall the iclone os macOS app.

Standard library only. Every install verifies sha256 against SHA256SUMS.txt, then the Developer ID
signature, team id, bundle id and notarisation, before anything is moved. Never uses sudo.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import os
import platform as _platform
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterator, List, NamedTuple, Optional, Sequence

from . import __version__

REPOSITORY = "devclone20/icloneos"
FEED_FILE = "latest-mac.yml"
SUMS_FILE = "SHA256SUMS.txt"
SUMS_SIGNATURE_FILE = "SHA256SUMS.txt.sig"
# Off until the owner publishes the first signed list (packaging/README.md, "Signing SHA256SUMS").
REQUIRE_SIGNED_SUMS = False
APPLE_ROOT_CA_SHA256 = "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024"
SYSTEM_ROOTS_KEYCHAIN = "/System/Library/Keychains/SystemRootCertificates.keychain"
DEVELOPER_ID_APPLICATION_OID = "1.2.840.113635.100.6.1.13"
DMG_FILE = "iclone-os-mac-arm64.dmg"
APP_BUNDLE_NAME = "iclone os.app"
BUNDLE_ID = "io.cloneframe.icloneos"
TEAM_ID = "HJSLQL98D8"
# The rollback floor: raise it with every launcher release that follows an app release with a known flaw.
MINIMUM_VERSION = "0.0.3"
ALLOWED_DOWNLOAD_HOSTS = (
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
)
MAX_DMG_BYTES = 2 * 1024**3

# Absolute paths only: a hostile PATH must not be able to substitute codesign or spctl.
SYSTEM_TOOLS: Dict[str, str] = {
    "codesign": "/usr/bin/codesign",
    "ditto": "/usr/bin/ditto",
    "hdiutil": "/usr/bin/hdiutil",
    "open": "/usr/bin/open",
    "openssl": "/usr/bin/openssl",
    "pgrep": "/usr/bin/pgrep",
    "plutil": "/usr/bin/plutil",
    "security": "/usr/bin/security",
    "spctl": "/usr/sbin/spctl",
}

_VERSION = re.compile(r"^\d+(?:\.\d+){1,3}$", re.ASCII)
_FEED_VERSION = re.compile(r"""^version:\s*['"]?([^'"\s]+)['"]?\s*$""", re.ASCII)
_SUM_LINE = re.compile(r"^([0-9a-f]{64}) [ *]([^\s/][^/]*)$", re.ASCII)
_PEM_BLOCK = re.compile(r"-----BEGIN CERTIFICATE-----\r?\n[\s\S]*?-----END CERTIFICATE-----")
STAGING_PREFIX = ".icloneos-staging-"
PREVIOUS_APP = "previous.app"


class Refusal(Exception):
    """An expected, explained stop; the CLI prints the one-sentence reason and exits 2."""


class Terminated(BaseException):
    """SIGTERM, raised like KeyboardInterrupt so every `finally` runs; the CLI exits 143."""


@contextlib.contextmanager
def _signals_deferred() -> Iterator[None]:
    """Holds SIGINT and SIGTERM until the block ends, so the swap and its rollback are never cut in half."""
    deferred = {signal.SIGINT, signal.SIGTERM}
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, deferred)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


class RunResult(NamedTuple):
    code: int
    stdout: str
    stderr: str


Runner = Callable[[str, Sequence[str]], RunResult]


def run_system_tool(command: str, args: Sequence[str]) -> RunResult:
    executable = SYSTEM_TOOLS[command]
    completed = subprocess.run([executable, *args], capture_output=True, text=True, check=False)
    return RunResult(completed.returncode, completed.stdout, completed.stderr)


def assert_allowed_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise Refusal(f"Refusing a non-HTTPS download location ({parsed.scheme}:).")
    if parsed.hostname not in ALLOWED_DOWNLOAD_HOSTS:
        raise Refusal(f"The download was redirected to an unexpected host ({parsed.hostname}).")


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        assert_allowed_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


MACOS_CA_BUNDLE = "/etc/ssl/cert.pem"


def tls_context() -> ssl.SSLContext:
    # The python.org installer ships without a CA store until "Install Certificates.command" is run;
    # macOS's own bundle keeps certificate verification on without adding certifi as a dependency.
    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0) == 0 and os.path.exists(MACOS_CA_BUNDLE):
        context.load_verify_locations(cafile=MACOS_CA_BUNDLE)
    return context


_OPENER = urllib.request.build_opener(_HttpsOnlyRedirects, urllib.request.HTTPSHandler(context=tls_context()))


def _open(url: str):  # type: ignore[no-untyped-def]
    assert_allowed_url(url)
    try:
        response = _OPENER.open(url, timeout=60)
    except Refusal:
        raise
    except Exception as error:  # noqa: BLE001 — every network failure becomes one sentence
        raise Refusal(f"Could not download {url}: {error}.") from error
    assert_allowed_url(response.geturl())
    return response


def fetch_text(url: str) -> str:
    with _open(url) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise Refusal(f"{url} is unexpectedly large for a text file.")
    return body.decode("utf-8")


def download(url: str, destination: Path) -> None:
    received = 0
    with _open(url) as response, open(destination, "xb") as out:
        os.chmod(destination, 0o600)
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            received += len(chunk)
            if received > MAX_DMG_BYTES:
                raise Refusal("The disk image is larger than any iclone os release can be.")
            out.write(chunk)


@dataclass
class System:
    run: Runner = run_system_tool
    fetch_text: Callable[[str], str] = fetch_text
    download: Callable[[str, Path], None] = download
    home: Path = field(default_factory=Path.home)
    system_apps_dir: Path = Path("/Applications")
    tmp_root: Path = field(default_factory=lambda: Path(tempfile.gettempdir()))
    platform: str = sys.platform
    arch: str = field(default_factory=_platform.machine)
    uid: int = field(default_factory=lambda: os.getuid() if hasattr(os, "getuid") else -1)


Log = Callable[[str], None]


def latest_asset_url(file: str) -> str:
    return f"https://github.com/{REPOSITORY}/releases/latest/download/{urllib.parse.quote(file)}"


def tagged_asset_url(version: str, file: str) -> str:
    return f"https://github.com/{REPOSITORY}/releases/download/v{version}/{urllib.parse.quote(file)}"


def parse_feed_version(yaml_text: str) -> str:
    for line in yaml_text.splitlines():
        match = _FEED_VERSION.match(line)
        if match:
            if not _VERSION.match(match.group(1)):
                raise Refusal(f'The release feed announces a malformed version "{match.group(1)}".')
            return match.group(1)
    raise Refusal("The release feed does not announce a version.")


def parse_sha256_sums(text: str) -> Dict[str, str]:
    sums: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        match = _SUM_LINE.match(line)
        if not match:
            raise Refusal('The checksum list contains a line that is not "<sha256>  <file>".')
        digest, name = match.group(1), match.group(2)
        if sums.get(name, digest) != digest:
            raise Refusal(f"The checksum list gives two different hashes for {name}.")
        sums[name] = digest
    return sums


def compare_versions(a: str, b: str) -> int:
    left = [int(part) for part in a.split(".")]
    right = [int(part) for part in b.split(".")]
    length = max(len(left), len(right))
    left += [0] * (length - len(left))
    right += [0] * (length - len(right))
    return (left > right) - (left < right)


def assert_not_below_floor(version: str) -> None:
    # Someone who can write to the release repository could point "latest" at an older, genuinely notarised
    # build with a known flaw; Apple's signature cannot tell the two apart, the floor can.
    if compare_versions(version, MINIMUM_VERSION) < 0:
        raise Refusal(
            f"The release feed offers {version}, below the minimum supported version {MINIMUM_VERSION}; "
            "this looks like a rollback, so nothing was installed."
        )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_codesign_display(report: str) -> Dict[str, Optional[str]]:
    found: Dict[str, Optional[str]] = {"identifier": None, "team_id": None, "leaf_authority": None}
    for line in report.splitlines():
        key, sep, value = line.partition("=")
        if not sep:
            continue
        if key == "Identifier":
            found["identifier"] = value.strip()
        elif key == "TeamIdentifier":
            found["team_id"] = value.strip()
        elif key == "Authority" and found["leaf_authority"] is None:
            found["leaf_authority"] = value.strip()
    return found


def _verify_team(run: Runner, path: Path, label: str) -> Optional[str]:
    display = run("codesign", ["--display", "--verbose=2", str(path)])
    if display.code != 0:
        raise Refusal(f"codesign could not read the signature of {label}.")
    info = parse_codesign_display(display.stderr + display.stdout)
    if info["team_id"] != TEAM_ID:
        raise Refusal(f"{label} is signed by team {info['team_id'] or 'none'}, not the iclone os team {TEAM_ID}.")
    if not (info["leaf_authority"] or "").startswith("Developer ID Application:"):
        raise Refusal(f"{label} is not signed with a Developer ID Application certificate.")
    return info["identifier"]


def _assert_notarised(result: RunResult, label: str) -> None:
    if result.code != 0 or "source=Notarized Developer ID" not in result.stderr + result.stdout:
        raise Refusal(f"Gatekeeper does not accept {label} as notarised.")


def verify_disk_image(run: Runner, dmg: Path) -> None:
    label = "the disk image"
    if run("codesign", ["--verify", "--strict", "--verbose=2", str(dmg)]).code != 0:
        raise Refusal(f"The code signature of {label} is invalid.")
    _verify_team(run, dmg, label)
    _assert_notarised(
        run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", str(dmg)]),
        label,
    )


def verify_signed_app(run: Runner, app: Path) -> None:
    """Signature, seal, team and bundle id. `launch` runs this before every open: launcher-installed apps carry
    no quarantine flag, so Gatekeeper does not assess them on launch."""
    label = "the app bundle"
    if run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", str(app)]).code != 0:
        raise Refusal(f"The code signature of {label} is invalid or was modified.")
    identifier = _verify_team(run, app, label)
    if identifier != BUNDLE_ID:
        raise Refusal(f"{label} identifies as {identifier or 'nothing'}, not {BUNDLE_ID}.")


def verify_app_bundle(run: Runner, app: Path) -> None:
    verify_signed_app(run, app)
    _assert_notarised(run("spctl", ["--assess", "--type", "execute", "--verbose=2", str(app)]), "the app bundle")


def pem_certificates(text: str) -> List[str]:
    return _PEM_BLOCK.findall(text)


def pem_fingerprint(pem: str) -> str:
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()


def parse_signer_report(report: str) -> Dict[str, object]:
    """`openssl x509 -noout -text -subject -issuer -nameopt sep_multiline,utf8`: the text dump, then a `subject=`
    and an `issuer=` block of four-space-indented `KEY=value` lines."""
    subject: Dict[str, str] = {}
    issuer: Dict[str, str] = {}
    section: Optional[Dict[str, str]] = None
    for line in report.splitlines():
        if line.startswith("subject="):
            section = subject
        elif line.startswith("issuer="):
            section = issuer
        elif section is not None:
            match = re.match(r"^ {4}([A-Za-z]+)=(.*)$", line)
            if match and match.group(1) not in section:
                section[match.group(1)] = match.group(2)
    return {"subject": subject, "issuer": issuer, "marker": f"{DEVELOPER_ID_APPLICATION_OID}:" in report}


def verify_sums_signature(run: Runner, sums: Path, signature: Path, work: Path, team_id: str = TEAM_ID) -> None:
    """Detached CMS over the exact bytes of SHA256SUMS.txt, chained to Apple Root CA (pinned by sha256), with
    exactly one signer: a Developer ID Application certificate of our team from Apple's Developer ID CA.
    LibreSSL needs -ignore_critical for Apple's extensions; the Developer ID marker is checked here instead."""
    label = SUMS_FILE
    roots = run("security", ["find-certificate", "-a", "-c", "Apple Root CA", "-p", SYSTEM_ROOTS_KEYCHAIN])
    root = next((pem for pem in pem_certificates(roots.stdout) if pem_fingerprint(pem) == APPLE_ROOT_CA_SHA256), None)
    if roots.code != 0 or root is None:
        raise Refusal("Apple's root certificate was not found in the system root store, so the checksum list cannot be checked.")
    root_path, signer_path = work / "apple-root-ca.pem", work / "sums-signer.pem"
    with open(root_path, "x", encoding="ascii") as handle:
        handle.write(root + "\n")
    verify = run(
        "openssl",
        ["smime", "-verify", "-binary", "-inform", "DER", "-in", str(signature), "-content", str(sums),
         "-CAfile", str(root_path), "-purpose", "any", "-ignore_critical", "-signer", str(signer_path),
         "-out", "/dev/null"],
    )
    if verify.code != 0:
        raise Refusal(f"The signature on {label} is invalid or does not chain to Apple's root certificate.")
    try:
        signers = pem_certificates(signer_path.read_text(encoding="ascii"))
    except OSError:
        signers = []
    if len(signers) != 1:
        raise Refusal(f"{label} must carry exactly one signer, not {len(signers)}.")
    report = run("openssl", ["x509", "-in", str(signer_path), "-noout", "-text", "-subject", "-issuer",
                             "-nameopt", "sep_multiline,utf8"])
    if report.code != 0:
        raise Refusal(f"openssl could not read the signer of {label}.")
    parsed = parse_signer_report(report.stdout)
    subject = parsed["subject"]
    issuer = parsed["issuer"]
    assert isinstance(subject, dict) and isinstance(issuer, dict)
    if issuer.get("CN") != "Developer ID Certification Authority" or issuer.get("O") != "Apple Inc.":
        raise Refusal(f"{label} was not signed with a certificate from Apple's Developer ID authority.")
    if not parsed["marker"] or not str(subject.get("CN", "")).startswith("Developer ID Application:"):
        raise Refusal(f"{label} was not signed with a Developer ID Application certificate.")
    if subject.get("OU") != team_id:
        raise Refusal(f"{label} is signed by team {subject.get('OU') or 'none'}, not the iclone os team {team_id}.")


@dataclass(frozen=True)
class Release:
    version: str
    dmg_sha256: str


def resolve_latest_release(sys_: System, require_signed_sums: bool = REQUIRE_SIGNED_SUMS) -> Release:
    version = parse_feed_version(sys_.fetch_text(latest_asset_url(FEED_FILE)))
    assert_not_below_floor(version)
    sums_text = sys_.fetch_text(tagged_asset_url(version, SUMS_FILE))
    if require_signed_sums:
        work = Path(tempfile.mkdtemp(prefix="icloneos-sums-", dir=sys_.tmp_root))
        try:
            sums_path, signature_path = work / SUMS_FILE, work / SUMS_SIGNATURE_FILE
            with open(sums_path, "x", encoding="utf-8", newline="") as handle:
                handle.write(sums_text)
            sys_.download(tagged_asset_url(version, SUMS_SIGNATURE_FILE), signature_path)
            verify_sums_signature(sys_.run, sums_path, signature_path, work)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    sums = parse_sha256_sums(sums_text)
    if DMG_FILE not in sums:
        raise Refusal(f"The checksum list has no entry for {DMG_FILE}.")
    return Release(version, sums[DMG_FILE])


def _plist_key(sys_: System, app: Path, key: str) -> Optional[str]:
    result = sys_.run("plutil", ["-extract", key, "raw", "-o", "-", str(app / "Contents" / "Info.plist")])
    return result.stdout.strip() if result.code == 0 else None


def _assert_supported_host(sys_: System) -> None:
    if sys_.platform != "darwin":
        raise Refusal("iclone os is a macOS app; this machine is not macOS.")
    if sys_.arch != "arm64":
        raise Refusal("iclone os ships for Apple silicon (arm64) only.")
    if sys_.uid == 0:
        raise Refusal("Do not run icloneos as root or with sudo; it installs for your user only.")


def _assert_ours(sys_: System, app: Path) -> Optional[str]:
    bundle_id = _plist_key(sys_, app, "CFBundleIdentifier")
    if bundle_id != BUNDLE_ID:
        raise Refusal(f"{app} is not iclone os (bundle id {bundle_id or 'unreadable'}); icloneos will not touch it.")
    return _plist_key(sys_, app, "CFBundleVersion")


def _is_running(sys_: System, app: Path) -> bool:
    prefix = re.escape(f"{app}/Contents/MacOS/")
    return sys_.run("pgrep", ["-f", f"^{prefix}"]).code == 0


def _writable_dir(directory: Path) -> Path:
    directory = directory.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if not os.access(directory, os.W_OK):
        raise Refusal(f"{directory} is not writable by you; use --dest ~/Applications (icloneos never uses sudo).")
    return directory


def _assert_not_symlink(path: Path) -> None:
    # Every verb treats a symlinked `iclone os.app` the same way: never followed, replaced or removed.
    if path.is_symlink():
        raise Refusal(f"{path} is a symbolic link; icloneos will not follow, replace or remove it.")


def _search_dirs(sys_: System, dest: Optional[Path]) -> List[Path]:
    return [dest.expanduser().resolve()] if dest else [sys_.home / "Applications", sys_.system_apps_dir]


def _locate(sys_: System, dest: Optional[Path]) -> Path:
    dirs = _search_dirs(sys_, dest)
    for directory in dirs:
        candidate = directory / APP_BUNDLE_NAME
        if candidate.exists() or candidate.is_symlink():
            _assert_not_symlink(candidate)
            return candidate
    raise Refusal(f"iclone os is not installed in {' or '.join(map(str, dirs))}; run \"icloneos install\" first.")


def _settle_staging(staging: Path, target: Path) -> None:
    """Puts the previous app back if the swap did not finish, then removes staging. If the restore fails,
    staging is kept so the previous app is never deleted."""
    previous = staging / PREVIOUS_APP
    if previous.exists() and not (target.exists() or target.is_symlink()):
        try:
            os.rename(previous, target)
        except OSError as error:
            raise Refusal(
                f"The previous iclone os could not be put back; it is safe at {previous}. Move it to {target}."
            ) from error
    shutil.rmtree(staging, ignore_errors=True)


def recover_interrupted_swaps(directory: Path, log: "Log") -> None:
    """A run killed outright (SIGKILL, power loss) can leave the previous app inside a staging folder with
    nothing at the target. Every verb sweeps those first."""
    target = directory / APP_BUNDLE_NAME
    try:
        entries = list(directory.iterdir())
    except OSError:
        return
    for staging in entries:
        if not staging.name.startswith(STAGING_PREFIX) or staging.is_symlink() or not staging.is_dir():
            continue
        previous = staging / PREVIOUS_APP
        try:
            if previous.is_dir() and not previous.is_symlink() and not (target.exists() or target.is_symlink()):
                os.rename(previous, target)
                log(f"Restored iclone os at {target} after an interrupted install.")
            shutil.rmtree(staging)
        except OSError as error:
            log(f"Could not clean up {staging}: {error}.")


def _locate_after_recovery(sys_: System, dest: Optional[Path], log: "Log") -> Path:
    for directory in _search_dirs(sys_, dest):
        recover_interrupted_swaps(directory, log)
    return _locate(sys_, dest)


def _detach(sys_: System, mount_point: Path) -> None:
    if sys_.run("hdiutil", ["detach", str(mount_point), "-quiet"]).code != 0:
        sys_.run("hdiutil", ["detach", str(mount_point), "-force", "-quiet"])


def _install_release(sys_: System, release: Release, dest_dir: Path, log: Log) -> Path:
    target = dest_dir / APP_BUNDLE_NAME
    work = Path(tempfile.mkdtemp(prefix="icloneos-", dir=sys_.tmp_root))
    staging: Optional[Path] = None
    try:
        dmg = work / DMG_FILE
        log(f"Downloading iclone os {release.version} …")
        sys_.download(tagged_asset_url(release.version, DMG_FILE), dmg)
        log("Verifying sha256 against SHA256SUMS.txt …")
        actual = sha256_file(dmg)
        if actual != release.dmg_sha256:
            raise Refusal(
                f"The sha256 of {DMG_FILE} ({actual}) does not match the published SHA256SUMS ({release.dmg_sha256})."
            )
        log("Verifying the disk image signature and notarisation …")
        verify_disk_image(sys_.run, dmg)

        # K81: staging exists before anything is mounted, the mount runs inside the try whose finally detaches
        # it, and the detach holds SIGINT/SIGTERM: nothing between attach and detach can leave the image mounted.
        staging = Path(tempfile.mkdtemp(prefix=STAGING_PREFIX, dir=dest_dir))
        staged = staging / APP_BUNDLE_NAME
        mount_point = work / "mnt"
        mount_point.mkdir(mode=0o700)
        try:
            attach = sys_.run(
                "hdiutil",
                [
                    "attach", str(dmg), "-nobrowse", "-readonly", "-noautoopen",
                    "-mountpoint", str(mount_point), "-quiet",
                ],
            )
            if attach.code != 0:
                raise Refusal("hdiutil could not mount the verified disk image.")
            source = mount_point / APP_BUNDLE_NAME
            if source.is_symlink() or not source.is_dir():
                raise Refusal(f"The disk image does not contain {APP_BUNDLE_NAME} as a real folder.")
            if sys_.run("ditto", [str(source), str(staged)]).code != 0:
                raise Refusal("Copying the app out of the disk image failed.")
        finally:
            with _signals_deferred():
                _detach(sys_, mount_point)

        log("Verifying the app signature, team id and notarisation …")
        verify_app_bundle(sys_.run, staged)
        staged_version = _plist_key(sys_, staged, "CFBundleVersion")
        if staged_version != release.version:
            raise Refusal(
                f"The app reports version {staged_version or 'none'} but the release feed says {release.version}."
            )

        if target.exists() or target.is_symlink():
            _assert_not_symlink(target)
            _assert_ours(sys_, target)
            if _is_running(sys_, target):
                raise Refusal("iclone os is running; quit it and try again.")
        with _signals_deferred():
            if target.exists():
                os.rename(target, staging / PREVIOUS_APP)
            os.rename(staged, target)
        return target
    finally:
        with _signals_deferred():
            try:
                if staging is not None:
                    _settle_staging(staging, target)
            finally:
                shutil.rmtree(work, ignore_errors=True)


def install(sys_: System, dest: Optional[Path], force: bool, log: Log, allow_downgrade: bool = False) -> Path:
    _assert_supported_host(sys_)
    dest_dir = _writable_dir(dest or sys_.home / "Applications")
    recover_interrupted_swaps(dest_dir, log)
    release = resolve_latest_release(sys_)
    target = dest_dir / APP_BUNDLE_NAME
    if target.exists() or target.is_symlink():
        _assert_not_symlink(target)
        installed = _assert_ours(sys_, target)
        order = compare_versions(installed, release.version) if installed and _VERSION.match(installed) else -1
        if order > 0 and not allow_downgrade:
            raise Refusal(
                f"iclone os {installed} is installed and the release feed offers the older {release.version}; "
                "pass --allow-downgrade to install it anyway."
            )
        if order == 0 and not force:
            log(f"iclone os {installed} is already installed at {target}.")
            return target
    path = _install_release(sys_, release, dest_dir, log)
    log(f"Installed iclone os {release.version} at {path}.")
    return path


def update(sys_: System, dest: Optional[Path], log: Log) -> Path:
    """Never downgrades: an older feed leaves the installed app alone (`install --allow-downgrade` does that)."""
    _assert_supported_host(sys_)
    app = _locate_after_recovery(sys_, dest, log)
    installed = _assert_ours(sys_, app)
    release = resolve_latest_release(sys_)
    if installed and _VERSION.match(installed) and compare_versions(installed, release.version) >= 0:
        log(f"iclone os {installed} is up to date.")
        return app
    if _is_running(sys_, app):
        raise Refusal("iclone os is running; quit it and try again.")
    path = _install_release(sys_, release, _writable_dir(app.parent), log)
    log(f"Updated iclone os {installed or '?'} → {release.version}.")
    return path


def launch(sys_: System, dest: Optional[Path], log: Log) -> None:
    _assert_supported_host(sys_)
    app = _locate_after_recovery(sys_, dest, log)
    _assert_ours(sys_, app)
    verify_signed_app(sys_.run, app)
    if sys_.run("open", [str(app)]).code != 0:
        raise Refusal(f"macOS could not open {app}.")
    log(f"Launched {app}.")


def uninstall(sys_: System, dest: Optional[Path], log: Log, force: bool = False) -> None:
    """Removes the bundle only. It must carry our signature unless --force: the Info.plist alone is no proof."""
    _assert_supported_host(sys_)
    app = _locate_after_recovery(sys_, dest, log)
    _assert_ours(sys_, app)
    if _is_running(sys_, app):
        raise Refusal("iclone os is running; quit it and try again.")
    if not force:
        try:
            verify_signed_app(sys_.run, app)
        except Refusal as refusal:
            raise Refusal(
                f"{app} does not carry a valid iclone os signature ({refusal}); pass --force to remove it anyway."
            ) from refusal
    shutil.rmtree(app)
    log(f"Removed {app}. Your data in ~/.hermes and ~/Library/Application Support/iclone os was kept.")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="icloneos",
        description="Install and run the iclone os desktop app (macOS, Apple silicon). Never uses sudo.",
        allow_abbrev=False,
    )
    parser.add_argument("--version", "-v", action="version", version=__version__)
    verbs = parser.add_subparsers(dest="verb", metavar="{install,launch,update,uninstall}")
    for verb in ("install", "launch", "update", "uninstall"):
        sub = verbs.add_parser(verb, allow_abbrev=False)
        where = sub.add_mutually_exclusive_group()
        where.add_argument("--dest", type=Path, help="install folder (default ~/Applications)")
        where.add_argument("--system", action="store_true", help="use /Applications")
        if verb == "install":
            sub.add_argument("--force", action="store_true", help="reinstall even if current")
            sub.add_argument(
                "--allow-downgrade", action="store_true", help="install even if older than the installed app"
            )
        if verb == "uninstall":
            sub.add_argument("--force", action="store_true", help="remove even if the signature does not check out")
    return parser


def main(argv: Optional[Sequence[str]] = None, sys_: Optional[System] = None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        code = exit_.code if isinstance(exit_.code, int) else 64
        return 0 if code == 0 else 64
    if args.verb is None:
        parser.print_help()
        return 0
    system = sys_ or System()
    dest: Optional[Path] = system.system_apps_dir if args.system else args.dest

    def log(line: str) -> None:
        print(line, file=sys.stderr)

    def terminate(_signum: int, _frame: object) -> None:
        raise Terminated()

    previous_term = signal.signal(signal.SIGTERM, terminate)
    try:
        if args.verb == "install":
            install(system, dest, args.force, log, allow_downgrade=args.allow_downgrade)
        elif args.verb == "update":
            update(system, dest, log)
        elif args.verb == "launch":
            launch(system, dest, log)
        else:
            uninstall(system, dest, log, force=args.force)
        return 0
    except (KeyboardInterrupt, Terminated) as stop:
        print("icloneos: interrupted — nothing half-installed: the app in place is either the one you had or the fully verified new one.", file=sys.stderr)
        return 143 if isinstance(stop, Terminated) else 130
    except Refusal as refusal:
        print(f"icloneos: refused — {refusal}", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 — top-level boundary
        print(f"icloneos: failed — {error}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_term)


def entry_point() -> None:
    raise SystemExit(main())
