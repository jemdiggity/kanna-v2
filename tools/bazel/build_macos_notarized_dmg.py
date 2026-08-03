#!/usr/bin/env python3

import argparse
import os
import stat
import shutil
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dmg", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(
            f"missing required environment variable: {name}\n"
            "Run Bazel with --config=notarize so Bazel forwards notarization credentials."
        )
    return value


def main() -> None:
    args = parse_args()

    dmg_path = Path(args.dmg).resolve()
    output_path = Path(args.output).resolve()

    if not dmg_path.exists():
        raise SystemExit(f"dmg does not exist: {dmg_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(dmg_path, output_path)
    output_path.chmod(output_path.stat().st_mode | stat.S_IWUSR)

    keychain_profile = required_env("APPLE_KEYCHAIN_PROFILE")
    keychain_path = Path(required_env("APPLE_KEYCHAIN_PATH"))
    if not keychain_path.is_absolute():
        raise SystemExit(
            "APPLE_KEYCHAIN_PATH must be absolute so kd and the Bazel action select the same Keychain."
        )
    if not keychain_path.is_file():
        raise SystemExit(f"configured notarization keychain does not exist: {keychain_path}")

    submit_command = [
        "xcrun",
        "notarytool",
        "submit",
        str(output_path),
        "--wait",
        "--keychain-profile",
        keychain_profile,
        "--keychain",
        str(keychain_path),
    ]

    subprocess.run(submit_command, check=True)

    subprocess.run(
        [
            "xcrun",
            "stapler",
            "staple",
            str(output_path),
        ],
        check=True,
    )

    subprocess.run(
        [
            "xcrun",
            "stapler",
            "validate",
            str(output_path),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
