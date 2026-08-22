#!/usr/bin/env python3

"""Keeps Kanna's Bazel macOS floor, bundle plist, and Mach-O files aligned."""

import argparse
import os
import plistlib
import re
import subprocess
from pathlib import Path
from typing import Callable, Sequence


BUILD_TARGET_PATTERN = re.compile(
    r"^build\s+--macos_minimum_os(?:=|\s+)([^\s#]+)(?:\s+#.*)?$"
)
HOST_TARGET_PATTERN = re.compile(
    r"^build\s+--host_macos_minimum_os(?:=|\s+)([^\s#]+)(?:\s+#.*)?$"
)
MINOS_PATTERN = re.compile(r"^\s*minos\s+(\S+)\s*$", re.MULTILINE)
RunCommand = Callable[..., subprocess.CompletedProcess[str]]


class DeploymentTargetError(RuntimeError):
    """The configured, declared, or linked macOS deployment targets disagree."""


def _values(contents: str, pattern: re.Pattern[str]) -> set[str]:
    return {
        match.group(1)
        for line in contents.splitlines()
        if (match := pattern.match(line.strip()))
    }


def _single_value(contents: str, pattern: re.Pattern[str], flag: str) -> str:
    values = _values(contents, pattern)
    if len(values) != 1:
        rendered = ", ".join(sorted(values)) if values else "missing"
        raise DeploymentTargetError(
            f"{flag} must have one committed value; found {rendered}"
        )
    return next(iter(values))


def read_deployment_target(bazelrc_path: Path) -> str:
    contents = bazelrc_path.read_text(encoding="utf-8")
    target = _single_value(contents, BUILD_TARGET_PATTERN, "--macos_minimum_os")
    host_values = _values(contents, HOST_TARGET_PATTERN)
    if len(host_values) > 1:
        raise DeploymentTargetError(
            "--host_macos_minimum_os has conflicting committed values"
        )
    if host_values and target not in host_values:
        host = next(iter(host_values))
        raise DeploymentTargetError(
            f"target macOS floor {target} does not match host macOS floor {host}"
        )
    return target


def render_plist(base_path: Path, output_path: Path, deployment_target: str) -> None:
    with base_path.open("rb") as base_file:
        plist = plistlib.load(base_file)
    plist["LSMinimumSystemVersion"] = deployment_target
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as output_file:
        plistlib.dump(plist, output_file, sort_keys=False)


def _run_text(command: Sequence[str], run: RunCommand) -> str:
    result = run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic"
        raise DeploymentTargetError(f"{' '.join(command)} failed: {detail}")
    return result.stdout


def macho_files(app_path: Path, run: RunCommand = subprocess.run) -> list[Path]:
    discovered: list[Path] = []
    for root, directories, filenames in os.walk(app_path):
        directories.sort()
        for filename in sorted(filenames):
            candidate = Path(root) / filename
            if candidate.is_symlink():
                continue
            description = _run_text(
                ["/usr/bin/file", "--brief", str(candidate)], run
            )
            if "Mach-O" in description:
                discovered.append(candidate)
    return discovered


def verify_app(
    app_path: Path,
    deployment_target: str,
    run: RunCommand = subprocess.run,
) -> None:
    info_plist_path = app_path / "Contents" / "Info.plist"
    try:
        with info_plist_path.open("rb") as info_file:
            plist_target = plistlib.load(info_file).get("LSMinimumSystemVersion")
    except (OSError, plistlib.InvalidFileException) as error:
        raise DeploymentTargetError(
            f"cannot read bundle plist {info_plist_path}: {error}"
        ) from error
    if plist_target != deployment_target:
        raise DeploymentTargetError(
            f"{info_plist_path}: LSMinimumSystemVersion is {plist_target!r}; "
            f"expected {deployment_target}"
        )

    binaries = macho_files(app_path, run)
    if not binaries:
        raise DeploymentTargetError(
            f"{app_path}: release bundle contains no Mach-O files"
        )

    mismatches: list[str] = []
    for binary in binaries:
        build_versions = _run_text(
            ["xcrun", "vtool", "-show-build", str(binary)], run
        )
        minimum_versions = MINOS_PATTERN.findall(build_versions)
        if not minimum_versions:
            mismatches.append(f"{binary}: vtool reported no minos")
            continue
        for index, minimum_version in enumerate(minimum_versions, start=1):
            if minimum_version != deployment_target:
                mismatches.append(
                    f"{binary} slice {index}: minos {minimum_version}; "
                    f"expected {deployment_target}"
                )
    if mismatches:
        raise DeploymentTargetError(
            "macOS release deployment target gate failed:\n" + "\n".join(mismatches)
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    render = subparsers.add_parser("render-plist")
    render.add_argument("--bazelrc", required=True, type=Path)
    render.add_argument("--base", required=True, type=Path)
    render.add_argument("--output", required=True, type=Path)

    verify = subparsers.add_parser("verify-app")
    verify.add_argument("--bazelrc", required=True, type=Path)
    verify.add_argument("--app", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    deployment_target = read_deployment_target(args.bazelrc)
    if args.command == "render-plist":
        render_plist(args.base, args.output, deployment_target)
    else:
        verify_app(args.app, deployment_target)


if __name__ == "__main__":
    main()
