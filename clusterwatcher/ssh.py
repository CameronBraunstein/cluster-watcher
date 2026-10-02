"""SSH transport and optional MFA-friendly connection multiplexing."""

from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from typing import Mapping

from .models import Machine, RemoteCommandResult


_runtime_directory = Path(os.environ.get("XDG_RUNTIME_DIR", tempfile.gettempdir()))
CONTROL_SOCKET_DIRECTORY = _runtime_directory / f"cluster-watcher-{os.getuid()}" / "ssh"
_activity_lock = threading.Lock()
_last_activity: dict[tuple[str, str, int], datetime] = {}


def control_socket_path() -> Path:
    """Return a user-private OpenSSH control-socket template.

    ``%C`` is expanded by OpenSSH to a hash of the endpoint, keeping sockets
    distinct for each host, port, and remote user. A local runtime directory is
    used because network-mounted home directories may reject OpenSSH's atomic
    hard-link operation while it creates a multiplexing socket.
    """
    directory = CONTROL_SOCKET_DIRECTORY
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
    except OSError:
        # Containers sometimes expose XDG_RUNTIME_DIR read-only. Keep the
        # fallback user-specific and private rather than disabling multiplexing.
        directory = Path(tempfile.gettempdir()) / f"cluster-watcher-{os.getuid()}" / "ssh"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
    return directory / "%C"


def _connection_options(machine: Machine, timeout: int, batch_mode: bool) -> list[str]:
    """Build shared OpenSSH options for a regular or multiplexed connection."""
    command = ["-o", f"BatchMode={'yes' if batch_mode else 'no'}", "-o", f"ConnectTimeout={timeout}"]
    command.extend([
        "-o", "ControlMaster=auto", "-o", f"ControlPersist={machine.control_persist}",
        "-o", f"ControlPath={control_socket_path()}",
    ])
    if machine.port != 22:
        command.extend(["-p", str(machine.port)])
    if machine.identity_file:
        command.extend(["-i", str(Path(machine.identity_file).expanduser())])
    return command


def ssh_command(machine: Machine, timeout: int, remote_command: str) -> list[str]:
    """Build a non-interactive SSH command for a fixed remote command."""
    return ["ssh", *_connection_options(machine, timeout, batch_mode=True), f"{machine.username}@{machine.host}", remote_command]


def existing_session_ssh_command(
    machine: Machine,
    timeout: int,
    remote_command: str | None = None,
    allocate_tty: bool = False,
) -> list[str]:
    """Build an SSH command that can only use an existing control master.

    ``ProxyCommand=false`` deliberately makes the direct-connection fallback
    fail. OpenSSH ignores it when the configured control socket is available,
    but it prevents a race from unexpectedly starting a new authenticated
    connection after the service has checked the master.
    """
    command = [
        "ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={min(timeout, 30)}",
        "-o", "ControlMaster=no", "-o", f"ControlPath={control_socket_path()}",
        "-o", "ProxyCommand=false",
    ]
    if machine.port != 22:
        command.extend(["-p", str(machine.port)])
    if allocate_tty:
        command.append("-t")
    command.append(f"{machine.username}@{machine.host}")
    if remote_command is not None:
        command.append(remote_command)
    return command


def start_interactive_session(machine: Machine, timeout: int, askpass_environment: Mapping[str, str] | None = None) -> None:
    """Authenticate once and background an SSH master for an MFA machine.

    Without ``askpass_environment``, terminal streams are inherited and
    OpenSSH prompts normally. Credential groups instead provide a private
    askpass broker environment whose secrets never appear in this command.
    """
    if not machine.interactive_auth:
        return
    command = ["ssh", *_connection_options(machine, timeout, batch_mode=False), "-N", "-f", f"{machine.username}@{machine.host}"]
    run_options: dict[str, object] = {}
    if askpass_environment is not None:
        run_options = {
            "env": {**os.environ, **askpass_environment},
            "stdin": subprocess.DEVNULL,
            "capture_output": True,
        }
    try:
        result = subprocess.run(command, text=True, check=False, **run_options)
    except OSError as exc:
        raise RuntimeError(f"could not start SSH authentication: {exc}") from exc
    if result.returncode:
        detail = result.stderr.strip() if askpass_environment is not None and result.stderr else ""
        raise RuntimeError(detail or f"interactive SSH authentication exited with status {result.returncode}")
    _mark_activity(machine)


def run_remote(machine: Machine, timeout: int, remote_command: str) -> str:
    """Run one fixed remote command through the system SSH client."""
    result = _run_remote_process(machine, timeout, remote_command)
    return result.stdout


def run_remote_combined(
    machine: Machine,
    timeout: int,
    remote_command: str,
    process_timeout: float | None = None,
) -> str:
    """Run a remote command and return both output streams.

    Command-line tools such as ``srun`` write their own informational messages
    to standard error even when they exit successfully.  Collectors that parse
    those messages must therefore inspect both streams.
    """
    result = _run_remote_process(machine, timeout, remote_command, process_timeout)
    return "\n".join(stream.rstrip("\n") for stream in (result.stdout, result.stderr) if stream)


def _run_remote_process(
    machine: Machine,
    timeout: int,
    remote_command: str,
    process_timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """Execute one remote command with an optional exact process deadline."""
    execution_timeout = timeout + 5 if process_timeout is None else process_timeout
    result = subprocess.run(
        ssh_command(machine, timeout, remote_command),
        text=True,
        capture_output=True,
        timeout=execution_timeout,
        check=False,
    )
    if result.returncode != 255:
        _mark_activity(machine)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"ssh exited with status {result.returncode}")
    return result


def parse_control_persist(value: str) -> int | None:
    """Convert an OpenSSH time value to seconds, or ``None`` for forever."""
    text = value.strip().casefold()
    if text in {"yes", "forever"}:
        return None
    if text == "no":
        return 0
    if text.isdigit():
        return int(text)
    position = 0
    total = 0
    multipliers = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
    for match in re.finditer(r"(\d+)([smhdw])", text):
        if match.start() != position:
            raise ValueError(f"invalid OpenSSH duration: {value!r}")
        total += int(match.group(1)) * multipliers[match.group(2)]
        position = match.end()
    if position != len(text) or not text:
        raise ValueError(f"invalid OpenSSH duration: {value!r}")
    return total


def _machine_key(machine: Machine) -> tuple[str, str, int]:
    """Return the stable key used for in-memory session activity."""
    return machine.username, machine.host, machine.port


def _activity_path(machine: Machine) -> Path:
    """Return a private cross-process activity timestamp path for a machine."""
    key = "\0".join(map(str, _machine_key(machine))).encode()
    digest = hashlib.sha256(key).hexdigest()
    return control_socket_path().parent / f"activity-{digest}"


def _mark_activity(machine: Machine) -> None:
    """Record when a multiplexed channel most recently became idle.

    The private timestamp file lets separate Cluster Watcher CLI processes use
    the estimate maintained by the dashboard process. Failure to persist this
    advisory metadata must not turn a successful SSH operation into a failure.
    """
    observed_at = datetime.now(timezone.utc)
    with _activity_lock:
        _last_activity[_machine_key(machine)] = observed_at
    try:
        path = _activity_path(machine)
        path.write_text(observed_at.isoformat(), encoding="utf-8")
        path.chmod(0o600)
    except OSError:
        pass


def _read_last_activity(machine: Machine) -> datetime | None:
    """Return the newest in-memory or cross-process activity observation."""
    with _activity_lock:
        in_memory = _last_activity.get(_machine_key(machine))
    try:
        persisted = datetime.fromisoformat(_activity_path(machine).read_text(encoding="utf-8").strip())
        if persisted.tzinfo is None:
            persisted = persisted.replace(tzinfo=timezone.utc)
    except (OSError, ValueError):
        persisted = None
    candidates = [value for value in (in_memory, persisted) if value is not None]
    return max(candidates) if candidates else None


def control_check_command(machine: Machine) -> list[str]:
    """Build a local-only OpenSSH control-master health check."""
    command = ["ssh", "-o", f"ControlPath={control_socket_path()}", "-O", "check"]
    if machine.port != 22:
        command.extend(["-p", str(machine.port)])
    command.append(f"{machine.username}@{machine.host}")
    return command


def session_status(machine: Machine, timeout: int = 5) -> dict[str, object]:
    """Return verified control-master state and estimated persistence time.

    OpenSSH reports whether the master is running but not its idle deadline.
    The remaining value is therefore an estimate based on activity observed by
    Cluster Watcher processes; it is ``None`` when no observation is available
    or persistence is unlimited.
    """
    persist_seconds = parse_control_persist(machine.control_persist)
    try:
        result = subprocess.run(
            control_check_command(machine), text=True, capture_output=True,
            timeout=max(1, min(timeout, 5)), check=False,
        )
        message = (result.stdout or result.stderr).strip()
        session_open = result.returncode == 0
    except (OSError, subprocess.TimeoutExpired) as exc:
        message = str(exc)
        session_open = False
    pid_match = re.search(r"pid=(\d+)", message)
    last_activity = _read_last_activity(machine)
    remaining: int | None = None
    if session_open and persist_seconds is not None and last_activity is not None:
        deadline = last_activity + timedelta(seconds=persist_seconds)
        remaining = max(0, int((deadline - datetime.now(timezone.utc)).total_seconds()))
    return {
        "name": machine.name,
        "host": machine.host,
        "username": machine.username,
        "available": session_open,
        "session_open": session_open,
        "pid": int(pid_match.group(1)) if pid_match else None,
        "control_persist_seconds": persist_seconds,
        "estimated_remaining_seconds": remaining,
        "last_activity_at": last_activity.isoformat() if last_activity else None,
        "error": None if session_open else (message or "No open SSH control master"),
    }


def _drain_limited(stream: object, chunks: list[bytes], state: dict[str, bool], limit: int) -> None:
    """Drain a child-process pipe while retaining at most ``limit`` bytes."""
    while data := stream.read(65536):  # type: ignore[attr-defined]
        retained = sum(map(len, chunks))
        if retained < limit:
            chunks.append(data[:limit - retained])
        if retained + len(data) > limit:
            state["truncated"] = True


def run_remote_command(machine: Machine, timeout: int | None, remote_command: str, output_limit: int) -> RemoteCommandResult:
    """Execute through an existing master with bounded output and optional time limit."""
    started = time.monotonic()
    connection_timeout = min(timeout, 15) if timeout is not None else 15
    process = subprocess.Popen(
        existing_session_ssh_command(machine, connection_timeout, remote_command),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    stdout_state = {"truncated": False}
    stderr_state = {"truncated": False}
    readers = [
        threading.Thread(target=_drain_limited, args=(process.stdout, stdout_chunks, stdout_state, output_limit), daemon=True),
        threading.Thread(target=_drain_limited, args=(process.stderr, stderr_chunks, stderr_state, output_limit), daemon=True),
    ]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        returncode = process.wait()
    for reader in readers:
        reader.join()
    if returncode != 255:
        _mark_activity(machine)
    return RemoteCommandResult(
        returncode=returncode,
        stdout=b"".join(stdout_chunks).decode(errors="replace"),
        stderr=b"".join(stderr_chunks).decode(errors="replace"),
        stdout_truncated=stdout_state["truncated"],
        stderr_truncated=stderr_state["truncated"],
        timed_out=timed_out,
        duration_seconds=round(time.monotonic() - started, 3),
    )


def open_remote_shell(machine: Machine, timeout: int) -> int:
    """Attach the current terminal to a shell on an existing SSH master."""
    try:
        result = subprocess.run(
            existing_session_ssh_command(machine, timeout, allocate_tty=True),
            check=False,
        )
    except KeyboardInterrupt:
        return 130
    if result.returncode != 255:
        _mark_activity(machine)
    return result.returncode
