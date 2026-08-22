import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import macos_deployment_target


class MacosDeploymentTargetTest(unittest.TestCase):
    def test_reads_the_single_target_floor(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bazelrc = Path(temp_dir) / ".bazelrc"
            bazelrc.write_text(
                "build --macos_minimum_os=13.0\n",
                encoding="utf-8",
            )
            self.assertEqual(
                macos_deployment_target.read_deployment_target(bazelrc),
                "13.0",
            )

    def test_rendered_plist_uses_configured_floor(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base = root / "Info.plist"
            output = root / "Rendered.plist"
            with base.open("wb") as base_file:
                plistlib.dump({"CFBundleName": "Kanna"}, base_file)

            macos_deployment_target.render_plist(base, output, "13.0")

            with output.open("rb") as output_file:
                self.assertEqual(
                    plistlib.load(output_file)["LSMinimumSystemVersion"],
                    "13.0",
                )

    def test_rejects_binary_with_higher_minos(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = Path(temp_dir) / "Kanna.app"
            binary = app / "Contents" / "MacOS" / "kanna-desktop"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"synthetic Mach-O fixture")
            with (app / "Contents" / "Info.plist").open("wb") as info_file:
                plistlib.dump({"LSMinimumSystemVersion": "13.0"}, info_file)

            def run(
                command: list[str], **_kwargs: object
            ) -> subprocess.CompletedProcess[str]:
                if command[:2] == ["/usr/bin/file", "--brief"]:
                    if command[-1].endswith("Info.plist"):
                        return subprocess.CompletedProcess(
                            command, 0, "XML 1.0 document text\n", ""
                        )
                    return subprocess.CompletedProcess(
                        command, 0, "Mach-O 64-bit executable arm64\n", ""
                    )
                if command[:3] == ["xcrun", "vtool", "-show-build"]:
                    return subprocess.CompletedProcess(
                        command,
                        0,
                        "Load command 10\n"
                        "      cmd LC_BUILD_VERSION\n"
                        "    minos 26.5\n"
                        "      sdk 26.5\n",
                        "",
                    )
                self.fail(f"unexpected command: {command}")

            with self.assertRaisesRegex(
                macos_deployment_target.DeploymentTargetError,
                r"minos 26\.5; expected 13\.0",
            ):
                macos_deployment_target.verify_app(app, "13.0", run)

    def test_accepts_every_matching_macho_slice(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = Path(temp_dir) / "Kanna.app"
            binary = app / "Contents" / "MacOS" / "kanna-desktop"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"synthetic universal Mach-O fixture")
            with (app / "Contents" / "Info.plist").open("wb") as info_file:
                plistlib.dump({"LSMinimumSystemVersion": "13.0"}, info_file)

            run = Mock(
                side_effect=[
                    subprocess.CompletedProcess(
                        [], 0, "XML 1.0 document text\n", ""
                    ),
                    subprocess.CompletedProcess(
                        [], 0, "Mach-O universal binary\n", ""
                    ),
                    subprocess.CompletedProcess(
                        [],
                        0,
                        "architecture arm64\n"
                        "    minos 13.0\n"
                        "architecture x86_64\n"
                        "    minos 13.0\n",
                        "",
                    ),
                ]
            )
            macos_deployment_target.verify_app(app, "13.0", run)


if __name__ == "__main__":
    unittest.main()
