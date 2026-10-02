"""Tests for locating and reading a job's Slurm batch script."""

from unittest.mock import patch

from clusterwatcher.job_scripts import (
    JobScriptNotFound, fetch_batch_script, parse_accounting_script, submitted_script_path,
)
from clusterwatcher.models import Machine
from helpers import TimedTestCase


MACHINE = Machine("alpha", "alpha.example", "alice")


class SubmitLineTests(TimedTestCase):
    """Find the script argument among sbatch options."""

    def test_script_follows_options_with_and_without_values(self):
        cases = {
            "sbatch --parsable --time=04:00:00 --export=ALL slurm/train.sbatch config_a 3": "slurm/train.sbatch",
            "sbatch -p gpu -N 2 job.sh": "job.sh",
            "sbatch -pgpu --hold job.sh arg": "job.sh",
            "/usr/bin/sbatch --partition gpu -H -- 'my job.sh'": "my job.sh",
            "sbatch --array=0-3 -o 'logs/%A_%a.out' /abs/run.sh": "/abs/run.sh",
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                self.assertEqual(submitted_script_path(line), expected)

    def test_wrap_stdin_and_unparseable_lines_have_no_script(self):
        for line in ("sbatch --wrap='python x.py'", "sbatch --wrap 'python x.py'", "sbatch -p gpu",
                     "sbatch -", "srun job.sh", "sbatch 'unterminated", ""):
            with self.subTest(line=line):
                self.assertIsNone(submitted_script_path(line))

    def test_accounting_output_without_a_stored_script_is_ignored(self):
        header = "Batch Script for 10\n" + "-" * 80 + "\n"
        self.assertIsNone(parse_accounting_script(header + "NONE\n"))
        self.assertEqual(parse_accounting_script(header + "#!/bin/bash\necho hi\n"), "#!/bin/bash\necho hi\n")


class FetchBatchScriptTests(TimedTestCase):
    """Prefer exact copies; fall back to the file named by SubmitLine."""

    @patch("clusterwatcher.job_scripts.run_remote", return_value="#!/bin/bash\n#SBATCH -p gpu\n")
    def test_live_job_uses_the_controller_copy(self, run_remote):
        result = fetch_batch_script(MACHINE, 5, "10")

        self.assertEqual(result["source"], "slurm")
        self.assertIsNone(result["path"])
        self.assertIn("scontrol write batch_script 10 -", run_remote.call_args.args[2])

    @patch("clusterwatcher.job_scripts.run_remote")
    def test_finished_job_reads_the_submitted_file_relative_to_workdir(self, run_remote):
        run_remote.side_effect = [
            RuntimeError("Invalid job id specified"),
            "Batch Script for 10\n" + "-" * 80 + "\nNONE\n",
            "sbatch --parsable -p gpu jobs/run.sbatch extra|/work/alice/project\n",
            "#!/bin/bash\necho finished\n",
        ]

        result = fetch_batch_script(MACHINE, 5, "10")

        self.assertEqual(result, {
            "source": "file", "path": "/work/alice/project/jobs/run.sbatch",
            "content": "#!/bin/bash\necho finished\n", "truncated": False,
        })
        self.assertIn("--user=alice", run_remote.call_args_list[2].args[2])
        self.assertIn("head -c", run_remote.call_args_list[3].args[2])

    @patch("clusterwatcher.job_scripts.run_remote")
    def test_stored_accounting_copy_beats_the_current_file(self, run_remote):
        run_remote.side_effect = ["", "Batch Script for 10\n" + "-" * 80 + "\n#!/bin/bash\nexact\n"]

        result = fetch_batch_script(MACHINE, 5, "10")

        self.assertEqual((result["source"], result["content"]), ("accounting", "#!/bin/bash\nexact\n"))

    @patch("clusterwatcher.job_scripts.run_remote")
    def test_wrap_jobs_and_deleted_files_are_reported_as_not_found(self, run_remote):
        run_remote.side_effect = ["", "", "sbatch --wrap='echo hi'|/work\n"]
        with self.assertRaisesRegex(JobScriptNotFound, "not submitted from a script file"):
            fetch_batch_script(MACHINE, 5, "10")

        run_remote.side_effect = ["", "", "sbatch run.sh|/work\n", RuntimeError("Script is not readable")]
        with self.assertRaisesRegex(JobScriptNotFound, "/work/run.sh"):
            fetch_batch_script(MACHINE, 5, "10")

    def test_job_id_is_validated_before_any_remote_command(self):
        with self.assertRaisesRegex(ValueError, "numeric"):
            fetch_batch_script(MACHINE, 5, "10; rm -rf ~")
