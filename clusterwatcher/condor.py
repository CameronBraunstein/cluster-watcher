"""HTCondor ClassAd collectors normalized for the existing status and jobs APIs.

HTCondor advertises slots rather than Slurm partitions. A single ``pool``
group is therefore shown, and capacity counts are derived from partitionable
slot free resources plus their dynamic children. This is a snapshot of
advertised resources, not a prediction that a particular job will match.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import json
import posixpath
import re
import shlex
import subprocess

from .compute import rank_partitions
from .compute import profile_for
from .models import AccountingSnapshot, ClusterStatus, Machine
from .remote_batch import run_batch
from .ssh import active_host, run_remote
from .job_scripts import JobScriptNotFound, MAX_SCRIPT_BYTES

STATUS_COMMAND = (
    "condor_status -json -attributes "
    "Name,Machine,SlotType,PartitionableSlot,DynamicSlot,Cpus,GPUs,State,Activity,"
    "RemoteOwner,RemoteUser,GPUs_DeviceName,GPUDeviceName,GPUs_GlobalMemoryMb"
)
HISTORY_LIMIT = 5000
PRIORITY_COMMAND = "condor_userprio -all -af:t Name Priority PriorityFactor SubmitterShare SubmitterLimit WeightedResourcesUsed"
JOB_STATES = {1: "PENDING", 2: "RUNNING", 3: "CANCELLED", 4: "COMPLETED", 5: "HELD", 6: "STAGE_OUT", 7: "SUSPENDED"}


def _ads(output: str) -> list[dict[str, object]]:
    """Validate JSON ClassAd arrays without trusting malformed remote output."""
    if not output.strip():
        # Some HTCondor releases print no bytes for an empty queue/history.
        return []
    parsed = json.loads(output)
    if not isinstance(parsed, list) or any(not isinstance(item, dict) for item in parsed):
        raise ValueError("HTCondor query did not return a JSON ClassAd array")
    return parsed


def _integer(value: object) -> int:
    """Convert a numeric ClassAd value to a nonnegative resource count."""
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def _timestamp(value: object) -> str | None:
    """Convert HTCondor epoch seconds to an unambiguous UTC timestamp."""
    seconds = _integer(value)
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat() if seconds else None


def _owner_constraint(username: str, since: datetime | None = None) -> str:
    """Construct a bounded ClassAd expression for one configured user."""
    # JSON quoting is also valid ClassAd string quoting for usernames.
    expression = f"Owner == {json.dumps(username)}"
    if since is not None:
        expression += f" && QDate >= {int(since.timestamp())}"
    return shlex.quote(expression)


def queue_command(username: str) -> str:
    """Query only this user's jobs so a large shared pool stays responsive."""
    return f"condor_q -json -constraint {_owner_constraint(username)}"


def _resource(slot: dict[str, object], name: str) -> int:
    """Read a possibly differently capitalized advertised resource name."""
    for key in (name, name.lower(), name.upper()):
        if key in slot:
            return _integer(slot[key])
    return 0


def parse_slots(output: str) -> list[dict[str, object]]:
    """Aggregate partitionable, dynamic, and static slot ads by physical host.

    A partitionable parent advertises remaining free resources; its dynamic
    children hold resources already assigned to jobs. Adding both yields the
    total without counting a parent ``TotalSlot*`` field twice. Static slots
    are counted once, including a static slot currently running a job.
    """
    hosts: dict[str, dict[str, object]] = {}
    for slot in _ads(output):
        name = str(slot.get("Machine") or str(slot.get("Name") or "").partition("@")[2])
        if not name:
            continue
        host = hosts.setdefault(name, {"name": name, "partitions": "pool", "state": "idle", "cpu": {"total": 0, "allocated": 0, "idle": 0}, "gpu": {"total": 0, "allocated": 0, "idle": 0, "types": {}}, "my_usage": {"cpus": 0, "gpus": 0}})
        kind = str(slot.get("SlotType") or "").casefold()
        dynamic = bool(slot.get("DynamicSlot")) or kind == "dynamic"
        free_slot = bool(slot.get("PartitionableSlot")) or kind == "partitionable"
        state = str(slot.get("State") or "").casefold()
        activity = str(slot.get("Activity") or "").casefold()
        busy = dynamic or (not free_slot and (state == "claimed" or activity == "busy"))
        usable = state not in {"owner", "drained", "shutdown", "delete", "unclaimed_disabled"}
        cpu = _resource(slot, "Cpus")
        gpu = _resource(slot, "GPUs")
        for field, count in (("cpu", cpu), ("gpu", gpu)):
            resource = host[field]
            resource["total"] += count
            resource["allocated" if busy else "idle"] += count
        if not usable:
            host["state"] = "down"
        elif busy and host["state"] != "down":
            host["state"] = "mixed"
        owner = str(slot.get("RemoteOwner") or slot.get("RemoteUser") or "").split("@", 1)[0]
        if busy and owner:
            # Individual CPU/GPU squares can be outlined for the current user.
            own = host.setdefault("_owners", defaultdict(lambda: {"cpus": 0, "gpus": 0}))
            own[owner]["cpus"] += cpu
            own[owner]["gpus"] += gpu
        model = str(slot.get("GPUs_DeviceName") or slot.get("GPUDeviceName") or "").strip()
        if model and gpu:
            types = host["gpu"]["types"]
            types[model] = max(types.get(model, 0), gpu)
            memory_mb = _integer(slot.get("GPUs_GlobalMemoryMb"))
            if memory_mb:
                host["gpu"].setdefault("memory_gb", {})[model] = round(memory_mb / 1024)
    result: list[dict[str, object]] = []
    for host in hosts.values():
        gpu = host["gpu"]
        if gpu["total"] and not gpu["types"]:
            gpu["types"] = {"generic": gpu["total"]}
        elif len(gpu["types"]) == 1:
            # Repeated ads for the same model describe portions of one host.
            model = next(iter(gpu["types"]))
            gpu["types"] = {model: gpu["total"]}
        else:
            # The aggregate slot ad does not prove per-model counts when a
            # machine advertises different GPU types. Do not invent a split.
            gpu["types"] = {"generic": gpu["total"]}
            gpu.pop("memory_gb", None)
        owners = host.pop("_owners", {})
        host["_owners"] = dict(owners)
        if host["state"] == "mixed" and gpu["idle"] == 0 and host["cpu"]["idle"] == 0:
            host["state"] = "allocated"
        result.append(host)
    return sorted(result, key=lambda host: str(host["name"]))


def _model_group(cluster: str, node: dict[str, object]) -> str | None:
    """Name a display-only GPU group from one host's advertised device model."""
    types = node.get("gpu", {}).get("types", {})
    if len(types) != 1 or "generic" in types:
        return None
    raw = next(iter(types))
    profile = profile_for(cluster, [raw])
    name = profile.name if profile else raw
    model = re.search(r"\b[HAVL]\d{2,4}\b", name, re.IGNORECASE)
    memory = re.search(r"\b\d+\s*GB\b", name, re.IGNORECASE)
    label = model[0].upper() if model else name
    if model and memory:
        label += f" {memory[0].replace(' ', '')}"
    return f"pool: {label}"


def group_nodes_by_model(cluster: str, nodes: list[dict[str, object]]) -> list[str]:
    """Add disjoint model groups while retaining ``pool`` as the all-host view."""
    names: set[str] = set()
    for node in nodes:
        group = _model_group(cluster, node)
        node["partitions"] = f"pool,{group}" if group else "pool"
        if group:
            names.add(group)
    return sorted(names)


def parse_jobs(output: str, username: str, *, history: bool = False) -> list[dict[str, object]]:
    """Normalize personal ClassAds; ``ClusterId.ProcId`` remains the stable ID."""
    jobs: list[dict[str, object]] = []
    for ad in _ads(output):
        if str(ad.get("Owner") or "") != username:
            continue
        cluster_id = ad.get("ClusterId")
        proc_id = ad.get("ProcId")
        if cluster_id is None or proc_id is None:
            continue
        job_id = f"{_integer(cluster_id)}.{_integer(proc_id)}"
        state = JOB_STATES.get(_integer(ad.get("JobStatus")), "UNKNOWN")
        if history and state == "COMPLETED" and (
            _integer(ad.get("ExitCode")) or ad.get("ExitBySignal") is True
        ):
            state = "FAILED"
        host = str(ad.get("RemoteHost") or "").partition("@")[2]
        if not host:
            host = str(ad.get("LastRemoteHost") or "").partition("@")[2]
        started = _timestamp(ad.get("JobStartDate"))
        submitted = _timestamp(ad.get("QDate"))
        ended = _timestamp(ad.get("CompletionDate") or ad.get("EnteredCurrentStatus")) if state in {"COMPLETED", "FAILED", "CANCELLED"} else None
        elapsed = _integer(ad.get("RemoteWallClockTime")) or None
        if state == "RUNNING" and started:
            elapsed = max(0, int(datetime.now(timezone.utc).timestamp()) - _integer(ad.get("JobStartDate")))
        gpus = _integer(ad.get("RequestGPUs"))
        limit = _integer(ad.get("AllowedExecuteDuration")) or None
        reason = ad.get("HoldReason") if state == "HELD" else ad.get("LastRejMatchReason")
        jobs.append({
            "id": job_id, "job_id": job_id, "name": str(ad.get("JobBatchName") or ad.get("Cmd") or job_id).rsplit("/", 1)[-1],
            "state": state, "partition": "pool", "nodes": [host] if host else [], "node_count": 1,
            "cpus": _integer(ad.get("RequestCpus")), "gpus": gpus, "gpu_total": gpus,
            "submit_time": submitted, "submit_at": submitted,
            "start_time": started, "start_at": started, "end_at": ended,
            "elapsed_seconds": elapsed, "time_limit_seconds": limit,
            "time_left_seconds": max(0, limit - elapsed) if limit is not None and elapsed is not None else None,
            "expected_start_at": None, "priority": ad.get("JobPrio"), "reason": reason,
            "hold_reason_code": _integer(ad.get("HoldReasonCode")) if state == "HELD" else None,
            "dependency": None, "exit_code": ad.get("ExitCode"),
            "_stdout": ad.get("Out"), "_stderr": ad.get("Err"), "_workdir": ad.get("Iwd"),
            "_submit_file": ad.get("JobSubmitFile"),
        })
    return jobs


def collect_history(machine: Machine, timeout: int, since: datetime, job_ids: tuple[str, ...] = ()) -> list[dict[str, object]]:
    """Query a bounded recent history; filter specific job IDs locally."""
    command = f"condor_history -json -limit {HISTORY_LIMIT} -constraint {_owner_constraint(machine.username, None if job_ids else since)}"
    jobs = parse_jobs(run_remote(machine, timeout, command), machine.username, history=True)
    return [job for job in jobs if not job_ids or any(
        job["job_id"] == requested or ("." not in requested and job["job_id"].startswith(f"{requested}."))
        for requested in job_ids
    )]


def fetch_submit_file(machine: Machine, timeout: int, record: dict[str, object]) -> dict[str, object]:
    """Read the current submit file named by a user's Condor job ClassAd.

    Condor stores the path, not an immutable copy of the submitted text. The
    returned source is therefore ``file`` and callers must show that caveat.
    """
    raw = str(record.get("_submit_file") or "")
    workdir = str(record.get("_workdir") or "")
    if not raw:
        raise JobScriptNotFound("This HTCondor job does not advertise a submit-file path")
    if not raw.startswith("/") and not workdir.startswith("/"):
        raise JobScriptNotFound("The HTCondor submit-file path has no absolute working directory")
    path = posixpath.normpath(raw if raw.startswith("/") else posixpath.join(workdir, raw))
    quoted = shlex.quote(path)
    try:
        content = run_remote(
            machine, timeout,
            f"test -f {quoted} -a -r {quoted} || {{ echo 'Submit file is not readable' >&2; exit 1; }}; "
            f"head -c {MAX_SCRIPT_BYTES + 1} -- {quoted}",
        )
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        raise JobScriptNotFound(f"The submit file is no longer readable: {path}") from exc
    encoded = content.encode()
    return {"source": "file", "scheduler": "condor", "path": path,
            "content": encoded[:MAX_SCRIPT_BYTES].decode(errors="ignore"),
            "truncated": len(encoded) > MAX_SCRIPT_BYTES}


def capacity_signals(nodes: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    """Report single-host GPU fit by model without claiming a start-time ETA.

    HTCondor matchmaking also considers requirements, submitter priority, and
    site policy. These signals only say whether an advertised host has enough
    free devices for one ordinary single-host job at this instant.
    """
    groups: dict[str, list[dict[str, object]]] = defaultdict(list)
    for node in nodes:
        for name in str(node.get("partitions", "pool")).split(","):
            groups[name].append(node)
    result = {}
    for name, members in groups.items():
        max_total = max((_integer(node["gpu"].get("total")) for node in members), default=0)
        max_free = max((_integer(node["gpu"].get("idle")) if node.get("state") != "down" else 0 for node in members), default=0)
        result[name] = []
        for count in (1, 2, 4, 8, 16, 32, 64):
            if count > max_total:
                state = "multi_node"
                detail = "No single host has this many GPUs; a multi-node workflow is required"
            elif count <= max_free:
                state = "free"
                detail = "Enough GPUs on one host; access, CPU, memory, and priority may prevent a start"
            else:
                state = "busy"
                detail = "No host currently advertises this many free GPUs; wait is unknown"
            result[name].append({"gpus": count, "nodes": 1, "walltime_minutes": 60,
                                 "start_time": None, "capacity_state": state,
                                 "error": detail, "error_kind": "capacity"})
    return result


def parse_user_priority(output: str, username: str) -> list[dict[str, object]]:
    """Read per-submitter negotiator priority and share from tab-separated ads."""
    rows: list[dict[str, object]] = []
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) < 4 or fields[0].split("@", 1)[0].strip('"').rsplit(".", 1)[-1] != username:
            continue
        def number(text: str) -> float | None:
            try:
                return float(text)
            except ValueError:
                return None
        rows.append({
            "submitter": fields[0].strip('"'),
            "effective_priority": number(fields[1]),
            "priority_factor": number(fields[2]),
            "pool_share": number(fields[3]),
            "core_limit": number(fields[4]) if len(fields) > 4 else None,
            "cores_used": number(fields[5]) if len(fields) > 5 else None,
        })
    return rows


def collect_status(
    machine: Machine, timeout: int, include_jobs: bool,
    include_personal_details: bool = True, *, previous: ClusterStatus | None = None,
    refresh_capacity: bool = True, include_accounting: bool = False,
) -> ClusterStatus:
    """Collect pool capacity and personal jobs in one reusable SSH session."""
    status = ClusterStatus(machine.name, machine.host, machine.username,
                           hosts=machine.candidate_hosts, submission_host=machine.submission_host,
                           scheduler="condor")
    capacity = refresh_capacity or previous is None or previous.capacity_updated_at is None
    commands = {}
    if capacity:
        commands["slots"] = STATUS_COMMAND
    if include_personal_details or include_jobs or include_accounting:
        commands["queue"] = queue_command(machine.username)
    if capacity:
        commands["priority"] = PRIORITY_COMMAND
    try:
        sections = run_batch(machine, timeout, commands)
        if capacity:
            status.nodes = parse_slots(sections["slots"].output())
            groups = group_nodes_by_model(machine.name, status.nodes)
            for node in status.nodes:
                node["my_usage"] = node.pop("_owners", {}).get(machine.username, {"cpus": 0, "gpus": 0})
            status.partitions = []
            for name in [*groups, "pool"]:
                count = sum(name in node["partitions"].split(",") for node in status.nodes)
                status.partitions.append({"partition": name, "available": "up",
                                          "nodes": str(count), "cpus": "", "state": "mixed"})
            status.partition_compute = rank_partitions(machine.name, status.nodes)
            for item in status.partition_compute:
                if item["name"] == "pool":
                    item["aggregate"] = True
                    item["rank"] = None
            status.partition_compute.sort(key=lambda item: item["name"] == "pool")
            status.capacity_updated_at = datetime.now(timezone.utc).isoformat()
            status.scheduling = {"scheduler": "condor", "note": "HTCondor schedules slots; pool is a display group, not a partition."}
            priority = sections["priority"]
            status.condor_priority = parse_user_priority(priority.stdout, machine.username) if priority.returncode == 0 else []
        elif previous is not None:
            for field in ("nodes", "partitions", "partition_compute", "capacity_updated_at", "scheduling", "jobs", "resource_error", "condor_priority"):
                setattr(status, field, deepcopy(getattr(previous, field)))
        if "queue" in sections:
            queue = parse_jobs(sections["queue"].output(), machine.username)
            status.user_jobs = queue if include_personal_details else []
            if include_jobs:
                status.jobs = dict(Counter(job["state"] for job in queue))
            if include_accounting:
                # HTCondor history is queried separately by JobService. Keep
                # queue records here so the ordinary jobs API can reuse them.
                status.accounting = AccountingSnapshot([], "", "", datetime.now(timezone.utc).isoformat())
        else:
            status.user_jobs = []
        status.fair_share = {"associations": [], "visible_associations": 0,
                             "error": "HTCondor user priority is not comparable to Slurm fair-share factors"}
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        status.error = str(exc)
    status.host = active_host(machine)
    return status


def collect_user_job_status(machine: Machine, timeout: int) -> ClusterStatus:
    """Collect just the current queue for the terminal jobs view."""
    status = ClusterStatus(machine.name, machine.host, machine.username,
                           hosts=machine.candidate_hosts, submission_host=machine.submission_host,
                           scheduler="condor")
    try:
        status.user_jobs = parse_jobs(run_remote(machine, timeout, queue_command(machine.username)), machine.username)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        status.error = str(exc)
        status.user_jobs = []
    status.host = active_host(machine)
    return status
