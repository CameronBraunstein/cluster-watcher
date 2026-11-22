"""Ephemeral password/OTP sharing and explicit SSH host-key confirmation."""

from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
from typing import Callable, TextIO

from .models import Machine
from .askpass import ASKPASS_MODE_ENVIRONMENT_VARIABLE
from .platforms import supports_ssh_multiplexing, user_runtime_token
from .ssh import select_login_machine, session_status, start_interactive_session, verify_submission_host


ASKPASS_SOCKET_ENV = "CLUSTER_WATCHER_ASKPASS_SOCKET"
ASKPASS_PROGRAM = Path(__file__).with_name("askpass.py").resolve()
CREDENTIAL_PROMPT_PREFIX = "CLUSTER_WATCHER_AUTH_PROMPT "
SecretPrompt = Callable[[str, str], str]


class CredentialPromptCancelled(RuntimeError):
    """Raised when a machine-readable credential client cancels or closes."""


class JsonLineCredentialPrompt:
    """Exchange credential and host-trust prompts over private standard streams.

    This private protocol lets a graphical client present its own password
    field without placing credentials in command arguments, environment
    variables, files, or process output. Requests are prefixed so ordinary
    service diagnostics can share the output stream safely. Responses arrive
    only on stdin and are never echoed.
    """

    def __init__(self, input_stream: TextIO | None = None, output_stream: TextIO | None = None) -> None:
        self.input_stream = input_stream or sys.stdin
        self.output_stream = output_stream or sys.stderr
        self._request_id = 0

    def __call__(self, kind: str, prompt: str) -> str:
        """Request a password/OTP or host-trust decision from the client."""
        self._request_id += 1
        request = {
            "version": 1,
            "request_id": self._request_id,
            "kind": kind,
            "prompt": prompt,
        }
        encoded_request = json.dumps(request, separators=(",", ":"))
        print(
            f"{CREDENTIAL_PROMPT_PREFIX}{encoded_request}",
            file=self.output_stream,
            flush=True,
        )
        response_line = self.input_stream.readline(20_000)
        if not response_line:
            raise CredentialPromptCancelled("credential input was closed")
        if len(response_line) >= 20_000 and not response_line.endswith("\n"):
            raise CredentialPromptCancelled("credential client response was too large")
        try:
            response = json.loads(response_line)
        except json.JSONDecodeError as exc:
            raise CredentialPromptCancelled("credential client returned invalid JSON") from exc
        if not isinstance(response, dict) or response.get("request_id") != self._request_id:
            raise CredentialPromptCancelled("credential client returned an unexpected response")
        if response.get("cancel") is True:
            raise CredentialPromptCancelled("authentication was cancelled")
        value = response.get("value")
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 16_384
            or any(character in value for character in ("\x00", "\r", "\n"))
        ):
            raise CredentialPromptCancelled("credential client returned an invalid secret")
        return value


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

    def __init__(self, password: str, host_key_prompt: SecretPrompt | None = None,
                 credential_prompt: SecretPrompt | None = None) -> None:
        self._password = password
        self._host_key_prompt = host_key_prompt
        self._credential_prompt = credential_prompt
        self.cancelled = False
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
            self._directory = tempfile.TemporaryDirectory(prefix=f"cluster-watcher-auth-{user_runtime_token()}-")
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
        """Confirm new hosts explicitly; send secrets only to credential prompts."""
        normalized = prompt.casefold()
        # Check before password/OTP markers: hostnames and known_hosts paths
        # in a host-key prompt may themselves contain those words.
        if any(marker in normalized for marker in (
            "authenticity of host", "host key", "key fingerprint", "continue connecting",
        )):
            if not (
                normalized.startswith("the authenticity of host '")
                and "key fingerprint is" in normalized
                and "are you sure you want to continue connecting (yes/no" in normalized
                and self._host_key_prompt is not None
            ):
                return ""
            try:
                answer = self._host_key_prompt("host_key", prompt)
            except (CredentialPromptCancelled, EOFError):
                return "no"
            # No response is cached or shared with other hosts in the group.
            return "yes" if answer == "yes" else "no"
        otp_markers = ("one-time", "one time", "otp", "verification code", "passcode", "token code")
        kind = (
            "otp" if any(marker in normalized for marker in otp_markers)
            else "passphrase" if "passphrase for key" in normalized
            else "password" if "password" in normalized else None
        )
        with self._credential_lock:
            if self.cancelled:
                return ""
            value = self._password if kind == "password" else self._otp if kind == "otp" else ""
        # A user may leave a dialog open while SSH exits. Never hold the lock
        # while waiting for input, so broker cleanup can still clear secrets.
        if kind and self._credential_prompt and not value:
            try:
                value = self._credential_prompt(kind, prompt)
            except (CredentialPromptCancelled, EOFError):
                self.cancelled = True
                return ""
            with self._credential_lock:
                if self._stop.is_set():
                    return ""
                if kind == "password":
                    self._password = value
                elif kind == "otp":
                    self._otp = value
        # Unknown prompts receive nothing; host-key prompts were handled above.
        return value

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


def _secret(kind: str, prompt: str, secret_prompt: SecretPrompt | None) -> str:
    """Read one secret from the selected UI without retaining another copy."""
    return secret_prompt(kind, prompt) if secret_prompt is not None else getpass.getpass(prompt)


def _terminal_host_key_prompt(_kind: str, prompt: str) -> str:
    """Show OpenSSH's full fingerprint prompt, accepting only an explicit yes."""
    print(prompt, file=sys.stderr, end="", flush=True)
    return input().strip().lower()


def _start_credential_group(
    machines: list[Machine], timeout: int, secret_prompt: SecretPrompt | None = None,
) -> list[tuple[Machine, RuntimeError]]:
    """Share one password while requesting a separate OTP for every machine."""
    group = machines[0].credential_group
    label = group or machines[0].name
    names = ", ".join(machine.name for machine in machines)
    username = machines[0].username
    print(f"Authenticating credential group {label!r} for {names}.", file=sys.stderr)
    password = _secret("password", f"Password for {username} ({label})", secret_prompt)
    errors: list[tuple[Machine, RuntimeError]] = []
    try:
        with CredentialBroker(password, secret_prompt or _terminal_host_key_prompt) as broker:
            for machine in machines:
                otp = _secret(
                    "otp", f"One-time code for {machine.name} ({machine.host})", secret_prompt,
                )
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
                    otp = _secret(
                        "otp", f"Fresh one-time code for {machine.name} ({machine.host})", secret_prompt,
                    )
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


def login_targets(
    machines: list[Machine], requested: list[str], include_credential_groups: bool = True,
) -> list[Machine]:
    """Return machines that an explicit ``cluster-watcher login`` should try.

    With no names, every machine is a target. Named machines also
    bring in the other machines of their credential groups by default: one
    shared password then covers every group member whose session has closed
    too (each still needs its own OTP). ``include_credential_groups=False``
    restricts named requests to exactly those machines. Machines with an open
    session reuse it in :func:`establish_login_sessions`; their submission hop
    is still checked so a previously untrusted hop can be repaired.
    """
    known = {machine.name: machine for machine in machines}
    unknown = [name for name in requested if name not in known]
    if unknown:
        raise ValueError(f"unknown machine(s): {', '.join(unknown)}")
    if not requested:
        return list(machines)
    if not include_credential_groups:
        return [known[name] for name in requested]
    groups = {known[name].credential_group for name in requested} - {None}
    return [
        machine for machine in machines
        if machine.name in requested or machine.credential_group in groups
    ]


def establish_login_sessions(
    machines: list[Machine], timeout: int, secret_prompt: SecretPrompt | None = None,
) -> list[tuple[Machine, RuntimeError]]:
    """Explicit login for keys, passwords, or MFA, including submission-host trust.

    Unlike automatic MFA startup, this runs only at the user's login request.
    Credentials are requested on demand by SSH. Open masters are reused while
    submission hops are still checked, allowing a failed second hop to recover.
    """
    confirm = secret_prompt or _terminal_host_key_prompt
    errors: list[tuple[Machine, RuntimeError]] = []
    if machines and not supports_ssh_multiplexing():
        return [(machine, RuntimeError("explicit reusable SSH login requires OpenSSH multiplexing; use WSL on Windows"))
                for machine in machines]
    groups: dict[tuple[str, str], list[Machine]] = {}
    for machine in machines:
        key = ("group", machine.credential_group) if machine.credential_group else ("machine", machine.name)
        groups.setdefault(key, []).append(machine)
    for group in groups.values():
        current = group[0]

        def request(kind: str, prompt: str) -> str:
            return _secret(kind, f"{current.name} ({current.host}): {prompt}", secret_prompt)

        with CredentialBroker("", confirm, request) as broker:
            for original in group:
                try:
                    current = select_login_machine(original, timeout)
                    if not session_status(current, timeout)["session_open"]:
                        try:
                            start_interactive_session(current, timeout, broker.environment())
                        except RuntimeError as exc:
                            # Only retry an OTP we actually requested. A password-only
                            # failure must not invent an OTP or reuse a wrong password.
                            if not broker._otp or broker.cancelled or not _authentication_failed(exc):
                                raise
                            broker.update_otp("")
                            start_interactive_session(current, timeout, broker.environment())
                    verify_submission_host(current, timeout, confirm)
                except RuntimeError as exc:
                    errors.append((original, exc))
                finally:
                    broker.update_otp("")
    return errors


def establish_interactive_sessions(
    machines: list[Machine], timeout: int, secret_prompt: SecretPrompt | None = None,
) -> list[tuple[Machine, RuntimeError]]:
    """Start missing reusable SSH masters, sharing named-group credentials.

    Ungrouped machines preserve OpenSSH's normal terminal prompting unless a
    graphical ``secret_prompt`` is supplied; graphical clients use the same
    private askpass broker for a one-machine group. Named groups prompt once
    for a shared password and separately for each host's single-use OTP. A
    rejection refreshes only that host's OTP and retries it once. Verified
    control masters are excluded before any credential prompt, allowing
    separate CLI processes to reuse a dashboard or earlier command's active
    session without asking for its password or OTP again.
    """
    machines = [
        machine for machine in machines
        if machine.interactive_auth and not session_status(machine, timeout)["session_open"]
    ]
    if machines and not supports_ssh_multiplexing():
        error = RuntimeError(
            "native Windows OpenSSH cannot keep reusable password/OTP sessions; "
            "use SSH keys/agent or run Cluster Watcher in WSL"
        )
        return [(machine, error) for machine in machines]
    errors: list[tuple[Machine, RuntimeError]] = []
    selected: list[Machine] = []
    for machine in machines:
        try:
            selected.append(select_login_machine(machine, timeout))
        except RuntimeError as exc:
            errors.append((machine, exc))
    machines = selected
    completed_groups: set[str] = set()
    for machine in machines:
        if machine.credential_group is None and secret_prompt is None:
            try:
                start_interactive_session(machine, timeout)
            except RuntimeError as exc:
                errors.append((machine, exc))
            continue
        if machine.credential_group is None:
            # A graphical caller has no inherited terminal for OpenSSH's
            # prompts. Use the same private askpass broker for this one host;
            # password-only sites simply ignore the supplied OTP.
            errors.extend(_start_credential_group([machine], timeout, secret_prompt))
            continue
        if machine.credential_group in completed_groups:
            continue
        completed_groups.add(machine.credential_group)
        group_machines = [candidate for candidate in machines if candidate.credential_group == machine.credential_group]
        errors.extend(_start_credential_group(group_machines, timeout, secret_prompt))
    return errors
