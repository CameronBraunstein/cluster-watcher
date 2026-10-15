"""GPU profile matching and deterministic partition compute ranking."""

from __future__ import annotations

import math
import re
import tomllib
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class GPUProfile:
    """Hardware characteristics used to rank one cluster's GPU partitions."""

    cluster: str
    name: str
    aliases: tuple[str, ...]
    vram_gb: int
    fp16_bf16_tensor_tflops: float


def _normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


_config_path: Path | None = None


def configure_gpu_profiles(path: Path | None) -> None:
    """Select the ``clusters.toml`` file supplying GPU profiles and reload it."""
    global _config_path
    _config_path = path
    gpu_profiles.cache_clear()


@cache
def gpu_profiles() -> tuple[GPUProfile, ...]:
    """Load optional cluster-scoped GPU hardware profiles from ``clusters.toml``.

    Without ``[[profile]]`` entries, no model, VRAM, or throughput is reported
    and partitions rank by GPU count alone.
    """
    if _config_path is None:
        return ()
    try:
        with _config_path.open("rb") as file:
            data = tomllib.load(file)
    except FileNotFoundError as exc:
        raise ValueError(f"configuration file not found: {_config_path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"invalid TOML in {_config_path}: {exc}") from exc
    return parse_gpu_profiles(data, _config_path)


def parse_gpu_profiles(
    data: dict[str, object], path: Path, known_clusters: set[str] | None = None,
) -> tuple[GPUProfile, ...]:
    """Validate and parse ``[[profile]]`` entries in one TOML document.

    ``known_clusters`` is supplied when validating the full configuration, so
    a mistyped cluster name cannot silently hide a GPU profile.
    """
    raw_profiles = data.get("profile", [])
    if not isinstance(raw_profiles, list):
        raise ValueError(f"[[profile]] in {path} must be an array of tables")
    profiles = []
    for index, item in enumerate(raw_profiles, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"GPU profile #{index} in {path} must be a table")
        cluster = item.get("cluster")
        name = item.get("name")
        aliases = item.get("aliases")
        vram = item.get("vram_gb")
        throughput = item.get("fp16_bf16_tensor_tflops")
        try:
            throughput_value = float(throughput) if isinstance(throughput, (int, float)) else 0.0
        except OverflowError:
            throughput_value = 0.0
        if (
            not isinstance(cluster, str) or not cluster.strip()
            or not isinstance(name, str) or not name.strip()
            or not isinstance(aliases, list) or not aliases
            or any(not isinstance(alias, str) or not alias.strip() for alias in aliases)
            or not isinstance(vram, int) or isinstance(vram, bool) or vram < 1
            or isinstance(throughput, bool) or not math.isfinite(throughput_value)
            or throughput_value <= 0
        ):
            raise ValueError(f"GPU profile #{index} in {path} is incomplete or invalid")
        if known_clusters is not None and cluster not in known_clusters:
            raise ValueError(f"GPU profile #{index} in {path} refers to unknown cluster {cluster!r}")
        profiles.append(GPUProfile(cluster, name, tuple(aliases), vram, throughput_value))
    return tuple(profiles)


def profile_for(cluster: str, labels: list[str]) -> GPUProfile | None:
    """Return the profile matching ``labels`` in the named cluster only.

    The cluster boundary is deliberate: Slurm partition and GRES labels are
    local names, so matching them across dashboard machines can misidentify
    otherwise identical labels.
    """
    candidates = [_normalized(label) for label in labels]
    aliases = sorted(
        ((alias, profile) for profile in gpu_profiles() if profile.cluster == cluster for alias in profile.aliases),
        key=lambda item: len(_normalized(item[0])), reverse=True,
    )
    for alias, profile in aliases:
        normalized_alias = _normalized(alias)
        if any(normalized_alias in candidate for candidate in candidates):
            return profile
    return None


def rank_partitions(cluster: str, nodes: list[dict[str, object]]) -> list[dict[str, Any]]:
    """Rank by the best single GPU's VRAM, Tensor throughput, then CPU threads.

    An ``*-all`` partition whose nodes are all also present in another
    partition is marked as an aggregate. Aggregates are returned after ranked
    specific partitions and intentionally receive no numeric rank.
    """
    summaries: dict[str, dict[str, Any]] = {}
    for node in nodes:
        gpu = node.get("gpu", {})
        gpu_types = gpu.get("types", {}) if isinstance(gpu, dict) else {}
        partitions = [partition.rstrip("*") for partition in str(node.get("partitions", "")).split(",") if partition and partition != "(null)"]
        labels = [str(node.get("name", "")), *(str(gpu_type) for gpu_type in gpu_types), *partitions]
        fallback_profile = profile_for(cluster, labels)
        for name in partitions:
            summary = summaries.setdefault(name, {"name": name, "cpu_threads": 0, "node_names": set(), "profiles": {}})
            summary["node_names"].add(str(node.get("name", id(node))))
            cpu = node.get("cpu", {})
            summary["cpu_threads"] += int(cpu.get("total", 0)) if isinstance(cpu, dict) else 0
            typed_count = 0
            for gpu_type, count in gpu_types.items():
                profile = profile_for(cluster, [str(gpu_type)]) or fallback_profile
                if profile:
                    count = int(count)
                    typed_count += count
                    summary["profiles"][profile.name] = {"profile": profile, "count": summary["profiles"].get(profile.name, {}).get("count", 0) + count}
            total_gpus = int(gpu.get("total", 0)) if isinstance(gpu, dict) else 0
            if total_gpus > typed_count:
                profile = profile_for(cluster, [str(node.get("name", "")), name])
                if profile:
                    count = total_gpus - typed_count
                    summary["profiles"][profile.name] = {"profile": profile, "count": summary["profiles"].get(profile.name, {}).get("count", 0) + count}

    for summary in summaries.values():
        profiles = list(summary["profiles"].values())
        best = max(profiles, key=lambda item: (item["profile"].vram_gb, item["profile"].fp16_bf16_tensor_tflops), default=None)
        summary["best_gpu"] = None if best is None else {"name": best["profile"].name, "vram_gb": best["profile"].vram_gb, "tensor_tflops": best["profile"].fp16_bf16_tensor_tflops}
        tokens = re.split(r"[-_]", summary["name"].lower())
        other_nodes = set().union(*(other["node_names"] for other in summaries.values() if other is not summary))
        summary["aggregate"] = "all" in tokens and bool(summary["node_names"]) and summary["node_names"] <= other_nodes

    specifics = [item for item in summaries.values() if not item["aggregate"]]
    specifics.sort(key=lambda item: (-(item["best_gpu"] or {"vram_gb": 0})["vram_gb"], -(item["best_gpu"] or {"tensor_tflops": 0})["tensor_tflops"], -item["cpu_threads"], item["name"]))
    aggregates = sorted((item for item in summaries.values() if item["aggregate"]), key=lambda item: item["name"])
    for rank, summary in enumerate(specifics, start=1):
        summary["rank"] = rank
    for summary in aggregates:
        summary["rank"] = None
    for summary in [*specifics, *aggregates]:
        del summary["node_names"]
        del summary["profiles"]
    return [*specifics, *aggregates]
