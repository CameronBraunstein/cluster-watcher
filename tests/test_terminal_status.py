"""Tests for the terminal cluster-capacity board."""

from datetime import datetime, timezone
from io import StringIO
from threading import Barrier
from unittest.mock import Mock

from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.terminal_status import (
    TERMINAL_WAIT_PROBE_BUDGET_SECONDS,
    TERMINAL_WAIT_PROBE_TIMEOUT_SECONDS,
    StatusBoardCollector,
    render_status_board,
    run_terminal_status_board,
)
from helpers import TimedTestCase


def capacity_payload() -> dict[str, object]:
    """Return one representative public snapshot for terminal rendering."""
    waits = [
        {
            "gpus": count,
            "nodes": 1 if count <= 4 else 2,
            "walltime_seconds": 3600,
            "estimated_wait_seconds": seconds,
            "error": None,
        }
        for count, seconds in ((1, 0), (2, 240), (4, 1800), (8, 7200))
    ]
    return {
        "generated_at": "2026-09-29T10:00:00+00:00",
        "clusters": [{
            "name": "cluster_1",
            "reachable": True,
            "error": None,
            "resource_error": None,
            "partitions": [{
                "name": "apu",
                "cpus": {"total": 768, "allocated": 96, "idle": 672},
                "gpus": {
                    "total": 8,
                    "allocated": 3,
                    "idle": 5,
                    "schedulable_idle": 4,
                    "unavailable_idle": 1,
                    "models": [{
                        "name": "AMD Instinct MI300A",
                        "vram_gb": 128,
                        "fp16_bf16_tensor_tflops": 980.6,
                    }],
                },
                "wait_estimates": waits,
            }],
        }],
    }


class TerminalStatusTests(TimedTestCase):
    """Exercise status columns, capacity colors, probes, and live output."""

    def test_board_renders_cluster_capacity_and_fixed_wait_columns(self):
        """Show all requested capacity signals in one row per partition."""
        output = render_status_board(capacity_payload(), use_color=True, width=180)

        self.assertIn("## cluster_1 ##", output)
        self.assertIn("PARTITION", output)
        self.assertIn("GPU NAME", output)
        self.assertIn("WAIT TIME · JOB UP TO 1 HOUR · GPU COUNT", output)
        wait_header = output.splitlines()[4].split()
        self.assertEqual(wait_header, ["1", "2", "4", "8", "16", "32", "64"])
        self.assertIn("AMD Instinct MI300A", output)
        self.assertIn("128G", output)
        self.assertIn("980.6", output)
        self.assertIn("4/8", output)
        self.assertIn("768", output)
        self.assertIn("now", output)
        self.assertIn("4m", output)
        self.assertIn("30m", output)
        self.assertIn("2h", output)
        self.assertIn("\033[31m", output)
        self.assertIn("\033[32m", output)

    def test_board_marks_and_explains_wait_probe_errors(self):
        """Never represent a known wait failure as an unexplained unknown value."""
        payload = capacity_payload()
        partition = payload["clusters"][0]["partitions"][0]
        partition["wait_estimates"][0]["error"] = "sbatch: unrecognized option '--gpus'"
        partition["wait_estimates"][0]["estimated_wait_seconds"] = None

        output = render_status_board(payload, use_color=False, width=180)

        self.assertIn("ERR", output)
        self.assertIn("WAIT ERROR apu [1 GPU]", output)
        self.assertIn("unrecognized option '--gpus'", output)

        partition["wait_estimates"][0]["error"] = (
            "allocation failure: Invalid account or account/partition combination specified"
        )
        output = render_status_board(payload, use_color=False, width=180)
        self.assertIn("DENY", output)
        self.assertIn("WAIT DENIED apu [1 GPU]", output)

    def test_collector_caches_one_hour_wait_probes_for_ten_minutes(self):
        """Refresh capacity often without hammering Slurm's test-only path."""
        self.assertEqual(TERMINAL_WAIT_PROBE_TIMEOUT_SECONDS, 10.0)
        self.assertEqual(TERMINAL_WAIT_PROBE_BUDGET_SECONDS, 10.0)
        machine = Machine("cluster_1", "host", "alice")
        status_calls = 0

        def collect_status(_machine: Machine, _timeout: int, include_jobs: bool, personal: bool) -> ClusterStatus:
            nonlocal status_calls
            status_calls += 1
            self.assertFalse(include_jobs)
            self.assertFalse(personal)
            return ClusterStatus(
                "cluster_1", "host", "alice",
                partitions=[{"partition": "apu", "available": "up", "nodes": "2", "cpus": "0/192/0/192", "state": "idle"}],
                nodes=[{
                    "name": "node001", "partitions": "apu", "state": "IDLE",
                    "cpu": {"total": 96, "allocated": 0, "idle": 96},
                    "gpu": {"total": 4, "allocated": 0, "idle": 4, "types": {"mi300a": 4}},
                }],
                partition_compute=[{
                    "name": "apu", "rank": 1, "aggregate": False,
                    "cpu_threads": 96,
                    "best_gpu": {"name": "AMD Instinct MI300A", "vram_gb": 128, "tensor_tflops": 980.6},
                }],
            )

        wait_collector = Mock(return_value={
            "apu": [{
                "gpus": 1, "nodes": 1, "memory_mb": 1024,
                "walltime_minutes": 60, "walltime_hours": 1,
                "start_time": "2026-09-29T10:00:00", "error": None,
            }],
        })
        clock = iter((0.0, 100.0))
        collector = StatusBoardCollector(
            [machine], 15,
            status_collector=collect_status,
            wait_collector=wait_collector,
            monotonic=lambda: next(clock),
        )

        first = collector()
        second = collector()

        self.assertEqual(status_calls, 2)
        self.assertEqual(wait_collector.call_count, 1)
        arguments, keywords = wait_collector.call_args
        self.assertEqual(arguments[0], machine)
        self.assertEqual(arguments[1][0]["name"], "node001")
        self.assertEqual(arguments[2], 15)
        self.assertEqual(keywords["walltime_minutes"], (60,))
        self.assertEqual(keywords["maximum_gpus"], 64)
        self.assertLessEqual(keywords["probe_timeout_seconds"], TERMINAL_WAIT_PROBE_TIMEOUT_SECONDS)
        self.assertGreater(keywords["probe_timeout_seconds"], 9.9)
        self.assertLessEqual(keywords["time_budget_seconds"], TERMINAL_WAIT_PROBE_BUDGET_SECONDS)
        self.assertGreater(keywords["time_budget_seconds"], 0)
        self.assertNotIn("stop_on_error", keywords)  # Batched probes always run every shape.
        self.assertEqual(second["clusters"][0]["partitions"][0]["wait_estimates"][0]["nodes"], 1)

    def test_collector_probes_stale_clusters_concurrently(self):
        """Do not multiply partition-wait latency by the number of clusters."""
        machines = [
            Machine("alpha", "alpha.example", "alice"),
            Machine("beta", "beta.example", "alice"),
        ]
        rendezvous = Barrier(2)

        def collect_status(machine: Machine, *_args) -> ClusterStatus:
            return ClusterStatus(
                machine.name,
                machine.host,
                machine.username,
                partitions=[{
                    "partition": "gpu", "available": "up", "nodes": "1",
                    "cpus": "0/64/0/64", "state": "idle",
                }],
                nodes=[{
                    "name": f"{machine.name}001", "partitions": "gpu", "state": "IDLE",
                    "cpu": {"total": 64, "allocated": 0, "idle": 64},
                    "gpu": {"total": 1, "allocated": 0, "idle": 1, "types": {"a100": 1}},
                }],
            )

        def collect_waits(machine: Machine, *_args, **_kwargs):
            rendezvous.wait(timeout=1)
            return {"gpu": [{
                "gpus": 1, "nodes": 1, "memory_mb": 1024,
                "walltime_minutes": 60, "walltime_hours": 1,
                "start_time": "2026-09-29T10:00:00", "error": None,
            }]}

        payload = StatusBoardCollector(
            machines,
            15,
            status_collector=collect_status,
            wait_collector=collect_waits,
        )()

        self.assertEqual([cluster["name"] for cluster in payload["clusters"]], ["alpha", "beta"])
        self.assertTrue(all(cluster["partitions"][0]["wait_estimates"] for cluster in payload["clusters"]))

    def test_collector_reads_cluster_capacities_concurrently(self):
        """Do not serialize the initial Slurm inventory calls by cluster."""
        machines = [
            Machine("alpha", "alpha.example", "alice"),
            Machine("beta", "beta.example", "alice"),
        ]
        rendezvous = Barrier(2)

        def collect_status(machine: Machine, *_args) -> ClusterStatus:
            rendezvous.wait(timeout=1)
            return ClusterStatus(machine.name, machine.host, machine.username)

        payload = StatusBoardCollector(
            machines,
            15,
            status_collector=collect_status,
        )()

        self.assertEqual([cluster["name"] for cluster in payload["clusters"]], ["alpha", "beta"])

    def test_one_shot_board_returns_failure_for_an_unreachable_cluster(self):
        """Retain the old status command's useful nonzero failure signal."""
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "clusters": [{"name": "offline", "reachable": False, "error": "SSH failed"}],
        }
        output = StringIO()

        result = run_terminal_status_board(
            [Machine("offline", "host", "alice")], 15, None,
            output=output,
            collector=lambda: payload,
        )

        self.assertEqual(result, 1)
        self.assertIn("## offline ##", output.getvalue())
        self.assertIn("SSH failed", output.getvalue())
