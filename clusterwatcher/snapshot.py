"""Stable, versioned JSON snapshots for automated cluster selection."""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any

from .compute import GPUProfile, profile_for
from .models import ClusterStatus
from .wait_probes import WAIT_PROBE_REFRESH_SECONDS, classify_wait_error


SNAPSHOT_SCHEMA_VERSION = "1.0"
"""Current public snapshot schema; incompatible changes require a new API version."""


def _partitions(node: dict[str, object]) -> list[str]:
    """Return normalized partition names assigned to a Slurm node."""
    return [
        name.rstrip("*")
        for name in str(node.get("partitions", "")).split(",")
        if name and name != "(null)"
    ]


def _resource(resource: object) -> dict[str, int]:
    """Normalize an internal CPU/GPU resource mapping to integer counters."""
    if not isinstance(resource, dict):
        return {"total": 0, "allocated": 0, "idle": 0}
    return {
        "total": int(resource.get("total", 0)),
        "allocated": int(resource.get("allocated", 0)),
        "idle": int(resource.get("idle", 0)),
    }


def _node_is_schedulable(state: object) -> bool:
    """Return whether Slurm's node state permits new work in principle."""
    value = str(state).lower()
    unavailable_markers = ("drain", "down", "fail", "maint", "reboot", "power", "reserved", "no_resp")
    return value.startswith(("idle", "mixed")) and not any(marker in value for marker in unavailable_markers)


def _profile_dict(profile: GPUProfile | None) -> dict[str, object]:
    """Serialize catalogued GPU specifications without internal match aliases."""
    return {
        "catalogued": profile is not None,
        "name": profile.name if profile else None,
        "vram_gb": profile.vram_gb if profile else None,
        "fp16_bf16_tensor_tflops": profile.fp16_bf16_tensor_tflops if profile else None,
    }


def _node_gpu_types(cluster: str, partition: str, node: dict[str, object]) -> list[dict[str, object]]:
    """Resolve a node's Slurm GPU types to cluster-scoped hardware profiles."""
    gpu = node.get("gpu")
    resource = _resource(gpu)
    raw_types = gpu.get("types", {}) if isinstance(gpu, dict) else {}
    raw_types = raw_types if isinstance(raw_types, dict) else {}
    fallback = profile_for(cluster, [str(node.get("name", "")), partition, *(str(value) for value in raw_types)])
    records: list[dict[str, object]] = []
    for raw_type, count in raw_types.items():
        profile = profile_for(cluster, [str(raw_type)]) or fallback
        records.append({"slurm_type": str(raw_type), "count": int(count), **_profile_dict(profile)})
    typed_total = sum(int(record["count"]) for record in records)
    if resource["total"] > typed_total:
        profile = profile_for(cluster, [str(node.get("name", "")), partition]) or fallback
        records.append({"slurm_type": "generic", "count": resource["total"] - typed_total, **_profile_dict(profile)})
    return records


def _wait_seconds(start_time: object, generated_at: str | None) -> int | None:
    """Convert a Slurm start timestamp into a non-negative wait duration."""
    if not isinstance(start_time, str) or not generated_at:
        return None
    try:
        start = datetime.fromisoformat(start_time)
        generated = datetime.fromisoformat(generated_at)
    except ValueError:
        return None
    if start.tzinfo is None:
        generated = generated.astimezone().replace(tzinfo=None) if generated.tzinfo else generated
    elif generated.tzinfo is None:
        generated = generated.astimezone(start.tzinfo)
    else:
        generated = generated.astimezone(start.tzinfo)
    return max(0, round((start - generated).total_seconds()))


def _wait_estimates(status: ClusterStatus, partition: str, generated_at: str | None) -> list[dict[str, object]]:
    """Normalize hypothetical job probes for one partition."""
    raw_estimates = (status.wait_estimates or {}).get(partition, [])
    return [
        {
            "gpus": int(estimate.get("gpus", 0)),
            "nodes": int(estimate.get("nodes", 1)),
            "memory_mb": int(estimate.get("memory_mb", 0)),
            "walltime_seconds": int(
                estimate.get(
                    "walltime_minutes",
                    float(estimate.get("walltime_hours", 0)) * 60,
                )
            ) * 60,
            "expected_start_at": estimate.get("start_time"),
            "estimated_wait_seconds": _wait_seconds(estimate.get("start_time"), generated_at),
            "error": estimate.get("error"),
            # Additive: denied | minimum | limit | unavailable | timeout | budget | error.
            "error_kind": estimate.get("error_kind") or classify_wait_error(estimate.get("error")),
        }
        for estimate in raw_estimates
    ]


def _model_summaries(cluster: str, partition: str, nodes: list[dict[str, object]], partition_available: bool | None) -> list[dict[str, object]]:
    """Aggregate GPU inventory and availability by resolved hardware model."""
    models: dict[tuple[object, ...], dict[str, Any]] = {}
    for node in nodes:
        types = _node_gpu_types(cluster, partition, node)
        gpu = _resource(node.get("gpu"))
        schedulable = _node_is_schedulable(node.get("state")) and partition_available is not False
        availability_known = len(types) == 1 or gpu["allocated"] == 0 or gpu["idle"] == 0
        for gpu_type in types:
            key = (
                gpu_type["name"] or gpu_type["slurm_type"],
                gpu_type["vram_gb"],
                gpu_type["fp16_bf16_tensor_tflops"],
            )
            model = models.setdefault(
                key,
                {
                    "name": gpu_type["name"] or gpu_type["slurm_type"],
                    "slurm_types": set(),
                    "catalogued": gpu_type["catalogued"],
                    "vram_gb": gpu_type["vram_gb"],
                    "fp16_bf16_tensor_tflops": gpu_type["fp16_bf16_tensor_tflops"],
                    "gpus": {"total": 0, "allocated": 0, "idle": 0, "schedulable_idle": 0},
                    "availability_known": True,
                },
            )
            count = int(gpu_type["count"])
            model["slurm_types"].add(gpu_type["slurm_type"])
            model["gpus"]["total"] += count
            if not availability_known:
                model["availability_known"] = False
            elif len(types) == 1:
                model["gpus"]["allocated"] += gpu["allocated"]
                model["gpus"]["idle"] += gpu["idle"]
                model["gpus"]["schedulable_idle"] += gpu["idle"] if schedulable else 0
            elif gpu["allocated"] == 0:
                model["gpus"]["idle"] += count
                model["gpus"]["schedulable_idle"] += count if schedulable else 0
            else:
                model["gpus"]["allocated"] += count

    result: list[dict[str, object]] = []
    for model in models.values():
        model["slurm_types"] = sorted(model["slurm_types"])
        if not model.pop("availability_known"):
            model["gpus"]["allocated"] = None
            model["gpus"]["idle"] = None
            model["gpus"]["schedulable_idle"] = None
        result.append(model)
    return sorted(result, key=lambda item: (-(item["vram_gb"] or 0), str(item["name"])))


def _node_snapshot(cluster: str, partition: str, node: dict[str, object], partition_available: bool | None) -> dict[str, object]:
    """Serialize one node with current resources and resolved GPU specifications."""
    cpu = _resource(node.get("cpu"))
    gpu = _resource(node.get("gpu"))
    schedulable = _node_is_schedulable(node.get("state")) and partition_available is not False
    schedulable_idle = gpu["idle"] if schedulable else 0
    return {
        "name": str(node.get("name", "")),
        "state": str(node.get("state", "unknown")),
        "cpus": cpu,
        "gpus": {
            **gpu,
            "schedulable_idle": schedulable_idle,
            "unavailable_idle": max(0, gpu["idle"] - schedulable_idle),
            "types": _node_gpu_types(cluster, partition, node),
        },
        "next_resource_release_at": node.get("next_release"),
    }


def _partition_snapshot(status: ClusterStatus, name: str, generated_at: str | None) -> dict[str, object]:
    """Build a complete routing snapshot for one Slurm partition."""
    nodes = [node for node in (status.nodes or []) if name in _partitions(node)]
    compute = next((item for item in (status.partition_compute or []) if item.get("name") == name), {})
    slurm_rows = [row for row in (status.partitions or []) if row.get("partition") == name]
    availability_values = [str(row.get("available", "")).lower() for row in slurm_rows if row.get("available")]
    partition_available = any(value == "up" for value in availability_values) if availability_values else None
    node_details = [_node_snapshot(status.name, name, node, partition_available) for node in nodes]
    gpu_total = sum(int(node["gpus"]["total"]) for node in node_details)
    gpu_allocated = sum(int(node["gpus"]["allocated"]) for node in node_details)
    gpu_idle = sum(int(node["gpus"]["idle"]) for node in node_details)
    schedulable_idle = sum(int(node["gpus"]["schedulable_idle"]) for node in node_details)
    priority_row = next(
        (row for row in slurm_rows if row.get("priority_job_factor") is not None),
        {},
    )
    return {
        "name": name,
        "rank": compute.get("rank"),
        "aggregate": bool(compute.get("aggregate", False)),
        "available": partition_available,
        "priority_job_factor": priority_row.get("priority_job_factor"),
        "priority_tier": priority_row.get("priority_tier"),
        "reported_nodes": sum(int(row["nodes"]) for row in slurm_rows if str(row.get("nodes", "")).isdigit()),
        "node_states": dict(sorted(Counter(str(node["state"]) for node in node_details).items())),
        "cpus": {
            key: sum(int(node["cpus"][key]) for node in node_details)
            for key in ("total", "allocated", "idle")
        },
        "gpus": {
            "total": gpu_total,
            "allocated": gpu_allocated,
            "idle": gpu_idle,
            "schedulable_idle": schedulable_idle,
            "unavailable_idle": max(0, gpu_idle - schedulable_idle),
            "max_per_node": max((int(node["gpus"]["total"]) for node in node_details), default=0),
            "models": _model_summaries(status.name, name, nodes, partition_available),
        },
        "wait_estimates": _wait_estimates(status, name, generated_at),
        "nodes": sorted(node_details, key=lambda node: str(node["name"])),
    }


def _partition_names(status: ClusterStatus) -> list[str]:
    """Return every known partition, preserving compute rank where available."""
    ordered: list[str] = []
    for compute in status.partition_compute or []:
        name = str(compute.get("name", ""))
        if name and name not in ordered:
            ordered.append(name)
    remaining = {
        str(row.get("partition", ""))
        for row in status.partitions or []
        if row.get("partition")
    }
    for node in status.nodes or []:
        remaining.update(_partitions(node))
    ordered.extend(sorted(remaining - set(ordered)))
    return ordered


def _cluster_resources(status: ClusterStatus) -> dict[str, object]:
    """Summarize unique cluster nodes without double-counting partitions."""
    nodes = status.nodes or []
    gpu_resources = [_resource(node.get("gpu")) for node in nodes]
    cpu_resources = [_resource(node.get("cpu")) for node in nodes]
    partition_availability = {
        str(row.get("partition")): str(row.get("available", "")).lower() == "up"
        for row in status.partitions or []
        if row.get("partition") and row.get("available")
    }
    schedulable_idle = sum(
        gpu["idle"]
        for node, gpu in zip(nodes, gpu_resources)
        if _node_is_schedulable(node.get("state"))
        and any(partition_availability.get(name, True) for name in _partitions(node))
    )
    return {
        "nodes": len(nodes),
        "cpus": {key: sum(cpu[key] for cpu in cpu_resources) for key in ("total", "allocated", "idle")},
        "gpus": {
            "total": sum(gpu["total"] for gpu in gpu_resources),
            "allocated": sum(gpu["allocated"] for gpu in gpu_resources),
            "idle": sum(gpu["idle"] for gpu in gpu_resources),
            "schedulable_idle": schedulable_idle,
            "unavailable_idle": sum(gpu["idle"] for gpu in gpu_resources) - schedulable_idle,
        },
    }


def build_snapshot(statuses: list[ClusterStatus], generated_at: str | None, refresh_seconds: int) -> dict[str, object]:
    """Build the public API document from an immutable view of cached status."""
    clusters: list[dict[str, object]] = []
    for status in statuses:
        clusters.append(
            {
                "name": status.name,
                "host": status.host,
                "reachable": status.error is None,
                # Additive field: the session needs ``cluster-watcher login NAME``.
                "login_required": status.login_required,
                "resource_data_complete": status.error is None and status.resource_error is None,
                "error": status.error,
                "resource_error": status.resource_error,
                "wait_estimates_updated_at": status.wait_estimates_updated_at,
                "scheduling": status.scheduling or {},
                "resources": _cluster_resources(status),
                "partitions": [
                    _partition_snapshot(status, name, generated_at)
                    for name in _partition_names(status)
                ],
            }
        )
    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "generated_at": generated_at,
        "status_refresh_seconds": refresh_seconds,
        "wait_probe_refresh_seconds": WAIT_PROBE_REFRESH_SECONDS,
        "clusters": clusters,
    }
