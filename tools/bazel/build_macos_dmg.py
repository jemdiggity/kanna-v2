#!/usr/bin/env python3

import argparse
import contextlib
import fcntl
import os
import shlex
import shutil
import subprocess
import tempfile
import time
from typing import Optional
from pathlib import Path


DEFAULT_WINDOW_POS = (10, 60)
DEFAULT_WINDOW_SIZE = (500, 350)
DEFAULT_ICON_SIZE = 128
DEFAULT_TEXT_SIZE = 16
FINDER_INFO_LENGTH = 32
VOLUME_CUSTOM_ICON_FLAG = 0x0400
FINDER_LAYOUT_LOCK_PATH = Path("/tmp/kanna-build-macos-dmg-finder.lock")
FINDER_REGISTRATION_WEDGED_MESSAGE = (
    "Finder volume registration is wedged; relaunch Finder (killall Finder) and retry"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--volume-name", required=True)
    parser.add_argument("--volume-icon")
    parser.add_argument("--window-pos", default="10,60")
    parser.add_argument("--window-size", default="500,350")
    parser.add_argument("--icon-size", type=int, default=128)
    parser.add_argument("--text-size", type=int, default=16)
    parser.add_argument("--icon-position", action="append", default=[])
    parser.add_argument("--include-applications-link", action="store_true")
    return parser.parse_args()


def parse_pair(raw_value: str, label: str) -> tuple[int, int]:
    try:
        raw_x, raw_y = raw_value.split(",", 1)
        return (int(raw_x), int(raw_y))
    except ValueError as exc:
        raise SystemExit(f"invalid {label}: {raw_value}") from exc


def parse_icon_positions(entries: list[str]) -> dict[str, tuple[int, int]]:
    positions: dict[str, tuple[int, int]] = {}
    for entry in entries:
        try:
            name, raw_coords = entry.split(":", 1)
            raw_x, raw_y = raw_coords.split(",", 1)
        except ValueError as exc:
            raise SystemExit(f"invalid icon position: {entry}") from exc
        positions[name] = (int(raw_x), int(raw_y))
    return positions


def parse_mount_dir(attach_output: str) -> Path:
    for line in reversed(attach_output.splitlines()):
        fields = line.split("\t")
        if fields and fields[-1].startswith("/"):
            return Path(fields[-1])
    raise SystemExit("unable to determine mount directory from hdiutil attach output")


def copy_staged_item(source: Path, destination: Path) -> None:
    if source.is_symlink():
        os.symlink(os.readlink(source), destination)
    elif source.is_dir():
        shutil.copytree(source, destination, symlinks=False)
    else:
        shutil.copy2(source, destination, follow_symlinks=False)


def run_checked(command: list[str]) -> None:
    subprocess.run(command, check=True)


def applescript_string_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


@contextlib.contextmanager
def finder_layout_lock(lock_path: Optional[Path] = None):
    target_lock_path = lock_path or FINDER_LAYOUT_LOCK_PATH
    target_lock_path.parent.mkdir(parents=True, exist_ok=True)
    with target_lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def preflight_finder_volume_registration() -> None:
    volume_name = f"Kanna Finder Preflight {os.getpid()}"
    with tempfile.TemporaryDirectory(prefix="kanna-finder-preflight-") as temp_dir:
        image_path = Path(temp_dir) / "finder-preflight.dmg"
        run_checked(
            [
                "hdiutil",
                "create",
                "-size",
                "1m",
                "-fs",
                "HFS+",
                "-volname",
                volume_name,
                "-ov",
                str(image_path),
            ]
        )
        attach_result = subprocess.run(
            ["hdiutil", "attach", str(image_path), "-nobrowse"],
            check=True,
            capture_output=True,
            text=True,
        )
        mount_dir = parse_mount_dir(attach_result.stdout)
        try:
            finder_result = subprocess.run(
                [
                    "osascript",
                    "-e",
                    'on run argv\ntell application "Finder" to get disk (item 1 of argv)\nend run',
                    volume_name,
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if finder_result.returncode != 0:
                details = finder_result.stderr.strip() or finder_result.stdout.strip()
                message = FINDER_REGISTRATION_WEDGED_MESSAGE
                if details:
                    message = f"{message}\nFinder response: {details}"
                raise RuntimeError(message)
        finally:
            run_checked(["hdiutil", "detach", str(mount_dir), "-quiet"])


def mark_volume_icon(mount_dir: Path, icon_path: Path) -> None:
    staged_icon = mount_dir / ".VolumeIcon.icns"
    shutil.copy2(icon_path, staged_icon)
    mark_staged_volume_icon(mount_dir)


def mark_staged_volume_icon(mount_dir: Path) -> None:
    staged_icon = mount_dir / ".VolumeIcon.icns"
    if not staged_icon.exists():
        raise SystemExit(f"staged volume icon does not exist: {staged_icon}")
    set_finder_info(staged_icon, file_type=b"icnC")
    set_finder_info(mount_dir, finder_flags=VOLUME_CUSTOM_ICON_FLAG)


def read_finder_info(path: Path) -> bytes:
    result = subprocess.run(
        ["xattr", "-px", "com.apple.FinderInfo", str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return bytes(FINDER_INFO_LENGTH)
    hex_value = "".join(result.stdout.split())
    if not hex_value:
        return bytes(FINDER_INFO_LENGTH)
    finder_info = bytes.fromhex(hex_value)
    if len(finder_info) < FINDER_INFO_LENGTH:
        return finder_info.ljust(FINDER_INFO_LENGTH, b"\x00")
    return finder_info[:FINDER_INFO_LENGTH]


def set_finder_info(
    path: Path,
    *,
    file_type: Optional[bytes] = None,
    finder_flags: Optional[int] = None,
) -> None:
    finder_info = bytearray(read_finder_info(path))
    if file_type is not None:
        if len(file_type) != 4:
            raise SystemExit(f"Finder file type must be four bytes: {file_type!r}")
        finder_info[4:8] = file_type
    if finder_flags is not None:
        current_flags = int.from_bytes(finder_info[8:10], "big")
        finder_info[8:10] = (current_flags | finder_flags).to_bytes(2, "big")
    run_checked(
        [
            "xattr",
            "-wx",
            "com.apple.FinderInfo",
            finder_info.hex(),
            str(path),
        ]
    )


def build_applescript(
    *,
    mount_dir: Path,
    window_pos: tuple[int, int],
    window_size: tuple[int, int],
    icon_size: int,
    text_size: int,
    icon_positions: dict[str, tuple[int, int]],
) -> str:
    ds_store_path = applescript_string_literal(str(mount_dir / ".DS_Store"))
    position_lines = "\n".join(
        f'            set position of item "{name}" to {{{x}, {y}}}'
        for name, (x, y) in icon_positions.items()
    )
    return f"""on run (volumeName)
    tell application "Finder"
        tell disk (volumeName as string)
            open
            set theXOrigin to {window_pos[0]}
            set theYOrigin to {window_pos[1]}
            set theWidth to {window_size[0]}
            set theHeight to {window_size[1]}
            tell container window
                set current view to icon view
                set toolbar visible to false
                set statusbar visible to false
                set the bounds to {{theXOrigin, theYOrigin, theXOrigin + theWidth, theYOrigin + theHeight}}
            end tell
            tell the icon view options of container window
                set icon size to {icon_size}
                set text size to {text_size}
                set arrangement to not arranged
            end tell
{position_lines}
            close
            open
            delay 1
        end tell
        delay 1
        tell disk (volumeName as string)
            tell container window
                set statusbar visible to false
                set the bounds to {{theXOrigin, theYOrigin, theXOrigin + theWidth, theYOrigin + theHeight}}
            end tell
        end tell
        set dsStorePath to {ds_store_path}
        repeat 20 times
            if (do shell script "[ -f " & quoted form of dsStorePath & " ] && echo yes || echo no") is "yes" then
                return
            end if
            delay 0.5
        end repeat
    end tell
    error "Finder did not write .DS_Store for " & volumeName
end run
"""


def run_finder_layout(
    *,
    mount_dir: Path,
    window_pos: tuple[int, int],
    window_size: tuple[int, int],
    icon_size: int,
    text_size: int,
    icon_positions: dict[str, tuple[int, int]],
) -> None:
    script = build_applescript(
        mount_dir=mount_dir,
        window_pos=window_pos,
        window_size=window_size,
        icon_size=icon_size,
        text_size=text_size,
        icon_positions=icon_positions,
    )
    with tempfile.NamedTemporaryFile(
        "w", suffix=".applescript", delete=False
    ) as handle:
        handle.write(script)
        applescript_path = Path(handle.name)
    keep_applescript = False
    try:
        mounted_volume_name = mount_dir.name
        for attempt in range(1, 11):
            result = subprocess.run(
                ["osascript", str(applescript_path), mounted_volume_name],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                break
            stdout = result.stdout.strip()
            stderr = result.stderr.strip()
            if "(-1728)" not in result.stderr:
                keep_applescript = True
                message_lines = [
                    f"Finder layout failed for mounted volume '{mounted_volume_name}' (attempt {attempt}/10)",
                    f"mount path: {mount_dir}",
                    f"AppleScript path: {applescript_path}",
                    f"command: {shlex.join(result.args)}",
                    f"exit code: {result.returncode}",
                ]
                if stdout:
                    message_lines.extend(["stdout:", stdout])
                if stderr:
                    message_lines.extend(["stderr:", stderr])
                raise RuntimeError("\n".join(message_lines))
            time.sleep(1)
        else:
            keep_applescript = True
            raise RuntimeError(
                "\n".join(
                    [
                        f"Finder layout failed for mounted volume '{mounted_volume_name}' after 10 retries",
                        f"mount path: {mount_dir}",
                        f"AppleScript path: {applescript_path}",
                        "osascript continued returning Finder missing-item errors (-1728)",
                    ]
                )
            )
        ds_store_path = mount_dir / ".DS_Store"
        if not ds_store_path.exists():
            raise SystemExit(
                f"Finder did not write .DS_Store for mounted volume: {mount_dir}"
            )
    finally:
        if not keep_applescript:
            applescript_path.unlink(missing_ok=True)


def main() -> None:
    args = parse_args()

    app_path = Path(args.app).resolve()
    output_path = Path(args.output).resolve()
    window_pos = parse_pair(args.window_pos, "window position")
    window_size = parse_pair(args.window_size, "window size")
    icon_positions = parse_icon_positions(args.icon_position)
    volume_icon_path = Path(args.volume_icon).resolve() if args.volume_icon else None

    if not app_path.exists():
        raise SystemExit(f"app does not exist: {app_path}")
    if volume_icon_path is not None and not volume_icon_path.exists():
        raise SystemExit(f"volume icon does not exist: {volume_icon_path}")

    has_custom_layout = (
        volume_icon_path is not None
        or bool(icon_positions)
        or args.window_pos != f"{DEFAULT_WINDOW_POS[0]},{DEFAULT_WINDOW_POS[1]}"
        or args.window_size != f"{DEFAULT_WINDOW_SIZE[0]},{DEFAULT_WINDOW_SIZE[1]}"
        or args.icon_size != DEFAULT_ICON_SIZE
        or args.text_size != DEFAULT_TEXT_SIZE
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="kanna-dmg-") as temp_dir:
        staging_dir = Path(temp_dir) / "staging"
        staging_dir.mkdir()
        mounted_dmg = Path(temp_dir) / "mounted.dmg"
        compressed_dmg = Path(temp_dir) / "compressed.dmg"
        private_mount_dir = Path(temp_dir) / "mount"
        private_mount_dir.mkdir()

        staged_app = staging_dir / app_path.name
        shutil.copytree(app_path, staged_app, symlinks=False)

        if args.include_applications_link:
            os.symlink("/Applications", staging_dir / "Applications")
        du_output = subprocess.check_output(["du", "-sk", str(staging_dir)], text=True)
        staging_size_kb = int(du_output.split()[0])
        image_size_kb = max(10240, int(staging_size_kb * 1.25) + 10240)

        create_command = [
            "hdiutil",
            "create",
            "-size",
            f"{image_size_kb}k",
            "-fs",
            "HFS+",
            "-volname",
            args.volume_name,
            "-ov",
            str(mounted_dmg),
        ]
        run_checked(create_command)

        private_attach_command = [
            "hdiutil",
            "attach",
            str(mounted_dmg),
            "-mountpoint",
            str(private_mount_dir),
            "-readwrite",
            "-nobrowse",
            "-quiet",
        ]
        run_checked(private_attach_command)

        try:
            for child in staging_dir.iterdir():
                destination = private_mount_dir / child.name
                copy_staged_item(child, destination)
            if volume_icon_path is not None:
                mark_volume_icon(private_mount_dir, volume_icon_path)
        finally:
            run_checked(["hdiutil", "detach", str(private_mount_dir), "-quiet"])

        with finder_layout_lock():
            if has_custom_layout:
                preflight_finder_volume_registration()
            attach_command = [
                "hdiutil",
                "attach",
                str(mounted_dmg),
                "-readwrite",
                "-nobrowse",
            ]
            attach_result = subprocess.run(
                attach_command,
                check=True,
                capture_output=True,
                text=True,
            )
            mount_dir = parse_mount_dir(attach_result.stdout)

            try:
                if has_custom_layout:
                    run_finder_layout(
                        mount_dir=mount_dir,
                        window_pos=window_pos,
                        window_size=window_size,
                        icon_size=args.icon_size,
                        text_size=args.text_size,
                        icon_positions=icon_positions,
                    )
            finally:
                run_checked(["hdiutil", "detach", str(mount_dir), "-quiet"])

        convert_command = [
            "hdiutil",
            "convert",
            str(mounted_dmg),
            "-format",
            "UDZO",
            "-ov",
            "-o",
            str(compressed_dmg),
        ]
        run_checked(convert_command)
        shutil.move(compressed_dmg, output_path)


if __name__ == "__main__":
    main()
