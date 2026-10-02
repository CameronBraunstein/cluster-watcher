"""Low-frequency Slurm scheduling probes for representative GPU job shapes."""

from __future__ import annotations

import re
import subprocess
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from math import ceil
from typing import Any, Callable

from .models import Machine
from .ssh import run_remote_combined


WAIT_PROBE_REFRESH_SECONDS = 600
"""Minimum interval between scheduling probes, to avoid controller load."""

WAIT_PROBE_WALLTIME_MINUTES = (60, 720, 1440)
"""Representative walltimes displayed for every probed GPU request."""

WAIT_PROBE_MEMORY_MB_PER_GPU = 1024
"""Minimal host-memory allocation per GPU used to isolate GPU pressure."""

_START_TIME = re.compile(r"\bto start at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\b", re.IGNORECASE)


def powers_of_two_through(limit: int) -> tuple[int, ...]:
    """Return positive powers of two no larger than a node's GPU capacity."""
    values: list[int] = []
    value = 1
    while value <= limit:
        values.append(value)
        value *= 2
    return tuple(values)


def partition_gpu_limits(nodes: list[dict[str, object]]) -> dict[str, int]:
    """Return the largest per-node GPU count available in each partition."""
    limits: dict[str, int] = defaultdict(int)
    for node in nodes:
        gpu = node.get("gpu")
        total = int(gpu.get("total", 0)) if isinstance(gpu, dict) else 0
        if total < 1:
            continue
        for partition in str(node.get("partitions", "")).split(","):
            name = partition.rstrip("*")
            if name and name != "(null)":
                limits[name] = max(limits[name], total)
    return dict(limits)


def partition_gpu_topology(nodes: list[dict[str, object]]) -> dict[str, dict[str, Any]]:
    """Return total, maximum, and individual node GPU capacities by partition."""
    topology: dict[str, dict[str, Any]] = {}
    for node in nodes:
        gpu = node.get("gpu")
        total = int(gpu.get("total", 0)) if isinstance(gpu, dict) else 0
        if total < 1:
            continue
        for partition in str(node.get("partitions", "")).split(","):
            name = partition.rstrip("*")
            if not name or name == "(null)":
                continue
            capacity = topology.setdefault(
                name, {"total": 0, "max_per_node": 0, "node_capacities": []},
            )
            capacity["total"] += total
            capacity["max_per_node"] = max(capacity["max_per_node"], total)
            capacity["node_capacities"].append(total)
    for capacity in topology.values():
        capacity["node_capacities"].sort(reverse=True)
    return topology


def required_nodes_for_gpus(node_capacities: list[int], requested_gpus: int) -> int:
    """Return the fewest highest-capacity nodes that can supply a GPU total."""
    accumulated = 0
    for count, capacity in enumerate(sorted(node_capacities, reverse=True), start=1):
        accumulated += capacity
        if accumulated >= requested_gpus:
            return count
    raise ValueError(f"partition has fewer than {requested_gpus} GPUs")


def test_only_command(
    partition: str,
    gpus: int,
    walltime_minutes: int,
    nodes: int = 1,
    *,
    use_gres: bool = True,
) -> str:
    """Build a non-submitting batch request for one representative job shape.

    ``sbatch`` is intentional: some sites impose short walltime limits on every
    ``srun`` allocation because they classify it as interactive, including
    requests made with ``--test-only``. GRES is the broadly compatible primary
    form and requests enough GPUs per node to meet or exceed the job-wide total.
    ``--gpus`` is available for sites whose filters require the exact job-wide
    count. An explicit per-node ``--mem`` satisfies shared-node site policies.
    """
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", partition):
        raise ValueError(f"unsafe partition name for Slurm probe: {partition!r}")
    if nodes < 1 or gpus < 1 or walltime_minutes < 1:
        raise ValueError("wait probes require at least one node, GPU, and runtime minute")
    gpus_per_node = ceil(gpus / nodes)
    gpu_argument = f"--gres=gpu:{gpus_per_node}" if use_gres else f"--gpus={gpus}"
    memory_per_node_mb = gpus_per_node * WAIT_PROBE_MEMORY_MB_PER_GPU
    hours, minutes = divmod(walltime_minutes, 60)
    slurm_time = f"{hours:02d}:{minutes:02d}:00"
    return (
        f"sbatch --test-only --partition={partition} --nodes={nodes} --ntasks=1 "
        f"{gpu_argument} --mem={memory_per_node_mb}M "
        f"--time={slurm_time} --wrap=/bin/true"
    )


def _requires_gres(error: str) -> bool:
    """Return whether a site rejected ``--gpus`` and requested GRES syntax."""
    message = error.casefold()
    return "--gpus" in message and (
        "--gres" in message
        or "unrecognized option" in message
        or "unknown option" in message
    )


def _requires_job_wide_gpus(error: str) -> bool:
    """Return whether a site rejected GRES as a valid GPU request."""
    message = error.casefold()
    return (
        "no gpus were requested" in message
        or "invalid generic resource (gres) specification" in message
        or "invalid gres specification" in message
    )


def _larger_gpu_request_may_succeed(error: str) -> bool:
    """Identify lower-bound policy errors that should not suppress larger probes."""
    message = error.casefold()
    return "qosmingres" in message or "minimum gres" in message


def parse_test_only_start(output: str) -> str | None:
    """Extract Slurm's ISO expected-start timestamp from test-only output."""
    match = _START_TIME.search(output)
    return match.group(1) if match else None


def _collect_partition_wait_estimates(
    machine: Machine,
    partition: str,
    capacity: dict[str, Any],
    timeout: int,
    walltime_minutes: tuple[int, ...],
    maximum_gpus: int | None,
    probe_timeout_seconds: float | None,
    time_budget_seconds: float | None,
    stop_on_error: bool,
    monotonic: Callable[[], float],
) -> list[dict[str, Any]]:
    """Collect one partition sequentially within its independent deadline."""
    deadline = None if time_budget_seconds is None else monotonic() + max(0, time_budget_seconds)
    per_node = capacity["max_per_node"]
    limit = per_node if maximum_gpus is None else min(capacity["total"], maximum_gpus)
    rows: list[dict[str, Any]] = []
    partition_error: str | None = None
    shape_errors: dict[int, str] = {}
    use_gres = True

    for gpus in powers_of_two_through(limit):
        required_nodes = required_nodes_for_gpus(capacity["node_capacities"], gpus)
        for requested_minutes in walltime_minutes:
            error = partition_error or shape_errors.get(requested_minutes)
            start_time = None
            if error is None and deadline is not None and monotonic() >= deadline:
                partition_error = error = "wait-probe time budget exhausted"
            if error is None:
                process_timeout: float | None = None
                partition_budget_limited = False

                def run_probe(use_gres: bool) -> str:
                    """Run one syntax variant within this partition's budget."""
                    nonlocal process_timeout, partition_budget_limited
                    process_timeout = probe_timeout_seconds
                    partition_budget_limited = False
                    if deadline is not None:
                        remaining = max(0.05, deadline - monotonic())
                        partition_budget_limited = process_timeout is None or remaining < process_timeout
                        process_timeout = remaining if process_timeout is None else min(process_timeout, remaining)
                    command = test_only_command(
                        partition, gpus, requested_minutes, required_nodes,
                        use_gres=use_gres,
                    )
                    if process_timeout is None:
                        return run_remote_combined(machine, timeout, command)
                    return run_remote_combined(
                        machine, timeout, command,
                        process_timeout=max(0.05, process_timeout),
                    )

                try:
                    try:
                        output = run_probe(use_gres)
                    except RuntimeError as exc:
                        if use_gres and _requires_job_wide_gpus(str(exc)):
                            use_gres = False
                        elif not use_gres and _requires_gres(str(exc)):
                            use_gres = True
                        else:
                            raise
                        output = run_probe(use_gres)
                    start_time = parse_test_only_start(output)
                    error = None if start_time else "Slurm did not provide an expected start time"
                except subprocess.TimeoutExpired:
                    if partition_budget_limited and time_budget_seconds is not None:
                        error = f"partition wait-probe budget exhausted after {time_budget_seconds:g} seconds"
                    else:
                        elapsed_limit = process_timeout if process_timeout is not None else timeout + 5
                        error = f"Slurm probe timed out after {elapsed_limit:g} seconds"
                except (OSError, RuntimeError) as exc:
                    error = str(exc)
                if error:
                    if not _larger_gpu_request_may_succeed(error):
                        shape_errors[requested_minutes] = error
                        if stop_on_error and partition_error is None:
                            partition_error = error
            rows.append({
                "gpus": gpus,
                "nodes": required_nodes,
                "memory_mb": gpus * WAIT_PROBE_MEMORY_MB_PER_GPU,
                "walltime_minutes": requested_minutes,
                "walltime_hours": requested_minutes / 60,
                "start_time": start_time,
                "error": error,
            })
    return rows


def collect_wait_estimates(
    machine: Machine,
    nodes: list[dict[str, object]],
    timeout: int,
    walltime_minutes: tuple[int, ...] = WAIT_PROBE_WALLTIME_MINUTES,
    maximum_gpus: int | None = None,
    probe_timeout_seconds: float | None = None,
    time_budget_seconds: float | None = None,
    stop_on_error: bool = False,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, list[dict[str, Any]]]:
    """Probe each partition's 1/2/4/... GPU requests without submitting jobs.

    The default dashboard requests one, 12, and 24 hour shapes, each capped by
    the configured maximum for its partition. Callers may request a larger
    job-wide GPU ceiling; the minimum required node count is derived from that
    partition's per-node inventory. GRES is tried first;
    partitions that reject it are retried with job-wide ``--gpus=N``. The
    successful syntax is then reused only within that partition.
    A failed shape is retained and propagated to larger GPU counts with the
    same walltime instead of issuing requests that cannot succeed. Partitions
    run concurrently, while shapes within one partition remain sequential so
    each partition has an independent ``time_budget_seconds`` deadline.
    """
    partitions = sorted(partition_gpu_topology(nodes).items())
    if not partitions:
        return {}
    with ThreadPoolExecutor(
        max_workers=len(partitions),
        thread_name_prefix="cluster-watcher-wait",
    ) as executor:
        futures = {
            partition: executor.submit(
                _collect_partition_wait_estimates,
                machine,
                partition,
                capacity,
                timeout,
                tuple(dict.fromkeys(
                    min(minutes, machine.max_time_minutes(partition))
                    for minutes in walltime_minutes
                )),
                maximum_gpus,
                probe_timeout_seconds,
                time_budget_seconds,
                stop_on_error,
                monotonic,
            )
            for partition, capacity in partitions
        }
        return {partition: futures[partition].result() for partition, _ in partitions}
