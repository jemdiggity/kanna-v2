import contextlib
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_macos_dmg


class BuildMacosDmgTest(unittest.TestCase):
    def test_parse_args_accepts_finder_cosmetic_options(self) -> None:
        argv = [
            "build_macos_dmg.py",
            "--app",
            "/tmp/Kanna.app",
            "--output",
            "/tmp/Kanna.dmg",
            "--volume-name",
            "Kanna",
            "--volume-icon",
            "/tmp/Kanna.icns",
            "--window-pos",
            "20,80",
            "--window-size",
            "640,480",
            "--icon-size",
            "96",
            "--text-size",
            "12",
            "--icon-position",
            "Kanna.app:160,175",
            "--icon-position",
            "Applications:352,175",
            "--include-applications-link",
        ]
        with mock.patch.object(sys, "argv", argv):
            args = build_macos_dmg.parse_args()

        self.assertEqual(args.volume_icon, "/tmp/Kanna.icns")
        self.assertEqual(args.window_pos, "20,80")
        self.assertEqual(args.window_size, "640,480")
        self.assertEqual(args.icon_size, 96)
        self.assertEqual(args.text_size, 12)
        self.assertEqual(
            args.icon_position,
            ["Kanna.app:160,175", "Applications:352,175"],
        )
        self.assertTrue(args.include_applications_link)

    def test_parse_pair_rejects_invalid_coordinates(self) -> None:
        with self.assertRaisesRegex(SystemExit, "invalid window position"):
            build_macos_dmg.parse_pair("10", "window position")

    def test_parse_mount_dir_extracts_hdiutil_mount_path(self) -> None:
        attach_output = (
            "/dev/disk4\tGUID_partition_scheme\t\n"
            "/dev/disk4s1\tApple_HFS\t/Volumes/dmg.CMLAUG\n"
        )
        self.assertEqual(
            build_macos_dmg.parse_mount_dir(attach_output),
            Path("/Volumes/dmg.CMLAUG"),
        )

    def test_parse_icon_positions_rejects_missing_separator(self) -> None:
        with self.assertRaises(SystemExit):
            build_macos_dmg.parse_icon_positions(["Kanna.app:160"])

    def test_parse_icon_positions_parses_named_coordinates(self) -> None:
        self.assertEqual(
            build_macos_dmg.parse_icon_positions(
                ["Kanna.app:160,175", "Applications:352,175"]
            ),
            {
                "Kanna.app": (160, 175),
                "Applications": (352, 175),
            },
        )

    def test_build_applescript_includes_window_and_icon_clauses(self) -> None:
        script = build_macos_dmg.build_applescript(
            mount_dir=Path("/Volumes/Kanna"),
            window_pos=(10, 60),
            window_size=(500, 350),
            icon_size=128,
            text_size=16,
            icon_positions={
                "Kanna.app": (160, 175),
                "Applications": (352, 175),
            },
        )
        self.assertIn('set position of item "Kanna.app" to {160, 175}', script)
        self.assertIn('set position of item "Applications" to {352, 175}', script)
        self.assertIn("set icon size to 128", script)
        self.assertIn('set dsStorePath to "/Volumes/Kanna/.DS_Store"', script)

    def test_build_applescript_uses_actual_mount_dir_when_volume_name_collides(self) -> None:
        script = build_macos_dmg.build_applescript(
            mount_dir=Path("/Volumes/Kanna 1"),
            window_pos=(10, 60),
            window_size=(500, 350),
            icon_size=128,
            text_size=16,
            icon_positions={},
        )

        self.assertIn('set dsStorePath to "/Volumes/Kanna 1/.DS_Store"', script)
        self.assertNotIn('"/Volumes/" & volumeName', script)

    def test_read_finder_info_returns_zeroed_bytes_when_missing(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["xattr"], returncode=1, stdout="", stderr=""
        )
        with mock.patch.object(
            build_macos_dmg.subprocess, "run", return_value=completed
        ):
            self.assertEqual(
                build_macos_dmg.read_finder_info(Path("/tmp/missing")),
                bytes(build_macos_dmg.FINDER_INFO_LENGTH),
            )

    def test_set_finder_info_sets_file_type_and_custom_flag(self) -> None:
        existing = bytes.fromhex(
            "0000000000000000000000000000000000000000000000000000000000000000"
        )
        with mock.patch.object(
            build_macos_dmg, "read_finder_info", return_value=existing
        ):
            with mock.patch.object(build_macos_dmg, "run_checked") as run_checked:
                build_macos_dmg.set_finder_info(
                    Path("/tmp/Kanna"),
                    file_type=b"icnC",
                    finder_flags=build_macos_dmg.VOLUME_CUSTOM_ICON_FLAG,
                )

        run_checked.assert_called_once_with(
            [
                "xattr",
                "-wx",
                "com.apple.FinderInfo",
                "0000000069636e43040000000000000000000000000000000000000000000000",
                "/tmp/Kanna",
            ]
        )

    def test_mark_volume_icon_stages_icns_and_marks_volume(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mount_dir = root / "mount"
            mount_dir.mkdir()
            icon_path = root / "Kanna.icns"
            icon_path.write_text("icon-bytes", encoding="utf-8")

            with mock.patch.object(
                build_macos_dmg, "mark_staged_volume_icon"
            ) as mark_staged_volume_icon:
                build_macos_dmg.mark_volume_icon(mount_dir, icon_path)

            self.assertEqual(
                (mount_dir / ".VolumeIcon.icns").read_text(encoding="utf-8"),
                "icon-bytes",
            )
            mark_staged_volume_icon.assert_called_once_with(mount_dir)

    def test_mark_staged_volume_icon_marks_existing_icon_and_volume(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            mount_dir = Path(temp_dir)
            staged_icon = mount_dir / ".VolumeIcon.icns"
            staged_icon.write_text("icon-bytes", encoding="utf-8")

            with mock.patch.object(
                build_macos_dmg, "set_finder_info"
            ) as set_finder_info:
                build_macos_dmg.mark_staged_volume_icon(mount_dir)

            self.assertEqual(
                set_finder_info.call_args_list,
                [
                    mock.call(staged_icon, file_type=b"icnC"),
                    mock.call(
                        mount_dir,
                        finder_flags=build_macos_dmg.VOLUME_CUSTOM_ICON_FLAG,
                    ),
                ],
            )

    def test_copy_staged_item_preserves_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_file = root / "source.txt"
            source_file.write_text("kanna", encoding="utf-8")
            source_link = root / "Applications"
            source_link.symlink_to("/Applications")
            dest_link = root / "Applications.copy"
            build_macos_dmg.copy_staged_item(source_link, dest_link)
            self.assertTrue(dest_link.is_symlink())
            self.assertEqual(dest_link.readlink(), Path("/Applications"))

    def test_run_finder_layout_invokes_osascript_and_waits_for_ds_store(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            mount_dir = Path(temp_dir) / "Kanna 1"
            mount_dir.mkdir()
            ds_store_path = mount_dir / ".DS_Store"

            def fake_run(command, check=False, capture_output=False, text=False):
                self.assertEqual(command[0], "osascript")
                self.assertEqual(command[-1], "Kanna 1")
                ds_store_path.write_text("finder-layout", encoding="utf-8")
                return subprocess.CompletedProcess(
                    args=command, returncode=0, stdout="", stderr=""
                )

            with mock.patch.object(
                build_macos_dmg, "build_applescript", return_value="on run {}"
            ) as build_applescript:
                with mock.patch.object(
                    build_macos_dmg.subprocess, "run", side_effect=fake_run
                ) as subprocess_run:
                    build_macos_dmg.run_finder_layout(
                        mount_dir=mount_dir,
                        window_pos=(10, 60),
                        window_size=(500, 350),
                        icon_size=128,
                        text_size=16,
                        icon_positions={"Kanna.app": (160, 175)},
                    )

            build_applescript.assert_called_once_with(
                mount_dir=mount_dir,
                window_pos=(10, 60),
                window_size=(500, 350),
                icon_size=128,
                text_size=16,
                icon_positions={"Kanna.app": (160, 175)},
            )
            subprocess_run.assert_called_once()
            self.assertTrue(ds_store_path.exists())

    def test_run_finder_layout_surfaces_osascript_failure_details(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            mount_dir = Path(temp_dir) / "Kanna 1"
            mount_dir.mkdir()
            applescript_path = Path(temp_dir) / "layout.applescript"
            applescript_path.write_text("on run {}", encoding="utf-8")

            completed = subprocess.CompletedProcess(
                args=["osascript", str(applescript_path), "Kanna 1"],
                returncode=1,
                stdout="finder stdout",
                stderr="finder stderr",
            )

            with mock.patch.object(
                build_macos_dmg, "build_applescript", return_value="on run {}"
            ):
                with mock.patch.object(
                    build_macos_dmg.tempfile,
                    "NamedTemporaryFile",
                ) as named_tempfile:
                    handle = mock.MagicMock()
                    handle.write = mock.Mock()
                    handle.name = str(applescript_path)
                    named_tempfile.return_value.__enter__.return_value = handle
                    named_tempfile.return_value.__exit__.return_value = False
                    with mock.patch.object(
                        build_macos_dmg.subprocess, "run", return_value=completed
                    ):
                        with self.assertRaisesRegex(
                            RuntimeError,
                            "(?s)Finder layout failed for mounted volume 'Kanna 1' "
                            r"\(attempt 1/10\).*mount path: .*Kanna 1.*"
                            r"AppleScript path: .*layout\.applescript.*"
                            r"stderr:\nfinder stderr",
                        ):
                            build_macos_dmg.run_finder_layout(
                                mount_dir=mount_dir,
                                window_pos=(10, 60),
                                window_size=(500, 350),
                                icon_size=128,
                                text_size=16,
                                icon_positions={"Kanna.app": (160, 175)},
                            )

            self.assertTrue(applescript_path.exists())

    def test_finder_layout_lock_serializes_finder_access(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            lock_path = Path(temp_dir) / "finder-layout.lock"

            with mock.patch.object(build_macos_dmg.fcntl, "flock") as flock:
                with build_macos_dmg.finder_layout_lock(lock_path):
                    self.assertTrue(lock_path.exists())

            self.assertEqual(
                flock.call_args_list,
                [
                    mock.call(mock.ANY, build_macos_dmg.fcntl.LOCK_EX),
                    mock.call(mock.ANY, build_macos_dmg.fcntl.LOCK_UN),
                ],
            )

    def test_preflight_finder_volume_registration_uses_scratch_volume(self) -> None:
        attach_result = subprocess.CompletedProcess(
            args=["hdiutil", "attach"],
            returncode=0,
            stdout="/dev/disk8s1\tApple_HFS\t/Volumes/Kanna Finder Preflight 123\n",
            stderr="",
        )
        finder_result = subprocess.CompletedProcess(
            args=["osascript"], returncode=0, stdout="disk Kanna Finder Preflight 123", stderr=""
        )

        with mock.patch.object(build_macos_dmg.os, "getpid", return_value=123):
            with mock.patch.object(build_macos_dmg, "run_checked") as run_checked:
                with mock.patch.object(
                    build_macos_dmg.subprocess,
                    "run",
                    side_effect=[attach_result, finder_result],
                ) as subprocess_run:
                    build_macos_dmg.preflight_finder_volume_registration()

        create_command = run_checked.call_args_list[0].args[0]
        self.assertEqual(create_command[:2], ["hdiutil", "create"])
        self.assertIn("Kanna Finder Preflight 123", create_command)
        self.assertEqual(subprocess_run.call_args_list[0].args[0][:2], ["hdiutil", "attach"])
        self.assertEqual(subprocess_run.call_args_list[1].args[0][0], "osascript")
        self.assertEqual(
            run_checked.call_args_list[-1],
            mock.call(
                [
                    "hdiutil",
                    "detach",
                    "/Volumes/Kanna Finder Preflight 123",
                    "-quiet",
                ]
            ),
        )

    def test_preflight_finder_volume_registration_reports_wedged_finder(self) -> None:
        attach_result = subprocess.CompletedProcess(
            args=["hdiutil", "attach"],
            returncode=0,
            stdout="/dev/disk8s1\tApple_HFS\t/Volumes/Kanna Finder Preflight 123\n",
            stderr="",
        )
        finder_result = subprocess.CompletedProcess(
            args=["osascript"],
            returncode=1,
            stdout="",
            stderr="Finder got an error: Can’t get disk (-1728)",
        )

        with mock.patch.object(build_macos_dmg.os, "getpid", return_value=123):
            with mock.patch.object(build_macos_dmg, "run_checked") as run_checked:
                with mock.patch.object(
                    build_macos_dmg.subprocess,
                    "run",
                    side_effect=[attach_result, finder_result],
                ):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        r"Finder volume registration is wedged; relaunch Finder "
                        r"\(killall Finder\) and retry",
                    ):
                        build_macos_dmg.preflight_finder_volume_registration()

        self.assertEqual(run_checked.call_args_list[-1].args[0][:2], ["hdiutil", "detach"])

    def test_main_serializes_public_mount_when_custom_layout_is_requested(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            app_path = root / "Kanna.app"
            app_path.mkdir()
            output_path = root / "Kanna.dmg"
            mounted_dmg = root / "mounted.dmg"
            compressed_dmg = root / "compressed.dmg"
            private_mount_dir = root / "private-mount"
            public_mount_dir = root / "public-mount"

            real_tempdir = tempfile.TemporaryDirectory

            class FakeCompletedProcess:
                def __init__(self, stdout: str = "") -> None:
                    self.stdout = stdout
                    self.returncode = 0

            def fake_tempdir(*args, **kwargs):
                return real_tempdir(dir=root, *args, **kwargs)

            def fake_run(command, check=False, capture_output=False, text=False):
                if command[:2] == ["hdiutil", "create"]:
                    mounted_dmg.write_text("rw-image", encoding="utf-8")
                    return FakeCompletedProcess()
                if command[:2] == ["hdiutil", "attach"] and "-mountpoint" in command:
                    private_mount_dir.mkdir(exist_ok=True)
                    return FakeCompletedProcess()
                if command[:2] == ["hdiutil", "attach"] and capture_output:
                    public_mount_dir.mkdir(exist_ok=True)
                    return FakeCompletedProcess(
                        stdout=f"/dev/disk4s1\tApple_HFS\t{public_mount_dir}\n"
                    )
                if command[:2] == ["hdiutil", "detach"]:
                    return FakeCompletedProcess()
                if command[:2] == ["hdiutil", "convert"]:
                    Path(command[-1]).write_text("compressed", encoding="utf-8")
                    return FakeCompletedProcess()
                raise AssertionError(f"unexpected command: {command}")

            argv = [
                "build_macos_dmg.py",
                "--app",
                str(app_path),
                "--output",
                str(output_path),
                "--volume-name",
                "Kanna",
                "--icon-position",
                "Kanna.app:160,175",
            ]

            with mock.patch.object(sys, "argv", argv):
                with mock.patch.object(
                    build_macos_dmg.tempfile, "TemporaryDirectory", side_effect=fake_tempdir
                ):
                    with mock.patch.object(
                        build_macos_dmg.subprocess, "check_output", return_value="1\tstaging\n"
                    ):
                        with mock.patch.object(
                            build_macos_dmg.subprocess, "run", side_effect=fake_run
                        ):
                            with mock.patch.object(
                                build_macos_dmg, "finder_layout_lock", return_value=contextlib.nullcontext()
                            ) as finder_layout_lock:
                                with mock.patch.object(
                                    build_macos_dmg, "run_finder_layout"
                                ) as run_finder_layout:
                                    with mock.patch.object(
                                        build_macos_dmg,
                                        "preflight_finder_volume_registration",
                                    ) as finder_preflight:
                                        with mock.patch.object(
                                            build_macos_dmg.shutil,
                                            "move",
                                            side_effect=lambda src, dst: Path(dst).write_text(
                                                Path(src).read_text(encoding="utf-8"),
                                                encoding="utf-8",
                                            ),
                                        ):
                                            build_macos_dmg.main()

            finder_layout_lock.assert_called_once_with()
            finder_preflight.assert_called_once_with()
            run_finder_layout.assert_called_once_with(
                mount_dir=public_mount_dir,
                window_pos=(10, 60),
                window_size=(500, 350),
                icon_size=128,
                text_size=16,
                icon_positions={"Kanna.app": (160, 175)},
            )

    def test_main_skips_finder_layout_when_no_cosmetic_inputs_are_requested(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            app_path = root / "Kanna.app"
            app_path.mkdir()
            output_path = root / "Kanna.dmg"
            mounted_dmg = root / "mounted.dmg"
            compressed_dmg = root / "compressed.dmg"

            real_tempdir = tempfile.TemporaryDirectory

            class FakeCompletedProcess:
                def __init__(self, stdout: str = "") -> None:
                    self.stdout = stdout

            def fake_tempdir(*args, **kwargs):
                return real_tempdir(dir=root, *args, **kwargs)

            def fake_run(command, check=False, capture_output=False, text=False):
                if command[:2] == ["hdiutil", "attach"] and capture_output:
                    mount_dir = root / "public-mount"
                    mount_dir.mkdir(exist_ok=True)
                    return FakeCompletedProcess(
                        stdout=f"/dev/disk4s1\tApple_HFS\t{mount_dir}\n"
                    )
                if command[:2] == ["hdiutil", "create"]:
                    mounted_dmg.write_text("rw-image", encoding="utf-8")
                if command[:2] == ["hdiutil", "convert"]:
                    Path(command[-1]).write_text("compressed", encoding="utf-8")
                return FakeCompletedProcess()

            argv = [
                "build_macos_dmg.py",
                "--app",
                str(app_path),
                "--output",
                str(output_path),
                "--volume-name",
                "Kanna",
            ]

            with mock.patch.object(sys, "argv", argv):
                with mock.patch.object(
                    build_macos_dmg.tempfile, "TemporaryDirectory", side_effect=fake_tempdir
                ):
                    with mock.patch.object(
                        build_macos_dmg.subprocess, "check_output", return_value="1\tstaging\n"
                    ):
                        with mock.patch.object(
                            build_macos_dmg.subprocess, "run", side_effect=fake_run
                        ):
                            with mock.patch.object(
                                build_macos_dmg, "run_finder_layout"
                            ) as run_finder_layout:
                                with mock.patch.object(
                                    build_macos_dmg, "mark_volume_icon"
                                ) as mark_volume_icon:
                                    with mock.patch.object(
                                        build_macos_dmg.shutil,
                                        "move",
                                        side_effect=lambda src, dst: Path(dst).write_text(
                                            Path(src).read_text(encoding="utf-8"),
                                            encoding="utf-8",
                                        ),
                                    ):
                                        build_macos_dmg.main()

            run_finder_layout.assert_not_called()
            mark_volume_icon.assert_not_called()
            self.assertEqual(output_path.read_text(encoding="utf-8"), "compressed")


if __name__ == "__main__":
    unittest.main()
