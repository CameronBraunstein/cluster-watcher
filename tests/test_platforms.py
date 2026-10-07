"""Cross-platform packaging and transport policy tests."""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from clusterwatcher.credentials import establish_interactive_sessions
from clusterwatcher.models import Machine
from clusterwatcher.packaging import standalone_artifact_name
from clusterwatcher.platforms import (
    normalized_architecture,
    normalized_system,
    standalone_default_config,
    supports_ssh_multiplexing,
    user_runtime_token,
)
from clusterwatcher.ssh import existing_session_ssh_command, session_status, ssh_command, start_interactive_session
from helpers import TimedTestCase


class PlatformTests(TimedTestCase):
    """Verify host aliases, release metadata, and Windows SSH degradation."""

    def test_public_platform_names_are_stable(self):
        self.assertEqual(normalized_system("Darwin"), "macos")
        self.assertEqual(normalized_system("Windows"), "windows")
        self.assertEqual(normalized_architecture("AMD64"), "x86_64")
        self.assertEqual(normalized_architecture("arm64"), "aarch64")
        self.assertTrue(supports_ssh_multiplexing("Linux"))
        self.assertTrue(supports_ssh_multiplexing("Darwin"))
        self.assertFalse(supports_ssh_multiplexing("Windows"))
        self.assertTrue(user_runtime_token())

    def test_test_case_runs_without_posix_interval_timers(self):
        """Let Windows execute tests even though it has no ``SIGALRM``."""
        case = TimedTestCase()
        result = unittest.TestResult()
        with patch("helpers.hasattr", return_value=False, create=True), \
                patch.object(unittest.TestCase, "run", return_value=result) as base_run:
            self.assertIs(case.run(result), result)
        base_run.assert_called_once_with(result)

    def test_frozen_config_uses_native_user_directories(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"APPDATA": directory}, clear=False,
        ), patch("clusterwatcher.platforms.normalized_system", return_value="windows"):
            self.assertEqual(
                standalone_default_config(), Path(directory) / "ClusterWatcher" / "clusters.toml",
            )
        with patch("clusterwatcher.platforms.normalized_system", return_value="macos"), \
                patch("clusterwatcher.platforms.Path.home", return_value=Path("/Users/alice")):
            self.assertEqual(
                standalone_default_config(),
                Path("/Users/alice/Library/Application Support/Cluster Watcher/clusters.toml"),
            )

    def test_frozen_config_honors_installer_sidecar(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "cluster-watcher.exe"
            executable.touch()
            configured = Path(directory) / "custom config" / "clusters.toml"
            executable.with_name(".cluster-watcher-config").write_text(str(configured), encoding="utf-8")

            self.assertEqual(standalone_default_config(executable), configured)

    def test_release_manifest_covers_every_supported_binary(self):
        root = Path(__file__).parents[1]
        manifest = json.loads((root / "release-platforms.json").read_text(encoding="utf-8"))
        artifacts = {target["artifact"] for target in manifest["targets"]}
        expected = {
            standalone_artifact_name(system, architecture)
            for system, architecture in (
                ("Linux", "x86_64"), ("Linux", "aarch64"),
                ("Darwin", "x86_64"), ("Darwin", "aarch64"),
                ("Windows", "x86_64"), ("Windows", "aarch64"),
            )
        }
        self.assertEqual(artifacts, expected)
        self.assertTrue((root / "install.ps1").is_file())
        self.assertTrue((root / "uninstall.ps1").is_file())

    def test_windows_key_transport_uses_direct_noninteractive_ssh(self):
        machine = Machine("cluster", "login.example", "alice", port=2222)
        with patch("clusterwatcher.ssh.SSH_MULTIPLEXING_SUPPORTED", False):
            ordinary = ssh_command(machine, 8, "sinfo")
            existing = existing_session_ssh_command(machine, 8, "hostname")

        self.assertNotIn("ControlMaster=auto", ordinary)
        self.assertNotIn("ControlPath=", " ".join(ordinary))
        self.assertIn("BatchMode=yes", existing)
        self.assertEqual(existing[-2:], ["alice@login.example", "hostname"])

    def test_windows_session_status_probes_direct_authentication(self):
        machine = Machine("cluster", "login.example", "alice")
        with patch("clusterwatcher.ssh.SSH_MULTIPLEXING_SUPPORTED", False), \
                patch("clusterwatcher.ssh.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = ""
            run.return_value.stderr = ""
            status = session_status(machine, 9)

        self.assertTrue(status["session_open"])
        self.assertEqual(status["connection_mode"], "direct")
        self.assertIsNone(status["control_persist_seconds"])
        self.assertIn("BatchMode=yes", run.call_args.args[0])

    def test_windows_interactive_auth_fails_before_requesting_credentials(self):
        machine = Machine("cluster", "login.example", "alice", interactive_auth=True)
        with patch("clusterwatcher.ssh.SSH_MULTIPLEXING_SUPPORTED", False):
            with self.assertRaisesRegex(RuntimeError, "WSL"):
                start_interactive_session(machine, 8)

        with patch("clusterwatcher.credentials.supports_ssh_multiplexing", return_value=False), \
                patch("clusterwatcher.credentials.session_status", return_value={"session_open": False}), \
                patch("clusterwatcher.credentials.getpass.getpass") as prompt:
            errors = establish_interactive_sessions([machine], 8)
        prompt.assert_not_called()
        self.assertEqual(errors[0][0], machine)
        self.assertIn("WSL", str(errors[0][1]))
