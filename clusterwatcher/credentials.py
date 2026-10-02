"""Ephemeral password/OTP sharing for related interactive SSH sessions."""

from __future__ import annotations

import getpass
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading

from .models import Machine
from .askpass import ASKPASS_MODE_ENVIRONMENT_VARIABLE
from .ssh import session_status, start_interactive_session


ASKPASS_SOCKET_ENV = "CLUSTER_WATCHER_ASKPASS_SOCKET"
ASKPASS_PROGRAM = Path(__file__).with_name("askpass.py").resolve()


def _askpass_program() -> tuple[Path, bool]:
    """Return an executable askpass client and whether it is the frozen app.

    Source installations launch the small executable Python helper. A
    PyInstaller one-file build cannot assume that Python or an extracted
    source script exists on the target machine, so it launches its own binary
    with a private environment flag that routes directly to the same helper
    logic.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve(), True
    return ASKPASS_PROGRAM, False


class CredentialBroker:
    """Serve one shared password and one current host's ephemeral OTP."""

    def __init__(self, password: str) -> None:
        self._password = password
        self._otp = ""
        self._credential_lock = threading.Lock()
        self._stop = threading.Event()
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self.socket_path: Path | None = None

    def __enter__(self) -> CredentialBroker:
        """Create a private socket and start serving askpass requests."""
        try:
            self._directory = tempfile.TemporaryDirectory(prefix=f"cluster-watcher-auth-{os.getuid()}-")
            directory = Path(self._directory.name)
            directory.chmod(0o700)
            self.socket_path = directory / "askpass.sock"
            self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._socket.bind(str(self.socket_path))
            self.socket_path.chmod(0o600)
            self._socket.listen()
            self._socket.settimeout(0.2)
            self._thread = threading.Thread(target=self._serve, name="credential-broker", daemon=True)
            self._thread.start()
        except Exception:
            self._cleanup_transport()
            raise
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        """Stop the broker and discard references to the shared credentials."""
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
        self._cleanup_transport()
        with self._credential_lock:
            self._password = ""
            self._otp = ""

    def _cleanup_transport(self) -> None:
        """Close and remove partially or fully initialized broker resources."""
        if self._socket:
            self._socket.close()
            self._socket = None
        if self.socket_path:
            self.socket_path.unlink(missing_ok=True)
            self.socket_path = None
        if self._directory:
            self._directory.cleanup()
            self._directory = None

    def environment(self) -> dict[str, str]:
        """Return the non-secret environment needed by OpenSSH askpass."""
        if self.socket_path is None:
            raise RuntimeError("credential broker has not been started")
        askpass_program, frozen = _askpass_program()
        if not askpass_program.is_file() or not os.access(askpass_program, os.X_OK):
            raise RuntimeError(f"SSH askpass helper is not executable: {askpass_program}")
        environment = {
            "SSH_ASKPASS": str(askpass_program),
            "SSH_ASKPASS_REQUIRE": "force",
            "DISPLAY": os.environ.get("DISPLAY", "cluster-watcher:0"),
            ASKPASS_SOCKET_ENV: str(self.socket_path),
        }
        if frozen:
            environment[ASKPASS_MODE_ENVIRONMENT_VARIABLE] = "1"
        return environment

    def update_otp(self, otp: str) -> None:
        """Set or clear the single-use OTP for the machine being authenticated."""
        with self._credential_lock:
            self._otp = otp

    def _response(self, prompt: str) -> str:
        """Select a credential only for recognized password or OTP prompts."""
        normalized = prompt.casefold()
        otp_markers = ("one-time", "one time", "otp", "verification code", "passcode", "token code")
        with self._credential_lock:
            if any(marker in normalized for marker in otp_markers):
                return self._otp
            if "password" in normalized:
                return self._password
        # Never send a credential to host-key confirmations or unknown prompts.
        return ""

    def _serve(self) -> None:
        """Answer askpass clients until the startup authentication phase ends."""
        if self._socket is None:
            return
        while not self._stop.is_set():
            try:
                connection, _ = self._socket.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            with connection:
                try:
                    chunks: list[bytes] = []
                    while chunk := connection.recv(4096):
                        chunks.append(chunk)
                    prompt = b"".join(chunks).decode("utf-8", errors="replace")
                    connection.sendall(self._response(prompt).encode("utf-8"))
                except OSError:
                    # One abandoned askpass client must not stop later logins.
                    continue


def _authentication_failed(error: RuntimeError) -> bool:
    """Return whether an SSH failure is plausibly caused by an expired OTP."""
    message = str(error).casefold()
    return any(marker in message for marker in ("permission denied", "authentication failed", "access denied"))


def _start_credential_group(machines: list[Machine], timeout: int) -> list[tuple[Machine, RuntimeError]]:
    """Share one password while requesting a separate OTP for every machine."""
    group = machines[0].credential_group
    names = ", ".join(machine.name for machine in machines)
    username = machines[0].username
    print(f"Authenticating credential group {group!r} for {names}.", file=sys.stderr)
    password = getpass.getpass(f"Password for {username} ({group}): ")
    errors: list[tuple[Machine, RuntimeError]] = []
    try:
        with CredentialBroker(password) as broker:
            for machine in machines:
                otp = getpass.getpass(f"One-time code for {machine.name} ({machine.host}): ")
                broker.update_otp(otp)
                try:
                    start_interactive_session(machine, timeout, broker.environment())
                except RuntimeError as exc:
                    if not _authentication_failed(exc):
                        errors.append((machine, exc))
                        continue
                    print(
                        f"Authentication for {machine.name} was rejected; its OTP may have expired.",
                        file=sys.stderr,
                    )
                    otp = getpass.getpass(f"Fresh one-time code for {machine.name} ({machine.host}): ")
                    broker.update_otp(otp)
                    try:
                        start_interactive_session(machine, timeout, broker.environment())
                    except RuntimeError as retry_error:
                        errors.append((machine, retry_error))
                finally:
                    # A single-use OTP is never retained for the next host.
                    broker.update_otp("")
                    otp = ""
    finally:
        password = ""
    return errors


def establish_interactive_sessions(machines: list[Machine], timeout: int) -> list[tuple[Machine, RuntimeError]]:
    """Start missing reusable SSH masters, sharing named-group credentials.

    Ungrouped machines preserve OpenSSH's normal terminal prompting. Grouped
    machines prompt once for a shared password and separately for each host's
    single-use OTP. A rejection refreshes only that host's OTP and retries it
    once. Verified control masters are excluded before any credential prompt,
    allowing separate CLI processes to reuse a dashboard or earlier command's
    active session without asking for its password or OTP again.
    """
    machines = [
        machine for machine in machines
        if machine.interactive_auth and not session_status(machine, timeout)["session_open"]
    ]
    errors: list[tuple[Machine, RuntimeError]] = []
    completed_groups: set[str] = set()
    for machine in machines:
        if machine.credential_group is None:
            try:
                start_interactive_session(machine, timeout)
            except RuntimeError as exc:
                errors.append((machine, exc))
            continue
        if machine.credential_group in completed_groups:
            continue
        completed_groups.add(machine.credential_group)
        group_machines = [candidate for candidate in machines if candidate.credential_group == machine.credential_group]
        errors.extend(_start_credential_group(group_machines, timeout))
    return errors
