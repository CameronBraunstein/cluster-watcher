"""Tests for shared SSH session inspection and bounded remote execution."""

from datetime import datetime, timezone
from io import BytesIO
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

from clusterwatcher.commands import RemoteCommandService, SessionUnavailableError, UnknownMachineError
from clusterwatcher.models import Machine, RemoteCommandResult
from clusterwatcher.ssh import (
    _drain_limited,
    _mark_activity,
    existing_session_ssh_command,
    parse_control_persist,
    run_remote_command,
    session_status,
)
import clusterwatcher.ssh as ssh_module
from helpers import TimedTestCase


class RemoteCommandTests(TimedTestCase):
    """Verify session discovery and command-service policy without real SSH."""

    def test_control_persist_parser_accepts_openssh_durations(self):
        self.assertEqual(parse_control_persist("8h"), 28800)
        self.assertEqual(parse_control_persist("1h30m5s"), 5405)
        self.assertEqual(parse_control_persist("120"), 120)
        self.assertIsNone(parse_control_persist("yes"))
        with self.assertRaises(ValueError):
            parse_control_persist("tomorrow")

    @patch("clusterwatcher.ssh.subprocess.run")
    def test_session_status_verifies_master_and_reports_pid(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="Master running (pid=4321)\n")
        machine = Machine("alpha", "alpha.example", "alice", control_persist="2h")

        activity = {("alice", "alpha.example", 22): datetime.now(timezone.utc)}
        with tempfile.TemporaryDirectory() as directory, patch(
            "clusterwatcher.ssh.CONTROL_SOCKET_DIRECTORY", Path(directory)
        ), patch.dict("clusterwatcher.ssh._last_activity", activity, clear=True):
            status = session_status(machine)

        self.assertTrue(status["available"])
        self.assertTrue(status["session_open"])
        self.assertEqual(status["pid"], 4321)
        self.assertEqual(status["control_persist_seconds"], 7200)
        self.assertGreaterEqual(status["estimated_remaining_seconds"], 7198)

    def test_limited_pipe_drain_discards_excess_output(self):
        chunks: list[bytes] = []
        state = {"truncated": False}

        _drain_limited(BytesIO(b"abcdefgh"), chunks, state, 5)

        self.assertEqual(b"".join(chunks), b"abcde")
        self.assertTrue(state["truncated"])

    @patch("clusterwatcher.ssh._mark_activity")
    @patch("clusterwatcher.ssh.subprocess.Popen")
    def test_remote_transport_waits_without_deadline_when_timeout_is_none(self, popen, _mark_activity):
        """Keep connection setup bounded while allowing unlimited execution."""
        process = popen.return_value
        process.stdout = BytesIO(b"done\n")
        process.stderr = BytesIO(b"")
        process.wait.return_value = 0
        machine = Machine("alpha", "alpha.example", "alice")

        result = run_remote_command(machine, None, "long-running-command", 1024)

        process.wait.assert_called_once_with(timeout=None)
        command = popen.call_args.args[0]
        self.assertIn("ConnectTimeout=15", command)
        self.assertEqual(result.stdout, "done\n")
        self.assertFalse(result.timed_out)

    def test_command_transport_cannot_fall_back_to_a_new_connection(self):
        machine = Machine("alpha", "alpha.example", "alice", port=2222)

        command = existing_session_ssh_command(machine, 45, "hostname")

        self.assertIn("ControlMaster=no", command)
        self.assertIn("ProxyCommand=false", command)
        self.assertNotIn("ControlMaster=auto", command)
        self.assertEqual(command[-2:], ["alice@alpha.example", "hostname"])
        self.assertEqual(command[command.index("-p") + 1], "2222")

        shell_command = existing_session_ssh_command(machine, 45, allocate_tty=True)
        self.assertIn("-t", shell_command)
        self.assertEqual(shell_command[-1], "alice@alpha.example")

    @patch("clusterwatcher.ssh.subprocess.run")
    def test_activity_estimate_is_shared_between_processes(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="Master running (pid=1)")
        machine = Machine("alpha", "alpha.example", "alice", control_persist="2h")

        with tempfile.TemporaryDirectory() as directory, patch(
            "clusterwatcher.ssh.CONTROL_SOCKET_DIRECTORY", Path(directory)
        ), patch.dict("clusterwatcher.ssh._last_activity", {}, clear=True):
            _mark_activity(machine)
            ssh_module._last_activity.clear()
            status = session_status(machine)

        self.assertIsNotNone(status["last_activity_at"])
        self.assertGreaterEqual(status["estimated_remaining_seconds"], 7198)

    @patch("clusterwatcher.commands.run_remote_command")
    @patch("clusterwatcher.commands.session_status")
    def test_execute_requires_and_rechecks_existing_session(self, status, run_command):
        status.side_effect = [
            {"session_open": True, "error": None},
            {"session_open": False, "error": "master disappeared"},
        ]
        run_command.return_value = RemoteCommandResult(255, "partial\n", "connection lost", False, False, False, 0.2)
        machine = Machine("alpha", "alpha.example", "alice")
        service = RemoteCommandService([machine], 5)

        result = service.execute("alpha", "printf partial")

        self.assertTrue(result["connection_dropped"])
        self.assertEqual(result["stdout"], "partial\n")
        self.assertEqual(result["exit_code"], 255)
        run_command.assert_called_once_with(machine, 30, "printf partial", 1024 * 1024)

    @patch("clusterwatcher.commands.run_remote_command")
    @patch("clusterwatcher.commands.session_status", return_value={"session_open": True, "error": None})
    def test_execute_accepts_an_unlimited_command_deadline(self, _status, run_command):
        """Represent an unlimited CLI execution deadline as ``None``."""
        run_command.return_value = RemoteCommandResult(0, "done\n", "", False, False, False, 12.0)
        machine = Machine("alpha", "alpha.example", "alice")
        service = RemoteCommandService([machine], 5)

        result = service.execute("alpha", "long-running-command", None)

        self.assertEqual(result["exit_code"], 0)
        run_command.assert_called_once_with(machine, None, "long-running-command", 1024 * 1024)

    @patch("clusterwatcher.commands.run_remote_command")
    @patch("clusterwatcher.commands.session_status", return_value={"session_open": True, "error": None})
    def test_execute_accepts_a_long_finite_deadline(self, _status, run_command):
        """Do not apply the HTTP endpoint's timeout ceiling to local commands."""
        run_command.return_value = RemoteCommandResult(0, "done\n", "", False, False, False, 500.0)
        machine = Machine("alpha", "alpha.example", "alice")
        service = RemoteCommandService([machine], 5)

        result = service.execute("alpha", "sleep 500", 600)

        self.assertEqual(result["exit_code"], 0)
        run_command.assert_called_once_with(machine, 600, "sleep 500", 1024 * 1024)

    @patch("clusterwatcher.commands.run_remote_command")
    @patch("clusterwatcher.commands.session_status", return_value={"session_open": False, "error": "no socket"})
    def test_closed_and_unknown_sessions_fail_clearly(self, _status, run_command):
        service = RemoteCommandService([Machine("alpha", "alpha.example", "alice")], 5)

        with self.assertRaisesRegex(SessionUnavailableError, "not open"):
            service.execute("alpha", "hostname")
        with self.assertRaisesRegex(UnknownMachineError, "unknown machine"):
            service.execute("missing", "hostname")
        run_command.assert_not_called()

    @patch("clusterwatcher.commands.session_status")
    def test_session_inventory_includes_every_configured_machine(self, status):
        status.side_effect = lambda machine, _timeout: {
            "name": machine.name,
            "session_open": machine.name == "open",
        }
        service = RemoteCommandService(
            [Machine("open", "one.example", "alice"), Machine("closed", "two.example", "alice")],
            5,
        )

        payload = service.sessions()

        self.assertEqual(payload["schema_version"], "1.0")
        self.assertEqual([item["name"] for item in payload["machines"]], ["open", "closed"])

    @patch("clusterwatcher.commands.open_remote_shell", return_value=7)
    @patch("clusterwatcher.commands.session_status", return_value={"session_open": True, "error": None})
    def test_shell_reuses_a_verified_session(self, _status, open_shell):
        machine = Machine("alpha", "alpha.example", "alice")
        service = RemoteCommandService([machine], 5)

        self.assertEqual(service.shell("alpha"), 7)

        open_shell.assert_called_once_with(machine, 5)
