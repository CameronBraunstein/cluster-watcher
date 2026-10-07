"""Low-frequency Slurm scheduling probes for representative GPU job shapes."""

from __future__ import annotations

import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from math import ceil
from typing import Any

from .models import Machine
from .remote_batch import BUDGET_EXHAUSTED, run_batch


WAIT_PROBE_REFRESH_SECONDS = 600
"""Minimum interval between scheduling probes, to avoid controller load."""

WAIT_PROBE_WALLTIME_MINUTES = (60, 720, 1440)
"""Representative walltimes displayed for every probed GPU request."""

WAIT_PROBE_MAX_GPUS = 64
"""Largest job-wide GPU request probed (the status tables' last column)."""

WAIT_PROBE_TIMEOUT_SECONDS = 60.0
"""Longest one ``sbatch --test-only`` may take; busy controllers need tens of seconds."""

WAIT_PROBE_BUDGET_SECONDS = 240.0
"""Time after which a partition's batch starts no further probes."""

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
    # One task per node: with ``--ntasks=1`` Slurm silently shrinks a
    # multi-node request to one node ("can't run 1 processes on 2 nodes").
    return (
        f"sbatch --test-only --partition={partition} --nodes={nodes} --ntasks-per-node=1 "
        f"{gpu_argument} --mem={memory_per_node_mb}M "
        f"--time={slurm_time} --wrap=/bin/true"
    )


def parse_test_only_start(output: str) -> str | None:
    """Extract Slurm's ISO expected-start timestamp from test-only output."""
    match = _START_TIME.search(output)
    return match.group(1) if match else None


# A site's submit filter answers these when it wants the job-wide ``--gpus=N``
# form instead of GRES. "More than N gpus per node" carries the same "invalid
# GRES" suffix but is a per-node policy limit, so it must not trigger a retry.
_JOB_WIDE_GPUS_PATTERN = r"no gpus were requested|invalid (generic resource \(gres\)|gres) specification"
_PER_NODE_LIMIT_PATTERN = r"more than [0-9]+ gpus per node"

WAIT_ERROR_KINDS = ("denied", "minimum", "limit", "unavailable", "timeout", "budget", "error")
"""Classification of a failed probe; see :func:`classify_wait_error`."""


def classify_wait_error(error: str | None) -> str | None:
    """Return why a probe failed, so displays can tell policy from failure.

    ``denied``: the account may not use the partition; ``minimum``: the
    request is below a minimum (larger ones may work); ``limit``: it exceeds a
    QOS, association, per-node, or time limit; ``unavailable``: no node can
    currently run it (for example all are drained); ``timeout``: Slurm did not
    answer in time; ``budget``: not probed because the partition's time budget
    ran out; ``error``: anything else.
    """
    if not error:
        return None
    message = error.casefold()
    if any(text in message for text in ("permission denied", "invalid account")):
        return "denied"
    if "qosmingres" in message or "minimum gres" in message:
        return "minimum"
    if re.search(_PER_NODE_LIMIT_PATTERN, message) or any(text in message for text in (
        "qosmax", "qosgrp", "assocmax", "assocgrp", "accounting/qos policy",
        "time limit is invalid", "exceeds",
    )):
        return "limit"
    if "node configuration is not available" in message or "node count specification invalid" in message:
        return "unavailable"
    if "budget exhausted" in message:
        return "budget"
    if "timed out" in message:
        return "timeout"
    return "error"


def probe_script(partition: str, gpus: int, walltime_minutes: int, nodes: int, timeout_seconds: float) -> str:
    """Return the shell snippet that probes one shape on the cluster.

    GRES is tried first; when the site asks for job-wide GPUs instead, the
    snippet retries with ``--gpus=N`` in the same SSH call. Each ``sbatch``
    is bounded by ``timeout`` (exit status 124) when the cluster has it.
    Output is printed whatever the outcome; the exit status is ``sbatch``'s.
    """
    gres = test_only_command(partition, gpus, walltime_minutes, nodes, use_gres=True)
    job_wide = test_only_command(partition, gpus, walltime_minutes, nodes, use_gres=False)
    return (
        f"t=; command -v timeout >/dev/null 2>&1 && t='timeout {timeout_seconds:g}'; "
        f"o=$($t {gres} 2>&1); r=$?; "
        f"if [ $r -ne 0 ] && printf '%s' \"$o\" | grep -qiE '{_JOB_WIDE_GPUS_PATTERN}' "
        f"&& ! printf '%s' \"$o\" | grep -qiE '{_PER_NODE_LIMIT_PATTERN}'; "
        f"then o=$($t {job_wide} 2>&1); r=$?; fi; "
        "printf '%s\\n' \"$o\"; exit $r"
    )


def probe_shapes(
    capacity: dict[str, Any], walltime_minutes: tuple[int, ...], maximum_gpus: int,
) -> list[tuple[int, int, int]]:
    """Return ``(gpus, nodes, minutes)`` shapes for one partition, in order.

    Requests that fit on one node are probed for every walltime. Larger,
    multi-node requests (up to ``maximum_gpus`` and the partition's total) are
    probed only for the shortest walltime, which the status tables show,
    keeping the number of scheduler queries small.
    """
    per_node = capacity["max_per_node"]
    limit = min(capacity["total"], maximum_gpus)
    shapes: list[tuple[int, int, int]] = []
    for gpus in powers_of_two_through(limit):
        nodes = required_nodes_for_gpus(capacity["node_capacities"], gpus)
        minutes = walltime_minutes if gpus <= per_node else walltime_minutes[:1]
        shapes.extend((gpus, nodes, requested) for requested in minutes)
    return shapes


def _collect_partition_wait_estimates(
    machine: Machine,
    partition: str,
    capacity: dict[str, Any],
    timeout: int,
    walltime_minutes: tuple[int, ...],
    maximum_gpus: int,
    probe_timeout_seconds: float,
    time_budget_seconds: float,
) -> list[dict[str, Any]]:
    """Probe every shape of one partition in a single SSH call.

    The remote batch stops starting probes once ``time_budget_seconds`` have
    passed; shapes it skipped are reported as budget-exhausted.
    """
    shapes = probe_shapes(capacity, walltime_minutes, maximum_gpus)
    commands = {
        f"p{index}": probe_script(partition, gpus, minutes, nodes, probe_timeout_seconds)
        for index, (gpus, nodes, minutes) in enumerate(shapes)
    }
    try:
        sections = run_batch(
            machine, timeout, commands,
            budget_seconds=time_budget_seconds,
            process_timeout=time_budget_seconds + probe_timeout_seconds * 2 + timeout + 10,
        )
        failure = None
    except (OSError, RuntimeError) as exc:
        sections, failure = {}, str(exc)

    rows: list[dict[str, Any]] = []
    for index, (gpus, nodes, minutes) in enumerate(shapes):
        start_time = None
        section = sections.get(f"p{index}")
        if section is None:
            error = failure or "remote batch ended before this probe finished"
        elif section.stderr == BUDGET_EXHAUSTED:
            error = f"partition wait-probe budget exhausted after {time_budget_seconds:g} seconds"
        elif section.returncode == 124:
            error = f"Slurm probe timed out after {probe_timeout_seconds:g} seconds"
        else:
            output = "\n".join(text for text in (section.stdout.strip(), section.stderr.strip()) if text)
            start_time = parse_test_only_start(output)
            error = None if start_time else (output or f"sbatch exited with status {section.returncode}")
        rows.append({
            "gpus": gpus,
            "nodes": nodes,
            "memory_mb": gpus * WAIT_PROBE_MEMORY_MB_PER_GPU,
            "walltime_minutes": minutes,
            "walltime_hours": minutes / 60,
            "start_time": start_time,
            "error": error,
            "error_kind": classify_wait_error(error),
        })
    return rows


def collect_wait_estimates(
    machine: Machine,
    nodes: list[dict[str, object]],
    timeout: int,
    walltime_minutes: tuple[int, ...] = WAIT_PROBE_WALLTIME_MINUTES,
    maximum_gpus: int = WAIT_PROBE_MAX_GPUS,
    probe_timeout_seconds: float = WAIT_PROBE_TIMEOUT_SECONDS,
    time_budget_seconds: float = WAIT_PROBE_BUDGET_SECONDS,
) -> dict[str, list[dict[str, Any]]]:
    """Probe each partition's 1/2/4/... GPU requests without submitting jobs.

    Shapes come from :func:`probe_shapes`: single-node requests for each
    walltime (by default one, 12, and 24 hours, capped by the partition's
    configured maximum) and multi-node requests up to ``maximum_gpus`` for the
    shortest walltime, using the fewest nodes the partition's inventory
    allows. Each partition is probed in one SSH call (see
    :func:`probe_script`), and partitions run concurrently. Failed shapes keep
    Slurm's message and an ``error_kind`` from :func:`classify_wait_error`.
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
            )
            for partition, capacity in partitions
        }
        return {partition: futures[partition].result() for partition, _ in partitions}
