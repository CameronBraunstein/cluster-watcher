"""Tests for the public cluster availability web-service contract."""

from io import BytesIO
from email.message import Message
import json
from unittest.mock import Mock, patch

from clusterwatcher.dashboard import StatusStore, make_handler
from clusterwatcher.commands import SessionUnavailableError
from clusterwatcher.jobs import JobLogNotFound
from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.snapshot import build_snapshot
from helpers import TimedTestCase


def example_status() -> ClusterStatus:
    """Return a mixed-availability cluster fixture with a wait estimate."""
    return ClusterStatus(
        "cluster_0",
        "slurm.example",
        "alice",
        partitions=[{
            "partition": "gpu-a100", "available": "up", "nodes": "2",
            "cpus": "1/143/0/144", "state": "mix",
            "priority_job_factor": 200, "priority_tier": 2,
        }],
        nodes=[
            {
                "name": "gpu01",
                "partitions": "gpu-a100",
                "state": "MIXED",
                "cpu": {"total": 72, "allocated": 1, "idle": 71},
                "gpu": {"total": 4, "allocated": 1, "idle": 3, "types": {"a100": 4}},
                "next_release": "2026-09-22T10:30:00",
            },
            {
                "name": "gpu02",
                "partitions": "gpu-a100",
                "state": "IDLE+DRAIN",
                "cpu": {"total": 72, "allocated": 0, "idle": 72},
                "gpu": {"total": 4, "allocated": 0, "idle": 4, "types": {"a100": 4}},
                "next_release": None,
            },
        ],
        partition_compute=[
            {
                "name": "gpu-a100",
                "rank": 1,
                "aggregate": False,
                "cpu_threads": 144,
                "best_gpu": {"name": "NVIDIA A100 80 GB", "vram_gb": 80, "tensor_tflops": 312.0},
            }
        ],
        wait_estimates={
            "gpu-a100": [
                {
                    "gpus": 1, "memory_mb": 1024, "walltime_minutes": 60,
                    "walltime_hours": 1, "start_time": "2026-09-22T11:00:00+00:00",
                    "error": None,
                }
            ]
        },
        wait_estimates_updated_at="2026-09-22T09:59:00+00:00",
        scheduling={"scheduler_type": "sched/backfill", "priority_type": "priority/multifactor"},
    )


def request_handler(
    store: StatusStore,
    path: str,
    method: str = "GET",
    body: bytes = b"",
    headers: dict[str, str] | None = None,
) -> tuple[dict[str, object], dict[str, object]]:
    """Exercise one HTTP request without opening a network socket."""
    handler = object.__new__(make_handler(store))
    handler.path = path
    handler.wfile = BytesIO()
    handler.rfile = BytesIO(body)
    handler.headers = Message()
    for name, value in (headers or {}).items():
        handler.headers[name] = value
    response: dict[str, object] = {"headers": {}}
    handler.send_response = lambda code: response.update(status=code)
    handler.send_header = lambda name, value: response["headers"].update({name: value})
    handler.end_headers = lambda: None
    if method == "POST":
        handler.do_POST()
    else:
        handler.do_GET()
    return response, json.loads(handler.wfile.getvalue())


class SnapshotTests(TimedTestCase):
    """Verify stable API semantics separately from the dashboard payload."""

    def test_disconnected_http_clients_do_not_emit_request_tracebacks(self):
        store = StatusStore([Machine("cluster_0", "slurm.example", "alice")], 5, False, 15)

        for error in (BrokenPipeError(), ConnectionResetError()):
            with self.subTest(error=type(error).__name__):
                handler = object.__new__(make_handler(store))
                handler.send_response = Mock()
                handler.send_header = Mock()
                handler.end_headers = Mock()
                handler.wfile = Mock()
                handler.wfile.write.side_effect = error

                handler._write_response(b"payload", "text/plain", 200, {})

                handler.wfile.write.assert_called_once_with(b"payload")

    def test_snapshot_contains_routing_resources_specs_and_waits(self):
        snapshot = build_snapshot([example_status()], "2026-09-22T10:00:00+00:00", 15)

        self.assertEqual(snapshot["schema_version"], "1.0")
        self.assertEqual(snapshot["wait_probe_refresh_seconds"], 600)
        cluster = snapshot["clusters"][0]
        self.assertTrue(cluster["reachable"])
        self.assertTrue(cluster["resource_data_complete"])
        self.assertEqual(cluster["scheduling"]["scheduler_type"], "sched/backfill")
        self.assertNotIn("username", cluster)
        self.assertEqual(cluster["resources"]["gpus"]["total"], 8)
        self.assertEqual(cluster["resources"]["gpus"]["schedulable_idle"], 3)

        partition = cluster["partitions"][0]
        self.assertEqual(partition["name"], "gpu-a100")
        self.assertTrue(partition["available"])
        self.assertFalse(partition["aggregate"])
        self.assertEqual(partition["priority_job_factor"], 200)
        self.assertEqual(partition["priority_tier"], 2)
        self.assertEqual(partition["gpus"]["allocated"], 1)
        self.assertEqual(partition["gpus"]["idle"], 7)
        self.assertEqual(partition["gpus"]["schedulable_idle"], 3)
        self.assertEqual(partition["gpus"]["unavailable_idle"], 4)
        self.assertEqual(partition["gpus"]["models"][0]["name"], "NVIDIA A100 80 GB")
        self.assertEqual(partition["gpus"]["models"][0]["vram_gb"], 80)
        self.assertEqual(partition["wait_estimates"][0]["walltime_seconds"], 3600)
        self.assertEqual(partition["wait_estimates"][0]["nodes"], 1)
        self.assertEqual(partition["wait_estimates"][0]["memory_mb"], 1024)
        self.assertEqual(partition["wait_estimates"][0]["estimated_wait_seconds"], 3600)
        self.assertEqual(partition["nodes"][1]["gpus"]["schedulable_idle"], 0)

    def test_snapshot_preserves_subhour_partition_probe_runtime(self):
        """Expose a configured 15-minute development-partition probe accurately."""
        status = example_status()
        status.wait_estimates["gpu-a100"][0]["walltime_minutes"] = 15

        snapshot = build_snapshot([status], "2026-09-22T10:00:00+00:00", 15)

        self.assertEqual(
            snapshot["clusters"][0]["partitions"][0]["wait_estimates"][0]["walltime_seconds"],
            900,
        )

    def test_snapshot_endpoint_returns_json_contract(self):
        store = StatusStore([Machine("cluster_0", "slurm.example", "alice")], 5, False, 15)
        store._statuses = [example_status()]
        store._updated_at = "2026-09-22T10:00:00+00:00"
        response, document = request_handler(store, "/api/v1/snapshot")

        self.assertEqual(response["status"], 200)
        self.assertEqual(response["headers"]["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        self.assertEqual(document["schema_version"], "1.0")
        self.assertEqual(document["clusters"][0]["partitions"][0]["gpus"]["total"], 8)

    def test_down_partition_has_no_schedulable_idle_gpus(self):
        status = example_status()
        status.partitions[0]["available"] = "down"

        partition = build_snapshot([status], "2026-09-22T10:00:00+00:00", 15)["clusters"][0]["partitions"][0]

        self.assertFalse(partition["available"])
        self.assertEqual(partition["gpus"]["idle"], 7)
        self.assertEqual(partition["gpus"]["schedulable_idle"], 0)
        self.assertEqual(partition["gpus"]["models"][0]["gpus"]["schedulable_idle"], 0)

    def test_snapshot_endpoint_is_unavailable_until_first_collection(self):
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15)
        response, snapshot = request_handler(store, "/api/v1/snapshot")

        self.assertEqual(response["status"], 503)
        self.assertEqual(response["headers"]["Retry-After"], "1")
        self.assertIsNone(snapshot["generated_at"])
        self.assertEqual(snapshot["clusters"], [])
        self.assertIn("first cluster status collection", snapshot["error"])

    def test_dashboard_endpoint_retries_until_first_collection(self):
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15)
        response, dashboard = request_handler(store, "/api/status")

        self.assertEqual(response["status"], 503)
        self.assertEqual(response["headers"]["Retry-After"], "1")
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        self.assertIsNone(dashboard["updated_at"])
        self.assertEqual(dashboard["clusters"], [])
        self.assertIn("first cluster status collection", dashboard["error"])

        store._statuses = [example_status()]
        store._updated_at = "2026-09-22T10:00:00+00:00"
        response, dashboard = request_handler(store, "/api/status")

        self.assertEqual(response["status"], 200)
        self.assertEqual(dashboard["clusters"][0]["name"], "cluster_0")

    def test_jobs_endpoint_is_opt_in_and_forwards_repeatable_filters(self):
        disabled = StatusStore([Machine("a", "host", "user")], 5, False, 15)
        response, document = request_handler(disabled, "/api/v1/jobs")
        self.assertEqual(response["status"], 404)
        self.assertIn("--jobs-api", document["error"])

        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, jobs_api_enabled=True)
        store._statuses = [ClusterStatus("a", "host", "user", user_jobs=[])]
        store._updated_at = "2026-09-23T10:00:00+00:00"
        result = {"schema_version": "1.0", "clusters": [], "jobs": []}
        with patch.object(store.job_service, "query", return_value=result) as query:
            response, document = request_handler(
                store,
                "/api/v1/jobs?cluster=a&job_id=10&job_id=11_2&state=terminal&since=2026-09-22T00%3A00%3A00Z",
            )

        self.assertEqual(response["status"], 200)
        self.assertEqual(document["schema_version"], "1.0")
        args = query.call_args.args
        self.assertEqual(args[:3], (("a",), ("10", "11_2"), "terminal"))
        self.assertEqual(args[3].isoformat(), "2026-09-22T00:00:00+00:00")

    def test_queued_job_log_endpoint_returns_clear_not_found(self):
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, jobs_api_enabled=True)
        with patch.object(store.job_service, "log_tail", side_effect=JobLogNotFound("queued job has no log yet")):
            response, document = request_handler(store, "/api/v1/jobs/a/10/log")

        self.assertEqual(response["status"], 404)
        self.assertIn("no log yet", document["error"])

    def test_job_log_endpoint_forwards_stdout_and_tail_selection(self):
        """Allow front ends to request either Slurm output stream explicitly."""
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, jobs_api_enabled=True)
        result = {
            "cluster": "a", "job_id": "10", "stream": "out", "path": "/logs/10.out",
            "lines": 1, "truncated": False, "content": "done\n",
        }
        with patch.object(store.job_service, "log_tail", return_value=result) as log_tail:
            response, document = request_handler(store, "/api/v1/jobs/a/10/log?stream=out&tail=2000")

        self.assertEqual(response["status"], 200)
        self.assertEqual(document["stream"], "out")
        log_tail.assert_called_once_with("a", "10", "out", 2000, None, 0)

    def test_job_log_endpoint_forwards_older_page_offset(self):
        """Expose bounded backward pagination without accepting duplicate offsets."""
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, jobs_api_enabled=True)
        result = {
            "cluster": "a", "job_id": "10", "stream": "err", "path": "/logs/10.err",
            "lines": 2000, "before": 2000, "more_before": True, "truncated": True, "content": "older\n",
        }
        with patch.object(store.job_service, "log_tail", return_value=result) as log_tail:
            response, document = request_handler(store, "/api/v1/jobs/a/10/log?stream=err&tail=2000&before=2000")

        self.assertEqual(response["status"], 200)
        self.assertTrue(document["more_before"])
        log_tail.assert_called_once_with("a", "10", "err", 2000, None, 2000)

        response, document = request_handler(store, "/api/v1/jobs/a/10/log?before=1&before=2")
        self.assertEqual(response["status"], 400)
        self.assertIn("at most once", document["error"])

    def test_script_endpoint_maps_results_and_missing_scripts(self):
        """Serve a job's batch script and turn a missing one into a clear 404."""
        from clusterwatcher.job_scripts import JobScriptNotFound

        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, jobs_api_enabled=True)
        result = {"cluster": "a", "job_id": "10", "source": "slurm", "path": None, "content": "#!/bin/bash\n", "truncated": False}
        with patch.object(store.job_service, "batch_script", return_value=result) as batch_script:
            response, document = request_handler(store, "/api/v1/jobs/a/10/script")
        self.assertEqual(response["status"], 200)
        self.assertEqual(document["source"], "slurm")
        batch_script.assert_called_once_with("a", "10")

        with patch.object(store.job_service, "batch_script", side_effect=JobScriptNotFound("no longer exists")):
            response, document = request_handler(store, "/api/v1/jobs/a/10/script")
        self.assertEqual(response["status"], 404)
        self.assertIn("no longer exists", document["error"])

    def test_cancel_endpoint_requires_jobs_api_and_json(self):
        """Refuse simple cross-site form posts and forward valid cancellations."""
        disabled = StatusStore([Machine("a", "host", "user")], 5, False, 15)
        response, _document = request_handler(
            disabled, "/api/v1/jobs/a/10/cancel", "POST", b"{}", {"Content-Type": "application/json"},
        )
        self.assertEqual(response["status"], 404)

        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, jobs_api_enabled=True)
        with patch.object(store.job_service, "cancel", return_value={"cluster": "a", "job_id": "10"}) as cancel:
            response, _document = request_handler(
                store, "/api/v1/jobs/a/10/cancel", "POST", b"", {"Content-Type": "text/plain"},
            )
            self.assertEqual(response["status"], 415)
            cancel.assert_not_called()

            response, document = request_handler(
                store, "/api/v1/jobs/a/10/cancel", "POST", b"{}", {"Content-Type": "application/json"},
            )
        self.assertEqual(response["status"], 200)
        self.assertEqual(document["job_id"], "10")
        cancel.assert_called_once_with("a", "10")

        with patch.object(store.job_service, "cancel", side_effect=RuntimeError("scancel: Invalid job id")):
            response, document = request_handler(
                store, "/api/v1/jobs/a/10/cancel", "POST", b"{}", {"Content-Type": "application/json"},
            )
        self.assertEqual(response["status"], 502)
        self.assertIn("Invalid job id", document["error"])

    def test_session_and_command_endpoints_are_opt_in(self):
        disabled = StatusStore([Machine("a", "host", "user")], 5, False, 15)
        response, document = request_handler(disabled, "/api/v1/sessions")
        self.assertEqual(response["status"], 404)
        self.assertIn("--command-api", document["error"])

        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, command_api_enabled=True)
        inventory = {"schema_version": "1.0", "generated_at": "now", "machines": []}
        with patch.object(store.command_service, "sessions", return_value=inventory):
            response, document = request_handler(store, "/api/v1/sessions")
        self.assertEqual(response["status"], 200)
        self.assertEqual(document["schema_version"], "1.0")

    def test_command_endpoint_returns_output_and_session_failures(self):
        store = StatusStore([Machine("a", "host", "user")], 5, False, 15, command_api_enabled=True)
        result = {
            "machine": "a", "exit_code": 0, "stdout": "hello\n", "stderr": "",
            "stdout_truncated": False, "stderr_truncated": False, "timed_out": False,
            "connection_dropped": False, "duration_seconds": 0.1, "session": {"session_open": True},
        }
        body = json.dumps({"machine": "a", "command": "printf hello", "timeout_seconds": 10}).encode()
        request_headers = {"Content-Type": "application/json", "Content-Length": str(len(body))}
        with patch.object(store.command_service, "execute", return_value=result) as execute:
            response, document = request_handler(
                store, "/api/v1/commands", "POST", body, request_headers
            )

        self.assertEqual(response["status"], 200)
        self.assertEqual(document["stdout"], "hello\n")
        execute.assert_called_once_with("a", "printf hello", 10)

        with patch.object(
            store.command_service, "execute",
            side_effect=SessionUnavailableError("SSH session for a is not open"),
        ):
            response, document = request_handler(
                store, "/api/v1/commands", "POST", body, request_headers
            )
        self.assertEqual(response["status"], 409)
        self.assertIn("not open", document["error"])

        unlimited_body = json.dumps({
            "machine": "a", "command": "sleep 600", "timeout_seconds": None,
        }).encode()
        response, document = request_handler(
            store, "/api/v1/commands", "POST", unlimited_body,
            {"Content-Type": "application/json", "Content-Length": str(len(unlimited_body))},
        )
        self.assertEqual(response["status"], 400)
        self.assertIn("between 1 and 300", document["error"])

        excessive_body = json.dumps({
            "machine": "a", "command": "sleep 600", "timeout_seconds": 600,
        }).encode()
        response, document = request_handler(
            store, "/api/v1/commands", "POST", excessive_body,
            {"Content-Type": "application/json", "Content-Length": str(len(excessive_body))},
        )
        self.assertEqual(response["status"], 400)
        self.assertIn("between 1 and 300", document["error"])

        with patch.object(store.command_service, "execute", return_value={**result, "timed_out": True}):
            response, document = request_handler(
                store, "/api/v1/commands", "POST", body, request_headers
            )
        self.assertEqual(response["status"], 504)
        self.assertEqual(document["stdout"], "hello\n")

        with patch.object(store.command_service, "execute", return_value={**result, "connection_dropped": True}):
            response, document = request_handler(
                store, "/api/v1/commands", "POST", body, request_headers
            )
        self.assertEqual(response["status"], 502)


if __name__ == "__main__":
    import unittest

    unittest.main()
