import hashlib
import json
import os
import shutil
import signal
import tempfile
import unittest
from pathlib import Path
from typing import Callable, List, Optional, Sequence
from unittest import mock

from icloneos import cli
from icloneos.cli import APP_BUNDLE_NAME, BUNDLE_ID, TEAM_ID, Refusal, RunResult, System

APPLE_ROOT_CA_PEM = (Path(__file__).parent / "fixtures" / "apple-root-ca.crt").read_text().strip()
OTHER_ROOT_PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"


def signer_report(team: str, issuer_cn: str = "Developer ID Certification Authority", marker: bool = True,
                  cn: Optional[str] = None) -> str:
    lines = ["Certificate:", "    Data:"]
    if marker:
        lines.append("            1.2.840.113635.100.6.1.13: critical")
    lines += ["subject= ", f"    UID={team}", f"    CN={cn or f'Developer ID Application: T ({team})'}",
              f"    OU={team}", "    O=T", "issuer= ", f"    CN={issuer_cn}",
              "    OU=Apple Certification Authority", "    O=Apple Inc.", "    C=US", ""]
    return "\n".join(lines)


def write_fake_app(app: Path, bundle_id: str, version: str) -> None:
    (app / "Contents" / "MacOS").mkdir(parents=True, exist_ok=True)
    (app / "Contents" / "Info.plist").write_text(
        json.dumps({"CFBundleIdentifier": bundle_id, "CFBundleVersion": version})
    )


class Fake:
    def __init__(self, **scenario: object) -> None:
        self.s = scenario
        self.root = Path(tempfile.mkdtemp(prefix="icloneos-pytest-")).resolve()
        self.home = self.root / "home"
        self.tmp = self.root / "tmp"
        self.home.mkdir()
        self.tmp.mkdir()
        self.dest = self.home / "Applications"
        self.calls: List[Sequence[str]] = []
        self.fetched: List[str] = []
        self.feed_version = str(scenario.get("feed_version", "0.0.3"))
        self.dmg = b"genuine iclone os disk image"
        self.published = hashlib.sha256(self.dmg).hexdigest()
        self.system = System(
            run=self.run,
            fetch_text=self.fetch_text,
            download=self.download,
            home=self.home,
            system_apps_dir=self.root / "Applications",
            tmp_root=self.tmp,
            platform=str(scenario.get("platform", "darwin")),
            arch="arm64",
            uid=int(scenario.get("uid", 501)),  # type: ignore[call-overload]
        )

    def fetch_text(self, url: str) -> str:
        self.fetched.append(url)
        if url.endswith("/latest-mac.yml"):
            return f"version: {self.feed_version}\nfiles: []\n"
        return f"{self.published}  iclone-os-mac-arm64.dmg\n"

    def download(self, url: str, destination: Path) -> None:
        self.fetched.append(url)
        if url.endswith("/SHA256SUMS.txt.sig"):
            destination.write_bytes(b"cms")
            return
        destination.write_bytes(self.s.get("delivered", self.dmg))  # type: ignore[arg-type]

    def run(self, command: str, args: Sequence[str]) -> RunResult:
        self.calls.append([command, *args])
        hook = self.s.get("on_command")
        if callable(hook):
            hook(command, args)
        last = args[-1] if args else ""
        is_dmg = last.endswith(".dmg")
        if command == "codesign":
            if args[0] == "--verify":
                ok = self.s.get("dmg_valid" if is_dmg else "app_valid", True)
                return RunResult(0 if ok else 1, "", "")
            team = self.s.get("dmg_team" if is_dmg else "app_team", TEAM_ID)
            ident = "iclone-os-mac-arm64" if is_dmg else self.s.get("app_bundle_id", BUNDLE_ID)
            report = f"Identifier={ident}\nAuthority=Developer ID Application: T ({team})\nTeamIdentifier={team}\n"
            return RunResult(0, "", report)
        if command == "spctl":
            ok = self.s.get("dmg_notarised" if is_dmg else "app_notarised", True)
            return RunResult(0, "", "source=Notarized Developer ID") if ok else RunResult(3, "", "rejected")
        if command == "hdiutil":
            if args[0] == "attach":
                mount = Path(args[args.index("-mountpoint") + 1])
                write_fake_app(
                    mount / APP_BUNDLE_NAME,
                    str(self.s.get("app_bundle_id", BUNDLE_ID)),
                    str(self.s.get("app_version", self.feed_version)),
                )
                # attach_code: hdiutil mounted the image but still answered with an error.
                return RunResult(int(self.s.get("attach_code", 0)), "", "")  # type: ignore[call-overload]
            else:
                # detach_codes: what each detach answers in turn (a busy volume refuses the plain one).
                codes = self.s.setdefault("detach_codes", [])
                code = int(codes.pop(0)) if codes else 0  # type: ignore[union-attr]
                if code != 0:
                    return RunResult(code, "", "resource busy")
                for child in Path(args[1]).iterdir():
                    shutil.rmtree(child)
            return RunResult(0, "", "")
        if command == "ditto":
            shutil.copytree(args[0], args[1])
            return RunResult(0, "", "")
        if command == "plutil":
            try:
                value = json.loads(Path(last).read_text()).get(args[1])
            except OSError:
                return RunResult(1, "", "")
            return RunResult(0, f"{value}\n", "") if isinstance(value, str) else RunResult(1, "", "")
        if command == "pgrep":
            return RunResult(0 if self.s.get("running") else 1, "", "")
        if command == "open":
            return RunResult(0, "", "")
        if command == "security":
            roots = [OTHER_ROOT_PEM] if self.s.get("root_missing") else [OTHER_ROOT_PEM, APPLE_ROOT_CA_PEM]
            return RunResult(0, "\n".join(roots) + "\n", "")
        if command == "openssl":
            if args[0] == "smime":
                if self.s.get("smime_fails"):
                    return RunResult(4, "", "Verification failure")
                Path(args[args.index("-signer") + 1]).write_text((OTHER_ROOT_PEM + "\n") * int(self.s.get("signers", 1)))  # type: ignore[call-overload]
                return RunResult(0, "", "Verification successful")
            return RunResult(0, str(self.s.get("signer_report", signer_report(TEAM_ID))), "")
        raise AssertionError(command)

    def listing(self) -> List[str]:
        return sorted(p.name for p in self.dest.iterdir()) if self.dest.exists() else []

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


def quiet(_: str) -> None:
    pass


class InstallTests(unittest.TestCase):
    def fake(self, **scenario: object) -> Fake:
        fake = Fake(**scenario)
        self.addCleanup(fake.cleanup)
        return fake

    def assertRefused(self, pattern: str, fake: Fake, force: bool = False, dest: Optional[Path] = None) -> None:
        with self.assertRaisesRegex(Refusal, pattern):
            cli.install(fake.system, dest, force, quiet)

    def test_happy_path(self) -> None:
        fake = self.fake()
        path = cli.install(fake.system, None, False, quiet)
        self.assertEqual(path, fake.dest / APP_BUNDLE_NAME)
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])
        self.assertEqual(list(fake.tmp.iterdir()), [])
        self.assertTrue(fake.fetched[2].endswith("/releases/download/v0.0.3/iclone-os-mac-arm64.dmg"))

    def test_k81_attach_error_still_detaches(self) -> None:
        fake = self.fake(attach_code=1)
        self.assertRefused("could not mount", fake)
        self.assertEqual([call[1] for call in fake.calls if call[0] == "hdiutil"], ["attach", "detach"])
        self.assertEqual(fake.listing(), [])
        self.assertEqual(list(fake.tmp.iterdir()), [])

    def test_k81_staging_failure_mounts_nothing(self) -> None:
        fake = self.fake()

        def lock_dest(_command: str, args: Sequence[str]) -> None:
            # The last disk-image check: from here on the destination refuses new folders.
            if args and args[-1].endswith(".dmg"):
                fake.dest.chmod(0o500)

        fake.s["on_command"] = lock_dest
        try:
            with self.assertRaises(OSError):
                cli.install(fake.system, None, False, quiet)
        finally:
            fake.dest.chmod(0o700)
        self.assertFalse(any(call[0] == "hdiutil" for call in fake.calls))
        self.assertEqual(list(fake.tmp.iterdir()), [])

    def test_tampered_dmg_refused_before_mount(self) -> None:
        fake = self.fake(delivered=b"tampered")
        self.assertRefused("does not match the published SHA256SUMS", fake)
        self.assertFalse(any(call[0] == "hdiutil" for call in fake.calls))
        self.assertEqual(fake.listing(), [])

    def test_codesign_failure_refused(self) -> None:
        fake = self.fake(app_valid=False)
        self.assertRefused("code signature of the app bundle is invalid", fake)
        self.assertEqual(fake.listing(), [])

    def test_dmg_codesign_failure_refused(self) -> None:
        self.assertRefused("code signature of the disk image", self.fake(dmg_valid=False))

    def test_not_notarised_refused(self) -> None:
        fake = self.fake(app_notarised=False)
        self.assertRefused("Gatekeeper does not accept the app bundle", fake)
        self.assertEqual(fake.listing(), [])

    def test_wrong_team_refused(self) -> None:
        self.assertRefused("signed by team ZZZZZZZZZZ", self.fake(app_team="ZZZZZZZZZZ"))

    def test_wrong_bundle_id_refused(self) -> None:
        self.assertRefused("identifies as com.evil", self.fake(app_bundle_id="com.evil"))

    def test_version_mismatch_refused(self) -> None:
        self.assertRefused("reports version 0.0.1", self.fake(app_version="0.0.1"))

    def test_root_refused(self) -> None:
        self.assertRefused("root or with sudo", self.fake(uid=0))

    def test_foreign_app_never_replaced(self) -> None:
        fake = self.fake()
        write_fake_app(fake.dest / APP_BUNDLE_NAME, "com.other", "9.9")
        self.assertRefused("is not iclone os", fake, force=True)

    def test_update_keeps_old_app_on_failure(self) -> None:
        fake = self.fake(feed_version="0.0.4", app_notarised=False)
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        with self.assertRaises(Refusal):
            cli.update(fake.system, None, quiet)
        plist = json.loads((fake.dest / APP_BUNDLE_NAME / "Contents" / "Info.plist").read_text())
        self.assertEqual(plist["CFBundleVersion"], "0.0.3")
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])

    def test_update_replaces_older(self) -> None:
        fake = self.fake(feed_version="0.0.4")
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        cli.update(fake.system, None, quiet)
        plist = json.loads((fake.dest / APP_BUNDLE_NAME / "Contents" / "Info.plist").read_text())
        self.assertEqual(plist["CFBundleVersion"], "0.0.4")

    def test_launch_and_uninstall(self) -> None:
        fake = self.fake()
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        cli.launch(fake.system, None, quiet)
        self.assertEqual(fake.calls[-1], ["open", str(fake.dest / APP_BUNDLE_NAME)])
        cli.uninstall(fake.system, None, quiet)
        self.assertEqual(fake.listing(), [])


def version_of(app: Path) -> str:
    return str(json.loads((app / "Contents" / "Info.plist").read_text())["CFBundleVersion"])


class SafetyTests(unittest.TestCase):
    def fake(self, **scenario: object) -> Fake:
        fake = Fake(**scenario)
        self.addCleanup(fake.cleanup)
        return fake

    # --- rollback floor and downgrade (M2) ---
    def test_floor_refuses_old_feed_even_with_every_flag(self) -> None:
        fake = self.fake(feed_version="0.0.1")
        with self.assertRaisesRegex(Refusal, "offers 0.0.1, below the minimum supported version 0.0.3"):
            cli.install(fake.system, None, True, quiet, allow_downgrade=True)
        self.assertEqual(len(fake.fetched), 1)

    def test_downgrade_refused_then_allowed(self) -> None:
        fake = self.fake(feed_version="0.0.3")
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.4")
        for force in (False, True):
            with self.assertRaisesRegex(Refusal, "0.0.4 is installed .* older 0.0.3; pass --allow-downgrade"):
                cli.install(fake.system, None, force, quiet)
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.4")
        self.assertFalse(any(url.endswith(".dmg") for url in fake.fetched))
        cli.install(fake.system, None, False, quiet, allow_downgrade=True)
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.3")

    def test_update_never_downgrades(self) -> None:
        fake = self.fake(feed_version="0.0.3")
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.4")
        cli.update(fake.system, None, quiet)
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.4")

    def test_feed_version_is_ascii_only(self) -> None:
        with self.assertRaises(Refusal):
            cli.parse_feed_version("version: \u0660.\u0660.\u0662\n")

    # --- interrupted runs (M1) ---
    def _signal_on(self, command: str, nth: int, signum: int) -> Callable[[str, Sequence[str]], None]:
        seen = [0]

        def hook(cmd: str, _args: Sequence[str]) -> None:
            if cmd == command:
                seen[0] += 1
                if seen[0] == nth:
                    os.kill(os.getpid(), signum)

        return hook

    def test_sigint_before_swap_keeps_old_app(self) -> None:
        fake = self.fake(feed_version="0.0.4", on_command=self._signal_on("pgrep", 2, signal.SIGINT))
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        self.assertEqual(cli.main(["update", "--dest", str(fake.dest)], fake.system), 130)
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.3")
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])
        self.assertEqual(list(fake.tmp.iterdir()), [])

    def test_sigterm_during_copy_keeps_old_app(self) -> None:
        fake = self.fake(feed_version="0.0.4", on_command=self._signal_on("ditto", 1, signal.SIGTERM))
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        self.assertEqual(cli.main(["update", "--dest", str(fake.dest)], fake.system), 143)
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.3")
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])

    def test_sigint_during_the_mount_detach_still_force_detaches(self) -> None:
        """V3-K critic r1 m5: the detach runs with SIGINT held (K81). A SIGINT that lands while the plain detach is
        refused must not cut off the forced one, or the verified image stays mounted."""
        fake = self.fake(
            feed_version="0.0.4",
            detach_codes=[16],
            on_command=self._signal_on("hdiutil", 2, signal.SIGINT),
        )
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        self.assertEqual(cli.main(["update", "--dest", str(fake.dest)], fake.system), 130)
        detaches = [call[1:] for call in fake.calls if call[0] == "hdiutil" and call[1] == "detach"]
        self.assertEqual(len(detaches), 2)
        self.assertIn("-force", detaches[1])
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.3")

    def test_sigint_between_the_two_renames_never_loses_an_app(self) -> None:
        fake = self.fake(feed_version="0.0.4")
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        real_rename = os.rename
        calls = [0]

        def rename(src: object, dst: object) -> None:
            real_rename(src, dst)  # type: ignore[arg-type]
            calls[0] += 1
            if calls[0] == 1:
                os.kill(os.getpid(), signal.SIGINT)

        with mock.patch.object(cli.os, "rename", rename):
            code = cli.main(["update", "--dest", str(fake.dest)], fake.system)
        self.assertEqual(code, 130)
        # The signal is held until the swap finishes, so the run ends on a complete, verified new app.
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.4")
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])

    def test_second_rename_failure_restores_old_app(self) -> None:
        fake = self.fake(feed_version="0.0.4")
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        real_rename = os.rename
        calls = [0]

        def rename(src: object, dst: object) -> None:
            calls[0] += 1
            if calls[0] == 2:
                raise OSError("disk full")
            real_rename(src, dst)  # type: ignore[arg-type]

        with mock.patch.object(cli.os, "rename", rename), self.assertRaises(OSError):
            cli.update(fake.system, None, quiet)
        self.assertEqual(version_of(fake.dest / APP_BUNDLE_NAME), "0.0.3")
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])

    def test_stranded_app_is_restored_by_the_next_run(self) -> None:
        fake = self.fake()
        write_fake_app(fake.dest / ".icloneos-staging-AbC" / "previous.app", BUNDLE_ID, "0.0.3")
        lines: List[str] = []
        cli.launch(fake.system, None, lines.append)
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])
        self.assertIn("Restored iclone os", "\n".join(lines))

    # --- symlinks, launch, uninstall (L5, L8, L9) ---
    def test_symlinked_app_is_refused_by_every_verb(self) -> None:
        for verb in ("install", "update", "launch", "uninstall"):
            with self.subTest(verb=verb):
                fake = self.fake(feed_version="0.0.4")
                real = fake.home / "elsewhere" / APP_BUNDLE_NAME
                write_fake_app(real, BUNDLE_ID, "0.0.3")
                fake.dest.mkdir(parents=True)
                (fake.dest / APP_BUNDLE_NAME).symlink_to(real)
                action = {
                    "install": lambda: cli.install(fake.system, None, True, quiet),
                    "update": lambda: cli.update(fake.system, None, quiet),
                    "launch": lambda: cli.launch(fake.system, None, quiet),
                    "uninstall": lambda: cli.uninstall(fake.system, None, quiet, force=True),
                }[verb]
                with self.assertRaisesRegex(Refusal, "is a symbolic link; icloneos will not follow, replace or remove it"):
                    action()
                self.assertEqual(version_of(real), "0.0.3")
                self.assertTrue((fake.dest / APP_BUNDLE_NAME).is_symlink())
                self.assertEqual(cli.main(["uninstall", "--dest", str(fake.dest)], fake.system), 2)

    def test_launch_reverifies_signature(self) -> None:
        fake = self.fake(app_valid=False)
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        with self.assertRaisesRegex(Refusal, "code signature of the app bundle is invalid"):
            cli.launch(fake.system, None, quiet)
        self.assertFalse(any(call[0] == "open" for call in fake.calls))

    def test_uninstall_requires_our_signature_unless_forced(self) -> None:
        fake = self.fake(app_team="ZZZZZZZZZZ")
        write_fake_app(fake.dest / APP_BUNDLE_NAME, BUNDLE_ID, "0.0.3")
        with self.assertRaisesRegex(Refusal, "does not carry a valid iclone os signature .*pass --force"):
            cli.uninstall(fake.system, None, quiet)
        self.assertEqual(fake.listing(), [APP_BUNDLE_NAME])
        self.assertEqual(cli.main(["uninstall", "--force", "--dest", str(fake.dest)], fake.system), 0)
        self.assertEqual(fake.listing(), [])

    # --- signed SHA256SUMS (M2b, feature flag) ---
    def test_signed_sums_flag_is_off_and_root_pin_is_real(self) -> None:
        self.assertFalse(cli.REQUIRE_SIGNED_SUMS)
        self.assertEqual(cli.pem_fingerprint(APPLE_ROOT_CA_PEM), cli.APPLE_ROOT_CA_SHA256)

    def test_signed_sums_accepted_when_on(self) -> None:
        fake = self.fake()
        self.assertEqual(cli.resolve_latest_release(fake.system, require_signed_sums=True).version, "0.0.3")
        self.assertTrue(fake.fetched[-1].endswith("/releases/download/v0.0.3/SHA256SUMS.txt.sig"))
        self.assertEqual(list(fake.tmp.iterdir()), [])

    def test_signed_sums_hostile_cases(self) -> None:
        cases = {
            "signature on SHA256SUMS.txt is invalid": {"smime_fails": True},
            "root certificate was not found": {"root_missing": True},
            "exactly one signer, not 2": {"signers": 2},
            "signed by team ZZZZZZZZZZ": {"signer_report": signer_report("ZZZZZZZZZZ")},
            "Developer ID authority": {"signer_report": signer_report(TEAM_ID, issuer_cn="Apple Worldwide Developer Relations Certification Authority")},
            "not signed with a Developer ID Application": {"signer_report": signer_report(TEAM_ID, marker=False)},
        }
        for reason, scenario in cases.items():
            with self.subTest(reason=reason):
                fake = self.fake(**scenario)
                with self.assertRaisesRegex(Refusal, reason):
                    cli.resolve_latest_release(fake.system, require_signed_sums=True)
                self.assertEqual(list(fake.tmp.iterdir()), [])


class ParsingTests(unittest.TestCase):
    def test_feed_and_sums(self) -> None:
        self.assertEqual(cli.parse_feed_version("version: 0.0.2\n"), "0.0.2")
        with self.assertRaises(Refusal):
            cli.parse_feed_version("version: ../x\n")
        with self.assertRaises(Refusal):
            cli.parse_sha256_sums(f"{'0' * 64}  a\n{'1' * 64}  a\n")
        self.assertEqual(cli.compare_versions("0.0.10", "0.0.9"), 1)

    def test_url_allowlist(self) -> None:
        cli.assert_allowed_url("https://release-assets.githubusercontent.com/x")
        with self.assertRaises(Refusal):
            cli.assert_allowed_url("https://github.com.evil.example/x")
        with self.assertRaises(Refusal):
            cli.assert_allowed_url("http://github.com/x")

    def test_cli_exit_codes(self) -> None:
        fake = Fake()
        self.addCleanup(fake.cleanup)
        self.assertEqual(cli.main(["frobnicate"], fake.system), 64)
        self.assertEqual(cli.main(["install", "--dest", "/x", "--system"], fake.system), 64)
        self.assertEqual(cli.main(["launch"], fake.system), 2)


class ReleaseRepositoryTests(unittest.TestCase):
    def test_every_url_names_devclone20_icloneos_only(self) -> None:
        self.assertEqual(cli.REPOSITORY, "devclone20/icloneos")
        self.assertEqual(
            cli.latest_asset_url("latest-mac.yml"),
            "https://github.com/devclone20/icloneos/releases/latest/download/latest-mac.yml",
        )
        self.assertEqual(
            cli.tagged_asset_url("0.0.3", cli.DMG_FILE),
            "https://github.com/devclone20/icloneos/releases/download/v0.0.3/iclone-os-mac-arm64.dmg",
        )
        # The earlier releases repo is archived: the shim never names it (spelled in halves so this file is no hit).
        archived = "-".join(["iclone-os", "releases"])
        self.assertNotIn(archived, Path(cli.__file__).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
