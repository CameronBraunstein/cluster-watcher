"""GPU profile matching and deterministic partition compute ranking."""

from __future__ import annotations

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


GPU_PROFILES_FILENAME = "gpu_profiles.toml"
_profiles_path: Path | None = None


def gpu_profiles_path(config_path: Path) -> Path:
    """Return the personal GPU catalog location: beside ``clusters.toml``."""
    return config_path.expanduser().with_name(GPU_PROFILES_FILENAME)


def configure_gpu_profiles(path: Path | None) -> None:
    """Select the GPU catalog file (``None`` disables profiles) and reload it."""
    global _profiles_path
    _profiles_path = path
    gpu_profiles.cache_clear()


@cache
def gpu_profiles() -> tuple[GPUProfile, ...]:
    """Load the personal, cluster-scoped GPU hardware catalog.

    The catalog is optional site knowledge kept beside ``clusters.toml`` (see
    ``gpu_profiles.example.toml``). Without it no GPU model, VRAM, or
    throughput is reported and partitions rank by GPU count alone.
    """
    if _profiles_path is None or not _profiles_path.is_file():
        return ()
    try:
        with _profiles_path.open("rb") as file:
            data = tomllib.load(file)
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"invalid TOML in {_profiles_path}: {exc}") from exc
    profiles = []
    for index, item in enumerate(data.get("profile", []), start=1):
        try:
            profiles.append(GPUProfile(
                str(item["cluster"]), str(item["name"]), tuple(str(alias) for alias in item["aliases"]),
                int(item["vram_gb"]), float(item["fp16_bf16_tensor_tflops"]),
            ))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"GPU profile #{index} in {_profiles_path} is incomplete or invalid: {exc}") from exc
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
