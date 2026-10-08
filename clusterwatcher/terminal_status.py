"""Collect and render the terminal cluster-capacity dashboard."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import math
import shutil
import sys
import time
from typing import Callable, TextIO

from .models import ClusterStatus, Machine
from .slurm import collect_status
from .snapshot import build_snapshot
from .terminal_ui import run_live_board
from .wait_probes import WAIT_PROBE_REFRESH_SECONDS, classify_wait_error, collect_wait_estimates


ANSI_RED = "\033[31m"
ANSI_GREEN = "\033[32m"
ANSI_RESET = "\033[0m"
WAIT_GPU_COUNTS = (1, 2, 4, 8, 16, 32, 64)
TERMINAL_WAIT_PROBE_BUDGET_SECONDS = 10.0
"""Maximum wait-probe time added by each concurrent partition worker."""

TERMINAL_WAIT_PROBE_TIMEOUT_SECONDS = 10.0
"""Maximum duration of one probe within its partition worker's budget."""

FAILED_WAIT_PROBE_REFRESH_SECONDS = 30
"""Retry failed live wait probes sooner than successful cached estimates."""


def _fit(value: object, width: int) -> str:
    """Truncate and pad plain terminal text to an exact display width."""
    text = str(value if value not in {None, ""} else "—").replace("\n", " ")
    if len(text) > width:
        text = text[: max(1, width - 1)] + "…"
    return text.ljust(width)


def _format_number(value: object) -> str:
    """Format a hardware specification without meaningless trailing zeros."""
    if value is None:
        return "—"
    number = float(value)
    return f"{number:.1f}" if not number.is_integer() else str(int(number))


def _format_wait(seconds: object) -> str:
    """Format a scheduler wait estimate in a five-character terminal cell."""
    if seconds is None:
        return "?"
    remaining = max(0, int(seconds))
    if remaining == 0:
        return "now"
    if remaining < 60:
        return "<1m"
    if remaining < 3600:
        return f"{math.ceil(remaining / 60)}m"
    if remaining < 86400:
        hours = remaining / 3600
        return f"{hours:.1f}h" if hours < 10 and not hours.is_integer() else f"{math.ceil(hours)}h"
    days = remaining / 86400
    return f"{days:.1f}d" if days < 10 and not days.is_integer() else f"{math.ceil(days)}d"


WAIT_ERROR_LABELS = {
    "denied": "DENY", "minimum": "min", "limit": "limit", "unavailable": "n/a",
    "timeout": "ERR", "error": "ERR", "budget": "?",
}
"""Short wait-cell labels for each ``classify_wait_error`` kind.

Policy refusals get their own words, so ``ERR`` only marks real failures;
``?`` means the shape was not probed.
"""


def wait_error_label(estimate: dict[str, object]) -> str:
    """Return the wait-cell label of a failed estimate."""
    kind = estimate.get("error_kind") or classify_wait_error(str(estimate.get("error") or ""))
    return WAIT_ERROR_LABELS.get(str(kind), "ERR")


def _availability_bar(idle: int, total: int, use_color: bool, width: int = 8) -> tuple[str, str]:
    """Render schedulable idle GPUs in green before unavailable GPUs in red."""
    idle = min(max(0, idle), max(0, total))
    if total < 1:
        plain_bar = "[" + "░" * width + "]"
        return plain_bar, plain_bar
    green = round(idle / total * width)
    if idle and green == 0:
        green = 1
    if total > idle and green == width:
        green -= 1
    red = width - green
    plain_bar = f"[{'░' * green}{'█' * red}]"
    if not use_color:
        return plain_bar, plain_bar
    styled = f"[{ANSI_GREEN}{'█' * green}{ANSI_RED}{'█' * red}{ANSI_RESET}]"
    return styled, plain_bar


def _best_gpu(partition: dict[str, object]) -> dict[str, object] | None:
    """Return the strongest single GPU model represented by a partition."""
    gpus = partition.get("gpus")
    models = gpus.get("models", []) if isinstance(gpus, dict) else []
    candidates = [model for model in models if isinstance(model, dict)]
    return max(
        candidates,
        key=lambda model: (
            float(model.get("vram_gb") or 0),
            float(model.get("fp16_bf16_tensor_tflops") or 0),
        ),
        default=None,
    )


def _wait_cells(partition: dict[str, object]) -> list[str]:
    """Return up-to-one-hour wait estimates for fixed GPU-count columns."""
    gpus = partition.get("gpus")
    total = int(gpus.get("total", 0)) if isinstance(gpus, dict) else 0
    estimates = {
        int(row.get("gpus", 0)): row
        for row in partition.get("wait_estimates", [])
        if isinstance(row, dict)
    }
    cells: list[str] = []
    for count in WAIT_GPU_COUNTS:
        if count > total:
            cells.append("—")
            continue
        estimate = estimates.get(count)
        if estimate and estimate.get("error"):
            cells.append(wait_error_label(estimate))
        else:
            cells.append(_format_wait(estimate.get("estimated_wait_seconds")) if estimate else "?")
    return cells


def _wait_error_lines(partitions: list[dict[str, object]]) -> list[str]:
    """Summarize repeated per-shape wait failures without hiding their cause."""
    lines: list[str] = []
    for partition in partitions:
        grouped: dict[str, list[int]] = {}
        for estimate in partition.get("wait_estimates", []):
            if not isinstance(estimate, dict) or not estimate.get("error"):
                continue
            error = " ".join(str(estimate["error"]).split())
            grouped.setdefault(error, []).append(int(estimate.get("gpus", 0)))
        for error, counts in grouped.items():
            gpu_counts = ",".join(str(count) for count in counts)
            short = wait_error_label({"error": error})
            label = "WAIT DENIED" if short == "DENY" else "WAIT ERROR" if short == "ERR" else f"WAIT {short.upper()}"
            lines.append(f"{label} {partition.get('name', 'unknown')} [{gpu_counts} GPU]: {error}")
    return lines


def _wait_cache_seconds(estimates: dict[str, list[dict[str, object]]]) -> int:
    """Return a shorter cache interval whenever at least one probe failed."""
    failed = any(row.get("error") for rows in estimates.values() for row in rows)
    return FAILED_WAIT_PROBE_REFRESH_SECONDS if failed else WAIT_PROBE_REFRESH_SECONDS


def _partition_row(partition: dict[str, object], use_color: bool) -> tuple[list[str], str]:
    """Prepare plain cells and an ANSI-styled availability cell for a partition."""
    profile = _best_gpu(partition)
    gpus = partition.get("gpus") if isinstance(partition.get("gpus"), dict) else {}
    cpus = partition.get("cpus") if isinstance(partition.get("cpus"), dict) else {}
    total = int(gpus.get("total", 0))
    idle = int(gpus.get("schedulable_idle", 0))
    styled_bar, plain_bar = _availability_bar(idle, total, use_color)
    availability = f"{plain_bar} {idle}/{total}"
    styled_availability = f"{styled_bar} {idle}/{total}"
    cells = [
        str(partition.get("name") or "—"),
        str(profile.get("name") or "—") if profile else "—",
        f"{_format_number(profile.get('vram_gb'))}G" if profile else "—",
        _format_number(profile.get("fp16_bf16_tensor_tflops")) if profile else "—",
        availability,
        *_wait_cells(partition),
        str(cpus.get("total", 0)),
    ]
    return cells, styled_availability


def render_status_board(
    payload: dict[str, object],
    *,
    use_color: bool = False,
    width: int | None = None,
    refresh_seconds: int | None = None,
) -> str:
    """Render current GPU capacity and one-hour scheduler waits by cluster."""
    terminal_width = width or shutil.get_terminal_size((140, 24)).columns
    generated = payload.get("generated_at")
    try:
        updated = datetime.fromisoformat(str(generated)).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        updated = "unknown"
    suffix = f" · refreshing every {refresh_seconds}s" if refresh_seconds else ""
    lines = [f"Cluster capacities · updated {updated}{suffix}"]
    headings = (
        "PARTITION", "GPU NAME", "VRAM", "TFLOPS/S", "GPU AVAILABILITY",
        *(str(count) for count in WAIT_GPU_COUNTS), "CPU THREADS",
    )
    caps = (18, 24, 7, 9, 19, 5, 5, 5, 5, 5, 5, 5, 11)
    minimums = (9, 12, 5, 7, 16, 3, 3, 3, 3, 3, 3, 3, 7)

    for cluster in payload.get("clusters", []):
        if not isinstance(cluster, dict):
            continue
        lines.extend(("", f"## {cluster.get('name', 'unknown')} ##"))
        if not cluster.get("reachable", False):
            lines.append(f"ERROR: {cluster.get('error') or 'cluster is unreachable'}")
            continue
        if cluster.get("resource_error"):
            lines.append(f"WARNING: {cluster['resource_error']}")
        partitions = [item for item in cluster.get("partitions", []) if isinstance(item, dict)]
        if not partitions:
            lines.append("No partitions returned by Slurm.")
            continue
        prepared = [_partition_row(partition, use_color) for partition in partitions]
        widths = [
            min(cap, max(len(heading), *(len(cells[index]) for cells, _ in prepared)))
            for index, (heading, cap) in enumerate(zip(headings, caps))
        ]
        overflow = sum(widths) + 2 * (len(widths) - 1) - terminal_width
        for index in (1, 0, 4, 12, 3, 2):
            reduction = min(max(0, overflow), widths[index] - minimums[index])
            widths[index] -= reduction
            overflow -= reduction
        leading_heading = "  ".join(
            _fit(headings[index], widths[index]) for index in range(5)
        )
        wait_width = sum(widths[5:12]) + 2 * 6
        lines.append(
            f"{leading_heading}  "
            f"{'WAIT TIME · JOB UP TO 1 HOUR · GPU COUNT'.center(wait_width)}  "
            f"{_fit(headings[12], widths[12])}".rstrip()
        )
        wait_start = len(leading_heading) + 2
        lines.append(
            " " * wait_start
            + "  ".join(_fit(headings[index], widths[index]) for index in range(5, 12)).rstrip()
        )
        lines.append("─" * min(terminal_width, sum(widths) + 2 * (len(widths) - 1)))
        for cells, styled_availability in prepared:
            values = [_fit(value, widths[index]) for index, value in enumerate(cells)]
            if use_color and len(cells[4]) <= widths[4]:
                values[4] = styled_availability + " " * (widths[4] - len(cells[4]))
            lines.append("  ".join(values).rstrip())
        lines.extend(_wait_error_lines(partitions))
        if cluster.get("job_states") is not None:
            jobs = cluster.get("job_states") or {}
            summary = ", ".join(f"{state}={count}" for state, count in jobs.items()) or "none"
            lines.append(f"Jobs: {summary}")
    return "\n".join(lines) + "\n"


class StatusBoardCollector:
    """Collect fast capacity snapshots and cache expensive scheduler probes."""

    def __init__(
        self,
        machines: list[Machine],
        timeout: int,
        include_jobs: bool = False,
        *,
        status_collector: Callable[[Machine, int, bool, bool], ClusterStatus] = collect_status,
        wait_collector: Callable[..., dict[str, list[dict[str, object]]]] = collect_wait_estimates,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.machines = machines
        self.timeout = timeout
        self.include_jobs = include_jobs
        self.status_collector = status_collector
        self.wait_collector = wait_collector
        self.monotonic = monotonic
        self._wait_cache: dict[str, tuple[float, dict[str, list[dict[str, object]]], str]] = {}

    def __call__(self) -> dict[str, object]:
        """Return a public snapshot with fresh capacity and cached wait probes."""
        statuses: list[ClusterStatus] = []
        if self.machines:
            with ThreadPoolExecutor(
                max_workers=len(self.machines),
                thread_name_prefix="cluster-watcher-capacity",
            ) as executor:
                status_futures = [
                    executor.submit(
                        self.status_collector,
                        machine,
                        self.timeout,
                        self.include_jobs,
                        False,
                    )
                    for machine in self.machines
                ]
                statuses = [future.result() for future in status_futures]
        now = self.monotonic()
        stale: list[tuple[Machine, ClusterStatus]] = []
        for machine, status in zip(self.machines, statuses):
            if status.error or not status.nodes:
                continue
            cached = self._wait_cache.get(machine.name)
            cache_seconds = _wait_cache_seconds(cached[1]) if cached else 0
            if cached is None or now - cached[0] >= cache_seconds:
                stale.append((machine, status))

        if stale:
            with ThreadPoolExecutor(
                max_workers=len(stale),
                thread_name_prefix="cluster-watcher-cluster-wait",
            ) as executor:
                futures = {
                    machine.name: executor.submit(
                        self.wait_collector,
                        machine,
                        status.nodes,
                        self.timeout,
                        walltime_minutes=(60,),
                        maximum_gpus=max(WAIT_GPU_COUNTS),
                        probe_timeout_seconds=TERMINAL_WAIT_PROBE_TIMEOUT_SECONDS,
                        time_budget_seconds=TERMINAL_WAIT_PROBE_BUDGET_SECONDS,
                    )
                    for machine, status in stale
                }
                for machine, _status in stale:
                    estimates = futures[machine.name].result()
                    self._wait_cache[machine.name] = (
                        now,
                        estimates,
                        datetime.now(timezone.utc).isoformat(),
                    )

        for machine, status in zip(self.machines, statuses):
            if status.error or not status.nodes:
                continue
            cached = self._wait_cache[machine.name]
            status.wait_estimates = cached[1]
            status.wait_estimates_updated_at = cached[2]
        generated_at = datetime.now(timezone.utc).isoformat()
        snapshot = build_snapshot(statuses, generated_at, 0)
        for cluster, status in zip(snapshot["clusters"], statuses):
            cluster["job_states"] = status.jobs
        return snapshot


def run_terminal_status_board(
    machines: list[Machine],
    timeout: int,
    refresh_seconds: int | None,
    *,
    include_jobs: bool = False,
    output: TextIO = sys.stdout,
    input_stream: TextIO = sys.stdin,
    collector: Callable[[], dict[str, object]] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Print once or redraw cluster capacity through the shared terminal UI."""
    collect = collector or StatusBoardCollector(machines, timeout, include_jobs)
    last_payload: dict[str, object] = {}

    def tracked_collect() -> dict[str, object]:
        nonlocal last_payload
        last_payload = collect()
        return last_payload

    result = run_live_board(
        tracked_collect,
        lambda payload, color, refresh: render_status_board(
            payload, use_color=color, refresh_seconds=refresh,
        ),
        refresh_seconds,
        output=output,
        input_stream=input_stream,
        sleep=sleep,
    )
    if refresh_seconds is None and any(
        not cluster.get("reachable", False)
        for cluster in last_payload.get("clusters", [])
        if isinstance(cluster, dict)
    ):
        return 1
    return result
