#!/usr/bin/env python3
"""Minimal PTY bridge: run a command on a real terminal, pipe bytes in and out.

Node has no built-in PTY, and the live contract suite must not grow a native
dependency to drive a TUI. This bridge gives the child a controlling terminal
(exactly like the Kanna daemon does) while the driving test keeps ordinary
pipes on stdin/stdout.

Bytes written to this process's stdin are written verbatim to the PTY master —
the same fd-level write the daemon performs for `Command::Input`. Nothing is
transformed, so a test that writes through here is exercising the real
injected-input path, not an approximation of it.

Usage: pty-bridge.py <command> [args...]
Closing stdin does NOT close the PTY: the child keeps running until it exits
on its own, which is what the quit-command tests need to observe.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

ROWS = 40
COLS = 120


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("pty-bridge.py: no command given\n")
        return 2

    pid, master = pty.fork()
    if pid == 0:
        # Child: the slave side is already our controlling terminal.
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            sys.stderr.write(f"pty-bridge.py: exec failed: {error}\n")
            os._exit(127)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True
    exit_status = None

    while True:
        watch = [master] + ([stdin_fd] if stdin_open else [])
        try:
            readable, _, _ = select.select(watch, [], [], 0.05)
        except (InterruptedError, OSError):
            readable = []

        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if data:
                os.write(stdout_fd, data)
            else:
                break

        if stdin_open and stdin_fd in readable:
            data = os.read(stdin_fd, 65536)
            if data:
                os.write(master, data)
            else:
                # Keep the PTY open; the child owns its own lifetime.
                stdin_open = False

        if exit_status is None:
            waited_pid, status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                exit_status = status
                # Drain whatever the child wrote before exiting. select() first:
                # a lingering grandchild can still hold the slave open, and a
                # blocking read would hang the bridge forever.
                while True:
                    ready, _, _ = select.select([master], [], [], 0.1)
                    if not ready:
                        break
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    os.write(stdout_fd, data)
                break

    if exit_status is None:
        try:
            _, exit_status = os.waitpid(pid, 0)
        except ChildProcessError:
            exit_status = 0

    os.close(master)
    if os.WIFSIGNALED(exit_status):
        return 128 + os.WTERMSIG(exit_status)
    return os.WEXITSTATUS(exit_status)


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
