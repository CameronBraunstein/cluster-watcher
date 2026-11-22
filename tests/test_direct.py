"""Direct SSH submission and monitoring without a live remote machine."""

from datetime import datetime, timedelta, timezone
from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from clusterwatcher.config import load_config
from clusterwatcher.cli import main
from clusterwatcher.direct import _INVENTORY_COMMAND, _parse_inventory, collect_status, submit_job
from clusterwatcher.jobs import JobService
from clusterwatcher.models import Machine
from clusterwatcher.snapshot import build_snapshot
from clusterwatcher.terminal_status import render_status_board
from helpers import TimedTestCase


class DirectTests(TimedTestCase):
    """Verify that direct hosts never inherit scheduler or failover semantics."""

    def setUp(self) -> None:
        """Use two independently addressable SSH members."""
        self.machine = Machine("lab", "gpu-a.example", "alice", hosts=("gpu-a.example", "gpu-b.example"),
                               scheduler="direct")

    def test_config_accepts_direct_members_and_rejects_scheduler_hop(self):
        """A direct host array is a set of job destinations, not login failover."""
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "clusters.toml"
            config.write_text('[[machine]]\nname="lab"\nhost=["gpu-a", "gpu-b"]\n'
                              'username="alice"\nscheduler="direct"\n', encoding="utf-8")
            machine = load_config(config)[0]
            self.assertEqual(machine.candidate_hosts, ("gpu-a", "gpu-b"))
            self.assertEqual(machine.scheduler, "direct")
            config.write_text(config.read_text(encoding="utf-8") + 'submission_host="submit"\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cannot set submission_host"):
                load_config(config)

    def test_submit_starts_one_tmux_session_and_runner_writes_separate_logs(self):
        """The remote manifest, script, and logs survive the submitting process."""
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            work = home / "remote work"
            work.mkdir()
            script = work / "train.sh"
            script.write_text(
                "#!/bin/bash\n#SBATCH --job-name=demo\n#SBATCH --output=logs/%x-%j.out\n"
                "#SBATCH --error=logs/%j.err\n#SBATCH --cpus-per-task=2\n"
                "#SBATCH --gpus=1\necho finished\necho warning >&2\nexit 3\n",
                encoding="utf-8",
            )
            tools = home / "bin"
            tools.mkdir()
            tmux = tools / "tmux"
            tmux.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/tmux-args"\n', encoding="utf-8")
            tmux.chmod(0o700)
            env = {**os.environ, "HOME": str(home), "PATH": f"{tools}:{os.environ['PATH']}"}
            seen_hosts = []

            def fake_remote(endpoint, _timeout, command, *, failover=True):
                seen_hosts.append((endpoint.host, failover))
                result = subprocess.run(["sh", "-c", command], env=env, text=True,
                                        capture_output=True, timeout=2, check=False)
                if result.returncode:
                    raise RuntimeError(result.stderr or f"remote exit {result.returncode}")
                return result.stdout

            with patch("clusterwatcher.direct.run_remote", side_effect=fake_remote):
                result = submit_job(self.machine, "gpu-b.example", str(work), "train.sh", timeout=3)
            self.assertEqual(seen_hosts, [("gpu-b.example", False), ("gpu-b.example", False)])
            self.assertEqual(result["cpus"], 2)
            self.assertEqual(result["gpus"], 1)
            self.assertEqual(result["tmux_session"], f"cw-{result['job_id']}")
            self.assertIn(result["tmux_session"], (home / "tmux-args").read_text(encoding="utf-8"))
            state = home / ".local/share/cluster-watcher/direct-jobs" / result["job_id"]
            manifest = json.loads((state / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["host"], "gpu-b.example")
            self.assertEqual(manifest["stdout"], result["stdout"])
            execution = subprocess.run(["sh", str(state / "run.sh")], env=env, text=True,
                                       capture_output=True, timeout=2, check=False)
            self.assertEqual(execution.returncode, 3)
            self.assertEqual(Path(result["stdout"]).read_text(encoding="utf-8"), "finished\n")
            self.assertEqual(Path(result["stderr"]).read_text(encoding="utf-8"), "warning\n")
            self.assertEqual((state / "exit_code").read_text(encoding="utf-8").strip(), "3")
            inventory = subprocess.run(["sh", "-c", _INVENTORY_COMMAND], env=env, text=True,
                                       capture_output=True, timeout=2, check=True)
            recovered = _parse_inventory(inventory.stdout, "gpu-b.example")
            self.assertEqual(recovered[0]["state"], "FAILED")
            self.assertEqual(recovered[0]["exit_code"], 3)

    def test_rejects_arrays_dependencies_and_unknown_hosts_before_launch(self):
        """Unsupported scheduler features and unconfigured destinations fail early."""
        with self.assertRaisesRegex(ValueError, "not a direct SSH member"):
            submit_job(self.machine, "other.example", "/work", "job.sh")
        with patch("clusterwatcher.direct.run_remote", return_value="#SBATCH --array=1-4\necho hello\n"):
            with self.assertRaisesRegex(ValueError, "not supported"):
                submit_job(self.machine, "gpu-a.example", "/work", "job.sh")
        with patch("clusterwatcher.direct.run_remote", return_value="#SBATCH --dependency=afterok:1\n"):
            with self.assertRaisesRegex(ValueError, "not supported"):
                submit_job(self.machine, "gpu-a.example", "/work", "job.sh")
        with patch("clusterwatcher.direct.run_remote", return_value="#SBATCH -d afterok:1\n"):
            with self.assertRaisesRegex(ValueError, "not supported"):
                submit_job(self.machine, "gpu-a.example", "/work", "job.sh")

    def test_submit_command_selects_cluster_and_named_host(self):
        """Expose the new command without contacting a scheduler."""
        result = {"job_id": "123", "tmux_session": "cw-123", "stdout": "/work/123.out", "stderr": "/work/123.err"}
        output = StringIO()
        with patch("clusterwatcher.cli.load_config", return_value=[self.machine]), \
             patch("clusterwatcher.cli.gpu_profiles", return_value={}), \
             patch("clusterwatcher.cli.submit_job", return_value=result) as submit, \
             redirect_stdout(output):
            self.assertEqual(main(["submit", "lab", "gpu-b.example", "/work", "train.sh"]), 0)
        submit.assert_called_once_with(self.machine, "gpu-b.example", "/work", "train.sh", 15)
        self.assertIn("cw-123", output.getvalue())

    def test_monitor_restores_running_and_finished_jobs_and_exposes_logs(self):
        """A second process can read remote manifests and route logs by host."""
        submitted = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        records = [
            {"job_id": "123", "name": "training", "host": "gpu-a.example", "workdir": "/work",
             "script": "/work/train.sh", "stdout": "/work/train.out", "stderr": "/work/train.err",
             "submit_at": submitted, "cpus": 4, "gpus": 2},
            {"job_id": "124", "name": "finished", "host": "gpu-b.example", "workdir": "/work",
             "script": "/work/test.sh", "stdout": "/work/test.out", "stderr": "/work/test.err",
             "submit_at": submitted, "cpus": 1, "gpus": 0},
        ]
        lines = {
            "gpu-a.example": "CW\t" + json.dumps(records[0]) + "\t" + submitted + "\t\t\t\t1\n",
            "gpu-b.example": "CW\t" + json.dumps(records[1]) + "\t" + submitted
                             + "\t" + submitted + "\t0\t\t0\n",
        }
        with patch("clusterwatcher.direct.run_remote", side_effect=lambda endpoint, *_args, **_kwargs: lines[endpoint.host]):
            status = collect_status(self.machine, 3, True)
        self.assertIsNone(status.error)
        self.assertEqual([job["state"] for job in status.user_jobs], ["RUNNING", "COMPLETED"])
        self.assertEqual(status.jobs, {"RUNNING": 1, "COMPLETED": 1})
        snapshot = build_snapshot([status], datetime.now(timezone.utc).isoformat(), 15)
        self.assertEqual(snapshot["clusters"][0]["direct_members"][0]["running"], 1)
        self.assertEqual(snapshot["clusters"][0]["partitions"], [])
        terminal = render_status_board(snapshot)
        self.assertIn("gpu-a.example (1 running)", terminal)
        self.assertIn("Capacity unmanaged", terminal)

        service = JobService([self.machine], 3, 0, lambda: [status])
        with patch("clusterwatcher.jobs.collect_accounting_jobs", side_effect=AssertionError("sacct must not run")):
            jobs = service.query()["jobs"]
        self.assertEqual([job["job_id"] for job in jobs], ["123", "124"])
        self.assertTrue(jobs[0]["log_paths_available"]["out"])
        self.assertTrue(jobs[0]["script_available"])
        routed = []

        def log_remote(endpoint, _timeout, command, **_kwargs):
            routed.append((endpoint.host, command))
            return "line one\n"

        with patch("clusterwatcher.jobs.run_remote", side_effect=log_remote):
            log = service.log_tail("lab", "124", "err")
        self.assertEqual(routed[0][0], "gpu-b.example")
        self.assertIn("/work/test.err", routed[0][1])
        self.assertEqual(log["content"], "line one\n")

    def test_direct_inventory_ignores_unrelated_or_corrupt_manifests(self):
        """A remote user's private state cannot invent jobs on another host."""
        invalid = 'CW\t{"job_id":"44","host":"elsewhere"}\t\t\t\t\t1\n'
        self.assertEqual(_parse_inventory(invalid + "garbage\n", "gpu-a.example"), [])


if __name__ == "__main__":
    unittest.main()
