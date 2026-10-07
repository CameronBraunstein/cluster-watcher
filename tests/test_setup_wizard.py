"""Tests for the interactive ``setup`` and ``config`` commands."""

from pathlib import Path
import tempfile
from unittest.mock import patch

from clusterwatcher.cli import main
from clusterwatcher.config import load_config
from clusterwatcher.setup_wizard import edit_config, find_editor, render_config, run_setup
from helpers import TimedTestCase


def scripted(*answers: str):
    """Return a prompt function that replays ``answers`` in order."""
    remaining = list(answers)
    return lambda _question: remaining.pop(0)


class SetupWizardTests(TimedTestCase):
    """Exercise configuration creation and editing without a terminal."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "clusters.toml"

    def tearDown(self):
        self.directory.cleanup()

    def test_setup_writes_a_valid_multi_machine_configuration(self):
        prompt = scripted(
            "cluster_0", "slurm.example", "", "", "", "n", "/work/logs", "y",
            "cluster_1", "cluster_1.example", "bob", "2222", "~/.ssh/key", "y", "site_group", "", "n",
        )
        output: list[str] = []

        self.assertEqual(run_setup(self.path, prompt, output.append, {"USER": "alice"}), 0)

        machines = load_config(self.path)
        self.assertEqual([machine.name for machine in machines], ["cluster_0", "cluster_1"])
        self.assertEqual(machines[0].username, "alice")
        self.assertEqual(machines[0].job_log_roots, ("/work/logs",))
        self.assertEqual((machines[1].port, machines[1].credential_group), (2222, "site_group"))
        self.assertTrue(machines[1].interactive_auth)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_setup_rejects_duplicate_names_and_keeps_existing_file_unless_confirmed(self):
        self.path.write_text("existing")
        output: list[str] = []

        self.assertEqual(run_setup(self.path, scripted("n"), output.append, {}), 1)
        self.assertEqual(self.path.read_text(), "existing")

        prompt = scripted("y", "a", "a.example", "u", "", "", "n", "", "y", "a", "b", "b.example", "", "", "", "n", "", "n")
        self.assertEqual(run_setup(self.path, prompt, output.append, {}), 0)
        self.assertEqual([machine.name for machine in load_config(self.path)], ["a", "b"])
        self.assertEqual(self.path.with_name("clusters.toml.bak").read_text(), "existing")
        self.assertTrue(any("already exists" in line for line in output))

    def test_rendered_strings_are_escaped(self):
        text = render_config([{"name": 'odd"name', "host": "h", "username": "u"}])
        self.assertIn('name = "odd\\"name"', text)

    def test_editor_prefers_visual_then_editor_then_fallback(self):
        self.assertEqual(find_editor({"VISUAL": "code --wait", "EDITOR": "vim"}), ["code", "--wait"])
        self.assertEqual(find_editor({"EDITOR": "emacs"}), ["emacs"])
        self.assertEqual(find_editor({}, lambda name: name if name == "vi" else None), ["vi"])
        self.assertEqual(
            find_editor({}, lambda name: name if name == "notepad" else None, system_name="nt"),
            ["notepad"],
        )
        with self.assertRaisesRegex(RuntimeError, "EDITOR"):
            find_editor({}, lambda _name: None)

    def test_config_reopens_editor_until_valid(self):
        self.path.write_text("not toml [")
        valid = render_config([{"name": "a", "host": "h", "username": "u"}])
        calls: list[list[str]] = []

        def editor(command):
            calls.append(command)
            if len(calls) == 2:
                self.path.write_text(valid)

        output: list[str] = []
        result = edit_config(self.path, scripted("y"), output.append, {"EDITOR": "nano"}, editor)

        self.assertEqual(result, 0)
        self.assertEqual(calls, [["nano", str(self.path)]] * 2)
        self.assertTrue(any("invalid" in line for line in output))

    def test_config_offers_setup_when_file_is_missing(self):
        self.assertEqual(edit_config(self.path, scripted("n"), lambda _line: None, {}), 1)

    def test_config_path_prints_resolved_location_without_editing(self):
        from contextlib import redirect_stdout
        from io import StringIO

        buffer = StringIO()
        with patch("clusterwatcher.cli.edit_config") as edit, redirect_stdout(buffer):
            self.assertEqual(main(["--config", str(self.path), "config", "--path"]), 0)
        edit.assert_not_called()
        self.assertEqual(buffer.getvalue().strip(), str(self.path.resolve()))

    @patch("clusterwatcher.cli.run_setup", return_value=0)
    @patch("clusterwatcher.cli.edit_config", return_value=0)
    def test_cli_dispatches_without_loading_a_missing_config(self, edit, setup):
        self.assertEqual(main(["--config", str(self.path), "setup"]), 0)
        self.assertEqual(main(["--config", str(self.path), "set-up"]), 0)
        self.assertEqual(main(["--config", str(self.path), "config"]), 0)
        self.assertEqual(setup.call_count, 2)
        edit.assert_called_once_with(self.path)
