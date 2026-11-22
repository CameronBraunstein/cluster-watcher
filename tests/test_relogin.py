"""Tests for re-opening closed interactive SSH sessions (``cluster-watcher login``)."""

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
import subprocess
import sys
from unittest import skipUnless
from unittest.mock import patch

from clusterwatcher.cli import main, run_login
from clusterwatcher.credentials import (
    CREDENTIAL_PROMPT_PREFIX,
    ASKPASS_PROGRAM,
    CredentialBroker,
    CredentialPromptCancelled,
    JsonLineCredentialPrompt,
    establish_interactive_sessions,
    establish_login_sessions,
    login_targets,
)
from clusterwatcher.dashboard import StatusStore
from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.snapshot import build_snapshot
from clusterwatcher.ssh import ssh_command
from clusterwatcher.ssh import select_login_machine
from helpers import TimedTestCase


GROUP_A = Machine("cluster_0", "c0.example", "alice", interactive_auth=True, credential_group="site")
GROUP_B = Machine("cluster_1", "c1.example", "alice", interactive_auth=True, credential_group="site")
LONE = Machine("cluster_2", "c2.example", "alice", interactive_auth=True)
KEYED = Machine("cluster_3", "c3.example", "alice")
MACHINES = [GROUP_A, GROUP_B, LONE, KEYED]
HOST_KEY_PROMPT = (
    "The authenticity of host 'password-otp.example (192.0.2.1)' can't be established.\n"
    "ED25519 key fingerprint is SHA256:exampleFingerprint.\n"
    "This key is not known by any other names.\n"
    "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
)


class HostKeyPromptTests(TimedTestCase):
    def test_new_host_requires_explicit_approval_without_disclosing_credentials(self):
        for answer in ("yes", "no", "", "YES", "shared-password", None):
            with self.subTest(answer=answer):
                prompts = []

                def confirm(kind, prompt):
                    prompts.append((kind, prompt))
                    return answer

                broker = CredentialBroker("shared-password", confirm)
                broker.update_otp("123456")
                self.assertEqual(broker._response(HOST_KEY_PROMPT), "yes" if answer == "yes" else "no")
                self.assertEqual(prompts, [("host_key", HOST_KEY_PROMPT)])
                self.assertEqual(broker._response("Password:"), "shared-password")
                self.assertEqual(broker._response("One-time password:"), "123456")

    def test_missing_confirmation_handler_and_changed_keys_are_not_approved(self):
        broker = CredentialBroker("shared-password")
        self.assertEqual(broker._response(HOST_KEY_PROMPT), "")
        with patch("builtins.input", side_effect=AssertionError("unexpected prompt")):
            broker = CredentialBroker("shared-password", lambda *_args: self.fail("unexpected confirmation"))
            for prompt in (
                "Accept host key (yes/no)?",
                "Warning: the host key for 'password.example' differs from the key for the IP address.\n"
                "Are you sure you want to continue connecting (yes/no)?",
                "REMOTE HOST IDENTIFICATION HAS CHANGED!",
                "An unknown authentication challenge:",
            ):
                self.assertEqual(broker._response(prompt), "")

    def test_cancelled_or_closed_confirmation_rejects_the_host(self):
        for error in (CredentialPromptCancelled("cancelled"), EOFError()):
            with self.subTest(error=error):
                def confirm(*_args):
                    raise error

                self.assertEqual(CredentialBroker("secret", confirm)._response(HOST_KEY_PROMPT), "no")

    def test_approval_is_not_shared_between_hosts(self):
        prompts = []

        def confirm(_kind, prompt):
            prompts.append(prompt)
            return "yes" if len(prompts) == 1 else "no"

        broker = CredentialBroker("secret", confirm)
        self.assertEqual(broker._response(HOST_KEY_PROMPT), "yes")
        second = HOST_KEY_PROMPT.replace("password-otp.example", "other.example")
        self.assertEqual(broker._response(second), "no")
        self.assertEqual(prompts, [HOST_KEY_PROMPT, second])

    def test_host_confirmation_round_trips_the_json_protocol(self):
        requests = StringIO()
        client = JsonLineCredentialPrompt(StringIO('{"request_id":1,"value":"yes"}\n'), requests)
        self.assertEqual(CredentialBroker("secret", client)._response(HOST_KEY_PROMPT), "yes")
        line = requests.getvalue().strip().removeprefix(CREDENTIAL_PROMPT_PREFIX)
        self.assertEqual(json.loads(line)["kind"], "host_key")
        self.assertEqual(json.loads(line)["prompt"], HOST_KEY_PROMPT)

    @skipUnless(os.name == "posix", "askpass broker requires Unix sockets")
    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    def test_login_routes_host_trust_through_the_real_askpass_transport(self, _status):
        prompts = []

        def confirm(kind, message):
            prompts.append((kind, message))
            return {"host_key": "yes", "password": "shared-password", "otp": "123456"}[kind]

        def authenticate(_machine, _timeout, environment):
            for prompt, expected in (
                (HOST_KEY_PROMPT, "yes"), ("Password:", "shared-password"), ("OTP:", "123456"),
            ):
                result = subprocess.run(
                    [sys.executable, str(ASKPASS_PROGRAM), prompt],
                    env={**os.environ, **environment}, capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, expected)

        with patch("clusterwatcher.credentials.start_interactive_session", side_effect=authenticate):
            self.assertEqual(establish_interactive_sessions([LONE], 5, confirm), [])
        self.assertEqual([kind for kind, _ in prompts], ["password", "otp", "host_key"])

    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    def test_terminal_credential_group_can_confirm_a_host(self, _status):
        def authenticate(_machine, _timeout, _environment):
            confirm = broker_type.call_args.args[1]
            self.assertEqual(confirm("host_key", HOST_KEY_PROMPT), "yes")

        with patch("clusterwatcher.credentials.CredentialBroker") as broker_type, \
                patch("clusterwatcher.credentials.start_interactive_session", side_effect=authenticate), \
                patch("clusterwatcher.credentials.getpass.getpass", side_effect=["secret", "123456"]), \
                patch("builtins.input", return_value="yes"), redirect_stderr(StringIO()) as output:
            self.assertEqual(establish_interactive_sessions([GROUP_A], 5), [])
        self.assertIn(HOST_KEY_PROMPT, output.getvalue())


class LoginTargetTests(TimedTestCase):
    """One named machine brings its credential group, so one password covers it."""

    def test_named_machine_includes_its_credential_group_only(self):
        self.assertEqual(login_targets(MACHINES, ["cluster_0"]), [GROUP_A, GROUP_B])

    def test_exact_named_machine_excludes_credential_group_peers(self):
        self.assertEqual(login_targets(MACHINES, ["cluster_0"], False), [GROUP_A])

    def test_ungrouped_machine_is_logged_in_alone(self):
        self.assertEqual(login_targets(MACHINES, ["cluster_2"]), [LONE])

    def test_no_names_includes_password_only_and_key_based_machines(self):
        self.assertEqual(login_targets(MACHINES, []), MACHINES)

    def test_named_non_mfa_machine_can_log_in(self):
        self.assertEqual(login_targets(MACHINES, [KEYED.name], False), [KEYED])

    def test_unknown_names_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown machine"):
            login_targets(MACHINES, ["nope"])

    @patch("clusterwatcher.ssh.socket.create_connection")
    @patch("clusterwatcher.ssh.session_status", return_value={"session_open": False})
    def test_login_selection_skips_an_unreachable_primary_node(self, _status, connect):
        """Probe physical nodes before prompting so a dead node consumes no OTP."""
        connection = connect.return_value
        connect.side_effect = [OSError("connection refused"), connection]
        machine = Machine(
            "cluster_a", "login12.example", "alice", interactive_auth=True,
            hosts=("login12.example", "login13.example"),
        )
        with patch.dict("clusterwatcher.ssh._selected_hosts", {}, clear=True):
            selected = select_login_machine(machine, 7)

        self.assertEqual(selected.host, "login13.example")
        self.assertEqual(selected.candidate_hosts, ("login13.example",))
        self.assertEqual(
            [call.args[0] for call in connect.call_args_list],
            [("login12.example", 22), ("login13.example", 22)],
        )
        connection.close.assert_called_once_with()

    @patch("clusterwatcher.cli.establish_login_sessions")
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


@skipUnless(os.name == "posix", "askpass broker requires Unix sockets")
class ExplicitLoginTests(TimedTestCase):
    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    @patch("clusterwatcher.credentials.verify_submission_host")
    def test_password_only_login_confirms_host_without_requesting_otp(self, verify, _status):
        prompts = []
        machine = Machine("lst", "login.example", "alice", submission_host="submit")

        def prompt(kind, message):
            prompts.append((kind, message))
            return {"host_key": "yes", "password": "secret"}[kind]

        def authenticate(_machine, _timeout, environment):
            for challenge, expected in ((HOST_KEY_PROMPT, "yes"), ("alice's password:", "secret")):
                result = subprocess.run([sys.executable, str(ASKPASS_PROGRAM), challenge],
                                        env={**os.environ, **environment}, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.stdout, expected)

        with patch("clusterwatcher.credentials.start_interactive_session", side_effect=authenticate):
            self.assertEqual(establish_login_sessions([machine], 5, prompt), [])
        self.assertEqual([kind for kind, _ in prompts], ["host_key", "password"])
        verify.assert_called_once_with(machine, 5, prompt)

    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    @patch("clusterwatcher.credentials.verify_submission_host")
    @patch("clusterwatcher.credentials.start_interactive_session")
    def test_key_login_needs_no_credential_prompts(self, start, _verify, _status):
        self.assertEqual(establish_login_sessions([KEYED], 5, lambda *_: self.fail("unexpected prompt")), [])
        start.assert_called_once()

    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": True})
    @patch("clusterwatcher.credentials.verify_submission_host", side_effect=RuntimeError("host key verification failed"))
    @patch("clusterwatcher.credentials.start_interactive_session")
    def test_open_login_session_still_checks_submission_trust(self, start, verify, _status):
        machine = Machine("lst", "login.example", "alice", submission_host="submit")
        errors = establish_login_sessions([machine], 5, lambda *_: self.fail("unexpected credential"))
        start.assert_not_called()
        verify.assert_called_once()
        self.assertEqual(errors[0][0], machine)
        self.assertIn("host key verification failed", str(errors[0][1]))

    def test_lazy_credentials_share_only_password_and_clear_otp_per_host(self):
        requests = []

        def prompt(kind, message):
            requests.append(kind)
            return f"{kind}-{len(requests)}"

        broker = CredentialBroker("", credential_prompt=prompt)
        self.assertEqual(broker._response("Password:"), "password-1")
        self.assertEqual(broker._response("OTP:"), "otp-2")
        broker.update_otp("")
        self.assertEqual(broker._response("Password:"), "password-1")
        self.assertEqual(broker._response("OTP:"), "otp-3")
        self.assertEqual(broker._response("Enter passphrase for key '/tmp/test':"), "passphrase-4")
        self.assertEqual(requests, ["password", "otp", "otp", "passphrase"])

    def test_cancelled_credential_prompt_is_not_repeated(self):
        requests = []

        def prompt(*_args):
            requests.append(1)
            raise CredentialPromptCancelled("cancelled")

        broker = CredentialBroker("", credential_prompt=prompt)
        self.assertEqual(broker._response("Password:"), "")
        self.assertEqual(broker._response("Password:"), "")
        self.assertTrue(broker.cancelled)
        self.assertEqual(len(requests), 1)

    def test_broker_shutdown_can_clear_secrets_while_a_prompt_is_open(self):
        def prompt(*_args):
            broker.__exit__(None, None, None)
            return "late-secret"

        broker = CredentialBroker("", credential_prompt=prompt)
        self.assertEqual(broker._response("Password:"), "")
        self.assertEqual(broker._password, "")

    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    @patch("clusterwatcher.credentials.verify_submission_host")
    def test_grouped_mfa_retries_expired_otp_and_shares_only_password(self, _verify, _status):
        requests = []
        attempts = []

        def prompt(kind, message):
            requests.append(kind)
            return "password" if kind == "password" else str(len(requests))

        def authenticate(machine, _timeout, environment):
            attempts.append(machine.name)
            for challenge in ("Password:", "One-time password:"):
                subprocess.run([sys.executable, str(ASKPASS_PROGRAM), challenge],
                               env={**os.environ, **environment}, capture_output=True, timeout=3, check=True)
            if len(attempts) == 1:
                raise RuntimeError("Permission denied")

        with patch("clusterwatcher.credentials.start_interactive_session", side_effect=authenticate):
            self.assertEqual(establish_login_sessions([GROUP_A, GROUP_B], 5, prompt), [])
        self.assertEqual(attempts, [GROUP_A.name, GROUP_A.name, GROUP_B.name])
        self.assertEqual(requests, ["password", "otp", "otp", "otp"])

    @patch("clusterwatcher.credentials.session_status", return_value={"session_open": False})
    @patch("clusterwatcher.credentials.verify_submission_host")
    @patch("clusterwatcher.credentials.start_interactive_session", side_effect=RuntimeError("Permission denied"))
    def test_password_only_failure_does_not_invent_an_otp_retry(self, start, verify, _status):
        errors = establish_login_sessions([KEYED], 5, lambda *_: self.fail("unexpected prompt"))
        self.assertEqual(len(errors), 1)
        start.assert_called_once()
        verify.assert_not_called()


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
