"""Simulated HTCondor responses for scheduler routing and normalized views."""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from clusterwatcher.condor import (
    capacity_signals, collect_status, fetch_submit_file, group_nodes_by_model,
    parse_jobs, parse_slots, parse_user_priority,
)
from clusterwatcher.config import load_config
from clusterwatcher.dashboard import StatusStore
from clusterwatcher.job_scripts import JobScriptNotFound
from clusterwatcher.jobs import JobService
from clusterwatcher.models import ClusterStatus, Machine
from clusterwatcher.remote_batch import Section
from clusterwatcher.scheduler import detected_scheduler
from clusterwatcher.snapshot import build_snapshot
from clusterwatcher.terminal_status import render_status_board
from clusterwatcher.terminal_jobs import _state_group


class CondorTests(unittest.TestCase):
    """Check Condor resource accounting and API compatibility without SSH."""

    def setUp(self):
        self.machine = Machine("saar", "login.example", "cameronb", scheduler="condor")
        self.now = datetime.now(timezone.utc)
        self.slots = json.dumps([
            {"Name": "slot1@node-a", "Machine": "node-a", "SlotType": "Partitionable", "PartitionableSlot": True,
             "Cpus": 6, "GPUs": 1, "State": "Unclaimed", "GPUs_DeviceName": "NVIDIA A100", "GPUs_GlobalMemoryMb": 81920},
            {"Name": "slot1_1@node-a", "Machine": "node-a", "SlotType": "Dynamic", "DynamicSlot": True,
             "Cpus": 2, "GPUs": 1, "State": "Claimed", "RemoteOwner": "cameronb@submit"},
            {"Name": "slot1@node-b", "Machine": "node-b", "SlotType": "Static",
             "Cpus": 4, "GPUs": 0, "State": "Unclaimed"},
        ])
        self.queue = json.dumps([
            {"Owner": "cameronb", "ClusterId": 42, "ProcId": 0, "JobBatchName": "training",
             "JobStatus": 2, "RequestCpus": 2, "RequestGPUs": 1,
             "AllowedExecuteDuration": 3600,
             "QDate": 1760000000, "JobStartDate": 1760000100, "RemoteHost": "slot1_1@node-a",
             "Out": "training.out", "Err": "training.err", "Iwd": "/home/cameronb/jobs",
             "JobSubmitFile": "training.sub"},
            {"Owner": "cameronb", "ClusterId": 42, "ProcId": 1, "JobBatchName": "training",
             "JobStatus": 1, "RequestCpus": 2, "RequestGPUs": 1, "QDate": 1760000000},
            {"Owner": "another", "ClusterId": 99, "ProcId": 0, "JobStatus": 2},
        ])

    def tearDown(self):
        detected_scheduler.cache_clear()

    def test_config_scheduler_and_auto_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clusters.toml"
            path.write_text('[[machine]]\nname="saar"\nhost="login.example"\nusername="cameronb"\nscheduler="condor"\n')
            self.assertEqual(load_config(path)[0].scheduler, "condor")
            path.write_text('[[machine]]\nname="saar"\nhost="login.example"\nusername="cameronb"\nscheduler="pbs"\n')
            with self.assertRaisesRegex(ValueError, "scheduler must be"):
                load_config(path)
        auto = Machine("saar", "login.example", "cameronb")
        with patch("clusterwatcher.scheduler.run_remote", return_value="condor_q\n"):
            self.assertEqual(detected_scheduler(auto, 5), "condor")
        detected_scheduler.cache_clear()
        with patch("clusterwatcher.scheduler.run_remote", return_value="sinfo\ncondor_q\n"):
            with self.assertRaisesRegex(RuntimeError, "both Slurm and HTCondor"):
                detected_scheduler(auto, 5)

    def test_slot_resources_are_counted_once_and_owned_usage_is_marked(self):
        nodes = parse_slots(self.slots)
        self.assertEqual(len(nodes), 2)
        self.assertEqual(nodes[0]["cpu"], {"total": 8, "allocated": 2, "idle": 6})
        self.assertEqual(nodes[0]["gpu"]["total"], 2)
        self.assertEqual(nodes[0]["gpu"]["allocated"], 1)
        self.assertEqual(nodes[0]["_owners"]["cameronb"], {"cpus": 2, "gpus": 1})

    def test_mixed_gpu_models_remain_untyped_without_reliable_counts(self):
        """Different model labels on one host must not all inherit its total."""
        ads = json.dumps([
            {"Machine": "mixed", "SlotType": "Partitionable", "Cpus": 2, "GPUs": 1,
             "GPUs_DeviceName": "A100", "GPUs_GlobalMemoryMb": 81920},
            {"Machine": "mixed", "SlotType": "Dynamic", "Cpus": 2, "GPUs": 1,
             "GPUs_DeviceName": "H100", "GPUs_GlobalMemoryMb": 81920},
        ])
        node = parse_slots(ads)[0]
        self.assertEqual(node["gpu"]["total"], 2)
        self.assertEqual(node["gpu"]["types"], {"generic": 2})

    def test_array_like_proc_ids_and_history_state(self):
        self.assertEqual(parse_jobs("", "cameronb"), [])
        jobs = parse_jobs(self.queue, "cameronb")
        self.assertEqual([job["job_id"] for job in jobs], ["42.0", "42.1"])
        self.assertEqual([job["state"] for job in jobs], ["RUNNING", "PENDING"])
        self.assertEqual(jobs[0]["_stderr"], "training.err")
        self.assertEqual(jobs[0]["time_limit_seconds"], 3600)
        history = json.dumps([{"Owner": "cameronb", "ClusterId": 41, "ProcId": 0,
                               "JobStatus": 4, "ExitCode": 2, "QDate": 1760000000}])
        self.assertEqual(parse_jobs(history, "cameronb", history=True)[0]["state"], "FAILED")
        held = parse_jobs(json.dumps([{"Owner": "cameronb", "ClusterId": 43, "ProcId": 0,
                                      "JobStatus": 5, "HoldReason": "Missing input"}]), "cameronb")
        self.assertEqual(_state_group(held[0]["state"]), "OTHER")

    def test_pool_snapshot_and_model_capacity_signals(self):
        sections = {
            "slots": Section(self.slots, "", 0),
            "queue": Section(self.queue, "", 0),
            "priority": Section("poweruser.cameronb@submit\t2.5\t1\t0.25\t12\t4", "", 0),
        }
        with patch("clusterwatcher.condor.run_batch", return_value=sections), patch("clusterwatcher.condor.active_host", return_value="login.example"):
            status = collect_status(self.machine, 5, True)
        self.assertIsNone(status.error)
        self.assertEqual(status.condor_priority[0]["pool_share"], 0.25)
        self.assertEqual(status.nodes[0]["my_usage"]["gpus"], 1)
        status.wait_estimates = capacity_signals(status.nodes)
        snapshot = build_snapshot([status], self.now.isoformat(), 15)
        cluster = snapshot["clusters"][0]
        self.assertEqual(cluster["scheduler"], "condor")
        self.assertEqual([item["name"] for item in cluster["partitions"]], ["pool: A100", "pool"])
        self.assertEqual(cluster["resources"]["gpus"]["total"], 2)
        self.assertEqual(cluster["partitions"][0]["gpus"]["models"][0]["vram_gb"], 80)
        self.assertEqual(cluster["partitions"][0]["wait_estimates"][0]["capacity_state"], "free")
        self.assertEqual(cluster["partitions"][0]["wait_estimates"][1]["capacity_state"], "busy")
        self.assertTrue(cluster["partitions"][1]["aggregate"])
        board = render_status_board(snapshot, width=140)
        self.assertIn("## saar ##", board)
        self.assertIn("pool", board)
        self.assertIn("FREE", board)
        self.assertIn("BUSY", board)
        self.assertIn("GPU FIT NOW", board)
        self.assertNotIn("WAIT TIME · JOB", board)
        self.assertIn("Pool share: 25.0%", board)
        store = StatusStore([self.machine], 5, False, 15)
        store._statuses = [status]
        self.assertNotIn("_stderr", store.payload()["clusters"][0]["user_jobs"][0])

    def test_jobs_api_uses_condor_history_and_stable_proc_ids(self):
        active = parse_jobs(self.queue, "cameronb")
        status = ClusterStatus("saar", "login.example", "cameronb", scheduler="condor", user_jobs=active, nodes=[])
        history = [{"job_id": "40.0", "name": "finished", "state": "COMPLETED", "submit_at": self.now.isoformat(),
                    "partition": "pool", "nodes": [], "gpus": 0, "gpu_total": 0, "cpus": 1}]
        with patch("clusterwatcher.condor.collect_history", return_value=history):
            payload = JobService([self.machine], 5, 0, lambda: [status]).query(since=self.now - timedelta(hours=1))
        records = {job["job_id"]: job for job in payload["jobs"]}
        self.assertEqual(set(records), {"40.0", "42.0", "42.1"})
        self.assertEqual(records["42.0"]["scheduler"], "condor")
        self.assertEqual(records["42.0"]["gpu_total"], 1)
        self.assertTrue(records["42.0"]["script_available"])
        self.assertEqual(records["42.0"]["log_paths_available"], {"out": True, "err": True})
        self.assertNotIn("_submit_file", records["42.0"])

    def test_cancel_verifies_owner_and_log_paths_use_submit_workdir(self):
        active = parse_jobs(self.queue, "cameronb")
        status = ClusterStatus("saar", "login.example", "cameronb", scheduler="condor", user_jobs=active)
        service = JobService([self.machine], 5, 0, lambda: [status])
        self.assertEqual(
            service._resolve_job_log_path(self.machine, "42.0", "err"),
            "/home/cameronb/jobs/training.err",
        )
        with patch("clusterwatcher.jobs.run_remote", side_effect=[json.dumps([{"Owner": "cameronb"}]), "removed"]) as remote:
            service.cancel("saar", "42.0")
        self.assertIn("condor_rm 42.0", remote.call_args_list[1].args[2])
        with patch("clusterwatcher.jobs.run_remote", return_value=json.dumps([{"Owner": "someone-else"}])):
            with self.assertRaisesRegex(ValueError, "does not belong"):
                service.cancel("saar", "42.1")

    def test_priority_parser_filters_other_users(self):
        rows = parse_user_priority("other@host\t1\t1\t0.5\npoweruser.cameronb@host\t2\t1\t0.25", "cameronb")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["effective_priority"], 2)

    def test_model_groups_keep_memory_variants_separate_and_single_host_fit(self):
        nodes = [
            {"name": "a", "partitions": "pool", "state": "mixed", "gpu": {"types": {"NVIDIA A100 80GB PCIe": 8}, "total": 8, "idle": 0}},
            {"name": "b", "partitions": "pool", "state": "mixed", "gpu": {"types": {"NVIDIA A100-PCIE-40GB": 8}, "total": 8, "idle": 4}},
        ]
        self.assertEqual(group_nodes_by_model("saar", nodes), ["pool: A100 40GB", "pool: A100 80GB"])
        signals = capacity_signals(nodes)
        self.assertEqual(signals["pool: A100 80GB"][0]["capacity_state"], "busy")
        self.assertEqual(signals["pool: A100 40GB"][2]["capacity_state"], "free")
        self.assertEqual(signals["pool"][4]["capacity_state"], "multi_node")

    def test_submit_file_is_current_copy_and_logs_use_cached_history(self):
        record = {"job_id": "42.0", "_submit_file": "jobs/train.sub", "_workdir": "/work/cameronb",
                  "_stdout": "run.out", "_stderr": "run.err"}
        with patch("clusterwatcher.condor.run_remote", return_value="request_gpus = 1\n") as remote:
            file = fetch_submit_file(self.machine, 5, record)
        self.assertEqual(file["source"], "file")
        self.assertEqual(file["path"], "/work/cameronb/jobs/train.sub")
        self.assertIn("head -c", remote.call_args.args[2])
        with patch("clusterwatcher.condor.run_remote", side_effect=RuntimeError("missing")):
            with self.assertRaises(JobScriptNotFound):
                fetch_submit_file(self.machine, 5, record)
        status = ClusterStatus("saar", "login.example", "cameronb", scheduler="condor", user_jobs=[])
        service = JobService([self.machine], 5, 0, lambda: [status])
        service._log_records[("saar", "42.0")] = record
        with patch("clusterwatcher.condor.collect_history", side_effect=AssertionError("history should be cached")):
            self.assertEqual(service._resolve_job_log_path(self.machine, "42.0", "out"), "/work/cameronb/run.out")
            with patch("clusterwatcher.condor.fetch_submit_file", return_value=file):
                self.assertEqual(service.batch_script("saar", "42.0")["source"], "file")


if __name__ == "__main__":
    unittest.main()
