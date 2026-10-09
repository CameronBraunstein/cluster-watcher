"""Tests for batched collection, slower capacity refresh, gated accounting, and ETags."""

from email.message import Message
from io import BytesIO
import subprocess
from unittest.mock import patch

from clusterwatcher.dashboard import CAPACITY_REFRESH_SECONDS, StatusStore, make_handler, stable_etag
from clusterwatcher.jobs import JobService
from clusterwatcher.models import AccountingSnapshot, ClusterStatus, Machine
from clusterwatcher.remote_batch import Section, parse_batch_output, run_batch
from clusterwatcher.slurm import _accounting_from_section, accounting_gate_command, collect_status
from helpers import TimedTestCase


MACHINE = Machine("alpha", "alpha.example", "alice")
ACCOUNTING_LINE = (
    "10|train|COMPLETED|0:0|2026-09-22T10:00:00|2026-09-22T10:01:00|2026-09-22T10:02:00|60|60|gpu|"
    "node01|1|8|cpu=8,gres/gpu=1|None|/logs/job.out|/logs/job.err|/work/alice\n"
)


def run_locally(_machine, _timeout, command, _process_timeout=None):
    """Execute what would be sent over SSH with the local shell instead."""
    result = subprocess.run(["sh", "-c", command], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout


class RemoteBatchTests(TimedTestCase):
    """The generated sh script frames each command's streams and status exactly."""

    @patch("clusterwatcher.remote_batch.run_remote", side_effect=run_locally)
    def test_round_trip_keeps_each_commands_output_stderr_and_status(self, _run_remote):
        sections = run_batch(MACHINE, 5, {
            "plain": "printf 'a|b\\nc\\n'",
            "no_newline": "printf abc",
            "empty": "true",
            "failed": "echo partial; echo oops >&2; exit 3",
            "lookalike": "echo '@@CW0000000000000000@@<plain'",
            "quotes": "echo \"it's $((1 + 1))\"",
        })

        self.assertEqual(sections["plain"], Section("a|b\nc\n", "", 0))
        self.assertEqual(sections["no_newline"].stdout, "abc")
        self.assertEqual(sections["empty"], Section("", "", 0))
        self.assertEqual(sections["failed"], Section("partial\n", "oops\n", 3))
        self.assertEqual(sections["lookalike"].stdout, "@@CW0000000000000000@@<plain\n")
        self.assertEqual(sections["quotes"].stdout, "it's 2\n")
        with self.assertRaisesRegex(RuntimeError, "oops"):
            sections["failed"].output()

    @patch("clusterwatcher.remote_batch.run_remote", side_effect=subprocess.TimeoutExpired(["ssh", "x" * 5000], 35))
    def test_timeout_message_is_short_and_deadline_is_generous(self, run_remote):
        with self.assertRaises(RuntimeError) as raised:
            run_batch(MACHINE, 15, {"one": "true"})
        self.assertEqual(str(raised.exception), "no response from the cluster within 35 s")
        self.assertEqual(run_remote.call_args.args[3], 35)

    def test_truncated_output_marks_unfinished_sections_failed(self):
        token = "@@CWtoken@@"
        output = f"{token}<first\nok\n\n{token}>first 0\n{token}<second\npart"

        sections = parse_batch_output(output, token, ["first", "second", "third"])

        self.assertEqual(sections["first"], Section("ok\n", "", 0))
        self.assertEqual(sections["second"].returncode, 1)
        self.assertEqual(sections["third"].returncode, 1)

    def test_section_names_are_restricted(self):
        from clusterwatcher.remote_batch import batch_script

        with self.assertRaises(ValueError):
            batch_script({"bad name; rm": "true"}, "@@CWx@@")


class CapacityCadenceTests(TimedTestCase):
    """Capacity data is reused between its slower refreshes."""

    def previous(self) -> ClusterStatus:
        return ClusterStatus(
            "alpha", "alpha.example", "alice",
            partitions=[{"partition": "gpu", "available": "up", "nodes": "1", "cpus": "0/8/0/8", "state": "idle"}],
            nodes=[{"name": "node01", "partitions": "gpu", "cpu": {"total": 8}, "gpu": {"total": 1}, "next_release": "soon"}],
            partition_compute=[{"name": "gpu"}], jobs={"RUNNING": 3},
            scheduling={"scheduler_type": "sched/backfill", "priority_type": "priority/multifactor"},
            capacity_updated_at="2026-09-22T10:00:00+00:00",
        )

    @patch("clusterwatcher.slurm.run_batch")
    def test_jobs_only_refresh_sends_only_personal_queries_and_keeps_capacity(self, run_batch):
        running = "10|train|RUNNING|gpu|node01|1|4|gres/gpu:1|2026-09-22T10:00:00|2026-09-22T09:59:00|NULL|00:10:00|01:00:00|00:50:00|None\n"
        run_batch.return_value = {"running": Section(running, "", 0), "pending": Section("", "", 0)}
        previous = self.previous()

        status = collect_status(MACHINE, 5, True, previous=previous, refresh_capacity=False)

        self.assertEqual(list(run_batch.call_args.args[2]), ["running", "pending"])
        self.assertEqual(status.partitions, previous.partitions)
        self.assertEqual(status.jobs, {"RUNNING": 3})
        self.assertEqual(status.scheduling, previous.scheduling)
        self.assertEqual(status.capacity_updated_at, previous.capacity_updated_at)
        self.assertEqual(status.nodes[0]["my_usage"], {"cpus": 4, "gpus": 1})
        self.assertEqual(status.nodes[0]["next_release"], "soon")
        self.assertNotIn("my_usage", previous.nodes[0])  # The previous snapshot is not mutated.

    @patch("clusterwatcher.slurm.run_batch")
    def test_first_refresh_or_due_capacity_collects_everything(self, run_batch):
        run_batch.return_value = {
            name: Section("", "", 0)
            for name in ("sinfo", "nodes", "scheduler", "running", "pending", "releases", "queue")
        }

        collect_status(MACHINE, 5, True, previous=None, refresh_capacity=False)

        self.assertEqual(
            list(run_batch.call_args.args[2]),
            ["sinfo", "nodes", "scheduler", "running", "pending", "releases", "queue"],
        )

    @patch("clusterwatcher.slurm.run_batch")
    def test_unavailable_scheduler_details_do_not_hide_other_status(self, run_batch):
        run_batch.return_value = {
            name: Section("", "", 0)
            for name in ("sinfo", "nodes", "running", "pending", "releases", "queue")
        }
        run_batch.return_value["sinfo"] = Section("gpu|up|1|0/8/0/8|idle\n", "", 0)
        run_batch.return_value["scheduler"] = Section("", "config unavailable", 1)

        status = collect_status(MACHINE, 5, True)

        self.assertIsNone(status.error)
        self.assertIsNone(status.resource_error)
        self.assertEqual(status.partitions[0]["partition"], "gpu")
        self.assertEqual(status.scheduling, {})

    @patch("clusterwatcher.dashboard.collect_status")
    def test_status_store_refreshes_capacity_at_most_every_minute(self, collect):
        collect.side_effect = lambda machine, *_args, **_kwargs: ClusterStatus(machine.name, machine.host, machine.username)
        store = StatusStore([MACHINE], 5, False, 15, jobs_api_enabled=True)

        with patch("clusterwatcher.dashboard.time.monotonic", side_effect=[1000.0, 1015.0, 1000.0 + CAPACITY_REFRESH_SECONDS]):
            store.refresh()
            store.refresh()
            store.refresh()

        self.assertEqual([call.kwargs["refresh_capacity"] for call in collect.call_args_list], [True, False, True])
        self.assertTrue(all(call.kwargs["include_accounting"] for call in collect.call_args_list))
        self.assertIsNotNone(collect.call_args_list[1].kwargs["previous"])


    @patch("clusterwatcher.dashboard.collect_status")
    def test_clusters_are_collected_in_parallel_and_keep_their_order(self, collect):
        import threading
        machines = [Machine(name, f"{name}.example", "alice") for name in ("c0", "c1", "c2")]
        barrier = threading.Barrier(len(machines), timeout=2)

        def slow(machine, *_args, **_kwargs):
            barrier.wait()  # Deadlocks (and times out) unless all clusters run at once.
            return ClusterStatus(machine.name, machine.host, machine.username)

        collect.side_effect = slow
        store = StatusStore(machines, 5, False, 15)
        store.refresh()

        self.assertEqual([status.name for status in store.statuses()], ["c0", "c1", "c2"])


class AccountingGateTests(TimedTestCase):
    """sacct runs only when the queue fingerprint changes or the cache is old."""

    def test_gate_command_compares_with_the_previous_fingerprint(self):
        command = accounting_gate_command(MACHINE, "123 45", force=False)
        self.assertIn("--format='%i|%T'", command)  # IDs and states only, never times.
        self.assertIn("if [ 0 = 0 ] && [ \"$fp\" = '123 45' ]; then echo unchanged", command)
        self.assertIn("sacct", command)
        self.assertIn("if [ 1 = 0 ]", accounting_gate_command(MACHINE, "123 45", force=True))

    def test_unchanged_fingerprint_reuses_records_and_change_parses_new_ones(self):
        previous = AccountingSnapshot([{"job_id": "9"}], "1 1", "since", "fetched", 0.0)

        fingerprint, reused = _accounting_from_section(Section("fingerprint 1 1\nunchanged\n", "", 0), previous)
        self.assertEqual(fingerprint, "1 1")
        self.assertIs(reused, previous)

        fingerprint, fresh = _accounting_from_section(Section(f"fingerprint 2 2\n{ACCOUNTING_LINE}", "", 0), previous)
        self.assertEqual(fingerprint, "2 2")
        self.assertEqual([record["job_id"] for record in fresh.records], ["10"])
        self.assertEqual(fresh.fingerprint, "2 2")

        self.assertEqual(_accounting_from_section(Section("", "squeue failed", 1), previous), (None, None))

    @patch("clusterwatcher.slurm.run_batch")
    def test_stale_accounting_forces_a_query(self, run_batch):
        run_batch.return_value = {"accounting": Section("fingerprint 1 1\nunchanged\n", "", 0)}
        previous = ClusterStatus("alpha", "h", "alice", capacity_updated_at="x",
                                 accounting=AccountingSnapshot([], "1 1", "s", "f", fetched_monotonic=0.0))

        with patch("clusterwatcher.slurm.time.monotonic", return_value=10_000.0):
            collect_status(MACHINE, 5, False, False, previous=previous, refresh_capacity=False, include_accounting=True)

        self.assertIn("if [ 1 = 0 ]", run_batch.call_args.args[2]["accounting"])

    @patch("clusterwatcher.jobs.collect_accounting_jobs")
    def test_default_jobs_query_reuses_refresh_records_without_sacct(self, collect_accounting_jobs):
        from clusterwatcher.slurm import parse_accounting_jobs

        status = ClusterStatus("alpha", "h", "alice", user_jobs=[],
                               accounting=AccountingSnapshot(parse_accounting_jobs(ACCOUNTING_LINE), "1 1", "s", "f"))
        service = JobService([MACHINE], 5, 15, lambda: [status])

        payload = service.query()

        self.assertEqual([job["job_id"] for job in payload["jobs"]], ["10"])
        collect_accounting_jobs.assert_not_called()
        self.assertNotIn("_stdout", payload["jobs"][0])

        collect_accounting_jobs.return_value = []
        service.query(job_ids=("10",))
        collect_accounting_jobs.assert_called_once()


class ETagTests(TimedTestCase):
    """Unchanged data answers 304 even though timestamps and elapsed times moved."""

    def test_etag_ignores_volatile_fields_only(self):
        base = {"generated_at": "t1", "jobs": [{"job_id": "1", "state": "RUNNING", "elapsed_seconds": 10}]}
        later = {"generated_at": "t2", "jobs": [{"job_id": "1", "state": "RUNNING", "elapsed_seconds": 25}]}
        finished = {"generated_at": "t2", "jobs": [{"job_id": "1", "state": "COMPLETED", "elapsed_seconds": 25}]}

        self.assertEqual(stable_etag(base), stable_etag(later))
        self.assertEqual(stable_etag({**base, "since": "2026-10-05T10:00:00"}), stable_etag({**base, "since": "2026-10-05T10:00:15"}))
        self.assertNotEqual(stable_etag(base), stable_etag(finished))

    def request(self, store: StatusStore, path: str, if_none_match: str | None = None) -> dict[str, object]:
        handler = object.__new__(make_handler(store))
        handler.path = path
        handler.wfile = BytesIO()
        handler.headers = Message()
        if if_none_match:
            handler.headers["If-None-Match"] = if_none_match
        response: dict[str, object] = {"headers": {}}
        handler.send_response = lambda code: response.update(status=code)
        handler.send_header = lambda name, value: response["headers"].update({name: value})
        handler.end_headers = lambda: None
        handler.do_GET()
        response["body"] = handler.wfile.getvalue()
        return response

    def test_snapshot_returns_304_until_the_data_changes(self):
        store = StatusStore([MACHINE], 5, False, 15)
        store._statuses = [ClusterStatus("alpha", "h", "alice", partitions=[])]
        store._updated_at = "2026-09-22T10:00:00+00:00"

        first = self.request(store, "/api/v1/snapshot")
        etag = first["headers"]["ETag"]
        store._updated_at = "2026-09-22T10:00:15+00:00"  # A new refresh with identical data.
        unchanged = self.request(store, "/api/v1/snapshot", etag)
        store._statuses[0].error = "unreachable"
        changed = self.request(store, "/api/v1/snapshot", etag)

        self.assertEqual(first["status"], 200)
        self.assertEqual((unchanged["status"], unchanged["body"]), (304, b""))
        self.assertEqual(changed["status"], 200)
        self.assertNotEqual(changed["headers"]["ETag"], etag)

    def test_internal_accounting_cache_never_reaches_the_api(self):
        store = StatusStore([MACHINE], 5, False, 15)
        store._statuses = [ClusterStatus("alpha", "h", "alice", accounting=AccountingSnapshot([{"_stdout": "/x"}], "1", "s", "f"))]
        self.assertNotIn("accounting", store.payload()["clusters"][0])
