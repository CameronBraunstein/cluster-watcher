"""Naming helpers for standalone Cluster Watcher distributions."""

from __future__ import annotations

import platform
import re

from .platforms import normalized_architecture, normalized_system


def _safe_component(value: str) -> str:
    """Return a lowercase filename component containing portable characters."""
    normalized = re.sub(r"[^a-z0-9_.]+", "-", value.strip().lower())
    return normalized.strip("-.") or "unknown"


def standalone_artifact_name(system: str | None = None, machine: str | None = None) -> str:
    """Return the platform-qualified filename for a standalone executable.

    Architecture aliases are normalized to Linux's conventional ``x86_64``
    and ``aarch64`` spellings so builds made by differently configured Python
    runtimes still receive the same public filename.
    """
    system_name = _safe_component(normalized_system(system if system is not None else platform.system()))
    architecture = _safe_component(
        normalized_architecture(machine if machine is not None else platform.machine())
    )
    suffix = ".exe" if system_name == "windows" else ""
    return f"cluster-watcher-{system_name}-{architecture}{suffix}"
