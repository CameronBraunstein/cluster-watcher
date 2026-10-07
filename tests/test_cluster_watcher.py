import subprocess
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import hashlib
import json
import os
from pathlib import Path
import sys
from threading import Barrier
import tomllib
from unittest.mock import patch

from clusterwatcher.config import load_config, load_wait_threshold_minutes
from clusterwatcher.cli import main
from clusterwatcher.dashboard import PAGE, StatusStore
from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.slurm import collect_status
from clusterwatcher.ssh import ssh_command, start_interactive_session
from helpers import TimedTestCase


CONFIG = b'''[[machine]]
name = "alpha"
host = "login.alpha"
username = "alice"
port = 2222
'''




def fake_batch(outputs: dict[str, object]):
    """Return a ``run_batch`` stand-in: section name -> stdout, or an exception for a failed command."""
    from clusterwatcher.remote_batch import Section

    def run(_machine, _timeout, commands):
        sections = {}
        for name in commands:
            value = outputs.get(name, "")
            sections[name] = Section("", str(value), 1) if isinstance(value, Exception) else Section(str(value), "", 0)
        return sections
    return run

def installer_function(name: str, *args: object) -> str:
    """Run one helper function defined by install.sh without running the installer."""
    installer = Path(__file__).parents[1] / "install.sh"
    result = subprocess.run(
        ["bash", "-c", 'CLUSTER_WATCHER_INSTALL_LIB=1 source "$0"; "$@"', str(installer), name, *map(str, args)],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.rstrip("\n")


def managed_path_block(bin_directory: Path) -> str:
    """Return the marked PATH block that install.sh writes and uninstall.sh removes."""
    return (
        "# >>> cluster-watcher initialize >>>\n"
        "# !! Contents within this block are managed by 'cluster-watcher install.sh' !!\n"
        f"export PATH='{bin_directory}':\"$PATH\"\n"
        "# <<< cluster-watcher initialize <<<"
    )

class ClusterWatcherTests(TimedTestCase):
    def test_package_exposes_terminal_and_module_entry_points(self):
        """Keep the installed command mapped to the same development CLI."""
        root = Path(__file__).parents[1]
        project = tomllib.loads((root / "pyproject.toml").read_text())
        specification = (root / "cluster-watcher.spec").read_text()

        self.assertEqual(project["project"]["scripts"]["cluster-watcher"], "clusterwatcher.cli:main")
        self.assertEqual(project["project"]["optional-dependencies"]["standalone"], ["pyinstaller>=6.0,<7"])
        self.assertTrue((root / "clusterwatcher" / "__main__.py").is_file())
        self.assertIn("standalone_artifact_name", specification)
        self.assertIn("name=artifact_name", specification)
        self.assertNotIn("gpu_profiles.toml", specification)  # Personal config, never bundled.
        self.assertNotIn("COLLECT(", specification)  # EXE receives data directly in one-file mode.

    @unittest.skipIf(os.name == "nt", "POSIX installer is tested on Linux and macOS")
    def test_install_script_is_executable_safe_and_has_working_help(self):
        """Keep the per-user standalone installer syntactically valid and guarded."""
        installer = Path(__file__).parents[1] / "install.sh"

        syntax = subprocess.run(["bash", "-n", str(installer)], capture_output=True, text=True)
        help_result = subprocess.run([str(installer), "--help"], capture_output=True, text=True)
        source = installer.read_text()

        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn('single public command "cluster-watcher"', help_result.stdout)
        self.assertNotIn('command "cluster_watcher"', help_result.stdout)
        self.assertIn("--add-to-path", help_result.stdout)
        self.assertIn("--state-dir", help_result.stdout)
        self.assertIn('[[ "$(id -u)" -ne 0 ]]', source)
        self.assertIn("refusing to replace symbolic link", source)
        self.assertIn("mktemp -d", source)
        self.assertIn("PIP_CACHE_DIR=", source)

    def test_personal_files_stay_private_and_installer_works_without_them(self):
        """Never publish clusters.toml or AGENTS.md; ship a valid example instead."""
        root = Path(__file__).parents[1]
        ignored = (root / ".gitignore").read_text().splitlines()
        installer = (root / "install.sh").read_text()

        for name in ("clusters.toml", "clusters.toml.bak", "AGENTS.md"):
            self.assertIn(name, ignored)
        self.assertNotIn('fail "missing clusters.toml', installer)
        self.assertIn("cluster-watcher setup", installer)
        self.assertEqual(
            [machine.name for machine in load_config(root / "clusters.example.toml")],
            ["cluster-a", "cluster-b"],
        )

    def test_add_to_path_checks_the_profile_not_only_the_parent_environment(self):
        """Persist PATH when a temporary parent shell already exposes the bin directory."""
        installer = (Path(__file__).parents[1] / "install.sh").read_text()

        self.assertNotIn(
            '[[ "${path_contains_bin}" -eq 0 && "${ADD_TO_PATH}" -eq 1 ]]',
            installer,
        )
        self.assertGreaterEqual(
            installer.count('if [[ "${ADD_TO_PATH}" -eq 1 ]]; then'),
            2,
        )
        self.assertIn('PROFILE_PATH="${requested_profile}"', installer)

    def test_standalone_artifact_names_include_normalized_platform(self):
        """Give every distributable an unambiguous OS and architecture suffix."""
        from clusterwatcher.packaging import standalone_artifact_name

        self.assertEqual(standalone_artifact_name("Linux", "AMD64"), "cluster-watcher-linux-x86_64")
        self.assertEqual(standalone_artifact_name("Linux", "arm64"), "cluster-watcher-linux-aarch64")
        self.assertEqual(standalone_artifact_name("Darwin", "arm64"), "cluster-watcher-macos-aarch64")
        self.assertEqual(standalone_artifact_name("Windows", "AMD64"), "cluster-watcher-windows-x86_64.exe")
        self.assertEqual(standalone_artifact_name("Free BSD", "riscv64"), "cluster-watcher-free-bsd-riscv64")

    @unittest.skipIf(os.name == "nt", "POSIX installer is tested on Linux and macOS")
    def test_installer_uses_site_private_profile_and_marked_block(self):
        """Honor a site-managed shell profile's delegated private file."""
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            bashrc = home / ".bashrc"
            bashrc.write_text(
                "# PLEASE DO NOT EDIT!\n"
                "# make your changes in ~/.bashrc_private instead\n"
                "if [ -f $HOME/.bashrc_private ]; then\n"
                "    . $HOME/.bashrc_private\n"
                "fi\n"
            )

            self.assertEqual(installer_function("preferred_shell_profile", home, "/bin/bash"), str(home / ".bashrc_private"))
            self.assertEqual(installer_function("preferred_shell_profile", home, "/bin/zsh"), str(home / ".zshrc"))
            self.assertEqual(
                installer_function("managed_path_block", home / ".local" / "bin"),
                managed_path_block(home / ".local" / "bin"),
            )

    @unittest.skipIf(os.name == "nt", "POSIX installer is tested on Linux and macOS")
    def test_installer_artifact_name_matches_python_packaging(self):
        """The release asset chosen by install.sh must be the one CI publishes."""
        from clusterwatcher.packaging import standalone_artifact_name

        for system, machine in (
            ("Linux", "x86_64"), ("Linux", "AMD64"), ("Linux", "arm64"),
            ("Darwin", "arm64"), ("Free BSD", "riscv64"),
        ):
            with self.subTest(system=system, machine=machine):
                self.assertEqual(
                    installer_function("platform_artifact_name", system, machine),
                    standalone_artifact_name(system, machine),
                )

    @unittest.skipIf(os.name == "nt", "POSIX installer is tested on Linux and macOS")
    def test_installer_downloads_and_verifies_a_release(self):
        """Install from a local file:// release; refuse a checksum mismatch."""
        from clusterwatcher.packaging import standalone_artifact_name

        artifact = standalone_artifact_name()
        for tampered in (False, True):
            with self.subTest(tampered=tampered), tempfile.TemporaryDirectory() as directory:
                temporary = Path(directory)
                release = temporary / "release"
                home = temporary / "home"
                release.mkdir()
                home.mkdir()
                binary = release / artifact
                binary.write_text("#!/bin/sh\nexit 0\n")
                digest = hashlib.sha256(b"something else" if tampered else binary.read_bytes()).hexdigest()
                (release / "SHA256SUMS").write_text(f"{digest}  {artifact}\n")
                # Run a copy outside the checkout so no personal clusters.toml is adopted.
                installer = temporary / "install.sh"
                installer.write_text((Path(__file__).parents[1] / "install.sh").read_text())
                installer.chmod(0o755)

                result = subprocess.run(
                    [str(installer)], capture_output=True, text=True,
                    env={**os.environ, "HOME": str(home), "CLUSTER_WATCHER_RELEASE_URL": release.as_uri(),
                         "XDG_BIN_HOME": "", "XDG_CONFIG_HOME": "", "XDG_STATE_HOME": "", "PATH": os.environ["PATH"]},
                )

                installed = home / ".local" / "bin" / artifact
                if tampered:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("checksum mismatch", result.stderr)
                    self.assertFalse(installed.exists())
                    continue
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Verified SHA-256 checksum", result.stdout)
                self.assertIn("cluster-watcher setup", result.stdout)
                self.assertEqual(installed.read_bytes(), binary.read_bytes())
                shim = (home / ".local" / "bin" / "cluster-watcher").read_text()
                if sys.platform == "darwin":
                    config = home / "Library" / "Application Support" / "Cluster Watcher" / "clusters.toml"
                else:
                    config = home / ".config" / "cluster-watcher" / "clusters.toml"
                self.assertIn(f"--config '{config}'", shim)
                self.assertFalse(config.exists())

    @unittest.skipIf(os.name == "nt", "POSIX uninstaller is tested on Linux and macOS")
    def test_uninstall_script_preserves_config_and_reverses_managed_path(self):
        """Uninstall both current and legacy managed PATH blocks safely."""
        root = Path(__file__).parents[1]
        uninstaller = root / "uninstall.sh"
        for block_format in ("current", "legacy"):
            with self.subTest(block_format=block_format), tempfile.TemporaryDirectory() as directory:
                temporary = Path(directory)
                home = temporary / "home"
                bin_dir = home / ".local" / "bin"
                config_dir = home / ".config" / "cluster-watcher"
                state_dir = home / ".local" / "state" / "cluster-watcher"
                bin_dir.mkdir(parents=True)
                config_dir.mkdir(parents=True)
                binary = bin_dir / "cluster-watcher-linux-x86_64"
                command = bin_dir / "cluster-watcher"
                marker = bin_dir / ".cluster-watcher-install"
                profile = home / ".bashrc_private"
                config = config_dir / "clusters.toml"
                binary.write_text("binary")
                command.write_text("shim")
                config.write_text("user configuration")
                if block_format == "current":
                    path_block = managed_path_block(bin_dir)
                else:
                    path_block = (
                        "# Added by Cluster Watcher install.sh\n"
                        f"export PATH='{bin_dir}':\"$PATH\""
                    )
                profile.write_text(f"export EDITOR=vi\n\n{path_block}\n")
                profile.chmod(0o640)
                marker.write_text(
                    "version=2\n"
                    f"binary={binary}\ncommand={command}\nconfig={config}\nprofile={profile}\n"
                )

                result = subprocess.run(
                    [
                        str(uninstaller),
                        "--bin-dir", str(bin_dir),
                        "--config-dir", str(config_dir),
                        "--state-dir", str(state_dir),
                    ],
                    capture_output=True,
                    text=True,
                    env={**os.environ, "HOME": str(home)},
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(binary.exists())
                self.assertFalse(command.exists())
                self.assertFalse(marker.exists())
                self.assertEqual(config.read_text(), "user configuration")
                self.assertEqual(profile.read_text(), "export EDITOR=vi\n\n")
                self.assertEqual(profile.stat().st_mode & 0o777, 0o640)
                backups = list(state_dir.glob("uninstall-backup-*"))
                self.assertEqual(len(backups), 1)
                self.assertTrue((backups[0] / binary.name).is_file())
                self.assertTrue((backups[0] / command.name).is_file())
                self.assertTrue((backups[0] / marker.name).is_file())
                self.assertTrue((backups[0] / profile.name).is_file())

    @unittest.skipIf(os.name == "nt", "POSIX uninstaller is tested on Linux and macOS")
    def test_uninstall_script_can_back_up_and_purge_configuration(self):
        """Treat configuration deletion as an explicit, recoverable operation."""
        root = Path(__file__).parents[1]
        uninstaller = root / "uninstall.sh"
        syntax = subprocess.run(["bash", "-n", str(uninstaller)], capture_output=True, text=True)
        help_result = subprocess.run([str(uninstaller), "--help"], capture_output=True, text=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("--purge-config", help_result.stdout)

        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            home = temporary / "home"
            bin_dir = home / "bin"
            config_dir = home / "config"
            state_dir = home / "state"
            bin_dir.mkdir(parents=True)
            config_dir.mkdir(parents=True)
            binary = bin_dir / "cluster-watcher-linux-aarch64"
            command = bin_dir / "cluster-watcher"
            config = config_dir / "clusters.toml"
            marker = bin_dir / ".cluster-watcher-install"
            binary.write_text("binary")
            command.write_text("shim")
            config.write_text("valuable config")
            marker.write_text(
                "version=2\n"
                f"binary={binary}\ncommand={command}\nconfig={config}\nprofile=\n"
            )

            result = subprocess.run(
                [
                    str(uninstaller), "--purge-config",
                    "--bin-dir", str(bin_dir),
                    "--config-dir", str(config_dir),
                    "--state-dir", str(state_dir),
                ],
                capture_output=True,
                text=True,
                env={**os.environ, "HOME": str(home)},
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(config.exists())
            backups = list(state_dir.glob("uninstall-backup-*"))
            self.assertEqual((backups[0] / "clusters.toml").read_text(), "valuable config")

    @patch("clusterwatcher.askpass.main", return_value=7)
    def test_private_frozen_askpass_mode_bypasses_normal_cli(self, askpass_main):
        """Allow the standalone executable to serve as its own askpass helper."""
        with patch.dict("clusterwatcher.cli.os.environ", {"CLUSTER_WATCHER_ASKPASS_MODE": "1"}, clear=True):
            self.assertEqual(main(["this-would-not-parse"]), 7)

        askpass_main.assert_called_once_with()

    @patch("clusterwatcher.cli.load_config", return_value=[])
    def test_installed_command_shim_can_set_the_public_help_name(self, _load_config):
        """Do not expose the installer's private binary name in normal usage."""
        stderr = StringIO()
        with patch.dict("clusterwatcher.cli.os.environ", {"CLUSTER_WATCHER_COMMAND_NAME": "cluster-watcher"}, clear=True):
            with redirect_stderr(stderr), self.assertRaises(SystemExit) as exit_context:
                main([])

        self.assertEqual(exit_context.exception.code, 2)
        self.assertIn("usage: cluster-watcher", stderr.getvalue())

    @patch("clusterwatcher.cli.run_terminal_job_board", return_value=0)
    @patch("clusterwatcher.cli.establish_interactive_sessions", return_value=[])
    @patch("clusterwatcher.cli.load_config", return_value=[Machine("CLUSTER_0", "host", "alice")])
    def test_jobs_cli_forwards_optional_refresh_interval(self, _load_config, establish, run_board):
        """Expose one-shot and periodically refreshed personal jobs from the CLI."""
        self.assertEqual(main(["jobs", "7", "--timeout", "12"]), 0)

        establish.assert_called_once_with([Machine("CLUSTER_0", "host", "alice")], 12)
        run_board.assert_called_once_with([Machine("CLUSTER_0", "host", "alice")], 12, 7)

    def test_jobs_help_documents_order_colors_and_refresh(self):
        """Keep the terminal board's behavior discoverable from command help."""
        stdout = StringIO()
        with redirect_stdout(stdout), self.assertRaises(SystemExit) as exit_context:
            main(["jobs", "--help"])

        self.assertEqual(exit_context.exception.code, 0)
        self.assertIn("running, pending, completed", stdout.getvalue())
        self.assertIn("progress is blue", stdout.getvalue())
        self.assertIn("refresh every SECONDS", stdout.getvalue())
        self.assertIn("Page Up/Page Down", stdout.getvalue())

    @patch("clusterwatcher.cli.run_terminal_status_board", return_value=0)
    @patch("clusterwatcher.cli.establish_interactive_sessions", return_value=[])
    @patch("clusterwatcher.cli.load_config", return_value=[
        Machine("CLUSTER_0", "cluster_0.example", "alice"),
        Machine("cluster_1", "cluster_1.example", "alice"),
    ])
    def test_status_cli_forwards_refresh_and_machine_selection(
        self, _load_config, establish, run_board,
    ):
        """Expose live capacity refresh while retaining machine selection."""
        self.assertEqual(main(["status", "30", "cluster_1", "--timeout", "12"]), 0)

        selected = [Machine("cluster_1", "cluster_1.example", "alice")]
        establish.assert_called_once_with(selected, 12)
        run_board.assert_called_once_with(selected, 12, 30, include_jobs=False)

    def test_status_help_documents_capacity_waits_colors_and_refresh(self):
        """Keep the redesigned status board discoverable from command help."""
        stdout = StringIO()
        with redirect_stdout(stdout), self.assertRaises(SystemExit) as exit_context:
            main(["status", "--help"])

        self.assertEqual(exit_context.exception.code, 0)
        help_text = " ".join(stdout.getvalue().split())
        self.assertIn("red/green availability", help_text)
        self.assertIn("one-hour wait estimates", help_text)
        self.assertIn("1, 2, 4, 8, 16, 32, and 64 GPUs", help_text)
        self.assertIn("Pass SECONDS first for live refresh", help_text)
        self.assertIn("only ERR", " ".join(help_text.split()))

    def test_frozen_credential_broker_uses_the_main_executable_for_askpass(self):
        """Avoid requiring an external Python interpreter in standalone builds."""
        from clusterwatcher.askpass import ASKPASS_MODE_ENVIRONMENT_VARIABLE
        from clusterwatcher.credentials import CredentialBroker

        broker = CredentialBroker("secret")
        broker.socket_path = Path("/private/askpass.sock")
        with patch("clusterwatcher.credentials.sys.frozen", True, create=True):
            environment = broker.environment()

        self.assertEqual(environment["SSH_ASKPASS"], str(Path(sys.executable).resolve()))
        self.assertEqual(environment[ASKPASS_MODE_ENVIRONMENT_VARIABLE], "1")

    @patch("clusterwatcher.cli.load_config", return_value=[Machine("cluster_3", "cluster_3.example", "alice")])
    @patch("clusterwatcher.cli.RemoteCommandService")
    def test_sessions_cli_supports_machine_readable_output(self, service_type, _load_config):
        service_type.return_value.sessions.return_value = {
            "schema_version": "1.0",
            "generated_at": "now",
            "machines": [{
                "name": "cluster_3",
                "host": "cluster_3.example",
                "username": "alice",
                "session_open": True,
                "control_persist_seconds": 7200,
                "estimated_remaining_seconds": 3661,
                "error": None,
            }],
        }
        output = StringIO()

        with redirect_stdout(output):
            result = main(["sessions", "--json"])

        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output.getvalue())["machines"][0]["name"], "cluster_3")

        output = StringIO()
        with redirect_stdout(output):
            result = main(["sessions"])
        self.assertEqual(result, 0)
        self.assertIn("cluster_3\topen\t1h 1m 1s\talice@cluster_3.example", output.getvalue())

    @patch("clusterwatcher.cli.load_config", return_value=[Machine("cluster_3", "cluster_3.example", "alice")])
    @patch("clusterwatcher.cli.RemoteCommandService")
    def test_exec_cli_relays_output_command_and_exit_status(self, service_type, _load_config):
        service_type.return_value.execute.return_value = {
            "stdout": "result\n",
            "stderr": "warning\n",
            "stdout_truncated": False,
            "stderr_truncated": False,
            "timed_out": False,
            "connection_dropped": False,
            "exit_code": 7,
        }
        stdout, stderr = StringIO(), StringIO()

        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = main(["exec", "--timeout", "20", "cluster_3", "--", "bash", "-lc", "echo $HOME"])

        self.assertEqual(result, 7)
        self.assertEqual(stdout.getvalue(), "result\n")
        self.assertEqual(stderr.getvalue(), "warning\n")
        service_type.return_value.execute.assert_called_once_with(
            "cluster_3", "bash -lc 'echo $HOME'", 20,
        )
        service_type.assert_called_once_with([Machine("cluster_3", "cluster_3.example", "alice")], 5)

    @patch("clusterwatcher.cli.load_config", return_value=[Machine("cluster_3", "cluster_3.example", "alice")])
    @patch("clusterwatcher.cli.RemoteCommandService")
    def test_exec_cli_has_no_command_timeout_by_default(self, service_type, _load_config):
        """Let an exec command run indefinitely unless the caller sets a limit."""
        service_type.return_value.execute.return_value = {
            "stdout": "", "stderr": "", "stdout_truncated": False,
            "stderr_truncated": False, "timed_out": False,
            "connection_dropped": False, "exit_code": 0,
        }

        self.assertEqual(main(["exec", "cluster_3", "--", "sleep", "600"]), 0)

        service_type.assert_called_once_with([Machine("cluster_3", "cluster_3.example", "alice")], 5)
        service_type.return_value.execute.assert_called_once_with("cluster_3", "sleep 600", None)

    @patch("clusterwatcher.cli.load_config", return_value=[Machine("cluster_3", "cluster_3.example", "alice")])
    @patch("clusterwatcher.cli.RemoteCommandService")
    def test_exec_cli_accepts_timeout_longer_than_five_minutes(self, service_type, _load_config):
        """Allow local callers to set long finite execution deadlines."""
        service_type.return_value.execute.return_value = {
            "stdout": "", "stderr": "", "stdout_truncated": False,
            "stderr_truncated": False, "timed_out": False,
            "connection_dropped": False, "exit_code": 0,
        }

        result = main(["exec", "--timeout", "600", "cluster_3", "--", "sleep", "500"])

        self.assertEqual(result, 0)
        service_type.return_value.execute.assert_called_once_with("cluster_3", "sleep 500", 600)

    def test_exec_help_documents_unlimited_default_timeout(self):
        """Make the potentially long-running default explicit in CLI help."""
        stdout = StringIO()
        with redirect_stdout(stdout), self.assertRaises(SystemExit) as exit_context:
            main(["exec", "--help"])

        self.assertEqual(exit_context.exception.code, 0)
        self.assertIn("default: unlimited", stdout.getvalue())
        self.assertIn("positive when set", stdout.getvalue())

    @patch("clusterwatcher.cli.load_config", return_value=[Machine("cluster_3", "cluster_3.example", "alice")])
    @patch("clusterwatcher.cli.RemoteCommandService")
    def test_shell_cli_returns_the_ssh_exit_status(self, service_type, _load_config):
        service_type.return_value.shell.return_value = 9

        self.assertEqual(main(["shell", "cluster_3"]), 9)

        service_type.return_value.shell.assert_called_once_with("cluster_3")

    @patch("clusterwatcher.cli.load_wait_threshold_minutes", return_value=(5, 30))
    @patch("clusterwatcher.cli.load_config", return_value=[Machine("a", "host", "user")])
    @patch("clusterwatcher.cli.serve", return_value=0)
    def test_jobs_api_flag_does_not_require_global_job_summary(self, serve, _load_config, _thresholds):
        self.assertEqual(main(["serve", "--jobs-api", "--no-browser"]), 0)
        self.assertFalse(serve.call_args.args[4])
        self.assertTrue(serve.call_args.args[8])

    @patch("clusterwatcher.cli.load_wait_threshold_minutes", return_value=(5, 30))
    @patch("clusterwatcher.cli.load_config", return_value=[Machine("a", "host", "user")])
    @patch("clusterwatcher.cli.serve", return_value=0)
    def test_command_api_flag_is_forwarded(self, serve, _load_config, _thresholds):
        self.assertEqual(main(["serve", "--command-api", "--no-browser"]), 0)
        self.assertFalse(serve.call_args.args[8])
        self.assertTrue(serve.call_args.args[9])

    def test_load_and_build_ssh_command(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(CONFIG)
            machine = load_config(path)[0]
        self.assertEqual(machine.name, "alpha")
        command = ssh_command(machine, 8, "sinfo")
        self.assertEqual(command[0], "ssh")
        self.assertIn("BatchMode=yes", command)
        self.assertIn("ConnectTimeout=8", command)
        self.assertIn("ControlMaster=auto", command)
        self.assertIn("ControlPersist=8h", command)
        self.assertIn("-p", command)
        self.assertEqual(command[-2:], ["alice@login.alpha", "sinfo"])

    def test_interactive_machine_uses_a_reusable_ssh_control_socket(self):
        machine = Machine("cluster_1", "cluster_1.example", "alice", interactive_auth=True, control_persist="4h")
        with tempfile.TemporaryDirectory() as directory, patch("clusterwatcher.ssh.CONTROL_SOCKET_DIRECTORY", Path(directory)), patch("clusterwatcher.ssh.subprocess.run") as run:
            command = ssh_command(machine, 8, "sinfo")
            self.assertIn("ControlMaster=auto", command)
            self.assertIn("ControlPersist=4h", command)
            self.assertIn("BatchMode=yes", command)
            run.return_value.returncode = 0
            start_interactive_session(machine, 8)
        self.assertIn("BatchMode=no", run.call_args.args[0])
        self.assertIn("-N", run.call_args.args[0])
        self.assertIn("-f", run.call_args.args[0])

    def test_grouped_interactive_session_uses_private_askpass_transport(self):
        machine = Machine("cluster_1", "cluster_1.example", "alice", interactive_auth=True, credential_group="shared")
        askpass_environment = {
            "SSH_ASKPASS": "/private/askpass",
            "SSH_ASKPASS_REQUIRE": "force",
            "CLUSTER_WATCHER_ASKPASS_SOCKET": "/private/socket",
        }
        with tempfile.TemporaryDirectory() as directory, patch("clusterwatcher.ssh.CONTROL_SOCKET_DIRECTORY", Path(directory)), patch("clusterwatcher.ssh.subprocess.run") as run:
            run.return_value.returncode = 0
            start_interactive_session(machine, 8, askpass_environment)

        options = run.call_args.kwargs
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertTrue(options["capture_output"])
        self.assertEqual(options["env"]["CLUSTER_WATCHER_ASKPASS_SOCKET"], "/private/socket")

    def test_loads_interactive_authentication_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(CONFIG + b'\ninteractive_auth = true\ncontrol_persist = "2h"\n')
            machine = load_config(path)[0]
        self.assertTrue(machine.interactive_auth)
        self.assertEqual(machine.control_persist, "2h")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(CONFIG + b'\ncontrol_persist = "later"\n')
            with self.assertRaisesRegex(ValueError, "invalid control_persist"):
                load_config(path)

    def test_loads_and_validates_partition_maximum_walltimes(self):
        """Resolve partition overrides while retaining a machine-wide default."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(
                CONFIG
                + b'\ndefault_partition_max_time_minutes = 1440\n'
                + b'[machine.partition_max_time_minutes]\ngpudev = 15\n'
            )
            machine = load_config(path)[0]
            self.assertEqual(machine.max_time_minutes("gpudev"), 15)
            self.assertEqual(machine.max_time_minutes("gpu"), 1440)

            path.write_bytes(CONFIG + b'\npartition_max_time_minutes = { gpudev = 0 }\n')
            with self.assertRaisesRegex(ValueError, "positive integer minutes"):
                load_config(path)

    def test_loads_and_validates_remote_job_log_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(CONFIG + b'\njob_log_roots = ["/work/alice", "/scratch/alice"]\n')
            self.assertEqual(load_config(path)[0].job_log_roots, ("/work/alice", "/scratch/alice"))

            path.write_bytes(CONFIG + b'\njob_log_roots = ["relative/path"]\n')
            with self.assertRaisesRegex(ValueError, "absolute remote paths"):
                load_config(path)

    def test_hidden_machines_are_excluded_from_all_workflows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_text(
                '[[machine]]\nname="visible"\nhost="visible.example"\nusername="alice"\n'
                '[[machine]]\nname="hidden"\nhost="hidden.example"\nusername="alice"\n'
                'interactive_auth=true\ncredential_group="shared"\nhidden=true\n'
            )

            machines = load_config(path)

            self.assertEqual([machine.name for machine in machines], ["visible"])

    def test_hidden_flag_must_be_boolean_and_one_machine_must_remain_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(CONFIG + b'\nhidden = "yes"\n')
            with self.assertRaisesRegex(ValueError, "invalid hidden value"):
                load_config(path)

            path.write_bytes(CONFIG + b"\nhidden = true\n")
            with self.assertRaisesRegex(ValueError, "at least one machine without hidden=true"):
                load_config(path)

    def test_loads_and_validates_shared_credential_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(CONFIG + b'\ninteractive_auth = true\ncredential_group = "shared"\n')
            machine = load_config(path)[0]
            self.assertEqual(machine.credential_group, "shared")

            path.write_bytes(CONFIG + b'\ncredential_group = "shared"\n')
            with self.assertRaisesRegex(ValueError, "interactive_auth=true"):
                load_config(path)

            path.write_text(
                '[[machine]]\nname="a"\nhost="one"\nusername="alice"\ninteractive_auth=true\ncredential_group="shared"\n'
                '[[machine]]\nname="b"\nhost="two"\nusername="bob"\ninteractive_auth=true\ncredential_group="shared"\n'
            )
            with self.assertRaisesRegex(ValueError, "must use one username"):
                load_config(path)

    def test_credential_broker_serves_secrets_without_putting_them_in_environment(self):
        from clusterwatcher.credentials import CredentialBroker

        broker = CredentialBroker("shared-password")
        broker.socket_path = Path("/private/askpass.sock")
        askpass_environment = broker.environment()

        self.assertEqual(broker._response("Password:"), "shared-password")
        self.assertEqual(broker._response("One-time password (OATH):"), "")
        broker.update_otp("123456")
        self.assertEqual(broker._response("One-time password (OATH):"), "123456")
        self.assertEqual(broker._response("Accept host key (yes/no)?"), "")
        self.assertNotIn("shared-password", askpass_environment.values())
        self.assertNotIn("123456", askpass_environment.values())

    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    @patch("clusterwatcher.credentials.start_interactive_session")
    @patch("clusterwatcher.credentials.getpass.getpass", side_effect=["shared-password", "cluster_1-otp", "cluster_2-otp", "cluster_3-otp"])
    def test_credential_group_shares_password_but_prompts_for_each_otp(self, getpass_mock, start_session, _status):
        from clusterwatcher.credentials import establish_interactive_sessions

        machines = [
            Machine(name, f"{name.lower()}.example", "alice", interactive_auth=True, credential_group="shared")
            for name in ("CLUSTER_1", "CLUSTER_2", "Cluster_3")
        ]

        with patch("clusterwatcher.credentials.CredentialBroker") as broker_type:
            broker = broker_type.return_value.__enter__.return_value
            broker.environment.return_value = {"ASKPASS": "socket"}
            self.assertEqual(establish_interactive_sessions(machines, 5), [])
        self.assertEqual(getpass_mock.call_count, 4)
        self.assertEqual(start_session.call_count, 3)
        self.assertEqual(
            [call.args[0] for call in broker.update_otp.call_args_list],
            ["cluster_1-otp", "", "cluster_2-otp", "", "cluster_3-otp", ""],
        )
        for call in start_session.call_args_list:
            environment = call.args[2]
            self.assertNotIn("shared-password", environment.values())
            self.assertFalse(any("otp" in value for value in environment.values()))

    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    @patch("clusterwatcher.credentials.start_interactive_session")
    @patch("clusterwatcher.credentials.getpass.getpass", side_effect=["shared-password", "cluster_1-otp", "expired", "fresh", "cluster_3-otp"])
    def test_rejected_machine_otp_is_refreshed_and_only_that_host_retried(self, getpass_mock, start_session, _status):
        from clusterwatcher.credentials import establish_interactive_sessions

        machines = [
            Machine(name, f"{name.lower()}.example", "alice", interactive_auth=True, credential_group="shared")
            for name in ("CLUSTER_1", "CLUSTER_2", "Cluster_3")
        ]
        start_session.side_effect = [None, RuntimeError("Permission denied (keyboard-interactive)"), None, None]

        with patch("clusterwatcher.credentials.CredentialBroker") as broker_type:
            broker = broker_type.return_value.__enter__.return_value
            broker.environment.return_value = {"ASKPASS": "socket"}
            self.assertEqual(establish_interactive_sessions(machines, 5), [])
        self.assertEqual(getpass_mock.call_count, 5)
        self.assertEqual(start_session.call_count, 4)
        self.assertEqual(start_session.call_args_list[1].args[0].name, "CLUSTER_2")
        self.assertEqual(start_session.call_args_list[2].args[0].name, "CLUSTER_2")
        self.assertEqual(
            [call.args[0] for call in broker.update_otp.call_args_list],
            ["cluster_1-otp", "", "expired", "fresh", "", "cluster_3-otp", ""],
        )

    @patch("clusterwatcher.credentials.start_interactive_session")
    @patch("clusterwatcher.credentials.getpass.getpass")
    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": True})
    def test_active_interactive_sessions_are_reused_without_credentials(self, status, getpass_mock, start_session):
        """Do not prompt when another process already owns a usable SSH master."""
        from clusterwatcher.credentials import establish_interactive_sessions

        machines = [
            Machine("CLUSTER_1", "cluster_1.example", "alice", interactive_auth=True, credential_group="shared"),
            Machine("CLUSTER_0", "cluster_0.example", "alice"),
        ]

        self.assertEqual(establish_interactive_sessions(machines, 5), [])

        status.assert_called_once_with(machines[0], 5)
        getpass_mock.assert_not_called()
        start_session.assert_not_called()

    def test_loads_configurable_wait_thresholds(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_bytes(CONFIG + b'\n[dashboard]\nwait_threshold_minutes = [10, 45, 90]\n')
            self.assertEqual(load_wait_threshold_minutes(path), (10, 45, 90))
            path.write_bytes(CONFIG + b'\n[dashboard]\nwait_threshold_minutes = [30, 5]\n')
            with self.assertRaisesRegex(ValueError, "strictly increasing"):
                load_wait_threshold_minutes(path)

    @patch("clusterwatcher.slurm.run_batch")
    def test_collect_status_parses_sinfo_and_jobs(self, run_batch):
        run_batch.side_effect = fake_batch({"sinfo": "debug|up|2|0/64/0/64|idle\n", "queue": "RUNNING\nPENDING\nRUNNING\n"})
        status = collect_status(Machine("a", "host", "user"), 5, True)
        self.assertEqual(run_batch.call_count, 1)  # Every command shares one SSH call.
        self.assertIsNone(status.error)
        self.assertEqual(status.partitions, [{"partition": "debug", "available": "up", "nodes": "2", "cpus": "0/64/0/64", "state": "idle"}])
        self.assertEqual(status.jobs, {"PENDING": 1, "RUNNING": 2})

    def test_job_parsing_marks_user_allocations_and_node_release_times(self):
        from clusterwatcher.slurm import (
            SQUEUE_RUNNING_END_COMMAND,
            SQUEUE_USER_PENDING_COMMAND,
            SQUEUE_USER_RUNNING_COMMAND,
            node_release_estimates,
            parse_jobs,
            slurm_duration_seconds,
            user_node_usage,
        )

        jobs = parse_jobs(
            "42|train-model|RUNNING|gpu-a40*|gpu[01-02]|2|8|gpu:a40:2|"
            "2026-09-21T10:00:00|2026-09-21T08:00:00|afterok:41|01:30:00|12:00:00|10:30:00\n"
        )
        self.assertEqual(jobs[0]["name"], "train-model")
        self.assertEqual(jobs[0]["partition"], "gpu-a40")
        self.assertEqual(jobs[0]["node_count"], 2)
        self.assertEqual(jobs[0]["gpus"], 2)
        self.assertEqual(jobs[0]["submit_time"], "2026-09-21T08:00:00Z")
        self.assertEqual(jobs[0]["start_time"], "2026-09-21T10:00:00Z")
        self.assertEqual(jobs[0]["dependency"], "afterok:41")
        self.assertEqual(jobs[0]["nodes"], ["gpu01", "gpu02"])
        self.assertEqual(jobs[0]["elapsed_seconds"], 5400)
        self.assertEqual(jobs[0]["time_limit_seconds"], 43200)
        self.assertEqual(jobs[0]["time_left_seconds"], 37800)
        self.assertEqual(user_node_usage(jobs)["gpu01"], {"cpus": 4, "gpus": 1})
        self.assertEqual(slurm_duration_seconds("2-03:04:05"), 183845)
        self.assertIsNone(slurm_duration_seconds("UNLIMITED"))
        self.assertEqual(node_release_estimates("gpu[01-02]|2026-09-21T12:00:00\n")["gpu02"], "2026-09-21T12:00:00Z")
        self.assertTrue(SQUEUE_RUNNING_END_COMMAND.startswith("TZ=UTC squeue"))
        self.assertTrue(SQUEUE_USER_RUNNING_COMMAND.startswith("TZ=UTC squeue"))
        self.assertTrue(SQUEUE_USER_PENDING_COMMAND.startswith("TZ=UTC squeue"))
        self.assertIn("%e", SQUEUE_RUNNING_END_COMMAND)
        self.assertIn("%j", SQUEUE_USER_RUNNING_COMMAND)
        self.assertIn("%M", SQUEUE_USER_RUNNING_COMMAND)
        self.assertIn("%l", SQUEUE_USER_RUNNING_COMMAND)
        self.assertIn("%L", SQUEUE_USER_RUNNING_COMMAND)
        self.assertIn("%D", SQUEUE_USER_RUNNING_COMMAND)
        self.assertIn("--array", SQUEUE_USER_RUNNING_COMMAND)
        self.assertIn("%V", SQUEUE_USER_PENDING_COMMAND)
        self.assertIn("%E", SQUEUE_USER_PENDING_COMMAND)
        self.assertIn("%r", SQUEUE_USER_PENDING_COMMAND)
        self.assertIn("--array", SQUEUE_USER_PENDING_COMMAND)

        array_jobs = parse_jobs(
            "2000068_[1]|grid_search|PENDING|apu|None assigned|1|16|gres/gpu:2|"
            "N/A|2026-09-28T11:24:00|NULL|00:00:18|01:00:00|00:59:42|Resources\n"
        )
        self.assertEqual(array_jobs[0]["id"], "2000068_1")
        self.assertEqual((array_jobs[0]["gpus"], array_jobs[0]["cpus"]), (2, 16))

    def test_gpu_count_parses_typed_and_untyped_gres(self):
        from clusterwatcher.slurm import SCONTROL_NODES_COMMAND, gpu_count

        self.assertEqual(gpu_count("gpu:4"), 4)
        self.assertEqual(gpu_count("gpu:a100:4(S:0-3),shard:20"), 4)
        self.assertEqual(gpu_count("gres/gpu:1"), 1)
        self.assertEqual(gpu_count("gres/gpu:l40:1"), 1)
        self.assertIn("-d", SCONTROL_NODES_COMMAND)

    def test_gpu_count_uses_tres_aggregate_without_double_counting_types(self):
        from clusterwatcher.slurm import gpu_count, gpu_types

        allocated_tres = "cpu=10,mem=112G,node=1,billing=1,gres/gpu=1,gres/gpu:l40=1"
        self.assertEqual(gpu_count(allocated_tres), 1)
        self.assertEqual(gpu_count("gres/gpu:a100=2,gres/gpu:h100=1"), 3)
        self.assertEqual(gpu_types("gres/gpu=2,gres/gpu:mi300a=2"), {"mi300a": 2})
        self.assertEqual(gpu_types("cpu=96,mem=220000M,gres/gpu=2"), {"generic": 2})

    def test_job_parsing_accepts_slurm_gres_gpu_prefix(self):
        from clusterwatcher.slurm import parse_jobs

        jobs = parse_jobs(
            "1000101|train_model|RUNNING|gpu-l40|gpu-node14|1|10|gres/gpu:1|"
            "2026-09-22T16:33:19|2026-09-22T16:33:15|NULL|23:35:58|1-00:00:00|00:24:02\n"
        )

        self.assertEqual(jobs[0]["gpus"], 1)

    @patch("clusterwatcher.slurm.run_remote")
    def test_terminal_job_collection_uses_one_bounded_live_query(self, run_remote):
        """Avoid full node inventory calls when rendering only personal jobs."""
        from clusterwatcher.slurm import SQUEUE_USER_JOBS_COMMAND, collect_user_job_status

        run_remote.return_value = (
            "1000101|train_model|RUNNING|gpu-l40|gpu-node14|1|10|gres/gpu:1|"
            "2026-09-22T16:33:19|2026-09-22T16:33:15|NULL|00:10:00|01:00:00|00:50:00|None\n"
        )

        status = collect_user_job_status(Machine("CLUSTER_0", "host", "alice"), 5)

        self.assertEqual(status.user_jobs[0]["id"], "1000101")
        self.assertEqual(status.user_jobs[0]["gpus"], 1)
        self.assertIn("--array", SQUEUE_USER_JOBS_COMMAND)
        run_remote.assert_called_once_with(Machine("CLUSTER_0", "host", "alice"), 5, SQUEUE_USER_JOBS_COMMAND)

    @patch("clusterwatcher.slurm.run_remote")
    def test_collect_node_status_parses_cpu_and_gpu_allocations(self, run_remote):
        from clusterwatcher.slurm import collect_node_status

        run_remote.return_value = "NodeName=gpu01 Partitions=gpu State=MIXED CPUAlloc=12 CPUTot=64 Gres=gpu:a100:4 GresUsed=gpu:a100:3(IDX:0-2)\n"
        node = collect_node_status(Machine("a", "host", "user"), 5)[0]
        self.assertEqual(node["cpu"], {"allocated": 12, "idle": 52, "total": 64})
        self.assertEqual(node["gpu"], {"allocated": 3, "idle": 1, "total": 4, "types": {"a100": 4}})

    @patch("clusterwatcher.slurm.run_remote")
    def test_apus_fall_back_to_tres_gpu_inventory(self, run_remote):
        """Count MI300A APUs when Cluster_1 leaves the legacy GRES fields empty."""
        from clusterwatcher.compute import rank_partitions
        from clusterwatcher.slurm import collect_node_status
        from clusterwatcher.snapshot import build_snapshot
        from clusterwatcher.wait_probes import partition_gpu_limits

        run_remote.return_value = (
            "NodeName=node001 Partitions=apu State=MIXED CPUAlloc=24 CPUTot=96 "
            "Gres=(null) GresUsed=(null) "
            "CfgTRES=cpu=96,mem=220000M,billing=96,gres/gpu=2,gres/gpu:mi300a=2 "
            "AllocTRES=cpu=24,mem=110000M,gres/gpu=1,gres/gpu:mi300a=1\n"
        )

        nodes = collect_node_status(Machine("cluster_1", "host", "user"), 5)

        self.assertEqual(
            nodes[0]["gpu"],
            {"allocated": 1, "idle": 1, "total": 2, "types": {"mi300a": 2}},
        )
        self.assertEqual(partition_gpu_limits(nodes), {"apu": 2})
        ranking = rank_partitions("cluster_1", nodes)
        self.assertEqual(ranking[0]["best_gpu"]["name"], "AMD Instinct MI300A")
        status = ClusterStatus(
            "cluster_1", "host", "user", nodes=nodes, partition_compute=ranking,
            partitions=[{"partition": "apu", "available": "up", "nodes": "1"}],
        )
        partition = build_snapshot([status], "2026-09-24T10:00:00+00:00", 15)["clusters"][0]["partitions"][0]
        self.assertEqual(partition["gpus"]["total"], 2)
        self.assertEqual(partition["gpus"]["schedulable_idle"], 1)
        self.assertEqual(partition["gpus"]["models"][0]["name"], "AMD Instinct MI300A")

    @patch("clusterwatcher.slurm.run_batch")
    def test_detailed_resource_collection_failure_is_reported(self, run_batch):
        run_batch.side_effect = fake_batch({"sinfo": "gpu|up|1|0/64/0/64|idle\n", "nodes": RuntimeError("scontrol denied")})

        status = collect_status(Machine("a", "host", "user"), 5, False)

        self.assertIsNone(status.error)
        self.assertEqual(status.resource_error, "scontrol denied")
        self.assertEqual(status.nodes, [])

    def test_partition_compute_ranks_by_best_single_gpu_and_collapses_aggregate(self):
        from clusterwatcher.compute import rank_partitions

        nodes = [
            {"partitions": "gpu-a100,gpu-all", "cpu": {"total": 64}, "gpu": {"total": 4, "types": {"a100": 4}}},
            {"partitions": "gpu-a40,gpu-all", "cpu": {"total": 64}, "gpu": {"total": 8, "types": {"a40": 8}}},
        ]
        ranked = rank_partitions("cluster_0", nodes)
        self.assertEqual([item["name"] for item in ranked], ["gpu-a100", "gpu-a40", "gpu-all"])
        self.assertEqual(ranked[0]["best_gpu"]["vram_gb"], 80)
        self.assertEqual(ranked[1]["best_gpu"]["tensor_tflops"], 149.7)
        self.assertTrue(ranked[2]["aggregate"])
        self.assertIsNone(ranked[2]["rank"])

    def test_gpu_catalog_is_optional_personal_configuration(self):
        """Read the catalog beside clusters.toml; tolerate absence, reject bad data."""
        from clusterwatcher.compute import configure_gpu_profiles, gpu_profiles, gpu_profiles_path, profile_for

        root = Path(__file__).parents[1]
        self.assertEqual(gpu_profiles_path(Path("/etc/cw/clusters.toml")), Path("/etc/cw/gpu_profiles.toml"))
        with tempfile.TemporaryDirectory() as directory:
            catalog = Path(directory) / "gpu_profiles.toml"
            configure_gpu_profiles(catalog)
            self.assertEqual(gpu_profiles(), ())
            self.assertIsNone(profile_for("cluster_0", ["a100"]))

            catalog.write_text('[[profile]]\ncluster = "c"\nname = "X"\n')
            configure_gpu_profiles(catalog)
            with self.assertRaisesRegex(ValueError, "profile #1 .* incomplete"):
                gpu_profiles()

        configure_gpu_profiles(root / "gpu_profiles.example.toml")
        self.assertEqual(profile_for("cluster-b", ["gpu-a100"]).vram_gb, 40)
        self.assertEqual(profile_for("cluster-a", ["gpu-a100"]).vram_gb, 80)

    @patch("clusterwatcher.cli.load_config", return_value=[])
    def test_cli_reads_gpu_catalog_beside_the_selected_config(self, _load_config):
        from clusterwatcher import compute

        with tempfile.TemporaryDirectory() as directory, redirect_stdout(StringIO()):
            config = Path(directory) / "clusters.toml"
            main(["--config", str(config), "list"])
            self.assertEqual(compute._profiles_path, Path(directory) / "gpu_profiles.toml")

    def test_gpu_profiles_are_scoped_to_the_source_cluster(self):
        from clusterwatcher.compute import profile_for, rank_partitions

        self.assertEqual(profile_for("cluster_0", ["a100"]).vram_gb, 80)
        self.assertEqual(profile_for("cluster_3", ["a100"]).vram_gb, 40)
        self.assertIsNone(profile_for("cluster_2", ["a100"]))

        # CLUSTER_2's Slurm partitions are generic; its node-name prefix
        # identifies the GPU when GRES does not provide a type.
        ranked = rank_partitions(
            "cluster_2",
            [{"name": "bnode01", "partitions": "gpu", "cpu": {"total": 192}, "gpu": {"total": 8, "types": {}}}],
        )
        self.assertEqual(ranked[0]["best_gpu"]["name"], "NVIDIA B200")
        self.assertEqual(ranked[0]["best_gpu"]["vram_gb"], 180)

    @patch("clusterwatcher.slurm.run_batch")
    def test_collector_passes_the_machine_name_to_dashboard_compute_ranking(self, run_batch):
        run_batch.side_effect = fake_batch({
            "sinfo": "gpu|up|16|0/1536/0/1536|idle\n",
            "nodes": "NodeName=bnode01 Partitions=gpu State=IDLE CPUAlloc=0 CPUTot=192 Gres=gpu:8 GresUsed=gpu:0\n",
        })

        status = collect_status(Machine("cluster_2", "host", "user"), 5, False)

        self.assertEqual(status.partition_compute[0]["best_gpu"]["name"], "NVIDIA B200")

    @patch("clusterwatcher.ssh.subprocess.run")
    def test_combined_remote_output_includes_successful_stderr(self, run):
        from clusterwatcher.ssh import run_remote_combined

        run.return_value = subprocess.CompletedProcess(
            [], 0, stdout="", stderr="sbatch: Job 42 to start at 2026-09-21T12:34:56\n"
        )

        output = run_remote_combined(
            Machine("a", "host", "user"), 5, "sbatch --test-only", process_timeout=2,
        )

        self.assertIn("to start at 2026-09-21T12:34:56", output)
        self.assertEqual(run.call_args.kwargs["timeout"], 2)

    @patch("clusterwatcher.dashboard.collect_wait_estimates")
    def test_status_store_caches_wait_probes_independently(self, collect_wait_estimates):
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15)
        store._statuses = [ClusterStatus("a", "host", "user", nodes=[{"partitions": "gpu", "gpu": {"total": 1}}])]
        collect_wait_estimates.return_value = {"gpu": [{"gpus": 1, "walltime_hours": 1, "start_time": "2026-09-21T12:00:00", "error": None}]}

        self.assertTrue(store.refresh_wait_estimates())
        payload = store.payload()["clusters"][0]
        self.assertEqual(payload["wait_estimates"]["gpu"][0]["gpus"], 1)
        self.assertIsNotNone(payload["wait_estimates_updated_at"])

    def test_duplicate_machine_name_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_text('[[machine]]\nname="a"\nhost="one"\nusername="u"\n[[machine]]\nname="a"\nhost="two"\nusername="u"\n')
            with self.assertRaisesRegex(ValueError, "unique"):
                load_config(path)

    def test_dashboard_data_contract(self):
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15)
        store._statuses = [ClusterStatus("a", "host", "user", partitions=[])]
        store._updated_at = "2026-01-01T00:00:00+00:00"
        self.assertIn("Cluster Watcher", PAGE)
        self.assertIn("nodeCard", PAGE)
        self.assertIn("node-state-block", PAGE)
        self.assertIn("partition-status", PAGE)
        self.assertIn("gpu-cell", PAGE)
        self.assertIn("cpu-cell", PAGE)
        self.assertIn("partitionGroups", PAGE)
        self.assertIn("partition_compute", PAGE)
        self.assertIn("aggregate-partition", PAGE)
        self.assertIn("summaryStateClass", PAGE)
        self.assertIn("jobBadges", PAGE)
        self.assertIn("waitLabel", PAGE)
        self.assertIn("job-badge", PAGE)
        self.assertIn("waitChart", PAGE)
        self.assertIn("jobsView", PAGE)
        self.assertIn("recentJobsView", PAGE)
        self.assertIn("/api/v1/jobs/", PAGE)
        self.assertIn("data-log-stream=\"err\"", PAGE)
        self.assertIn("data-log-stream=\"out\"", PAGE)
        self.assertIn("Loading .${stream} tail", PAGE)
        self.assertIn("data-running-progress", PAGE)
        self.assertIn("data-pending-progress", PAGE)
        self.assertIn("Slurm cannot currently estimate", PAGE)
        self.assertIn("Waiting for dependency", PAGE)
        self.assertIn("Next refresh in", PAGE)
        self.assertIn("response.status === 503", PAGE)
        self.assertIn("response.headers.get('Retry-After')", PAGE)
        self.assertIn("if (!result.updated_at)", PAGE)
        self.assertIn("Estimated queue wait in hours", PAGE)
        self.assertIn("My jobs", PAGE)
        self.assertIn("waiting for dependency", PAGE)
        self.assertIn("nodesByAvailableGpu", PAGE)
        self.assertIn("statePriority", PAGE)
        self.assertIn("<details class=\"partition-section", PAGE)
        self.assertIn("How to read this dashboard", PAGE)
        self.assertIn("mixed-powered-off", PAGE)
        self.assertIn("refresh-clock-hand", PAGE)
        self.assertNotIn("refresh-track", PAGE)
        self.assertIn("JOB_ARCHIVE_STORAGE_KEY", PAGE)
        self.assertIn("localStorage.setItem", PAGE)
        self.assertIn("restored_jobs", PAGE)
        self.assertIn("data-job-sort", PAGE)
        self.assertIn("data-job-action=\"${action}\"", PAGE)
        self.assertIn("<details class=\"job-card\"", PAGE)
        self.assertIn("<details class=\"job-group\"", PAGE)
        self.assertIn("job-card-summary-title", PAGE)
        self.assertIn("${timing}</summary>", PAGE)
        self.assertIn("job-progress.completed", PAGE)
        self.assertIn("JOB_GROUP_LABELS", PAGE)
        self.assertIn("Archive (${archived.length})", PAGE)
        self.assertIn("jobDisclosure", PAGE)
        self.assertNotIn("### RUNNING ###", PAGE)
        self.assertIn("Submitted", PAGE)
        self.assertIn("launched:'Launched'", PAGE)
        self.assertIn("ended:'Ended'", PAGE)
        self.assertIn("jobLifecycleCell(job, 'launched')", PAGE)
        self.assertIn("jobLifecycleCell(job, 'ended')", PAGE)
        self.assertIn("submitted.toISOString()", PAGE)
        self.assertIn("rememberPartitionDisclosure", PAGE)
        self.assertIn("data-partition-key", PAGE)
        self.assertEqual(store.payload()["refresh_seconds"], 15)
        self.assertEqual(store.payload()["wait_threshold_minutes"], (5, 30, 60, 120))
        self.assertEqual(store.payload()["clusters"][0]["name"], "a")

    def test_each_test_has_a_short_deadline(self):
        self.assertEqual(self.TEST_TIMEOUT_SECONDS, 5)

    def test_vscode_icon_combines_servers_and_a_magnifier(self):
        """Keep the original CC0 server motif and its search overlay together."""
        root = Path(__file__).parents[1]
        icon = (root / "vscode" / "media" / "cluster-watcher.svg").read_text()
        license_text = (root / "vscode" / "media" / "LICENSE.txt").read_text()

        self.assertGreaterEqual(icon.count("<rect"), 3)
        self.assertIn('class="magnifier-lens"', icon)
        self.assertIn('class="magnifier-handle"', icon)
        self.assertIn("CC0-1.0", icon)
        self.assertIn("CC0 1.0", license_text)

    def test_timeout_guard_interrupts_a_stuck_test(self):
        class StuckTest(TimedTestCase):
            TEST_TIMEOUT_SECONDS = 0.01

            def runTest(self):
                time.sleep(0.1)

        result = unittest.TestResult()
        StuckTest().run(result)
        self.assertEqual(len(result.errors), 1)
        self.assertIn("exceeded its 0.01-second test timeout", result.errors[0][1])


if __name__ == "__main__":
    unittest.main()
