#!/usr/bin/env python3
"""Re-capture the OpenCode TUI fixtures in this directory from the installed CLI.

The daemon's status matcher reads rendered terminal rows, so the only fixture
worth pinning it against is a real byte stream from a real `opencode` process on
a real PTY. Every `.ansi` file here is exactly that: raw output from process
start up to the moment the TUI reached the named state, replayable into
`HeadlessTerminal` to reconstruct the frame the daemon would have seen.

Nothing here is hand-written. When OpenCode's TUI moves, re-run this rather than
editing the fixtures:

    python3 crates/daemon/tests/fixtures/opencode/capture-tui-fixtures.py

then update the pinned CLI version in README.md and in the tests that name it.
Needs the `opencode` CLI installed and authenticated for the model below; the
run costs a few free-tier turns.

Usage: capture-tui-fixtures.py [OUTPUT_DIR]
"""

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

MODEL = "opencode/big-pickle"
GEOMETRIES = ((120, 40), (80, 24))
# The TUI is what the daemon's matcher reads, and `opencode [project]` — the
# CLI's default command — is what draws it. `opencode run` streams plain text
# and exits at the end of its turn, so it renders no chrome to pin.
TUI_ARGS = ["--model", MODEL]

# Long enough to hold the TUI in its working state for a few frames, short
# enough that the fixture stays a few kilobytes.
BUSY_PROMPT = (
    "Without asking any questions, print every integer from 1 to 60 in your reply, "
    "one per line, and then stop."
)
# Needs a tool call so the permission dialog opens; the repo config below turns
# every permission back to "ask".
PERMISSION_PROMPT = (
    "Run the shell command `echo hello > greeting.txt` in the current directory. "
    "Do not ask me anything, just run it."
)
PERMISSION_CONFIG = json.dumps(
    {
        "$schema": "https://opencode.ai/config.json",
        "permission": {"bash": "ask", "edit": "ask", "webfetch": "ask"},
    }
)

ANSI = re.compile(
    rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]"
)
COMPOSER_READY = re.compile(r"Askanything|Build·")
WORKING_FOOTER = re.compile(r"esc(ape)?interrupt|esc(ape)?tointerrupt")


def find_binary() -> str:
    home = os.path.expanduser("~")
    candidates = [
        f"{home}/.opencode/bin/opencode",
        f"{home}/.local/bin/opencode",
        "/usr/local/bin/opencode",
        "/opt/homebrew/bin/opencode",
    ]
    for candidate in candidates:
        if os.access(candidate, os.X_OK):
            return candidate
    sys.exit("opencode binary not found. Install: curl -fsSL https://opencode.ai/install | bash")


class Session:
    """An `opencode` process on a real PTY, recording every byte it writes."""

    def __init__(self, argv, cwd, cols, rows):
        self.raw = bytearray()
        self.exited = False
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvp(argv[0], argv)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, seconds: float) -> int:
        """Read for `seconds`, returning how many bytes arrived."""
        deadline = time.time() + seconds
        received = 0
        while time.time() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.05)
            if self.master in readable:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    data = b""
                if not data:
                    self.exited = True
                    return received
                self.raw.extend(data)
                received += len(data)
            waited, _ = os.waitpid(self.pid, os.WNOHANG)
            if waited == self.pid:
                self.exited = True
                return received
        return received

    @property
    def compact(self) -> str:
        return re.sub(r"\s+", "", ANSI.sub(b"", bytes(self.raw)).decode("utf-8", "replace"))

    def wait_for(self, pattern: re.Pattern, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline and not self.exited:
            self.pump(0.3)
            if pattern.search(self.compact):
                return True
        return False

    def wait_until_quiet(self, quiet_for: float, timeout: float) -> None:
        """Pump until the TUI stops redrawing — the turn is over, or a dialog is up."""
        deadline = time.time() + timeout
        last_output = time.time()
        while time.time() < deadline and not self.exited:
            if self.pump(0.5) > 0:
                last_output = time.time()
            elif time.time() - last_output >= quiet_for:
                return

    def submit(self, text: str) -> None:
        """kanna-server's submission policy: write the text, pause, then a discrete CR."""
        os.write(self.master, text.encode())
        time.sleep(0.15)
        os.write(self.master, b"\r")

    def kill(self) -> None:
        try:
            os.kill(self.pid, 9)
        except OSError:
            pass


def write_fixture(outdir: str, name: str, raw: bytes) -> None:
    path = os.path.join(outdir, name)
    with open(path, "wb") as handle:
        handle.write(raw)
    print(f"  {name}: {len(raw)} bytes")


def capture_turn(binary: str, outdir: str, cols: int, rows: int) -> None:
    """One live turn, truncated twice: while it is working, and once it is done."""
    cwd = tempfile.mkdtemp(prefix="opencode-fixture-")
    subprocess.run(["git", "init", "-q"], cwd=cwd, check=True)
    session = Session([binary, *TUI_ARGS, cwd], cwd, cols, rows)
    try:
        if not session.wait_for(COMPOSER_READY, 60):
            sys.exit(f"{cols}x{rows}: opencode never drew its composer")
        session.submit(BUSY_PROMPT)
        if not session.wait_for(WORKING_FOOTER, 120):
            sys.exit(f"{cols}x{rows}: opencode never drew its working footer")
        # Let the working frame finish painting before truncating.
        session.pump(1.5)
        write_fixture(outdir, f"busy-{cols}x{rows}.ansi", bytes(session.raw))

        session.wait_until_quiet(quiet_for=6, timeout=240)
        write_fixture(outdir, f"idle-{cols}x{rows}.ansi", bytes(session.raw))
    finally:
        session.kill()


def capture_permission(binary: str, outdir: str, cols: int, rows: int) -> None:
    cwd = tempfile.mkdtemp(prefix="opencode-fixture-")
    subprocess.run(["git", "init", "-q"], cwd=cwd, check=True)
    with open(os.path.join(cwd, "opencode.json"), "w") as handle:
        handle.write(PERMISSION_CONFIG)
    session = Session([binary, *TUI_ARGS, cwd], cwd, cols, rows)
    try:
        if not session.wait_for(COMPOSER_READY, 60):
            sys.exit(f"{cols}x{rows}: opencode never drew its composer")
        session.submit(PERMISSION_PROMPT)
        session.wait_until_quiet(quiet_for=6, timeout=240)
        write_fixture(outdir, f"permission-{cols}x{rows}.ansi", bytes(session.raw))
    finally:
        session.kill()


def main() -> None:
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(outdir, exist_ok=True)
    binary = find_binary()
    version = subprocess.run(
        [binary, "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    print(f"capturing from {binary} ({version}) into {outdir}")
    for cols, rows in GEOMETRIES:
        print(f"{cols}x{rows}:")
        capture_turn(binary, outdir, cols, rows)
        capture_permission(binary, outdir, cols, rows)
    print(f"done — pinned CLI version is {version}")


if __name__ == "__main__":
    main()
