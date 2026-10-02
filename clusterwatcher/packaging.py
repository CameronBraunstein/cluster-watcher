"""Naming helpers for standalone Cluster Watcher distributions."""

from __future__ import annotations

import platform
import re


_ARCHITECTURE_ALIASES = {
    "amd64": "x86_64",
    "x64": "x86_64",
    "arm64": "aarch64",
}


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
    system_name = _safe_component(system if system is not None else platform.system())
    machine_name = _safe_component(machine if machine is not None else platform.machine())
    architecture = _ARCHITECTURE_ALIASES.get(machine_name, machine_name)
    return f"cluster-watcher-{system_name}-{architecture}"
