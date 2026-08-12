import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("build_macos_notarized_dmg.py")
REPO_ROOT = SCRIPT.parents[2]


class BuildMacosNotarizedDmgTest(unittest.TestCase):
    def test_notarize_config_forwards_only_non_secret_keychain_selectors(self) -> None:
        bazelrc = (REPO_ROOT / ".bazelrc").read_text(encoding="utf-8")

        self.assertIn(
            "build:notarize --action_env=APPLE_KEYCHAIN_PROFILE", bazelrc
        )
        self.assertIn(
            "build:notarize --action_env=APPLE_KEYCHAIN_PATH", bazelrc
        )
        self.assertNotIn("build:notarize --action_env=APPLE_PASSWORD", bazelrc)
        self.assertNotIn("build:notarize --action_env=APPLE_ID", bazelrc)

    def test_action_runner_forwards_profile_and_explicit_keychain(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            log_path = root / "xcrun.log"
            fake_xcrun = bin_dir / "xcrun"
            fake_xcrun.write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$KANNA_NOTARY_TEST_LOG\"\n",
                encoding="utf-8",
            )
            fake_xcrun.chmod(fake_xcrun.stat().st_mode | stat.S_IXUSR)

            source_dmg = root / "signed.dmg"
            output_dmg = root / "notarized.dmg"
            keychain = root / "login.keychain-db"
            source_dmg.write_text("signed dmg", encoding="utf-8")
            keychain.write_text("disposable keychain fixture", encoding="utf-8")
            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
                "APPLE_KEYCHAIN_PROFILE": "fixture-profile",
                "APPLE_KEYCHAIN_PATH": str(keychain),
                "KANNA_NOTARY_TEST_LOG": str(log_path),
            }

            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--dmg",
                    str(source_dmg),
                    "--output",
                    str(output_dmg),
                ],
                check=True,
                env=env,
            )

            self.assertEqual(output_dmg.read_text(encoding="utf-8"), "signed dmg")
            self.assertEqual(
                log_path.read_text(encoding="utf-8").splitlines(),
                [
                    f"notarytool submit {output_dmg.resolve()} --wait --keychain-profile fixture-profile --keychain {keychain}",
                    f"stapler staple {output_dmg.resolve()}",
                    f"stapler validate {output_dmg.resolve()}",
                ],
            )

    def test_action_runner_rejects_missing_keychain_before_notarytool(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_dmg = root / "signed.dmg"
            source_dmg.write_text("signed dmg", encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--dmg",
                    str(source_dmg),
                    "--output",
                    str(root / "notarized.dmg"),
                ],
                check=False,
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "APPLE_KEYCHAIN_PROFILE": "fixture-profile",
                    "APPLE_KEYCHAIN_PATH": str(root / "missing.keychain-db"),
                },
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("configured notarization keychain does not exist", result.stderr)


if __name__ == "__main__":
    unittest.main()
