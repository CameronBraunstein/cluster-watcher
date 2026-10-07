"""Small, dependency-free helpers for host-platform differences.

The application deliberately keeps platform policy here so packaging, SSH,
and installer-facing paths do not each invent their own aliases.  Functions
accept optional values where useful so platform behavior can be tested on any
host without mutating global interpreter state.
"""

from __future__ import annotations

import getpass
import hashlib
import os
from pathlib import Path
import platform
import tempfile


_SYSTEM_ALIASES = {
    "darwin": "macos",
    "win32": "windows",
}

_ARCHITECTURE_ALIASES = {
    "amd64": "x86_64",
    "x64": "x86_64",
    "arm64": "aarch64",
}


def normalized_system(value: str | None = None) -> str:
    """Return the stable public OS identifier for ``value`` or this host."""
    raw = (value if value is not None else platform.system()).strip().casefold()
    return _SYSTEM_ALIASES.get(raw, raw)


def normalized_architecture(value: str | None = None) -> str:
    """Return the stable public CPU identifier for ``value`` or this host."""
    raw = (value if value is not None else platform.machine()).strip().casefold()
    return _ARCHITECTURE_ALIASES.get(raw, raw)


def supports_ssh_multiplexing(system: str | None = None) -> bool:
    """Return whether the supported system OpenSSH has ``ControlMaster``.

    Microsoft's native OpenSSH port does not implement the ancillary-data
    transport needed by ControlMaster.  Unix-like targets use upstream
    OpenSSH-compatible control sockets and retain reusable MFA sessions.
    """
    return normalized_system(system) != "windows"


def user_runtime_token() -> str:
    """Return a non-secret, filesystem-safe identifier for the local user."""
    getuid = getattr(os, "getuid", None)
    if getuid is not None:
        return str(getuid())
    username = getpass.getuser().encode("utf-8", errors="replace")
    return hashlib.sha256(username).hexdigest()[:16]


def runtime_directory() -> Path:
    """Return the host's private-runtime base directory.

    Unix follows ``XDG_RUNTIME_DIR`` with the temporary directory as a
    fallback. Windows uses ``LOCALAPPDATA`` when available, keeping runtime
    metadata out of a roaming profile.
    """
    if normalized_system() == "windows":
        base = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()))
        return base / "ClusterWatcher" / "runtime"
    return Path(os.environ.get("XDG_RUNTIME_DIR", tempfile.gettempdir()))


def standalone_default_config(executable: Path | None = None) -> Path:
    """Return the configuration path for a frozen executable.

    Native installers may put a UTF-8 ``.cluster-watcher-config`` sidecar next
    to the executable when a custom configuration directory was selected.
    Missing, empty, or unreadable sidecars safely fall back to the host's
    conventional per-user directory.
    """
    if executable is not None:
        pointer = executable.resolve().with_name(".cluster-watcher-config")
        try:
            configured = pointer.read_text(encoding="utf-8").strip()
        except OSError:
            configured = ""
        if configured:
            return Path(configured).expanduser()
    system = normalized_system()
    if system == "windows":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        return base / "ClusterWatcher" / "clusters.toml"
    if system == "macos":
        return Path.home() / "Library" / "Application Support" / "Cluster Watcher" / "clusters.toml"
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "cluster-watcher" / "clusters.toml"
