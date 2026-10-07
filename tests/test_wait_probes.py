"""Tests for batched wait probes: shapes, on-cluster retries, timeouts, budgets, and labels.

The generated probe scripts run in the local shell against a fake ``sbatch``
on ``PATH``, so the shell-side GRES fallback, ``timeout``, and time budget are
exercised for real.
"""

import os
from pathlib import Path
import subprocess
import tempfile
from threading import Barrier
from unittest.mock import patch

from clusterwatcher.dashboard import StatusStore
from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.remote_batch import BUDGET_EXHAUSTED, run_batch
from clusterwatcher.snapshot import _wait_estimates
from clusterwatcher.terminal_status import wait_error_label
from clusterwatcher.wait_probes import (
    classify_wait_error, collect_wait_estimates, probe_shapes, test_only_command,
)
from helpers import TimedTestCase


MACHINE = Machine("cluster_0", "c0.example", "alice")
START = "sbatch: Job 42 to start at 2026-09-29T12:34:56 using 1 processors on nodes n1 in partition gpu"
FAKE_SBATCH = f"""#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$FAKE_MODE" in
  ok) echo '{START}' >&2 ;;
  jobwide) case "$*" in
      *--gres=*) echo 'sbatch: error: No gpus were requested. Aborted...' >&2
                 echo 'allocation failure: Invalid generic resource (gres) specification' >&2; exit 1 ;;
      *) echo '{START}' >&2 ;;
    esac ;;
  pernode) echo 'sbatch: error: More than 4 gpus per node were requested. Consider using node exclusively. Aborted...' >&2
           echo 'allocation failure: Invalid generic resource (gres) specification' >&2; exit 1 ;;
  slow) sleep 5 ;;
esac
"""


def run_locally(_machine, _timeout, command, _process_timeout=None):
    """Execute what would be sent over SSH with the local shell instead."""
    result = subprocess.run(["sh", "-c", command], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout


def nodes(gpus_per_node, count=1, partition="gpu"):
    """Return ``count`` fake nodes with ``gpus_per_node`` GPUs each."""
    return [{"partitions": partition, "gpu": {"total": gpus_per_node}} for _ in range(count)]


class FakeClusterTestCase(TimedTestCase):
    """Put a fake ``sbatch`` first on PATH and log its arguments."""

    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        sbatch = Path(directory.name) / "sbatch"
        sbatch.write_text(FAKE_SBATCH)
        sbatch.chmod(0o755)
        self.log = Path(directory.name) / "calls.log"
        self.log.touch()
        environment = patch.dict(os.environ, {
            "PATH": f"{directory.name}{os.pathsep}{os.environ['PATH']}",
            "FAKE_LOG": str(self.log), "FAKE_MODE": "ok",
        })
        environment.start()
        self.addCleanup(environment.stop)
        ssh = patch("clusterwatcher.remote_batch.run_remote", side_effect=run_locally)
        self.ssh = ssh.start()
        self.addCleanup(ssh.stop)

    def mode(self, value):
        os.environ["FAKE_MODE"] = value

    def calls(self):
        return self.log.read_text().splitlines()


class ProbeShapeTests(TimedTestCase):
    def test_single_node_shapes_use_every_walltime_and_multi_node_only_the_first(self):
        capacity = {"total": 64, "max_per_node": 8, "node_capacities": [8] * 8}
        shapes = probe_shapes(capacity, (60, 720, 1440), 64)

        self.assertEqual([shape for shape in shapes if shape[0] <= 8], [
            (gpus, 1, minutes) for gpus in (1, 2, 4, 8) for minutes in (60, 720, 1440)
        ])
        self.assertEqual([shape for shape in shapes if shape[0] > 8], [(16, 2, 60), (32, 4, 60), (64, 8, 60)])

    def test_shapes_stop_at_the_partition_total(self):
        capacity = {"total": 12, "max_per_node": 4, "node_capacities": [4, 4, 4]}
        self.assertEqual([gpus for gpus, _nodes, _minutes in probe_shapes(capacity, (60,), 64)], [1, 2, 4, 8])

    def test_multi_node_requests_run_one_task_per_node(self):
        """``--ntasks=1`` would make Slurm shrink a multi-node request to one node."""
        command = test_only_command("gpu", 16, 60, 2)
        self.assertIn("--nodes=2 --ntasks-per-node=1 --gres=gpu:8 --mem=8192M --time=01:00:00", command)
        self.assertNotIn("--ntasks=1", command)


class BatchedProbeTests(FakeClusterTestCase):
    def test_each_partition_is_one_ssh_call_with_every_shape(self):
        estimates = collect_wait_estimates(MACHINE, nodes(8, 8, "gpu") + nodes(2, 1, "dev"), 5)

        self.assertEqual(self.ssh.call_count, 2)
        self.assertEqual([row["gpus"] for row in estimates["gpu"]], [1, 1, 1, 2, 2, 2, 4, 4, 4, 8, 8, 8, 16, 32, 64])
        self.assertEqual(estimates["gpu"][-1]["nodes"], 8)
        self.assertTrue(all(row["start_time"] == "2026-09-29T12:34:56" for rows in estimates.values() for row in rows))
        self.assertTrue(all(row["error"] is None and row["error_kind"] is None for row in estimates["gpu"]))
        self.assertEqual(len(self.calls()), 15 + 6)

    def test_runtime_is_capped_by_partition_configuration(self):
        machine = Machine("cluster_3", "host", "user", partition_max_time_minutes=(("gpudev", 15),))
        estimates = collect_wait_estimates(machine, nodes(4, 1, "gpudev"), 5, walltime_minutes=(60,))

        self.assertEqual({row["walltime_minutes"] for row in estimates["gpudev"]}, {15})
        self.assertTrue(all("--time=00:15:00" in call for call in self.calls()))

    def test_site_requiring_job_wide_gpus_is_retried_in_the_same_call(self):
        self.mode("jobwide")
        estimates = collect_wait_estimates(MACHINE, nodes(1), 5, walltime_minutes=(60,))

        self.assertEqual(self.ssh.call_count, 1)
        self.assertIn("--gres=gpu:1", self.calls()[0])
        self.assertIn("--gpus=1", self.calls()[1])
        self.assertEqual(estimates["gpu"][0]["start_time"], "2026-09-29T12:34:56")

    def test_per_node_gpu_limit_is_a_limit_not_a_syntax_retry(self):
        self.mode("pernode")
        estimates = collect_wait_estimates(MACHINE, nodes(1), 5, walltime_minutes=(60,))

        self.assertEqual(len(self.calls()), 1)  # No misleading --gpus retry.
        self.assertEqual(estimates["gpu"][0]["error_kind"], "limit")
        self.assertIn("More than 4 gpus per node", estimates["gpu"][0]["error"])

    def test_slow_probe_is_cut_off_by_timeout(self):
        self.mode("slow")
        estimates = collect_wait_estimates(MACHINE, nodes(1), 5, walltime_minutes=(60,), probe_timeout_seconds=1)

        self.assertEqual(estimates["gpu"][0]["error"], "Slurm probe timed out after 1 seconds")
        self.assertEqual(estimates["gpu"][0]["error_kind"], "timeout")

    def test_probes_after_the_budget_are_not_run(self):
        estimates = collect_wait_estimates(MACHINE, nodes(2), 5, walltime_minutes=(60,), time_budget_seconds=0)

        self.assertEqual(self.calls(), [])
        self.assertTrue(all(row["error_kind"] == "budget" for row in estimates["gpu"]))
        self.assertEqual(estimates["gpu"][0]["error"], "partition wait-probe budget exhausted after 0 seconds")

    def test_ssh_failure_marks_every_shape(self):
        self.ssh.side_effect = RuntimeError("Permission denied (gssapi-with-mic,password).")
        estimates = collect_wait_estimates(MACHINE, nodes(2), 5, walltime_minutes=(60,))

        self.assertEqual([row["error"] for row in estimates["gpu"]], ["Permission denied (gssapi-with-mic,password)."] * 2)

    def test_deadline_covers_the_budget_and_one_slow_probe(self):
        with patch("clusterwatcher.wait_probes.run_batch", return_value={}) as batch:
            collect_wait_estimates(MACHINE, nodes(1), 15, probe_timeout_seconds=60, time_budget_seconds=240)
        self.assertEqual(batch.call_args.kwargs["budget_seconds"], 240)
        self.assertGreaterEqual(batch.call_args.kwargs["process_timeout"], 240 + 60)

    def test_partitions_are_probed_concurrently(self):
        rendezvous = Barrier(2)

        def concurrent(*args, **kwargs):
            rendezvous.wait(timeout=2)
            return run_locally(*args, **kwargs)

        self.ssh.side_effect = concurrent
        estimates = collect_wait_estimates(MACHINE, nodes(1, 1, "a") + nodes(1, 1, "b"), 5, walltime_minutes=(60,))
        self.assertEqual(list(estimates), ["a", "b"])


class BudgetedBatchTests(FakeClusterTestCase):
    def test_sections_after_the_budget_report_it_and_do_not_run(self):
        sections = run_batch(MACHINE, 5, {"first": "echo ran >> \"$FAKE_LOG\""}, budget_seconds=0)

        self.assertEqual(sections["first"].stderr, BUDGET_EXHAUSTED)
        self.assertEqual(sections["first"].returncode, 1)
        self.assertEqual(self.calls(), [])

    def test_sections_within_the_budget_run_normally(self):
        sections = run_batch(MACHINE, 5, {"first": "echo hi"}, budget_seconds=60)
        self.assertEqual((sections["first"].stdout, sections["first"].stderr, sections["first"].returncode), ("hi\n", "", 0))


class ErrorKindTests(TimedTestCase):
    CASES = {
        "allocation failure: Invalid account or account/partition combination specified": ("denied", "DENY"),
        "allocation failure: Access/permission denied": ("denied", "DENY"),
        "sbatch: error: QOSMinGRES\nallocation failure: Job violates accounting/QOS policy": ("minimum", "min"),
        "sbatch: error: QOSGrpGRES\nallocation failure: Job violates accounting/QOS policy": ("limit", "limit"),
        "sbatch: error: More than 4 gpus per node were requested.": ("limit", "limit"),
        "allocation failure: Requested time limit is invalid (missing or exceeds some limit)": ("limit", "limit"),
        "allocation failure: Requested node configuration is not available": ("unavailable", "n/a"),
        "Slurm probe timed out after 60 seconds": ("timeout", "ERR"),
        "partition wait-probe budget exhausted after 240 seconds": ("budget", "?"),
        "Slurm did not provide an expected start time": ("error", "ERR"),
    }

    def test_errors_are_classified_and_labelled(self):
        for error, (kind, label) in self.CASES.items():
            with self.subTest(error=error):
                self.assertEqual(classify_wait_error(error), kind)
                self.assertEqual(wait_error_label({"error": error}), label)
        self.assertIsNone(classify_wait_error(None))

    def test_snapshot_carries_the_kind_even_for_older_cached_rows(self):
        status = ClusterStatus("c", "h", "u", wait_estimates={"gpu": [
            {"gpus": 1, "walltime_minutes": 60, "error": "allocation failure: Requested node configuration is not available"},
        ]})
        self.assertEqual(_wait_estimates(status, "gpu", None)[0]["error_kind"], "unavailable")


class ServiceProbeTests(TimedTestCase):
    @patch("clusterwatcher.dashboard.collect_wait_estimates")
    def test_clusters_are_probed_concurrently(self, collect):
        machines = [Machine(name, f"{name}.example", "alice") for name in ("c0", "c1")]
        rendezvous = Barrier(2)

        def probe(machine, *_args, **_kwargs):
            rendezvous.wait(timeout=2)  # Deadlocks unless both clusters probe at once.
            return {"gpu": [{"gpus": 1, "start_time": None, "error": None}]}

        collect.side_effect = probe
        store = StatusStore(machines, 5, False, 15)
        store._statuses = [ClusterStatus(machine.name, machine.host, machine.username, nodes=[{}]) for machine in machines]

        self.assertTrue(store.refresh_wait_estimates())
        self.assertTrue(all(status.wait_estimates_updated_at for status in store.statuses()))
