"""Slurm command execution, parsing, and terminal presentation."""

from collections import Counter
from datetime import datetime, timezone
import re
import shlex
import subprocess

from copy import deepcopy
from datetime import timedelta
import time

from .models import AccountingSnapshot, ClusterStatus, Machine
from .compute import rank_partitions
from .remote_batch import Section, run_batch
from .ssh import run_remote

SINFO_COMMAND = "sinfo --noheader --format='%P|%a|%D|%C|%T'"
SQUEUE_COMMAND = "squeue --noheader --format='%T'"
SQUEUE_USER_RUNNING_COMMAND = "TZ=UTC squeue --me --array --states=RUNNING --noheader --format='%i|%j|%T|%P|%N|%D|%C|%b|%S|%V|%E|%M|%l|%L|%r'"
SQUEUE_USER_PENDING_COMMAND = "TZ=UTC squeue --me --array --start --noheader --format='%i|%j|%T|%P|%N|%D|%C|%b|%S|%V|%E|%M|%l|%L|%r'"
SQUEUE_USER_JOBS_COMMAND = "TZ=UTC squeue --me --array --start --states=RUNNING,PENDING --noheader --format='%i|%j|%T|%P|%N|%D|%C|%b|%S|%V|%E|%M|%l|%L|%r'"
SQUEUE_RUNNING_END_COMMAND = "TZ=UTC squeue --states=RUNNING --noheader --format='%N|%e'"
# GresUsed, which reports allocated GPUs, is emitted only in detailed output.
SCONTROL_NODES_COMMAND = "scontrol show node --oneliner -d"
# Cheap identity of the user's queue: job IDs and states only, never times.
SQUEUE_USER_FINGERPRINT_COMMAND = "squeue --me --array --noheader --format='%i|%T'"
# Recent accounting records are re-fetched at least this often even if the
# queue fingerprint is unchanged (e.g. to pick up late exit codes).
ACCOUNTING_REFRESH_SECONDS = 300
ACCOUNTING_LOOKBACK = timedelta(hours=24)


def gpu_count(gres: str) -> int:
    """Return a whole-GPU count from Slurm GRES or TRES text.

    Slurm may render the same resource as ``gpu:a100:2``,
    ``gres/gpu:2``, or ``gres/gpu:a100=2`` depending on the command and
    cluster version.  Allocated TRES can contain both an aggregate entry and
    its typed breakdown, for example ``gres/gpu=2,gres/gpu:a100=2``.  In that
    case the aggregate is authoritative and must not be added to the typed
    count.
    """
    generic_count = 0
    typed_count = 0
    has_generic_count = False
    for raw_entry in gres.split(","):
        entry = raw_entry.strip().split("(", 1)[0]
        if "=" in entry:
            resource, count_text = entry.rsplit("=", 1)
            resource_parts = resource.split(":")
        else:
            resource_parts = entry.split(":")
            if len(resource_parts) < 2:
                continue
            count_text = resource_parts.pop()

        if resource_parts[0] not in {"gpu", "gres/gpu"} or not count_text.isdigit():
            continue
        count = int(count_text)
        if len(resource_parts) == 1:
            generic_count += count
            has_generic_count = True
        else:
            typed_count += count
    return generic_count if has_generic_count else typed_count


def gpu_types(gres: str) -> dict[str, int]:
    """Return configured GPU counts from GRES or TRES text.

    Detailed Slurm output is not uniform across clusters. A node may expose
    ``gpu:mi300a:2`` through ``Gres`` or ``gres/gpu:mi300a=2`` through
    ``CfgTRES``. TRES can contain both an aggregate ``gres/gpu=2`` and the
    typed breakdown for the same devices; the typed records win so the
    physical inventory is not counted twice.
    """
    generic_count = 0
    types: dict[str, int] = {}
    for raw_entry in gres.split(","):
        entry = raw_entry.strip().split("(", 1)[0]
        if "=" in entry:
            resource, count_text = entry.rsplit("=", 1)
            resource_parts = resource.split(":")
        else:
            resource_parts = entry.split(":")
            if len(resource_parts) < 2:
                continue
            count_text = resource_parts.pop()
        if resource_parts[0] not in {"gpu", "gres/gpu"} or not count_text.isdigit():
            continue
        count = int(count_text)
        if len(resource_parts) == 1:
            generic_count += count
        else:
            gpu_type = ":".join(resource_parts[1:])
            types[gpu_type] = types.get(gpu_type, 0) + count
    return types or ({"generic": generic_count} if generic_count else {})


def _gpu_resource_text(fields: dict[str, str], primary: str, fallback: str) -> str:
    """Choose a GPU-bearing GRES field, falling back to its TRES equivalent."""
    primary_value = fields.get(primary, "")
    return primary_value if gpu_count(primary_value) else fields.get(fallback, primary_value)


def expand_hostlist(hostlist: str) -> list[str]:
    """Expand common Slurm host-list ranges without invoking a remote shell."""
    names: list[str] = []
    for item in re.split(r",(?!(?:[^\[]*\]))", hostlist):
        match = re.fullmatch(r"([^\[]+)\[([^]]+)\]", item)
        if not match:
            if item and not item.startswith("("):
                names.append(item)
            continue
        prefix, ranges = match.groups()
        for value in ranges.split(","):
            if "-" not in value:
                names.append(prefix + value)
                continue
            start, end = value.split("-", 1)
            width = max(len(start), len(end))
            names.extend(f"{prefix}{number:0{width}d}" for number in range(int(start), int(end) + 1))
    return names


def slurm_duration_seconds(value: str) -> int | None:
    """Convert a Slurm ``[days-]hours:minutes:seconds`` duration to seconds.

    Slurm omits leading components for short durations. Sentinel values such as
    ``UNLIMITED``, ``NOT_SET``, and ``N/A`` have no finite numeric equivalent.
    """
    if not value or value.upper() in {"INVALID", "N/A", "NOT_SET", "UNLIMITED"}:
        return None
    day_text, separator, clock = value.partition("-")
    days = int(day_text) if separator and day_text.isdigit() else 0
    clock = clock if separator else day_text
    parts = clock.split(":")
    if not 1 <= len(parts) <= 3 or any(not part.isdigit() for part in parts):
        return None
    values = [int(part) for part in parts]
    hours, minutes, seconds = ([0] * (3 - len(values))) + values
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def utc_slurm_timestamp(value: str | None) -> str | None:
    """Mark a timestamp emitted under ``TZ=UTC`` as explicitly UTC.

    Slurm's text formats omit an offset even when the command environment is
    UTC. Adding ``Z`` at the parsing boundary prevents terminal, browser, and
    API consumers from mistaking those values for their local timezone.
    Sentinel and malformed values are preserved for existing error handling.
    """
    if value is None:
        return None
    text = value.strip()
    if not text or text in {"Unknown", "N/A", "None", "(null)", "NULL"}:
        return text
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text
    return f"{text}Z" if parsed.tzinfo is None else text


def parse_jobs(output: str) -> list[dict[str, object]]:
    """Parse compact ``squeue`` output with names and runtime progress."""
    jobs: list[dict[str, object]] = []
    for line in output.splitlines():
        fields = line.split("|")
        if len(fields) not in {14, 15}:
            continue
        reason = fields.pop() if len(fields) == 15 else ""
        (job_id, name, state, partition, node_list, node_count, cpus, gres,
         start_time, submit_time, dependency, elapsed, time_limit, time_left) = fields
        job_id = canonical_job_id(job_id)
        elapsed_seconds = slurm_duration_seconds(elapsed)
        limit_seconds = slurm_duration_seconds(time_limit)
        left_seconds = slurm_duration_seconds(time_left)
        if left_seconds is None and elapsed_seconds is not None and limit_seconds is not None:
            left_seconds = max(0, limit_seconds - elapsed_seconds)
        jobs.append({
            "id": job_id,
            "name": name or job_id,
            "state": state,
            "partition": partition.rstrip("*"),
            "nodes": expand_hostlist(node_list),
            "node_count": int(node_count) if node_count.isdigit() else 0,
            "cpus": int(cpus) if cpus.isdigit() else 0,
            "gpus": gpu_count(gres),
            "start_time": utc_slurm_timestamp(start_time),
            "submit_time": utc_slurm_timestamp(submit_time),
            "dependency": dependency,
            "reason": reason,
            "elapsed": elapsed,
            "elapsed_seconds": elapsed_seconds,
            "time_limit": time_limit,
            "time_limit_seconds": limit_seconds,
            "time_left": time_left,
            "time_left_seconds": left_seconds,
        })
    return jobs


def normalize_job_state(state: str) -> str:
    """Return Slurm's stable state name without annotations or truncation.

    Accounting can emit values such as ``CANCELLED by 12345`` or append ``+``
    when a display value was truncated.  API consumers need the underlying
    state while the exit code remains available separately.
    """
    return state.strip().split(None, 1)[0].rstrip("+").upper() or "UNKNOWN"


def canonical_job_id(job_id: str) -> str:
    """Normalize Slurm's single-task compressed array identifier.

    Without ``squeue --array``, a pending task can be printed as ``123_[4]``
    while accounting identifies the same task as ``123_4``. Normalizing the
    defensive fallback prevents duplicate live/accounting records.
    """
    match = re.fullmatch(r"(\d+)_\[(\d+)\]", job_id.strip())
    return f"{match.group(1)}_{match.group(2)}" if match else job_id.strip()


def job_array_task_id(job_id: str) -> int | None:
    """Extract an array task number from a canonical Slurm job identifier."""
    match = re.fullmatch(r"\d+_(\d+)", job_id)
    return int(match.group(1)) if match else None


def _optional_slurm_value(value: str) -> str | None:
    """Convert Slurm's empty-value markers to JSON-friendly ``None``."""
    return None if value.strip() in {"", "Unknown", "N/A", "None", "(null)", "NULL"} else value.strip()


def parse_accounting_jobs(output: str) -> list[dict[str, object]]:
    """Parse allocation-only, pipe-delimited ``sacct`` output.

    Private ``_stdout`` and ``_stderr`` fields are retained for on-demand log
    resolution but are removed before records enter the public jobs API.
    """
    jobs: list[dict[str, object]] = []
    for line in output.splitlines():
        fields = line.rstrip("\n").split("|")
        if len(fields) != 17:
            continue
        (job_id, name, state, exit_code, submit_at, start_at, end_at,
         elapsed_raw, partition, node_list, node_count, cpus, allocated_tres,
         reason, stdout, stderr, workdir) = fields
        job_id = job_id.strip()
        if not re.fullmatch(r"\d+(?:_\d+)?", job_id):
            continue
        jobs.append({
            "job_id": job_id,
            "array_task_id": job_array_task_id(job_id),
            "name": name.strip() or job_id,
            "state": normalize_job_state(state),
            "exit_code": _optional_slurm_value(exit_code),
            "submit_at": utc_slurm_timestamp(_optional_slurm_value(submit_at)),
            "start_at": utc_slurm_timestamp(_optional_slurm_value(start_at)),
            "end_at": utc_slurm_timestamp(_optional_slurm_value(end_at)),
            "elapsed_seconds": int(elapsed_raw) if elapsed_raw.isdigit() else None,
            "partition": partition.strip(),
            "nodes": expand_hostlist(node_list.strip()),
            "node_count": int(node_count) if node_count.isdigit() else 0,
            "cpus": int(cpus) if cpus.isdigit() else 0,
            "gpus": gpu_count(allocated_tres),
            "expected_start_at": None,
            "reason": _optional_slurm_value(reason),
            "_stdout": _optional_slurm_value(stdout),
            "_stderr": _optional_slurm_value(stderr),
            "_workdir": _optional_slurm_value(workdir),
        })
    return jobs


def accounting_jobs_command(since: datetime, job_ids: tuple[str, ...] = (), username: str | None = None) -> str:
    """Build one bounded ``sacct`` query for all requested job identifiers."""
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    start = since.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    fields = (
        "JobID,JobName,State,ExitCode,Submit,Start,End,ElapsedRaw,Partition,"
        "NodeList,NNodes,NCPUS,AllocTRES,Reason,StdOut,StdErr,WorkDir"
    )
    command = f"TZ=UTC sacct --noheader --parsable2 --allocations --array --starttime={shlex.quote(start)} --format={fields}"
    if username:
        command += f" --user={shlex.quote(username)}"
    if job_ids:
        command += f" --jobs={shlex.quote(','.join(job_ids))}"
    return command


def collect_accounting_jobs(
    machine: Machine,
    timeout: int,
    since: datetime,
    job_ids: tuple[str, ...] = (),
) -> list[dict[str, object]]:
    """Fetch recent jobs in one accounting round trip for a cluster."""
    return parse_accounting_jobs(run_remote(machine, timeout, accounting_jobs_command(since, job_ids, machine.username)))


def parse_job_log_paths(output: str) -> dict[str, str]:
    """Extract fully resolved stdout/stderr paths from ``scontrol -o`` text."""
    paths: dict[str, str] = {}
    for stream, field in (("out", "StdOut"), ("err", "StdErr")):
        match = re.search(rf"(?:^|\s){field}=(.*?)(?=\s+[A-Za-z][A-Za-z0-9_:]*=|$)", output)
        if match and _optional_slurm_value(match.group(1)):
            paths[stream] = match.group(1).strip()
    return paths


def collect_live_job_log_paths(machine: Machine, timeout: int, job_id: str) -> dict[str, str]:
    """Read resolved log paths for one live job from the Slurm controller."""
    if not re.fullmatch(r"\d+(?:_\d+)?", job_id):
        raise ValueError("job_id must be a numeric Slurm job or array-task identifier")
    output = run_remote(machine, timeout, f"scontrol show job --oneliner {job_id}")
    return parse_job_log_paths(output)


def user_node_usage(running_jobs: list[dict[str, object]]) -> dict[str, dict[str, int]]:
    """Estimate each user's running CPU/GPU allocations per assigned node."""
    usage: dict[str, dict[str, int]] = {}
    for job in running_jobs:
        nodes = job["nodes"]
        if not nodes:
            continue
        node_count = len(nodes)
        cpus_per_node = (int(job["cpus"]) + node_count - 1) // node_count
        gpus_per_node = (int(job["gpus"]) + node_count - 1) // node_count
        for name in nodes:
            current = usage.setdefault(name, {"cpus": 0, "gpus": 0})
            current["cpus"] += cpus_per_node
            current["gpus"] += gpus_per_node
    return usage


def node_release_estimates(output: str) -> dict[str, str]:
    """Return the earliest visible running-job end time for each node.

    This is a resource-release hint, not a scheduler promise: priority,
    reservations, and requested resource shape can delay a new job further.
    """
    estimates: dict[str, str] = {}
    for line in output.splitlines():
        fields = line.split("|", 1)
        if len(fields) != 2 or fields[1] in {"Unknown", "N/A", ""}:
            continue
        timestamp = utc_slurm_timestamp(fields[1])
        if not timestamp:
            continue
        for node in expand_hostlist(fields[0]):
            estimates[node] = min(estimates.get(node, timestamp), timestamp)
    return estimates


def collect_node_status(machine: Machine, timeout: int) -> list[dict[str, object]]:
    """Read individual node CPU/GPU allocation from detailed ``scontrol``.

    ``Gres`` and ``GresUsed`` are preferred when populated. ``CfgTRES`` and
    ``AllocTRES`` are authoritative fallbacks for sites that publish MI300A
    APU scheduling resources only in their TRES inventory.
    Slurm schedules each MI300A APU as one ``gres/gpu`` resource, so reporting
    it as a GPU here matches the resource users request with ``--gres=gpu``.
    """
    return parse_node_status(run_remote(machine, timeout, SCONTROL_NODES_COMMAND))


def parse_node_status(output: str) -> list[dict[str, object]]:
    """Parse ``scontrol show node --oneliner -d`` output; see :func:`collect_node_status`."""
    nodes: list[dict[str, object]] = []
    for line in output.splitlines():
        fields = dict(token.split("=", 1) for token in line.split() if "=" in token)
        name = fields.get("NodeName")
        if not name:
            continue
        cpu_total = int(fields.get("CPUTot", "0"))
        cpu_allocated = min(int(fields.get("CPUAlloc", "0")), cpu_total)
        configured_gpus = _gpu_resource_text(fields, "Gres", "CfgTRES")
        allocated_gpus = _gpu_resource_text(fields, "GresUsed", "AllocTRES")
        gpu_total = gpu_count(configured_gpus)
        gpu_allocated = min(gpu_count(allocated_gpus), gpu_total)
        nodes.append(
            {
                "name": name,
                "partitions": fields.get("Partitions", ""),
                "state": fields.get("State", "unknown"),
                "cpu": {"allocated": cpu_allocated, "idle": cpu_total - cpu_allocated, "total": cpu_total},
                "gpu": {"allocated": gpu_allocated, "idle": gpu_total - gpu_allocated, "total": gpu_total, "types": gpu_types(configured_gpus)},
            }
        )
    return nodes


def accounting_gate_command(machine: Machine, previous_fingerprint: str | None, force: bool) -> str:
    """Return a remote command that queries ``sacct`` only when the queue changed.

    The fingerprint is a ``cksum`` of the user's sorted ``squeue`` job IDs and
    states, computed on the cluster so that the decision costs no extra SSH
    round trip. Elapsed and remaining times are excluded, so a job that is just
    running longer is not a change. Output: a ``fingerprint <value>`` line,
    then either ``unchanged`` or the ``sacct`` records. The query also runs when
    ``force`` is true or no previous fingerprint is known.
    """
    since = datetime.now(timezone.utc) - ACCOUNTING_LOOKBACK
    previous = shlex.quote(previous_fingerprint or "")
    return (
        f"queue=$({SQUEUE_USER_FINGERPRINT_COMMAND}) || exit 1; "
        "fp=$(printf '%s\\n' \"$queue\" | sort | cksum); "
        "printf 'fingerprint %s\\n' \"$fp\"; "
        f"if [ {int(force)} = 0 ] && [ \"$fp\" = {previous} ]; then echo unchanged; exit 0; fi; "
        f"{accounting_jobs_command(since, (), machine.username)}"
    )


def _accounting_from_section(
    section: Section, previous: AccountingSnapshot | None,
) -> tuple[str | None, AccountingSnapshot | None]:
    """Return the queue fingerprint and the (possibly reused) accounting records."""
    if section.returncode:
        return None, None
    first, _, rest = section.stdout.partition("\n")
    if not first.startswith("fingerprint "):
        return None, None
    fingerprint = first.removeprefix("fingerprint ").strip()
    if rest.strip() == "unchanged" and previous is not None:
        return fingerprint, previous
    now = datetime.now(timezone.utc)
    return fingerprint, AccountingSnapshot(
        records=parse_accounting_jobs(rest),
        fingerprint=fingerprint,
        since=(now - ACCOUNTING_LOOKBACK).isoformat(),
        fetched_at=now.isoformat(),
        fetched_monotonic=time.monotonic(),
    )


def collect_status(
    machine: Machine,
    timeout: int,
    include_jobs: bool,
    include_personal_details: bool = True,
    *,
    previous: ClusterStatus | None = None,
    refresh_capacity: bool = True,
    include_accounting: bool = False,
) -> ClusterStatus:
    """Collect one cluster's status with a single SSH call.

    Capacity data (``sinfo``, node detail, everyone's running-job end times,
    and the optional queue summary) changes slowly and is large on big
    clusters, so with ``refresh_capacity=False`` it is copied from
    ``previous`` and only the user's own jobs are queried. With
    ``include_accounting``, recent ``sacct`` records are fetched in the same
    call when the user's queue fingerprint changed (see
    :func:`accounting_gate_command`) and reused from ``previous`` otherwise.
    """
    status = ClusterStatus(machine.name, machine.host, machine.username)
    capacity = refresh_capacity or previous is None or previous.capacity_updated_at is None
    commands: dict[str, str] = {}
    if capacity:
        commands["sinfo"] = SINFO_COMMAND
        commands["nodes"] = SCONTROL_NODES_COMMAND
    if include_personal_details:
        commands["running"] = SQUEUE_USER_RUNNING_COMMAND
        commands["pending"] = SQUEUE_USER_PENDING_COMMAND
        if capacity:
            commands["releases"] = SQUEUE_RUNNING_END_COMMAND
    if include_jobs and capacity:
        commands["queue"] = SQUEUE_COMMAND
    previous_accounting = previous.accounting if previous else None
    if include_accounting:
        force = previous_accounting is None or (
            time.monotonic() - previous_accounting.fetched_monotonic >= ACCOUNTING_REFRESH_SECONDS
        )
        commands["accounting"] = accounting_gate_command(
            machine, previous_accounting.fingerprint if previous_accounting else None, force,
        )
    try:
        sections = run_batch(machine, timeout, commands)
        if capacity:
            status.partitions = []
            for line in sections["sinfo"].output().splitlines():
                fields = line.strip().split("|")
                if len(fields) == 5:
                    partition, available, nodes, cpus, state = fields
                    status.partitions.append({"partition": partition.rstrip("*"), "available": available, "nodes": nodes, "cpus": cpus, "state": state})
            status.capacity_updated_at = datetime.now(timezone.utc).isoformat()
        else:
            assert previous is not None
            status.partitions = deepcopy(previous.partitions)
            status.nodes = deepcopy(previous.nodes)
            status.partition_compute = deepcopy(previous.partition_compute)
            status.jobs = deepcopy(previous.jobs)
            status.resource_error = previous.resource_error
            status.capacity_updated_at = previous.capacity_updated_at
        try:
            if capacity:
                status.nodes = parse_node_status(sections["nodes"].output())
            if include_personal_details:
                running_jobs = parse_jobs(sections["running"].output())
                pending_jobs = parse_jobs(sections["pending"].output())
                usage = user_node_usage(running_jobs)
                releases = node_release_estimates(sections["releases"].output()) if capacity else None
                for node in status.nodes or []:
                    node["my_usage"] = usage.get(str(node["name"]), {"cpus": 0, "gpus": 0})
                    if releases is not None:
                        node["next_release"] = releases.get(str(node["name"]))
                status.user_jobs = [*running_jobs, *pending_jobs]
            else:
                status.user_jobs = []
            if capacity:
                status.partition_compute = rank_partitions(machine.name, status.nodes)
        except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
            # Preserve the basic sinfo partition data when detailed collection fails.
            status.nodes = []
            status.partition_compute = []
            status.user_jobs = []
            status.resource_error = str(exc)
        if include_jobs and capacity:
            job_output = sections["queue"].output()
            status.jobs = dict(sorted(Counter(line.strip() for line in job_output.splitlines() if line.strip()).items()))
        if include_accounting:
            status.user_jobs_fingerprint, status.accounting = _accounting_from_section(
                sections["accounting"], previous_accounting,
            )
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        status.error = str(exc)
    return status


def collect_user_job_status(machine: Machine, timeout: int) -> ClusterStatus:
    """Collect only the user's active jobs for the terminal jobs board."""
    status = ClusterStatus(machine.name, machine.host, machine.username)
    try:
        status.user_jobs = parse_jobs(run_remote(machine, timeout, SQUEUE_USER_JOBS_COMMAND))
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        status.user_jobs = []
        status.error = str(exc)
    return status


def print_status(status: ClusterStatus, include_jobs: bool) -> None:
    print(f"\n{status.name} ({status.username}@{status.host})")
    if status.error:
        print(f"  ERROR: {status.error}")
    elif not status.partitions:
        print("  No partitions returned by sinfo.")
    else:
        print("  PARTITION                 AVAIL  NODES  CPUS                 STATE")
        for partition in status.partitions:
            print(f"  {partition['partition']:<25} {partition['available']:<5} {partition['nodes']:>5}  {partition['cpus']:<20} {partition['state']}")
    if include_jobs and not status.error:
        summary = ", ".join(f"{state}={count}" for state, count in (status.jobs or {}).items()) or "none"
        print(f"  Jobs: {summary}")
