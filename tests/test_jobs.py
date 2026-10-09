"""Tests for the loopback-only personal jobs and log service."""

from datetime import datetime, timezone
from unittest.mock import patch

from clusterwatcher.dashboard import is_loopback_host, serve
from clusterwatcher.jobs import JobLogNotFound, JobService, MAX_LOG_TAIL_LINES, parse_since
from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.slurm import accounting_jobs_command, parse_accounting_jobs
from helpers import TimedTestCase


SINCE = datetime(2026, 9, 22, tzinfo=timezone.utc)


def accounting_line(
    job_id: str,
    state: str = "COMPLETED",
    exit_code: str = "0:0",
    stderr: str = "/logs/job.err",
) -> str:
    """Return one allocation-only sacct fixture row."""
    return (
        f"{job_id}|train|{state}|{exit_code}|2026-09-22T10:00:00|"
        f"2026-09-22T10:01:00|2026-09-22T10:02:00|60|60|gpu|node01|1|8|"
        f"cpu=8,gres/gpu=1|None|"
        f"/logs/job.out|{stderr}|/work/alice\n"
    )


class JobServiceTests(TimedTestCase):
    """Exercise parsing, degradation, caching, and safe bounded log access."""

    def test_finished_array_tasks_and_cancelled_state_are_parsed(self):
        jobs = parse_accounting_jobs(
            accounting_line("12345_0")
            + accounting_line("12345_1", "CANCELLED by 777", "9:15")
        )

        self.assertEqual([job["job_id"] for job in jobs], ["12345_0", "12345_1"])
        self.assertEqual([job["array_task_id"] for job in jobs], [0, 1])
        self.assertEqual(jobs[1]["state"], "CANCELLED")
        self.assertEqual(jobs[1]["exit_code"], "9:15")
        self.assertEqual(jobs[0]["node_count"], 1)
        self.assertEqual(jobs[0]["cpus"], 8)
        self.assertEqual(jobs[0]["gpus"], 1)
        self.assertEqual(jobs[0]["submit_at"], "2026-09-22T10:00:00Z")
        self.assertEqual(jobs[0]["start_at"], "2026-09-22T10:01:00Z")
        self.assertEqual(jobs[0]["end_at"], "2026-09-22T10:02:00Z")
        self.assertEqual(jobs[0]["elapsed_seconds"], 60)
        self.assertEqual(jobs[0]["time_limit_seconds"], 3600)

    def test_accounting_query_batches_ids_and_is_user_scoped(self):
        command = accounting_jobs_command(SINCE, ("123", "456_7"), "alice")

        self.assertIn("--jobs=123,456_7", command)
        self.assertIn("--user=alice", command)
        self.assertIn("--allocations", command)
        self.assertIn("--array", command)
        self.assertIn("ElapsedRaw,TimelimitRaw,Partition", command)
        self.assertIn("NNodes,NCPUS,AllocTRES", command)
        self.assertTrue(command.startswith("TZ=UTC sacct"))
        self.assertEqual(command.count("sacct"), 1)

    @patch("clusterwatcher.jobs.collect_accounting_jobs")
    def test_finished_job_is_reported_and_query_is_cached(self, collect_accounting_jobs):
        machine = Machine("alpha", "alpha.example", "alice")
        status = ClusterStatus("alpha", "alpha.example", "alice", user_jobs=[])
        collect_accounting_jobs.return_value = parse_accounting_jobs(accounting_line("1000101"))
        service = JobService([machine], 5, 15, lambda: [status])

        first = service.query(job_ids=("1000101",), since=SINCE)
        second = service.query(job_ids=("1000101",), since=SINCE)

        self.assertEqual(first["jobs"][0]["state"], "COMPLETED")
        self.assertEqual(first["jobs"][0]["time_limit_seconds"], 3600)
        self.assertEqual(second["jobs"][0]["job_id"], "1000101")
        collect_accounting_jobs.assert_called_once_with(machine, 5, SINCE, ("1000101",))

    @patch("clusterwatcher.jobs.collect_accounting_jobs")
    def test_pending_array_task_merges_live_resources_with_accounting(self, collect_accounting_jobs):
        """Treat bracketed squeue and canonical sacct IDs as one array task."""
        machine = Machine("cluster_1", "cluster_1.example", "alice")
        status = ClusterStatus(
            "cluster_1", "cluster_1.example", "alice",
            user_jobs=[{
                "id": "2000068_[1]", "name": "grid_search", "state": "PENDING",
                "partition": "apu", "nodes": [], "node_count": 1,
                "cpus": 16, "gpus": 2, "submit_time": "2026-09-28T11:24:00",
                "start_time": "N/A", "elapsed_seconds": 18,
                "dependency": "NULL", "reason": "Resources",
            }],
        )
        accounting = parse_accounting_jobs(accounting_line("2000068_1", "PENDING"))
        accounting[0].update({"node_count": 1, "cpus": 0, "gpus": 0})
        collect_accounting_jobs.return_value = accounting
        service = JobService([machine], 5, 0, lambda: [status])

        payload = service.query(since=SINCE)

        self.assertEqual(len(payload["jobs"]), 1)
        pending = payload["jobs"][0]
        self.assertEqual(pending["job_id"], "2000068_1")
        self.assertEqual(pending["array_task_id"], 1)
        self.assertEqual((pending["node_count"], pending["gpus"], pending["cpus"]), (1, 2, 16))

    @patch("clusterwatcher.jobs.collect_accounting_jobs")
    def test_accounting_failure_keeps_active_jobs_and_marks_unknown_ids(self, collect_accounting_jobs):
        machine = Machine("alpha", "alpha.example", "alice")
        status = ClusterStatus(
            "alpha", "alpha.example", "alice",
            user_jobs=[{
                "id": "10", "name": "running", "state": "RUNNING", "partition": "gpu",
                "nodes": ["node01"], "start_time": "2026-09-22T10:00:00",
                "submit_time": "2026-09-22T09:00:00", "elapsed_seconds": 60,
                "node_count": 1, "cpus": 8, "gpus": 1,
                "dependency": "(null)", "reason": "None",
            }],
        )
        collect_accounting_jobs.side_effect = RuntimeError("sacct is not configured")
        service = JobService([machine], 5, 15, lambda: [status])

        payload = service.query(job_ids=("10", "11"), since=SINCE)

        self.assertEqual({job["job_id"]: job["state"] for job in payload["jobs"]}, {"10": "RUNNING", "11": "UNKNOWN"})
        running = next(job for job in payload["jobs"] if job["job_id"] == "10")
        self.assertEqual((running["node_count"], running["gpus"], running["cpus"]), (1, 1, 8))
        self.assertFalse(payload["clusters"][0]["accounting_available"])
        self.assertTrue(payload["clusters"][0]["reachable"])

    @patch("clusterwatcher.jobs.collect_accounting_jobs")
    def test_unreachable_cluster_does_not_hide_another_cluster(self, collect_accounting_jobs):
        machines = [Machine("down", "down.example", "alice"), Machine("up", "up.example", "alice")]
        statuses = [
            ClusterStatus("down", "down.example", "alice", user_jobs=[], error="SSH unavailable"),
            ClusterStatus("up", "up.example", "alice", user_jobs=[]),
        ]
        collect_accounting_jobs.side_effect = [RuntimeError("SSH unavailable"), parse_accounting_jobs(accounting_line("42"))]
        service = JobService(machines, 5, 15, lambda: statuses)

        payload = service.query(since=SINCE)

        self.assertFalse(payload["clusters"][0]["reachable"])
        self.assertTrue(payload["clusters"][1]["reachable"])
        self.assertEqual(payload["jobs"][0]["job_id"], "42")

    @patch("clusterwatcher.jobs.collect_accounting_jobs", return_value=[])
    @patch("clusterwatcher.jobs.collect_live_job_log_paths", return_value={})
    def test_queued_job_without_log_is_reported_as_not_found(self, _live_paths, _accounting):
        machine = Machine("alpha", "alpha.example", "alice")
        status = ClusterStatus("alpha", "alpha.example", "alice", user_jobs=[{"id": "10", "state": "PENDING"}])
        service = JobService([machine], 5, 15, lambda: [status])

        with self.assertRaisesRegex(JobLogNotFound, "queued jobs may not have a log"):
            service.log_tail("alpha", "10")

        with self.assertRaisesRegex(ValueError, "before must be a non-negative integer"):
            service.log_tail("alpha", "10", before=-1)

    @patch("clusterwatcher.jobs.run_remote")
    def test_explicit_path_outside_configured_root_is_refused(self, run_remote):
        machine = Machine("alpha", "alpha.example", "alice", job_log_roots=("/safe/logs",))
        run_remote.return_value = "/secret/job.err\n/safe/logs\n"
        service = JobService([machine], 5, 15, lambda: [])

        with self.assertRaisesRegex(ValueError, "outside the configured"):
            service.log_tail("alpha", "10", explicit_path="/secret/job.err")

    @patch("clusterwatcher.jobs.run_remote")
    def test_log_tail_is_hard_capped_and_never_uses_cat(self, run_remote):
        machine = Machine("alpha", "alpha.example", "alice", job_log_roots=("/safe",))
        lines = "".join(f"line {number}\n" for number in range(MAX_LOG_TAIL_LINES + 1))
        run_remote.side_effect = ["/safe/job.err\n/safe\n", lines]
        service = JobService([machine], 5, 15, lambda: [])

        result = service.log_tail("alpha", "10", tail=999999, explicit_path="/safe/job.err")

        self.assertEqual(result["lines"], MAX_LOG_TAIL_LINES)
        self.assertTrue(result["truncated"])
        tail_command = run_remote.call_args_list[1].args[2]
        self.assertIn(f"tail -n {MAX_LOG_TAIL_LINES + 1}", tail_command)
        self.assertNotIn("cat ", tail_command)

    @patch("clusterwatcher.jobs.run_remote")
    @patch("clusterwatcher.jobs.collect_accounting_jobs")
    def test_log_tail_loads_one_bounded_older_page(self, accounting, run_remote):
        """Page backward remotely without transferring the intervening tail."""
        machine = Machine("alpha", "alpha.example", "alice")
        accounting.return_value = parse_accounting_jobs(accounting_line("10"))
        run_remote.return_value = "".join(f"line {number}\n" for number in range(MAX_LOG_TAIL_LINES + 1))
        service = JobService([machine], 5, 15, lambda: [])

        result = service.log_tail("alpha", "10", stream="out", tail=MAX_LOG_TAIL_LINES, before=MAX_LOG_TAIL_LINES)

        self.assertEqual(result["before"], MAX_LOG_TAIL_LINES)
        self.assertEqual(result["lines"], MAX_LOG_TAIL_LINES)
        self.assertTrue(result["more_before"])
        self.assertNotIn("line 0\n", result["content"])
        command = run_remote.call_args.args[2]
        self.assertIn("tac --", command)
        self.assertIn(f"tail -n +{MAX_LOG_TAIL_LINES + 1}", command)
        self.assertIn(f"head -n {MAX_LOG_TAIL_LINES + 1}", command)

    @patch("clusterwatcher.jobs.run_remote", return_value="last line\n")
    @patch("clusterwatcher.jobs.collect_accounting_jobs")
    def test_completed_job_log_uses_accounting_workdir_and_expands_pattern(self, accounting, _run_remote):
        machine = Machine("alpha", "alpha.example", "alice")
        accounting.return_value = parse_accounting_jobs(accounting_line("10", stderr="logs/job-%j.err"))
        service = JobService([machine], 5, 15, lambda: [ClusterStatus("alpha", "host", "alice", user_jobs=[])])

        result = service.log_tail("alpha", "10")

        self.assertEqual(result["path"], "/work/alice/logs/job-10.err")
        self.assertEqual(result["content"], "last line\n")

    @patch("clusterwatcher.jobs.run_remote", return_value="")
    def test_cancel_is_user_scoped_validated_and_clears_cache(self, run_remote):
        machine = Machine("alpha", "alpha.example", "alice")
        service = JobService([machine], 5, 15, lambda: [])
        service._cache[("key",)] = (0.0, {})

        result = service.cancel("alpha", "12345_6")

        self.assertEqual(result["job_id"], "12345_6")
        self.assertEqual(run_remote.call_args.args[2], "scancel --user=alice -- 12345_6")
        self.assertEqual(service._cache, {})
        with self.assertRaisesRegex(ValueError, "numeric"):
            service.cancel("alpha", "1; rm -rf /")
        with self.assertRaisesRegex(ValueError, "unknown cluster"):
            service.cancel("beta", "1")

    def test_active_record_exposes_dependency(self):
        from clusterwatcher.jobs import _active_record

        record = _active_record(
            "alpha",
            {
                "id": "11",
                "state": "PENDING",
                "dependency": "afterok:10(failed)",
                "reason": "DependencyNeverSatisfied",
                "priority": 43210,
            },
        )
        self.assertEqual(record["dependency"], "afterok:10(failed)")
        self.assertEqual(record["reason"], "DependencyNeverSatisfied")
        self.assertEqual(record["priority"], 43210)
        waiting = _active_record(
            "alpha",
            {
                "id": "12",
                "state": "PENDING",
                "dependency": "afterok:10(unfulfilled)",
                "reason": "Dependency",
            },
        )
        self.assertEqual(waiting["reason"], "Dependency: afterok:10(unfulfilled)")
        self.assertIsNone(_active_record("alpha", {"id": "12", "state": "PENDING", "dependency": "(null)"})["dependency"])

    def test_since_defaults_to_24_hours_and_personal_api_is_loopback_only(self):
        now = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)

        self.assertEqual(parse_since(None, now), datetime(2026, 9, 22, 12, tzinfo=timezone.utc))
        self.assertTrue(is_loopback_host("127.0.0.1"))
        self.assertTrue(is_loopback_host("::1"))
        self.assertFalse(is_loopback_host("0.0.0.0"))
        self.assertFalse(is_loopback_host("dashboard.example"))
        with self.assertRaisesRegex(ValueError, "loopback"):
            serve([], "0.0.0.0", 8080, 5, False, 15, False, jobs_api_enabled=True)
