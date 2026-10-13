"""Tests for re-opening closed interactive SSH sessions (``cluster-watcher login``)."""

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from unittest.mock import patch

from clusterwatcher.cli import main, run_login
from clusterwatcher.credentials import (
    CREDENTIAL_PROMPT_PREFIX,
    CredentialPromptCancelled,
    JsonLineCredentialPrompt,
    login_targets,
)
from clusterwatcher.dashboard import StatusStore
from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.snapshot import build_snapshot
from clusterwatcher.ssh import ssh_command
from helpers import TimedTestCase


GROUP_A = Machine("cluster_0", "c0.example", "alice", interactive_auth=True, credential_group="site")
GROUP_B = Machine("cluster_1", "c1.example", "alice", interactive_auth=True, credential_group="site")
LONE = Machine("cluster_2", "c2.example", "alice", interactive_auth=True)
KEYED = Machine("cluster_3", "c3.example", "alice")
MACHINES = [GROUP_A, GROUP_B, LONE, KEYED]


class LoginTargetTests(TimedTestCase):
    """One named machine brings its credential group, so one password covers it."""

    def test_named_machine_includes_its_credential_group_only(self):
        self.assertEqual(login_targets(MACHINES, ["cluster_0"]), [GROUP_A, GROUP_B])

    def test_exact_named_machine_excludes_credential_group_peers(self):
        self.assertEqual(login_targets(MACHINES, ["cluster_0"], False), [GROUP_A])

    def test_ungrouped_machine_is_logged_in_alone(self):
        self.assertEqual(login_targets(MACHINES, ["cluster_2"]), [LONE])

    def test_no_names_means_every_interactive_machine(self):
        self.assertEqual(login_targets(MACHINES, []), [GROUP_A, GROUP_B, LONE])

    def test_unknown_names_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown machine"):
            login_targets(MACHINES, ["nope"])

    @patch("clusterwatcher.cli.establish_interactive_sessions")
    def test_run_login_reports_each_target_and_fails_on_errors(self, establish):
        establish.return_value = [(GROUP_B, RuntimeError("Permission denied"))]
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run_login(MACHINES, ["cluster_0"], 15)

        self.assertEqual(code, 1)
        establish.assert_called_once_with([GROUP_A, GROUP_B], 15, None)
        self.assertIn("cluster_0: session open", out.getvalue())
        self.assertIn("cluster_1: login failed: Permission denied", err.getvalue())

    @patch("clusterwatcher.cli.run_login", return_value=0)
    @patch("clusterwatcher.cli.load_config", return_value=MACHINES)
    def test_cli_subcommand_passes_names_and_timeout(self, _load, run):
        with patch("clusterwatcher.cli.configure_gpu_profiles"), patch("clusterwatcher.cli.gpu_profiles"):
            self.assertEqual(main(["login", "cluster_0", "--timeout", "7"]), 0)
        run.assert_called_once_with(MACHINES, ["cluster_0"], 7, None, True)

    @patch("clusterwatcher.cli.run_login", return_value=0)
    @patch("clusterwatcher.cli.load_config", return_value=MACHINES)
    def test_cli_only_flag_excludes_credential_group_peers(self, _load, run):
        with patch("clusterwatcher.cli.configure_gpu_profiles"), patch("clusterwatcher.cli.gpu_profiles"):
            self.assertEqual(main(["login", "cluster_0", "--only"]), 0)
        run.assert_called_once_with(MACHINES, ["cluster_0"], 15, None, False)

    def test_json_line_prompt_keeps_secret_out_of_request_output(self):
        response = StringIO(json.dumps({"request_id": 1, "value": "top-secret"}) + "\n")
        requests = StringIO()

        value = JsonLineCredentialPrompt(response, requests)("password", "Password for alice")

        self.assertEqual(value, "top-secret")
        line = requests.getvalue().strip()
        self.assertTrue(line.startswith(CREDENTIAL_PROMPT_PREFIX))
        request = json.loads(line.removeprefix(CREDENTIAL_PROMPT_PREFIX))
        self.assertEqual(request, {
            "version": 1, "request_id": 1, "kind": "password", "prompt": "Password for alice",
        })
        self.assertNotIn("top-secret", line)

    def test_json_line_prompt_accepts_cancellation_without_echoing_a_secret(self):
        response = StringIO('{"request_id":1,"cancel":true}\n')
        with self.assertRaisesRegex(CredentialPromptCancelled, "cancelled"):
            JsonLineCredentialPrompt(response, StringIO())("otp", "One-time code")

    @patch("clusterwatcher.cli.JsonLineCredentialPrompt")
    @patch("clusterwatcher.cli.run_login", return_value=0)
    @patch("clusterwatcher.cli.load_config", return_value=MACHINES)
    def test_cli_machine_protocol_is_forwarded_to_login(self, _load, run, prompt_type):
        prompt = prompt_type.return_value
        with patch("clusterwatcher.cli.configure_gpu_profiles"), patch("clusterwatcher.cli.gpu_profiles"):
            self.assertEqual(main(["login", "cluster_0", "--credential-stdin-json"]), 0)
        run.assert_called_once_with(MACHINES, ["cluster_0"], 15, prompt, True)


class LoginRequiredTests(TimedTestCase):
    """The service flags failed interactive clusters whose shared session is gone."""

    def refresh(self, machine, session_open):
        status = ClusterStatus(machine.name, machine.host, machine.username, error="Permission denied")
        with patch("clusterwatcher.dashboard.collect_status", return_value=status), \
                patch("clusterwatcher.dashboard.session_status", return_value={"session_open": session_open}) as check:
            store = StatusStore([machine], 5, False, 15)
            store.refresh()
        return store, check

    def test_closed_session_sets_login_required_in_both_apis(self):
        store, _check = self.refresh(GROUP_A, session_open=False)

        self.assertTrue(store.payload()["clusters"][0]["login_required"])
        self.assertTrue(store.snapshot_payload()["clusters"][0]["login_required"])

    def test_open_session_means_another_problem(self):
        store, _check = self.refresh(GROUP_A, session_open=True)
        self.assertFalse(store.payload()["clusters"][0]["login_required"])

    def test_key_based_machines_are_never_checked(self):
        store, check = self.refresh(KEYED, session_open=False)
        check.assert_not_called()
        self.assertFalse(store.payload()["clusters"][0]["login_required"])

    def test_healthy_clusters_skip_the_session_check(self):
        healthy = ClusterStatus(GROUP_A.name, GROUP_A.host, GROUP_A.username)
        with patch("clusterwatcher.dashboard.collect_status", return_value=healthy), \
                patch("clusterwatcher.dashboard.session_status") as check:
            StatusStore([GROUP_A], 5, False, 15).refresh()
        check.assert_not_called()

    def test_snapshot_defaults_to_not_required(self):
        snapshot = build_snapshot([ClusterStatus("c", "h", "u")], None, 15)
        self.assertFalse(snapshot["clusters"][0]["login_required"])


class KeepaliveTests(TimedTestCase):
    def test_shared_sessions_send_keepalives(self):
        command = " ".join(ssh_command(GROUP_A, 5, "true"))
        self.assertIn("ServerAliveInterval=30", command)
        self.assertIn("ServerAliveCountMax=4", command)
