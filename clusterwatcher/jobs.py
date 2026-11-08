"""Versioned personal-job queries, caching, filtering, and safe log tails."""

from copy import deepcopy
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import posixpath
import re
import shlex
import subprocess
import threading
import time
from typing import Callable

from .job_scripts import fetch_batch_script
from .models import ClusterStatus, Machine
from .slurm import (
    canonical_job_id,
    collect_accounting_jobs,
    collect_live_job_log_paths,
    job_array_task_id,
    normalize_job_state,
)
from .ssh import run_remote


DEFAULT_JOB_LOOKBACK_HOURS = 24
MAX_LOG_TAIL_LINES = 2000
ACTIVE_JOB_STATES = {
    "CONFIGURING", "PENDING", "REQUEUED", "REQUEUE_FED", "REQUEUE_HOLD",
    "RESIZING", "RUNNING", "SIGNALING", "STAGE_OUT", "SUSPENDED",
}
_JOB_ID_PATTERN = re.compile(r"\d+(?:_\d+)?")
_MISSING_VALUES = {"", "Unknown", "N/A", "None", "(null)", "NULL"}


class JobLogNotFound(RuntimeError):
    """Indicate that a job has no readable log file yet."""


def _tail_page_command(path_argument: str, tail: int, before: int) -> str:
    """Read a bounded EOF-relative page with GNU or BSD shell utilities.

    ``path_argument`` must already be a quoted shell argument, including
    ``\"$resolved\"`` when authorization resolves the path remotely. Read
    only the required suffix with tail, then retain at most ``tail + 1``
    lines in POSIX awk to discard the newest ``before`` lines. The extra
    line lets the caller detect another older page. Unlike negative head
    counts, this also works on macOS and when the file is shorter than the
    requested suffix. Memory usage depends on page size, not page offset.
    """
    command = f"tail -n {before + tail + 1} -- {path_argument}"
    if before:
        command += (
            f" | awk -v skip={before} -v limit={tail + 1} "
            "'NR <= limit { lines[NR] = $0 } "
            "END { count = NR - skip; if (count > limit) count = limit; "
            "for (i = 1; i <= count; i++) print lines[i] }'"
        )
    return command


def parse_since(value: str | None, now: datetime | None = None) -> datetime:
    """Parse an ISO-8601 lower bound, defaulting to the preceding 24 hours."""
    current = now or datetime.now(timezone.utc)
    if value is None:
        return current - timedelta(hours=DEFAULT_JOB_LOOKBACK_HOURS)
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("since must be a valid ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if parsed > current:
        raise ValueError("since cannot be in the future")
    return parsed


def validate_job_ids(job_ids: tuple[str, ...]) -> tuple[str, ...]:
    """Validate and de-duplicate Slurm job and array-task identifiers."""
    unique = tuple(dict.fromkeys(job_ids))
    if any(not _JOB_ID_PATTERN.fullmatch(job_id) for job_id in unique):
        raise ValueError("job_id must be a numeric Slurm job or array-task identifier")
    return unique


def _present(value: object) -> str | None:
    """Return meaningful Slurm text while discarding sentinel values."""
    text = str(value or "").strip()
    return None if text in _MISSING_VALUES else text


def _active_record(cluster: str, job: dict[str, object]) -> dict[str, object]:
    """Convert the dashboard's compact squeue record to the jobs API shape."""
    job_id = canonical_job_id(str(job.get("id", "")))
    state = normalize_job_state(str(job.get("state", "UNKNOWN")))
    dependency = _present(job.get("dependency"))
    slurm_reason = _present(job.get("reason"))
    # Preserve DependencyNeverSatisfied so clients can distinguish an
    # impossible dependency. Ordinary dependency waits retain the established
    # descriptive fallback used by the terminal and older clients.
    dependency_failed = (slurm_reason or "").casefold() == "dependencyneversatisfied"
    reason = slurm_reason if dependency_failed or not dependency else f"Dependency: {dependency}"
    start = _present(job.get("start_time"))
    return {
        "cluster": cluster,
        "job_id": job_id,
        "array_task_id": job_array_task_id(job_id),
        "name": str(job.get("name") or job_id),
        "state": state,
        "exit_code": None,
        "submit_at": _present(job.get("submit_time")),
        "start_at": start if state != "PENDING" else None,
        "end_at": None,
        "elapsed_seconds": job.get("elapsed_seconds"),
        "partition": str(job.get("partition") or ""),
        "nodes": list(job.get("nodes") or []),
        "node_count": int(job.get("node_count") or 0),
        "cpus": int(job.get("cpus") or 0),
        "gpus": int(job.get("gpus") or 0),
        "time_limit": job.get("time_limit"),
        "time_limit_seconds": job.get("time_limit_seconds"),
        "time_left_seconds": job.get("time_left_seconds"),
        "priority": job.get("priority"),
        "global_priority_rank": job.get("global_priority_rank"),
        "global_priority_total": job.get("global_priority_total"),
        "expected_start_at": start if state == "PENDING" else None,
        "reason": reason,
        "dependency": dependency,
    }


def _unknown_record(cluster: str, job_id: str, reason: str) -> dict[str, object]:
    """Represent a requested ID whose state cannot be established honestly."""
    return {
        "cluster": cluster,
        "job_id": job_id,
        "array_task_id": job_array_task_id(job_id),
        "name": job_id,
        "state": "UNKNOWN",
        "exit_code": None,
        "submit_at": None,
        "start_at": None,
        "end_at": None,
        "elapsed_seconds": None,
        "partition": "",
        "nodes": [],
        "expected_start_at": None,
        "reason": reason,
    }


def _matches_requested(job_id: str, requested: tuple[str, ...]) -> bool:
    """Match an exact ID or array children requested through their parent ID."""
    return not requested or any(job_id == value or ("_" not in value and job_id.startswith(f"{value}_")) for value in requested)


def _public_record(record: dict[str, object]) -> dict[str, object]:
    """Remove private log-resolution fields from a public API record."""
    return {key: value for key, value in record.items() if not key.startswith("_")}


class JobService:
    """Collect and cache personal job state, and fetch logs only on demand."""

    def __init__(
        self,
        machines: list[Machine],
        timeout: int,
        refresh_seconds: int,
        status_provider: Callable[[], list[ClusterStatus]],
    ) -> None:
        self.machines = machines
        self.timeout = timeout
        self.refresh_seconds = refresh_seconds
        self.status_provider = status_provider
        self._cache: dict[tuple[object, ...], tuple[float, dict[str, object]]] = {}
        self._lock = threading.Lock()
        self._inflight: dict[tuple[object, ...], Future[dict[str, object]]] = {}
        self._log_path_cache: dict[tuple[str, str, str], str] = {}
        # Keep a bounded set of private paths from custom older-window queries.
        self._log_records: dict[tuple[str, str], dict[str, object]] = {}

    def query(
        self,
        cluster_names: tuple[str, ...] = (),
        job_ids: tuple[str, ...] = (),
        state: str = "both",
        since: datetime | None = None,
    ) -> dict[str, object]:
        """Return recent jobs, caching each query for one dashboard interval."""
        requested_ids = validate_job_ids(job_ids)
        if state not in {"active", "terminal", "both"}:
            raise ValueError("state must be active, terminal, or both")
        by_name = {machine.name: machine for machine in self.machines}
        selected_names = tuple(dict.fromkeys(cluster_names)) or tuple(by_name)
        unknown = [name for name in selected_names if name not in by_name]
        if unknown:
            raise ValueError(f"unknown cluster(s): {', '.join(unknown)}")
        since_value = since or parse_since(None)
        cache_key = (selected_names, requested_ids, state, since_value.isoformat() if since else "default")

        with self._lock:
            now = time.monotonic()
            self._cache = {
                key: value for key, value in self._cache.items()
                if now - value[0] < self.refresh_seconds
            }
            cached = self._cache.get(cache_key)
            if cached:
                return deepcopy(cached[1])
            flight = self._inflight.get(cache_key)
            owner = flight is None
            if flight is None:
                flight = Future()
                self._inflight[cache_key] = flight
        if not owner:
            return deepcopy(flight.result())
        try:
            payload = self._collect(selected_names, requested_ids, state, since_value, default_window=since is None)
        except BaseException as exc:
            flight.set_exception(exc)
            with self._lock:
                self._inflight.pop(cache_key, None)
            raise
        with self._lock:
            # A cancellation may have invalidated the cache during collection.
            if self._inflight.get(cache_key) is flight:
                self._cache[cache_key] = (time.monotonic(), payload)
                self._inflight.pop(cache_key, None)
        flight.set_result(payload)
        return deepcopy(payload)

    def _collect(
        self,
        selected_names: tuple[str, ...],
        requested_ids: tuple[str, ...],
        state_filter: str,
        since: datetime,
        default_window: bool = False,
    ) -> dict[str, object]:
        """Collect each selected cluster independently so failures stay local.

        For the default 24-hour window, accounting records collected by the
        status refresh (gated by the queue fingerprint) are reused, so polling
        clients cause no ``sacct`` queries of their own. Specific job IDs or
        another ``since`` still query ``sacct`` directly.
        """
        machines = {machine.name: machine for machine in self.machines}
        statuses = {status.name: status for status in self.status_provider()}
        jobs: list[dict[str, object]] = []
        cluster_results: list[dict[str, object]] = []
        log_records: dict[tuple[str, str], dict[str, object]] = {}

        def accounting_for(name: str) -> tuple[list[dict[str, object]], str | None]:
            """Fetch one cluster's accounting without holding another query."""
            machine = machines[name]
            status = statuses.get(name)
            if default_window and not requested_ids and status is not None and status.accounting is not None:
                return deepcopy(status.accounting.records), None
            try:
                return collect_accounting_jobs(machine, self.timeout, since, requested_ids), None
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                return [], str(exc)

        if len(selected_names) == 1:
            accounting_results = [accounting_for(selected_names[0])]
        else:
            with ThreadPoolExecutor(max_workers=len(selected_names), thread_name_prefix="jobs") as pool:
                accounting_results = list(pool.map(accounting_for, selected_names))
        for name, (accounting, accounting_error) in zip(selected_names, accounting_results):
            status = statuses.get(name)
            active_records = [
                _active_record(name, job)
                for job in (status.user_jobs if status and status.user_jobs else [])
            ]
            active = {
                str(record["job_id"]): record
                for record in active_records
                if _matches_requested(str(record["job_id"]), requested_ids)
            }
            merged: dict[str, dict[str, object]] = {}
            for record in accounting:
                record["cluster"] = name
                job_id = str(record["job_id"])
                if _matches_requested(job_id, requested_ids):
                    merged[job_id] = record
                    if record.get("_stdout") or record.get("_stderr"):
                        log_records[(name, job_id)] = record.copy()
            for job_id, record in active.items():
                private = {key: value for key, value in merged.get(job_id, {}).items() if key.startswith("_")}
                merged[job_id] = {**record, **private}

            if accounting_error and requested_ids:
                for job_id in requested_ids:
                    if not any(_matches_requested(existing, (job_id,)) for existing in merged):
                        merged[job_id] = _unknown_record(name, job_id, f"Accounting unavailable: {accounting_error}")

            for record in merged.values():
                is_active = str(record["state"]) in ACTIVE_JOB_STATES
                if state_filter == "active" and not is_active:
                    continue
                if state_filter == "terminal" and is_active:
                    continue
                jobs.append(_public_record(record))

            status_error = status.error if status else "No cluster status has been collected"
            reachable = not (status_error and accounting_error)
            error = accounting_error if accounting_error else status_error
            cluster_results.append({
                "name": name,
                "reachable": reachable,
                "accounting_available": accounting_error is None,
                "error": error,
            })

        jobs.sort(key=lambda job: (str(job["cluster"]), str(job["job_id"])))
        with self._lock:
            for key, record in log_records.items():
                self._log_records.pop(key, None)
                self._log_records[key] = record
            while len(self._log_records) > 1024:
                self._log_records.pop(next(iter(self._log_records)))
        return {
            "schema_version": "1.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "since": since.astimezone(timezone.utc).isoformat(),
            "state": state_filter,
            "clusters": cluster_results,
            "jobs": jobs,
        }

    def cancel(self, cluster: str, job_id: str) -> dict[str, object]:
        """Cancel one of the configured user's jobs with ``scancel``.

        ``--user`` limits the request to the configured account, so a job
        belonging to somebody else is never signalled even where Slurm
        operators could. The query cache is cleared so the next jobs request
        reflects the cancellation.
        """
        validate_job_ids((job_id,))
        machine = next((machine for machine in self.machines if machine.name == cluster), None)
        if machine is None:
            raise ValueError(f"unknown cluster: {cluster}")
        run_remote(
            machine, self.timeout,
            f"scancel --user={shlex.quote(machine.username)} -- {shlex.quote(job_id)}",
            failover=False,
        )
        with self._lock:
            self._cache.clear()
            self._inflight.clear()
        return {
            "cluster": cluster,
            "job_id": job_id,
            "cancelled_at": datetime.now(timezone.utc).isoformat(),
        }

    def batch_script(self, cluster: str, job_id: str) -> dict[str, object]:
        """Return the batch script of one job (see :mod:`clusterwatcher.job_scripts`)."""
        validate_job_ids((job_id,))
        machine = next((machine for machine in self.machines if machine.name == cluster), None)
        if machine is None:
            raise ValueError(f"unknown cluster: {cluster}")
        return {"cluster": cluster, "job_id": job_id, **fetch_batch_script(machine, self.timeout, job_id)}

    def log_tail(
        self,
        cluster: str,
        job_id: str,
        stream: str = "err",
        tail: int = 100,
        explicit_path: str | None = None,
        before: int = 0,
    ) -> dict[str, object]:
        """Return one bounded log page, counting ``before`` lines from EOF."""
        validate_job_ids((job_id,))
        if stream not in {"out", "err"}:
            raise ValueError("stream must be out or err")
        if tail < 1:
            raise ValueError("tail must be a positive integer")
        if before < 0:
            raise ValueError("before must be a non-negative integer")
        tail = min(tail, MAX_LOG_TAIL_LINES)
        by_name = {machine.name: machine for machine in self.machines}
        if cluster not in by_name:
            raise ValueError(f"unknown cluster: {cluster}")
        machine = by_name[cluster]

        if explicit_path is not None:
            if not explicit_path.startswith("/") or "\x00" in explicit_path:
                raise ValueError("path must be an absolute remote path")
            if not machine.job_log_roots:
                raise ValueError(f"cluster {machine.name} has no configured job_log_roots")
            path = explicit_path
        else:
            path = self._resolve_job_log_path(machine, job_id, stream)

        try:
            if explicit_path is not None:
                command = self._explicit_tail_command(machine, path, tail, before)
            elif before:
                quoted_path = shlex.quote(path)
                command = (
                    f"test -r {quoted_path} || {{ echo 'Log file is not readable' >&2; exit 1; }}; "
                    + _tail_page_command(quoted_path, tail, before)
                )
            else:
                command = _tail_page_command(shlex.quote(path), tail, before)
            output = run_remote(machine, self.timeout, command)
            if explicit_path is not None:
                canonical, separator, output = output.partition("\x00")
                if not separator or not canonical.startswith("__CW_LOG_PATH__"):
                    raise RuntimeError("could not validate the remote log path")
                path = canonical[len("__CW_LOG_PATH__"):]
        except RuntimeError as exc:
            message = str(exc).lower()
            if "outside the configured job_log_roots" in message:
                raise ValueError("path is outside the configured job_log_roots") from exc
            if "tail:" in message or "realpath:" in message or "no such file" in message or "log file is not readable" in message:
                raise JobLogNotFound(f"Log file does not exist yet or is not readable: {path}") from exc
            raise
        lines = output.splitlines(keepends=True)
        more_before = len(lines) > tail
        if more_before:
            lines = lines[1:]
        return {
            "cluster": cluster,
            "job_id": job_id,
            "stream": stream,
            "path": path,
            "lines": len(lines),
            "before": before,
            "more_before": more_before,
            "truncated": more_before,
            "content": "".join(lines),
        }

    @staticmethod
    def _explicit_tail_command(machine: Machine, path: str, tail: int, before: int) -> str:
        """Canonicalize, authorize, and read a log using GNU or BSD utilities.

        Plain realpath resolves symlinks on both platforms. Readability and
        root-existence checks retain strict existing-path behavior without
        GNU's ``-e`` option. Every input path is absolute, so it cannot be
        interpreted as a command option even without an option separator.
        """
        roots = " ".join(shlex.quote(root) for root in machine.job_log_roots)
        page = _tail_page_command('"$resolved"', tail, before)
        return (
            f"resolved=$(realpath {shlex.quote(path)}) || exit 1; "
            "test -r \"$resolved\" || { echo 'Log file is not readable' >&2; exit 1; }; "
            "allowed=0; "
            f"for root in {roots}; do "
            "canonical_root=$(realpath \"$root\") || exit 1; "
            "test -e \"$canonical_root\" || { echo 'realpath: configured log root does not exist' >&2; exit 1; }; "
            "if test \"$canonical_root\" = /; then allowed=1; continue; fi; "
            "case \"$resolved\" in \"$canonical_root\"|\"$canonical_root\"/*) allowed=1;; esac; "
            "done; "
            "test \"$allowed\" -eq 1 || { echo 'path is outside the configured job_log_roots' >&2; exit 1; }; "
            "printf '__CW_LOG_PATH__%s\\0' \"$resolved\"; " + page
        )

    def _resolve_job_log_path(self, machine: Machine, job_id: str, stream: str) -> str:
        """Use cached accounting first, then bounded remote Slurm lookups."""
        cache_key = (machine.name, job_id, stream)
        with self._lock:
            if cache_key in self._log_path_cache:
                return self._log_path_cache[cache_key]
        statuses = {status.name: status for status in self.status_provider()}
        status = statuses.get(machine.name)
        live = any(str(job.get("id")) == job_id for job in (status.user_jobs if status and status.user_jobs else []))
        if live:
            try:
                path = collect_live_job_log_paths(machine, self.timeout, job_id).get(stream)
                if path:
                    return path
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                pass

        records = status.accounting.records if status and status.accounting else []
        record = next((item for item in records if str(item["job_id"]) == job_id), None)
        if record is None:
            with self._lock:
                record = self._log_records.get((machine.name, job_id))
        if record is None:
            accounting = collect_accounting_jobs(machine, self.timeout, parse_since(None), (job_id,))
            record = next((item for item in accounting if str(item["job_id"]) == job_id), None)
        raw_path = str(record.get(f"_{'stdout' if stream == 'out' else 'stderr'}") or "") if record else ""
        if not raw_path:
            raise JobLogNotFound(f"No {stream} log path is available for job {job_id}; queued jobs may not have a log yet")
        path = self._expand_log_pattern(raw_path, record)
        workdir = str(record.get("_workdir") or "")
        resolved = posixpath.join(workdir, path) if not path.startswith("/") and workdir else path
        if not live:
            with self._lock:
                self._log_path_cache[cache_key] = resolved
        return resolved

    @staticmethod
    def _expand_log_pattern(path: str, record: dict[str, object]) -> str:
        """Expand common Slurm filename tokens retained by ``sacct``."""
        job_id = str(record["job_id"])
        array_job_id, _, task_id = job_id.partition("_")
        replacements = {
            "%j": str(record.get("_allocation_id") or array_job_id),
            "%A": array_job_id,
            "%a": task_id or "4294967294",
            "%x": str(record.get("name") or job_id),
        }
        marker = "\x00PERCENT\x00"
        expanded = path.replace("%%", marker)
        for token, value in replacements.items():
            expanded = expanded.replace(token, value)
        return expanded.replace(marker, "%")
