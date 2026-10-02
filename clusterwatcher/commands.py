"""Policy layer for loopback-only remote command and SSH-session APIs."""

from dataclasses import asdict
from datetime import datetime, timezone
import threading

from .models import Machine
from .ssh import open_remote_shell, run_remote_command, session_status


DEFAULT_COMMAND_TIMEOUT_SECONDS = 30
MAX_COMMAND_TIMEOUT_SECONDS = 300
MAX_COMMAND_BYTES = 65536
MAX_OUTPUT_BYTES = 1024 * 1024


class UnknownMachineError(LookupError):
    """Indicate that a command names no visible configured machine."""


class SessionUnavailableError(RuntimeError):
    """Indicate that a machine has no verified open SSH control master."""


class RemoteCommandService:
    """Inspect persistent sessions and execute commands through them."""

    def __init__(self, machines: list[Machine], ssh_timeout: int) -> None:
        self.machines = {machine.name: machine for machine in machines}
        self.ssh_timeout = ssh_timeout
        self._machine_locks = {name: threading.Lock() for name in self.machines}

    def sessions(self) -> dict[str, object]:
        """Return availability and persistence estimates for every machine."""
        return {
            "schema_version": "1.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "machines": [session_status(machine, self.ssh_timeout) for machine in self.machines.values()],
        }

    def _open_machine(self, machine_name: str) -> Machine:
        """Return a configured machine only when its master is verified open."""
        machine = self.machines.get(machine_name)
        if machine is None:
            raise UnknownMachineError(f"unknown machine: {machine_name}")
        status = session_status(machine, self.ssh_timeout)
        if not status["session_open"]:
            raise SessionUnavailableError(
                f"SSH session for {machine_name} is not open: {status['error']}"
            )
        return machine

    def execute(
        self,
        machine_name: str,
        command: str,
        timeout_seconds: int | None = DEFAULT_COMMAND_TIMEOUT_SECONDS,
    ) -> dict[str, object]:
        """Run shell text through a live master, optionally without a deadline."""
        if not isinstance(command, str) or not command.strip():
            raise ValueError("command must be a non-empty string")
        if len(command.encode()) > MAX_COMMAND_BYTES:
            raise ValueError(f"command exceeds the {MAX_COMMAND_BYTES}-byte limit")
        if timeout_seconds is not None and (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, int)
            or timeout_seconds < 1
        ):
            raise ValueError("timeout_seconds must be at least 1")

        lock = self._machine_locks.get(machine_name)
        if lock is None:
            raise UnknownMachineError(f"unknown machine: {machine_name}")
        with lock:
            machine = self._open_machine(machine_name)
            started_at = datetime.now(timezone.utc)
            result = run_remote_command(machine, timeout_seconds, command, MAX_OUTPUT_BYTES)
            finished_at = datetime.now(timezone.utc)
            after = session_status(machine, self.ssh_timeout)

        payload = asdict(result)
        payload["exit_code"] = payload.pop("returncode")
        payload.update({
            "machine": machine.name,
            "started_at": started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "connection_dropped": not bool(after["session_open"]),
            "session": after,
        })
        return payload

    def shell(self, machine_name: str) -> int:
        """Attach to an interactive shell through an existing master only."""
        if machine_name not in self.machines:
            raise UnknownMachineError(f"unknown machine: {machine_name}")
        with self._machine_locks[machine_name]:
            machine = self._open_machine(machine_name)
            return open_remote_shell(machine, self.ssh_timeout)
