"""TOML configuration loading and validation."""

from pathlib import Path
from pathlib import PurePosixPath
import re
import sys
import tomllib

from .models import Machine
from .platforms import standalone_default_config
from .ssh import parse_control_persist

DEFAULT_CONFIG = standalone_default_config(Path(sys.executable)) if getattr(sys, "frozen", False) else Path("clusters.toml")
DEFAULT_WAIT_THRESHOLD_MINUTES = (5, 30, 60, 120)


def _load_toml(path: Path) -> dict[str, object]:
    """Load a TOML document while presenting configuration-specific errors."""
    try:
        with path.open("rb") as config_file:
            return tomllib.load(config_file)
    except FileNotFoundError as exc:
        raise ValueError(f"configuration file not found: {path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"invalid TOML in {path}: {exc}") from exc


def load_config(path: Path) -> list[Machine]:
    """Read, validate, and return visible machines from ``clusters.toml``.

    Entries with ``hidden = true`` remain in the configuration but are omitted
    from every caller, preventing authentication, polling, and display.
    """
    data = _load_toml(path)

    raw_machines = data.get("machine")
    if not isinstance(raw_machines, list) or not raw_machines:
        raise ValueError("configuration needs at least one [[machine]] entry")
    machines: list[Machine] = []
    names: set[str] = set()
    for index, raw in enumerate(raw_machines, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"machine #{index} must be a TOML table")
        missing = [key for key in ("name", "host", "username") if not isinstance(raw.get(key), str) or not raw[key].strip()]
        if missing:
            raise ValueError(f"machine #{index} is missing a non-empty: {', '.join(missing)}")
        name = raw["name"].strip()
        if name in names:
            raise ValueError(f"machine names must be unique (duplicate: {name!r})")
        names.add(name)
        hidden = raw.get("hidden", False)
        if not isinstance(hidden, bool):
            raise ValueError(f"machine {name!r} has an invalid hidden value")
        port = raw.get("port", 22)
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError(f"machine {name!r} has an invalid port")
        identity_file = raw.get("identity_file")
        if identity_file is not None and (not isinstance(identity_file, str) or not identity_file.strip()):
            raise ValueError(f"machine {name!r} has an invalid identity_file")
        interactive_auth = raw.get("interactive_auth", False)
        if not isinstance(interactive_auth, bool):
            raise ValueError(f"machine {name!r} has an invalid interactive_auth value")
        control_persist = raw.get("control_persist", "8h")
        if not isinstance(control_persist, str) or not control_persist.strip():
            raise ValueError(f"machine {name!r} has an invalid control_persist value")
        try:
            parse_control_persist(control_persist)
        except ValueError as exc:
            raise ValueError(f"machine {name!r} has an invalid control_persist value") from exc
        credential_group = raw.get("credential_group")
        if credential_group is not None and (not isinstance(credential_group, str) or not credential_group.strip()):
            raise ValueError(f"machine {name!r} has an invalid credential_group")
        if credential_group is not None and not interactive_auth:
            raise ValueError(f"machine {name!r} requires interactive_auth=true when credential_group is set")
        raw_log_roots = raw.get("job_log_roots", [])
        if not isinstance(raw_log_roots, list) or any(
            not isinstance(root, str) or not root.strip() or "\x00" in root or "\n" in root
            or not PurePosixPath(root.strip()).is_absolute()
            for root in raw_log_roots
        ):
            raise ValueError(f"machine {name!r} job_log_roots must be a list of absolute remote paths")
        job_log_roots = tuple(dict.fromkeys(root.rstrip("/") or "/" for root in map(str.strip, raw_log_roots)))
        default_max_time = raw.get("default_partition_max_time_minutes", 1440)
        if not isinstance(default_max_time, int) or isinstance(default_max_time, bool) or default_max_time < 1:
            raise ValueError(
                f"machine {name!r} default_partition_max_time_minutes must be a positive integer"
            )
        raw_max_times = raw.get("partition_max_time_minutes", {})
        if not isinstance(raw_max_times, dict) or any(
            not isinstance(partition, str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+", partition)
            or not isinstance(minutes, int)
            or isinstance(minutes, bool)
            or minutes < 1
            for partition, minutes in raw_max_times.items()
        ):
            raise ValueError(
                f"machine {name!r} partition_max_time_minutes must map partition names "
                "to positive integer minutes"
            )
        partition_max_times = tuple(sorted(raw_max_times.items()))
        if not hidden:
            machines.append(
                Machine(
                    name=name,
                    host=raw["host"].strip(),
                    username=raw["username"].strip(),
                    port=port,
                    identity_file=identity_file,
                    interactive_auth=interactive_auth,
                    control_persist=control_persist.strip(),
                    credential_group=credential_group.strip() if credential_group is not None else None,
                    job_log_roots=job_log_roots,
                    default_partition_max_time_minutes=default_max_time,
                    partition_max_time_minutes=partition_max_times,
                )
            )
    if not machines:
        raise ValueError("configuration needs at least one machine without hidden=true")
    group_usernames: dict[str, str] = {}
    for machine in machines:
        if machine.credential_group is None:
            continue
        prior_username = group_usernames.setdefault(machine.credential_group, machine.username)
        if prior_username != machine.username:
            raise ValueError(
                f"credential group {machine.credential_group!r} must use one username "
                f"(found {prior_username!r} and {machine.username!r})"
            )
    return machines


def load_wait_threshold_minutes(path: Path) -> tuple[int, ...]:
    """Return strictly increasing pending-job wait buckets from ``[dashboard]``.

    When omitted, the dashboard uses five minutes, 30 minutes, one hour, and
    two hours. Values are positive minute counts and define the upper bound of
    each displayed ``<`` bucket.
    """
    dashboard = _load_toml(path).get("dashboard", {})
    if not isinstance(dashboard, dict):
        raise ValueError("[dashboard] must be a TOML table")
    raw_thresholds = dashboard.get("wait_threshold_minutes", list(DEFAULT_WAIT_THRESHOLD_MINUTES))
    if not isinstance(raw_thresholds, list) or not raw_thresholds:
        raise ValueError("dashboard.wait_threshold_minutes must be a non-empty list of minutes")
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in raw_thresholds):
        raise ValueError("dashboard.wait_threshold_minutes must contain positive integers")
    thresholds = tuple(raw_thresholds)
    if any(left >= right for left, right in zip(thresholds, thresholds[1:])):
        raise ValueError("dashboard.wait_threshold_minutes must be strictly increasing")
    return thresholds
