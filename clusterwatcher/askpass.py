#!/usr/bin/env python3
"""Minimal OpenSSH askpass client for Cluster Watcher's credential broker.

This executable receives only an OpenSSH prompt. The password and OTP stay in
the parent process and are fetched over a user-private Unix-domain socket.
"""

import os
import socket
import sys


SOCKET_ENVIRONMENT_VARIABLE = "CLUSTER_WATCHER_ASKPASS_SOCKET"
ASKPASS_MODE_ENVIRONMENT_VARIABLE = "CLUSTER_WATCHER_ASKPASS_MODE"
"""Set only when the frozen main executable is acting as the askpass client."""


def main() -> int:
    """Request the response for OpenSSH's prompt and write it to stdout."""
    socket_path = os.environ.get(SOCKET_ENVIRONMENT_VARIABLE)
    if not socket_path:
        return 1
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(socket_path)
            connection.sendall(prompt.encode("utf-8", errors="replace"))
            connection.shutdown(socket.SHUT_WR)
            chunks: list[bytes] = []
            while chunk := connection.recv(4096):
                chunks.append(chunk)
    except OSError:
        return 1
    sys.stdout.write(b"".join(chunks).decode("utf-8", errors="replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
