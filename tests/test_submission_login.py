"""Submission-host trust uses the existing login session and forwards only yes/no."""

import os
import shlex
import subprocess
import sys
from unittest import skipUnless
from unittest.mock import patch

from clusterwatcher.models import Machine
from clusterwatcher.ssh import verify_submission_host
from helpers import TimedTestCase


PROMPT = (
    "The authenticity of host 'submit (192.0.2.2)' can't be established.\r\n"
    "ED25519 key fingerprint is SHA256:test.\r\n"
    "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
)


@skipUnless(os.name == "posix", "submission login uses POSIX pipes and a remote terminal")
class SubmissionLoginTests(TimedTestCase):
    def run_child(self, script, confirm):
        popen = subprocess.Popen
        commands = []

        def launch(command, **kwargs):
            commands.append(command)
            return popen([sys.executable, "-c", script], **kwargs)

        machine = Machine("lst", "login.example", "alice", submission_host="submit")
        with patch("clusterwatcher.ssh.subprocess.Popen", side_effect=launch), \
                patch("clusterwatcher.ssh.subprocess.run", return_value=subprocess.CompletedProcess(
                    [], 255, "", "Host key verification failed.",
                )):
            verify_submission_host(machine, 1, confirm)
        return commands[0]

    def test_split_prompt_can_be_confirmed_on_the_login_host(self):
        requests = []

        def confirm(kind, prompt):
            requests.append((kind, prompt))
            return "yes"

        command = self.run_child(
            "import sys,time\n"
            f"p={PROMPT!r}\n"
            "sys.stdout.write(p[:60]); sys.stdout.flush(); time.sleep(.01)\n"
            "sys.stdout.write(p[60:]); sys.stdout.flush()\n"
            "assert sys.stdin.readline() == 'yes\\n'\n", confirm,
        )
        self.assertEqual(requests[0][0], "host_key")
        self.assertIn("SHA256:test", requests[0][1])
        self.assertIn("known-hosts file on login.example", requests[0][1])
        self.assertIn("-tt", command)
        self.assertIn("ProxyCommand=false", command)
        self.assertEqual(command[-2], "alice@login.example")
        inner = shlex.split(command[-1])
        self.assertEqual(inner[-2:], ["submit", "true"])
        for setting in ("PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "NumberOfPasswordPrompts=0"):
            self.assertIn(setting, inner)

    def test_cancellation_sends_no_and_reports_failed_hop(self):
        with self.assertRaisesRegex(RuntimeError, "Submission hop login.example → submit failed"):
            self.run_child(
                "import sys\n"
                f"sys.stdout.write({PROMPT!r}); sys.stdout.flush()\n"
                "assert sys.stdin.readline() == 'no\\n'\n"
                "print('Host key verification failed.'); sys.exit(255)\n",
                lambda *_: "no",
            )

    def test_known_host_does_not_prompt(self):
        machine = Machine("lst", "login.example", "alice", submission_host="submit")
        with patch("clusterwatcher.ssh.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run, \
                patch("clusterwatcher.ssh.subprocess.Popen") as popen:
            verify_submission_host(machine, 1, lambda *_: self.fail("unexpected prompt"))
        popen.assert_not_called()
        self.assertIn("BatchMode=yes", shlex.split(run.call_args.args[0][-1]))

    def test_changed_host_key_does_not_offer_approval(self):
        with self.assertRaisesRegex(RuntimeError, "REMOTE HOST IDENTIFICATION HAS CHANGED"):
            self.run_child(
                "import sys; print('REMOTE HOST IDENTIFICATION HAS CHANGED!'); sys.exit(255)",
                lambda *_: self.fail("unexpected prompt"),
            )

    def test_changed_key_or_auth_failure_in_preflight_does_not_allocate_terminal(self):
        machine = Machine("lst", "login.example", "alice", submission_host="submit")
        for diagnostic in ("REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
                           "Permission denied (publickey)."):
            with self.subTest(diagnostic=diagnostic), \
                    patch("clusterwatcher.ssh.subprocess.run", return_value=subprocess.CompletedProcess([], 255, "", diagnostic)), \
                    patch("clusterwatcher.ssh.subprocess.Popen") as popen:
                with self.assertRaises(RuntimeError):
                    verify_submission_host(machine, 1, lambda *_: self.fail("unexpected prompt"))
                popen.assert_not_called()

    def test_credential_or_unknown_challenge_never_gets_a_secret(self):
        with self.assertRaisesRegex(RuntimeError, "Permission denied"):
            self.run_child("import sys; print('Permission denied (publickey).'); sys.exit(255)",
                           lambda *_: self.fail("must not ask for second-hop credentials"))

    def test_machine_without_submission_hop_does_not_spawn(self):
        with patch("clusterwatcher.ssh.subprocess.Popen") as popen:
            verify_submission_host(Machine("one", "login.example", "alice"), 1, lambda *_: "yes")
        popen.assert_not_called()
