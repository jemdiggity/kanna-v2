#!/usr/bin/env python3

import argparse
import os
import re
import shutil
import subprocess
from pathlib import Path


DEVELOPER_ID_PATTERN = re.compile(r'"(Developer ID Application:[^"]+)"')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--deployment-target-config", required=True)
    parser.add_argument("--deployment-target-tool", required=True)
    parser.add_argument("--signing-identity")
    return parser.parse_args()


def detect_signing_identity() -> str:
    output = subprocess.check_output(
        ["security", "find-identity", "-v", "-p", "codesigning"],
        text=True,
    )
    for line in output.splitlines():
        match = DEVELOPER_ID_PATTERN.search(line)
        if match:
            return match.group(1)
    raise SystemExit("no Developer ID Application signing identity found")


def normalize_bundle_directory_modes(app_path: Path) -> None:
    for root, dirs, _files in os.walk(app_path):
        Path(root).chmod(0o755)
        for dirname in dirs:
            (Path(root) / dirname).chmod(0o755)


def main() -> None:
    args = parse_args()

    app_path = Path(args.app).resolve()
    output_path = Path(args.output).resolve()

    if not app_path.exists():
        raise SystemExit(f"app does not exist: {app_path}")

    signing_identity = args.signing_identity or detect_signing_identity()

    if output_path.exists():
        shutil.rmtree(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(app_path, output_path, symlinks=False)
    normalize_bundle_directory_modes(output_path)

    subprocess.run(
        [
            "python3",
            args.deployment_target_tool,
            "verify-app",
            "--bazelrc",
            args.deployment_target_config,
            "--app",
            str(output_path),
        ],
        check=True,
    )

    subprocess.run(
        [
            "codesign",
            "--force",
            "--sign",
            signing_identity,
            "--deep",
            "--options",
            "runtime",
            "--timestamp",
            str(output_path),
        ],
        check=True,
    )

    normalize_bundle_directory_modes(output_path)

    subprocess.run(
        [
            "codesign",
            "--verify",
            "--deep",
            "--strict",
            "--verbose=2",
            str(output_path),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
